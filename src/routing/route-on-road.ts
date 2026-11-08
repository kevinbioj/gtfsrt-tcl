import { type Coordinates, haversine } from "../utils/geometry.js";
import { edgePointCount, nodeCoordinates, type RoadGraph, readEdgePoint } from "./road-graph.js";
import { smoothPath } from "./smooth-path.js";
import { type RoadSnap, snapToRoad } from "./snap-to-road.js";

export type RoadRoute = {
	/** L'itinéraire, du projeté du départ à celui de l'arrivée, en suivant la chaussée. */
	path: Coordinates[];
	/** Longueur parcourue, en kilomètres. */
	distance: number;
	from: RoadSnap;
	to: RoadSnap;
};

/**
 * Les deux façons d'échouer, distinguées parce qu'elles appellent des gestes différents : déplacer
 * le point, ou renoncer à l'accrochage sur cette jambe.
 */
export type RoadRouteFailure = { failure: "no-road" | "unreachable" };

export type RoutingOptions = {
	/** Écart maximal entre un point demandé et la rue sur laquelle on l'accroche, en kilomètres. */
	snapRadius: number;
	/** Nombre de carrefours que la recherche s'autorise à développer avant d'abandonner. */
	maxExpansions: number;
	/** Écart toléré entre le tracé rendu et la courbe qui en arrondit les angles, en kilomètres. */
	smoothingTolerance: number;
};

/**
 * L'itinéraire routier entre deux points, par le plus court chemin.
 *
 * Les deux points sont d'abord accrochés au réseau, et tombent donc presque toujours AU MILIEU d'une
 * arête et non sur un carrefour. La recherche part alors des DEUX extrémités de l'arête de départ,
 * pour le coût du bout d'arête parcouru, et s'achève symétriquement. Le cas où les deux points
 * partagent la même arête se traite à part : il n'y a rien à chercher, il suffit de longer la rue.
 *
 * Aucune restriction de circulation n'est opposée au tracé : ni sens unique, ni interdiction
 * d'accès. Le dessinateur sait ce que l'exploitation a décidé — rue inversée pour un chantier, voie
 * fermée sauf aux bus — et le graphe n'a pas à lui refuser une rue qu'il a sous les yeux.
 *
 * Le coût est la seule distance, sans préférence pour les grands axes : un autobus dévié emprunte
 * volontiers une rue secondaire, et c'est encore au dessinateur de trancher, en posant un point de
 * passage.
 *
 * La géométrie rendue passe enfin par {@link smoothPath}, qui en arrondit les angles. La LONGUEUR,
 * elle, reste celle des rues telles qu'OpenStreetMap les décrit : c'est la distance qu'on parcourt
 * sur la chaussée, et non celle de la courbe qu'on dessine par-dessus.
 */
export function routeOnRoad(
	graph: RoadGraph,
	from: Coordinates,
	to: Coordinates,
	options: RoutingOptions,
): RoadRoute | RoadRouteFailure {
	const start = snapToRoad(graph, from, options.snapRadius);
	const end = snapToRoad(graph, to, options.snapRadius);
	if (start === undefined || end === undefined) return { failure: "no-road" };

	const direct = alongOneEdge(graph, start, end);
	if (direct !== undefined) return rounded(direct, options.smoothingTolerance);

	const arcs = search(graph, start, end, options.maxExpansions);
	if (arcs === undefined) return { failure: "unreachable" };

	return rounded(assemble(graph, start, end, arcs), options.smoothingTolerance);
}

/** Le même itinéraire, ses angles arrondis. */
function rounded(route: RoadRoute, tolerance: number): RoadRoute {
	return { ...route, path: smoothPath(route.path, tolerance) };
}

/** Les deux points sur la même arête : la rue elle-même fait l'itinéraire, dans un sens ou l'autre. */
function alongOneEdge(graph: RoadGraph, start: RoadSnap, end: RoadSnap): RoadRoute | undefined {
	if (start.edge !== end.edge) return undefined;

	const path: Coordinates[] = [start.point];
	appendEdgePortion(graph, start.edge, start.distance, end.distance, path);

	return { path, distance: Math.abs(end.distance - start.distance), from: start, to: end };
}

/** Un arc emprunté : l'arête, et le sens dans lequel on la prend. */
type Arc = { edge: number; reversed: boolean };

/**
 * A* sur les carrefours.
 *
 * L'heuristique est la distance à vol d'oiseau jusqu'au projeté de l'arrivée. Elle ne surestime
 * jamais : les longueurs d'arêtes sont des sommes de distances à vol d'oiseau, donc toujours
 * supérieures ou égales à celle qui joint directement leurs bouts. L'itinéraire rendu est donc bien
 * le plus court.
 *
 * Rien n'est alloué par appel : les tableaux de travail vivent avec le graphe, et une estampille
 * incrémentée à chaque recherche tient lieu de remise à zéro.
 */
function search(graph: RoadGraph, start: RoadSnap, end: RoadSnap, maxExpansions: number): Arc[] | undefined {
	const work = workspaceOf(graph);
	work.generation += 1;
	const generation = work.generation;
	work.heap.clear();

	const goal = end.point;
	const endLength = graph.edgeLengths[end.edge]!;

	// Ce qu'il en coûte de quitter un carrefour pour rejoindre le projeté de l'arrivée, et par quel
	// bout de l'arête d'arrivée. Une arête s'aborde par ses deux extrémités.
	const exitCost = (node: number): { cost: number; arc: Arc } | undefined => {
		if (node === graph.edgeFrom[end.edge]!) {
			return { cost: end.distance, arc: { edge: end.edge, reversed: false } };
		}
		if (node === graph.edgeTo[end.edge]!) {
			return { cost: endLength - end.distance, arc: { edge: end.edge, reversed: true } };
		}
		return undefined;
	};

	const open = (node: number, cost: number, arc: Arc, previous: number): void => {
		if (work.stamp[node] === generation && work.cost[node]! <= cost) return;
		work.stamp[node] = generation;
		work.cost[node] = cost;
		work.cameEdge[node] = arc.edge;
		work.cameReversed[node] = arc.reversed ? 1 : 0;
		work.cameNode[node] = previous;
		work.heap.push(cost + haversine(nodeCoordinates(graph, node), goal), node);
	};

	// Les deux bouts de l'arête de départ, pour le prix du morceau de rue qui les en sépare.
	const startLength = graph.edgeLengths[start.edge]!;
	open(graph.edgeTo[start.edge]!, startLength - start.distance, { edge: start.edge, reversed: false }, -1);
	open(graph.edgeFrom[start.edge]!, start.distance, { edge: start.edge, reversed: true }, -1);

	let bestCost = Number.POSITIVE_INFINITY;
	let bestNode = -1;
	let bestArc: Arc | undefined;
	let expansions = 0;

	while (!work.heap.empty) {
		const estimate = work.heap.peekPriority();
		const node = work.heap.pop();

		// Rien au-delà ne peut faire mieux que ce qu'on tient déjà : l'heuristique ne surestimant
		// jamais, l'estimation du sommet du tas minore tout ce qui reste.
		if (estimate >= bestCost) break;
		// Un carrefour atteint plus tard par un chemin plus court a été réempilé : cette entrée-ci est
		// périmée, et le tas n'a pas de quoi l'effacer.
		if (work.closed[node] === generation) continue;
		if (work.stamp[node] !== generation) continue;
		work.closed[node] = generation;

		expansions += 1;
		if (expansions > maxExpansions) break;

		const cost = work.cost[node]!;

		const exit = exitCost(node);
		if (exit !== undefined && cost + exit.cost < bestCost) {
			bestCost = cost + exit.cost;
			bestNode = node;
			bestArc = exit.arc;
		}

		for (let index = graph.arcStart[node]!; index < graph.arcStart[node + 1]!; index += 1) {
			const arc = graph.arcEdges[index]!;
			const edge = arc >>> 1;
			const reversed = (arc & 1) === 1;
			const next = reversed ? graph.edgeFrom[edge]! : graph.edgeTo[edge]!;
			if (work.closed[next] === generation) continue;

			open(next, cost + graph.edgeLengths[edge]!, { edge, reversed }, node);
		}
	}

	if (bestNode < 0 || bestArc === undefined) return undefined;

	// Remontée du chemin : chaque carrefour retient l'arc par lequel on y est arrivé. Le tout premier
	// est le morceau de l'arête de départ, et le dernier celui de l'arête d'arrivée.
	const arcs: Arc[] = [bestArc];
	for (let node = bestNode; node >= 0; node = work.cameNode[node]!) {
		arcs.push({ edge: work.cameEdge[node]!, reversed: work.cameReversed[node] === 1 });
	}

	return arcs.reverse();
}

/** Recompose la géométrie et la longueur à partir des arcs empruntés. */
function assemble(graph: RoadGraph, start: RoadSnap, end: RoadSnap, arcs: readonly Arc[]): RoadRoute {
	const path: Coordinates[] = [start.point];
	let distance = 0;

	arcs.forEach((arc, index) => {
		const length = graph.edgeLengths[arc.edge]!;
		// Le premier arc commence où le départ s'est accroché, le dernier s'arrête où l'arrivée s'est
		// accrochée ; les autres se parcourent d'un bout à l'autre.
		const from = index === 0 ? start.distance : arc.reversed ? length : 0;
		const to = index === arcs.length - 1 ? end.distance : arc.reversed ? 0 : length;

		appendEdgePortion(graph, arc.edge, from, to, path);
		distance += Math.abs(to - from);
	});

	return { path, distance, from: start, to: end };
}

// Réemployés d'un arc à l'autre : une jambe de déviation en parcourt des dizaines.
const cursor: Coordinates = { latitude: 0, longitude: 0 };
const previous: Coordinates = { latitude: 0, longitude: 0 };

/**
 * Ajoute la portion d'arête comprise entre deux abscisses, dans l'ordre où on la parcourt.
 *
 * Les abscisses se comptent toujours dans le sens du chemin d'origine ; c'est leur ordre qui dit le
 * sens de parcours. Le point de départ n'est pas ajouté — il l'a été par l'arc précédent, ou c'est
 * le projeté du départ.
 */
function appendEdgePortion(graph: RoadGraph, edge: number, from: number, to: number, into: Coordinates[]): void {
	const count = edgePointCount(graph, edge);
	const forward = to >= from;
	const low = Math.min(from, to);
	const high = Math.max(from, to);

	// Les sommets intermédiaires, avec leur abscisse, pour ne retenir que ceux de la portion.
	const inside: Coordinates[] = [];
	let travelled = 0;
	readEdgePoint(graph, edge, 0, cursor);

	for (let position = 1; position < count; position += 1) {
		previous.latitude = cursor.latitude;
		previous.longitude = cursor.longitude;
		readEdgePoint(graph, edge, position, cursor);

		travelled += haversine(previous, cursor);
		if (position === count - 1) break;
		if (travelled > low && travelled < high) inside.push({ latitude: cursor.latitude, longitude: cursor.longitude });
	}

	if (!forward) inside.reverse();
	into.push(...inside, pointAt(graph, edge, to));
}

/** Le point d'une arête à une abscisse donnée. */
function pointAt(graph: RoadGraph, edge: number, distance: number): Coordinates {
	const count = edgePointCount(graph, edge);

	// Aux deux bouts, le carrefour lui-même et non son interpolation : les longueurs s'additionnent
	// en flottants, et un raccord placé à un millimètre du carrefour se verrait au point suivant.
	if (distance <= 0) return exactPoint(graph, edge, 0);
	if (distance >= graph.edgeLengths[edge]!) return exactPoint(graph, edge, count - 1);

	let travelled = 0;
	readEdgePoint(graph, edge, 0, cursor);

	for (let position = 1; position < count; position += 1) {
		previous.latitude = cursor.latitude;
		previous.longitude = cursor.longitude;
		readEdgePoint(graph, edge, position, cursor);

		const length = haversine(previous, cursor);
		if (travelled + length >= distance || position === count - 1) {
			const fraction = length === 0 ? 0 : Math.min(1, Math.max(0, (distance - travelled) / length));
			return {
				latitude: previous.latitude + (cursor.latitude - previous.latitude) * fraction,
				longitude: previous.longitude + (cursor.longitude - previous.longitude) * fraction,
			};
		}

		travelled += length;
	}

	return { latitude: cursor.latitude, longitude: cursor.longitude };
}

function exactPoint(graph: RoadGraph, edge: number, position: number): Coordinates {
	const point: Coordinates = { latitude: 0, longitude: 0 };
	readEdgePoint(graph, edge, position, point);
	return point;
}

/**
 * Les tableaux de travail de la recherche, attachés au graphe et non à l'appel.
 *
 * Remettre à zéro cent soixante mille cases à chaque jambe coûterait plus cher que la recherche
 * elle-même : une estampille par carrefour, comparée à celle de la recherche en cours, dit si sa
 * valeur est de ce tour-ci ou d'un tour précédent.
 */
type Workspace = {
	generation: number;
	stamp: Int32Array;
	closed: Int32Array;
	cost: Float64Array;
	cameEdge: Int32Array;
	cameReversed: Int8Array;
	cameNode: Int32Array;
	heap: Heap;
};

const workspaces = new WeakMap<RoadGraph, Workspace>();

function workspaceOf(graph: RoadGraph): Workspace {
	let workspace = workspaces.get(graph);
	if (workspace === undefined) {
		const size = graph.counts.nodeCount;
		workspace = {
			generation: 0,
			stamp: new Int32Array(size),
			closed: new Int32Array(size),
			cost: new Float64Array(size),
			cameEdge: new Int32Array(size),
			cameReversed: new Int8Array(size),
			cameNode: new Int32Array(size),
			heap: new Heap(),
		};
		workspaces.set(graph, workspace);
	}
	return workspace;
}

/**
 * Une file d'attente triée par estimation, en tas binaire.
 *
 * Un carrefour peut y figurer plusieurs fois, avec des estimations différentes : plutôt que de
 * chercher puis corriger son entrée, on en ajoute une meilleure et l'ancienne est reconnue périmée
 * quand elle ressort.
 */
class Heap {
	private priorities = new Float64Array(1 << 12);
	private values = new Int32Array(1 << 12);
	private count = 0;

	get empty(): boolean {
		return this.count === 0;
	}

	clear(): void {
		this.count = 0;
	}

	peekPriority(): number {
		return this.priorities[0]!;
	}

	push(priority: number, value: number): void {
		if (this.count === this.values.length) this.grow();

		let child = this.count;
		this.count += 1;

		while (child > 0) {
			const parent = (child - 1) >> 1;
			if (this.priorities[parent]! <= priority) break;
			this.priorities[child] = this.priorities[parent]!;
			this.values[child] = this.values[parent]!;
			child = parent;
		}

		this.priorities[child] = priority;
		this.values[child] = value;
	}

	pop(): number {
		const top = this.values[0]!;
		this.count -= 1;
		if (this.count === 0) return top;

		const priority = this.priorities[this.count]!;
		const value = this.values[this.count]!;

		let parent = 0;
		for (;;) {
			let child = parent * 2 + 1;
			if (child >= this.count) break;
			if (child + 1 < this.count && this.priorities[child + 1]! < this.priorities[child]!) child += 1;
			if (this.priorities[child]! >= priority) break;
			this.priorities[parent] = this.priorities[child]!;
			this.values[parent] = this.values[child]!;
			parent = child;
		}

		this.priorities[parent] = priority;
		this.values[parent] = value;
		return top;
	}

	private grow(): void {
		const priorities = new Float64Array(this.priorities.length * 2);
		priorities.set(this.priorities);
		this.priorities = priorities;

		const values = new Int32Array(this.values.length * 2);
		values.set(this.values);
		this.values = values;
	}
}
