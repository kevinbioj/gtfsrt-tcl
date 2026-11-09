import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import GtfsRealtime from "gtfs-realtime-bindings";
import { type Context, Hono } from "hono";
import { basicAuth } from "hono/basic-auth";

import { ADMIN_UI_DIR, ROAD_ROUTING_MAX_EXPANSIONS, ROAD_SMOOTHING_TOLERANCE, ROAD_SNAP_RADIUS } from "../config.js";
import { serviceDay } from "../gtfs-rt/scheduled-trips.js";
import {
	type AlertPeriod,
	alertSourceKey,
	customPublishedPeriods,
	type DailyWindow,
	hasEnded,
	imageMediaType,
	inWindow,
	isActive,
	periodsOverlap,
	publishedPeriods,
} from "../gtfs-rt/use-service-alerts.js";
import {
	courseKey,
	normalizeStopName,
	type RoutePattern,
	type StaticGtfs,
	type StopBounds,
} from "../gtfs-rt/use-static-gtfs.js";
import type { RoadGraph, RoadGraphHandle } from "../routing/road-graph.js";
import { routeOnRoad } from "../routing/route-on-road.js";
import { encodePolyline } from "../utils/encode-polyline.js";
import { sanitizeHtml } from "../utils/sanitize-html.js";
import type {
	AlertDto,
	AlertPhase,
	AlertPublication,
	DepartureDayDto,
	DepartureDto,
	FeedClock,
	LabelDto,
	LineDto,
	ModificationDetailDto,
	ModificationState,
	ModificationSummaryDto,
	RivalDto,
	RouteDto,
	StatusDto,
	StopGroupDto,
	TripSetDto,
} from "./admin-dto.js";
import { deduceBounds, overlappingSegments, removesStops, type SegmentBounds } from "./bounds.js";
import { countSelectableTrips } from "./build-entities.js";
import type { LineCartridges } from "./line-cartridges.js";
import { collides, type ModificationIndex, type ResolvedAlert, type ResolvedModification } from "./modifications.js";
import {
	type AlertInput,
	type AlertOverrides,
	canonicalImpact,
	type DetourSegment,
	type DetourStore,
	type ImpactEntity,
	impactKey,
	informedEntities,
	type ModificationInput,
	type ModificationTripSetInput,
	type ProvisionalStop,
	type ProvisionalStopFields,
	type SavedPeriod,
	type SkipOverride,
	type TripSet,
	type TripSetInput,
} from "./store.js";

/**
 * Nombre de quais que la recherche d'arrêts renvoie au plus. Un libellé court — « gare » — en touche
 * des dizaines, et la liste cesse d'être lisible bien avant d'être longue.
 */
const STOP_SEARCH_LIMIT = 50;

/**
 * Marge autour de l'enveloppe des quais du GTFS, en degrés : une vingtaine de kilomètres. Une
 * coordonnée au-delà est manifestement fautive — un arrêt provisoire ou un tracé ne s'éloignent pas
 * tant du réseau.
 */
const BOUNDS_MARGIN = 0.25;

/** Faute de GTFS chargé, la France métropolitaine : de quoi n'écarter que l'absurde. */
const FALLBACK_BOUNDS: StopBounds = { minLatitude: 41, maxLatitude: 52, minLongitude: -6, maxLongitude: 10 };

/** L'enveloppe des quais du GTFS en vigueur (cf. `readCoordinates`), posée au montage des routes. */
let networkBounds: () => StopBounds | null = () => null;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const TIME_ZONE = "Europe/Paris";

/**
 * Combien de journées de service la liste des départs à annuler parcourt, à partir du premier jour de
 * la période qui n'est pas passé. Une semaine voit passer tous les types de journée — semaine, samedi,
 * dimanche — sans noyer la liste sous des départs qui se répètent.
 */
const DEPARTURE_WINDOW_DAYS = 7;

/** Au-delà, un horaire n'est plus celui d'une journée de service, fût-elle débordante. */
const MAX_DEPARTURE = 48 * 3600;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Assez pour un titre d'info trafic ; une description, elle, n'est pas bornée. */
const HEADER_MAX_LENGTH = 300;

/** La longueur maximale d'une adresse saisie : lien, ou image. */
const LINK_MAX_LENGTH = 2000;

/** Un nom d'étiquette se lit d'un coup d'œil dans une pastille. */
const LABEL_MAX_LENGTH = 40;

const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/** La couleur d'une ligne que le GTFS ne colore pas. */
const NEUTRAL_LINE = { color: "#5B626A", textColor: "#FFFFFF" };

const Alert = GtfsRealtime.transit_realtime.Alert;

export type AdminDependencies = {
	username: string;
	password: string;
	store: DetourStore;
	gtfs: { data: StaticGtfs };
	/** Les modifications et les infos trafic résolues, à rebâtir après chaque saisie. */
	modificationIndex: ModificationIndex;
	/** Le graphe routier, pour accrocher un tracé aux rues. Son absence désarme le mode, rien de plus. */
	roadGraph: RoadGraphHandle;
	/** Les pictogrammes des lignes. */
	cartridges: LineCartridges;
	/** L'alerte telle que le flux amont la donne, avant toute réécriture — `undefined` hors du flux. */
	receivedAlert: (alertNumber: string) => GtfsRealtime.transit_realtime.IAlert | undefined;
	/** Quand chaque flux a été réassemblé et modifié pour la dernière fois, et l'âge du GTFS. */
	feedStatus: () => {
		serviceAlerts: FeedClock;
		tripModifications: FeedClock;
		tripUpdates: FeedClock;
		gtfsImportedAt: number;
	};
	/** Réassemble les entités du feed, pour qu'un enregistrement se voie sans attendre le relevé suivant. */
	rebuild: () => void;
};

/**
 * L'interface de gestion des modifications, et l'API qu'elle consomme. Trois sections : les infos
 * trafic — ce qu'on en republie, ce qu'elles suppriment et activent —, les modifications elles-mêmes —
 * les déviations —, et la base des arrêts provisoires.
 *
 * Le sous-routeur est monté sous `/admin` et s'ouvre par son authentification : tout ce qui suit est
 * en accès restreint, y compris l'interface elle-même — elle porte les textes des infos trafic et la
 * géographie du réseau, rien de secret, mais rien qui ait à traîner non plus.
 */
export function adminRoutes(deps: AdminDependencies): Hono {
	const admin = new Hono();
	admin.use(basicAuth({ username: deps.username, password: deps.password, realm: "Administration TCL" }));
	networkBounds = () => deps.gtfs.data.stopBounds;

	/** Après une saisie : l'index se rebâtit, puis le feed, qui le lit. */
	const refresh = () => {
		deps.modificationIndex.reindex();
		deps.rebuild();
	};

	/** La modification résolue que désigne `:uid`, ou `undefined`. */
	const resolve = (c: Context) => deps.modificationIndex.modifications.get(Number(c.req.param("uid")));

	/** L'info trafic résolue que désigne `:alertNumber`, ou `undefined`. */
	const resolveAlert = (c: Context) => deps.modificationIndex.alerts.get(c.req.param("alertNumber") ?? "");

	/** De quoi remplir la barre latérale : l'état des flux, et ce que compte chaque section. */
	admin.get("/api/status", (c) => {
		const { gtfsImportedAt, ...feeds } = deps.feedStatus();
		return c.json({
			feeds,
			gtfsImportedAt,
			counts: {
				alerts: deps.modificationIndex.alerts.size,
				// Une info trafic créée à la main n'a rien à vérifier : tout en est saisi.
				uncheckedAlerts: [...deps.modificationIndex.alerts.values()].filter(
					(alert) => !alert.custom && deps.store.alertSettings(alert.alertNumber).checked === null,
				).length,
				modifications: deps.modificationIndex.modifications.size,
				provisionalStops: deps.store.provisionalStops.size,
			},
			roadRouting: deps.roadGraph.available,
		} satisfies StatusDto);
	});

	/** Toutes les modifications, actives ou non : c'est l'interface qui les filtre. */
	admin.get("/api/modifications", (c) => {
		const gtfs = deps.gtfs.data;
		const now = Temporal.Now.instant();
		const modifications = [...deps.modificationIndex.modifications.values()]
			.sort((a, b) => compareRows(a, b, gtfs))
			.map((modification) => summarize(modification, deps, now));
		return c.json({ modifications });
	});

	admin.get("/api/modifications/:uid", (c) => {
		const modification = resolve(c);
		if (modification === undefined) return c.json({ code: 404, message: "Modification inconnue." }, 404);
		return c.json(detail(modification, deps));
	});

	/**
	 * Crée une modification : sa ligne, son sens, ses tracés, sa description — et, si l'éditeur l'a déjà
	 * fait dessiner, tout le reste d'un coup. Créée depuis une info trafic (`alertNumbers`), elle lui est
	 * associée ; sinon, rien ne l'active encore.
	 */
	admin.post("/api/modifications", async (c) => {
		const payload = await readObject(c);
		if ("message" in payload) return c.json({ code: 400, message: payload.message }, 400);

		const gtfs = deps.gtfs.data;
		const { routeId, directionId } = payload;
		const directions = typeof routeId === "string" ? gtfs.routeDirections.get(routeId) : undefined;
		if (typeof routeId !== "string" || directions === undefined) {
			return c.json({ code: 400, message: `Ligne « ${String(routeId)} » inconnue du GTFS.` }, 400);
		}
		if (typeof directionId !== "number" || !directions.some((direction) => direction.directionId === directionId)) {
			return c.json(
				{ code: 400, message: `La ligne ${lineName(gtfs, routeId)} n'a pas de sens ${String(directionId)}.` },
				400,
			);
		}

		const parsed = parseInput(
			{ removedStopIds: [], segments: [], tripSets: [], ...payload },
			routeId,
			directionId,
			0,
			deps,
		);
		if ("message" in parsed) return c.json({ code: 400, message: parsed.message }, 400);

		// Créée depuis une info trafic, elle lui est associée d'emblée.
		const alertNumbers = Array.isArray(payload.alertNumbers) ? payload.alertNumbers.map(String) : [];
		const unknown = alertNumbers.find((alertNumber) => !deps.modificationIndex.alerts.has(alertNumber));
		if (unknown !== undefined) return c.json({ code: 400, message: `Info trafic ${unknown} inconnue.` }, 400);

		const created = deps.store.create({ routeId, directionId, ...parsed.input, alertNumbers }, nowSeconds());
		refresh();
		return c.json({ uid: created.uid });
	});

	/** Enregistre tout d'un bloc : description, tracés, arrêts supprimés, tronçons, priorité. */
	admin.put("/api/modifications/:uid", async (c) => {
		const modification = resolve(c);
		if (modification === undefined) return c.json({ code: 404, message: "Modification inconnue." }, 404);

		const payload = await readObject(c);
		if ("message" in payload) return c.json({ code: 400, message: payload.message }, 400);

		const parsed = parseInput(
			payload,
			modification.routeId,
			modification.directionId,
			modification.record.priority,
			deps,
		);
		if ("message" in parsed) return c.json({ code: 400, message: parsed.message }, 400);

		deps.store.save(modification.uid, parsed.input, nowSeconds());
		refresh();

		const saved = deps.modificationIndex.modifications.get(modification.uid);
		if (saved === undefined) return c.json({ code: 404, message: "Modification inconnue." }, 404);
		return c.json(detail(saved, deps));
	});

	/** Active une modification à la main — elle vaut jusqu'à ce qu'on la désactive —, ou la désactive. */
	admin.put("/api/modifications/:uid/manual", async (c) => {
		const modification = resolve(c);
		if (modification === undefined) return c.json({ code: 404, message: "Modification inconnue." }, 404);

		const payload = await readObject(c);
		if ("message" in payload) return c.json({ code: 400, message: payload.message }, 400);
		if (typeof payload.active !== "boolean") return c.json({ code: 400, message: "Booléen « active » attendu." }, 400);

		deps.store.setManual([modification.uid], payload.active, nowSeconds());
		refresh();
		return c.json({ code: 200, message: payload.active ? "Activée à la main." : "Désactivée." });
	});

	/**
	 * Les départs de sa ligne et de son sens qu'une modification peut annuler, jour par jour d'après le
	 * GTFS du moment (cf. `departureDays`), tous tracés confondus : chacun dit de quels tracés il relève, et l'éditeur ne
	 * retient que ceux qu'il a cochés — enregistrés ou non.
	 */
	admin.get("/api/modifications/:uid/departures", (c) => {
		const modification = resolve(c);
		if (modification === undefined) return c.json({ code: 404, message: "Modification inconnue." }, 404);
		const { routeId, directionId, periods } = modification;
		return c.json(departureDays(deps.gtfs.data, routeId, directionId, periods, Temporal.Now.instant()));
	});

	admin.delete("/api/modifications/:uid", (c) => {
		const modification = resolve(c);
		if (modification === undefined) return c.json({ code: 404, message: "Modification inconnue." }, 404);

		deps.store.remove([modification.uid]);
		refresh();
		return c.json({ code: 200, message: "Modification supprimée." });
	});

	/**
	 * Une action sur les modifications cochées, d'un bloc : les supprimer, les activer à la main, les
	 * désactiver. Ce qui a disparu entre l'affichage et le clic est passé sous silence.
	 */
	admin.post("/api/bulk", async (c) => {
		const payload = await readObject(c);
		if ("message" in payload) return c.json({ code: 400, message: payload.message }, 400);

		const action = payload.action;
		if (action !== "delete" && action !== "activate" && action !== "deactivate") {
			return c.json({ code: 400, message: "Action attendue : « delete », « activate » ou « deactivate »." }, 400);
		}

		const uids = (Array.isArray(payload.uids) ? payload.uids : [])
			.map(Number)
			.filter((uid) => deps.modificationIndex.modifications.has(uid));

		if (action === "delete") deps.store.remove(uids);
		else deps.store.setManual(uids, action === "activate", nowSeconds());

		refresh();
		return c.json({ code: 200, message: `${uids.length} modification(s) traitée(s).` });
	});

	/** Les étiquettes, dans l'ordre de leurs noms. */
	admin.get("/api/labels", (c) => c.json([...deps.store.labels.values()] satisfies LabelDto[]));

	/** Crée une étiquette, et la pose d'emblée sur les modifications données — fût-ce aucune. */
	admin.post("/api/labels", async (c) => {
		const payload = await readObject(c);
		if ("message" in payload) return c.json({ code: 400, message: payload.message }, 400);

		const name = typeof payload.name === "string" ? payload.name.trim().replace(/\s+/g, " ") : "";
		if (name.length === 0) return c.json({ code: 400, message: "L'étiquette doit porter un nom." }, 400);
		if (name.length > LABEL_MAX_LENGTH) {
			return c.json({ code: 400, message: `Un nom d'étiquette tient en ${LABEL_MAX_LENGTH} caractères.` }, 400);
		}
		if (typeof payload.color !== "string" || !COLOR_PATTERN.test(payload.color)) {
			return c.json({ code: 400, message: "Couleur « #RRGGBB » attendue." }, 400);
		}

		const uids = (Array.isArray(payload.uids) ? payload.uids : []).map(Number);
		const label = deps.store.createLabel({ name, color: payload.color.toUpperCase() }, uids, nowSeconds());
		if (label === undefined) return c.json({ code: 409, message: `L'étiquette « ${name} » existe déjà.` }, 409);
		refresh();
		return c.json(label satisfies LabelDto);
	});

	/**
	 * Pose une étiquette sur des modifications, ou la leur retire. Ce qui a disparu entre l'affichage et
	 * le clic est passé sous silence.
	 */
	admin.put("/api/labels/:labelId/modifications", async (c) => {
		const payload = await readObject(c);
		if ("message" in payload) return c.json({ code: 400, message: payload.message }, 400);
		if (typeof payload.assigned !== "boolean") {
			return c.json({ code: 400, message: "Booléen « assigned » attendu." }, 400);
		}

		const labelId = Number(c.req.param("labelId"));
		const label = deps.store.labels.get(labelId);
		const uids = (Array.isArray(payload.uids) ? payload.uids : [])
			.map(Number)
			.filter((uid) => deps.modificationIndex.modifications.has(uid));
		if (label === undefined || !deps.store.setLabel(labelId, uids, payload.assigned)) {
			return c.json({ code: 404, message: "Étiquette inconnue." }, 404);
		}
		refresh();
		return c.json({
			code: 200,
			message: `« ${label.name} » ${payload.assigned ? "posée sur" : "retirée de"} ${uids.length} modification(s).`,
		});
	});

	/**
	 * Combien de courses ces bornes-là modifieraient, tracé par tracé, sans rien enregistrer. L'éditeur
	 * l'interroge dès qu'une borne change, avant même la création : c'est le chiffre qui dit si le
	 * tronçon sortira du feed, et sur quels tracés.
	 */
	admin.get("/api/trip-count", (c) => {
		const routeId = c.req.query("routeId") ?? "";
		const directionId = Number(c.req.query("directionId"));
		const bounds: SegmentBounds = { startStopId: c.req.query("start") || null, endStopId: c.req.query("end") || null };
		if (bounds.startStopId === null) return c.json({ tripsByPattern: {} });
		const counts = countSelectableTrips(deps.gtfs.data, routeId, directionId, bounds, nowSeconds());
		return c.json({ tripsByPattern: Object.fromEntries(counts) });
	});

	/**
	 * Les lignes du réseau, leurs sens et leurs tracés : de quoi créer une modification. Chaque tracé
	 * dit combien d'arrêts il dessert, et combien de courses l'empruntent un jour ouvré.
	 */
	admin.get("/api/routes", (c) => {
		const gtfs = deps.gtfs.data;
		const perDay = tripsPerPattern(gtfs, nextWeekday());
		const routes = [...gtfs.routeDirections]
			.sort(([a], [b]) => compareLines(gtfs, a, b))
			.map(([routeId, directions]) => ({
				...lineOf(gtfs, routeId),
				cartridgeHref: deps.cartridges.of(routeId),
				agencyId: gtfs.routeAgencies.get(routeId) ?? null,
				agencyName: gtfs.agencies.get(gtfs.routeAgencies.get(routeId) ?? "") ?? null,
				directions: directions.map((direction) => {
					const patterns = patternsFor(gtfs, routeId, direction.directionId);
					const labels = patternLabels(patterns, gtfs);
					return {
						directionId: direction.directionId,
						headsigns: direction.headsigns,
						patterns: patterns.map((pattern, index) => ({
							patternId: pattern.patternId,
							label: labels[index] as string,
							stopCount: pattern.stops.length,
							tripsPerDay: perDay.get(pattern.patternId) ?? 0,
						})),
					};
				}),
			}));

		return c.json(routes satisfies RouteDto[]);
	});

	/**
	 * Les infos trafic : celles du flux, et celles qui l'ont quitté en gardant des modifications
	 * associées — il reste à les associer à celle qui leur succède, ou à les dissocier.
	 */
	admin.get("/api/alerts", (c) => {
		const now = Temporal.Now.instant();
		const alerts = [...deps.modificationIndex.alerts.values()]
			.sort(
				(a, b) => b.firstSeenAt - a.firstSeenAt || b.alertNumber.localeCompare(a.alertNumber, "fr", { numeric: true }),
			)
			.map((alert) => summarizeAlert(alert, deps, now));
		return c.json(alerts);
	});

	/**
	 * Crée une info trafic à la main, en brouillon, d'après tout ce qui s'en saisit : c'est son premier
	 * enregistrement. Rien n'existe avant — un formulaire abandonné ne laisse rien derrière lui.
	 */
	admin.post("/api/alerts", async (c) => {
		const payload = await readObject(c);
		if ("message" in payload) return c.json({ code: 400, message: payload.message }, 400);

		// Aucun numéro encore : rien de reçu ne s'y rattache, et l'impact saisi est tout l'impact.
		const parsed = parseAlertInput(payload, "", deps);
		if ("message" in parsed) return c.json({ code: 400, message: parsed.message }, 400);
		if (parsed.input.overrides.headerText === null) return c.json({ code: 400, message: "Titre attendu." }, 400);
		const scheduling =
			openEndedProblem(parsed.input.unpublishAt, parsed.input.periods ?? []) ??
			unpublishAtProblem(parsed.input.unpublishAt);
		if (scheduling !== null) return c.json({ code: 400, message: scheduling }, 400);

		const alertNumber = deps.store.createCustomAlert(parsed.input, nowSeconds());
		refresh();

		const created = deps.modificationIndex.alerts.get(alertNumber);
		if (created === undefined) return c.json({ code: 500, message: "Info trafic introuvable après création." }, 500);
		return c.json(summarizeAlert(created, deps, Temporal.Now.instant()), 201);
	});

	admin.get("/api/alerts/:alertNumber", (c) => {
		const alert = resolveAlert(c);
		if (alert === undefined) return c.json({ code: 404, message: "Info trafic inconnue." }, 404);
		return c.json(summarizeAlert(alert, deps, Temporal.Now.instant()));
	});

	/**
	 * Enregistre ce qui se règle d'une info trafic, d'un bloc : son texte, sa cause et son effet
	 * republiés, ses périodes, ses arrêts supprimés corrigés, ses courses annulées et ses modifications
	 * associées. Le masquage, lui, se bascule à part.
	 */
	admin.put("/api/alerts/:alertNumber", async (c) => {
		const alert = resolveAlert(c);
		if (alert === undefined) return c.json({ code: 404, message: "Info trafic inconnue." }, 404);

		const payload = await readObject(c);
		if ("message" in payload) return c.json({ code: 400, message: payload.message }, 400);

		const parsed = parseAlertInput(payload, alert.alertNumber, deps);
		if ("message" in parsed) return c.json({ code: 400, message: parsed.message }, 400);
		if (alert.custom) {
			// Elle n'a d'autres périodes que les siennes : il n'y a pas de source où revenir.
			parsed.input.periods ??= [];
			const problem = unpublishable(parsed.input.overrides, parsed.input.impact?.entities ?? []);
			if (problem === "title") return c.json({ code: 400, message: "Titre attendu." }, 400);
			if (problem === "impact" && !alert.hidden) {
				return c.json(
					{ code: 400, message: "Publiée, l'alerte doit toucher au moins une entité : la dépublier d'abord." },
					400,
				);
			}
			const openEnded = openEndedProblem(parsed.input.unpublishAt, parsed.input.periods);
			if (openEnded !== null) return c.json({ code: 400, message: openEnded }, 400);
			// Une échéance déjà enregistrée, et passée depuis l'ouverture du formulaire, a fait son office : la
			// dépublication l'a oubliée (cf. `unpublishDue`).
			if (parsed.input.unpublishAt !== alert.unpublishAt) {
				const scheduling = unpublishAtProblem(parsed.input.unpublishAt);
				if (scheduling !== null) return c.json({ code: 400, message: scheduling }, 400);
			}
		} else {
			// Celles du flux suivent sa période de communication.
			parsed.input.unpublishAt = null;
		}

		if (!deps.store.saveAlert(alert.alertNumber, parsed.input, nowSeconds())) {
			return c.json({ code: 404, message: `Info trafic ${alert.alertNumber} jamais relevée.` }, 404);
		}
		refresh();

		const saved = deps.modificationIndex.alerts.get(alert.alertNumber);
		if (saved === undefined) return c.json({ code: 404, message: "Info trafic inconnue." }, 404);
		return c.json(summarizeAlert(saved, deps, Temporal.Now.instant()));
	});

	/**
	 * Marque une info trafic traitée, ou la rend à traiter. Traitée, elle l'est pour l'alerte reçue en ce
	 * moment : qu'elle change à la source, et elle redevient à traiter (cf. `dropStaleChecks`).
	 */
	admin.put("/api/alerts/:alertNumber/checked", async (c) => {
		const alert = resolveAlert(c);
		if (alert === undefined) return c.json({ code: 404, message: "Info trafic inconnue." }, 404);

		const payload = await readObject(c);
		if ("message" in payload) return c.json({ code: 400, message: payload.message }, 400);
		if (typeof payload.checked !== "boolean")
			return c.json({ code: 400, message: "Booléen « checked » attendu." }, 400);

		const received = deps.receivedAlert(alert.alertNumber);
		const basis = payload.checked ? (received === undefined ? "" : alertSourceKey(received)) : null;
		if (!deps.store.setAlertChecked(alert.alertNumber, basis, nowSeconds())) {
			return c.json({ code: 404, message: `Info trafic ${alert.alertNumber} jamais relevée.` }, 404);
		}
		return c.json({ code: 200, message: payload.checked ? "Alerte traitée." : "Alerte à traiter." });
	});

	/**
	 * Dépublie une info trafic — plus aucun effet, plus republiée —, ou la publie. Une info trafic créée à
	 * la main ne se publie qu'avec un titre et au moins une entité touchée, que GTFS-RT exige.
	 */
	admin.put("/api/alerts/:alertNumber/hidden", async (c) => {
		const alert = resolveAlert(c);
		if (alert === undefined) return c.json({ code: 404, message: "Info trafic inconnue." }, 404);

		const payload = await readObject(c);
		if ("message" in payload) return c.json({ code: 400, message: payload.message }, 400);
		if (typeof payload.hidden !== "boolean") return c.json({ code: 400, message: "Booléen « hidden » attendu." }, 400);

		if (alert.custom && !payload.hidden) {
			const settings = deps.store.alertSettings(alert.alertNumber);
			const problem = unpublishable(settings.overrides, settings.impact?.entities ?? []);
			if (problem !== null) {
				const message =
					problem === "title"
						? "Sans titre, l'alerte ne peut pas être publiée."
						: "Sans entité touchée dans l'impact, l'alerte ne peut pas être publiée.";
				return c.json({ code: 409, message }, 409);
			}
		}

		deps.store.setAlertHidden(alert.alertNumber, payload.hidden, nowSeconds());
		refresh();
		return c.json({ code: 200, message: payload.hidden ? "Info trafic dépubliée." : "Info trafic publiée." });
	});

	/**
	 * Efface une info trafic sortie du flux ou créée à la main, et ce qui s'en était réglé ; ses
	 * modifications restent, détachées. Une info trafic encore au flux ne s'efface pas : relevée de
	 * nouveau dans la minute, elle reviendrait comme neuve, ses réglages perdus — elle se dépublie.
	 */
	admin.delete("/api/alerts/:alertNumber", (c) => {
		const alert = resolveAlert(c);
		if (alert === undefined) return c.json({ code: 404, message: "Info trafic inconnue." }, 404);
		if (alert.inFeed) {
			return c.json(
				{ code: 409, message: "Encore au flux, elle reviendrait au prochain relevé : la dépublier plutôt." },
				409,
			);
		}
		deps.store.deleteAlert(alert.alertNumber, nowSeconds());
		refresh();
		return c.json({ code: 200, message: `Info trafic ${alert.alertNumber} supprimée.` });
	});

	/**
	 * Les départs d'une ligne et d'un sens que l'info trafic peut annuler, jour par jour d'après le GTFS
	 * du moment (cf. `departureDays`). Chacun dit de quels tracés il relève, et s'il tombe dans ses périodes.
	 */
	admin.get("/api/alerts/:alertNumber/departures", (c) => {
		const alert = resolveAlert(c);
		if (alert === undefined) return c.json({ code: 404, message: "Info trafic inconnue." }, 404);

		const gtfs = deps.gtfs.data;
		const routeId = c.req.query("routeId") ?? "";
		const directionId = Number(c.req.query("directionId"));
		if (!gtfs.routeDirections.get(routeId)?.some((direction) => direction.directionId === directionId)) {
			return c.json({ code: 400, message: "Ligne ou sens inconnu du GTFS." }, 400);
		}
		return c.json(departureDays(gtfs, routeId, directionId, alert.periods, Temporal.Now.instant()));
	});

	/**
	 * Les arrêts désignables, du GTFS comme de la base provisoire, dans une seule liste. C'est la même
	 * chose du point de vue d'une déviation — un endroit où le véhicule s'arrête — et les séparer
	 * obligerait à savoir d'avance dans laquelle des deux chercher.
	 *
	 * La recherche passe par `normalizeStopName` : on cherche « champ de mars » sans se soucier des
	 * accents ni de la casse, comme le fait déjà le rapprochement des noms d'info trafic.
	 */
	admin.get("/api/stops", (c) => {
		const query = normalizeStopName(c.req.query("q") ?? "");
		if (query.length < 2) return c.json([]);

		const gtfs = deps.gtfs.data;
		const matches: { stopId: string; name: string; latitude: number; longitude: number; provisional: boolean }[] = [];

		// Les arrêts provisoires passent devant : ils sont peu nombreux, et c'est précisément eux qu'on
		// cherche quand on en réemploie un.
		for (const stop of deps.store.provisionalStops.values()) {
			if (normalizeStopName(stop.name).includes(query)) matches.push({ ...stop, provisional: true });
		}

		for (const [stopId, name] of gtfs.stopNames) {
			if (matches.length >= STOP_SEARCH_LIMIT) break;
			if (!normalizeStopName(name).includes(query)) continue;

			const coordinates = gtfs.stopCoordinates.get(stopId);
			// Un quai sans coordonnées ne se pose pas sur la carte : il n'a rien à faire dans la liste.
			if (coordinates === undefined) continue;

			matches.push({ stopId, name, ...coordinates, provisional: false });
		}

		return matches.length === 0 ? c.json([]) : c.json(matches);
	});

	/**
	 * Tous les arrêts désignables, du GTFS comme de la base provisoire, pour les poser sur la carte : un
	 * arrêt de substitution se choisit alors d'un clic, là où il est. En tableaux plutôt qu'en objets —
	 * le réseau compte quelques milliers de quais.
	 */
	admin.get("/api/stops/all", (c) => {
		const gtfs = deps.gtfs.data;
		const stops: [stopId: string, name: string, latitude: number, longitude: number, provisional: boolean][] = [];

		for (const stop of deps.store.provisionalStops.values()) {
			stops.push([stop.stopId, stop.name, stop.latitude, stop.longitude, true]);
		}
		for (const [stopId, name] of gtfs.stopNames) {
			const coordinates = gtfs.stopCoordinates.get(stopId);
			if (coordinates === undefined) continue;
			stops.push([stopId, name, coordinates.latitude, coordinates.longitude, false]);
		}

		return c.json(stops);
	});

	/**
	 * La base des arrêts provisoires, chacun avec les modifications qui le désignent. C'est ce qu'il
	 * faut voir avant d'en renommer ou d'en déplacer un : le changement vaudra pour toutes, et un arrêt
	 * que rien ne désigne plus est le seul qu'on puisse retirer sans rien toucher d'autre.
	 */
	admin.get("/api/provisional-stops", (c) => {
		const usages = new Map<string, ReturnType<typeof describeUsage>[]>();

		for (const record of deps.store.modifications.values()) {
			const designated = new Set(record.segments.flatMap((segment) => segment.stops.map((stop) => stop.stopId)));
			for (const stopId of designated) {
				if (!deps.store.provisionalStops.has(stopId)) continue;
				const list = usages.get(stopId) ?? [];
				list.push(describeUsage(record.uid, record.routeId, record.directionId, deps));
				usages.set(stopId, list);
			}
		}

		const stops = [...deps.store.provisionalStops.values()].map((stop) => ({
			...stop,
			usages: usages.get(stop.stopId) ?? [],
		}));

		return c.json(stops.sort((a, b) => a.name.localeCompare(b.name, "fr")));
	});

	/**
	 * Ce parmi quoi se choisissent la zone tarifaire et la station parente d'un arrêt provisoire : les
	 * zones du GTFS, et ses stations — en tableaux, il y en a un bon millier.
	 */
	admin.get("/api/stop-references", (c) => {
		const gtfs = deps.gtfs.data;
		const fareAreas = [...gtfs.fareAreas].map(([areaId, name]) => ({ areaId, name }));
		const stations: [stationId: string, name: string, latitude: number | null, longitude: number | null][] = [
			...gtfs.stations,
		].map(([stationId, station]) => [
			stationId,
			station.name,
			station.coordinates?.latitude ?? null,
			station.coordinates?.longitude ?? null,
		]);

		return c.json({
			fareAreas: fareAreas.sort((a, b) => a.name.localeCompare(b.name, "fr")),
			stations: stations.sort((a, b) => a[1].localeCompare(b[1], "fr")),
		});
	});

	admin.post("/api/provisional-stops", async (c) => {
		const parsed = await parseProvisionalStop(c);
		if ("message" in parsed) return c.json({ code: 400, message: parsed.message }, 400);

		const { details, ...located } = parsed;
		const fields = { ...NO_DETAILS, ...details, ...located };
		const unknown = unknownReference(fields, undefined, deps.gtfs.data);
		if (unknown !== undefined) return c.json({ code: 400, message: unknown }, 400);

		return c.json(deps.store.createProvisionalStop(fields, Math.floor(Date.now() / 1000)));
	});

	admin.put("/api/provisional-stops/:stopId", async (c) => {
		const stopId = c.req.param("stopId");
		const current = deps.store.provisionalStops.get(stopId);
		if (current === undefined) return c.json({ code: 404, message: "Arrêt provisoire inconnu." }, 404);

		const parsed = await parseProvisionalStop(c);
		if ("message" in parsed) return c.json({ code: 400, message: parsed.message }, 400);

		// Ce que la requête tait reste tel quel : l'éditeur de déviation ne fait que renommer ou
		// déplacer l'arrêt, et n'a pas à connaître le reste pour ne pas l'effacer.
		const { stopId: _, ...kept } = current;
		const { details, ...located } = parsed;
		const fields = { ...kept, ...details, ...located };
		const unknown = unknownReference(fields, current, deps.gtfs.data);
		if (unknown !== undefined) return c.json({ code: 400, message: unknown }, 400);

		if (!deps.store.updateProvisionalStop(stopId, fields)) {
			return c.json({ code: 404, message: "Arrêt provisoire inconnu." }, 404);
		}

		// Ce que le feed publie de l'arrêt vient de changer : il doit suivre.
		deps.rebuild();
		return c.json(deps.store.provisionalStops.get(stopId));
	});

	/** Retire un arrêt provisoire, et le retire au passage de toutes les déviations qui le désignent. */
	admin.delete("/api/provisional-stops/:stopId", (c) => {
		const withdrawn = deps.store.deleteProvisionalStop(c.req.param("stopId"), Math.floor(Date.now() / 1000));
		if (withdrawn === undefined) return c.json({ code: 404, message: "Arrêt provisoire inconnu." }, 404);

		// Des déviations publiées viennent de perdre un arrêt de substitution : le feed doit suivre.
		if (withdrawn > 0) deps.rebuild();
		return c.json({ code: 200, message: "Arrêt provisoire supprimé.", withdrawn });
	});

	/**
	 * Une jambe de tracé, accrochée aux rues : deux points cliqués, et l'itinéraire routier qui les
	 * joint.
	 *
	 * Une jambe par appel, et non le tracé entier : déplacer un point de passage ne remet en cause que
	 * les deux jambes qui le touchent, et l'interface n'a alors qu'à redemander celles-là.
	 */
	admin.post("/api/route", async (c) => {
		// Le graphe s'ouvre à la première demande, et peut refuser de s'ouvrir : fichier tronqué par un
		// transfert, ou d'une version que ce code ne sait plus lire. On rend alors la raison telle
		// quelle — l'éditeur l'affiche sur la jambe, et elle dit quoi faire.
		let graph: RoadGraph | undefined;
		try {
			graph = deps.roadGraph.graph();
		} catch (cause) {
			return c.json({ code: 500, message: cause instanceof Error ? cause.message : "Graphe routier illisible." }, 500);
		}

		if (graph === undefined) {
			return c.json({ code: 503, message: "Graphe routier absent : le mode accrochage est indisponible." }, 503);
		}

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ code: 400, message: "Corps de requête illisible." }, 400);
		}

		const payload = (body ?? {}) as Record<string, unknown>;
		const from = readPoint(payload.from);
		const to = readPoint(payload.to);
		if (from === undefined || to === undefined) {
			return c.json({ code: 400, message: "Deux points attendus, chacun en [latitude, longitude]." }, 400);
		}

		const route = routeOnRoad(graph, from, to, {
			snapRadius: ROAD_SNAP_RADIUS,
			maxExpansions: ROAD_ROUTING_MAX_EXPANSIONS,
			smoothingTolerance: ROAD_SMOOTHING_TOLERANCE,
		});

		if ("failure" in route) {
			const message =
				route.failure === "no-road" ? "Point trop éloigné d'une rue." : "Aucun itinéraire entre ces deux points.";
			return c.json({ code: 422, message }, 422);
		}

		// Les points partent en paires [latitude, longitude], comme le tracé d'un tronçon : l'interface
		// les recoud bout à bout sans rien convertir.
		return c.json({
			path: route.path.map((point) => [point.latitude, point.longitude]),
			distance: Math.round(route.distance * 1000),
			fromOffset: Math.round(route.from.offset * 1000),
			toOffset: Math.round(route.to.offset * 1000),
		});
	});

	// L'interface elle-même : ses fichiers, puis sa page pour toute autre adresse — c'est elle qui route.
	admin.use(
		"/assets/*",
		serveStatic({ root: ADMIN_UI_DIR, rewriteRequestPath: (path) => path.replace(/^\/admin/, "") }),
	);
	admin.get("*", (c) => {
		if (c.req.path.startsWith("/admin/api/")) return c.json({ code: 404, message: "Route inconnue." }, 404);
		const page = adminPage();
		if (page === undefined) {
			return c.text("Interface absente : la construire avec « pnpm --filter web build ».", 503);
		}
		return c.html(page.replace(/<base href="[^"]*"\s*\/?>/, `<base href="${relativeRoot(c.req.path)}" />`));
	});

	return admin;
}

/**
 * La racine de l'interface, relative à l'adresse de la page : « ./ » pour /admin/, « ../ » pour
 * /admin/modifications/12. Relative, elle suit d'elle-même le préfixe d'un proxy — /gtfs-rt/tcl/admin
 * —, que le producteur ne voit pas : il ne reçoit que /admin.
 */
function relativeRoot(path: string): string {
	const rest = path.replace(/^\/admin/, "");
	if (rest === "") return "admin/";
	const depth = rest.split("/").length - 2;
	return depth === 0 ? "./" : "../".repeat(depth);
}

// ---

/**
 * La page de l'interface. En production, elle se lit une fois pour toutes ; en développement, à chaque
 * demande : un build peut arriver pendant que le serveur tourne, et ses fichiers changent de nom.
 */
let cachedPage: string | undefined;
function adminPage(): string | undefined {
	if (cachedPage !== undefined) return cachedPage;
	const path = join(ADMIN_UI_DIR, "index.html");
	if (!existsSync(path)) return undefined;
	const page = readFileSync(path, "utf8");
	if (process.env.NODE_ENV === "production") cachedPage = page;
	return page;
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/** Le corps d'une requête, s'il est un objet JSON. */
async function readObject(c: Context): Promise<Record<string, unknown> | { message: string }> {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return { message: "Corps de requête illisible." };
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { message: "Corps de requête attendu : un objet." };
	}
	return body as Record<string, unknown>;
}

/** Les tracés d'une ligne et d'un sens, du plus long au plus court. */
function patternsFor(gtfs: StaticGtfs, routeId: string, directionId: number): RoutePattern[] {
	return gtfs.routePatterns.get(routeId)?.get(directionId) ?? [];
}

/**
 * Par ligne, dans l'ordre du réseau, puis par sens ; en vigueur d'abord au sein d'un même sens. Le
 * reste du rangement — onglets, groupes, tri choisi — se fait dans l'interface.
 */
function compareRows(
	a: { routeId: string; directionId: number; active: boolean },
	b: { routeId: string; directionId: number; active: boolean },
	gtfs: StaticGtfs,
): number {
	if (a.routeId !== b.routeId) return compareLines(gtfs, a.routeId, b.routeId);
	if (a.directionId !== b.directionId) return a.directionId - b.directionId;
	if (a.active !== b.active) return a.active ? -1 : 1;
	return 0;
}

/** Le nom commercial d'une ligne (« F7 », « Métro »), ou à défaut le bout de son identifiant. */
function lineName(gtfs: StaticGtfs, routeId: string): string {
	return gtfs.routeNames.get(routeId) ?? routeId.split(":").at(-1) ?? routeId;
}

/** Une ligne telle que l'interface l'affiche. */
function lineOf(gtfs: StaticGtfs, routeId: string): LineDto {
	const colors = gtfs.routeColors.get(routeId) ?? NEUTRAL_LINE;
	return { routeId, line: lineName(gtfs, routeId), ...colors };
}

/**
 * Dans l'ordre où le réseau présente ses lignes (`route_sort_order`), les trois réseaux entremêlés
 * comme dans le GTFS. Une ligne sans rang vient après, par nom — les nombres comparés comme tels.
 */
function compareLines(gtfs: StaticGtfs, a: string, b: string): number {
	const rankA = gtfs.routeSortOrders.get(a) ?? Number.POSITIVE_INFINITY;
	const rankB = gtfs.routeSortOrders.get(b) ?? Number.POSITIVE_INFINITY;
	if (rankA !== rankB) return rankA < rankB ? -1 : 1;
	return lineName(gtfs, a).localeCompare(lineName(gtfs, b), "fr", { numeric: true });
}

/** Les destinations d'un sens, telles que le GTFS les affiche. */
function headsignsOf(gtfs: StaticGtfs, routeId: string, directionId: number): string[] {
	return gtfs.routeDirections.get(routeId)?.find((direction) => direction.directionId === directionId)?.headsigns ?? [];
}

/**
 * Où se range une info trafic : ce qui n'a pas commencé, ce qui court, ce qui est fini — d'après ses
 * périodes, masquée ou non, dans le flux ou non. Une période sans borne court toujours, et une
 * tranche horaire court tant qu'on est dans ses dates : les travaux de nuit sont en cours à midi.
 */
function phaseOf(alert: ResolvedAlert, now: Temporal.Instant): "upcoming" | "current" | "ended" {
	const minute = now.toZonedDateTimeISO(TIME_ZONE).toPlainDateTime().round("minute");
	const bound = (time: Temporal.PlainDateTime) => time.toString({ smallestUnit: "minute" });
	const instant = { start: bound(minute), end: bound(minute.add({ minutes: 1 })), dailyWindow: null };
	if (periodsOverlap(alert.periods, [instant])) return "current";
	return hasEnded(alert.periods, now) ? "ended" : "upcoming";
}

/** « 2026-10-26 » donne « 26/10 », « 2026-10-26T08:30 » « 26/10 à 08:30 ». */
function formatBound(bound: string): string {
	const [date, time] = bound.split("T");
	const [, month, day] = (date as string).split("-");
	return time === undefined ? `${day}/${month}` : `${day}/${month} à ${time}`;
}

/** Un instant epoch, à l'heure de Paris : « 24/10 à 14:32 ». */
function formatInstant(seconds: number): string {
	const time = Temporal.Instant.fromEpochMilliseconds(seconds * 1000).toZonedDateTimeISO(TIME_ZONE);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(time.day)}/${pad(time.month)} à ${pad(time.hour)}:${pad(time.minute)}`;
}

/** La tranche horaire d'une période, en clair : « , de 09:00 à 12:00 » — rien sans tranche. */
function windowSuffix(period: AlertPeriod | undefined): string {
	return period?.dailyWindow ? `, de ${period.dailyWindow.from} à ${period.dailyWindow.to}` : "";
}

/** Le début de période à venir le plus proche, ou `undefined` : rien ne commence plus. */
function nextPeriod(periods: readonly AlertPeriod[], now: Temporal.Instant): AlertPeriod | undefined {
	const today = now.toZonedDateTimeISO(TIME_ZONE).toPlainDateTime().toString({ smallestUnit: "minute" });
	return periods
		.filter((period) => period.start !== null && period.start > today)
		.sort((a, b) => ((a.start as string) < (b.start as string) ? -1 : 1))[0];
}

/** La période qui court en ce moment, ou `undefined`. */
function currentPeriod(periods: readonly AlertPeriod[], now: Temporal.Instant): AlertPeriod | undefined {
	return periods.find((period) => isActive([period], now));
}

/** La fin la plus tardive des périodes, telle que saisie, ou `undefined` si l'une est ouverte. */
function lastEnd(periods: readonly AlertPeriod[]): string | undefined {
	if (periods.some((period) => period.end === null)) return undefined;
	return periods
		.map((period) => period.end as string)
		.sort()
		.at(-1);
}

/**
 * Les périodes que l'alerte republie, calculées comme pour le flux (cf. `publishedPeriods`) : de quoi
 * voir d'où viennent ses bornes quand aucune période n'est saisie. Pour une info trafic créée à la main,
 * rien n'est reçu, et rien ne se communique tant qu'elle n'est pas publiée (cf. `customPublishedPeriods`).
 */
function feedPeriodsOf(
	alert: ResolvedAlert,
	received: GtfsRealtime.transit_realtime.IAlert | undefined,
	now: Temporal.Instant,
): AlertDto["feedPeriods"] {
	const ranges = (list: GtfsRealtime.transit_realtime.ITimeRange[]) =>
		list.map((range) => ({
			start: range.start ? Number(range.start) : null,
			end: range.end ? Number(range.end) : null,
		}));
	if (alert.custom) {
		const published = customPublishedPeriods(alert.periods, alert.publishedAt ?? 0, alert.unpublishAt, now);
		return {
			received: [],
			communication: alert.publishedAt === null ? [] : ranges(published.communicationPeriod),
			impact: ranges(published.impactPeriod),
		};
	}
	if (!alert.inFeed || received === undefined) return null;
	const communication = received.communicationPeriod ?? [];
	const published = publishedPeriods(alert.periods, communication, now);
	return {
		received: ranges(communication),
		communication: ranges(published.communicationPeriod),
		impact: ranges(published.impactPeriod),
	};
}

/** Si une info trafic se republie : dépubliée ou sortie du flux, elle ne l'est pas (cf. `republished`). */
function alertPublicationOf(alert: ResolvedAlert): AlertPublication {
	if (alert.custom) return alert.hidden ? "draft" : "published";
	if (alert.hidden) return "hidden";
	if (!alert.inFeed) return "withdrawn";
	return "published";
}

/**
 * Où en est une info trafic d'après ses périodes, publiée ou non : en cours, dans ses dates mais hors
 * de ses heures, à venir, terminée. Avec la date qui va avec, s'il y en a une.
 */
function alertPhaseOf(alert: ResolvedAlert, now: Temporal.Instant): { phase: AlertPhase; detail: string } {
	// Aucune période, c'est « sans borne » : elle court, comme le veut `isActive`.
	if (alert.periods.length === 0) return { phase: "current", detail: "" };
	const period = currentPeriod(alert.periods, now);
	if (period !== undefined) {
		return { phase: "current", detail: period.start ? `Depuis le ${formatBound(period.start)}` : "" };
	}
	const phase = phaseOf(alert, now);
	if (phase === "current") return { phase: "paused", detail: "" };
	if (phase === "upcoming") {
		const next = nextPeriod(alert.periods, now);
		return {
			phase: "planned",
			detail: next?.start ? `À partir du ${formatBound(next.start)}${windowSuffix(next)}` : "",
		};
	}
	const end = lastEnd(alert.periods);
	return { phase: "expired", detail: end ? `Terminée le ${formatBound(end)}` : "" };
}

/**
 * Où en est la publication d'une modification : activée à la main, publiée via une info trafic en
 * vigueur, planifiée, ou rien de tout cela — avec la phrase qui le dit.
 */
function publicationOf(
	modification: ResolvedModification,
	now: Temporal.Instant,
): { state: ModificationState; detail: string } {
	if (modification.manual)
		return { state: "manual", detail: `depuis le ${formatInstant(modification.record.updatedAt)}` };

	if (modification.silent) {
		if (modification.record.segments.length === 0 && modification.removedStopIds.size === 0) {
			return { state: "off", detail: "brouillon · tracé à dessiner" };
		}
		if (modification.alerts.length === 0) return { state: "off", detail: "aucune alerte, inactive" };
		if (modification.alerts.every((alert) => !alert.inFeed && !alert.custom)) {
			return { state: "off", detail: "alerte retirée du flux" };
		}
		return { state: "off", detail: "alerte non publiée" };
	}

	if (modification.active) {
		const period = currentPeriod(modification.periods, now);
		return { state: "live", detail: period?.start ? `depuis le ${formatBound(period.start)}` : "en continu" };
	}
	if (hasEnded(modification.periods, now)) {
		const end = lastEnd(modification.periods);
		return { state: "off", detail: end ? `alerte expirée le ${formatBound(end)}` : "alerte expirée" };
	}
	const next = nextPeriod(modification.periods, now);
	if (next?.start) return { state: "planned", detail: `dès le ${formatBound(next.start)}${windowSuffix(next)}` };
	return { state: "planned", detail: `hors plage horaire${windowSuffix(modification.periods[0])}` };
}

/** Ce que la liste affiche d'une modification, sans la géographie que seule l'édition demande. */
function summarize(
	modification: ResolvedModification,
	deps: AdminDependencies,
	now: Temporal.Instant,
): ModificationSummaryDto {
	const gtfs = deps.gtfs.data;
	const record = modification.record;
	const publishable = record.segments.filter((segment) => isSegmentPublishable(segment, modification, gtfs));
	const publication = publicationOf(modification, now);
	const routePatterns = patternsFor(gtfs, modification.routeId, modification.directionId);
	const labels = patternLabels(routePatterns, gtfs);
	const first = record.segments[0];
	const last = record.segments.at(-1);
	const designated = new Set(record.segments.flatMap((segment) => segment.stops.map((stop) => stop.stopId)));
	const nameOf = (stopId: string | null | undefined) =>
		stopId == null ? null : (gtfs.stopNames.get(stopId) ?? deps.store.provisionalStops.get(stopId)?.name ?? stopId);

	return {
		uid: modification.uid,
		description: modification.description,
		routeId: modification.routeId,
		directionId: modification.directionId,
		line: lineOf(gtfs, modification.routeId),
		headsigns: headsignsOf(gtfs, modification.routeId, modification.directionId),
		state: publication.state,
		stateDetail: publication.detail,
		manual: modification.manual,
		draft:
			record.segments.length === 0 &&
			modification.removedStopIds.size === 0 &&
			!record.tripSets.some((set) => set.enabled),
		alerts: modification.alerts,
		labelIds: record.labelIds,
		active: modification.active,
		kind: first?.terminus === "start" ? "start" : first?.terminus === "end" ? "end" : "intra",
		fromStop: nameOf(first?.startStopId),
		toStop: last === undefined ? null : (nameOf(last.endStopId) ?? "terminus"),
		patternLabels:
			record.patternIds.length === 0
				? (labels as string[])
				: routePatterns.flatMap((pattern, index) =>
						record.patternIds.includes(pattern.patternId) ? [labels[index] as string] : [],
					),
		allPatterns: record.patternIds.length === 0,
		priority: record.priority,
		// Les tronçons écrasés en ce moment par un tronçon plus prioritaire, sur au moins un tracé.
		overriddenCount: modification.overridden.size,
		removedStopCount: removedOnCourse(modification, gtfs).length,
		segmentCount: record.segments.length,
		publishableSegments: publishable.length,
		provisionalStopCount: [...designated].filter((stopId) => deps.store.provisionalStops.has(stopId)).length,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

/**
 * Les arrêts supprimés que desservent les tracés visés. Une saisie ancienne peut en porter d'autres —
 * ceux d'autres lignes, de l'autre sens — qui ne suppriment rien ici et n'ont pas à se compter.
 */
function removedOnCourse(modification: ResolvedModification, gtfs: StaticGtfs): string[] {
	const served = new Set<string>();
	for (const pattern of patternsFor(gtfs, modification.routeId, modification.directionId)) {
		if (modification.patternIds.length > 0 && !modification.patternIds.includes(pattern.patternId)) continue;
		for (const stop of pattern.stops) served.add(stop.stopId);
	}
	return [...modification.removedStopIds].filter((stopId) => served.has(stopId));
}

/**
 * Les arrêts d'un sens, tous tracés confondus, dans l'ordre de parcours : le plus long d'abord, puis
 * les arrêts propres à chaque branche glissés après celui qui les précède. Ce n'est pas un itinéraire
 * — deux branches s'y suivent —, c'est de quoi poser chaque arrêt sur un schéma de ligne.
 */
function mergedSequence(patterns: readonly RoutePattern[]): { stopId: string; name: string }[] {
	const merged: { stopId: string; name: string }[] = [];
	for (const pattern of patterns) {
		let insertAt = 0;
		for (const stop of pattern.stops) {
			const at = merged.findIndex((known) => known.stopId === stop.stopId);
			if (at !== -1) {
				insertAt = at + 1;
				continue;
			}
			merged.splice(insertAt, 0, stop);
			insertAt += 1;
		}
	}
	return merged;
}

/**
 * Les effets qui annoncent forcément des arrêts ou des courses en moins — ceux qu'un avertissement
 * relève quand rien ne les traduit. « Service modifié » ou « Arrêt déplacé » peuvent n'en rien dire.
 */
const EFFECT_LABELS: Record<string, string> = {
	DETOUR: "Déviation",
	NO_SERVICE: "Aucun service",
};

/** Le nom d'une valeur d'énumération du GTFS-RT, ou `null`. */
function enumName(values: Record<string, unknown>, value: number | null | undefined): string | null {
	if (value == null) return null;
	const name = (values as Record<number, unknown>)[value];
	return typeof name === "string" ? name : null;
}

/** Le texte brut d'un fragment HTML : ses paragraphes et ses retours à la ligne gardés, ses balises ôtées. */
function htmlToText(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|h\d)>/gi, "\n")
		.replace(/<li[^>]*>/gi, "• ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Ce que l'interface affiche d'une info trafic : son texte reçu et republié, son état, et pour chaque
 * ligne citée et chaque sens, ses arrêts sur un schéma de ligne, ceux qu'on y a supprimés marqués.
 */
function summarizeAlert(alert: ResolvedAlert, deps: AdminDependencies, now: Temporal.Instant): AlertDto {
	const gtfs = deps.gtfs.data;
	const received = deps.receivedAlert(alert.alertNumber);
	// Créée à la main, elle n'a rien reçu : tout ce qu'elle publie est saisi, et se range en réécriture.
	const receivedText = alert.custom
		? {
				headerText: "",
				descriptionText: "",
				cause: null,
				effect: null,
				url: null,
				imageUrl: null,
				imageAlternativeText: null,
			}
		: {
				headerText: alert.headerText,
				descriptionText: htmlToText(alert.descriptionText),
				cause: enumName(Alert.Cause, received?.cause),
				effect: enumName(Alert.Effect, received?.effect),
				url: received?.url?.translation?.[0]?.text || null,
				imageUrl: received?.image?.localizedImage?.[0]?.url || null,
				imageAlternativeText: received?.imageAlternativeText?.translation?.[0]?.text || null,
			};
	const { overrides } = alert;
	// `""` retire ce que porte le flux.
	const removable = (override: string | null, fallback: string | null) =>
		override === null ? fallback : override === "" ? null : override;
	const published = {
		headerText: overrides.headerText ?? receivedText.headerText,
		descriptionText: overrides.descriptionText ?? receivedText.descriptionText,
		cause: overrides.cause ?? receivedText.cause,
		effect: overrides.effect ?? receivedText.effect,
		url: removable(overrides.url, receivedText.url),
		imageUrl: removable(overrides.imageUrl, receivedText.imageUrl),
		imageAlternativeText: removable(overrides.imageAlternativeText, receivedText.imageAlternativeText),
	};

	const associated = alert.modificationUids.flatMap((uid) => {
		const modification = deps.modificationIndex.modifications.get(uid);
		return modification === undefined ? [] : [modification];
	});
	const routeIds = [...new Set([...alert.routeIds, ...alert.skips.map((skip) => skip.routeId)])].sort((a, b) =>
		compareLines(gtfs, a, b),
	);

	const stopGroups: StopGroupDto[] = routeIds.flatMap((routeId) =>
		(gtfs.routeDirections.get(routeId) ?? []).map((direction) => {
			const { directionId } = direction;
			const skip = alert.skips.find((entry) => entry.routeId === routeId && entry.directionId === directionId);
			const removed = new Set(skip?.stopIds ?? []);
			const sequence = mergedSequence(patternsFor(gtfs, routeId, directionId));
			return {
				routeId,
				directionId,
				line: lineOf(gtfs, routeId),
				headsign: direction.headsigns.join(" / "),
				stops: sequence.map((stop) => ({
					stopId: stop.stopId,
					name: gtfs.stopNames.get(stop.stopId) ?? stop.name,
					removed: removed.has(stop.stopId),
				})),
				replacedBy: associated
					.filter((modification) => modification.routeId === routeId && modification.directionId === directionId)
					.map((modification) => modification.uid),
			};
		}),
	);

	const tripSets = alert.tripSets.map((set) =>
		describeTripSet(gtfs, set.routeId, set.directionId, set, alert.periods, null),
	);

	const { phase, detail } = alertPhaseOf(alert, now);
	const impact = (() => {
		const received = receivedImpact(alert.alertNumber, deps);
		const rewritten = deps.store.alertSettings(alert.alertNumber).impact;
		return { received, published: rewritten?.entities ?? received, overridden: rewritten !== null };
	})();
	const warnings = alertWarnings(published, stopGroups, tripSets, associated.length);
	if (alert.custom && impact.published.length === 0) {
		warnings.unshift("Aucune entité touchée dans l'impact : l'alerte ne peut pas être publiée.");
	}
	return {
		alertNumber: alert.alertNumber,
		inFeed: alert.inFeed,
		custom: alert.custom,
		publishedAt: alert.publishedAt,
		unpublishAt: alert.unpublishAt,
		hidden: alert.hidden,
		active: alert.active,
		publication: alertPublicationOf(alert),
		phase,
		phaseDetail: detail,
		// Nettoyé plutôt qu'échappé : le flux amont reprend ce que le CMS de l'exploitant a saisi,
		// listes et plans de déviation compris (cf. `sanitizeHtml`).
		received: { ...receivedText, descriptionHtml: alert.custom ? "" : sanitizeHtml(alert.descriptionText) },
		published,
		overrides,
		periods: alert.periods,
		sourcePeriods: alert.sourcePeriods,
		// Créée à la main, elle n'a d'autres périodes que les siennes.
		periodsOverridden: alert.custom || alert.periodsOverridden,
		feedPeriods: feedPeriodsOf(alert, received, now),
		lines: [...new Set(alert.routeIds)]
			.sort((a, b) => compareLines(gtfs, a, b))
			.map((routeId) => lineOf(gtfs, routeId)),
		stopGroups,
		tripSets,
		modifications: alert.modificationUids,
		modificationPeriods: Object.fromEntries(
			associated.flatMap((modification) => {
				const periods = modification.record.alertPeriods.get(alert.alertNumber);
				return periods === undefined ? [] : [[modification.uid, periods]];
			}),
		),
		warnings,
		firstSeenAt: alert.firstSeenAt,
		checkedAt: deps.store.alertSettings(alert.alertNumber).checked?.at ?? null,
		impact,
	};
}

/**
 * Un ensemble de courses annulées, tel que l'interface l'affiche : combien de courses il annule sur les
 * jours des périodes, et sur les tracés `patternIds` s'il en nomme (`null` : tous).
 */
function describeTripSet(
	gtfs: StaticGtfs,
	routeId: string,
	directionId: number,
	{ enabled, selection }: Pick<TripSet, "enabled" | "selection">,
	periods: readonly AlertPeriod[],
	patternIds: readonly string[] | null,
): TripSetDto {
	const headsign = headsignsOf(gtfs, routeId, directionId).join(" / ");
	const base = { routeId, directionId, enabled, selection, line: lineOf(gtfs, routeId), headsign };
	if (selection.kind === "range") {
		const count = departuresFor(gtfs, routeId, directionId, periods, patternIds).filter((entry) =>
			inWindow(selection, entry.departure % 86_400),
		).length;
		return { ...base, count, departures: [] };
	}
	const departures = selection.departures.map(({ stopId, departure }) => ({
		stopId,
		departure,
		name: gtfs.stopNames.get(stopId) ?? stopId,
		// Une course que le GTFS ne connaît plus — il a changé depuis — ne s'annule plus : on le dit.
		known: gtfs.courseVersions.has(courseKey(routeId, directionId, stopId, departure)),
	}));
	return { ...base, count: departures.filter((entry) => entry.known).length, departures };
}

/**
 * Ce qui, dans une info trafic, mérite qu'on y revienne : un effet qui annonce une perturbation que rien
 * ne traduit ; des départs annulés que le GTFS ne connaît plus.
 */
function alertWarnings(
	published: { headerText: string; descriptionText: string; effect: string | null },
	groups: readonly StopGroupDto[],
	tripSets: readonly TripSetDto[],
	modificationCount: number,
): string[] {
	const warnings: string[] = [];
	const label = published.effect === null ? undefined : EFFECT_LABELS[published.effect];
	const translated =
		groups.some((group) => group.replacedBy.length === 0 && group.stops.some((stop) => stop.removed)) ||
		tripSets.some((set) => set.enabled) ||
		modificationCount > 0;
	if (label !== undefined && !translated) {
		warnings.push(
			`L'effet « ${label} » n'est traduit par aucun arrêt supprimé, aucune course annulée ni aucune modification associée.`,
		);
	}

	const unknown = tripSets.flatMap((set) => set.departures).filter((entry) => !entry.known).length;
	if (unknown > 0)
		warnings.push(`${unknown} départ(s) annulé(s) ne figure(nt) plus au GTFS : ils n'annulent plus rien.`);

	return warnings;
}
/**
 * Un tronçon n'entre dans le feed qu'avec sa borne amont — c'est elle qui désigne les courses, avec
 * la borne aval s'il en a une — et de quoi dire quelque chose. Sans borne aval, il court jusqu'au
 * bout de la course et ne supprime rien : il lui faut un tracé.
 *
 * Quand sa plage supprime des arrêts, ce quelque chose est des arrêts de substitution, un tracé, ou
 * les deux : le tracé seul suffit, le segment est alors supprimé sans report, et l'itinéraire porte
 * toute l'information. Quand elle n'en supprime aucun, c'est le tracé et rien d'autre — il n'y a
 * rien à remplacer (cf. `removesStops`).
 */
function isSegmentPublishable(segment: DetourSegment, modification: ResolvedModification, gtfs: StaticGtfs): boolean {
	if (segment.startStopId === null) return false;
	const removes = removesStops(
		gtfs,
		modification.routeId,
		modification.directionId,
		modification.patternIds,
		modification.removedStopIds,
		segment,
	);
	if (!removes) return segment.path.length >= 2;
	return segment.stops.length > 0 || segment.path.length >= 2;
}

/**
 * Tout ce que l'édition doit afficher, en un seul aller-retour : ce qui a été saisi, les tracés du
 * sens avec leurs arrêts, leurs shapes, les bornes déduites, et les tronçons.
 *
 * Les shapes partent en polylignes encodées plutôt qu'en tableaux de coordonnées : une ligne de bus
 * en compte quelques milliers de points, et la page sait les décoder en quinze lignes.
 */
function detail(modification: ResolvedModification, deps: AdminDependencies): ModificationDetailDto {
	const gtfs = deps.gtfs.data;
	const record = modification.record;
	const { routeId, directionId } = modification;

	// Les tracés empruntés du sens, services partiels compris : la modification peut n'en viser que
	// certains, et c'est sur leurs arrêts que se choisissent les bornes de ses tronçons.
	const routePatterns = patternsFor(gtfs, routeId, directionId);
	const labels = patternLabels(routePatterns, gtfs);
	const perDay = tripsPerPattern(gtfs, nextWeekday());
	const offsets = scheduledOffsets(gtfs, routePatterns);
	const patterns = routePatterns.map((pattern, index) => ({
		patternId: pattern.patternId,
		shapeId: pattern.shapeId,
		label: labels[index] as string,
		stopCount: pattern.stops.length,
		tripsPerDay: perDay.get(pattern.patternId) ?? 0,
		sequence: pattern.stops.map((stop, rank) => ({
			stopId: stop.stopId,
			name: gtfs.stopNames.get(stop.stopId) ?? stop.name,
			...(gtfs.stopCoordinates.get(stop.stopId) ?? { latitude: null, longitude: null }),
			removed: modification.removedStopIds.has(stop.stopId),
			offset: offsets.get(pattern.patternId)?.[rank] ?? null,
		})),
	}));

	const shapes = [...new Set(routePatterns.map((pattern) => pattern.shapeId))].flatMap((shapeId) => {
		const points = gtfs.shapes.get(shapeId);
		return points === undefined ? [] : [{ shapeId, encodedPolyline: encodePolyline(points) }];
	});

	// Rien n'a encore été déclaré : les suites d'arrêts supprimés du meilleur itinéraire proposent
	// d'emblée un tronçon chacune. Sans arrêt supprimé, c'est un tronçon vierge qu'on propose — entre
	// quels arrêts la course passe ailleurs reste à choisir.
	const boundsCandidates = deduceBounds(
		gtfs,
		routeId,
		directionId,
		modification.removedStopIds,
		modification.patternIds,
	);
	const proposed = boundsCandidates.filter((bounds) => bounds.itinerary === boundsCandidates[0]?.itinerary);
	const fallback: DetourSegment[] = (
		modification.removedStopIds.size === 0 ? [{ startStopId: null, endStopId: null }] : proposed
	).map((bounds) => ({
		startStopId: bounds.startStopId,
		endStopId: bounds.endStopId,
		propagatedDelay: 0,
		terminus: null,
		stops: [],
		waypoints: [],
		path: [],
	}));
	const segments = record.segments.length > 0 ? record.segments : fallback;

	return {
		...summarize(modification, deps, Temporal.Now.instant()),
		patternIds: record.patternIds,
		removedStopIds: [...modification.removedStopIds],
		patterns,
		shapes,
		boundsCandidates,
		// Les déviations dont un tronçon recouvre l'un des siens : celles que sa priorité écrase quand
		// elles valent ensemble, et celles qui l'écrasent. À priorité égale, les tronçons se fusionnent.
		overrides: rivals(modification, deps)
			.filter((other) => other.record.priority < record.priority)
			.map(describeOther),
		overriddenBy: rivals(modification, deps)
			.filter((other) => other.record.priority > record.priority)
			.map(describeOther),
		// Un arrêt n'est que désigné : son libellé et sa position se relisent à l'affichage, du GTFS ou de
		// la base provisoire. `tripsByPattern` dit combien de courses ces bornes-là modifieraient sur
		// chaque tracé — zéro partout, et le tronçon ne sortira pas du tout dans le feed.
		segments: segments.map((segment, rank) => ({
			startStopId: segment.startStopId,
			endStopId: segment.endStopId,
			propagatedDelay: segment.propagatedDelay,
			terminus: segment.terminus,
			stops: segment.stops.map((stop) => ({ ...stop, ...describeStop(stop.stopId, deps) })),
			waypoints: segment.waypoints,
			path: segment.path,
			publishable: isSegmentPublishable(segment, modification, gtfs),
			tripsByPattern: Object.fromEntries(countTripsByPattern(segment, modification, deps)),
			// Les tracés où un tronçon plus prioritaire l'écrase en ce moment.
			overriddenOn: [...(modification.overridden.get(rank) ?? [])],
		})),
		tripSets: record.tripSets.map((set) =>
			describeTripSet(gtfs, routeId, directionId, set, modification.periods, targetedPatterns(record.patternIds)),
		),
	};
}

/** Les tracés que vise une modification, ou `null` : tous. */
function targetedPatterns(patternIds: readonly string[]): readonly string[] | null {
	return patternIds.length === 0 ? null : patternIds;
}

/**
 * Les déviations dont un tronçon recouvre l'un de ceux-ci, actives ou non : ce qui les active peut
 * changer d'un jour à l'autre, et c'est en les préparant qu'il faut savoir laquelle l'emporte.
 */
function rivals(modification: ResolvedModification, deps: AdminDependencies): ResolvedModification[] {
	return [...deps.modificationIndex.modifications.values()].filter(
		(other) => other.uid !== modification.uid && collides(modification, other, deps.gtfs.data),
	);
}

/**
 * Les départs d'une ligne et d'un sens qu'une info trafic ou une modification peut annuler : ceux des
 * courses qui circulent au moins une journée de ses périodes, parmi les {@link DEPARTURE_WINDOW_DAYS}
 * qui suivent leur premier jour non passé — aujourd'hui, si rien ne les borne. C'est le GTFS du moment
 * qui les donne : une course qu'il ne connaît plus n'y est pas.
 *
 * Avec `patternIds`, seules les courses de ces tracés : une modification n'annule que sur les siens.
 * Des périodes closes avant aujourd'hui n'en proposent aucun.
 */
function departuresFor(
	gtfs: StaticGtfs,
	routeId: string,
	directionId: number,
	periods: readonly AlertPeriod[],
	patternIds: readonly string[] | null = null,
) {
	const today = Temporal.Now.plainDateISO(TIME_ZONE);
	const dateOf = (bound: string) => Temporal.PlainDate.from(bound.slice(0, 10));

	const starts = periods.map((period) => (period.start === null ? today : dateOf(period.start)));
	const ends = periods.map((period) => (period.end === null ? null : dateOf(period.end)));

	let first = starts.reduce((a, b) => (Temporal.PlainDate.compare(a, b) <= 0 ? a : b), today);
	if (Temporal.PlainDate.compare(first, today) < 0) first = today;
	let last = first.add({ days: DEPARTURE_WINDOW_DAYS - 1 });
	if (ends.length > 0 && ends.every((end) => end !== null)) {
		const end = (ends as Temporal.PlainDate[]).reduce((a, b) => (Temporal.PlainDate.compare(a, b) >= 0 ? a : b));
		if (Temporal.PlainDate.compare(end, last) < 0) last = end;
	}

	const departures = new Map<
		string,
		{ stopId: string; departure: number; name: string; headsign: string; patternIds: Set<string> }
	>();

	for (let date = first; Temporal.PlainDate.compare(date, last) <= 0; date = date.add({ days: 1 })) {
		for (const serviceId of serviceDay(gtfs, date).services) {
			for (const tripId of gtfs.serviceTrips.get(serviceId) ?? []) {
				const meta = gtfs.trips.get(tripId);
				if (meta === undefined || meta.routeId !== routeId || meta.directionId !== directionId) continue;

				const origin = gtfs.tripStopSequences.get(tripId)?.[0];
				const departure = gtfs.tripDepartures.get(tripId);
				const patternId = gtfs.tripPatterns.get(tripId);
				if (origin === undefined || departure === undefined || patternId === undefined) continue;
				if (patternIds !== null && !patternIds.includes(patternId)) continue;

				const key = `${origin.stopId}|${departure}`;
				const known = departures.get(key);
				if (known !== undefined) {
					known.patternIds.add(patternId);
					continue;
				}
				departures.set(key, {
					stopId: origin.stopId,
					departure,
					name: gtfs.stopNames.get(origin.stopId) ?? origin.stopId,
					headsign: meta.headsign,
					patternIds: new Set([patternId]),
				});
			}
		}
	}

	return [...departures.values()]
		.sort((a, b) => a.departure - b.departure || a.name.localeCompare(b.name, "fr"))
		.map((entry) => ({ ...entry, patternIds: [...entry.patternIds] }));
}

/**
 * Les départs d'une ligne et d'un sens, journée de service par journée : aujourd'hui, les seules
 * courses qui ne sont pas encore arrivées — parties ou à venir —, puis les
 * {@link DEPARTURE_WINDOW_DAYS} journées suivantes en entier.
 *
 * Seuls les départs qui tombent dans les périodes ce jour-là : ce sont les seuls qui s'annulent (cf.
 * `isCancelled`). Une journée qui n'en porte aucun n'est pas rendue.
 */
function departureDays(
	gtfs: StaticGtfs,
	routeId: string,
	directionId: number,
	periods: readonly AlertPeriod[],
	now: Temporal.Instant,
): DepartureDayDto[] {
	const today = now.toZonedDateTimeISO(TIME_ZONE).toPlainDate();
	const nowSeconds = Math.floor(now.epochMilliseconds / 1000);

	const days: DepartureDayDto[] = [];
	for (let offset = 0; offset <= DEPARTURE_WINDOW_DAYS; offset += 1) {
		const date = today.add({ days: offset });
		const { midnight, services } = serviceDay(gtfs, date);
		const departures = new Map<string, DepartureDto & { patterns: Set<string> }>();

		for (const serviceId of services) {
			for (const tripId of gtfs.serviceTrips.get(serviceId) ?? []) {
				const meta = gtfs.trips.get(tripId);
				if (meta === undefined || meta.routeId !== routeId || meta.directionId !== directionId) continue;

				const origin = gtfs.tripStopSequences.get(tripId)?.[0];
				const departure = gtfs.tripDepartures.get(tripId);
				const patternId = gtfs.tripPatterns.get(tripId);
				if (origin === undefined || departure === undefined || patternId === undefined) continue;
				const arrival = gtfs.tripArrivals.get(tripId) ?? departure;
				if (midnight + arrival <= nowSeconds) continue;
				if (!isActive(periods, Temporal.Instant.fromEpochMilliseconds((midnight + departure) * 1000))) continue;

				const key = `${origin.stopId}|${departure}`;
				const known = departures.get(key);
				if (known !== undefined) {
					known.patterns.add(patternId);
					continue;
				}
				departures.set(key, {
					stopId: origin.stopId,
					departure,
					name: gtfs.stopNames.get(origin.stopId) ?? origin.stopId,
					headsign: meta.headsign,
					patternIds: [],
					patterns: new Set([patternId]),
					underway: midnight + departure <= nowSeconds,
				});
			}
		}

		if (departures.size === 0) continue;
		days.push({
			date: date.toString(),
			departures: [...departures.values()]
				.sort((a, b) => a.departure - b.departure || a.name.localeCompare(b.name, "fr"))
				.map(({ patterns, ...entry }) => ({ ...entry, patternIds: [...patterns] })),
		});
	}
	return days;
}

/**
 * Le libellé d'un tracé : « premier arrêt → dernier arrêt ». Deux tracés qui partent et arrivent au
 * même endroit se départagent par le premier arrêt que l'un dessert et pas l'autre.
 */
function patternLabels(patterns: readonly RoutePattern[], gtfs: StaticGtfs): string[] {
	const nameOf = (stopId: string | undefined) => (stopId === undefined ? "?" : (gtfs.stopNames.get(stopId) ?? stopId));
	const base = patterns.map(
		(pattern) => `${nameOf(pattern.stops[0]?.stopId)} → ${nameOf(pattern.stops.at(-1)?.stopId)}`,
	);

	return patterns.map((pattern, index) => {
		const twins = patterns.filter((_, other) => other !== index && base[other] === base[index]);
		if (twins.length === 0) return base[index] as string;

		const elsewhere = new Set(twins.flatMap((twin) => twin.stops.map((stop) => stop.stopId)));
		const own = pattern.stops.find((stop) => !elsewhere.has(stop.stopId));
		return own === undefined
			? `${base[index]} (${pattern.stops.length} arrêts)`
			: `${base[index]} via ${nameOf(own.stopId)}`;
	});
}

/**
 * Combien de courses les bornes d'un tronçon désignent sur chaque tracé du sens, visé ou non. Rien
 * tant que la borne amont n'est pas arrêtée ; sans borne aval, toutes celles qui desservent l'amont.
 */
function countTripsByPattern(
	bounds: SegmentBounds,
	modification: ResolvedModification,
	deps: AdminDependencies,
): Map<string, number> {
	if (bounds.startStopId === null) return new Map();

	return countSelectableTrips(deps.gtfs.data, modification.routeId, modification.directionId, bounds, nowSeconds());
}

/**
 * Les périodes saisies d'une info trafic : une liste de `{ start, end, dailyWindow }`, chaque borne un
 * objet `{ date, time }` — la date est obligatoire, l'heure facultative. `dailyWindow`, `{ from, to }`
 * ou rien, restreint la période à une tranche horaire chaque jour de ses dates. Une période laissée
 * entièrement vide est passée sous silence — c'est une ligne du formulaire qu'on n'a pas remplie.
 * Aucune : l'info trafic vaut tant qu'elle est au flux.
 *
 * Les périodes repartent dans l'ordre de leur début ; elles peuvent se recouvrir, l'info trafic vaut
 * alors sur leur réunion.
 */
function parsePeriods(raw: unknown): { periods: SavedPeriod[] } | { message: string } {
	if (!Array.isArray(raw)) return { message: "Périodes attendues : une liste, ou null." };

	const periods: SavedPeriod[] = [];
	for (const [index, entry] of raw.entries()) {
		const which = raw.length > 1 ? `Période ${index + 1} : ` : "";
		const parsed = parsePeriod(entry);
		if ("message" in parsed) return { message: which + parsed.message };
		if (parsed.period !== null) periods.push(parsed.period);
	}

	// « AAAA-MM-JJ » se range avant « AAAA-MM-JJTHH:MM » du même jour : c'est bien minuit.
	periods.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
	return { periods };
}

/** Assez pour reconnaître une modification dans la liste, pas pour en faire un texte. */
const DESCRIPTION_MAX_LENGTH = 80;

/** La description d'une modification, ou `null` si elle a été laissée vide. */
function parseDescription(raw: unknown): string | null | { message: string } {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "string") return { message: "Description attendue : un texte." };
	const description = raw.trim();
	if (description.length > DESCRIPTION_MAX_LENGTH) {
		return { message: `Description trop longue : ${DESCRIPTION_MAX_LENGTH} caractères au plus.` };
	}
	return description.length > 0 ? description : null;
}

/**
 * Une période saisie, ou `null` si elle a été laissée vide. La fin peut manquer — la période est
 * alors ouverte — et doit sinon venir après le début.
 *
 * Avec une tranche horaire, les bornes se saisissent à la journée : la tranche se répète de la date de
 * début à celle de fin, incluses (cf. `isDayInEnvelope`), et une heure de borne n'y changerait rien.
 */
function parsePeriod(raw: unknown): { period: SavedPeriod | null } | { message: string } {
	if (typeof raw !== "object" || raw === null) return { message: "Période illisible." };
	const entry = raw as Record<string, unknown>;

	const start = readBound(entry.start, "début");
	if ("message" in start) return start;
	const end = readBound(entry.end, "fin");
	if ("message" in end) return end;
	const daily = readDailyWindow(entry.dailyWindow);
	if ("message" in daily) return daily;

	if (start.bound === null) {
		if (end.bound !== null) return { message: "Une fin sans début : saisir aussi la date de début." };
		if (daily.window !== null) return { message: "Une tranche horaire sans dates : saisir aussi la date de début." };
		return { period: null };
	}

	if (daily.window !== null && (start.time !== null || (end.bound !== null && end.time !== null))) {
		return { message: "Avec une tranche horaire quotidienne, les dates se saisissent sans heure." };
	}

	// La fin se compare comme elle se jauge : exclusive, et à la journée entière quand elle est sans
	// heure (cf. `periodEnd`). « Du 24 au 24 » couvre donc bien la journée.
	if (end.bound !== null) {
		const from = start.time === null ? start.date.toPlainDateTime() : start.date.toPlainDateTime(start.time);
		const until = end.time === null ? end.date.add({ days: 1 }).toPlainDateTime() : end.date.toPlainDateTime(end.time);
		if (Temporal.PlainDateTime.compare(until, from) <= 0) return { message: "La fin doit venir après le début." };
	}

	return { period: { start: start.bound, end: end.bound, dailyWindow: daily.window } };
}

/**
 * La tranche horaire quotidienne d'une période, ou `null` si elle a été laissée vide. Une fin qui ne
 * vient pas après le début passe minuit : « 21:00 → 05:00 » court jusqu'au lendemain matin.
 */
function readDailyWindow(raw: unknown): { window: DailyWindow | null } | { message: string } {
	if (raw === undefined || raw === null) return { window: null };
	if (typeof raw !== "object") return { message: "Tranche horaire illisible." };

	const payload = raw as Record<string, unknown>;
	const from = typeof payload.from === "string" ? payload.from.trim() : "";
	const to = typeof payload.to === "string" ? payload.to.trim() : "";

	if (from.length === 0 && to.length === 0) return { window: null };
	if (from.length === 0 || to.length === 0) {
		return { message: "Tranche horaire : saisir l'heure de début et celle de fin." };
	}
	if (!TIME_PATTERN.test(from) || !TIME_PATTERN.test(to)) {
		return { message: "Tranche horaire attendue au format HH:MM." };
	}
	if (from === to) return { message: "Tranche horaire vide : le début et la fin sont à la même heure." };
	return { window: { from, to } };
}

/**
 * Les tracés visés. Facultatifs : sans eux, la modification les vise tous. Un tracé inconnu est
 * refusé plutôt qu'écarté — l'écarter élargirait en silence la modification à des courses qu'on n'a
 * pas choisies. Les nommer tous revient à n'en nommer aucun, et cette forme-là survit à un tracé que
 * le GTFS ajouterait demain.
 */
function parsePatterns(raw: unknown, patterns: readonly RoutePattern[]): { ids: string[] } | { message: string } {
	if (raw === undefined || raw === null) return { ids: [] };
	if (!Array.isArray(raw)) return { message: "Tracés visés attendus : une liste." };

	const ids: string[] = [];
	for (const patternId of raw) {
		if (typeof patternId !== "string" || !patterns.some((pattern) => pattern.patternId === patternId)) {
			return { message: `Tracé « ${String(patternId)} » inconnu du GTFS pour cette ligne et ce sens.` };
		}
		if (!ids.includes(patternId)) ids.push(patternId);
	}

	return { ids: ids.length === patterns.length ? [] : ids };
}

/**
 * Relit et contrôle ce que l'interface envoie. Tout est vérifié ici : au-delà, on écrit en base et on
 * publie dans le feed, où une coordonnée fantaisiste ou un temps de parcours qui recule se verrait
 * chez tous les consommateurs.
 */
function parseInput(
	payload: Record<string, unknown>,
	routeId: string,
	directionId: number,
	currentPriority: number,
	deps: AdminDependencies,
): { input: ModificationInput } | { message: string } {
	const gtfs = deps.gtfs.data;

	const description = parseDescription(payload.description);
	if (typeof description === "object" && description !== null) return description;

	const patternIds = parsePatterns(payload.patternIds, patternsFor(gtfs, routeId, directionId));
	if ("message" in patternIds) return patternIds;

	const input: ModificationInput = {
		description,
		patternIds: patternIds.ids,
		removedStopIds: [],
		segments: [],
		priority: currentPriority,
		tripSets: [],
	};

	if (!Array.isArray(payload.removedStopIds)) return { message: "Arrêts supprimés attendus : une liste." };
	for (const stopId of payload.removedStopIds) {
		if (typeof stopId !== "string" || !gtfs.stopNames.has(stopId)) {
			return { message: `Arrêt « ${String(stopId)} » inconnu du GTFS.` };
		}
		input.removedStopIds.push(stopId);
	}

	if (!Array.isArray(payload.segments)) return { message: "Liste de tronçons attendue." };
	// Deux entrées qui désignent le même arrêt donneraient deux `replacement_stops` de même `stop_id` :
	// la course s'y arrêterait deux fois. Tous tronçons confondus — ils se suivent sur la même course.
	const designated = new Set<string>();
	for (const [index, raw] of payload.segments.entries()) {
		const parsed = parseSegment(raw, `Tronçon ${index + 1}`, designated, gtfs, deps.store);
		if ("message" in parsed) return parsed;
		input.segments.push(parsed.segment);
	}

	const priority = payload.priority ?? currentPriority;
	if (!Number.isInteger(priority)) return { message: "Priorité attendue : un nombre entier." };
	input.priority = priority as number;

	const setList = readList(payload.tripSets, "tripSets");
	if ("message" in setList) return setList;
	for (const [index, entry] of setList.list.entries()) {
		const parsed = readTripSet(entry, `Ensemble de courses ${index + 1}`, gtfs);
		if ("message" in parsed) return parsed;
		input.tripSets.push(parsed.set);
	}

	const overlap = overlappingSegments(gtfs, routeId, directionId, input.patternIds, input.segments);
	if (overlap !== undefined) {
		return {
			message:
				`Tronçons ${overlap[0] + 1} et ${overlap[1] + 1} : leurs plages se recoupent sur l'un des tracés visés. ` +
				"Un même arrêt ne peut être supprimé deux fois — fondre les deux tronçons, ou reprendre les bornes.",
		};
	}

	return { input };
}

/** Les noms des énumérations de cause et d'effet du GTFS-RT, ceux qu'une réécriture peut prendre. */
function isEnumName(values: object, name: string): boolean {
	return Object.hasOwn(values, name) && Number.isNaN(Number(name));
}

/**
 * Un texte réécrit : `null` s'il est laissé vide, une erreur s'il dépasse la longueur admise — sans
 * `maxLength`, il n'en a pas.
 */
function readOverride(raw: unknown, label: string, maxLength?: number): { value: string | null } | { message: string } {
	if (raw === undefined || raw === null) return { value: null };
	if (typeof raw !== "string") return { message: `${label} attendu : un texte, ou null.` };
	const value = raw.trim();
	if (maxLength !== undefined && value.length > maxLength) {
		return { message: `${label} trop long : ${maxLength} caractères au plus.` };
	}
	return { value: value.length === 0 ? null : value };
}

/**
 * Ce qui empêche une info trafic créée à la main d'être publiée : un titre manquant, ou un impact vide —
 * GTFS-RT veut au moins une entité touchée. `null` : rien.
 */
function unpublishable(overrides: AlertOverrides, impact: readonly ImpactEntity[]): "title" | "impact" | null {
	if (overrides.headerText === null) return "title";
	if (impact.length === 0) return "impact";
	return null;
}

/**
 * Un champ qui se réécrit ou se retire : `null` (ou absent) garde celui du flux, `""` n'en garde aucun,
 * un texte le remplace.
 */
function readRemovable(raw: unknown, label: string, maxLength: number): { value: string | null } | { message: string } {
	if (raw === undefined || raw === null) return { value: null };
	if (typeof raw !== "string") return { message: `${label} attendu : un texte, ou null.` };
	const value = raw.trim();
	if (value.length > maxLength) return { message: `${label} trop long : ${maxLength} caractères au plus.` };
	return { value };
}

/** Une ligne et un sens du GTFS, ou une erreur. */
function readRouteDirection(
	entry: Record<string, unknown>,
	gtfs: StaticGtfs,
	label: string,
): { routeId: string; directionId: number } | { message: string } {
	const { routeId, directionId } = entry;
	if (
		typeof routeId !== "string" ||
		typeof directionId !== "number" ||
		!gtfs.routeDirections.get(routeId)?.some((direction) => direction.directionId === directionId)
	) {
		return { message: `${label} : ligne ou sens inconnu du GTFS.` };
	}
	return { routeId, directionId };
}

/** Une liste d'objets, ou une erreur qui nomme le champ. */
function readList(raw: unknown, field: string): { list: Record<string, unknown>[] } | { message: string } {
	if (!Array.isArray(raw)) return { message: `Liste « ${field} » attendue.` };
	return {
		list: raw.map((value) => (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>),
	};
}

/** Une heure de tranche, en secondes depuis minuit, ou `null`. */
function readClock(raw: unknown): number | null | undefined {
	if (raw === null || raw === undefined) return null;
	return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < 86_400 ? raw : undefined;
}

/** Un ensemble de courses saisi, sa ligne et son sens à part : coché ou non, et sa sélection. */
function readTripSet(
	entry: Record<string, unknown>,
	label: string,
	gtfs: StaticGtfs,
): { set: ModificationTripSetInput } | { message: string } {
	const enabled = entry.enabled ?? true;
	if (typeof enabled !== "boolean") return { message: `${label} : booléen « enabled » attendu.` };

	const selection = (typeof entry.selection === "object" && entry.selection !== null ? entry.selection : {}) as Record<
		string,
		unknown
	>;
	if (selection.kind === "range") {
		const from = readClock(selection.from);
		const to = readClock(selection.to);
		if (from === undefined || to === undefined)
			return { message: `${label} : heures attendues en secondes depuis minuit.` };
		if ((from === null) !== (to === null))
			return { message: `${label} : saisir le début et la fin de la tranche, ou aucun.` };
		return { set: { enabled, selection: { kind: "range", from, to } } };
	}
	if (selection.kind !== "departures") return { message: `${label} : type attendu, « range » ou « departures ».` };

	const departureList = readList(selection.departures, "departures");
	if ("message" in departureList) return departureList;
	const departures: { stopId: string; departure: number }[] = [];
	for (const [rank, value] of departureList.list.entries()) {
		const { stopId, departure } = value;
		if (typeof stopId !== "string" || !gtfs.stopNames.has(stopId)) {
			return { message: `${label}, départ ${rank + 1} : arrêt inconnu du GTFS.` };
		}
		if (typeof departure !== "number" || !Number.isInteger(departure) || departure < 0 || departure >= MAX_DEPARTURE) {
			return { message: `${label}, départ ${rank + 1} : horaire attendu en secondes depuis minuit.` };
		}
		departures.push({ stopId, departure });
	}
	if (departures.length === 0) return { message: `${label} : aucun départ choisi.` };
	return { set: { enabled, selection: { kind: "departures", departures } } };
}

/**
 * Relit et contrôle ce que l'interface envoie d'une info trafic. Tout est vérifié ici : au-delà, on
 * écrit en base et l'on publie — un quai inconnu ou un horaire fantaisiste se verraient chez tous les
 * consommateurs.
 */
function parseAlertInput(
	payload: Record<string, unknown>,
	alertNumber: string,
	deps: AdminDependencies,
): { input: AlertInput } | { message: string } {
	const gtfs = deps.gtfs.data;

	const rawOverrides = (
		typeof payload.overrides === "object" && payload.overrides !== null ? payload.overrides : {}
	) as Record<string, unknown>;
	const headerText = readOverride(rawOverrides.headerText, "Titre", HEADER_MAX_LENGTH);
	if ("message" in headerText) return headerText;
	const descriptionText = readOverride(rawOverrides.descriptionText, "Description");
	if ("message" in descriptionText) return descriptionText;
	const cause = readOverride(rawOverrides.cause, "Cause", 40);
	if ("message" in cause) return cause;
	if (cause.value !== null && !isEnumName(Alert.Cause, cause.value))
		return { message: `Cause « ${cause.value} » inconnue.` };
	const effect = readOverride(rawOverrides.effect, "Effet", 40);
	if ("message" in effect) return effect;
	if (effect.value !== null && !isEnumName(Alert.Effect, effect.value)) {
		return { message: `Effet « ${effect.value} » inconnu.` };
	}
	const url = readRemovable(rawOverrides.url, "Lien", LINK_MAX_LENGTH);
	if ("message" in url) return url;
	if (url.value && !/^https?:\/\/[^\s]+$/i.test(url.value)) {
		return { message: "Lien attendu : une adresse en https:// ou http://." };
	}
	const imageUrl = readRemovable(rawOverrides.imageUrl, "Image", LINK_MAX_LENGTH);
	if ("message" in imageUrl) return imageUrl;
	if (imageUrl.value) {
		// Comme pour les images du flux (cf. `sanitizeHtml`) : https:// seulement.
		if (!/^https:\/\/[^\s]+$/i.test(imageUrl.value)) return { message: "Image attendue : une adresse en https://." };
		if (imageMediaType(imageUrl.value) === undefined) {
			return { message: "Image : l'adresse doit finir par .png, .jpg, .jpeg, .gif ou .webp." };
		}
	}
	const imageAlternativeText = readRemovable(rawOverrides.imageAlternativeText, "Texte alternatif", HEADER_MAX_LENGTH);
	if ("message" in imageAlternativeText) return imageAlternativeText;
	const overrides: AlertOverrides = {
		headerText: headerText.value,
		descriptionText: descriptionText.value,
		cause: cause.value,
		effect: effect.value,
		url: url.value,
		imageUrl: imageUrl.value,
		imageAlternativeText: imageAlternativeText.value,
	};

	let periods: SavedPeriod[] | null = null;
	if (payload.periods !== null && payload.periods !== undefined) {
		const parsed = parsePeriods(payload.periods);
		if ("message" in parsed) return parsed;
		periods = parsed.periods;
	}

	const skipList = readList(payload.skipStops ?? [], "skipStops");
	if ("message" in skipList) return skipList;
	const skipStops: SkipOverride[] = [];
	for (const [index, entry] of skipList.list.entries()) {
		const scope = readRouteDirection(entry, gtfs, `Arrêt supprimé ${index + 1}`);
		if ("message" in scope) return scope;
		if (typeof entry.stopId !== "string" || !gtfs.stopNames.has(entry.stopId)) {
			return { message: `Arrêt supprimé ${index + 1} : quai inconnu du GTFS.` };
		}
		if (typeof entry.removed !== "boolean")
			return { message: `Arrêt supprimé ${index + 1} : booléen « removed » attendu.` };
		skipStops.push({ ...scope, stopId: entry.stopId, removed: entry.removed });
	}

	const setList = readList(payload.tripSets ?? [], "tripSets");
	if ("message" in setList) return setList;
	const tripSets: TripSetInput[] = [];
	for (const [index, entry] of setList.list.entries()) {
		const label = `Ensemble de courses ${index + 1}`;
		const scope = readRouteDirection(entry, gtfs, label);
		if ("message" in scope) return scope;
		const parsed = readTripSet(entry, label, gtfs);
		if ("message" in parsed) return parsed;
		tripSets.push({ ...scope, ...parsed.set });
	}

	if (!Array.isArray(payload.modificationUids)) return { message: "Liste « modificationUids » attendue." };
	const modificationUids = payload.modificationUids.map(Number);
	const unknown = modificationUids.find((uid) => !deps.modificationIndex.modifications.has(uid));
	if (unknown !== undefined) return { message: `Modification ${unknown} inconnue.` };

	// Celles d'une modification qu'on dissocie n'ont plus de quoi s'appliquer : elles s'ignorent.
	const rawOwn = payload.modificationPeriods ?? {};
	if (typeof rawOwn !== "object" || rawOwn === null || Array.isArray(rawOwn)) {
		return { message: "Objet « modificationPeriods » attendu." };
	}
	const modificationPeriods = new Map<number, SavedPeriod[]>();
	for (const [key, raw] of Object.entries(rawOwn)) {
		const uid = Number(key);
		if (!modificationUids.includes(uid)) continue;
		const parsed = parsePeriods(raw);
		if ("message" in parsed) return { message: `Modification MOD-${String(uid).padStart(4, "0")} : ${parsed.message}` };
		modificationPeriods.set(uid, parsed.periods);
	}

	let impact: AlertInput["impact"] = null;
	if (payload.impact !== null && payload.impact !== undefined) {
		const parsed = parseImpact(payload.impact, deps);
		if ("message" in parsed) return parsed;
		// Un impact identique à celui du flux n'est pas une réécriture.
		const basis = impactKey(receivedImpact(alertNumber, deps));
		if (impactKey(parsed.entities) !== basis) impact = { entities: parsed.entities, basis };
	}

	const rawUnpublishAt = payload.unpublishAt ?? null;
	if (rawUnpublishAt !== null && !(typeof rawUnpublishAt === "number" && Number.isInteger(rawUnpublishAt))) {
		return { message: "Dépublication automatique : un instant en secondes epoch, ou null, attendu." };
	}
	const unpublishAt = rawUnpublishAt as number | null;

	return {
		input: {
			overrides,
			periods,
			skipStops,
			tripSets,
			modificationUids,
			modificationPeriods,
			impact,
			unpublishAt,
		},
	};
}

/**
 * Ce qui ne va pas dans une dépublication programmée, ou `null`. Elle doit être à venir : échue, elle
 * dépublierait l'alerte à l'instant — c'est le bouton « Dépublier » qui fait cela.
 */
function unpublishAtProblem(unpublishAt: number | null): string | null {
	if (unpublishAt === null || unpublishAt > nowSeconds()) return null;
	return "La dépublication automatique doit être programmée dans le futur.";
}

/**
 * Une alerte dont une période court « à nouvel avis » ne se dépublie pas d'elle-même : rien ne dit
 * quand la perturbation finit, et c'est à la main qu'on la retirera.
 */
function openEndedProblem(unpublishAt: number | null, periods: readonly SavedPeriod[]): string | null {
	if (unpublishAt === null || !periods.some((period) => period.end === null)) return null;
	return "Une période court à nouvel avis : la dépublication automatique n'est pas possible.";
}

/**
 * L'impact que le flux donne à une info trafic, avant toute réécriture, sous sa forme canonique (cf.
 * `canonicalImpact`) — vide hors du flux.
 */
function receivedImpact(alertNumber: string, deps: AdminDependencies): ImpactEntity[] {
	return canonicalImpact(
		informedEntities(deps.receivedAlert(alertNumber)?.informedEntity ?? []),
		directionsOf(deps.gtfs.data),
	);
}

/** Les sens d'une ligne, d'après le GTFS. */
function directionsOf(gtfs: StaticGtfs) {
	return (routeId: string) => (gtfs.routeDirections.get(routeId) ?? []).map((direction) => direction.directionId);
}

/**
 * L'impact réécrit, tel que l'interface l'envoie : chaque entité une agence, une ligne — avec un sens
 * qu'elle a, ou aucun —, ou un arrêt du GTFS ou de la base provisoire.
 */
function parseImpact(raw: unknown, deps: AdminDependencies): { entities: ImpactEntity[] } | { message: string } {
	const list = readList(raw, "impact");
	if ("message" in list) return list;
	const gtfs = deps.gtfs.data;
	const agencies = new Set(gtfs.agencies.keys());
	const text = (value: unknown) => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);

	const entities: ImpactEntity[] = [];
	for (const [index, entry] of list.list.entries()) {
		const label = `Impact, entité ${index + 1}`;
		const agencyId = text(entry.agencyId);
		const routeId = text(entry.routeId);
		const stopId = text(entry.stopId);
		const directionId = entry.directionId ?? null;
		if (agencyId === null && routeId === null && stopId === null) return { message: `${label} : vide.` };
		if (agencyId !== null && !agencies.has(agencyId)) return { message: `${label} : agence « ${agencyId} » inconnue.` };
		if (routeId !== null && !gtfs.routeDirections.has(routeId)) {
			return { message: `${label} : ligne « ${routeId} » inconnue du GTFS.` };
		}
		if (directionId !== null) {
			if (routeId === null) return { message: `${label} : un sens sans ligne.` };
			if (!gtfs.routeDirections.get(routeId)?.some((direction) => direction.directionId === directionId)) {
				return { message: `${label} : la ligne n'a pas ce sens.` };
			}
		}
		if (stopId !== null && !gtfs.stopNames.has(stopId) && !deps.store.provisionalStops.has(stopId)) {
			return { message: `${label} : arrêt « ${stopId} » inconnu.` };
		}
		entities.push({ agencyId, routeId, directionId: directionId as number | null, stopId });
	}
	return { entities: canonicalImpact(entities, directionsOf(gtfs)) };
}

/**
 * Le temps théorique de chaque arrêt d'un tracé depuis son premier, en secondes : la médiane sur les
 * courses du tracé, que l'heure de pointe ou le soir n'emportent pas. `null` là où l'horaire se tait.
 * C'est de quoi se donner une idée du temps de parcours nominal d'une portion de ligne.
 */
function scheduledOffsets(gtfs: StaticGtfs, patterns: readonly RoutePattern[]): Map<string, (number | null)[]> {
	const wanted = new Map(patterns.map((pattern) => [pattern.patternId, pattern.stops.length]));
	const samples = new Map<string, number[][]>();
	for (const [tripId, patternId] of gtfs.tripPatterns) {
		const length = wanted.get(patternId);
		const schedule = gtfs.tripStopSequences.get(tripId);
		if (length === undefined || schedule === undefined || schedule.length !== length) continue;
		const origin = schedule[0]?.arrival ?? Number.NaN;
		const columns = samples.get(patternId) ?? Array.from({ length }, () => [] as number[]);
		schedule.forEach((stop, rank) => {
			const offset = stop.arrival - origin;
			if (Number.isFinite(offset)) columns[rank]?.push(offset);
		});
		samples.set(patternId, columns);
	}

	const median = (values: number[]) => {
		if (values.length === 0) return null;
		const sorted = [...values].sort((a, b) => a - b);
		return sorted[Math.floor(sorted.length / 2)] as number;
	};
	return new Map([...samples].map(([patternId, columns]) => [patternId, columns.map(median)]));
}

/** Le prochain mardi, aujourd'hui compris : un jour ouvré type, qui n'est ni un lundi ni un vendredi. */
function nextWeekday(): Temporal.PlainDate {
	const today = Temporal.Now.plainDateISO(TIME_ZONE);
	return today.add({ days: (2 - today.dayOfWeek + 7) % 7 });
}

/** Combien de courses empruntent chaque tracé, une journée de service donnée. */
function tripsPerPattern(gtfs: StaticGtfs, date: Temporal.PlainDate): Map<string, number> {
	const counts = new Map<string, number>();
	for (const serviceId of serviceDay(gtfs, date).services) {
		for (const tripId of gtfs.serviceTrips.get(serviceId) ?? []) {
			const patternId = gtfs.tripPatterns.get(tripId);
			if (patternId !== undefined) counts.set(patternId, (counts.get(patternId) ?? 0) + 1);
		}
	}
	return counts;
}
/** Une modification telle que l'édition d'une autre la cite : de quoi la reconnaître, et l'ouvrir. */
function describeOther(modification: ResolvedModification): RivalDto {
	return {
		uid: modification.uid,
		description: modification.description,
		state: publicationOf(modification, Temporal.Now.instant()).state,
		active: modification.active,
		priority: modification.record.priority,
		segmentCount: modification.record.segments.length,
	};
}

/** Un tronçon tel que l'interface l'envoie, contrôlé de bout en bout. */
function parseSegment(
	raw: unknown,
	label: string,
	designated: Set<string>,
	gtfs: StaticGtfs,
	store: DetourStore,
): { segment: DetourSegment } | { message: string } {
	if (typeof raw !== "object" || raw === null) return { message: `${label} : illisible.` };
	const payload = raw as Record<string, unknown>;

	const startStopId = payload.startStopId ?? null;
	const endStopId = payload.endStopId ?? null;
	if (startStopId !== null && (typeof startStopId !== "string" || !gtfs.stopNames.has(startStopId))) {
		return { message: `${label} : borne amont inconnue du GTFS.` };
	}
	if (endStopId !== null && (typeof endStopId !== "string" || !gtfs.stopNames.has(endStopId))) {
		return { message: `${label} : borne aval inconnue du GTFS.` };
	}

	const propagatedDelay = payload.propagatedDelay ?? 0;
	if (!Number.isInteger(propagatedDelay)) {
		return { message: `${label} : le délai propagé doit être un entier de secondes.` };
	}
	// Rien n'est refusé ici à un tronçon dont la plage ne supprime aucun arrêt : le périmètre peut
	// changer APRÈS l'enregistrement, et cet état-là est de toute façon à traverser. Ses arrêts de
	// substitution sont alors laissés de côté à la publication, qui le dit (cf. `collectCandidates`).
	if (!Array.isArray(payload.stops)) return { message: `${label} : liste d'arrêts de substitution attendue.` };
	const stops: DetourSegment["stops"] = [];
	let previousTravelTime = Number.NEGATIVE_INFINITY;

	for (const [index, entry] of payload.stops.entries()) {
		if (typeof entry !== "object" || entry === null) return { message: `${label}, arrêt ${index + 1} : illisible.` };
		const stop = entry as Record<string, unknown>;

		// Un tronçon ne fait que DÉSIGNER des arrêts : ce qu'ils sont — leur nom, leur position — vit
		// dans le GTFS ou dans la base provisoire, jamais ici. Rien à valider de plus que l'existence.
		const stopId = stop.stopId;
		if (typeof stopId !== "string" || stopId.length === 0) {
			return { message: `${label}, arrêt ${index + 1} : identifiant manquant.` };
		}
		if (!gtfs.stopNames.has(stopId) && !store.provisionalStops.has(stopId)) {
			return {
				message: `${label}, arrêt ${index + 1} : « ${stopId} » n'existe ni dans le GTFS ni dans les arrêts provisoires.`,
			};
		}
		if (designated.has(stopId)) {
			return { message: `${label}, arrêt ${index + 1} : cet arrêt figure déjà dans la déclaration.` };
		}
		designated.add(stopId);

		const travelTime = stop.travelTime;
		if (!Number.isInteger(travelTime)) {
			return { message: `${label}, arrêt ${index + 1} : temps de parcours attendu en secondes.` };
		}
		// La spec l'exige croissant : c'est un temps cumulé depuis l'arrêt de référence, pas un intervalle.
		if ((travelTime as number) <= previousTravelTime) {
			return {
				message: `${label}, arrêt ${index + 1} : le temps de parcours doit dépasser celui de l'arrêt précédent.`,
			};
		}
		previousTravelTime = travelTime as number;

		stops.push({ stopId, travelTime: travelTime as number });
	}

	if (!Array.isArray(payload.path)) return { message: `${label} : tracé attendu, une liste de points.` };
	const path = [];
	for (const [index, entry] of payload.path.entries()) {
		const point = Array.isArray(entry) ? readCoordinates(entry[0], entry[1]) : undefined;
		if (point === undefined) return { message: `${label}, point ${index + 1} du tracé : coordonnées hors du réseau.` };
		path.push(point);
	}
	// Un tracé d'un seul point ne décrit rien, et `Shape` en réclame deux au minimum.
	if (path.length === 1) return { message: `${label} : un tracé doit compter au moins deux points.` };

	// Les points de passage sont facultatifs : sans eux, le tracé EST sa propre suite de points de
	// passage, tirés droit — c'est le dessin libre d'avant, et un PUT écrit à la main reste valable.
	const waypoints: DetourSegment["waypoints"] = [];
	if (payload.waypoints === undefined) {
		waypoints.push(...path.map((point) => ({ ...point, mode: "free" as const })));
	} else {
		if (!Array.isArray(payload.waypoints)) return { message: `${label} : points de passage attendus, une liste.` };

		for (const [index, entry] of payload.waypoints.entries()) {
			if (typeof entry !== "object" || entry === null) {
				return { message: `${label}, point de passage ${index + 1} : illisible.` };
			}
			const waypoint = entry as Record<string, unknown>;

			const point = Array.isArray(waypoint.point) ? readCoordinates(waypoint.point[0], waypoint.point[1]) : undefined;
			if (point === undefined) {
				return { message: `${label}, point de passage ${index + 1} : coordonnées hors du réseau.` };
			}
			if (waypoint.mode !== "route" && waypoint.mode !== "free") {
				return { message: `${label}, point de passage ${index + 1} : mode attendu, « route » ou « free ».` };
			}

			waypoints.push({ ...point, mode: waypoint.mode });
		}
	}

	// Le seul lien qu'on impose entre les deux : ils vont de pair. On ne vérifie PAS que le tracé
	// redérive des points de passage — ce serait rejouer le routage ici, et le tracé, déjà contrôlé
	// point par point, fait foi de toute façon.
	if (waypoints.length === 1) return { message: `${label} : un tracé doit compter au moins deux points de passage.` };
	if ((path.length === 0) !== (waypoints.length === 0)) {
		return { message: `${label} : tracé et points de passage doivent être tous deux vides, ou tous deux remplis.` };
	}

	// Seul un tracé ouvre ou ferme la course : c'est lui qui en remplace le bout.
	const terminus = payload.terminus ?? null;
	if (terminus !== null && terminus !== "start" && terminus !== "end") {
		return { message: `${label} : bout de course attendu, « start », « end » ou rien.` };
	}
	if (terminus !== null && path.length === 0) {
		return { message: `${label} : seul un tracé peut ouvrir ou fermer la course.` };
	}

	return {
		segment: {
			startStopId: startStopId as string | null,
			endStopId: endStopId as string | null,
			propagatedDelay: propagatedDelay as number,
			terminus,
			stops,
			waypoints,
			path,
		},
	};
}

/** Une modification qui désigne un arrêt provisoire, telle que la liste des arrêts la cite. */
function describeUsage(uid: number, routeId: string, directionId: number, deps: AdminDependencies) {
	const modification = deps.modificationIndex.modifications.get(uid);

	return {
		uid,
		line: lineName(deps.gtfs.data, routeId),
		directionId,
		headsigns: headsignsOf(deps.gtfs.data, routeId, directionId),
		label: modification?.description ?? null,
		open: modification !== undefined,
	};
}

/** Ce qu'un arrêt désigné est, pour l'affichage : son libellé, sa position, et d'où il vient. */
function describeStop(stopId: string, deps: AdminDependencies) {
	const provisional = deps.store.provisionalStops.get(stopId);
	if (provisional !== undefined) {
		return {
			name: provisional.name,
			latitude: provisional.latitude,
			longitude: provisional.longitude,
			provisional: true,
		};
	}

	const coordinates = deps.gtfs.data.stopCoordinates.get(stopId);
	return {
		name: deps.gtfs.data.stopNames.get(stopId) ?? stopId,
		latitude: coordinates?.latitude ?? null,
		longitude: coordinates?.longitude ?? null,
		provisional: false,
	};
}

/** Une borne `{ date, time }` telle que le formulaire l'envoie, ou `null` pour une borne absente. */
function readBound(
	raw: unknown,
	which: string,
):
	| { bound: string; date: Temporal.PlainDate; time: Temporal.PlainTime | null }
	| { bound: null }
	| { message: string } {
	if (raw === undefined || raw === null) return { bound: null };
	if (typeof raw !== "object") return { message: `Borne de ${which} illisible.` };

	const payload = raw as Record<string, unknown>;
	const date = typeof payload.date === "string" ? payload.date.trim() : "";
	const time = typeof payload.time === "string" ? payload.time.trim() : "";

	if (date.length === 0) {
		return time.length === 0 ? { bound: null } : { message: `Heure de ${which} sans date.` };
	}
	if (!DATE_PATTERN.test(date)) return { message: `Date de ${which} attendue au format AAAA-MM-JJ.` };
	if (time.length > 0 && !TIME_PATTERN.test(time)) return { message: `Heure de ${which} attendue au format HH:MM.` };

	let plainDate: Temporal.PlainDate;
	try {
		plainDate = Temporal.PlainDate.from(date, { overflow: "reject" });
	} catch {
		return { message: `Date de ${which} invalide.` };
	}

	return time.length === 0
		? { bound: date, date: plainDate, time: null }
		: { bound: `${date}T${time}`, date: plainDate, time: Temporal.PlainTime.from(time) };
}

/** Ce qu'un arrêt provisoire porte au-delà de son nom et de sa position. */
type ProvisionalStopDetails = Omit<ProvisionalStopFields, "name" | "latitude" | "longitude">;

/** Les détails d'un arrêt provisoire tant que rien n'en a été dit. */
const NO_DETAILS: ProvisionalStopDetails = {
	stopCode: null,
	description: null,
	zoneId: null,
	parentStation: null,
	wheelchairBoarding: 0,
	platformCode: null,
};

/** Les champs libres d'un arrêt provisoire. */
const TEXT_DETAILS = ["stopCode", "description", "zoneId", "parentStation", "platformCode"] as const;

/**
 * La zone tarifaire ou la station qui ne figure pas au GTFS, s'il y en a une. Celle que l'arrêt porte
 * déjà reste admise, quand bien même le GTFS l'aurait retirée depuis : c'est à qui en change de la
 * remplacer.
 */
function unknownReference(fields: ProvisionalStopFields, current: ProvisionalStop | undefined, gtfs: StaticGtfs) {
	if (fields.zoneId !== null && fields.zoneId !== current?.zoneId && !gtfs.fareAreas.has(fields.zoneId)) {
		return `Zone tarifaire inconnue du GTFS : ${fields.zoneId}.`;
	}
	if (
		fields.parentStation !== null &&
		fields.parentStation !== current?.parentStation &&
		!gtfs.stations.has(fields.parentStation)
	) {
		return `Station inconnue du GTFS : ${fields.parentStation}.`;
	}
	return undefined;
}

/**
 * Relit le corps d'une création ou d'une modification d'arrêt provisoire. Le nom et la position sont
 * obligatoires ; des détails, seuls ceux que le corps cite sont rendus — `null` pour un champ vidé.
 */
async function parseProvisionalStop(
	c: Context,
): Promise<
	{ name: string; latitude: number; longitude: number; details: Partial<ProvisionalStopDetails> } | { message: string }
> {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return { message: "Corps de requête illisible." };
	}

	if (typeof body !== "object" || body === null) return { message: "Corps de requête attendu : un objet." };
	const payload = body as Record<string, unknown>;

	const name = typeof payload.name === "string" ? payload.name.trim() : "";
	if (name.length === 0) return { message: "Le nom de l'arrêt est obligatoire." };

	const coordinates = readCoordinates(payload.latitude, payload.longitude);
	if (coordinates === undefined) return { message: "Coordonnées hors du réseau." };

	const details: Partial<ProvisionalStopDetails> = {};
	for (const field of TEXT_DETAILS) {
		const raw = payload[field];
		if (raw === undefined) continue;
		if (raw !== null && typeof raw !== "string") return { message: `Champ ${field} attendu : un texte, ou null.` };
		details[field] = raw?.trim() || null;
	}

	const wheelchairBoarding = payload.wheelchairBoarding;
	if (wheelchairBoarding === 0 || wheelchairBoarding === 1 || wheelchairBoarding === 2) {
		details.wheelchairBoarding = wheelchairBoarding;
	} else if (wheelchairBoarding !== undefined) {
		return { message: "Accessibilité attendue : 0 (inconnue), 1 (accessible) ou 2 (inaccessible)." };
	}

	return { name, ...coordinates, details };
}

/** Un point tel que l'interface l'envoie : une paire [latitude, longitude]. */
function readPoint(raw: unknown) {
	return Array.isArray(raw) ? readCoordinates(raw[0], raw[1]) : undefined;
}

function readCoordinates(latitude: unknown, longitude: unknown) {
	if (typeof latitude !== "number" || typeof longitude !== "number") return undefined;
	if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
	const bounds = networkBounds();
	const { minLatitude, maxLatitude, minLongitude, maxLongitude } =
		bounds === null
			? FALLBACK_BOUNDS
			: {
					minLatitude: bounds.minLatitude - BOUNDS_MARGIN,
					maxLatitude: bounds.maxLatitude + BOUNDS_MARGIN,
					minLongitude: bounds.minLongitude - BOUNDS_MARGIN,
					maxLongitude: bounds.maxLongitude + BOUNDS_MARGIN,
				};
	if (latitude < minLatitude || latitude > maxLatitude) return undefined;
	if (longitude < minLongitude || longitude > maxLongitude) return undefined;
	return { latitude, longitude };
}
