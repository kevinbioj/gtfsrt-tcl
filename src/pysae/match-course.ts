import { PYSAE_DRIFT_TOLERANCE, PYSAE_MATCH_TOLERANCE, PYSAE_SIBLING_STOP_DISTANCE } from "../config.js";
import { normalizeStopName, type StaticGtfs, type TripStop } from "../gtfs-rt/use-static-gtfs.js";
import { haversine } from "../utils/geometry.js";
import type { PysaeStop } from "./static-gtfs.js";

/**
 * Le tronçon d'une course Pysae qu'assure une course de TCL : celle-ci, et pour chaque arrêt Pysae
 * qu'on y a retrouvé — par son `stop_sequence` —, l'arrêt de TCL qui lui correspond.
 */
export type MatchedSegment = { tripId: string; stops: Map<number, TripStop> };

/** Ce qu'il faut du GTFS de TCL pour y chercher une course : ses lignes par nom, ses courses par ligne. */
type TclIndex = { routesByName: Map<string, string[]>; routeTrips: Map<string, string[]> };

const indexes = new WeakMap<StaticGtfs, TclIndex>();

function tclIndex(gtfs: StaticGtfs): TclIndex {
	let index = indexes.get(gtfs);
	if (index !== undefined) return index;

	const routesByName = new Map<string, string[]>();
	for (const [routeId, name] of gtfs.routeNames) routesByName.set(name, [...(routesByName.get(name) ?? []), routeId]);
	const routeTrips = new Map<string, string[]>();
	for (const [tripId, { routeId }] of gtfs.trips) {
		const trips = routeTrips.get(routeId);
		if (trips === undefined) routeTrips.set(routeId, [tripId]);
		else trips.push(tripId);
	}

	index = { routesByName, routeTrips };
	indexes.set(gtfs, index);
	return index;
}

/**
 * Les lignes de TCL qui portent le nom d'une ligne Pysae. Les lignes scolaires y perdent parfois leur
 * préfixe (« 767 » pour « JD767 ») ; `aliases` couvre le reste (« N81 » pour « N181 »).
 */
export function tclRoutesNamed(gtfs: StaticGtfs, name: string, aliases: Readonly<Record<string, string>>): string[] {
	const { routesByName } = tclIndex(gtfs);
	const alias = aliases[name];
	const names = alias !== undefined ? [alias] : [name, `JD${name}`];
	return names.flatMap((candidate) => routesByName.get(candidate) ?? []);
}

/** Les courses de ces lignes que l'un de ces services assure. */
export function tripsOf(gtfs: StaticGtfs, routeIds: readonly string[], services: ReadonlySet<string>): string[] {
	const { routeTrips } = tclIndex(gtfs);
	return routeIds.flatMap((routeId) =>
		(routeTrips.get(routeId) ?? []).filter((tripId) => services.has(gtfs.trips.get(tripId)?.serviceId ?? "")),
	);
}

/**
 * Retrouve dans le GTFS de TCL, parmi `candidates`, la ou les courses que décrit l'horaire Pysae
 * `stops`. Les deux GTFS partagent leurs arrêts mais pas leurs identifiants de course, et pas
 * toujours leur découpage : c'est le passage aux mêmes arrêts, aux mêmes heures, qui les rapproche.
 *
 * La course retenue est celle qui reprend le plus d'arrêts de l'horaire Pysae, dans l'ordre, chacun à
 * {@link PYSAE_MATCH_TOLERANCE} près (cf. `align`). Ses autres arrêts s'y rattachent ensuite plus
 * largement (cf. `realign`), et il lui en faut alors au moins la moitié : en deçà, ce n'est qu'une
 * course qui croise la même rue à la même heure.
 *
 * Une course Pysae peut en recouvrir deux chez TCL : la 130 y fait l'aller et le retour d'une traite,
 * que TCL décrit en deux courses. Ce qu'en laisse la première, à son début ou à sa fin, se cherche donc
 * à son tour — pour peu que cela fasse au moins trois arrêts, retrouvés à moitié.
 *
 * À reprise égale, la course qui rattache le plus d'arrêts l'emporte, puis celle dont l'identifiant
 * finit comme celui de la course Pysae — le même, ou le même numéro de course dans une autre version
 * de l'horaire (« 223_S3B-023AM_00201002 » pour « 139_139A-001AM_00201002 ») —, puis celle dont les
 * horaires s'écartent le moins. C'est ce qui sépare les courses doublées, qu'assurent deux véhicules
 * au même horaire.
 */
export function matchCourse(
	gtfs: StaticGtfs,
	stops: readonly PysaeStop[],
	candidates: readonly string[],
	pysaeTripId: string,
): MatchedSegment[] {
	const segments: MatchedSegment[] = [];
	const used = new Set<string>();
	const pending: { stops: readonly PysaeStop[]; minimum: number }[] = [{ stops, minimum: Math.min(stops.length, 2) }];

	for (let run = pending.shift(); run !== undefined; run = pending.shift()) {
		const best = bestCandidate(
			gtfs,
			run.stops,
			candidates.filter((tripId) => !used.has(tripId)),
			pysaeTripId,
		);
		if (best === undefined || best.stops.size < Math.max(run.minimum, run.stops.length / 2)) continue;

		const matched = best.stops;
		segments.push({ tripId: best.tripId, stops: matched });
		used.add(best.tripId);

		// Ce qu'elle laisse à l'une ou l'autre extrémité : la suite d'une boucle, ou ce qui la précède.
		const first = run.stops.findIndex(({ stopSequence }) => matched.has(stopSequence));
		const last = run.stops.findLastIndex(({ stopSequence }) => matched.has(stopSequence));
		const before = run.stops.slice(0, first);
		const after = run.stops.slice(last + 1);
		if (before.length >= 3) pending.push({ stops: before, minimum: 3 });
		if (after.length >= 3) pending.push({ stops: after, minimum: 3 });
	}

	return segments.sort((a, b) => Math.min(...a.stops.keys()) - Math.min(...b.stops.keys()));
}

/**
 * Une course de TCL mise en regard de l'horaire Pysae : ce que l'alignement en a retrouvé (`score`,
 * `deviation`), et les arrêts rattachés au bout du compte (`stops`).
 */
type Candidate = { tripId: string; stops: Map<number, TripStop>; score: number; deviation: number };

function bestCandidate(
	gtfs: StaticGtfs,
	stops: readonly PysaeStop[],
	candidates: readonly string[],
	pysaeTripId: string,
): Candidate | undefined {
	let best: Candidate | undefined;
	for (const tripId of candidates) {
		const schedule = gtfs.tripStopSequences.get(tripId);
		if (schedule === undefined) continue;

		const aligned = align(gtfs, stops, schedule);
		if (aligned.stops.size === 0) continue;

		const candidate = { ...aligned, tripId, stops: realign(gtfs, stops, schedule, aligned.stops) };
		if (best === undefined || isBetter(candidate, best, pysaeTripId)) best = candidate;
	}
	return best;
}

function isBetter(candidate: Candidate, best: Candidate, pysaeTripId: string): boolean {
	if (candidate.score !== best.score) return candidate.score > best.score;
	if (candidate.stops.size !== best.stops.size) return candidate.stops.size > best.stops.size;
	const suffix = sharedSuffix(candidate.tripId, pysaeTripId);
	const bestSuffix = sharedSuffix(best.tripId, pysaeTripId);
	if (suffix !== bestSuffix) return suffix > bestSuffix;
	return candidate.deviation < best.deviation;
}

/** Le nombre de caractères par lesquels deux identifiants finissent de même. */
function sharedSuffix(a: string, b: string): number {
	let length = 0;
	while (length < a.length && length < b.length && a[a.length - 1 - length] === b[b.length - 1 - length]) length += 1;
	return length;
}

/**
 * Aligne l'horaire Pysae sur celui d'une course de TCL : chaque arrêt Pysae y retrouve, dans l'ordre,
 * le premier arrêt suivant desservi à la même heure — au même quai, ou à son vis-à-vis, qui compte
 * moitié moins (cf. `placeWeight`). L'heure se compare à l'arrivée comme au départ Pysae : un
 * terminus de boucle est l'arrivée de l'aller et le départ du retour.
 */
function align(
	gtfs: StaticGtfs,
	stops: readonly PysaeStop[],
	schedule: readonly TripStop[],
): { stops: Map<number, TripStop>; score: number; deviation: number } {
	const matched = new Map<number, TripStop>();
	let score = 0;
	let deviation = 0;
	let cursor = 0;

	for (const stop of stops) {
		for (let index = cursor; index < schedule.length; index += 1) {
			const candidate = schedule[index] as TripStop;
			const gap = Math.min(timeGap(candidate.arrival, stop.arrival), timeGap(candidate.arrival, stop.departure));
			if (gap > PYSAE_MATCH_TOLERANCE) continue;

			const weight = placeWeight(gtfs, candidate.stopId, stop);
			if (weight === 0) continue;

			matched.set(stop.stopSequence, candidate);
			score += weight;
			deviation += gap;
			cursor = index + 1;
			break;
		}
	}

	return { stops: matched, score, deviation };
}

/**
 * Rattache à la course de TCL les arrêts Pysae que l'alignement a laissés de côté, pour peu qu'elle
 * les desserve à leur place — entre les arrêts qui encadrent chacun — et à
 * {@link PYSAE_DRIFT_TOLERANCE} près. Les deux versions de l'horaire divergent parfois en cours de
 * route : celle de Pysae dessert un arrêt de plus, et toute la fin de la course passe sept minutes
 * plus tard que chez TCL ; ou TCL a décalé ses horaires de quelques minutes après le premier arrêt. Ce
 * sont pourtant les mêmes arrêts, et Pysae y annonce des instants, non des retards : ils valent pour
 * la course de TCL.
 */
function realign(
	gtfs: StaticGtfs,
	stops: readonly PysaeStop[],
	schedule: readonly TripStop[],
	anchors: ReadonlyMap<number, TripStop>,
): Map<number, TripStop> {
	const matched = new Map(anchors);
	const indexOf = new Map(schedule.map(({ stopSequence }, index) => [stopSequence, index]));
	const anchorIndex = (stop: PysaeStop) => {
		const anchor = anchors.get(stop.stopSequence);
		return anchor === undefined ? undefined : indexOf.get(anchor.stopSequence);
	};

	let lower = -1;
	stops.forEach((stop, position) => {
		const anchored = anchorIndex(stop);
		if (anchored !== undefined) {
			lower = anchored;
			return;
		}

		let upper = schedule.length;
		for (const next of stops.slice(position + 1)) {
			const index = anchorIndex(next);
			if (index !== undefined) {
				upper = index;
				break;
			}
		}

		for (let index = lower + 1; index < upper; index += 1) {
			const candidate = schedule[index] as TripStop;
			if (
				Math.min(timeGap(candidate.arrival, stop.arrival), timeGap(candidate.arrival, stop.departure)) >
				PYSAE_DRIFT_TOLERANCE
			)
				continue;
			if (placeWeight(gtfs, candidate.stopId, stop) === 0) continue;

			matched.set(stop.stopSequence, candidate);
			lower = index;
			break;
		}
	});

	return matched;
}

/** L'écart entre deux horaires, infini si l'un manque. */
function timeGap(a: number, b: number): number {
	const gap = Math.abs(a - b);
	return Number.isNaN(gap) ? Number.POSITIVE_INFINITY : gap;
}

/**
 * Le quai de TCL est-il l'arrêt Pysae ? 2 s'il en porte l'identifiant, 1 s'il en est le vis-à-vis —
 * même nom, à moins de {@link PYSAE_SIBLING_STOP_DISTANCE} —, 0 sinon.
 *
 * Pysae reprend les identifiants de TCL, mais crée parfois ses propres arrêts sous des identifiants
 * que TCL donne à d'autres : « 20 » est un report à Meyzieu chez l'un, Acacias chez l'autre, à seize
 * kilomètres. Un même identifiant ne vaut donc qu'au même endroit. Quant au vis-à-vis, c'est souvent
 * le quai d'en face, ou le terminus que Pysae a recréé sous son propre identifiant.
 */
function placeWeight(gtfs: StaticGtfs, tclStopId: string, stop: PysaeStop): number {
	const tclPosition = gtfs.stopCoordinates.get(tclStopId);
	const pysaePosition = stop.position ?? gtfs.stopCoordinates.get(stop.stopId);
	const near =
		tclPosition === undefined || pysaePosition === undefined
			? undefined
			: haversine(tclPosition, pysaePosition) <= PYSAE_SIBLING_STOP_DISTANCE;
	if (tclStopId === stop.stopId) return near === false ? 0 : 2;

	const tclName = gtfs.stopNames.get(tclStopId);
	const pysaeName = stop.name ?? gtfs.stopNames.get(stop.stopId);
	return near &&
		tclName !== undefined &&
		pysaeName !== undefined &&
		normalizeStopName(tclName) === normalizeStopName(pysaeName)
		? 1
		: 0;
}
