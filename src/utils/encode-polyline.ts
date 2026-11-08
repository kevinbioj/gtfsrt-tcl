import type { Coordinates } from "./geometry.js";

/**
 * Facteur d'échelle de l'encodage : cinq décimales, soit environ un mètre. C'est la précision que
 * l'algorithme de Google retient par défaut, et celle qu'attendent les consommateurs de
 * `Shape.encoded_polyline` — le GTFS-RT ne prévoit pas d'en déclarer une autre.
 */
const SCALE = 1e5;

/**
 * Encode une polyligne au format « encoded polyline » de Google, seul format que le GTFS-RT accepte
 * pour une entité `shape`.
 *
 * Le principe tient en trois gestes : chaque coordonnée est arrondie au cent-millième puis écrite en
 * ÉCART au point précédent — une shape urbaine avance de quelques dizaines de mètres à la fois, et
 * l'écart tient sur bien moins de chiffres que la coordonnée ; l'écart, signé, est replié en entier
 * positif par un décalage à gauche que la valeur négative fait suivre d'une inversion binaire
 * (« zigzag ») ; l'entier est enfin découpé en tranches de cinq bits, chacune portée à `0x20` tant
 * qu'une autre la suit, puis décalée de 63 pour tomber dans les caractères imprimables.
 *
 * L'arrondi se fait sur la coordonnée et non sur l'écart : arrondir les écarts ferait dériver le
 * tracé, chaque erreur s'ajoutant à la précédente tout au long de la polyligne.
 */
export function encodePolyline(points: readonly Coordinates[]): string {
	let encoded = "";
	let previousLatitude = 0;
	let previousLongitude = 0;

	for (const { latitude, longitude } of points) {
		const scaledLatitude = Math.round(latitude * SCALE);
		const scaledLongitude = Math.round(longitude * SCALE);

		encoded += encodeValue(scaledLatitude - previousLatitude);
		encoded += encodeValue(scaledLongitude - previousLongitude);

		previousLatitude = scaledLatitude;
		previousLongitude = scaledLongitude;
	}

	return encoded;
}

/** Un écart signé, tel qu'il s'écrit : zigzag, tranches de cinq bits, décalage de 63. */
function encodeValue(value: number): string {
	// `<< 1` sur un entier de 32 bits : une shape parcourt au plus quelques dizaines de kilomètres
	// entre deux points, très loin du débordement.
	let remaining = value < 0 ? ~(value << 1) : value << 1;
	let encoded = "";

	while (remaining >= 0x20) {
		encoded += String.fromCharCode((0x20 | (remaining & 0x1f)) + 63);
		remaining >>>= 5;
	}

	return encoded + String.fromCharCode(remaining + 63);
}
