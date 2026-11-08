import { createHash } from "node:crypto";
import GtfsRealtime from "gtfs-realtime-bindings";

import type { AlertSource } from "../alerts/source.js";
import { firstImage, htmlToText } from "../utils/sanitize-html.js";
import type { OrderedStop, StaticGtfs, TripStop } from "./use-static-gtfs.js";

const SKIPPED = GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED;
const NO_DATA = GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.NO_DATA;

const TIME_ZONE = "Europe/Paris";

/**
 * Tranche horaire quotidienne (heures locales) d'une perturbation récurrente. `to` <= `from`
 * signifie que la tranche passe minuit (elle se termine le lendemain matin).
 */
export type DailyWindow = { from: string; to: string };

/**
 * Période d'effet d'une perturbation. `null` = non précisé / ouvert. Les bornes valent soit
 * `AAAA-MM-JJ` (journée entière, fin incluse), soit `AAAA-MM-JJTHH:MM` (instant exact, fin exclue),
 * en heure de Paris. `dailyWindow` non nul restreint la période à une tranche horaire répétée chaque
 * jour de l'enveloppe.
 */
export type AlertPeriod = { start: string | null; end: string | null; dailyWindow: DailyWindow | null };

/**
 * Des quais à sauter sur une ligne, dans un sens, pour les courses de certains tracés seulement —
 * ou de tous (`null`) : une modification restreinte à un tracé ne touche pas les courses des autres.
 * Seulement pour les courses qui passent à l'une des bornes d'une suite d'arrêts supprimés pendant
 * l'une des périodes (cf. `passesDuring`) : une déviation qui commence ce soir se lit dès ce matin sur
 * les courses de ce soir.
 */
export type SkipBucket = {
	directionId: number;
	patternIds: ReadonlySet<string> | null;
	periods: AlertPeriod[];
	stopIds: ReadonlySet<string>;
};
/** routeId → buckets d'arrêts à sauter (SKIPPED), par sens et par tracé. */
export type SkipIndex = Map<string, SkipBucket[]>;

/**
 * Des départs annulés : pour les courses de certains tracés seulement — ou de tous (`null`) —, et les
 * jours où leur départ tombe dans l'une de ces périodes.
 */
export type CancelEntry = { patternIds: ReadonlySet<string> | null; periods: AlertPeriod[] };

/**
 * Une tranche horaire de départs annulés sur une ligne et dans un sens — heure locale, secondes depuis
 * minuit, bornes comprises ; `null` l'une et l'autre : toute la journée. Une fin avant le début passe
 * minuit.
 */
export type CancelWindow = CancelEntry & { from: number | null; to: number | null };

/**
 * Les courses à annuler : désignées une à une par leur clé de course (cf. `courseKey`), ou par tranche
 * horaire de leur départ, par ligne et sens (« routeId|directionId »).
 */
export type CancelIndex = { courses: Map<string, CancelEntry[]>; windows: Map<string, CancelWindow[]> };

/** Un index qui n'annule rien. */
export function emptyCancelIndex(): CancelIndex {
	return { courses: new Map(), windows: new Map() };
}

/**
 * La course, sur la journée de service qui commence à `midnight`, est-elle annulée ?
 *
 * C'est son propre départ qui se jauge à la période, et non l'instant où le feed est produit : le
 * 17:05 d'une modification qui court de 16:30 au lendemain 01:30 est annulé ce soir, pas demain —
 * quand bien même le feed de ce soir porte déjà les courses de demain.
 */
export function isCancelled(index: CancelIndex, gtfs: StaticGtfs, tripId: string, midnight: number): boolean {
	if (index.courses.size === 0 && index.windows.size === 0) return false;

	const departure = gtfs.tripDepartures.get(tripId);
	if (departure === undefined) return false;

	const pattern = gtfs.tripPatterns.get(tripId);
	const departsAt = Temporal.Instant.fromEpochMilliseconds((midnight + departure) * 1000);
	const applies = (entry: CancelEntry) =>
		(entry.patternIds === null || (pattern !== undefined && entry.patternIds.has(pattern))) &&
		isActive(entry.periods, departsAt);

	const key = gtfs.tripCourseKeys.get(tripId);
	if (key !== undefined && index.courses.get(key)?.some(applies)) return true;

	const trip = gtfs.trips.get(tripId);
	if (trip === undefined) return false;
	const windows = index.windows.get(`${trip.routeId}|${trip.directionId}`);
	if (windows === undefined) return false;

	// L'heure qu'affiche l'horloge au départ : une course de 25:10 part à 01:10.
	const clock = departure % 86_400;
	return windows.some((window) => inWindow(window, clock) && applies(window));
}

/** Un départ, en secondes depuis minuit à l'horloge, tombe-t-il dans la tranche ? */
export function inWindow(window: { from: number | null; to: number | null }, clock: number): boolean {
	const from = window.from ?? 0;
	const to = window.to ?? 86_399;
	return from <= to ? clock >= from && clock <= to : clock >= from || clock <= to;
}

/**
 * Une info trafic reçue de l'alimentation, réduite à ce qui sert à bâtir les index.
 *
 * Elle est retenue telle quelle d'un relevé à l'autre, et c'est ce qui permet de rebâtir l'index des
 * modifications à tout moment — quand les périodes basculent, ou quand une saisie change — sans
 * attendre le relevé suivant (cf. `useModificationIndex`). Tout ce qui s'en tire au-delà — arrêts
 * supprimés, courses annulées, périodes corrigées — se saisit à la main.
 */
export type FeedAlert = {
	/** L'identifiant sous lequel elle se republie : c'est lui que porte `serviceAlertId`. */
	alertId: string | null;
	alertNumber: string;
	headerText: string;
	/** Le texte de l'info trafic, tel que la source le donne (HTML toléré). */
	descriptionText: string;
	/** Les périodes que la source annonce — proposées par défaut, corrigeables dans l'interface. */
	periods: AlertPeriod[];
	/** Les lignes du réseau que l'info trafic cite, dans l'ordre où elle les cite. */
	routeIds: string[];
};

/**
 * Une info trafic prête à être republiée, et son numéro — ce qui s'en règle s'y rattache (cf.
 * `AlertSettings`). Son alerte garde la période de communication de la source ; celle qui se
 * republie, et la période d'impact, se déduisent des périodes annoncées ou saisies (cf.
 * `publishedPeriods`).
 */
export type AlertEntity = {
	alertNumber: string;
	entity: GtfsRealtime.transit_realtime.IFeedEntity;
	periods: AlertPeriod[];
};

/**
 * L'identifiant sous lequel une info trafic est republiée, et que citent donc nos `serviceAlertId` :
 * celui de la source, préfixé pour ne jamais rencontrer ceux de nos entités.
 */
export function republishedAlertId(alertId: string): string {
	return `SA:${alertId}`;
}

let currentInterval: NodeJS.Timeout | undefined;

/**
 * Les infos trafic de l'alimentation (cf. `AlertSource`), relevées à son rythme.
 *
 * Ce module ne fait que lire : ce qu'on en tire — les modifications qui valent, les arrêts à sauter —
 * se rebâtit ailleurs, à chaque relevé, par `onPublished` (cf. `useModificationIndex`). Sans
 * alimentation, il n'y a rien à relever : seules restent les infos trafic créées à la main.
 *
 * Les infos trafic republiées sont toujours celles du dernier relevé réussi.
 */
export function useServiceAlerts(
	source: AlertSource | null,
	gtfs: { data: StaticGtfs },
	{ onPublished }: { onPublished: () => void },
) {
	const resource = {
		/** Les infos trafic reçues (cf. {@link FeedAlert}). */
		alerts: [] as FeedAlert[],
		/** Les infos trafic reçues, prêtes à être republiées (cf. {@link republishedAlertId}). */
		entities: [] as AlertEntity[],
		importedAt: Temporal.Now.instant(),
	};

	if (currentInterval !== undefined) {
		clearInterval(currentInterval);
	}
	if (source === null) {
		console.log("➔ No service alert feed — manual alerts only.");
		return resource;
	}

	let fetching = false;
	const runPoll = async () => {
		if (fetching) return; // évite tout chevauchement si un relevé dépasse l'intervalle
		fetching = true;
		try {
			if (gtfs.data.trips.size === 0) {
				console.warn("✘ Static GTFS unavailable — skipping service alerts.");
				return;
			}

			const fetched = await source.fetch(gtfs.data);
			if (fetched === null) return; // erreur → on garde le relevé courant

			const alerts: FeedAlert[] = [];
			const entities: AlertEntity[] = [];
			for (const { alertNumber, alertId, alert, periods } of fetched) {
				// Une info trafic qui ne cite aucune ligne du GTFS n'a rien à quoi se rapporter.
				const routeIds = collectKnownRoutes(alert, gtfs.data);
				if (routeIds.length === 0) continue;

				// La période active de la source est sa fenêtre de publication : c'est la période de
				// communication reçue. Celle qui se republie, et la période d'impact, se déduisent des
				// périodes annoncées ou saisies (cf. `publishedPeriods`).
				const republished = plainAlert(alert);
				republished.communicationPeriod = alert.activePeriod ?? [];
				entities.push({ alertNumber, entity: { id: republishedAlertId(alertId), alert: republished }, periods });
				alerts.push({
					alertId,
					alertNumber,
					headerText: joinTranslations(alert.headerText),
					descriptionText: joinTranslations(alert.descriptionText),
					periods,
					routeIds,
				});
			}

			resource.alerts = alerts;
			resource.entities = entities;
			resource.importedAt = Temporal.Now.instant();
			console.log(
				`✓ ${alerts.length} service alerts from ${source.label}` +
					(fetched.length > alerts.length ? ` (${fetched.length - alerts.length} citing no known line ignored).` : "."),
			);
			onPublished();
		} catch (cause) {
			console.error("✘ Failed to load service alerts!", cause);
		} finally {
			fetching = false;
		}
	};

	void runPoll();
	currentInterval = setInterval(runPoll, source.interval);

	return resource;
}

/**
 * La course passe-t-elle à l'une de ces bornes pendant l'une des périodes ? Une déviation ne vaut que
 * pour les courses qui la rencontrent : c'est leur passage théorique à ses bornes qui se jauge, et non
 * leur départ — le 14:50 qui atteint à 15:10 une déviation de 15:00 à 16:00 la prend, le 15:55 qui ne
 * l'atteint qu'à 16:20 ne la prend pas.
 *
 * `passages` se comptent en secondes depuis `midnight`, comme `TripStop.arrival` ; ceux que l'horaire
 * ne donne pas (`NaN`) sont ignorés, et faute d'aucun, c'est `fallback` qui se jauge.
 */
export function passesDuring(
	periods: AlertPeriod[],
	midnight: number,
	passages: readonly number[],
	fallback: Temporal.Instant,
): boolean {
	if (periods.length === 0) return true;
	const known = passages.filter(Number.isFinite);
	if (known.length === 0) return isActive(periods, fallback);
	return known.some((seconds) =>
		isActive(periods, Temporal.Instant.fromEpochMilliseconds((midnight + seconds) * 1000)),
	);
}

/**
 * Renvoie l'ensemble des stopId à sauter pour une course de cette ligne, dans ce sens, sur ce tracé.
 * Un tracé inconnu — course absente du GTFS — ne voit que les suppressions qui visent tous les tracés.
 *
 * Sur son horaire théorique, les arrêts d'un bucket se regroupent en suites contiguës, qui sont les
 * tronçons déviés tels que la course les rencontre : chacune saute si la course passe à son premier
 * ou à son dernier arrêt pendant l'une des périodes (cf. `passesDuring`). Sans horaire, ou sans la
 * journée de service, c'est `departsAt` qui se jauge, pour tout le bucket.
 */
export function skippedStopIds(
	skipIndex: SkipIndex,
	routeId: string,
	directionId: number,
	patternId: string | undefined,
	schedule: TripStop[] | undefined,
	midnight: number | undefined,
	departsAt: Temporal.Instant,
): Set<string> {
	const buckets = skipIndex.get(routeId);
	if (buckets === undefined) return new Set();

	const stopIds = new Set<string>();
	for (const bucket of buckets) {
		if (bucket.directionId !== directionId) continue;
		if (bucket.patternIds !== null && (patternId === undefined || !bucket.patternIds.has(patternId))) continue;

		if (schedule === undefined || midnight === undefined) {
			if (isActive(bucket.periods, departsAt)) for (const stopId of bucket.stopIds) stopIds.add(stopId);
			continue;
		}

		let run: TripStop[] = [];
		const flush = () => {
			const first = run[0];
			const last = run.at(-1);
			if (first !== undefined && last !== undefined) {
				if (passesDuring(bucket.periods, midnight, [first.arrival, last.arrival], departsAt))
					for (const stop of run) stopIds.add(stop.stopId);
			}
			run = [];
		};
		for (const stop of schedule) {
			if (bucket.stopIds.has(stop.stopId)) run.push(stop);
			else flush();
		}
		flush();
	}
	return stopIds;
}

/**
 * Marque en SKIPPED les arrêts supprimés d'un trip, jaugés à son passage aux bornes de chaque
 * tronçon dévié sur la journée de service qui commence à `midnight` — ou, faute de la connaître, à
 * `departsAt` (cf. `skippedStopIds`). Deux cas :
 *  1. arrêt présent dans le GTFS-RT → on le bascule en SKIPPED (temps retirés) ;
 *  2. arrêt supprimé mais ABSENT du GTFS-RT (la source l'a retiré) → on le réinsère comme entrée
 *     SKIPPED, à sa position (stop_sequence issu de l'horaire théorique du trip).
 *
 * Les terminus que la course dessert encore sont préservés dans les deux cas (cf.
 * {@link keepEffectiveTermini}).
 */
export function applySkippedStops(
	tripUpdate: GtfsRealtime.transit_realtime.ITripUpdate,
	routeId: string,
	skipIndex: SkipIndex,
	gtfs: StaticGtfs,
	midnight: number | undefined,
	departsAt: Temporal.Instant,
) {
	const stopTimeUpdates = tripUpdate.stopTimeUpdate;
	if (!stopTimeUpdates?.length || !skipIndex.has(routeId)) return;

	const directionId = tripUpdate.trip?.directionId ?? 0;
	const tripId = tripUpdate.trip?.tripId;
	// L'horaire théorique date le passage aux bornes, sert au garde-fou (terminus de la course) puis à
	// la réinsertion.
	const schedule = tripId ? gtfs.tripStopSequences.get(tripId) : undefined;
	let stopIds = skippedStopIds(
		skipIndex,
		routeId,
		directionId,
		tripId ? gtfs.tripPatterns.get(tripId) : undefined,
		schedule,
		midnight,
		departsAt,
	);
	if (stopIds.size === 0) return;

	if (schedule !== undefined) {
		stopIds = keepEffectiveTermini(stopIds, schedule, gtfs, routeId, directionId);
		if (stopIds.size === 0) return;
	}

	// 1. Arrêts déjà présents → bascule en SKIPPED.
	const presentIds = new Set<string>();
	for (const stopTimeUpdate of stopTimeUpdates) {
		if (stopTimeUpdate.stopId) presentIds.add(stopTimeUpdate.stopId);
		if (stopTimeUpdate.stopId && stopIds.has(stopTimeUpdate.stopId)) {
			stopTimeUpdate.scheduleRelationship = SKIPPED;
			stopTimeUpdate.arrival = null;
			stopTimeUpdate.departure = null;
		}
	}

	// 2. Arrêts supprimés absents du GTFS-RT → réinsertion (à partir de l'horaire théorique du trip).
	if (schedule === undefined) return;

	const inserted: GtfsRealtime.transit_realtime.TripUpdate.IStopTimeUpdate[] = [];
	for (const { stopSequence, stopId } of schedule) {
		if (stopIds.has(stopId) && !presentIds.has(stopId)) {
			inserted.push({ stopSequence, stopId, scheduleRelationship: SKIPPED });
		}
	}
	if (inserted.length > 0) {
		tripUpdate.stopTimeUpdate = [...stopTimeUpdates, ...inserted].sort(
			(a, b) => (a.stopSequence ?? 0) - (b.stopSequence ?? 0),
		);
	}
}

/**
 * Cette course annonce-t-elle au moins un arrêt supprimé ? Sans temps réel ni suppression, il ne
 * reste d'elle que le NO_DATA de son premier arrêt — rien que l'horaire théorique ne dise déjà. Elle
 * n'est alors pas publiée du tout, qu'elle vienne du flux source ou du théorique.
 */
export function hasSkippedStops(tripUpdate: GtfsRealtime.transit_realtime.ITripUpdate): boolean {
	return tripUpdate.stopTimeUpdate?.some((stopTimeUpdate) => stopTimeUpdate.scheduleRelationship === SKIPPED) ?? false;
}

/**
 * Réduit un trip update à ce qu'on sait de sûr d'une course sans temps réel : qu'elle circule, et
 * quels arrêts elle ne dessert pas. Ses horaires, eux, ne valent rien et ne doivent pas être
 * diffusés — la source rebadge le théorique en temps réel sur les lignes hors
 * {@link REALTIME_LINES}, et une course qu'elle ignore n'en a tout simplement aucun. Les
 * suppressions d'arrêt, elles, viennent des alertes et non de la source : elles restent exploitables.
 *
 * Le premier arrêt de l'horaire théorique ouvre donc la liste en NO_DATA, qui vaut « pas de temps
 * réel ici » pour lui comme pour toute la suite de la course, et le distingue d'une course qu'on
 * aurait passée sous silence. Sauf lorsqu'il est lui-même supprimé : la suppression prime, elle en
 * dit davantage. Suivent les arrêts supprimés.
 *
 * Une course dont l'horaire théorique est introuvable — un GTFS antérieur au service en cours — et
 * qui ne saute aucun arrêt se retrouve sans stopTimeUpdate : elle n'a alors plus rien à dire, et
 * `createFeed` l'écarte à l'émission.
 */
export function declareNoRealtime(
	tripUpdate: GtfsRealtime.transit_realtime.ITripUpdate,
	schedule: TripStop[] | undefined,
) {
	const skipped = (tripUpdate.stopTimeUpdate ?? []).filter(
		(stopTimeUpdate) => stopTimeUpdate.scheduleRelationship === SKIPPED,
	);

	// L'horaire étant trié, un premier arrêt supprimé est nécessairement le premier des SKIPPED.
	const origin = schedule?.[0];
	tripUpdate.stopTimeUpdate =
		origin === undefined || skipped[0]?.stopId === origin.stopId
			? skipped
			: [{ stopSequence: origin.stopSequence, stopId: origin.stopId, scheduleRelationship: NO_DATA }, ...skipped];

	// Retard global calculé sur du faux temps réel → sans objet.
	tripUpdate.delay = null;
}

/**
 * Annonce la course annulée. Rien d'autre ne tient : ni ses horaires ni ses arrêts supprimés n'ont
 * plus d'objet, et le seul descripteur suffit à la désigner.
 */
export function declareCancelled(tripUpdate: GtfsRealtime.transit_realtime.ITripUpdate) {
	if (tripUpdate.trip) {
		tripUpdate.trip.scheduleRelationship = GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED;
	}
	tripUpdate.stopTimeUpdate = [];
	tripUpdate.delay = null;
}

/**
 * Une alerte peut porter plusieurs plages de dates disjointes (« du 17 au 21 et les 24 et 25 août ») :
 * elle est active dès que l'une d'elles l'est. Aucune période = aucune borne connue, donc toujours active.
 */
export function isActive(periods: readonly AlertPeriod[], now: Temporal.Instant): boolean {
	return periods.length === 0 || periods.some((period) => isPeriodActive(period, now));
}

/**
 * Toutes les périodes sont-elles closes ? Une période sans fin ne l'est jamais, et aucune période du
 * tout veut dire « sans borne » : ce n'est pas fini non plus.
 */
export function hasEnded(periods: AlertPeriod[], now: Temporal.Instant): boolean {
	return (
		periods.length > 0 &&
		periods.every((period) => {
			const endExclusive = envelopeEnd(period);
			return endExclusive !== null && Temporal.Instant.compare(now, endExclusive) >= 0;
		})
	);
}

/**
 * La fin de la dernière période, exclue. `null` quand rien ne borne la fin : une période ouverte, ou
 * aucune période du tout — c'est « sans borne », comme pour {@link hasEnded}.
 */
export function lastPeriodEnd(periods: AlertPeriod[]): Temporal.Instant | null {
	let last: Temporal.Instant | null = null;
	for (const period of periods) {
		const endExclusive = envelopeEnd(period);
		if (endExclusive === null) return null;
		if (last === null || Temporal.Instant.compare(endExclusive, last) > 0) last = endExclusive;
	}
	return last;
}

/**
 * Le premier début des périodes. `null` si l'une n'en a pas : la perturbation est déjà en cours, et
 * rien ne dit depuis quand.
 */
function firstPeriodStart(periods: AlertPeriod[]): Temporal.Instant | null {
	let first: Temporal.Instant | null = null;
	for (const period of periods) {
		const start = period.start ? periodStart(period.start) : null;
		if (start === null) return null;
		if (first === null || Temporal.Instant.compare(start, first) < 0) first = start;
	}
	return first;
}

/**
 * Deux listes de périodes ont-elles un instant en commun ? Chaque période se prend de sa borne de
 * début à sa borne de fin, tranche horaire comprise : c'est l'enveloppe qui compte ici. Aucune
 * période du tout veut dire « sans borne », et croise donc tout.
 */
export function periodsOverlap(a: AlertPeriod[], b: AlertPeriod[]): boolean {
	const spans = (periods: AlertPeriod[]) =>
		periods.length === 0
			? [{ start: null, end: null }]
			: periods.map((period) => ({
					start: period.start ? periodStart(period.start) : null,
					end: envelopeEnd(period),
				}));
	const before = (from: Temporal.Instant | null, until: Temporal.Instant | null) =>
		from === null || until === null || Temporal.Instant.compare(from, until) < 0;

	return spans(a).some((x) => spans(b).some((y) => before(x.start, y.end) && before(y.start, x.end)));
}

/** Un intervalle en secondes epoch, fin exclue ; `null` pour une borne ouverte. */
type Span = { start: number | null; end: number | null };

/**
 * Les périodes de communication et d'impact d'une alerte telles qu'elles se republient, tirées des
 * périodes que la source annonce — ou de celles qu'on y a saisies à la place (cf. `AlertSettings`) —
 * et de la période de communication que donne la source.
 *
 * Faute de période d'impact — aucune période (`null`), ou aucune qui tienne dans la communication —,
 * l'impact est la communication reçue : la perturbation dure, à ce qu'on en sait, tant que la source
 * la publie.
 *
 * La période active, dépréciée et gardée pour la rétrocompatibilité, suit la communication : la spec
 * les définit toutes deux comme le moment où l'alerte s'affiche, et c'est bien ainsi que le flux amont
 * remplit la sienne. Un lecteur qui ignore la communication montre donc l'alerte aux mêmes dates.
 */
export function publishedPeriods(
	periods: AlertPeriod[] | null,
	received: GtfsRealtime.transit_realtime.ITimeRange[],
	now: Temporal.Instant,
): {
	activePeriod: GtfsRealtime.transit_realtime.ITimeRange[];
	communicationPeriod: GtfsRealtime.transit_realtime.ITimeRange[];
	impactPeriod: GtfsRealtime.transit_realtime.ITimeRange[];
} {
	if (periods === null) return { activePeriod: received, communicationPeriod: received, impactPeriod: received };
	const communicationPeriod = communicationPeriods(periods, received);
	const impactPeriod = impactPeriods(periods, communicationPeriod, now);
	return {
		activePeriod: communicationPeriod,
		communicationPeriod,
		impactPeriod: impactPeriod.length > 0 ? impactPeriod : received,
	};
}

/**
 * Les périodes d'une info trafic créée à la main, telles qu'elles se publient. Elle s'affiche tant
 * qu'elle est publiée : la communication — et la période active, qui la suit (cf. `publishedPeriods`) —
 * part de sa publication, et finit à sa dépublication programmée s'il y en a une, sans fin sinon : les
 * consommateurs la retirent d'eux-mêmes à l'échéance. Ses périodes saisies ne disent que l'impact,
 * rogné sur rien : la perturbation peut avoir commencé avant qu'on ne la publie. Sans période saisie, le
 * champ est absent — elle a cours tout le temps qu'elle s'affiche.
 */
export function customPublishedPeriods(
	periods: AlertPeriod[],
	publishedAt: number,
	unpublishAt: number | null,
	now: Temporal.Instant,
): {
	activePeriod: GtfsRealtime.transit_realtime.ITimeRange[];
	communicationPeriod: GtfsRealtime.transit_realtime.ITimeRange[];
	impactPeriod: GtfsRealtime.transit_realtime.ITimeRange[];
} {
	const communicationPeriod = [{ start: publishedAt, ...(unpublishAt !== null && { end: unpublishAt }) }];
	return { activePeriod: communicationPeriod, communicationPeriod, impactPeriod: impactPeriods(periods, [], now) };
}

/**
 * La période de communication d'une alerte telle qu'elle se republie. Celle du flux amont est une
 * fenêtre de publication — souvent jusqu'à la fin de l'année —, et non la durée de la perturbation :
 * quand les périodes lues disent quand celle-ci finit, la communication s'arrête là ; quand elles la
 * disent ouverte (« à partir du 31/10 »), la communication l'est aussi. Son début reste celui du flux —
 * une alerte s'annonce avant la perturbation —, sauf si la perturbation commence plus tôt : le flux
 * amont ouvre souvent sa fenêtre à 00:01, et la communication remonte alors au début lu, pour que
 * l'impact, qui y tient, ne s'en trouve pas rogné d'une minute.
 *
 * Aucune période lue ne dit rien de la fin : la communication reçue reste. Une fin lue qui précède le
 * début de la communication est une lecture douteuse : la communication reçue reste aussi.
 */
export function communicationPeriods(
	periods: AlertPeriod[],
	received: GtfsRealtime.transit_realtime.ITimeRange[],
): GtfsRealtime.transit_realtime.ITimeRange[] {
	if (periods.length === 0) return received;

	const lastEnd = lastPeriodEnd(periods);
	const end = lastEnd === null ? null : secondsOf(lastEnd);
	const starts = received.map((range) => (range.start ? Number(range.start) : null));
	const receivedStart = starts.length === 0 || starts.includes(null) ? null : Math.min(...starts.map((s) => s ?? 0));
	const readStart = firstPeriodStart(periods);
	const start =
		receivedStart === null ? null : readStart === null ? receivedStart : Math.min(receivedStart, secondsOf(readStart));

	if (start !== null && end !== null && end <= start) return received;
	if (start === null && end === null) return [];
	return [{ ...(start !== null && { start }), ...(end !== null && { end }) }];
}

/**
 * La période d'impact d'une alerte, tirée des périodes lues ou saisies (cf. `publishedPeriods`).
 *
 * Une période simple donne un intervalle. Une tranche horaire donne un intervalle PAR JOUR, de la
 * veille — une tranche de nuit ouverte hier court encore — jusqu'au bout de son enveloppe, rognée
 * d'abord sur la communication. Sans fin connue d'aucun côté, les jours ne s'énumèrent pas, et c'est
 * l'enveloppe entière qui sort.
 *
 * Tout est ensuite rogné sur la communication, pour que chaque intervalle d'impact tienne dans l'un
 * des siens. Comme la communication finit là où finissent les périodes lues (cf.
 * `communicationPeriods`), c'est surtout le début qui se rogne. Aucune période lue ne dit rien de la
 * perturbation : la liste reste vide, et le champ absent.
 */
export function impactPeriods(
	periods: AlertPeriod[],
	communication: GtfsRealtime.transit_realtime.ITimeRange[],
	now: Temporal.Instant,
): GtfsRealtime.transit_realtime.ITimeRange[] {
	const bounds: Span[] = communication.map((range) => ({
		start: range.start ? Number(range.start) : null,
		end: range.end ? Number(range.end) : null,
	}));
	const hull: Span =
		bounds.length === 0
			? { start: null, end: null }
			: {
					start: bounds.some((span) => span.start === null) ? null : Math.min(...bounds.map((span) => span.start ?? 0)),
					end: bounds.some((span) => span.end === null) ? null : Math.max(...bounds.map((span) => span.end ?? 0)),
				};
	const yesterday = now.toZonedDateTimeISO(TIME_ZONE).toPlainDate().subtract({ days: 1 });

	return periods
		.flatMap((period) =>
			period.dailyWindow ? dailySpans(period, period.dailyWindow, hull, yesterday) : [spanOf(period)],
		)
		.flatMap((span) => (bounds.length === 0 ? [span] : bounds.flatMap((bound) => intersect(span, bound) ?? [])))
		.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
		.map((span) => ({
			...(span.start !== null && { start: span.start }),
			...(span.end !== null && { end: span.end }),
		}));
}

/** Un intervalle par jour de la tranche horaire, de `from` au bout de l'enveloppe rognée sur `hull`. */
function dailySpans(period: AlertPeriod, window: DailyWindow, hull: Span, from: Temporal.PlainDate): Span[] {
	const dayOf = (seconds: number) =>
		Temporal.Instant.fromEpochMilliseconds(seconds * 1000)
			.toZonedDateTimeISO(TIME_ZONE)
			.toPlainDate();
	const latest = (dates: (Temporal.PlainDate | null)[]) =>
		dates.reduce<Temporal.PlainDate | null>(
			(a, b) => (a === null || (b !== null && Temporal.PlainDate.compare(b, a) > 0) ? b : a),
			null,
		);
	const earliest = (dates: (Temporal.PlainDate | null)[]) =>
		dates.reduce<Temporal.PlainDate | null>(
			(a, b) => (a === null || (b !== null && Temporal.PlainDate.compare(b, a) < 0) ? b : a),
			null,
		);

	const first = latest([
		from,
		period.start ? plainDate(period.start) : null,
		hull.start === null ? null : dayOf(hull.start),
	]);
	const last = earliest([period.end ? plainDate(period.end) : null, hull.end === null ? null : dayOf(hull.end)]);
	if (first === null || last === null) return [spanOf(period)];

	const spansMidnight = window.to <= window.from;
	const spans: Span[] = [];
	for (let day = first; Temporal.PlainDate.compare(day, last) <= 0; day = day.add({ days: 1 })) {
		const start = atTime(day, window.from);
		const end = atTime(spansMidnight ? day.add({ days: 1 }) : day, window.to);
		if (start !== null && end !== null) spans.push({ start: secondsOf(start), end: secondsOf(end) });
	}
	return spans;
}

/** L'enveloppe d'une période, tranche horaire ignorée : bornes à la journée ou à la minute. */
function spanOf(period: AlertPeriod): Span {
	const start = period.start ? periodStart(period.start) : null;
	const end = period.end ? periodEnd(period.end) : null;
	return { start: start === null ? null : secondsOf(start), end: end === null ? null : secondsOf(end) };
}

/** Ce que deux intervalles ont en commun, ou `null` s'ils ne se croisent pas. */
function intersect(a: Span, b: Span): Span | null {
	const start = a.start === null ? b.start : b.start === null ? a.start : Math.max(a.start, b.start);
	const end = a.end === null ? b.end : b.end === null ? a.end : Math.min(a.end, b.end);
	return start !== null && end !== null && start >= end ? null : { start, end };
}

function secondsOf(instant: Temporal.Instant): number {
	return Math.floor(instant.epochMilliseconds / 1000);
}

/**
 * Une perturbation récurrente n'est active que pendant sa tranche horaire, chaque jour de l'enveloppe
 * `start`/`end` ; sinon, la période va de `start` à `end`, avec des bornes à la journée ou à la minute
 * selon ce que le texte de l'alerte précisait (cf. {@link AlertPeriod}).
 */
function isPeriodActive(period: AlertPeriod, now: Temporal.Instant): boolean {
	if (period.dailyWindow) return isDailyWindowActive(period, period.dailyWindow, now);

	const start = period.start ? periodStart(period.start) : null;
	const endExclusive = period.end ? periodEnd(period.end) : null;

	return (
		(start === null || Temporal.Instant.compare(now, start) >= 0) &&
		(endExclusive === null || Temporal.Instant.compare(now, endExclusive) < 0)
	);
}

/**
 * Active si `now` tombe dans la tranche horaire d'un jour couvert par l'enveloppe. On teste aussi la
 * tranche ouverte la VEILLE : une tranche de nuit (« 20h > 5h ») déborde sur le lendemain matin.
 */
function isDailyWindowActive(period: AlertPeriod, window: DailyWindow, now: Temporal.Instant): boolean {
	const zoned = now.toZonedDateTimeISO(TIME_ZONE);
	// `to` <= `from` → la tranche passe minuit et se termine le lendemain.
	const spansMidnight = window.to <= window.from;

	for (const dayOffset of [0, -1]) {
		const day = zoned.toPlainDate().add({ days: dayOffset });
		if (!isDayInEnvelope(period, day)) continue;

		const from = atTime(day, window.from);
		const to = atTime(spansMidnight ? day.add({ days: 1 }) : day, window.to);
		if (from === null || to === null) continue;

		if (Temporal.Instant.compare(now, from) >= 0 && Temporal.Instant.compare(now, to) < 0) return true;
	}

	return false;
}

/** Vrai si `day` est un jour où la tranche horaire démarre (bornes de l'enveloppe incluses). */
function isDayInEnvelope(period: AlertPeriod, day: Temporal.PlainDate): boolean {
	const start = period.start ? plainDate(period.start) : null;
	const end = period.end ? plainDate(period.end) : null;

	if (start !== null && Temporal.PlainDate.compare(day, start) < 0) return false;
	if (end !== null && Temporal.PlainDate.compare(day, end) > 0) return false;
	return true;
}

/** Borne de début : minuit pour une date seule, l'instant exact pour un « AAAA-MM-JJTHH:MM ». */
function periodStart(value: string): Temporal.Instant | null {
	return hasTime(value) ? toInstant(value) : startOfDay(value);
}

/**
 * La fin d'une période, exclue, tranche horaire comprise. Une tranche de nuit (« 21:00 → 05:00 ») qui
 * s'ouvre le dernier jour d'une fin à la journée court jusqu'au lendemain matin : c'est là que la
 * période finit, et non à minuit (cf. `isDailyWindowActive`). `null` : la période est ouverte.
 */
function envelopeEnd(period: AlertPeriod): Temporal.Instant | null {
	if (!period.end) return null;
	const window = period.dailyWindow;
	const last = hasTime(period.end) ? null : plainDate(period.end);
	if (window && window.to <= window.from && last !== null) return atTime(last.add({ days: 1 }), window.to);
	return periodEnd(period.end);
}

/** Borne de fin : exclusive. Une date seule couvre toute la journée, une heure précise arrête net. */
function periodEnd(value: string): Temporal.Instant | null {
	return hasTime(value) ? toInstant(value) : startOfDay(value, 1);
}

function hasTime(value: string): boolean {
	return value.includes("T");
}

function startOfDay(date: string, addDays = 0): Temporal.Instant | null {
	try {
		return Temporal.PlainDate.from(date).add({ days: addDays }).toZonedDateTime(TIME_ZONE).toInstant();
	} catch {
		return null;
	}
}

function toInstant(dateTime: string): Temporal.Instant | null {
	try {
		return Temporal.PlainDateTime.from(dateTime).toZonedDateTime(TIME_ZONE).toInstant();
	} catch {
		return null;
	}
}

function atTime(day: Temporal.PlainDate, time: string): Temporal.Instant | null {
	try {
		return day.toPlainDateTime(Temporal.PlainTime.from(time)).toZonedDateTime(TIME_ZONE).toInstant();
	} catch {
		return null;
	}
}

/** Partie date d'une borne, qu'elle porte ou non une heure. */
function plainDate(value: string): Temporal.PlainDate | null {
	try {
		return Temporal.PlainDate.from(value.slice(0, 10));
	} catch {
		return null;
	}
}

/**
 * L'empreinte d'une alerte telle que le flux la donne : son texte, sa cause et son effet, son impact,
 * son lien, sa gravité et sa période de communication — chez TCL, la seule période que la source
 * annonce, et donc ce qui dit quand la perturbation finit : qu'elle change, et l'alerte traitée est à
 * reprendre. Deux relevés de même empreinte disent la même chose.
 */
export function alertSourceKey(alert: GtfsRealtime.transit_realtime.IAlert): string {
	const translations = (text: GtfsRealtime.transit_realtime.ITranslatedString | null | undefined) =>
		(text?.translation ?? []).map((translation) => [translation.language ?? null, translation.text ?? ""]);
	return createHash("sha1")
		.update(
			JSON.stringify([
				translations(alert.headerText),
				translations(alert.descriptionText),
				alert.cause ?? null,
				alert.effect ?? null,
				(alert.informedEntity ?? []).map((entity) => [
					entity.agencyId || null,
					entity.routeId || null,
					entity.directionId ?? null,
					entity.stopId || null,
				]),
				translations(alert.url),
				alert.severityLevel ?? null,
				(alert.communicationPeriod ?? []).map((range) => [Number(range.start ?? 0), Number(range.end ?? 0)]),
			]),
		)
		.digest("base64");
}

/** Le titre et la description d'une info trafic. */
export type AlertText = { headerText: string; descriptionText: string };

/**
 * Le texte d'une info trafic tel qu'il se lit : titre et description ramenés au texte (cf.
 * `htmlToText`), sans leurs liens, espaces compactés. Les liens sont des documents, que l'alerte
 * republie à part (`url`) : une réécriture ne les remplace pas. C'est sur lui qu'une réécriture se
 * fait, et à lui qu'elle se compare ensuite (cf. {@link sameAlertText}).
 */
export function readableAlertText(alert: AlertText): AlertText {
	const readable = (raw: string) =>
		htmlToText(raw.replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, ""), undefined)
			.replace(/\s+/g, " ")
			.trim();
	return { headerText: readable(alert.headerText), descriptionText: readable(alert.descriptionText) };
}

/**
 * Deux textes lisibles (cf. {@link readableAlertText}) disent-ils la même chose ? Ils se comparent
 * réduits à leurs seules lettres et chiffres, en minuscules.
 *
 * Le flux amont rend parfois la même info sous un autre balisage — puces en texte ou en `<ul>`,
 * « 2ème info » devant ou derrière le numéro de ligne, plan en lien ou non —, et sert même, le temps
 * d'un relevé, ses descriptions dépouillées de leurs balises, éléments collés les uns aux autres
 * (« à nouvel avisTravaux rue… »). Ce n'est pas un nouveau texte, et une réécriture n'a pas à sauter
 * pour si peu (cf. `recordAlerts`).
 */
export function sameAlertText(a: AlertText, b: AlertText): boolean {
	const squash = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
	return squash(a.headerText) === squash(b.headerText) && squash(a.descriptionText) === squash(b.descriptionText);
}

/**
 * Ce qui a changé d'un texte lisible à l'autre, pour les journaux : le passage remplacé, entre ce qui
 * le précède et ce qui le suit en commun, champ par champ — « titre : …« avant » → « après »… ».
 */
export function alertTextChange(before: AlertText, after: AlertText): string {
	const CONTEXT = 30;
	const MAX = 300;
	const clip = (text: string) => (text.length > MAX ? `${text.slice(0, MAX)}…` : text);
	const change = (a: string, b: string) => {
		let start = 0;
		while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
		let end = 0;
		while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) {
			end += 1;
		}
		const head = start > CONTEXT ? `…${a.slice(start - CONTEXT, start)}` : a.slice(0, start);
		const tail = end > CONTEXT ? `${a.slice(a.length - end, a.length - end + CONTEXT)}…` : a.slice(a.length - end);
		return `${head}« ${clip(a.slice(start, a.length - end))} » → « ${clip(b.slice(start, b.length - end))} »${tail}`;
	};
	const changes: string[] = [];
	if (before.headerText !== after.headerText) changes.push(`titre : ${change(before.headerText, after.headerText)}`);
	if (before.descriptionText !== after.descriptionText) {
		changes.push(`description : ${change(before.descriptionText, after.descriptionText)}`);
	}
	return changes.join(" ; ");
}

/**
 * Routes touchées par l'alerte. On ne retient que celles que notre GTFS connaît, seules exploitables
 * en aval.
 */
function collectKnownRoutes(alert: GtfsRealtime.transit_realtime.IAlert, gtfs: StaticGtfs): string[] {
	const routeIds = new Set<string>();
	for (const informed of alert.informedEntity ?? []) {
		const routeId = informed.routeId;
		if (!routeId) continue;
		if (gtfs.routeDirections.has(routeId)) routeIds.add(routeId);
	}
	return [...routeIds];
}

/**
 * Écarte des arrêts à sauter les TERMINUS que la course dessert encore. Quand le GTFS a déjà intégré
 * une interruption, il tronque les courses au point de rebroussement : ce point devient leur terminus,
 * et le tronçon supprimé commence juste après. L'annoncer supprimé serait faux — une course qui finit
 * là s'y arrête bel et bien, et n'aurait plus aucun terminus desservi.
 *
 * La coupure se reconnaît au VOISIN : sur l'itinéraire complet de la ligne, l'arrêt situé AU-DELÀ du
 * terminus (donc hors de la course) est lui aussi supprimé. Sans ce test, on interdirait du même coup
 * les suppressions de terminus légitimes, celles où le GTFS n'a PAS encore été mis à jour (« terminus
 * provisoire Technopôle, arrêt non desservi ESIGELEC » : ESIGELEC termine l'itinéraire, rien au-delà).
 */
function keepEffectiveTermini(
	stopIds: Set<string>,
	schedule: TripStop[],
	gtfs: StaticGtfs,
	routeId: string,
	directionId: number,
): Set<string> {
	const first = schedule[0];
	const last = schedule.at(-1);
	if (first === undefined || last === undefined) return stopIds;

	const sequences = gtfs.routeStopSequences.get(routeId)?.get(directionId) ?? [];
	// Le début de la course a son au-delà en amont de l'itinéraire, la fin en aval.
	const termini = [
		{ stopId: first.stopId, step: -1 },
		{ stopId: last.stopId, step: 1 },
	];

	let kept = stopIds;
	for (const { stopId, step } of termini) {
		if (!kept.has(stopId) || !isTruncatedAt(sequences, stopId, step, stopIds)) continue;
		if (kept === stopIds) kept = new Set(stopIds);
		kept.delete(stopId);
	}

	return kept;
}

/** Vrai si l'arrêt voisin de `stopId`, au-delà du terminus de la course, est lui aussi supprimé. */
function isTruncatedAt(sequences: OrderedStop[][], stopId: string, step: number, stopIds: Set<string>): boolean {
	for (const sequence of sequences) {
		const index = sequence.findIndex((stop) => stop.stopId === stopId);
		if (index === -1) continue;

		const beyond = sequence[index + step];
		if (beyond !== undefined && stopIds.has(beyond.stopId)) return true;
	}

	return false;
}

/** Les types d'image qu'on sait nommer, par extension : le champ `media_type` est obligatoire. */
const IMAGE_MEDIA_TYPES = new Map([
	["png", "image/png"],
	["jpg", "image/jpeg"],
	["jpeg", "image/jpeg"],
	["gif", "image/gif"],
	["webp", "image/webp"],
]);

/**
 * Le type de média d'une image d'après l'extension de son adresse (`media_type` de `LocalizedImage`),
 * ou `undefined` pour une extension inconnue.
 */
export function imageMediaType(url: string): string | undefined {
	const extension = url.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/)?.[1]?.toLowerCase();
	return extension === undefined ? undefined : IMAGE_MEDIA_TYPES.get(extension);
}

/**
 * L'info trafic telle qu'on la republie : ses textes ramenés à du texte brut, et l'image que sa
 * description portait versée dans le champ `image` — la spécification GTFS-RT ne veut ni balise ni
 * image dans une `description_text`, quand le flux amont y verse le HTML de son CMS.
 *
 * Une copie : l'alerte reçue reste en HTML pour la page d'administration, qui la montre telle quelle.
 */
function plainAlert(alert: GtfsRealtime.transit_realtime.IAlert): GtfsRealtime.transit_realtime.IAlert {
	const urls = alert.url?.translation ?? [];
	/** Le document que l'alerte porte déjà, dans la langue du texte, ou dans la première à défaut. */
	const fileUrl = (language: string | null | undefined) =>
		(urls.find((url) => url.language === language) ?? urls[0])?.text ?? undefined;

	const plain = (
		text: GtfsRealtime.transit_realtime.ITranslatedString | null | undefined,
		clean: (text: string) => string = (text) => text,
	) => {
		const translation = (text?.translation ?? []).flatMap((translation) => {
			const converted = clean(htmlToText(translation.text ?? "", fileUrl(translation.language)));
			return converted.length > 0 ? [{ ...translation, text: converted }] : [];
		});
		return translation.length > 0 ? { translation } : null;
	};

	const localizedImage = (alert.descriptionText?.translation ?? []).flatMap((translation) => {
		const url = firstImage(translation.text ?? "");
		const mediaType = url === undefined ? undefined : imageMediaType(url);
		if (url === undefined || mediaType === undefined) return [];
		return [{ url, mediaType, ...(translation.language ? { language: translation.language } : {}) }];
	});

	return {
		...alert,
		headerText: plain(alert.headerText),
		descriptionText: plain(alert.descriptionText),
		image: alert.image?.localizedImage?.length || localizedImage.length === 0 ? alert.image : { localizedImage },
	};
}

function joinTranslations(text: GtfsRealtime.transit_realtime.ITranslatedString | null | undefined): string {
	if (!text?.translation?.length) return "";
	return text.translation
		.map((translation) => translation.text ?? "")
		.filter(Boolean)
		.join(" / ");
}
