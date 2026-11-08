import type { OrderedStop, RoutePattern, StaticGtfs } from "../gtfs-rt/use-static-gtfs.js";

/**
 * Les bornes d'un tronçon dévié, telles qu'un itinéraire de la ligne les donne.
 *
 * Elles désignent les arrêts SUPPRIMÉS eux-mêmes, premier et dernier, bornes incluses : c'est ce que
 * demande `Modification.start_stop_selector` — « le sélecteur du premier arrêt affecté », la sélection
 * allant jusqu'à `end_stop_selector` compris. Les arrêts de substitution remplacent ce segment.
 *
 * L'arrêt de référence, lui, est celui qui PRÉCÈDE la borne amont sur l'itinéraire : c'est depuis son
 * arrivée que se comptent les `travel_time_to_stop` des arrêts de substitution. Il n'existe pas
 * lorsque la déviation commence au premier arrêt de l'itinéraire — la référence est alors ce premier
 * arrêt, et les temps peuvent être négatifs, seul cas où la spec l'admet.
 */
export type DetourBounds = {
	/** Le rang de l'itinéraire d'où ces bornes sont tirées : les rangs d'un autre ne veulent rien dire. */
	itinerary: number;
	startStopId: string;
	endStopId: string;
	/** L'arrêt d'où se comptent les temps de parcours, ou `null` si la déviation ouvre l'itinéraire. */
	referenceStopId: string | null;
	/** Les quais supprimés que ce tronçon couvre, dans l'ordre de parcours. */
	removedStopIds: string[];
	/** Nombre d'arrêts que les bornes englobent — pour un tronçon, autant que de supprimés. */
	span: number;
	/** Vrai lorsque la borne amont ouvre l'itinéraire — il n'y a alors pas d'arrêt de référence. */
	opensRoute: boolean;
};

/**
 * Les tronçons que chaque itinéraire de la ligne/sens propose, du mieux couvert au moins bien.
 *
 * Une ligne a plusieurs itinéraires par sens — branches, services partiels —, et ils ne voient pas
 * les mêmes arrêts supprimés : les index relevés sur l'un ne veulent rien dire sur l'autre, et il ne
 * faut surtout pas les réunir. On les traite donc séparément, et on classe par nombre d'arrêts
 * supprimés couverts : celui qui en voit le plus décrit le tronçon réellement dévié, les autres sont
 * des branches qui n'en effleurent qu'une partie.
 *
 * Un itinéraire donne AUTANT DE TRONÇONS qu'il y a de suites d'arrêts supprimés séparées par des
 * arrêts encore desservis : une info trafic qui coupe la ligne en deux endroits distincts ne décrit
 * pas une seule déviation, et des bornes qui engloberaient tout supprimeraient au passage ce qui est
 * resté ouvert. Ils sortent dans l'ordre de parcours, prêts à devenir autant de segments.
 *
 * `removedStopIds` porte TOUS les quais du nom supprimé, les deux sens confondus — c'est délibéré en
 * amont (cf. `resolveRemovedStop`). L'intersection avec l'itinéraire du sens fait le tri toute
 * seule : il ne faut jamais chercher le voisin « d'avant » par son nom.
 *
 * Une modification qui ne vise que certains tracés ne regarde qu'eux : ce sont leurs arrêts qui
 * bornent ses tronçons, et une autre branche mieux couverte n'a rien à lui dicter.
 */
export function deduceBounds(
	gtfs: StaticGtfs,
	routeId: string,
	directionId: number,
	removedStopIds: ReadonlySet<string>,
	patternIds: readonly string[],
): DetourBounds[] {
	const candidates: DetourBounds[] = [];
	/** Combien d'arrêts supprimés chaque itinéraire dessert : c'est lui qui classe ses tronçons. */
	const coverage = new Map<number, number>();

	const sequences =
		patternIds.length === 0
			? (gtfs.routeStopSequences.get(routeId)?.get(directionId) ?? [])
			: (gtfs.routePatterns.get(routeId)?.get(directionId) ?? [])
					.filter((pattern) => patternIds.includes(pattern.patternId))
					.map((pattern) => pattern.stops);

	for (const [itinerary, sequence] of sequences.entries()) {
		const runs = boundsOn(sequence, removedStopIds, itinerary);
		coverage.set(
			itinerary,
			runs.reduce((total, run) => total + run.removedStopIds.length, 0),
		);
		candidates.push(...runs);
	}

	return candidates.sort(
		(a, b) => (coverage.get(b.itinerary) ?? 0) - (coverage.get(a.itinerary) ?? 0) || a.itinerary - b.itinerary,
	);
}

/**
 * Ce tronçon supprime-t-il des arrêts ?
 *
 * Il le fait dès que sa plage — bornes comprises — porte un arrêt que l'info trafic supprime dans ce
 * sens. Sinon il n'en supprime aucun : le véhicule passe ailleurs entre deux arrêts qu'il dessert
 * toujours : sa `Modification` ne désigne que sa borne amont, sans rien remplacer — des sélecteurs qui
 * engloberaient des arrêts encore desservis mentiraient. Elle publie son tracé et son délai propagé.
 *
 * Rien ne se déclare donc de plus : la nature d'un tronçon se lit du périmètre et des bornes, qui
 * sont déjà saisis. Ne cocher aucun arrêt supprimé, c'est dire que la desserte ne change pas.
 *
 * Un tronçon sans borne aval n'en supprime jamais : il ne dit qu'où le chemin change, jusqu'au bout
 * de la course — un tracé repris, une course rallongée. Supprimer jusqu'au terminus de chaque course,
 * c'est l'affaire d'un tronçon dont on choisit le dernier arrêt.
 *
 * Les bornes sont éprouvées d'abord pour elles-mêmes : une borne supprimée suffit, quand bien même
 * aucun itinéraire de la ligne ne porterait les deux — une branche que le GTFS a renumérotée.
 *
 * Seuls comptent les tracés que la modification vise : la plage ne dit rien des courses qu'elle ne
 * touche pas.
 */
export function removesStops(
	gtfs: StaticGtfs,
	routeId: string,
	directionId: number,
	patternIds: readonly string[],
	removedStopIds: ReadonlySet<string>,
	segment: SegmentBounds,
): boolean {
	const { startStopId, endStopId } = segment;
	if (startStopId === null || endStopId === null || removedStopIds.size === 0) return false;
	if (removedStopIds.has(startStopId) || removedStopIds.has(endStopId)) return true;

	for (const { stops: sequence } of patternsOf(gtfs, routeId, directionId, patternIds)) {
		const range = rangeOn(sequence, segment);
		if (range === undefined) continue;

		for (let index = range.start; index <= range.end; index += 1) {
			if (removedStopIds.has((sequence[index] as OrderedStop).stopId)) return true;
		}
	}

	return false;
}

/**
 * Les deux tronçons d'une déclaration dont les plages se recoupent sur l'un des itinéraires de la
 * ligne, ou `undefined` s'il n'y en a aucun.
 *
 * Deux tronçons superposés supprimeraient deux fois les mêmes arrêts, et la spécification ne dit pas
 * ce qu'un consommateur devrait en faire. Entre deux infos trafic la publication sait les replier ;
 * dans une même déclaration, c'est une erreur de saisie — celui qui saisit voit les deux et peut les
 * fondre en un seul.
 *
 * Un chevauchement sur UN SEUL des tracés visés suffit à refuser : c'est bien deux tronçons
 * superposés sur les courses de ce tracé.
 */
export function overlappingSegments(
	gtfs: StaticGtfs,
	routeId: string,
	directionId: number,
	patternIds: readonly string[],
	bounds: readonly SegmentBounds[],
): [number, number] | undefined {
	for (const { stops: sequence } of patternsOf(gtfs, routeId, directionId, patternIds)) {
		const ranges = bounds.map((segment) => rangeOn(sequence, segment));

		for (let first = 0; first < ranges.length; first += 1) {
			const a = ranges[first];
			if (a === undefined) continue;

			for (let second = first + 1; second < ranges.length; second += 1) {
				const b = ranges[second];
				if (b === undefined) continue;
				if (a.start <= b.end && b.start <= a.end) return [first, second];
			}
		}
	}

	return undefined;
}

/**
 * Les bornes d'un tronçon. Sans borne amont, il n'est pas arrêté ; sans borne aval, sa plage court
 * jusqu'au dernier arrêt de chaque course (cf. `rangeOn`).
 */
export type SegmentBounds = { startStopId: string | null; endStopId: string | null };

/**
 * La plage d'un tronçon sur une suite d'arrêts — un tracé, l'horaire d'une course : les rangs de ses
 * deux bornes, ou `undefined` si la suite ne les porte pas dans l'ordre. Sans borne aval, la plage
 * finit au dernier arrêt de la suite : c'est le bout de CETTE course, quel qu'il soit.
 */
export function rangeOn(
	sequence: readonly { stopId: string }[],
	segment: SegmentBounds,
): { start: number; end: number } | undefined {
	if (segment.startStopId === null) return undefined;
	const start = sequence.findIndex((stop) => stop.stopId === segment.startStopId);
	const end =
		segment.endStopId === null ? sequence.length - 1 : sequence.findIndex((stop) => stop.stopId === segment.endStopId);
	return start === -1 || end === -1 || start > end ? undefined : { start, end };
}

/** Ces tracés visés comprennent-ils celui-ci ? Aucun tracé nommé, c'est les viser tous. */
export function targets(patternIds: readonly string[], patternId: string): boolean {
	return patternIds.length === 0 || patternIds.includes(patternId);
}

/** Les tracés du sens que la modification vise. */
export function patternsOf(
	gtfs: StaticGtfs,
	routeId: string,
	directionId: number,
	patternIds: readonly string[],
): RoutePattern[] {
	return (gtfs.routePatterns.get(routeId)?.get(directionId) ?? []).filter((pattern) =>
		targets(patternIds, pattern.patternId),
	);
}

/** Les tronçons d'un itinéraire donné : une suite d'arrêts supprimés sans interruption en donne un. */
function boundsOn(sequence: OrderedStop[], removedStopIds: ReadonlySet<string>, itinerary: number): DetourBounds[] {
	const runs: DetourBounds[] = [];
	let current: number[] = [];

	const flush = () => {
		const first = current[0];
		const last = current.at(-1);
		if (first === undefined || last === undefined) return;

		runs.push({
			itinerary,
			startStopId: (sequence[first] as OrderedStop).stopId,
			endStopId: (sequence[last] as OrderedStop).stopId,
			referenceStopId: sequence[first - 1]?.stopId ?? null,
			removedStopIds: current.map((index) => (sequence[index] as OrderedStop).stopId),
			span: last - first + 1,
			opensRoute: first === 0,
		});
		current = [];
	};

	for (const [index, stop] of sequence.entries()) {
		if (removedStopIds.has(stop.stopId)) current.push(index);
		else flush();
	}
	flush();

	return runs;
}
