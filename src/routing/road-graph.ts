import { existsSync, readFileSync } from "node:fs";

import type { Coordinates } from "../utils/geometry.js";
import {
	COORDINATE_SCALE,
	GRAPH_HEADER_LENGTH,
	type GraphBounds,
	type GraphCounts,
	graphLayout,
	readGraphHeader,
} from "./graph-format.js";

/**
 * Le graphe routier en mémoire : rien d'autre que le fichier, avec des vues typées posées dessus.
 *
 * Aucun objet n'est construit au chargement. Un tableau de deux cent mille arêtes en objets
 * JavaScript coûterait dix fois la place et une seconde de démarrage ; ici, ouvrir le graphe revient
 * à lire seize mégaoctets et à calculer treize décalages.
 */
export type RoadGraph = {
	readonly counts: GraphCounts;
	readonly bounds: GraphBounds;

	readonly nodeLatitudes: Int32Array;
	readonly nodeLongitudes: Int32Array;

	readonly edgeFrom: Uint32Array;
	readonly edgeTo: Uint32Array;
	/** Longueur de l'arête, en kilomètres. */
	readonly edgeLengths: Float32Array;

	/** Compression creuse : les points intermédiaires de l'arête `i` vont de `[i]` à `[i + 1]`. */
	readonly edgeGeometryStart: Uint32Array;
	readonly geometryLatitudes: Int32Array;
	readonly geometryLongitudes: Int32Array;

	/**
	 * Compression creuse : les arêtes qui aboutissent au carrefour `i`, chacune `(arête × 2) |
	 * sensInverse`. Toute arête y figure par ses deux bouts — aucune restriction de circulation
	 * n'entre en ligne de compte (cf. `isDrivableRoad`).
	 */
	readonly arcStart: Uint32Array;
	readonly arcEdges: Uint32Array;

	/** Compression creuse : les arêtes qui traversent la maille `i`. */
	readonly cellStart: Uint32Array;
	readonly cellEdges: Uint32Array;

	readonly columns: number;
	readonly rows: number;
	/** Étendue d'une maille, en dix-millionièmes de degré. */
	readonly latitudeStep: number;
	readonly longitudeStep: number;
	/** Côté le plus court d'une maille, en kilomètres : de quoi borner une recherche par anneaux. */
	readonly cellReach: number;
};

/**
 * Ouvre le graphe.
 *
 * Fichier absent : `undefined`, et l'accrochage sera simplement indisponible — c'est un déploiement
 * normal, et rien d'autre dans le producteur n'en dépend. Fichier présent mais illisible ou d'une
 * autre version : on LÈVE. Ce n'est plus un mode dégradé mais une erreur de déploiement, et la taire
 * reviendrait à router sur des données qu'on n'a pas comprises.
 */
export function loadRoadGraph(path: string): RoadGraph | undefined {
	if (!existsSync(path)) return undefined;

	const file = readFileSync(path);
	const { counts, bounds } = readGraphHeader(file.subarray(0, GRAPH_HEADER_LENGTH));
	const layout = graphLayout(counts);

	if (file.length < layout.byteLength) {
		throw new Error("Graphe routier tronqué : le reconstruire avec pnpm build:graph.");
	}

	// Une vue typée refuse de se poser sur un décalage qui n'est pas un multiple de ses termes. Node
	// donne un tampon aligné pour un fichier de cette taille, mais rien ne l'y oblige.
	const buffer =
		file.byteOffset % 8 === 0
			? file.buffer.slice(file.byteOffset, file.byteOffset + layout.byteLength)
			: Uint8Array.prototype.slice.call(file, 0, layout.byteLength).buffer;

	const integers = (section: keyof typeof layout.offsets) =>
		new Int32Array(buffer, layout.offsets[section], layout.lengths[section]);
	const naturals = (section: keyof typeof layout.offsets) =>
		new Uint32Array(buffer, layout.offsets[section], layout.lengths[section]);

	const latitudeStep = (bounds.maxLatitude - bounds.minLatitude) / counts.gridRows;
	const longitudeStep = (bounds.maxLongitude - bounds.minLongitude) / counts.gridColumns;
	const middle = (((bounds.minLatitude + bounds.maxLatitude) / 2 / COORDINATE_SCALE) * Math.PI) / 180;

	return {
		counts,
		bounds,
		nodeLatitudes: integers("nodeLatitudes"),
		nodeLongitudes: integers("nodeLongitudes"),
		edgeFrom: naturals("edgeFrom"),
		edgeTo: naturals("edgeTo"),
		edgeLengths: new Float32Array(buffer, layout.offsets.edgeLengths, layout.lengths.edgeLengths),
		edgeGeometryStart: naturals("edgeGeometryStart"),
		geometryLatitudes: integers("geometryLatitudes"),
		geometryLongitudes: integers("geometryLongitudes"),
		arcStart: naturals("arcStart"),
		arcEdges: naturals("arcEdges"),
		cellStart: naturals("cellStart"),
		cellEdges: naturals("cellEdges"),
		columns: counts.gridColumns,
		rows: counts.gridRows,
		latitudeStep,
		longitudeStep,
		cellReach: Math.min(
			(latitudeStep / COORDINATE_SCALE) * 111.32,
			(longitudeStep / COORDINATE_SCALE) * 111.32 * Math.cos(middle) || Number.POSITIVE_INFINITY,
		),
	};
}

export type RoadGraphHandle = {
	/** Connue dès le démarrage, sans rien lire. */
	readonly available: boolean;
	/** Le graphe, ouvert à la première demande. */
	graph(): RoadGraph | undefined;
};

/**
 * Le graphe, ouvert paresseusement.
 *
 * Sa présence est constatée au démarrage — il faut bien la dire à l'éditeur — mais ses octets
 * attendent le premier accrochage : un producteur dont personne n'ouvre l'administration ne paie
 * alors rien, ni en mémoire ni en temps de démarrage.
 */
export function useRoadGraph(path: string): RoadGraphHandle {
	const available = existsSync(path);
	let graph: RoadGraph | undefined;

	if (available) console.log(`➔ Road graph found at ${path}, loaded on first use.`);
	else console.warn(`✘ Road graph missing at ${path} — detour path snapping disabled.`);

	return {
		available,
		graph() {
			if (!available) return undefined;
			graph ??= loadRoadGraph(path);
			return graph;
		},
	};
}

/** Le nombre de points d'une arête, ses deux carrefours compris. */
export function edgePointCount(graph: RoadGraph, edge: number): number {
	return graph.edgeGeometryStart[edge + 1]! - graph.edgeGeometryStart[edge]! + 2;
}

/**
 * Le point d'indice `position` de l'arête, dans le sens du chemin d'origine. Écrit dans `into` plutôt
 * que d'allouer : une seule recherche d'itinéraire en lit des dizaines de milliers.
 */
export function readEdgePoint(graph: RoadGraph, edge: number, position: number, into: Coordinates): void {
	const count = edgePointCount(graph, edge);

	if (position === 0) {
		readNode(graph, graph.edgeFrom[edge]!, into);
		return;
	}
	if (position === count - 1) {
		readNode(graph, graph.edgeTo[edge]!, into);
		return;
	}

	const index = graph.edgeGeometryStart[edge]! + position - 1;
	into.latitude = graph.geometryLatitudes[index]! / COORDINATE_SCALE;
	into.longitude = graph.geometryLongitudes[index]! / COORDINATE_SCALE;
}

export function readNode(graph: RoadGraph, node: number, into: Coordinates): void {
	into.latitude = graph.nodeLatitudes[node]! / COORDINATE_SCALE;
	into.longitude = graph.nodeLongitudes[node]! / COORDINATE_SCALE;
}

export function nodeCoordinates(graph: RoadGraph, node: number): Coordinates {
	return {
		latitude: graph.nodeLatitudes[node]! / COORDINATE_SCALE,
		longitude: graph.nodeLongitudes[node]! / COORDINATE_SCALE,
	};
}

/** La colonne d'une longitude, bornée à la grille. */
export function gridColumn(graph: RoadGraph, longitude: number): number {
	const scaled = Math.round(longitude * COORDINATE_SCALE);
	const column = Math.floor((scaled - graph.bounds.minLongitude) / graph.longitudeStep);
	return Math.min(graph.columns - 1, Math.max(0, column));
}

/** La ligne d'une latitude, bornée à la grille. */
export function gridRow(graph: RoadGraph, latitude: number): number {
	const scaled = Math.round(latitude * COORDINATE_SCALE);
	const row = Math.floor((scaled - graph.bounds.minLatitude) / graph.latitudeStep);
	return Math.min(graph.rows - 1, Math.max(0, row));
}
