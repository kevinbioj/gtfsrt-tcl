import { type Coordinates, haversine, projectOnSegment } from "../utils/geometry.js";
import { edgePointCount, gridColumn, gridRow, type RoadGraph, readEdgePoint } from "./road-graph.js";

/** Où un point tombe sur le réseau routier. */
export type RoadSnap = {
	edge: number;
	/** Abscisse curviligne du projeté depuis le carrefour amont de l'arête, en kilomètres. */
	distance: number;
	/** Écart entre le point demandé et le réseau, en kilomètres. */
	offset: number;
	/** Le projeté lui-même : c'est lui, et non le clic, qui entre dans le tracé. */
	point: Coordinates;
};

// Réemployés à chaque segment examiné : un accrochage en parcourt des centaines.
const segmentStart: Coordinates = { latitude: 0, longitude: 0 };
const segmentEnd: Coordinates = { latitude: 0, longitude: 0 };

/**
 * Accroche un point au réseau routier : l'arête qui en passe le plus près, et où précisément.
 *
 * La recherche part de la maille du point et s'élargit par anneaux, en s'arrêtant dès que le
 * meilleur candidat connu est plus proche que ne peut l'être quoi que ce soit de l'anneau suivant.
 * Sur une grille de cent vingt-cinq mètres, un point posé sur une rue est trouvé au premier anneau.
 *
 * `maxOffset` est un refus, pas un ajustement : au-delà, on rend `undefined` plutôt que d'accrocher
 * à la rue d'à côté. Un accrochage silencieux sur la mauvaise voie donnerait un itinéraire faux que
 * personne ne songerait à vérifier.
 */
export function snapToRoad(graph: RoadGraph, point: Coordinates, maxOffset: number): RoadSnap | undefined {
	const centerColumn = gridColumn(graph, point.longitude);
	const centerRow = gridRow(graph, point.latitude);
	const maxRing = Math.ceil(maxOffset / graph.cellReach) + 1;

	const examined = new Set<number>();
	let best: RoadSnap | undefined;

	for (let ring = 0; ring <= maxRing; ring += 1) {
		// Tout ce qui se trouve à cet anneau ou au-delà est à au moins (anneau - 1) mailles du point :
		// si l'on a déjà mieux, il n'y a plus rien à espérer.
		if (best !== undefined && best.offset <= (ring - 1) * graph.cellReach) break;

		for (let row = centerRow - ring; row <= centerRow + ring; row += 1) {
			if (row < 0 || row >= graph.rows) continue;
			const onEdgeOfRing = row === centerRow - ring || row === centerRow + ring;

			for (let column = centerColumn - ring; column <= centerColumn + ring; column += 1) {
				if (column < 0 || column >= graph.columns) continue;
				// Le pourtour de l'anneau seulement : l'intérieur a été vu aux tours précédents.
				if (!onEdgeOfRing && column !== centerColumn - ring && column !== centerColumn + ring) continue;

				const cell = row * graph.columns + column;
				for (let index = graph.cellStart[cell]!; index < graph.cellStart[cell + 1]!; index += 1) {
					const edge = graph.cellEdges[index]!;
					// Une arête traverse plusieurs mailles, et ce sont les anneaux qui les visitent.
					if (examined.has(edge)) continue;
					examined.add(edge);

					const candidate = projectOnEdge(graph, edge, point);
					if (best === undefined || candidate.offset < best.offset) best = candidate;
				}
			}
		}
	}

	return best !== undefined && best.offset <= maxOffset ? best : undefined;
}

/** Le projeté d'un point sur une arête, segment par segment. */
function projectOnEdge(graph: RoadGraph, edge: number, point: Coordinates): RoadSnap {
	const count = edgePointCount(graph, edge);

	let travelled = 0;
	let best: RoadSnap = {
		edge,
		distance: 0,
		offset: Number.POSITIVE_INFINITY,
		point: { latitude: 0, longitude: 0 },
	};

	readEdgePoint(graph, edge, 0, segmentEnd);

	for (let position = 1; position < count; position += 1) {
		segmentStart.latitude = segmentEnd.latitude;
		segmentStart.longitude = segmentEnd.longitude;
		readEdgePoint(graph, edge, position, segmentEnd);

		const length = haversine(segmentStart, segmentEnd);
		const { offset, fraction } = projectOnSegment(point, segmentStart, segmentEnd);

		if (offset < best.offset) {
			best = {
				edge,
				distance: travelled + length * fraction,
				offset,
				point: {
					latitude: segmentStart.latitude + (segmentEnd.latitude - segmentStart.latitude) * fraction,
					longitude: segmentStart.longitude + (segmentEnd.longitude - segmentStart.longitude) * fraction,
				},
			};
		}

		travelled += length;
	}

	return best;
}
