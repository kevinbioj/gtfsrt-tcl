import type { DetailPatternDto, ModificationDetailDto, ModificationInputDto, SegmentDto, SequenceStopDto } from "@dto";

import { type TripSetForm, tripSetKey } from "@/components/trip-sets";
import { type LatLng, lengthOf, project } from "@/lib/geometry";
import { decodePolyline } from "@/lib/polyline";

/** Une jambe du tracé : le trajet entre deux points de passage, routé par le serveur ou tiré droit. */
export type Leg = { points: LatLng[]; status: "ok" | "pending" | "failed"; token: number; message: string };

/** Un point de passage, et le mode de la jambe qui le SUIT. */
export type Waypoint = { point: LatLng; mode: "route" | "free" };

/** Un arrêt de remplacement : ce qu'il est, pour l'affichage, et le temps pour l'atteindre. */
export type ReplacementStop = {
	stopId: string;
	name: string;
	latitude: number | null;
	longitude: number | null;
	provisional: boolean;
	travelTime: number;
};

export type Terminus = "start" | "end" | null;

/** Un tronçon tel que l'éditeur le manipule. */
export type SegmentState = {
	key: string;
	startStopId: string | null;
	endStopId: string | null;
	/** La plage des bornes est-elle supprimée, ou le chemin seul change-t-il entre deux arrêts desservis ? */
	removes: boolean;
	/** Les bornes ont-elles été choisies à la main ? Sinon, elles suivent le dessin. */
	boundsOverridden: boolean;
	propagatedDelay: number;
	terminus: Terminus;
	stops: ReplacementStop[];
	waypoints: Waypoint[];
	legs: Leg[];
	/** Ce que le serveur dit du tronçon enregistré — rien pour un tronçon neuf. */
	saved: Pick<SegmentDto, "publishable" | "overriddenOn"> | null;
};

/** Tout ce que l'éditeur tient d'une modification jusqu'à l'enregistrement. */
export type EditorState = {
	description: string;
	priority: number;
	/** Les tracés cochés, explicitement : aucun coché ne s'enregistre pas. */
	patternIds: string[];
	/** Les arrêts supprimés qu'aucun tronçon ne couvre : une saisie plus ancienne, gardée telle quelle. */
	extraRemoved: string[];
	segments: SegmentState[];
	active: number;
	/** Les courses qu'elle annule, sur sa ligne et dans son sens. */
	tripSets: TripSetForm[];
};

let sequence = 0;
const nextKey = () => `segment${++sequence}`;
let tokens = 0;
/** Un jeton de requête : une réponse qui ne porte plus le dernier jeton de sa jambe est périmée. */
export const nextToken = () => ++tokens;

export const newLeg = (points: LatLng[] = []): Leg => ({ points, status: "ok", token: 0, message: "" });

export function emptySegment(): SegmentState {
	return {
		key: nextKey(),
		startStopId: null,
		endStopId: null,
		removes: true,
		boundsOverridden: false,
		propagatedDelay: 0,
		terminus: null,
		stops: [],
		waypoints: [],
		legs: [],
		saved: null,
	};
}

const samePoint = (a: LatLng, b: LatLng) => a[0] === b[0] && a[1] === b[1];

/**
 * Redécoupe en jambes le tracé enregistré : les frontières se retrouvent en suivant le tracé et en y
 * reconnaissant, dans l'ordre, chaque point de passage. Si la lecture ne retombe pas sur ses pieds, le
 * tracé reste TEL QUEL, chaque point devenu un point de passage en ligne droite — le trajet publié
 * n'est pas touché d'un pouce.
 */
function adoptDrawing(path: LatLng[], waypoints: Waypoint[]): { waypoints: Waypoint[]; legs: Leg[] } {
	if (path.length >= 2 && waypoints.length >= 2 && samePoint(path[0] as LatLng, (waypoints[0] as Waypoint).point)) {
		const legs: Leg[] = [];
		let points: LatLng[] = [path[0] as LatLng];
		let next = 1;
		for (let index = 1; index < path.length; index += 1) {
			const point = path[index] as LatLng;
			points.push(point);
			const waypoint = waypoints[next];
			if (waypoint !== undefined && samePoint(point, waypoint.point)) {
				legs.push(newLeg(points));
				points = [point];
				next += 1;
			}
		}
		if (next === waypoints.length && legs.length === waypoints.length - 1) return { waypoints, legs };
	}
	const straight = path.length >= 2 ? path.map((point) => ({ point, mode: "free" as const })) : [];
	return { waypoints: straight, legs: straightLegs(straight) };
}

/** Une jambe droite entre chaque point de passage. */
export function straightLegs(waypoints: readonly Waypoint[]): Leg[] {
	const legs: Leg[] = [];
	for (let index = 0; index + 1 < waypoints.length; index += 1) {
		legs.push(newLeg([(waypoints[index] as Waypoint).point, (waypoints[index + 1] as Waypoint).point]));
	}
	return legs;
}

/** Le tracé aplati d'un tronçon : ses jambes bout à bout, chaque raccord compté une fois. */
export function pathOf(segment: Pick<SegmentState, "legs" | "waypoints">): LatLng[] {
	if (segment.waypoints.length < 2) return [];
	const path: LatLng[] = [];
	segment.legs.forEach((leg, index) => {
		for (let point = index === 0 ? 0 : 1; point < leg.points.length; point += 1) path.push(leg.points[point] as LatLng);
	});
	return path;
}

/** L'état de l'éditeur pour une modification enregistrée. */
export function stateOf(detail: ModificationDetailDto, geometry: Geometry): EditorState {
	const checked =
		detail.patternIds.length === 0 ? detail.patterns.map((pattern) => pattern.patternId) : detail.patternIds;
	const patterns = detail.patterns.filter((pattern) => checked.includes(pattern.patternId));
	const removed = new Set(detail.removedStopIds);

	const segments = detail.segments.map((segment): SegmentState => {
		const path = segment.path.map((point): LatLng => [point.latitude, point.longitude]);
		const drawing = adoptDrawing(
			path,
			segment.waypoints.map((waypoint) => ({ point: [waypoint.latitude, waypoint.longitude], mode: waypoint.mode })),
		);
		const state: SegmentState = {
			key: nextKey(),
			startStopId: segment.startStopId,
			endStopId: segment.endStopId,
			removes: segment.startStopId !== null && removed.has(segment.startStopId),
			boundsOverridden: false,
			propagatedDelay: segment.propagatedDelay,
			terminus: segment.terminus,
			stops: segment.stops.map(({ stopId, name, latitude, longitude, provisional, travelTime }) => ({
				stopId,
				name,
				latitude,
				longitude,
				provisional,
				travelTime,
			})),
			...drawing,
			saved: { publishable: segment.publishable, overriddenOn: segment.overriddenOn },
		};
		// Des bornes que le dessin ne redonne pas ont été choisies à la main : elles restent.
		const derived = deriveBounds(state, patterns, geometry);
		state.boundsOverridden =
			segment.startStopId !== null &&
			(derived === null ||
				derived.startStopId !== segment.startStopId ||
				derived.endStopId !== segment.endStopId ||
				derived.removes !== state.removes);
		return state;
	});

	const covered = new Set(segments.flatMap((segment) => (segment.removes ? rangeStops(segment, patterns) : [])));
	return {
		description: detail.description ?? "",
		priority: detail.priority,
		patternIds: checked,
		extraRemoved: detail.removedStopIds.filter((stopId) => !covered.has(stopId)),
		segments: segments.length > 0 ? segments : [emptySegment()],
		active: 0,
		tripSets: detail.tripSets.map((set) => ({ ...set, key: tripSetKey() })),
	};
}

/** Les shapes du sens, décodées une fois pour toutes. */
export type Geometry = Map<string, LatLng[]>;

export function geometryOf(detail: ModificationDetailDto): Geometry {
	return new Map(detail.shapes.map((shape) => [shape.shapeId, decodePolyline(shape.encodedPolyline)]));
}

/** En deçà, un point du dessin est posé sur le tracé nominal : c'est une jonction. */
export const JUNCTION_TOLERANCE = 40;

/** Ce que le dessin d'un tronçon dit de lui, rapporté au tracé principal. */
export type Reading = {
	shape: LatLng[];
	/**
	 * Abscisses curvilignes, en mètres, d'où le dessin quitte le nominal et où il le rejoint. Tant
	 * qu'il ne l'a pas rejoint, les deux valent le point de départ.
	 */
	leaves: number;
	joins: number;
	leavesOnRoute: boolean;
	/** Le dessin est-il revenu sur le nominal — ou, pour une nouvelle fin, s'achève-t-il ? */
	joinsOnRoute: boolean;
	/** Les arrêts du tracé principal, chacun à son abscisse. */
	stops: (SequenceStopDto & { along: number })[];
};

/**
 * Lit le dessin d'un tronçon sur le premier tracé coché — le plus long : où il quitte l'itinéraire,
 * où il le rejoint. Un tracé qui ouvre la course part de son début ; qui la ferme, va jusqu'à sa fin.
 * Il se lit dès le premier point posé : l'arrêt de début se devine avant que le dessin soit fini.
 */
export function readSegment(
	segment: Pick<SegmentState, "legs" | "waypoints" | "terminus">,
	patterns: readonly DetailPatternDto[],
	geometry: Geometry,
): Reading | null {
	const pattern = patterns[0];
	const shape = pattern === undefined ? undefined : geometry.get(pattern.shapeId);
	const path = segment.waypoints.length === 1 ? [(segment.waypoints[0] as Waypoint).point] : pathOf(segment);
	if (pattern === undefined || shape === undefined || path.length === 0) return null;

	const first = project(shape, path[0] as LatLng);
	const last = project(shape, path.at(-1) as LatLng);
	const stops = pattern.sequence.flatMap((stop) =>
		stop.latitude === null || stop.longitude === null
			? []
			: [{ ...stop, along: project(shape, [stop.latitude, stop.longitude]).along }],
	);
	const leavesOnRoute = segment.terminus === "start" || first.offset <= JUNCTION_TOLERANCE;
	const joinsOnRoute =
		segment.waypoints.length >= 2 && (segment.terminus === "end" || last.offset <= JUNCTION_TOLERANCE);

	const leaves = segment.terminus === "start" ? 0 : first.along;
	if (!joinsOnRoute) return { shape, leaves, joins: leaves, leavesOnRoute, joinsOnRoute, stops };
	const joins = segment.terminus === "end" ? lengthOf(shape) : last.along;
	return {
		shape,
		leaves: Math.min(leaves, joins),
		joins: Math.max(leaves, joins),
		leavesOnRoute,
		joinsOnRoute,
		stops,
	};
}

/** Un arrêt à moins de cette distance d'une jonction compte comme posé dessus : il reste desservi. */
const STOP_TOLERANCE = 15;

/**
 * Les bornes que le dessin donne. Ce sont, comme le veut `start_stop_selector`, le premier et le dernier
 * arrêt de la zone déviée — supprimés, bornes comprises. Un nouveau début évite le départ de la course,
 * une nouvelle fin son terminus : ils en font partie.
 *
 * Dès que le dessin a quitté l'itinéraire, l'arrêt de début se devine : le premier qui suit le point de
 * départ. Le reste attend que le dessin revienne.
 *
 * Une déviation qui ne contourne aucun arrêt ne change que le chemin : ses bornes sont alors les deux
 * arrêts desservis qui l'encadrent, et rien n'est supprimé.
 */
export function deriveBounds(
	segment: Pick<SegmentState, "legs" | "waypoints" | "terminus">,
	patterns: readonly DetailPatternDto[],
	geometry: Geometry,
): Partial<Pick<SegmentState, "startStopId" | "endStopId" | "removes">> | null {
	const reading = readSegment(segment, patterns, geometry);
	if (reading === null || !reading.leavesOnRoute) return null;
	const { leaves, joins, stops } = reading;
	const afterStart = (stop: { along: number }) => segment.terminus === "start" || stop.along > leaves + STOP_TOLERANCE;
	const beforeEnd = (stop: { along: number }) => segment.terminus === "end" || stop.along < joins - STOP_TOLERANCE;

	if (!reading.joinsOnRoute) {
		const first = stops.find(afterStart);
		return first === undefined ? null : { startStopId: first.stopId, removes: true };
	}

	const skipped = stops.filter((stop) => afterStart(stop) && beforeEnd(stop));
	if (skipped.length > 0) {
		return {
			startStopId: (skipped[0] as SequenceStopDto).stopId,
			endStopId: (skipped.at(-1) as SequenceStopDto).stopId,
			removes: true,
		};
	}
	const before = stops.filter((stop) => stop.along <= leaves + STOP_TOLERANCE).at(-1);
	const after = stops.find((stop) => stop.along >= joins - STOP_TOLERANCE);
	return { startStopId: before?.stopId ?? null, endStopId: after?.stopId ?? null, removes: false };
}

/** Les rangs des bornes d'un tronçon dans une suite d'arrêts, ou `undefined` (cf. `rangeOn` côté serveur). */
export function rangeOn(
	sequence: readonly { stopId: string }[],
	segment: Pick<SegmentState, "startStopId" | "endStopId">,
) {
	if (segment.startStopId === null) return undefined;
	const start = sequence.findIndex((stop) => stop.stopId === segment.startStopId);
	const end =
		segment.endStopId === null ? sequence.length - 1 : sequence.findIndex((stop) => stop.stopId === segment.endStopId);
	return start === -1 || end === -1 || start > end ? undefined : { start, end };
}

/** Les arrêts de la plage d'un tronçon, sur tous les tracés cochés qui la portent. */
export function rangeStops(
	segment: Pick<SegmentState, "startStopId" | "endStopId">,
	patterns: readonly DetailPatternDto[],
): string[] {
	const stops = new Set<string>();
	for (const pattern of patterns) {
		const range = rangeOn(pattern.sequence, segment);
		if (range === undefined) continue;
		for (const stop of pattern.sequence.slice(range.start, range.end + 1)) stops.add(stop.stopId);
	}
	return [...stops];
}

/**
 * L'arrêt d'où se comptent les temps de parcours : celui qui précède la borne amont sur le premier des
 * tracés cochés qui la dessert. `null` lorsque la borne ouvre l'itinéraire — les temps se comptent
 * alors depuis le premier arrêt de la course.
 */
export function referenceOf(
	segment: Pick<SegmentState, "startStopId">,
	patterns: readonly DetailPatternDto[],
): SequenceStopDto | null {
	for (const pattern of patterns) {
		const index = pattern.sequence.findIndex((stop) => stop.stopId === segment.startStopId);
		if (index === -1) continue;
		return index === 0 ? null : (pattern.sequence[index - 1] as SequenceStopDto);
	}
	return null;
}

/**
 * Le temps de parcours nominal de la zone déviée : de l'arrêt de référence à l'arrêt qui suit la borne
 * de fin — l'arrêt de fin + 1, le premier que la course retrouve —, d'après l'horaire théorique du
 * premier tracé coché qui porte les deux bornes. De quoi juger des temps des arrêts de remplacement.
 * `null` sans borne de fin, quand elle termine la course, ou quand l'horaire se tait.
 */
export function nominalTravel(
	segment: Pick<SegmentState, "startStopId" | "endStopId">,
	patterns: readonly DetailPatternDto[],
): { from: SequenceStopDto; to: SequenceStopDto; seconds: number } | null {
	for (const pattern of patterns) {
		const range = rangeOn(pattern.sequence, segment);
		if (range === undefined || segment.endStopId === null) continue;
		const from = pattern.sequence[range.start === 0 ? 0 : range.start - 1] as SequenceStopDto;
		const to = pattern.sequence[range.end + 1];
		if (to === undefined || from.offset === null || to.offset === null) return null;
		return { from, to, seconds: to.offset - from.offset };
	}
	return null;
}

/** Les arrêts du sens, tracés confondus, sans doublon, dans l'ordre où ils se rencontrent. */
export function routeStops(patterns: readonly DetailPatternDto[]): SequenceStopDto[] {
	const seen = new Set<string>();
	const stops: SequenceStopDto[] = [];
	for (const pattern of patterns) {
		for (const stop of pattern.sequence) {
			if (seen.has(stop.stopId)) continue;
			seen.add(stop.stopId);
			stops.push(stop);
		}
	}
	return stops;
}

/** Ce que l'API reçoit. Un tronçon sans arrêt ni tracé ni borne ne part pas. */
export function inputOf(
	state: EditorState,
	patterns: readonly DetailPatternDto[],
	total: number,
): ModificationInputDto {
	const segments = state.segments.filter(
		(segment) => segment.stops.length > 0 || pathOf(segment).length >= 2 || segment.startStopId !== null,
	);
	const removed = new Set(state.extraRemoved);
	for (const segment of segments) {
		if (segment.removes) for (const stopId of rangeStops(segment, patterns)) removed.add(stopId);
	}
	return {
		description: state.description.trim().length === 0 ? null : state.description.trim(),
		patternIds: state.patternIds.length === total ? [] : state.patternIds,
		removedStopIds: [...removed],
		priority: state.priority,
		segments: segments.map((segment) => {
			const path = pathOf(segment);
			return {
				startStopId: segment.startStopId,
				endStopId: segment.endStopId,
				propagatedDelay: segment.propagatedDelay,
				// Sans tracé, il n'y a pas de bout de course à remplacer.
				terminus: path.length >= 2 ? segment.terminus : null,
				stops: segment.stops.map(({ stopId, travelTime }) => ({ stopId, travelTime })),
				path,
				waypoints: segment.waypoints.length >= 2 ? segment.waypoints.map(({ point, mode }) => ({ point, mode })) : [],
			};
		}),
		tripSets: state.tripSets.map(({ enabled, selection }) => ({ enabled, selection })),
	};
}
