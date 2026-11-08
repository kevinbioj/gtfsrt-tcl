/** Rayon moyen de la Terre, en kilomètres. Toutes les distances de ce module sont exprimées ainsi. */
const EARTH_RADIUS = 6371.0088;

const DEGREES_TO_RADIANS = Math.PI / 180;

export type Coordinates = { latitude: number; longitude: number };

/** Un point d'une polyligne : ses coordonnées et son abscisse curviligne depuis l'origine. */
export type ShapePoint = Coordinates & { distance: number };

/** Distance à vol d'oiseau entre deux points. */
export function haversine(from: Coordinates, to: Coordinates): number {
	const deltaLatitude = (to.latitude - from.latitude) * DEGREES_TO_RADIANS;
	const deltaLongitude = (to.longitude - from.longitude) * DEGREES_TO_RADIANS;

	const chord =
		Math.sin(deltaLatitude / 2) ** 2 +
		Math.cos(from.latitude * DEGREES_TO_RADIANS) *
			Math.cos(to.latitude * DEGREES_TO_RADIANS) *
			Math.sin(deltaLongitude / 2) ** 2;

	return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(chord)));
}

export type SegmentProjection = {
	/** Écart entre le point et le segment. */
	offset: number;
	/** Où tombe le projeté sur le segment : 0 à son début, 1 à sa fin. */
	fraction: number;
};

/**
 * Projette un point sur un segment.
 *
 * Le calcul se fait dans un plan local calé sur la latitude du segment, et non sur la sphère : à
 * l'échelle d'un segment de shape — quelques dizaines de mètres — la déformation est très inférieure
 * au mètre, alors qu'un haversine par segment coûterait deux trigonométries de plus par point de
 * chaque shape, à chaque relevé de chaque véhicule.
 */
export function projectOnSegment(point: Coordinates, start: Coordinates, end: Coordinates): SegmentProjection {
	// Mètres par degré, à cette latitude : l'écartement des méridiens s'y resserre en cos(latitude).
	const perLongitude = EARTH_RADIUS * DEGREES_TO_RADIANS * Math.cos(start.latitude * DEGREES_TO_RADIANS);
	const perLatitude = EARTH_RADIUS * DEGREES_TO_RADIANS;

	// Repère centré sur le début du segment.
	const segmentX = (end.longitude - start.longitude) * perLongitude;
	const segmentY = (end.latitude - start.latitude) * perLatitude;
	const pointX = (point.longitude - start.longitude) * perLongitude;
	const pointY = (point.latitude - start.latitude) * perLatitude;

	// Segment dégénéré : deux points de shape confondus, le projeté ne peut être que leur position.
	const lengthSquared = segmentX * segmentX + segmentY * segmentY;
	if (lengthSquared === 0) return { offset: Math.hypot(pointX, pointY), fraction: 0 };

	// Bornée à [0, 1] : au-delà, le projeté sortirait du segment et empiéterait sur le suivant.
	const fraction = Math.min(1, Math.max(0, (pointX * segmentX + pointY * segmentY) / lengthSquared));

	return { offset: Math.hypot(pointX - fraction * segmentX, pointY - fraction * segmentY), fraction };
}

export type ShapeProjection = {
	/** Abscisse curviligne du projeté sur la polyligne. */
	distance: number;
	/** Écart entre le point et la polyligne. */
	offset: number;
};

/**
 * Projette un point sur une polyligne, au segment qui en passe le plus près.
 *
 * `window` restreint les segments examinés à une plage d'abscisses. Une shape qui repasse au même
 * endroit — boucle, tronçon emprunté dans les deux sens — offre sinon plusieurs projetés également
 * plausibles, que la seule position ne départage pas : la plage les départage par l'avancement déjà
 * connu du véhicule. Aucun segment dans la plage — véhicule retrouvé loin de là où on l'attendait —
 * et la polyligne entière est reprise.
 */
export function projectOnShape(
	shape: ShapePoint[],
	point: Coordinates,
	window?: { from: number; to: number },
): ShapeProjection | undefined {
	if (shape.length < 2) return undefined;

	const restricted = nearestSegment(shape, point, window);
	if (restricted !== undefined) return restricted;

	return window === undefined ? undefined : nearestSegment(shape, point, undefined);
}

function nearestSegment(
	shape: ShapePoint[],
	point: Coordinates,
	window: { from: number; to: number } | undefined,
): ShapeProjection | undefined {
	let best: ShapeProjection | undefined;

	for (let index = 0; index < shape.length - 1; index += 1) {
		const start = shape[index] as ShapePoint;
		const end = shape[index + 1] as ShapePoint;
		if (window !== undefined && (end.distance < window.from || start.distance > window.to)) continue;

		const { offset, fraction } = projectOnSegment(point, start, end);
		if (best !== undefined && offset >= best.offset) continue;

		best = { distance: start.distance + (end.distance - start.distance) * fraction, offset };
	}

	return best;
}
