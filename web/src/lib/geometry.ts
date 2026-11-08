/** Un point [latitude, longitude]. */
export type LatLng = [number, number];

const EARTH_RADIUS = 6_371_000;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** La distance entre deux points, en mètres. */
export function distance(a: LatLng, b: LatLng): number {
	const dLat = toRadians(b[0] - a[0]);
	const dLon = toRadians(b[1] - a[1]);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a[0])) * Math.cos(toRadians(b[0])) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(h));
}

/** La longueur d'une polyligne, en mètres. */
export function lengthOf(points: readonly LatLng[]): number {
	let total = 0;
	for (let index = 1; index < points.length; index += 1) {
		total += distance(points[index - 1] as LatLng, points[index] as LatLng);
	}
	return total;
}

/**
 * Le point d'une polyligne le plus proche de `point` : son abscisse curviligne depuis le début, et la
 * distance qui l'en sépare, en mètres. Le calcul se fait dans un plan tangent local — à l'échelle d'une
 * ville, l'écart avec la sphère ne se voit pas.
 */
export function project(points: readonly LatLng[], point: LatLng): { along: number; offset: number; at: LatLng } {
	const cosLat = Math.cos(toRadians(point[0]));
	const toPlane = (p: LatLng): [number, number] => [
		toRadians(p[1]) * cosLat * EARTH_RADIUS,
		toRadians(p[0]) * EARTH_RADIUS,
	];
	const target = toPlane(point);

	let best = { along: 0, offset: Number.POSITIVE_INFINITY, at: point };
	let walked = 0;
	for (let index = 1; index < points.length; index += 1) {
		const from = points[index - 1] as LatLng;
		const to = points[index] as LatLng;
		const a = toPlane(from);
		const b = toPlane(to);
		const dx = b[0] - a[0];
		const dy = b[1] - a[1];
		const squared = dx * dx + dy * dy;
		const t =
			squared === 0 ? 0 : Math.max(0, Math.min(1, ((target[0] - a[0]) * dx + (target[1] - a[1]) * dy) / squared));
		const x = a[0] + t * dx;
		const y = a[1] + t * dy;
		const offset = Math.hypot(target[0] - x, target[1] - y);
		// L'abscisse se cumule en haversine, comme `lengthOf` et `slice` : le plan, calé sur la latitude
		// du point, allonge ou raccourcit les segments lointains, et l'écart se cumule le long du tracé —
		// plusieurs mètres au bout d'une ligne, assez pour que le tronçon évité morde sur ce qui reste parcouru.
		const segment = distance(from, to);
		if (offset < best.offset) {
			best = {
				along: walked + t * segment,
				offset,
				at: [from[0] + t * (to[0] - from[0]), from[1] + t * (to[1] - from[1])],
			};
		}
		walked += segment;
	}
	return best;
}

/** La portion d'une polyligne entre deux abscisses curvilignes, en mètres. */
export function slice(points: readonly LatLng[], from: number, to: number): LatLng[] {
	const result: LatLng[] = [];
	let walked = 0;
	for (let index = 1; index < points.length; index += 1) {
		const a = points[index - 1] as LatLng;
		const b = points[index] as LatLng;
		const length = distance(a, b);
		const start = walked;
		const end = walked + length;
		walked = end;
		if (end < from || start > to || length === 0) continue;
		const at = (along: number): LatLng => {
			const t = Math.max(0, Math.min(1, (along - start) / length));
			return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
		};
		if (result.length === 0) result.push(at(Math.max(from, start)));
		result.push(at(Math.min(to, end)));
	}
	return result;
}
