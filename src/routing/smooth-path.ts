import { type Coordinates, haversine, projectOnSegment } from "../utils/geometry.js";

/**
 * Nombre maximal de fois qu'une portée est coupée en deux. Trente-deux points pour huit mètres de
 * rue, c'est déjà bien au-delà de ce qu'une shape peut porter ; le garde-fou n'existe que pour le
 * cas dégénéré — trois points quasi confondus, dont la paramétrisation s'affole.
 */
const MAX_DEPTH = 5;

/**
 * En deçà, deux points consécutifs sont tenus pour confondus. Le routage en produit à chaque
 * raccord de jambe — le projeté du départ tombe sur un sommet de la rue — et une portée de longueur
 * nulle n'a pas de tangente.
 */
const COINCIDENT = 1e-6;

/**
 * Longueur, en kilomètres, en deçà de laquelle on cesse de couper — quoi qu'en dise la tolérance.
 *
 * Ce n'est pas un réglage mais une propriété de la sortie : le GTFS-RT ne transporte une shape qu'en
 * « encoded polyline », dont les coordonnées sont arrondies au cent-millième de degré, soit une
 * grille d'environ 1,1 m en latitude et 0,7 m en longitude à nos latitudes. Des points posés plus
 * serré que ça retombent sur les mêmes mailles : la courbe qu'on aura pris soin de calculer
 * ressortira en marches d'escalier, et l'on aura remplacé des angles francs par un tremblement.
 */
const MIN_SEGMENT = 0.002;

/**
 * Arrondit les angles d'un tracé routier, sans le déplacer.
 *
 * Un giratoire d'une quinzaine de mètres de rayon est décrit dans OpenStreetMap par une dizaine de
 * nœuds : la donnée est fine — trois à neuf mètres entre deux nœuds — mais un petit cercle
 * échantillonné reste un polygone, et chaque sommet y tourne d'une trentaine de degrés. Rendu en
 * chaussée large, l'angle disparaît sous l'épaisseur du trait ; rendu en ligne fine, il se voit.
 *
 * Le remède n'est donc pas de garder PLUS de points d'origine — ils y sont tous — mais d'en
 * INTERPOLER entre eux. La courbe retenue est une spline de Catmull-Rom centripète : elle passe par
 * tous les points d'origine, ce qui garde le tracé sur l'axe de la rue au lieu de couper les
 * virages comme le ferait un lissage par moyennes, et sa paramétrisation en racine des distances la
 * met à l'abri des boucles et des rebroussements que la variante uniforme produit dès que deux
 * points sont très inégalement espacés — ce qui est la règle ici, un raccord de jambe voisinant
 * avec une ligne droite de cinquante mètres.
 *
 * La subdivision est adaptative : une portée n'est coupée que tant que la courbe s'écarte de sa
 * corde de plus de `tolerance`. Une ligne droite ne reçoit donc AUCUN point — l'interpolée y est
 * confondue avec le segment — et seuls les virages s'alourdissent. C'est ce qui rend le geste
 * applicable à tout le tracé sans condition : il n'y a pas de seuil d'angle à partir duquel on
 * lisserait, la platitude décide toute seule.
 *
 * `tolerance` s'exprime en kilomètres, comme toutes les distances du producteur.
 */
export function smoothPath(points: readonly Coordinates[], tolerance: number): Coordinates[] {
	const anchors = withoutDuplicates(points);
	if (anchors.length < 3) return anchors;

	// Les tangentes des deux bouts demandent un point de part et d'autre de la portée. Aux
	// extrémités, il est pris par symétrie du voisin : la courbe y arrive alors droite, là où
	// dupliquer le point donnerait une portée de longueur nulle et une division par zéro.
	const first = reflect(anchors[0] as Coordinates, anchors[1] as Coordinates);
	const last = reflect(anchors[anchors.length - 1] as Coordinates, anchors[anchors.length - 2] as Coordinates);

	const smoothed: Coordinates[] = [anchors[0] as Coordinates];

	for (let index = 0; index < anchors.length - 1; index += 1) {
		const p0 = index === 0 ? first : (anchors[index - 1] as Coordinates);
		const p1 = anchors[index] as Coordinates;
		const p2 = anchors[index + 1] as Coordinates;
		const p3 = index + 2 < anchors.length ? (anchors[index + 2] as Coordinates) : last;

		const span = spanOf(p0, p1, p2, p3);
		subdivide(smoothed, span, 0, p1, 1, p2, tolerance, 0);
	}

	return smoothed;
}

/** Le symétrique de `neighbour` par rapport à `point` : le point fictif qui prolonge le tracé. */
function reflect(point: Coordinates, neighbour: Coordinates): Coordinates {
	return {
		latitude: 2 * point.latitude - neighbour.latitude,
		longitude: 2 * point.longitude - neighbour.longitude,
	};
}

function withoutDuplicates(points: readonly Coordinates[]): Coordinates[] {
	const kept: Coordinates[] = [];

	for (const point of points) {
		const previous = kept[kept.length - 1];
		if (previous !== undefined && haversine(previous, point) < COINCIDENT) continue;
		kept.push(point);
	}

	return kept;
}

/** Une portée de la spline : les quatre points qui la commandent, et leurs nœuds. */
type Span = { points: readonly [Coordinates, Coordinates, Coordinates, Coordinates]; knots: readonly number[] };

/**
 * Les nœuds de la portée, espacés de la RACINE de la distance entre points — c'est ce que veut dire
 * « centripète », et c'est le seul exposant qui garantisse une courbe sans boucle ni point de
 * rebroussement quelle que soit la disposition des quatre points.
 */
function spanOf(p0: Coordinates, p1: Coordinates, p2: Coordinates, p3: Coordinates): Span {
	const t0 = 0;
	const t1 = t0 + Math.sqrt(haversine(p0, p1));
	const t2 = t1 + Math.sqrt(haversine(p1, p2));
	const t3 = t2 + Math.sqrt(haversine(p2, p3));

	return { points: [p0, p1, p2, p3], knots: [t0, t1, t2, t3] };
}

/**
 * Le point de la portée à l'avancement `fraction`, de 0 en `p1` à 1 en `p2`.
 *
 * Trois interpolations linéaires successives entre les quatre points — la pyramide de
 * Barry-Goldman. C'est la forme qui se lit le plus directement sur les nœuds ; la forme
 * développée en polynôme cubique serait plus rapide, mais on en évalue quelques dizaines par
 * virage, pas des millions.
 */
function pointAt(span: Span, fraction: number): Coordinates {
	const [p0, p1, p2, p3] = span.points;
	const [t0, t1, t2, t3] = span.knots as [number, number, number, number];

	const t = t1 + (t2 - t1) * fraction;

	const a1 = between(p0, p1, t0, t1, t);
	const a2 = between(p1, p2, t1, t2, t);
	const a3 = between(p2, p3, t2, t3, t);

	const b1 = between(a1, a2, t0, t2, t);
	const b2 = between(a2, a3, t1, t3, t);

	return between(b1, b2, t1, t2, t);
}

/** Interpolation linéaire entre deux points, repérée sur leurs nœuds. */
function between(from: Coordinates, to: Coordinates, start: number, end: number, at: number): Coordinates {
	// Deux nœuds confondus : des points superposés ont survécu au dédoublonnage, ou la réflexion d'un
	// bout est tombée sur son voisin. On s'en tient au premier point plutôt que de diviser par zéro.
	if (end === start) return from;

	const fraction = (at - start) / (end - start);

	return {
		latitude: from.latitude + (to.latitude - from.latitude) * fraction,
		longitude: from.longitude + (to.longitude - from.longitude) * fraction,
	};
}

/**
 * Coupe la portée en deux tant que la courbe s'écarte de sa corde.
 *
 * Chaque appel se charge d'émettre SON point d'arrivée, jamais son point de départ : celui-ci a été
 * émis par l'appel précédent, ou c'est le premier point du tracé. Les points sortent ainsi dans
 * l'ordre du parcours, sans tri ni recollement.
 */
function subdivide(
	into: Coordinates[],
	span: Span,
	fromFraction: number,
	from: Coordinates,
	toFraction: number,
	to: Coordinates,
	tolerance: number,
	depth: number,
): void {
	const middleFraction = (fromFraction + toFraction) / 2;
	const middle = pointAt(span, middleFraction);

	const flat = projectOnSegment(middle, from, to).offset <= tolerance;
	const tiny = haversine(from, to) <= MIN_SEGMENT;

	if (depth >= MAX_DEPTH || flat || tiny) {
		into.push(to);
		return;
	}

	subdivide(into, span, fromFraction, from, middleFraction, middle, tolerance, depth + 1);
	subdivide(into, span, middleFraction, middle, toFraction, to, tolerance, depth + 1);
}
