import GtfsRealtime from "gtfs-realtime-bindings";

import {
	GTFS_CHECK_INTERVAL,
	PYSAE_API_URL,
	PYSAE_REFRESH_INTERVAL,
	PYSAE_RETENTION,
	type PysaeFeedConfig,
} from "../config.js";
import { type ServiceDay, serviceDay } from "../gtfs-rt/scheduled-trips.js";
import type { StaticGtfs } from "../gtfs-rt/use-static-gtfs.js";
import type { RealtimeSnapshot } from "../types.js";
import { tripEntityId, vehicleEntityId } from "../utils/entity-ids.js";
import { type MatchedSegment, matchCourse, tclRoutesNamed, tripsOf } from "./match-course.js";
import { fetchPysaeGtfs, type PysaeGtfs, type PysaeTrip } from "./static-gtfs.js";

type FeedMessage = GtfsRealtime.transit_realtime.IFeedMessage;
type TripDescriptor = GtfsRealtime.transit_realtime.ITripDescriptor;
type TripUpdate = GtfsRealtime.transit_realtime.ITripUpdate;
type StopTimeEvent = GtfsRealtime.transit_realtime.TripUpdate.IStopTimeEvent;
type StopTimeUpdate = GtfsRealtime.transit_realtime.TripUpdate.IStopTimeUpdate;
type VehicleDescriptor = GtfsRealtime.transit_realtime.IVehicleDescriptor;
type VehiclePosition = GtfsRealtime.transit_realtime.IVehiclePosition;

type TripRelationship = GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship;

const CANCELED = GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED;
const SCHEDULED = GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.SCHEDULED;
const STOP_SCHEDULED = GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SCHEDULED;

const TIME_ZONE = "Europe/Paris";

/** Délai au-delà duquel une requête à Pysae est abandonnée : le relevé suivant la retentera. */
const FETCH_TIMEOUT = 20_000;

/** Une entité publiée, et l'instant — en secondes epoch — à partir duquel elle ne l'est plus. */
type Expiring<T> = { value: T; expiresAt: number };

type FeedState = {
	config: PysaeFeedConfig;
	gtfs: PysaeGtfs | null;
	signature: string | null;
	checkedAt: number;
	tripUpdates: Map<string, Expiring<TripUpdate>>;
	vehiclePositions: Map<string, Expiring<VehiclePosition>>;
	/**
	 * Les courses de TCL déjà retrouvées, par « <trip_id Pysae>|<journée> » (cf. `matchCourse`). Elles ne
	 * dépendent que des deux GTFS : on les garde tant qu'aucun ne change et que la course reste au feed.
	 */
	matches: Map<string, MatchedSegment[]>;
	matchedAgainst: { pysae: PysaeGtfs; tcl: StaticGtfs } | null;
};

/**
 * Le temps réel des lignes sous-traitées à Cars Faure, que Pysae suit (cf. `PYSAE_FEEDS`), traduit
 * dans les identifiants de TCL pour se fondre dans le reste du feed.
 *
 * Chaque groupe est relevé toutes les dix secondes (cf. {@link PYSAE_REFRESH_INTERVAL}). Ses courses
 * sont retrouvées dans le GTFS de TCL — une course Pysae peut en recouvrir deux —, leurs arrêts
 * renumérotés d'après lui ; ce qui ne s'y retrouve pas est écarté. Ses véhicules sont nommés comme
 * ceux de SIRI Lite, « <opérateur>:<numéro de parc> », et ne se publient qu'en course.
 *
 * Un relevé en échec garde le précédent, qui vieillit comme le reste (cf. {@link PYSAE_RETENTION}).
 * `onUpdate` suit chaque relevé.
 */
export function usePysaeFeeds(
	feeds: readonly PysaeFeedConfig[],
	staticGtfs: { readonly data: StaticGtfs },
	onUpdate: () => void,
) {
	const states: FeedState[] = feeds.map((config) => ({
		config,
		gtfs: null,
		signature: null,
		checkedAt: 0,
		tripUpdates: new Map(),
		vehiclePositions: new Map(),
		matches: new Map(),
		matchedAgainst: null,
	}));

	async function loop() {
		const startedAt = Date.now();
		await Promise.all(states.map((state) => poll(state, staticGtfs.data)));
		onUpdate();
		setTimeout(loop, Math.max(PYSAE_REFRESH_INTERVAL - (Date.now() - startedAt), 1_000));
	}
	void loop();

	return {
		/**
		 * Ce qui vaut encore à `nowSeconds`, tous groupes confondus. Une course ou un véhicule que deux
		 * entités se disputent revient à la plus récente.
		 */
		snapshot(nowSeconds: number): RealtimeSnapshot {
			const tripUpdates = new Map<string, Expiring<TripUpdate>>();
			const vehiclePositions = new Map<string, Expiring<VehiclePosition>>();
			for (const state of states) {
				for (const [id, entry] of state.tripUpdates) if (entry.expiresAt >= nowSeconds) keep(tripUpdates, id, entry);
				for (const [id, entry] of state.vehiclePositions)
					if (entry.expiresAt >= nowSeconds) keep(vehiclePositions, id, entry);
			}
			return { tripUpdates: unwrap(tripUpdates), vehiclePositions: unwrap(vehiclePositions) };
		},
	};
}

/**
 * Le temps réel de SIRI Lite, complété de celui de Pysae. Une course que Pysae suit lui revient : SIRI
 * Lite n'en a que l'horaire théorique. Un véhicule que les deux suivraient revient de même à Pysae.
 */
export function mergeRealtime(siri: RealtimeSnapshot, pysae: RealtimeSnapshot): RealtimeSnapshot {
	const claimed = new Set([...pysae.tripUpdates.values()].map((tripUpdate) => tripUpdate.trip?.tripId));
	const tripUpdates = new Map([...siri.tripUpdates].filter(([, tripUpdate]) => !claimed.has(tripUpdate.trip?.tripId)));
	for (const [id, tripUpdate] of pysae.tripUpdates) tripUpdates.set(id, tripUpdate);

	return { tripUpdates, vehiclePositions: new Map([...siri.vehiclePositions, ...pysae.vehiclePositions]) };
}

async function poll(state: FeedState, tcl: StaticGtfs) {
	const { group } = state.config;
	try {
		if (state.gtfs === null || Date.now() - state.checkedAt >= GTFS_CHECK_INTERVAL) await refreshGtfs(state);
		if (state.gtfs === null) return;
		// Sans le GTFS de TCL, rien ne s'y retrouve : autant attendre qu'il soit là.
		if (tcl.trips.size === 0) return;

		const response = await fetch(`${PYSAE_API_URL}/${group}/gtfs-rt`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const message = GtfsRealtime.transit_realtime.FeedMessage.decode(new Uint8Array(await response.arrayBuffer()));
		// En objets simples, les entiers 64 bits en nombres : ce qui en sort se publie tel quel.
		const feed = GtfsRealtime.transit_realtime.FeedMessage.toObject(message, { longs: Number }) as FeedMessage;
		remap(state, state.gtfs, feed, tcl);
	} catch (cause) {
		console.error(`✘ Unable to update Pysae ${group}, keeping the previous snapshot.`, cause);
	}
}

async function refreshGtfs(state: FeedState) {
	const { group } = state.config;
	const result = await fetchPysaeGtfs(
		`${PYSAE_API_URL}/${group}/gtfs/pub`,
		state.gtfs === null ? null : state.signature,
	);
	state.checkedAt = Date.now();
	if (result === undefined || result === "unchanged") return;

	state.gtfs = result.gtfs;
	state.signature = result.signature;
	console.log(`✓ Pysae ${group}: loaded ${result.gtfs.trips.size} trips from GTFS.`);
}

/** Une course Pysae rapportée au GTFS de TCL : sa journée de service, et ce qui la couvre chez TCL. */
type ResolvedTrip = { date: string; midnight: number; pysaeTrip: PysaeTrip | undefined; segments: MatchedSegment[] };

/**
 * Traduit un relevé de Pysae — un feed complet, qui remplace le précédent — dans les identifiants de
 * TCL : courses, arrêts et véhicules.
 */
function remap(state: FeedState, pysae: PysaeGtfs, feed: FeedMessage, tcl: StaticGtfs) {
	const { group, operator, routeAliases } = state.config;
	if (state.matchedAgainst?.pysae !== pysae || state.matchedAgainst.tcl !== tcl) {
		state.matches = new Map();
		state.matchedAgainst = { pysae, tcl };
	}

	const matches = new Map<string, MatchedSegment[]>();
	const days = new Map<string, ServiceDay>();
	let unmatched = 0;

	const resolve = (trip: TripDescriptor | null | undefined): ResolvedTrip | undefined => {
		const tripId = trip?.tripId;
		if (!tripId) return undefined;

		// Pysae date ses courses ; faute de quoi, c'est la journée en cours.
		const date = trip.startDate && /^\d{8}$/.test(trip.startDate) ? trip.startDate : today();
		let day = days.get(date);
		if (day === undefined) {
			day = serviceDay(tcl, Temporal.PlainDate.from(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`));
			days.set(date, day);
		}

		const pysaeTrip = pysae.trips.get(tripId);
		const key = `${tripId}|${date}`;
		let segments = matches.get(key) ?? state.matches.get(key);
		if (segments === undefined) {
			const routes = tclRoutesNamed(tcl, routeNameOf(pysae, pysaeTrip?.routeId ?? trip.routeId), routeAliases);
			segments =
				pysaeTrip === undefined ? [] : matchCourse(tcl, pysaeTrip.stops, tripsOf(tcl, routes, day.services), tripId);
			if (segments.length === 0) console.warn(`⚠ Pysae ${group}: trip ${tripId} (${date}) not found in the TCL GTFS.`);
		}
		matches.set(key, segments);
		return { date, midnight: day.midnight, pysaeTrip, segments };
	};

	const tripUpdates = new Map<string, Expiring<TripUpdate>>();
	let received = 0;
	for (const entity of feed.entity ?? []) {
		const source = entity.tripUpdate;
		if (!source) continue;
		received += 1;

		const resolved = resolve(source.trip);
		if (resolved === undefined || resolved.segments.length === 0) {
			unmatched += 1;
			continue;
		}
		const cancelled = source.trip?.scheduleRelationship === CANCELED;

		for (const segment of resolved.segments) {
			const stopTimeUpdate = cancelled
				? []
				: (source.stopTimeUpdate ?? []).flatMap((update) => remapStopTimeUpdate(update, resolved.pysaeTrip, segment));
			if (!cancelled && stopTimeUpdate.length === 0) continue;

			const lastTime = Math.max(
				...stopTimeUpdate.map((update) => Number(update.departure?.time ?? update.arrival?.time ?? 0)),
			);
			// Annulée, elle ne dit plus rien de ses passages : c'est son arrivée théorique qui la fait expirer.
			const endsAt = lastTime > 0 ? lastTime : resolved.midnight + (tcl.tripArrivals.get(segment.tripId) ?? Number.NaN);
			if (!Number.isFinite(endsAt)) continue;

			keep(tripUpdates, tripEntityId(segment.tripId, resolved.date), {
				value: {
					trip: tripDescriptor(tcl, segment.tripId, resolved.date, cancelled ? CANCELED : SCHEDULED),
					stopTimeUpdate,
					timestamp: source.timestamp,
					vehicle: vehicleDescriptor(operator, source.vehicle),
				},
				expiresAt: endsAt + PYSAE_RETENTION,
			});
		}
	}

	const vehiclePositions = new Map<string, Expiring<VehiclePosition>>();
	for (const entity of feed.entity ?? []) {
		const source = entity.vehicle;
		const vehicle = vehicleDescriptor(operator, source?.vehicle);
		if (!source?.position || !vehicle?.id || !source.timestamp) continue;

		const resolved = resolve(source.trip);
		const sequence =
			source.currentStopSequence ??
			resolved?.pysaeTrip?.stops.find(({ stopId }) => stopId === source.stopId)?.stopSequence;
		const segment = segmentAt(resolved?.segments ?? [], sequence);
		const stop = segment !== undefined && sequence != null ? segment.stops.get(sequence) : undefined;

		// Pysae laisse un véhicule sur sa dernière course tant qu'il n'en commence pas une autre, fût-il
		// rentré au dépôt : il ne se publie que tant que cette course vaut — tous tronçons confondus —,
		// comme dans SIRI Lite, qui ne connaît que les véhicules en course.
		let trip: TripDescriptor | undefined;
		let tripExpiresAt = Number.NaN;
		if (segment !== undefined && resolved !== undefined) {
			trip = tripDescriptor(tcl, segment.tripId, resolved.date, SCHEDULED);
			tripExpiresAt = Math.max(
				...resolved.segments
					.map(
						({ tripId }) =>
							tripUpdates.get(tripEntityId(tripId, resolved.date))?.expiresAt ??
							resolved.midnight + (tcl.tripArrivals.get(tripId) ?? Number.NaN) + PYSAE_RETENTION,
					)
					.filter(Number.isFinite),
			);
		} else {
			// Course introuvable : la ligne, si elle ne fait aucun doute, vaut mieux que rien.
			const routes = tclRoutesNamed(tcl, routeNameOf(pysae, source.trip?.routeId), routeAliases);
			if (routes.length === 1) trip = { routeId: routes[0] };
			const terminus = resolved?.pysaeTrip?.stops.at(-1);
			if (resolved !== undefined && terminus !== undefined)
				tripExpiresAt =
					resolved.midnight +
					(Number.isFinite(terminus.arrival) ? terminus.arrival : terminus.departure) +
					PYSAE_RETENTION;
		}
		if (trip === undefined || !Number.isFinite(tripExpiresAt)) continue;

		keep(vehiclePositions, vehicleEntityId(vehicle.id), {
			value: {
				trip,
				position: source.position,
				currentStopSequence: stop?.stopSequence,
				stopId: stop?.stopId,
				currentStatus: stop !== undefined ? source.currentStatus : undefined,
				timestamp: source.timestamp,
				congestionLevel: source.congestionLevel,
				occupancyStatus: source.occupancyStatus,
				vehicle,
			},
			expiresAt: Math.min(Number(source.timestamp) + PYSAE_RETENTION, tripExpiresAt),
		});
	}

	state.matches = matches;
	state.tripUpdates = tripUpdates;
	state.vehiclePositions = vehiclePositions;
	const nowSeconds = Math.floor(Date.now() / 1000);
	const current = (entries: Map<string, Expiring<unknown>>) =>
		[...entries.values()].filter(({ expiresAt }) => expiresAt >= nowSeconds).length;
	console.log(
		`\t• Pysae ${group}: ${received} trip updates (${unmatched} not found in the TCL GTFS), ${current(tripUpdates)} TCL trips and ${current(vehiclePositions)} vehicles currently published.`,
	);
}

/**
 * Un passage annoncé par Pysae, rapporté à l'arrêt de TCL qui lui correspond dans ce tronçon. Pysae
 * donne des instants, jamais d'avance ni de retard : ce serait sur son horaire, pas sur celui de TCL.
 */
function remapStopTimeUpdate(
	update: StopTimeUpdate,
	pysaeTrip: PysaeTrip | undefined,
	segment: MatchedSegment,
): StopTimeUpdate[] {
	const sequence = update.stopSequence ?? pysaeTrip?.stops.find(({ stopId }) => stopId === update.stopId)?.stopSequence;
	const stop = sequence == null ? undefined : segment.stops.get(sequence);
	if (stop === undefined) return [];

	const arrival = stopTimeEvent(update.arrival);
	const departure = stopTimeEvent(update.departure);
	const relationship = update.scheduleRelationship ?? STOP_SCHEDULED;
	// Un arrêt desservi sans horaire n'apprend rien.
	if (arrival === undefined && departure === undefined && relationship === STOP_SCHEDULED) return [];

	return [
		{ stopSequence: stop.stopSequence, stopId: stop.stopId, arrival, departure, scheduleRelationship: relationship },
	];
}

function stopTimeEvent(event: StopTimeEvent | null | undefined): StopTimeEvent | undefined {
	if (!event?.time) return undefined;
	return event.uncertainty == null ? { time: event.time } : { time: event.time, uncertainty: event.uncertainty };
}

function tripDescriptor(tcl: StaticGtfs, tripId: string, date: string, relationship: TripRelationship): TripDescriptor {
	const meta = tcl.trips.get(tripId);
	return {
		tripId,
		routeId: meta?.routeId,
		directionId: meta?.directionId,
		startDate: date,
		scheduleRelationship: relationship,
	};
}

/** Le véhicule sous son identifiant de TCL : « CARS_FAURE:9803 », d'après son numéro de parc. */
function vehicleDescriptor(
	operator: string,
	vehicle: VehicleDescriptor | null | undefined,
): VehicleDescriptor | undefined {
	if (!vehicle) return undefined;

	const number = vehicle.label ?? `UNKNOWN_${vehicle.id}`;
	const id = `${operator}:${number}`;
	return vehicle?.licensePlate ? { id, label: id, licensePlate: vehicle.licensePlate } : { id, label: id };
}

/** Le tronçon où se trouve l'arrêt Pysae `sequence` : celui qui l'encadre, sinon le premier. */
function segmentAt(segments: readonly MatchedSegment[], sequence: number | null | undefined) {
	if (sequence != null) {
		for (const segment of segments) {
			const sequences = [...segment.stops.keys()];
			if (sequence >= Math.min(...sequences) && sequence <= Math.max(...sequences)) return segment;
		}
	}
	return segments[0];
}

function routeNameOf(pysae: PysaeGtfs, routeId: string | null | undefined): string {
	return routeId ? (pysae.routeNames.get(routeId) ?? routeId) : "";
}

function today(): string {
	return Temporal.Now.plainDateISO(TIME_ZONE).toString().replaceAll("-", "");
}

/** Range l'entrée sous `id`, à moins qu'une plus récente n'y soit déjà. */
function keep<T extends { timestamp?: unknown }>(entries: Map<string, Expiring<T>>, id: string, entry: Expiring<T>) {
	const current = entries.get(id);
	if (current === undefined || Number(entry.value.timestamp ?? 0) > Number(current.value.timestamp ?? 0))
		entries.set(id, entry);
}

function unwrap<T>(entries: Map<string, Expiring<T>>): Map<string, T> {
	return new Map([...entries].map(([id, { value }]) => [id, value]));
}
