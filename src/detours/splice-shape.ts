import { DETOUR_REJOIN_OFFSET } from "../config.js";
import { type Coordinates, projectOnShape, type ShapePoint } from "../utils/geometry.js";
import type { DetourTerminus } from "./store.js";

/** Un tracé à coudre, et le bout de la course qu'il remplace s'il en déclare un. */
export type DrawnPath = { points: readonly Coordinates[]; terminus: DetourTerminus | null };

/**
 * Ce que donne une recouture : le trajet complet, et de quoi juger les raccords.
 *
 * Le seul échec possible est la dégénérescence — aucun tracé exploitable, ou un itinéraire de moins
 * de deux points : il n'y a alors littéralement rien à coudre. Tout le reste est publié : un tracé
 * imparfait vaut mieux qu'une déviation sans tracé, et c'est à l'éditeur, qui montre le résultat, de
 * dire qu'il est imparfait.
 */
export type SpliceOutcome =
	| {
			ok: true;
			points: Coordinates[];
			/**
			 * Pour chaque point du trajet, son rang dans l'itinéraire d'origine s'il en vient, `null` s'il
			 * vient d'un tracé dessiné. C'est ce qui reporte une abscisse de l'itinéraire sur le trajet
			 * recousu (cf. `buildItinerary`).
			 */
			origins: (number | null)[];
			/**
			 * Écart à l'itinéraire du premier point de chaque tracé cousu, en kilomètres, dans l'ordre —
			 * sauf celui qui ouvre la course, qui n'en diverge pas.
			 */
			startOffsets: number[];
			/** Vrai si le trajet revient sur l'itinéraire après le dernier tracé cousu. */
			rejoined: boolean;
			/**
			 * Les tracés laissés de côté : ceux qui venaient après un détour sans retour — la course
			 * s'arrête au terminus provisoire et ne les atteint jamais —, qui remontaient l'itinéraire, ou
			 * qui ouvraient la course après un autre.
			 */
			unreachable: number;
	  }
	| { ok: false; degenerate: true };

/**
 * Recoud les tracés dessinés dans la shape de la course : ce qui précède le premier point de
 * divergence, puis le dessin, puis l'itinéraire jusqu'à la divergence suivante, et ainsi de suite.
 *
 * C'est le trajet COMPLET qu'il faut publier, terminus à terminus, et non les seuls tronçons déviés :
 * `SelectedTrips.shape_id` désigne le chemin que suit le véhicule sur toute la course, et un
 * consommateur qui n'y trouverait que les détours perdrait le tracé de tout le reste. Le découpage ne
 * coûte rien — `ShapePoint.distance` porte déjà l'abscisse curviligne de chaque point.
 *
 * Plusieurs tracés parce qu'une course peut être déviée en plusieurs endroits disjoints : deux
 * chantiers sur le même axe. Ils sont cousus dans l'ordre où la course les rencontre — celui de leur
 * point de divergence sur l'itinéraire —, et non dans celui où ils ont été déclarés : rien ne dit que
 * deux infos trafic se succèdent dans le sens de la marche.
 *
 * Le point de divergence d'un tracé est le projeté de son PREMIER point, et lui seul commande la
 * coupe.
 *
 * La course ne reprend son itinéraire que si le tracé l'a RAMENÉE dessus : son dernier point doit
 * tomber sur la ligne — à moins de {@link DETOUR_REJOIN_OFFSET} — et en aval du point de divergence,
 * faute de quoi la course remonterait. Un tracé qui s'arrête à l'écart de l'itinéraire s'y arrête
 * pour de bon, et le trajet publié s'achève là.
 *
 * Un tracé peut aussi DÉCLARER qu'il remplace un bout de la course, et plus rien ne se devine de sa
 * géométrie à ce bout-là :
 *
 *  - « start » : la course commence à son premier point. Rien de l'itinéraire ne le précède, où qu'il
 *    tombe — c'est un terminus provisoire en amont, ou la ligne prise en cours de route. Il passe
 *    avant tous les autres tracés ; son autre bout rejoint l'itinéraire selon la règle commune ;
 *  - « end » : la course s'achève à son dernier point, même posé sur la ligne — un demi-tour à un
 *    arrêt de l'itinéraire, un terminus provisoire en bord de ligne.
 *
 * Les tracés qui suivaient un tracé sans retour, ou qui en ouvrent un second, sont hors d'atteinte,
 * et {@link SpliceOutcome.unreachable} les compte.
 *
 * Rien n'est refusé pour cause de raccord douteux. Les écarts aux points de divergence sont rapportés
 * ({@link SpliceOutcome.startOffsets}) pour que l'appelant les signale, pas pour qu'il renonce.
 */
export function spliceShape(original: ShapePoint[], drawn: readonly DrawnPath[]): SpliceOutcome {
	if (original.length < 2) return { ok: false, degenerate: true };

	/** Chaque tracé rapporté à l'itinéraire : où il le quitte, où il le rejoint. */
	const projected: {
		points: readonly Coordinates[];
		from: number;
		to: number;
		/** `null` pour un tracé qui ouvre la course : il n'a pas de point de divergence. */
		offset: number | null;
		/** Le tracé ramène-t-il la course sur l'itinéraire ? */
		rejoins: boolean;
	}[] = [];
	let degenerate = 0;

	for (const { points: path, terminus } of drawn) {
		const first = path[0];
		const last = path.at(-1);
		if (first === undefined || last === undefined || path.length < 2) {
			degenerate += 1;
			continue;
		}

		const from = projectOnShape(original, first);
		const to = projectOnShape(original, last);
		if (from === undefined || to === undefined) {
			degenerate += 1;
			continue;
		}

		// Un tracé qui ouvre la course diverge « avant le début » : il passe devant tous les autres, et
		// rien de l'itinéraire ne vient avant lui.
		const opens = terminus === "start";
		projected.push({
			points: path,
			from: opens ? Number.NEGATIVE_INFINITY : from.distance,
			to: to.distance,
			offset: opens ? null : from.offset,
			rejoins: terminus !== "end" && to.offset <= DETOUR_REJOIN_OFFSET && (opens || to.distance > from.distance),
		});
	}

	if (projected.length === 0) return { ok: false, degenerate: true };
	projected.sort((a, b) => a.from - b.from);

	const points: Coordinates[] = [];
	const origins: (number | null)[] = [];
	const keep = (point: ShapePoint, index: number) => {
		points.push({ latitude: point.latitude, longitude: point.longitude });
		origins.push(index);
	};
	const startOffsets: number[] = [];
	let cursor = Number.NEGATIVE_INFINITY;
	/** Faux dès qu'un tracé s'achève sans retour : tout ce qui suit est hors d'atteinte. */
	let open = true;
	let unreachable = degenerate;

	for (const path of projected) {
		// Un tracé qui diverge avant le point où le précédent a rejoint l'itinéraire empiéterait sur lui :
		// la course ne peut pas remonter. On le laisse de côté plutôt que d'écrire un trajet qui revient
		// sur ses pas — le journal le dit, et l'exploitant fusionne ses segments.
		if (!open || path.from < cursor) {
			unreachable += 1;
			continue;
		}

		for (const [index, point] of original.entries()) {
			if (point.distance >= cursor && point.distance < path.from) keep(point, index);
		}
		for (const point of path.points) {
			points.push({ latitude: point.latitude, longitude: point.longitude });
			origins.push(null);
		}
		if (path.offset !== null) startOffsets.push(path.offset);

		if (path.rejoins) cursor = path.to;
		else open = false;
	}

	if (open) {
		for (const [index, point] of original.entries()) {
			if (point.distance > cursor) keep(point, index);
		}
	}

	return { ok: true, points, origins, startOffsets, rejoined: open, unreachable };
}
