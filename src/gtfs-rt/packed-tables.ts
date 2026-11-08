import type { ShapePoint } from "../utils/geometry.js";
import type { Lookup, TripStop } from "./use-static-gtfs.js";

/**
 * Les horaires théoriques de toutes les courses, compactés : une course occupe une plage de rangs
 * (`offsets[i]` à `offsets[i + 1]`), chaque rang un arrêt. Près de trois millions d'objets `TripStop`
 * pèseraient quelque 300 Mo et se transmettraient d'un processus à l'autre en plusieurs secondes ; ces
 * tableaux en pèsent une soixantaine et se transmettent d'un bloc.
 */
export type PackedSchedules = {
	tripIds: string[];
	offsets: Int32Array;
	stopSequences: Int32Array;
	/** Rang de l'arrêt dans `stopIds`. */
	stopIndexes: Int32Array;
	stopIds: string[];
	distances: Float64Array;
	/** {@link NO_ARRIVAL} pour une arrivée que `stop_times.txt` ne donne pas. */
	arrivals: Int32Array;
};

/** Les tracés de toutes les courses, compactés comme les horaires. */
export type PackedShapes = {
	shapeIds: string[];
	offsets: Int32Array;
	latitudes: Float64Array;
	longitudes: Float64Array;
	distances: Float64Array;
};

export type PackedTables = { schedules: PackedSchedules; shapes: PackedShapes };

/** L'arrivée inconnue (`NaN` dans un `TripStop`), qu'un `Int32Array` ne sait pas porter. */
const NO_ARRIVAL = -2_147_483_648;

export function packSchedules(schedules: ReadonlyMap<string, TripStop[]>): PackedSchedules {
	let total = 0;
	for (const stops of schedules.values()) total += stops.length;

	const tripIds: string[] = [];
	const offsets = new Int32Array(schedules.size + 1);
	const stopSequences = new Int32Array(total);
	const stopIndexes = new Int32Array(total);
	const distances = new Float64Array(total);
	const arrivals = new Int32Array(total);
	const stopIds: string[] = [];
	const stopRanks = new Map<string, number>();

	let row = 0;
	for (const [tripId, stops] of schedules) {
		offsets[tripIds.length] = row;
		tripIds.push(tripId);
		for (const stop of stops) {
			let rank = stopRanks.get(stop.stopId);
			if (rank === undefined) {
				rank = stopIds.length;
				stopIds.push(stop.stopId);
				stopRanks.set(stop.stopId, rank);
			}
			stopSequences[row] = stop.stopSequence;
			stopIndexes[row] = rank;
			distances[row] = stop.distance;
			arrivals[row] = Number.isFinite(stop.arrival) ? stop.arrival : NO_ARRIVAL;
			row += 1;
		}
	}
	offsets[tripIds.length] = row;

	return { tripIds, offsets, stopSequences, stopIndexes, stopIds, distances, arrivals };
}

export function packShapes(shapes: ReadonlyMap<string, ShapePoint[]>): PackedShapes {
	let total = 0;
	for (const points of shapes.values()) total += points.length;

	const shapeIds: string[] = [];
	const offsets = new Int32Array(shapes.size + 1);
	const latitudes = new Float64Array(total);
	const longitudes = new Float64Array(total);
	const distances = new Float64Array(total);

	let row = 0;
	for (const [shapeId, points] of shapes) {
		offsets[shapeIds.length] = row;
		shapeIds.push(shapeId);
		for (const point of points) {
			latitudes[row] = point.latitude;
			longitudes[row] = point.longitude;
			distances[row] = point.distance;
			row += 1;
		}
	}
	offsets[shapeIds.length] = row;

	return { shapeIds, offsets, latitudes, longitudes, distances };
}

/**
 * Les tables reçues d'un autre processus, recopiées : désérialisés, leurs tableaux ne sont que des vues
 * sur le message tout entier, qu'ils retiendraient en mémoire — plus de 200 Mo — tant qu'ils servent.
 */
export function detachTables({ schedules, shapes }: PackedTables): PackedTables {
	return {
		schedules: {
			...schedules,
			offsets: schedules.offsets.slice(),
			stopSequences: schedules.stopSequences.slice(),
			stopIndexes: schedules.stopIndexes.slice(),
			distances: schedules.distances.slice(),
			arrivals: schedules.arrivals.slice(),
		},
		shapes: {
			...shapes,
			offsets: shapes.offsets.slice(),
			latitudes: shapes.latitudes.slice(),
			longitudes: shapes.longitudes.slice(),
			distances: shapes.distances.slice(),
		},
	};
}

/**
 * Les horaires théoriques, consultés comme une `Map` : chaque lecture reconstitue l'horaire de la
 * course. Il n'y a rien à mettre en cache — une lecture coûte quelques dizaines d'objets, et les
 * courses lues d'un relevé à l'autre sont des milliers.
 */
export class ScheduleTable implements Lookup<string, TripStop[]> {
	readonly #packed: PackedSchedules;
	readonly #ranks = new Map<string, number>();

	constructor(packed: PackedSchedules) {
		this.#packed = packed;
		packed.tripIds.forEach((tripId, rank) => {
			this.#ranks.set(tripId, rank);
		});
	}

	get size(): number {
		return this.#ranks.size;
	}

	has(tripId: string): boolean {
		return this.#ranks.has(tripId);
	}

	get(tripId: string): TripStop[] | undefined {
		const rank = this.#ranks.get(tripId);
		if (rank === undefined) return undefined;

		const { offsets, stopSequences, stopIndexes, stopIds, distances, arrivals } = this.#packed;
		const from = offsets[rank] as number;
		const to = offsets[rank + 1] as number;
		const stops: TripStop[] = new Array(to - from);
		for (let row = from; row < to; row += 1) {
			const arrival = arrivals[row] as number;
			stops[row - from] = {
				stopSequence: stopSequences[row] as number,
				stopId: stopIds[stopIndexes[row] as number] as string,
				distance: distances[row] as number,
				arrival: arrival === NO_ARRIVAL ? Number.NaN : arrival,
			};
		}
		return stops;
	}
}

/** Nombre de tracés reconstitués que {@link ShapeTable} garde sous la main. */
const SHAPE_CACHE_SIZE = 256;

/**
 * Les tracés, consultés comme une `Map`. Les mêmes reviennent d'une reconstruction des déviations à
 * l'autre, et un tracé compte des centaines de points : les derniers lus restent sous la main. Ce
 * qu'elle rend se lit sans se modifier — c'est le même tableau d'une lecture à l'autre.
 */
export class ShapeTable implements Lookup<string, ShapePoint[]> {
	readonly #packed: PackedShapes;
	readonly #ranks = new Map<string, number>();
	readonly #cache = new Map<string, ShapePoint[]>();

	constructor(packed: PackedShapes) {
		this.#packed = packed;
		packed.shapeIds.forEach((shapeId, rank) => {
			this.#ranks.set(shapeId, rank);
		});
	}

	get size(): number {
		return this.#ranks.size;
	}

	has(shapeId: string): boolean {
		return this.#ranks.has(shapeId);
	}

	get(shapeId: string): ShapePoint[] | undefined {
		const cached = this.#cache.get(shapeId);
		if (cached !== undefined) {
			// Relu : il repasse en tête de l'ordre d'éviction.
			this.#cache.delete(shapeId);
			this.#cache.set(shapeId, cached);
			return cached;
		}

		const rank = this.#ranks.get(shapeId);
		if (rank === undefined) return undefined;

		const { offsets, latitudes, longitudes, distances } = this.#packed;
		const from = offsets[rank] as number;
		const to = offsets[rank + 1] as number;
		const points: ShapePoint[] = new Array(to - from);
		for (let row = from; row < to; row += 1) {
			points[row - from] = {
				latitude: latitudes[row] as number,
				longitude: longitudes[row] as number,
				distance: distances[row] as number,
			};
		}

		this.#cache.set(shapeId, points);
		if (this.#cache.size > SHAPE_CACHE_SIZE) {
			const oldest = this.#cache.keys().next().value;
			if (oldest !== undefined) this.#cache.delete(oldest);
		}
		return points;
	}
}
