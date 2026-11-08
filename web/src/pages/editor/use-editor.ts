import type { DetailPatternDto, ModificationDetailDto, RouteLegDto } from "@dto";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { type LatLng, project } from "@/lib/geometry";

import {
	deriveBounds,
	type EditorState,
	emptySegment,
	type Geometry,
	type Leg,
	newLeg,
	nextToken,
	type ReplacementStop,
	type SegmentState,
	stateOf,
	straightLegs,
	type Terminus,
	type Waypoint,
} from "./editor-state";

/** Garde-fou : un clic sur un autre tracé coché que le premier ne s'accroche pas au premier s'il en est loin. */
const SNAP_TOLERANCE = 25;

/**
 * L'état de l'éditeur et ce qui le change. Le routage des jambes part au serveur : la réponse peut
 * revenir après qu'on a redéplacé le point, et chaque jambe porte donc un jeton — une réponse dont le
 * jeton n'est plus le bon décrit un tracé qui n'existe plus.
 */
export function useEditor(detail: ModificationDetailDto, geometry: Geometry, initialActive = 0) {
	const [state, setState] = useState<EditorState>(() => {
		const initial = stateOf(detail, geometry);
		return { ...initial, active: Math.min(initialActive, initial.segments.length - 1) };
	});
	const ref = useRef(state);
	ref.current = state;

	const patternsOf = (current: EditorState): DetailPatternDto[] =>
		detail.patterns.filter((pattern) => current.patternIds.includes(pattern.patternId));

	/** Un tronçon dont les bornes suivent le dessin les relit. */
	const withBounds = (segment: SegmentState, current: EditorState): SegmentState => {
		if (segment.boundsOverridden) return segment;
		const derived = deriveBounds(segment, patternsOf(current), geometry);
		return derived === null ? segment : { ...segment, ...derived };
	};

	const commit = (next: EditorState) => {
		ref.current = next;
		setState(next);
	};

	const replaceSegment = (current: EditorState, index: number, segment: SegmentState): EditorState => ({
		...current,
		segments: current.segments.map((entry, rank) => (rank === index ? withBounds(segment, current) : entry)),
	});

	/** Modifie le tronçon actif. */
	const updateActive = (change: (segment: SegmentState) => SegmentState) => {
		const current = ref.current;
		const segment = current.segments[current.active];
		if (segment === undefined) return;
		commit(replaceSegment(current, current.active, change(segment)));
	};

	/** Recalcule des jambes du tronçon actif : droites tout de suite, routées à la réponse du serveur. */
	const resolveLegs = (indices: number[]) => {
		const current = ref.current;
		const rank = current.active;
		const segment = current.segments[rank];
		if (segment === undefined) return;

		const legs = [...segment.legs];
		const requests: { index: number; token: number; from: Waypoint; to: Waypoint }[] = [];
		for (const index of indices) {
			const from = segment.waypoints[index];
			const to = segment.waypoints[index + 1];
			if (from === undefined || to === undefined || legs[index] === undefined) continue;
			const token = nextToken();
			const routed = from.mode === "route";
			legs[index] = { points: [from.point, to.point], status: routed ? "pending" : "ok", token, message: "" };
			if (routed) requests.push({ index, token, from, to });
		}
		commit(replaceSegment(current, rank, { ...segment, legs }));

		for (const request of requests) {
			api<RouteLegDto>("/route", { method: "POST", body: { from: request.from.point, to: request.to.point } })
				.then((result) => settleLeg(segment.key, request.index, request.token, { points: result.path }))
				.catch((error: Error) => {
					settleLeg(segment.key, request.index, request.token, { failed: error.message });
					toast.error(`Jambe ${request.index + 1} : ${error.message}`);
				});
		}
	};

	/**
	 * Une jambe routée revient. Ses deux points de passage rejoignent la chaussée : le serveur a routé
	 * depuis leur projeté sur la rue la plus proche, et c'est lui qui sera publié. Une jambe droite
	 * voisine se retend d'autant.
	 */
	const settleLeg = (key: string, index: number, token: number, outcome: { points: LatLng[] } | { failed: string }) => {
		const current = ref.current;
		const rank = current.segments.findIndex((segment) => segment.key === key);
		const segment = current.segments[rank];
		if (segment === undefined || segment.legs[index]?.token !== token) return;

		const legs = [...segment.legs];
		const waypoints = [...segment.waypoints];
		if ("failed" in outcome) {
			legs[index] = { ...(legs[index] as Leg), status: "failed", message: outcome.failed };
		} else if (outcome.points.length >= 2) {
			legs[index] = { ...(legs[index] as Leg), points: outcome.points, status: "ok" };
			waypoints[index] = { ...(waypoints[index] as Waypoint), point: outcome.points[0] as LatLng };
			waypoints[index + 1] = { ...(waypoints[index + 1] as Waypoint), point: outcome.points.at(-1) as LatLng };
			for (const neighbour of [index - 1, index + 1]) {
				const leg = legs[neighbour];
				const from = waypoints[neighbour];
				const to = waypoints[neighbour + 1];
				if (leg === undefined || from === undefined || to === undefined || from.mode === "route") continue;
				legs[neighbour] = { ...leg, points: [from.point, to.point] };
			}
		}
		commit(replaceSegment(current, rank, { ...segment, legs, waypoints }));
	};

	/**
	 * Le point cliqué, accroché au tracé nominal quand il est posé sur le trait même, quel que soit le
	 * mode de dessin : on doit pouvoir cliquer tout contre sans s'y coller.
	 */
	const snapped = (point: LatLng, onShape: boolean): LatLng => {
		if (!onShape) return point;
		const primary = patternsOf(ref.current)[0];
		const shape = primary === undefined ? undefined : geometry.get(primary.shapeId);
		if (shape === undefined) return point;
		const projection = project(shape, point);
		return projection.offset <= SNAP_TOLERANCE ? projection.at : point;
	};

	const removeWaypoint = (index: number) => {
		const segment = ref.current.segments[ref.current.active];
		if (segment === undefined) return;
		const waypoints = segment.waypoints.filter((_, rank) => rank !== index);
		let legs = [...segment.legs];
		if (waypoints.length < 2) legs = [];
		else if (index === 0) legs.shift();
		else if (index === waypoints.length) legs.pop();
		else legs.splice(index, 1);
		updateActive(() => ({ ...segment, waypoints, legs }));
		if (waypoints.length >= 2 && index > 0 && index < waypoints.length) resolveLegs([index - 1]);
	};

	return {
		state,
		patterns: patternsOf(state),
		active: state.segments[state.active] as SegmentState,

		reset(next: ModificationDetailDto) {
			const fresh = stateOf(next, geometry);
			commit({ ...fresh, active: Math.min(ref.current.active, fresh.segments.length - 1) });
		},

		patch(change: Partial<Pick<EditorState, "description" | "priority" | "extraRemoved" | "tripSets">>) {
			commit({ ...ref.current, ...change });
		},

		togglePattern(patternId: string, on: boolean) {
			const current = ref.current;
			const patternIds = on
				? detail.patterns
						.map((pattern) => pattern.patternId)
						.filter((id) => id === patternId || current.patternIds.includes(id))
				: current.patternIds.filter((id) => id !== patternId);
			const next = { ...current, patternIds };
			commit({ ...next, segments: next.segments.map((segment) => withBounds(segment, next)) });
		},

		selectSegment(index: number) {
			commit({ ...ref.current, active: index });
		},

		addSegment() {
			const current = ref.current;
			commit({ ...current, segments: [...current.segments, emptySegment()], active: current.segments.length });
		},

		/** Retire un tronçon. Le tronçon sélectionné le reste ; c'est le précédent qui prend la place du retiré. */
		removeSegment(index: number) {
			const current = ref.current;
			const segments = current.segments.filter((_, rank) => rank !== index);
			const active =
				index < current.active || (index === current.active && index > 0) ? current.active - 1 : current.active;
			commit({
				...current,
				segments: segments.length === 0 ? [emptySegment()] : segments,
				active: Math.min(active, Math.max(0, segments.length - 1)),
			});
		},

		addWaypoint(point: LatLng, pen: "route" | "free", onShape = false) {
			const current = ref.current;
			const segment = current.segments[current.active];
			if (segment === undefined) return;
			// Le mode vit sur le point qui OUVRE la jambe : c'est le dernier posé qui prend le trait courant.
			const waypoints = segment.waypoints.map((waypoint, index, list) =>
				index === list.length - 1 ? { ...waypoint, mode: pen } : waypoint,
			);
			waypoints.push({ point: snapped(point, onShape), mode: pen });
			const legs = waypoints.length >= 2 ? [...segment.legs, newLeg()] : [];
			commit(replaceSegment(current, current.active, { ...segment, waypoints, legs }));
			if (waypoints.length >= 2) resolveLegs([waypoints.length - 2]);
		},

		moveWaypoint(index: number, point: LatLng, onShape = false) {
			updateActive((segment) => ({
				...segment,
				waypoints: segment.waypoints.map((waypoint, rank) =>
					rank === index ? { ...waypoint, point: snapped(point, onShape) } : waypoint,
				),
			}));
			resolveLegs([index - 1, index].filter((leg) => leg >= 0));
		},

		removeWaypoint,

		undo() {
			const segment = ref.current.segments[ref.current.active];
			if (segment !== undefined && segment.waypoints.length > 0) removeWaypoint(segment.waypoints.length - 1);
		},

		clear() {
			updateActive((segment) => ({ ...segment, waypoints: [], legs: [] }));
		},

		setTerminus(terminus: Terminus) {
			updateActive((segment) => ({ ...segment, terminus }));
		},

		setBounds(change: Partial<Pick<SegmentState, "startStopId" | "endStopId" | "removes">>) {
			updateActive((segment) => ({ ...segment, ...change, boundsOverridden: true }));
		},

		resetBounds() {
			updateActive((segment) => ({ ...segment, boundsOverridden: false }));
		},

		setDelay(propagatedDelay: number) {
			updateActive((segment) => ({ ...segment, propagatedDelay }));
		},

		addStop(stop: Omit<ReplacementStop, "travelTime">) {
			const current = ref.current;
			// Tous tronçons confondus : deux mentions du même arrêt y feraient arrêter le véhicule deux fois.
			if (current.segments.some((segment) => segment.stops.some((entry) => entry.stopId === stop.stopId))) {
				toast.error("Cet arrêt figure déjà dans la déclaration.");
				return;
			}
			updateActive((segment) => ({
				...segment,
				// Une minute après le dernier arrêt posé : une valeur de départ plausible, à corriger.
				stops: [...segment.stops, { ...stop, travelTime: (segment.stops.at(-1)?.travelTime ?? 0) + 60 }],
			}));
		},

		removeStop(stopId: string) {
			updateActive((segment) => ({ ...segment, stops: segment.stops.filter((stop) => stop.stopId !== stopId) }));
		},

		moveStop(index: number, step: -1 | 1) {
			updateActive((segment) => {
				const stops = [...segment.stops];
				const target = index + step;
				if (target < 0 || target >= stops.length) return segment;
				[stops[index], stops[target]] = [stops[target] as ReplacementStop, stops[index] as ReplacementStop];
				return { ...segment, stops };
			});
		},

		setTravelTime(stopId: string, travelTime: number) {
			updateActive((segment) => ({
				...segment,
				stops: segment.stops.map((stop) => (stop.stopId === stopId ? { ...stop, travelTime } : stop)),
			}));
		},

		/** Retend le tronçon actif en lignes droites — quand le routage ne répond plus. */
		straighten() {
			updateActive((segment) => ({
				...segment,
				waypoints: segment.waypoints.map((waypoint) => ({ ...waypoint, mode: "free" as const })),
				legs: straightLegs(segment.waypoints),
			}));
		},
	};
}
