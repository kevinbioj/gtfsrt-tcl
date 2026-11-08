import { createHash } from "node:crypto";

import type GtfsRealtime from "gtfs-realtime-bindings";

import { FINISHED_TRIP_RETENTION, MAX_DETOUR_JUNCTION_OFFSET, TRIP_MODIFICATIONS_HORIZON } from "../config.js";
import { serviceDaysBetween } from "../gtfs-rt/scheduled-trips.js";
import {
	type AlertPeriod,
	type CancelIndex,
	isCancelled,
	passesDuring,
	periodsOverlap,
	republishedAlertId,
} from "../gtfs-rt/use-service-alerts.js";
import type { StaticGtfs, TripStop } from "../gtfs-rt/use-static-gtfs.js";
import { encodePolyline } from "../utils/encode-polyline.js";
import type { Coordinates } from "../utils/geometry.js";
import { NETWORK } from "../utils/network.js";
import { rangeOn, removesStops, type SegmentBounds } from "./bounds.js";
import type { ResolvedModification } from "./modifications.js";
import { type DrawnPath, spliceShape } from "./splice-shape.js";
import { type DetourTerminus, type ProvisionalStop, provisionalStopUid } from "./store.js";

/**
 * Un tronçon dévié prêt à être appliqué : un segment d'une déclaration, dont l'info trafic est en
 * vigueur et dont tout ce qu'il faut pour publier est là. C'est ce que la suite manipule — la
 * déclaration dont il vient n'a plus d'importance, seule compte la course qu'il modifie.
 */
type Candidate = {
	/** De quoi le nommer au journal et dans les identifiants publiés : « M12#0 ». */
	label: string;
	/**
	 * Sa plage supprime-t-elle des arrêts ? Sinon le véhicule passe ailleurs sans rien perdre de sa
	 * desserte : le tronçon publie une `Modification` de tracé seul (cf. `shapeOnly`).
	 */
	removes: boolean;
	/** `null` sans info trafic à citer : déclarée sans, ou la sienne sortie du flux. */
	alertId: string | null;
	routeId: string;
	directionId: number;
	/** Les tracés visés, ou `null` pour tous (cf. `DetourSegment.patternIds`). */
	patternIds: ReadonlySet<string> | null;
	/**
	 * Les périodes de sa modification : il ne s'applique qu'aux courses qui passent à l'une de ses
	 * bornes pendant l'une d'elles (cf. `passesDuring`).
	 */
	periods: AlertPeriod[];
	/**
	 * La priorité de sa modification : sur une course, il cède la place à tout tronçon plus prioritaire
	 * qui s'y applique et en recouvre la plage (cf. `yieldToPriority`).
	 */
	priority: number;
	startStopId: string;
	/** `null` : la plage court jusqu'au dernier arrêt de chaque course, et le tronçon ne supprime rien. */
	endStopId: string | null;
	propagatedDelay: number;
	stops: { stopId: string; travelTime: number }[];
	path: Coordinates[];
	/** Le bout de la course que le tracé remplace, s'il le déclare (cf. `DetourSegment.terminus`). */
	terminus: DetourTerminus | null;
	updatedAt: number;
};

/** Un tronçon rapporté à une course : ses bornes y ont un rang, et c'est lui qui les ordonne. */
type Applicable = { candidate: Candidate; startIndex: number; endIndex: number };

/**
 * Les courses d'une journée qui reçoivent exactement la même chose : les mêmes modifications, les
 * mêmes déroutements, et le même itinéraire d'origine. Elles sortent en une seule entité.
 */
type Group = {
	modifications: Modification[];
	shapeId: string;
	tripIds: string[];
};

/**
 * Une `Modification` telle qu'elle sera publiée, une fois les chevauchements repliés. Elle vient d'un
 * tronçon, ou de plusieurs qui se recouvraient sur cette course.
 */
type Modification = {
	parts: string[];
	startStopId: string;
	/** `null` pour une modification de tracé seul : elle ne remplace aucun arrêt (cf. `shapeOnly`). */
	endStopId: string | null;
	startIndex: number;
	endIndex: number;
	propagatedDelay: number;
	stops: { stopId: string; travelTime: number }[];
	paths: DrawnPath[];
	alertId: string | null;
	lastModifiedTime: number;
};

/**
 * Les entités que les déviations déclarées ajoutent au feed : les arrêts provisoires qu'aucun GTFS ne
 * connaît, les tracés recousus, et les modifications elles-mêmes.
 *
 * Elles sortent dans cet ordre — arrêts, tracés, puis modifications qui les référencent. La spec
 * n'impose rien, mais un consommateur qui lit le feed d'une traite y gagne, et ça ne coûte rien.
 *
 * Le pivot est LA COURSE, et non la déclaration : la spécification veut qu'une course soit couverte
 * par une seule `TripModifications`, dont le champ `modifications` porte autant de `Modification`
 * qu'il y a de tronçons déviés. Deux infos trafic sur la même ligne et le même sens se retrouvent
 * donc dans la même entité, et une info trafic qui dévie la ligne en deux endroits y met deux
 * modifications. On assemble ce qui s'applique à chaque course, puis on réunit les courses qui
 * reçoivent exactement la même chose.
 *
 * Un tronçon qui ne supprime aucun arrêt, lui, produit une `Modification` de TRACÉ SEUL : sa borne
 * amont pour tout sélecteur, ni borne aval ni arrêt de substitution — la spécification le prévoit
 * ainsi, et c'est ce qui porte son délai propagé (cf. `shapeOnly`). Ce qu'il change — le chemin —
 * passe par le `shape_id` de la course. C'est le cas d'une ligne déviée dans un sens où elle ne perd
 * pas d'arrêt, d'un tracé repris jusqu'au terminus, d'une course rallongée.
 *
 * Une entité est émise PAR JOURNÉE DE SERVICE, et non une seule portant plusieurs `service_dates`.
 * Sans cela, les courses de toutes les journées se retrouveraient réunies sous chaque date : une
 * course que son service ne fait rouler que le dimanche serait déclarée modifiée le samedi.
 *
 * Les entités sortent sous le réseau du producteur (cf. `NETWORK`) : « TM:TCL:… », « SH:TCL:DEV:… ».
 */
export function buildDetourEntities(
	gtfs: StaticGtfs,
	modifications: ReadonlyMap<number, ResolvedModification>,
	cancelIndex: CancelIndex,
	provisional: ReadonlyMap<string, ProvisionalStop>,
	nowSeconds: number,
): GtfsRealtime.transit_realtime.IFeedEntity[] {
	const stops = new Map<string, GtfsRealtime.transit_realtime.IStop>();
	const shapes = new Map<string, GtfsRealtime.transit_realtime.IShape>();
	const entities: GtfsRealtime.transit_realtime.IFeedEntity[] = [];
	/**
	 * Ce qui a empêché une déclaration de sortir, ou de sortir entière. Un ensemble, et non une liste :
	 * les mêmes constats se reposent à l'identique sur des centaines de courses, et le journal n'a
	 * besoin de les lire qu'une fois.
	 */
	const problems = new Set<string>();

	// Toute course qui part dans les sept jours (cf. `TRIP_MODIFICATIONS_HORIZON`) et n'est pas arrivée
	// à son terminus depuis plus d'une heure (cf. `FINISHED_TRIP_RETENTION`).
	const horizon = nowSeconds + TRIP_MODIFICATIONS_HORIZON;
	const retainedSince = nowSeconds - FINISHED_TRIP_RETENTION;
	const days = serviceDaysBetween(gtfs, retainedSince, horizon);

	// Les tronçons se jaugent au passage des courses à leurs bornes, qui peut remonter à la veille : la
	// première journée candidate borne donc les périodes à considérer, et non l'instant présent.
	const candidates = collectCandidates(
		gtfs,
		modifications,
		provisional,
		problems,
		nowSeconds,
		days[0]?.midnight ?? retainedSince,
		horizon,
	);
	if (candidates.size === 0) {
		report(modifications.size, 0, stops, shapes, entities, problems);
		return [];
	}

	/** Les arrêts provisoires qu'une modification publiée désigne : eux seuls entrent dans le feed. */
	const referenced = new Set<string>();
	/** Les tronçons qui ont fini par s'appliquer à au moins une course. */
	const applied = new Set<string>();
	/** Les tronçons dont au moins une course porte les bornes, en vigueur à son départ ou non. */
	const served = new Set<string>();
	/** Les tracés recousus, par itinéraire d'origine et combinaison de tronçons. */
	const splicedShapes = new Map<string, SplicedShape | null>();

	for (const day of days) {
		/** Les courses du jour qui reçoivent exactement les mêmes modifications et le même itinéraire. */
		const groups = new Map<string, Group>();

		for (const serviceId of day.services) {
			for (const tripId of gtfs.serviceTrips.get(serviceId) ?? []) {
				const meta = gtfs.trips.get(tripId);
				if (meta === undefined) continue;

				const applicable = candidates.get(`${meta.routeId}:${meta.directionId}`);
				if (applicable === undefined) continue;

				// La course a fini de circuler depuis plus d'une heure, ou part au-delà de l'horizon : la
				// fenêtre glisse, elle la rattrapera.
				const departure = gtfs.tripDepartures.get(tripId);
				const arrival = gtfs.tripArrivals.get(tripId);
				if (departure === undefined || arrival === undefined) continue;
				if (day.midnight + arrival < retainedSince || day.midnight + departure >= horizon) continue;

				// Annulée, la course ne roule pas : elle n'a pas d'itinéraire à modifier.
				if (isCancelled(cancelIndex, gtfs, tripId, day.midnight)) continue;

				const schedule = gtfs.tripStopSequences.get(tripId);
				if (schedule === undefined) continue;

				// Chaque tronçon se jauge au passage de la course à ses bornes, comme les arrêts supprimés des
				// trip updates : la course qui n'atteint la déviation qu'après sa fin ne la prend pas, celle
				// partie avant son début mais qui l'atteint pendant la prend. Une déviation de ce soir se lit
				// dès ce matin, sur les courses de ce soir.
				const placed = matchOnTrip(applicable, schedule, gtfs.tripPatterns.get(tripId));
				for (const entry of placed) served.add(entry.candidate.label);
				const departsAt = Temporal.Instant.fromEpochMilliseconds((day.midnight + departure) * 1000);
				// Ce n'est qu'entre les tronçons qui valent pour cette course que la priorité départage.
				const matched = yieldToPriority(
					placed.filter((entry) =>
						passesDuring(
							entry.candidate.periods,
							day.midnight,
							[(schedule[entry.startIndex] as TripStop).arrival, (schedule[entry.endIndex] as TripStop).arrival],
							departsAt,
						),
					),
				);
				if (matched.length === 0) continue;

				// Les deux natures de tronçon se séparent ici. Seuls ceux qui suppriment se replient entre eux ;
				// un tronçon de tracé seul ne remplace rien, et n'a rien à replier.
				const removing = mergeOverlaps(
					gtfs,
					matched.filter((entry) => entry.candidate.removes),
					schedule,
					problems,
				);
				const resolved = [
					...removing,
					...shapeOnly(
						gtfs,
						matched.filter((entry) => !entry.candidate.removes),
						removing,
						problems,
					),
				].sort((a, b) => a.startIndex - b.startIndex);

				for (const modification of resolved) for (const part of modification.parts) applied.add(part);

				const signature = `${meta.shapeId}|${resolved.map(signatureOf).join(";")}`;
				const group = groups.get(signature);
				if (group === undefined)
					groups.set(signature, {
						modifications: resolved,
						shapeId: meta.shapeId,
						tripIds: [tripId],
					});
				else group.tripIds.push(tripId);
			}
		}

		for (const [signature, group] of groups) {
			const parts = group.modifications.map((modification) => modification.parts.join("+")).join("-");
			// Les mêmes tronçons ne donnent pas forcément la même chose sur deux branches : des horaires
			// différents les replient différemment. L'empreinte de la signature tranche, et reste la même
			// d'un relevé à l'autre tant que la déclaration ne bouge pas.
			const fingerprint = createHash("sha1").update(signature).digest("hex").slice(0, 8);
			const spliced = resolveShape(gtfs, shapes, splicedShapes, problems, parts, fingerprint, group);
			const shapeId = spliced?.shapeId ?? null;

			entities.push({
				id: `TM:${NETWORK}:${parts}:${day.date}:${fingerprint}`,
				tripModifications: {
					selectedTrips: [{ tripIds: group.tripIds, shapeId: shapeId ?? undefined }],
					serviceDates: [day.date],
					// `start_times` ne sert qu'à désigner un départ précis d'une course à fréquence. Les
					// courses sont ici énumérées une à une : une liste non vide ne ferait que restreindre à
					// tort ce qui est déjà désigné sans ambiguïté.
					startTimes: [],
					modifications: group.modifications.map((modification) => ({
						// Toujours par identifiant d'arrêt, jamais par rang : une même modification couvre
						// des dizaines de courses dont les `stop_sequence` ne coïncident pas.
						startStopSelector: { stopId: modification.startStopId },
						// Absent pour une modification de tracé seul : la spec l'interdit quand rien n'est remplacé.
						endStopSelector: modification.endStopId === null ? undefined : { stopId: modification.endStopId },
						propagatedModificationDelay: modification.propagatedDelay,
						replacementStops: modification.stops.map((stop) => ({
							stopId: stop.stopId,
							travelTimeToStop: stop.travelTime,
						})),
						// Facultatif dans la spécification : une modification sans info trafic n'en cite aucune.
						// Celle qu'elle cite est republiée dans le même feed, sous l'identifiant préfixé.
						serviceAlertId: modification.alertId === null ? undefined : republishedAlertId(modification.alertId),
						lastModifiedTime: modification.lastModifiedTime,
					})),
				},
			});

			// Les arrêts du GTFS ne sont jamais republiés : ils y sont déjà, et les redéclarer reviendrait
			// à en proposer une seconde version, avec le risque qu'elle prenne le pas sur la bonne. Ne
			// restent que les arrêts provisoires, publiés parce qu'une modification les désigne — et non
			// parce qu'une déviation les posséderait.
			for (const modification of group.modifications) {
				for (const stop of modification.stops) {
					if (provisional.has(stop.stopId)) referenced.add(stop.stopId);
				}
			}
		}
	}

	// Un tronçon dont aucune course ne relève ne laisse rien dans le feed, pas même ses arrêts. C'est le
	// cas à surveiller — des bornes qui ne figurent pas sur l'horaire théorique des courses, parce
	// qu'elles ont été prises sur une autre branche ou que le GTFS a renuméroté ses quais.
	// Un tronçon écrasé partout par un plus prioritaire reste servi : ses bornes, elles, sont bonnes.
	for (const list of candidates.values()) {
		for (const candidate of list) {
			if (served.has(candidate.label)) continue;
			problems.add(
				`${candidate.label} — aucune course de ${lineOf(gtfs, candidate.routeId)} sens ${candidate.directionId} ` +
					(candidate.patternIds === null ? "" : `sur ${[...candidate.patternIds].join(", ")} `) +
					`ne dessert ${candidate.startStopId}` +
					(candidate.endStopId === null ? "" : ` puis ${candidate.endStopId}`) +
					" dans les sept jours à venir : " +
					(candidate.patternIds === null ? "vérifier les bornes." : "vérifier les bornes et les tracés visés."),
			);
		}
	}

	for (const stopId of referenced) {
		const stop = provisional.get(stopId) as ProvisionalStop;
		stops.set(stopId, {
			stopId,
			stopCode: translated(stop.stopCode),
			stopName: translated(stop.name, "fr"),
			stopDesc: translated(stop.description, "fr"),
			stopLat: stop.latitude,
			stopLon: stop.longitude,
			zoneId: stop.zoneId,
			parentStation: stop.parentStation,
			wheelchairBoarding: stop.wheelchairBoarding,
			platformCode: translated(stop.platformCode),
		});
	}

	report(modifications.size, applied.size, stops, shapes, entities, problems);

	return [
		...stops.entries().map(([stopId, stop]) => ({ id: `ST:${stopId}`, stop })),
		...shapes.entries().map(([shapeId, shape]) => ({ id: `SH:${shapeId}`, shape })),
		...entities,
	];
}

/**
 * Le nombre de courses qu'un tronçon modifierait avec ces bornes dans les sept jours à venir, par
 * tracé emprunté. L'interface s'en sert pour le dire AVANT l'enregistrement : des
 * bornes que l'horaire théorique ne porte pas ne sélectionnent rien, et le tronçon n'entre alors pas
 * dans le feed. Le détail par tracé dit en plus lesquels desservent ces bornes.
 */
export function countSelectableTrips(
	gtfs: StaticGtfs,
	routeId: string,
	directionId: number,
	bounds: SegmentBounds,
	nowSeconds: number,
): Map<string, number> {
	const counts = new Map<string, number>();
	const horizon = nowSeconds + TRIP_MODIFICATIONS_HORIZON;
	const retainedSince = nowSeconds - FINISHED_TRIP_RETENTION;

	for (const day of serviceDaysBetween(gtfs, retainedSince, horizon)) {
		for (const serviceId of day.services) {
			for (const tripId of gtfs.serviceTrips.get(serviceId) ?? []) {
				const meta = gtfs.trips.get(tripId);
				if (meta === undefined || meta.routeId !== routeId || meta.directionId !== directionId) continue;

				const departure = gtfs.tripDepartures.get(tripId);
				const arrival = gtfs.tripArrivals.get(tripId);
				if (departure === undefined || arrival === undefined) continue;
				if (day.midnight + arrival < retainedSince || day.midnight + departure >= horizon) continue;

				const schedule = gtfs.tripStopSequences.get(tripId);
				const patternId = gtfs.tripPatterns.get(tripId);
				if (schedule === undefined || patternId === undefined) continue;
				if (rangeOn(schedule, bounds) === undefined) continue;

				counts.set(patternId, (counts.get(patternId) ?? 0) + 1);
			}
		}
	}

	return counts;
}

// ---

/**
 * Les tronçons publiables, indexés par ligne et sens. Tout ce qui empêche un segment de sortir se
 * juge ici, une fois pour toutes : au-delà, on ne raisonne plus que sur des courses.
 */
function collectCandidates(
	gtfs: StaticGtfs,
	modifications: ReadonlyMap<number, ResolvedModification>,
	provisional: ReadonlyMap<string, ProvisionalStop>,
	problems: Set<string>,
	nowSeconds: number,
	from: number,
	horizon: number,
): Map<string, Candidate[]> {
	const candidates = new Map<string, Candidate[]>();
	const window: AlertPeriod[] = [{ start: minuteOf(from), end: minuteOf(horizon), dailyWindow: null }];

	for (const modification of modifications.values()) {
		// Muette — ni activée à la main, ni associée à une info trafic effective (cf. `silent`) —, hors de
		// sa période de communication — de son dernier enregistrement à la fin de sa dernière période —,
		// ou sans période dans les jours à venir, la modification ne s'annonce pas : c'est un choix ou un
		// calendrier, pas un problème, et le journal n'a rien à en dire.
		const { communication } = modification;
		if (modification.silent) continue;
		if (nowSeconds < communication.start || (communication.end !== null && nowSeconds >= communication.end)) continue;
		if (!periodsOverlap(modification.periods, window)) continue;
		const record = modification.record;

		record.segments.forEach((segment, rank) => {
			const label = `M${record.uid}#${rank}`;
			const { startStopId, endStopId } = segment;
			// La borne amont est requise quelle que soit la nature du tronçon : publiée ou non, c'est elle
			// qui désigne les courses concernées. La borne aval peut manquer : la plage court alors
			// jusqu'au bout de chaque course (cf. `rangeOn`).
			if (startStopId === null) {
				problems.add(`${label} — borne amont du tronçon manquante.`);
				return;
			}

			// La nature du tronçon se lit d'ici : une plage sans arrêt supprimé ne supprime rien, et n'a
			// que son tracé à annoncer.
			const removes = removesStops(
				gtfs,
				record.routeId,
				record.directionId,
				record.patternIds,
				modification.removedStopIds,
				segment,
			);

			if (!removes && segment.path.length < 2) {
				problems.add(`${label} — aucun arrêt supprimé dans sa plage, et pas de tracé : rien à annoncer.`);
				return;
			}

			// Un tronçon peut n'avoir aucun arrêt de substitution : le segment est alors simplement
			// supprimé, et c'est le tracé qui dit par où le véhicule passe à la place. `replacement_stops`
			// admet d'être vide — la spec la veut « de longueur inférieure, égale ou supérieure » aux
			// arrêts remplacés. Il faut seulement qu'il annonce QUELQUE CHOSE : sans arrêt ni tracé, il ne
			// dit rien que les `SKIPPED` des trip updates ne disent déjà.
			if (removes && segment.stops.length === 0 && segment.path.length < 2) {
				problems.add(`${label} — ni arrêt de substitution ni tracé : rien à annoncer.`);
				return;
			}

			// Le périmètre a pu changer après coup : des arrêts de substitution saisis quand la plage
			// supprimait encore n'ont plus rien à remplacer. Ils sont laissés de côté, et le journal le
			// dit — les publier reviendrait à ajouter des arrêts à une course qui n'en perd aucun.
			if (!removes && segment.stops.length > 0) {
				problems.add(
					`${label} — aucun arrêt supprimé dans sa plage : ses arrêts de substitution sont ignorés, ` +
						"seuls le tracé et le délai propagé sont publiés.",
				);
			}

			// Un arrêt provisoire disparu de la base ne se rattrape pas : publier la modification laisserait
			// un `stop_id` que rien ne définit, et un consommateur ne saurait qu'en faire.
			const dangling = segment.stops.filter(
				(stop) => provisionalStopUid(stop.stopId) !== undefined && !provisional.has(stop.stopId),
			);
			if (dangling.length > 0) {
				problems.add(
					`${label} — désigne ${dangling.map((stop) => stop.stopId).join(", ")}, absent de la base des arrêts provisoires : arrêt à recréer ou à retirer.`,
				);
				return;
			}

			const routeDirection = `${record.routeId}:${record.directionId}`;
			const list = candidates.get(routeDirection);
			const candidate: Candidate = {
				label,
				removes,
				// Toujours une info trafic effective, donc republiée : une autre renverrait à une alerte absente.
				alertId: modification.alertId,
				periods: modification.periods,
				routeId: record.routeId,
				directionId: record.directionId,
				patternIds: record.patternIds.length === 0 ? null : new Set(record.patternIds),
				priority: record.priority,
				startStopId,
				endStopId,
				propagatedDelay: segment.propagatedDelay,
				stops: removes ? segment.stops.map((stop) => ({ stopId: stop.stopId, travelTime: stop.travelTime })) : [],
				path: segment.path,
				terminus: segment.terminus,
				updatedAt: record.updatedAt,
			};
			if (list === undefined) candidates.set(routeDirection, [candidate]);
			else list.push(candidate);
		});
	}

	return candidates;
}

/**
 * Les tronçons que l'horaire théorique de cette course porte, dans l'ordre où elle les rencontre.
 *
 * Un tronçon n'est retenu que si l'horaire porte ses DEUX bornes, dans l'ordre : c'est ce qui écarte
 * les branches et les services partiels qui ne passent pas par le segment dévié, sans avoir à les
 * deviner. Sans borne aval, la course n'a qu'à desservir la borne amont : la plage va jusqu'à son
 * dernier arrêt. S'il nomme des tracés, la course doit en plus emprunter l'un d'eux.
 */
function matchOnTrip(
	candidates: readonly Candidate[],
	schedule: TripStop[],
	patternId: string | undefined,
): Applicable[] {
	const matched: Applicable[] = [];

	for (const candidate of candidates) {
		if (candidate.patternIds !== null && (patternId === undefined || !candidate.patternIds.has(patternId))) continue;
		const range = rangeOn(schedule, candidate);
		if (range !== undefined) matched.push({ candidate, startIndex: range.start, endIndex: range.end });
	}

	return byPosition(matched);
}

/**
 * Tranche, sur cette course, entre les tronçons qui s'y appliquent et se recouvrent : le plus
 * prioritaire reste, l'autre s'efface ; à priorité égale, ils restent tous deux, et `mergeOverlaps`
 * les replie. Seul un tronçon qui reste peut en écraser un autre — comme `resolveOverrides`.
 *
 * C'est course par course que cela se juge, et non une fois pour toutes à l'instant de l'indexation :
 * une modification prioritaire le temps d'une manifestation ne vaut que pour les courses qui passent
 * pendant ses périodes. Jugée à l'instant, elle n'écraserait rien tant qu'elle n'a pas commencé — les
 * deux se replieraient alors l'une dans l'autre sur les courses à venir —, puis écraserait l'autre
 * jusque sur les courses d'après sa fin.
 */
function yieldToPriority(matched: readonly Applicable[]): Applicable[] {
	const kept: Applicable[] = [];
	for (const entry of [...matched].sort((a, b) => b.candidate.priority - a.candidate.priority)) {
		const beaten = kept.some(
			(other) =>
				other.candidate.priority > entry.candidate.priority &&
				other.startIndex <= entry.endIndex &&
				entry.startIndex <= other.endIndex,
		);
		if (!beaten) kept.push(entry);
	}
	return byPosition(kept);
}

/** Dans l'ordre où la course les rencontre : c'est celui que `mergeOverlaps` attend. */
function byPosition(entries: Applicable[]): Applicable[] {
	return entries.sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex);
}

/**
 * Replie en une seule `Modification` les tronçons qu'une course ne peut pas porter séparément.
 *
 * Un `ReplacementStop.travel_time_to_stop` se compte depuis l'ARRÊT DE RÉFÉRENCE de sa modification,
 * celui qui précède immédiatement sa borne amont. Deux tronçons doivent donc fusionner dès que la
 * référence du second tombe dans ce que le premier supprime — ce qui arrive dans deux cas :
 *
 *  - ils se RECOUVRENT : les mêmes arrêts seraient supprimés deux fois, et la spécification ne dit
 *    pas ce qu'un consommateur devrait en faire. C'est une erreur de saisie, et le journal le dit ;
 *  - ils se SUIVENT, la borne amont du second venant juste après la borne aval du premier : sa
 *    référence est alors le dernier arrêt supprimé par le premier. Publier deux modifications ferait
 *    compter les horaires du second depuis un arrêt que la course ne dessert plus — le consommateur
 *    retomberait sur la référence du premier, et tout le second tronçon serait décalé d'autant. Rien
 *    n'est fautif ici : c'est la seule façon de l'écrire, et il n'y a rien à signaler.
 *
 * Dans les deux cas, la modification fusionnée prend les bornes au plus large, met les arrêts de
 * substitution bout à bout, additionne les délais propagés, et REBASE les temps du second sur la
 * référence du premier — la seule qui survive.
 */
function mergeOverlaps(
	gtfs: StaticGtfs,
	matched: Applicable[],
	schedule: TripStop[],
	problems: Set<string>,
): Modification[] {
	const merged: Modification[] = [];

	for (const { candidate, startIndex, endIndex } of matched) {
		const previous = merged.at(-1);
		// La référence du tronçon est l'arrêt qui précède sa borne amont : il faut fusionner dès qu'elle
		// tombe dans ce que le précédent supprime, donc dès `startIndex - 1 <= previous.endIndex`.
		if (previous === undefined || startIndex - 1 > previous.endIndex) {
			merged.push({
				parts: [candidate.label],
				startStopId: candidate.startStopId,
				endStopId: (schedule[endIndex] as TripStop).stopId,
				startIndex,
				endIndex,
				propagatedDelay: candidate.propagatedDelay,
				stops: [...candidate.stops],
				paths: candidate.path.length >= 2 ? [drawnPath(candidate)] : [],
				alertId: candidate.alertId,
				lastModifiedTime: candidate.updatedAt,
			});
			continue;
		}

		const offset = rebaseOffset(schedule, previous.startIndex, startIndex);

		// Le recouvrement, lui, se signale : deux infos trafic qui suppriment les mêmes arrêts décrivent
		// probablement la même perturbation, et leurs délais propagés se comptent alors deux fois.
		if (startIndex <= previous.endIndex) {
			problems.add(
				`${previous.parts.join("+")} et ${candidate.label} se recouvrent sur ${lineOf(gtfs, candidate.routeId)} sens ` +
					`${candidate.directionId} : fusionnés en une seule modification. À ressaisir en un seul tronçon.`,
			);
		}
		if (offset === undefined) {
			problems.add(
				`${previous.parts.join("+")} et ${candidate.label} : horaire théorique incomplet, les temps de ` +
					"parcours du second n'ont pas pu être rebasés sur la référence du premier.",
			);
		}

		previous.parts.push(candidate.label);
		if (endIndex > previous.endIndex) {
			previous.endIndex = endIndex;
			previous.endStopId = (schedule[endIndex] as TripStop).stopId;
		}
		previous.propagatedDelay += candidate.propagatedDelay;
		previous.lastModifiedTime = Math.max(previous.lastModifiedTime, candidate.updatedAt);
		if (candidate.path.length >= 2) previous.paths.push(drawnPath(candidate));

		for (const stop of candidate.stops) {
			if (previous.stops.some((existing) => existing.stopId === stop.stopId)) continue;
			previous.stops.push({ stopId: stop.stopId, travelTime: stop.travelTime + (offset ?? 0) });
		}

		// La spec veut les temps strictement croissants, et le rebasage n'en donne pas la garantie : deux
		// tronçons qui se recouvrent se recouvrent aussi dans le temps. On les écarte d'une seconde plutôt
		// que de publier une suite que le consommateur refuserait.
		for (const [index, stop] of previous.stops.entries()) {
			const before = previous.stops[index - 1];
			if (before !== undefined && stop.travelTime <= before.travelTime) stop.travelTime = before.travelTime + 1;
		}
	}

	return merged;
}

/**
 * Les `Modification` de tracé seul des tronçons qui ne suppriment rien sur cette course.
 *
 * La spécification les prévoit : `start_stop_selector` seul, ni `end_stop_selector` ni
 * `replacement_stops`. Le délai propagé s'applique alors à partir de l'arrêt qui SUIT la borne amont
 * — la borne elle-même est desservie à l'heure. Rien n'est remplacé, et l'arrêt de référence ne sert
 * à rien : il n'y a pas de temps de parcours à compter.
 *
 * Une borne amont qu'une modification supprime sur cette course — deux déclarations de même priorité
 * qui se recoupent — ne désignerait qu'un arrêt que la course ne dessert plus. Le tronçon se replie
 * alors dans celle-là, qui emporte son tracé mais pas son délai ; le journal le dit.
 */
function shapeOnly(
	gtfs: StaticGtfs,
	matched: readonly Applicable[],
	removing: readonly Modification[],
	problems: Set<string>,
): Modification[] {
	const published: Modification[] = [];

	for (const { candidate, startIndex } of matched) {
		const host = removing.find((other) => other.startIndex <= startIndex && startIndex <= other.endIndex);
		if (host !== undefined) {
			problems.add(
				`${candidate.label} — sa borne amont est supprimée par ${host.parts.join("+")} sur ${lineOf(gtfs, candidate.routeId)} ` +
					`sens ${candidate.directionId} : son tracé y est joint, son délai propagé est perdu.`,
			);
			host.parts.push(candidate.label);
			host.lastModifiedTime = Math.max(host.lastModifiedTime, candidate.updatedAt);
			host.paths.push(drawnPath(candidate));
			continue;
		}

		published.push({
			parts: [candidate.label],
			startStopId: candidate.startStopId,
			endStopId: null,
			startIndex,
			endIndex: startIndex,
			propagatedDelay: candidate.propagatedDelay,
			stops: [],
			paths: [drawnPath(candidate)],
			alertId: candidate.alertId,
			lastModifiedTime: candidate.updatedAt,
		});
	}

	return published;
}

/** Le tracé d'un tronçon, tel que la recouture le prend. */
function drawnPath(candidate: Candidate): DrawnPath {
	return { points: candidate.path, terminus: candidate.terminus };
}

/**
 * Le temps qui sépare les arrêts de référence de deux tronçons sur cette course — celui qui précède
 * chacune de leurs bornes amont —, d'après l'horaire théorique.
 *
 * C'est de quoi décaler les temps de parcours du second pour les rapporter à la référence du premier,
 * et c'est exact : `stop_times.txt` donne l'arrivée à chaque arrêt, il n'y a rien à estimer.
 *
 * `undefined` lorsque l'horaire ne donne pas l'une des deux arrivées — mieux vaut ne rien décaler que
 * décaler n'importe comment, et le journal le dit.
 */
function rebaseOffset(schedule: TripStop[], fromStartIndex: number, toStartIndex: number): number | undefined {
	// Une borne amont qui ouvre la course n'a pas d'arrêt de référence : c'est elle-même, et les temps
	// se comptent alors depuis son arrivée (cf. `DetourStop.travelTime`).
	const from = schedule[Math.max(fromStartIndex - 1, 0)];
	const to = schedule[Math.max(toStartIndex - 1, 0)];
	if (from === undefined || to === undefined) return undefined;
	if (!Number.isFinite(from.arrival) || !Number.isFinite(to.arrival)) return undefined;

	return Math.round(to.arrival - from.arrival);
}

/**
 * Ce qui distingue une modification d'une autre, pour réunir les courses qui reçoivent la même.
 *
 * Les temps de parcours en font partie, et c'est indispensable depuis qu'une fusion les rebase sur
 * l'horaire théorique : deux courses de la même ligne ne mettent pas le même temps entre les deux
 * arrêts de référence — l'heure de pointe n'est pas le dimanche matin —, et les réunir publierait
 * pour l'une les horaires de l'autre.
 */
function signatureOf(modification: Modification): string {
	const stops = modification.stops.map((stop) => `${stop.stopId}@${stop.travelTime}`).join(",");
	return (
		`${modification.parts.join("+")}:${modification.startStopId}>${modification.endStopId}` +
		`/${modification.propagatedDelay}/${stops}`
	);
}

/** Un tracé recousu et publié : son identifiant, ses points, et d'où chacun vient (cf. `spliceShape`). */
type SplicedShape = { shapeId: string; points: Coordinates[]; origins: (number | null)[] };

/**
 * Le tracé dévié correspondant à l'itinéraire d'origine de ces courses, en l'inscrivant au feed au
 * passage. `null` lorsqu'il n'y a rien à publier — aucun tracé dessiné, itinéraire inconnu, ou
 * recouture impossible : la `SelectedTrips` sort alors sans `shape_id`, le champ étant facultatif.
 *
 * Mémoïsé par itinéraire ET par combinaison de tronçons : le même itinéraire ne se recoud pas de la
 * même façon selon ce qui s'y applique, et la même combinaison revient sur toutes les journées.
 */
function resolveShape(
	gtfs: StaticGtfs,
	shapes: Map<string, GtfsRealtime.transit_realtime.IShape>,
	spliced: Map<string, SplicedShape | null>,
	problems: Set<string>,
	parts: string,
	fingerprint: string,
	group: Group,
): SplicedShape | null {
	const memo = `${group.shapeId}|${fingerprint}`;
	const known = spliced.get(memo);
	if (known !== undefined) return known;

	const shape = buildShape(gtfs, shapes, problems, parts, fingerprint, group);
	spliced.set(memo, shape);
	return shape;
}

function buildShape(
	gtfs: StaticGtfs,
	shapes: Map<string, GtfsRealtime.transit_realtime.IShape>,
	problems: Set<string>,
	parts: string,
	fingerprint: string,
	group: Group,
): SplicedShape | null {
	const paths = group.modifications.flatMap((modification) => modification.paths);
	if (paths.length === 0) return null;

	const original = gtfs.shapes.get(group.shapeId);
	if (original === undefined) {
		problems.add(`${parts} — ${group.shapeId} absent du GTFS, tracé non publié pour ces courses.`);
		return null;
	}

	const outcome = spliceShape(original, paths);
	if (!outcome.ok) {
		problems.add(`${parts} — ${group.shapeId} : tracé ou itinéraire réduit à moins de deux points.`);
		return null;
	}

	// Les seuls reproches qu'on se permette : un point de divergence loin de l'itinéraire, et un tracé
	// laissé de côté. Le trajet est publié tel quel — il se voit dans l'éditeur, qui en montre le
	// résultat — mais un raccord à plusieurs centaines de mètres vaut d'être signalé.
	for (const offset of outcome.startOffsets) {
		if (offset > MAX_DETOUR_JUNCTION_OFFSET) {
			problems.add(
				`${parts} — ${group.shapeId} : tracé publié, mais un point de départ est à ${Math.round(offset * 1000)} m de l'itinéraire.`,
			);
		}
	}
	if (outcome.unreachable > 0) {
		problems.add(
			`${parts} — ${group.shapeId} : ${outcome.unreachable} tracé(s) laissé(s) de côté, la course ne les atteint pas dans cet ordre, ou deux ouvrent la course.`,
		);
	}

	const shapeId = `${NETWORK}:DEV:${parts}:${suffixOf(group.shapeId)}:${fingerprint}`;
	shapes.set(shapeId, { shapeId, encodedPolyline: encodePolyline(outcome.points) });
	return { shapeId, points: outcome.points, origins: outcome.origins };
}

function report(
	declared: number,
	applied: number,
	stops: Map<string, unknown>,
	shapes: Map<string, unknown>,
	modifications: readonly unknown[],
	problems: ReadonlySet<string>,
) {
	if (declared === 0) return;

	console.log(
		`✓ ${applied} detour segments published (${stops.size} stops, ${shapes.size} shapes, ${modifications.length} modifications).`,
	);
	for (const problem of problems) console.warn(`\t✘ ${problem}`);
}

/**
 * Un champ texte d'arrêt tel que le GTFS-RT le veut, ou rien pour un champ vide. Un code ou un quai
 * ne sont d'aucune langue : ils s'en passent.
 */
function translated(text: string | null, language?: string): GtfsRealtime.transit_realtime.ITranslatedString | null {
	if (text === null) return null;
	return { translation: [language === undefined ? { text } : { text, language }] };
}

/** Le nom commercial de la ligne, ou à défaut son identifiant. */
function lineOf(gtfs: StaticGtfs, routeId: string): string {
	return gtfs.routeNames.get(routeId) ?? routeId.split(":").at(-1) ?? routeId;
}

/** Un instant au format des bornes de période, à la minute : « AAAA-MM-JJTHH:MM ». */
function minuteOf(seconds: number): string {
	return Temporal.Instant.fromEpochMilliseconds(seconds * 1000)
		.toZonedDateTimeISO("Europe/Paris")
		.toPlainDateTime()
		.toString({ smallestUnit: "minute" });
}

/** La part distinctive d'un identifiant d'itinéraire, pour en dériver celui du tracé recousu. */
function suffixOf(shapeId: string): string {
	return shapeId.split(":").at(-1) ?? shapeId;
}
