import {
	type AlertPeriod,
	type CancelEntry,
	type CancelIndex,
	type CancelWindow,
	emptyCancelIndex,
	type FeedAlert,
	isActive,
	lastPeriodEnd,
	type SkipBucket,
	type SkipIndex,
} from "../gtfs-rt/use-service-alerts.js";
import { courseKey, type RoutePattern, type StaticGtfs } from "../gtfs-rt/use-static-gtfs.js";
import { rangeOn } from "./bounds.js";
import { type AlertOverrides, type DetourStore, type Modification, scopeKey, type TripSet } from "./store.js";

/**
 * Une info trafic telle que l'activation la voit : ce que le flux en dit, ce qu'on en a réglé et
 * saisi, et les modifications qui lui sont associées.
 */
export type ResolvedAlert = {
	/** L'identifiant d'entité du flux amont, que porte `serviceAlertId` ; `null` faute de dernier relevé. */
	alertId: string | null;
	alertNumber: string;
	headerText: string;
	/** Le texte de l'info trafic, en HTML brut. */
	descriptionText: string;
	routeIds: string[];
	/**
	 * Au flux amont en ce moment. Sinon, elle a été créée à la main (`custom`), ou elle n'est là que parce
	 * que des modifications lui restent associées.
	 */
	inFeed: boolean;
	/** Créée à la main : rien du flux amont ne la concerne, tout en est saisi. */
	custom: boolean;
	/** Depuis quand une info trafic créée à la main est publiée ; `null` : brouillon, ou pas créée à la main. */
	publishedAt: number | null;
	/** Quand une info trafic créée à la main se dépubliera d'elle-même ; `null` : jamais, ou pas créée à la main. */
	unpublishAt: number | null;
	/** Dépubliée (brouillon, pour une info trafic créée à la main) : sans aucun effet, et plus republiée. */
	hidden: boolean;
	/** Au flux ou créée à la main, et publiée : ses périodes, et elles seules, décident de ce qu'elle active. */
	effective: boolean;
	/** Les périodes saisies, sinon celles que la source annonce. */
	periods: AlertPeriod[];
	/** Celles que la source annonce, saisies ou non. */
	sourcePeriods: AlertPeriod[];
	periodsOverridden: boolean;
	/** Effective, et l'une de ses périodes couvre l'instant de l'indexation. */
	active: boolean;
	/** Les arrêts qu'elle supprime, saisis à la main, ligne par ligne et sens par sens. */
	skips: AlertSkip[];
	/** Les modifications qui lui sont associées. */
	modificationUids: number[];
	/** Les ensembles de courses qu'elle annule, chaque jour où elle vaut. */
	tripSets: readonly TripSet[];
	/** Ce qui se réécrit de l'alerte republiée. */
	overrides: AlertOverrides;
	/** Première apparition : l'ordre chronologique. */
	firstSeenAt: number;
};

/**
 * Des quais supprimés sur une ligne et dans un sens, saisis à la main. Ils sautent tant que l'info
 * trafic vaut, sauf remplacés par une déviation associée sur cette ligne et dans ce sens : c'est alors
 * elle qui dit quels arrêts sont supprimés.
 */
export type AlertSkip = {
	routeId: string;
	directionId: number;
	/** Ce qui saute. */
	stopIds: string[];
	/** Les déviations associées qui portent la même ligne et le même sens. */
	replacedBy: number[];
};

/**
 * Une info trafic associée, telle qu'une modification la cite. `active` : effective, et l'une des
 * périodes de la modification à son titre — les siennes propres, sinon celles de l'info trafic —
 * couvre l'instant de l'indexation.
 */
export type AlertLink = Pick<
	ResolvedAlert,
	"alertNumber" | "headerText" | "inFeed" | "custom" | "hidden" | "active"
> & {
	/** La modification a, au titre de cette info trafic, ses périodes propres. */
	periodsOverridden: boolean;
};

/**
 * Une modification telle que tout le reste la voit : ce qui a été saisi, et ce que ses infos trafic
 * associées — ou son activation à la main — en font.
 */
export type ResolvedModification = {
	uid: number;
	description: string | null;
	routeId: string;
	directionId: number;
	/** Les tracés visés, ou aucun pour tous. */
	patternIds: string[];
	/** Activée à la main : elle vaut, quoi que deviennent ses infos trafic. */
	manual: boolean;
	/** Ses infos trafic associées, au flux ou non. */
	alerts: AlertLink[];
	/**
	 * L'info trafic que cite son `serviceAlertId` : la première associée qui est en vigueur, à défaut
	 * la première effective ; `null` s'il n'y en a aucune.
	 */
	alertId: string | null;
	/**
	 * Aucune, donc sans fin, pour une modification activée à la main ; sinon la réunion, sur ses infos
	 * trafic effectives, de ses périodes propres à chacune ou à défaut des périodes de celle-ci — sans
	 * fin dès que l'une de ces listes est vide.
	 */
	periods: AlertPeriod[];
	/** Vrai lorsqu'elle vaut à l'instant de l'indexation. */
	active: boolean;
	/**
	 * Ne publie rien — ni tronçon, ni arrêt sauté, ni course annulée : ni activée à la main, ni associée à
	 * une info trafic effective.
	 */
	silent: boolean;
	/**
	 * La période de communication de ses trip modifications, en secondes epoch : de son dernier
	 * enregistrement à la fin de sa dernière période, exclue — `null` si rien ne la borne. Ce n'est
	 * que pendant celle-ci qu'elles sortent dans le feed, pour les courses qui passent pendant l'une
	 * des périodes (cf. `buildDetourEntities`).
	 */
	communication: { start: number; end: number | null };
	/**
	 * Ses tronçons écrasés à l'instant de l'indexation : rang du tronçon → tracés sur lesquels un
	 * tronçon plus prioritaire, actif, en recouvre la plage (cf. `resolveOverrides`).
	 */
	overridden: Map<number, Set<string>>;
	/** Les quais supprimés. */
	removedStopIds: Set<string>;
	/** Ce qui a été saisi, tel quel. */
	record: Modification;
};

export type ModificationIndex = ReturnType<typeof useModificationIndex>;

/**
 * Les modifications et les infos trafic résolues, les arrêts à sauter et les courses à annuler —
 * rebâtis d'un bloc.
 *
 * `reindex` est purement local : il relit le dernier relevé et la base, sans toucher au réseau. Il se
 * rejoue donc à chaque relevé d'infos trafic, à chaque minute, comme après chaque saisie.
 */
export function useModificationIndex(
	store: DetourStore,
	gtfs: { data: StaticGtfs },
	alerts: () => readonly FeedAlert[],
) {
	const resource = {
		/** Les modifications, par uid. */
		modifications: new Map<number, ResolvedModification>(),
		/** Les infos trafic du flux, et celles qui l'ont quitté en gardant des modifications associées, par numéro. */
		alerts: new Map<string, ResolvedAlert>(),
		/** Les quais à sauter dans les trip updates, chacun avec ses périodes (cf. `SkipBucket`). */
		skipIndex: new Map() as SkipIndex,
		/** Les courses à annuler, par clé de course ou par tranche horaire. */
		cancelIndex: emptyCancelIndex(),
		reindex() {
			const now = Temporal.Now.instant();
			const current = alerts();

			store.recordAlerts(current, Math.floor(now.epochMilliseconds / 1000));

			const indexed = indexModifications(current, store, gtfs.data, now);
			resource.modifications = indexed.modifications;
			resource.alerts = indexed.alerts;
			resource.skipIndex = indexed.skipIndex;
			resource.cancelIndex = indexed.cancelIndex;
		},
	};

	resource.reindex();
	return resource;
}

// ---

/**
 * Résout les infos trafic, puis les modifications, et en tire les arrêts à sauter et les courses à
 * annuler.
 *
 * Une info trafic sortie du flux n'active plus rien : ses associations restent en base, et elle reste
 * listée d'après son dernier relevé tant qu'il lui en reste — le réseau remplace souvent une info
 * trafic par une autre, sous un autre numéro, avant la fin de la perturbation, et il n'y a alors qu'à
 * associer la nouvelle.
 *
 * La priorité départage les tronçons qui se recouvrent (cf. `resolveOverrides`) : une déviation qui
 * en recouvre une autre le temps d'un chantier l'emporte, sans que les deux se replient l'une dans
 * l'autre. Le reste de la modification écrasée — ses autres tronçons, ses arrêts supprimés ailleurs, ses
 * courses annulées — continue de s'appliquer.
 *
 * Ce départage-ci se fait à l'instant de l'indexation : il dit à l'interface ce qui est écrasé en ce
 * moment, et borne les arrêts sautés des trip updates. Les trip modifications, publiées des jours à
 * l'avance, le refont course par course (cf. `yieldToPriority`).
 */
function indexModifications(
	current: readonly FeedAlert[],
	store: DetourStore,
	gtfs: StaticGtfs,
	now: Temporal.Instant,
) {
	const nowSeconds = Math.floor(now.epochMilliseconds / 1000);
	const records = [...store.modifications.values()];
	const live = new Set(current.map((alert) => alert.alertNumber));

	// Celles du flux, puis celles créées à la main, puis celles qui ont quitté le flux et que des
	// modifications citent encore.
	const sources: { alert: FeedAlert; inFeed: boolean; custom: boolean }[] = current.map((alert) => ({
		alert,
		inFeed: true,
		custom: false,
	}));
	for (const alertNumber of store.customAlerts.keys()) {
		const { overrides } = store.alertSettings(alertNumber);
		sources.push({
			// Rien n'est reçu : tout ce qui vaut se saisit, et se trouve dans ses réglages.
			alert: {
				alertId: alertNumber,
				alertNumber,
				headerText: overrides.headerText ?? "",
				descriptionText: overrides.descriptionText ?? "",
				periods: [],
				routeIds: [],
			},
			inFeed: false,
			custom: true,
		});
	}
	const withdrawn = new Set(
		records
			.flatMap((record) => record.alertNumbers)
			.filter((number) => !live.has(number) && !store.customAlerts.has(number)),
	);
	for (const alertNumber of withdrawn) {
		const alert = store.alertSnapshots.get(alertNumber) ?? {
			alertId: null,
			alertNumber,
			headerText: store.alertHeaders.get(alertNumber) ?? "",
			descriptionText: "",
			periods: [],
			routeIds: [],
		};
		sources.push({ alert, inFeed: false, custom: false });
	}

	const alerts = new Map<string, ResolvedAlert>();
	for (const { alert, inFeed, custom } of sources) {
		const settings = store.alertSettings(alert.alertNumber);
		const periods = settings.periods ?? alert.periods;
		const effective = (inFeed || custom) && !settings.hidden;
		const associated = records.filter((record) => record.alertNumbers.includes(alert.alertNumber));

		alerts.set(alert.alertNumber, {
			alertId: alert.alertId,
			alertNumber: alert.alertNumber,
			headerText: alert.headerText,
			descriptionText: alert.descriptionText,
			// Un impact réécrit dit à lui seul quelles lignes l'info trafic touche.
			routeIds:
				settings.impact === null
					? alert.routeIds
					: [
							...new Set(
								settings.impact.entities.flatMap(({ routeId }) =>
									routeId !== null && gtfs.routeDirections.has(routeId) ? [routeId] : [],
								),
							),
						],
			inFeed,
			custom,
			publishedAt: store.customAlerts.get(alert.alertNumber)?.publishedAt ?? null,
			unpublishAt: store.customAlerts.get(alert.alertNumber)?.unpublishAt ?? null,
			hidden: settings.hidden,
			effective,
			periods,
			sourcePeriods: alert.periods,
			periodsOverridden: settings.periods !== null,
			active: effective && isActive(periods, now),
			skips: skipsOf(alert.alertNumber, associated, store),
			modificationUids: associated.map((record) => record.uid),
			tripSets: store.alertTripSets(alert.alertNumber),
			overrides: settings.overrides,
			firstSeenAt: store.alertFirstSeen.get(alert.alertNumber) ?? nowSeconds,
		});
	}

	const modifications = new Map<number, ResolvedModification>();
	for (const record of records) {
		const linked = record.alertNumbers.flatMap((alertNumber) => {
			const alert = alerts.get(alertNumber);
			return alert === undefined ? [] : [alert];
		});
		const effective = linked.filter((alert) => alert.effective);
		const silent = !record.manual && effective.length === 0;
		// Au titre d'une info trafic, ses périodes propres si elle en a, sinon celles de l'info trafic. Les
		// unes comme les autres ne valent que tant que l'info trafic est effective.
		const periodsFor = (alert: ResolvedAlert): AlertPeriod[] =>
			record.alertPeriods.get(alert.alertNumber) ?? alert.periods;
		const linkActive = (alert: ResolvedAlert) => alert.effective && isActive(periodsFor(alert), now);
		// Une liste sans période vaut tant que l'info trafic est au flux : la réunion n'a alors plus de borne.
		const periods =
			record.manual || effective.some((alert) => periodsFor(alert).length === 0) ? [] : effective.flatMap(periodsFor);
		const end = lastPeriodEnd(periods);

		modifications.set(record.uid, {
			uid: record.uid,
			description: record.description,
			routeId: record.routeId,
			directionId: record.directionId,
			patternIds: record.patternIds,
			manual: record.manual,
			alerts: linked.map((alert) => ({
				alertNumber: alert.alertNumber,
				headerText: alert.headerText,
				inFeed: alert.inFeed,
				custom: alert.custom,
				hidden: alert.hidden,
				active: linkActive(alert),
				periodsOverridden: record.alertPeriods.has(alert.alertNumber),
			})),
			alertId: (effective.find(linkActive) ?? effective[0])?.alertId ?? null,
			periods,
			active: !silent && isActive(periods, now),
			silent,
			communication: {
				start: record.updatedAt,
				end: end === null ? null : Math.floor(end.epochMilliseconds / 1000),
			},
			overridden: new Map(),
			removedStopIds: new Set(record.removedStopIds),
			record,
		});
	}

	const skipIndex: SkipIndex = new Map();
	const cancelIndex: CancelIndex = emptyCancelIndex();
	const pushSkip = (routeId: string, bucket: SkipBucket) => {
		const buckets = skipIndex.get(routeId) ?? [];
		buckets.push(bucket);
		skipIndex.set(routeId, buckets);
	};

	// Ce que l'info trafic porte elle-même — ses arrêts supprimés, sauf remplacés, et ses courses
	// annulées —, tant qu'elle est effective. Les annulations ne se jaugent pas maintenant mais
	// course par course, à son départ (cf. `isCancelled`).
	for (const alert of alerts.values()) {
		if (!alert.effective) continue;
		for (const set of alert.tripSets) {
			pushCancellations(cancelIndex, set.routeId, set.directionId, [set], { patternIds: null, periods: alert.periods });
		}
		for (const skip of alert.skips) {
			if (skip.replacedBy.length > 0 || skip.stopIds.length === 0) continue;
			pushSkip(skip.routeId, {
				directionId: skip.directionId,
				patternIds: null,
				periods: alert.periods,
				stopIds: new Set(skip.stopIds),
			});
		}
	}

	const contenders = [...modifications.values()].filter((modification) => modification.active);
	const yielded = resolveOverrides(contenders, gtfs);

	for (const modification of modifications.values()) {
		const { record, periods, removedStopIds, silent } = modification;
		// Muette, elle ne fait rien sauter ni n'annule rien. Hors période, si : ses arrêts ne sautent que
		// sur les courses qui passent à leurs bornes pendant l'une de ses périodes, et le feed porte les
		// vingt-quatre heures à venir.
		if (silent) continue;
		const patternIds = record.patternIds.length === 0 ? null : new Set(record.patternIds);

		// Ses annulations se jaugent course par course, comme celles des infos trafic, sur ses seuls tracés.
		// Aucun tronçon ne les écrase : une priorité départage des tracés, pas des services.
		pushCancellations(cancelIndex, record.routeId, record.directionId, record.tripSets, { patternIds, periods });

		if (removedStopIds.size > 0) {
			const ceded = yielded.get(record.uid);
			if (ceded === undefined) {
				pushSkip(record.routeId, { directionId: record.directionId, patternIds, periods, stopIds: removedStopIds });
			} else {
				// Là où l'un de ses tronçons est écrasé, c'est la modification prioritaire qui dit quels
				// arrêts sont desservis : tracé par tracé, ses arrêts supprimés s'arrêtent à cette plage.
				for (const pattern of patternsOf(gtfs, modification)) {
					const zone = ceded.get(pattern.patternId);
					const stopIds =
						zone === undefined ? removedStopIds : new Set([...removedStopIds].filter((stopId) => !zone.has(stopId)));
					if (stopIds.size === 0) continue;
					pushSkip(record.routeId, {
						directionId: record.directionId,
						patternIds: new Set([pattern.patternId]),
						periods,
						stopIds,
					});
				}
			}
		}
	}

	console.log(
		`✓ ${modifications.size} modifications and ${alerts.size} alerts indexed (${skipIndex.size} routes with skipped stops, ${cancelIndex.courses.size} cancelled departures, ${cancelIndex.windows.size} routes with cancelled ranges).`,
	);

	return { modifications, alerts, skipIndex, cancelIndex };
}

/** Verse dans l'index les ensembles cochés d'une ligne et d'un sens, chacun valant `entry`. */
function pushCancellations(
	index: CancelIndex,
	routeId: string,
	directionId: number,
	sets: readonly Pick<TripSet, "enabled" | "selection">[],
	entry: CancelEntry,
) {
	for (const { enabled, selection } of sets) {
		if (!enabled) continue;
		if (selection.kind === "range") {
			const key = `${routeId}|${directionId}`;
			const window: CancelWindow = { ...entry, from: selection.from, to: selection.to };
			index.windows.set(key, [...(index.windows.get(key) ?? []), window]);
			continue;
		}
		for (const { stopId, departure } of selection.departures) {
			const key = courseKey(routeId, directionId, stopId, departure);
			index.courses.set(key, [...(index.courses.get(key) ?? []), entry]);
		}
	}
}

/**
 * Les arrêts qu'une info trafic supprime, par ligne et par sens, tels qu'on les a saisis. La maille est
 * le sens : c'est celle d'une déviation, qui peut les remplacer.
 */
function skipsOf(alertNumber: string, associated: readonly Modification[], store: DetourStore): AlertSkip[] {
	const byScope = new Map<string, AlertSkip>();
	for (const { routeId, directionId, stopId, removed } of store.alertSkipStops(alertNumber)) {
		if (!removed) continue;
		const key = scopeKey(alertNumber, routeId, directionId);
		let skip = byScope.get(key);
		if (skip === undefined) {
			skip = {
				routeId,
				directionId,
				stopIds: [],
				replacedBy: associated
					.filter((record) => record.routeId === routeId && record.directionId === directionId)
					.map((record) => record.uid),
			};
			byScope.set(key, skip);
		}
		if (!skip.stopIds.includes(stopId)) skip.stopIds.push(stopId);
	}
	return [...byScope.values()];
}

/** La plage d'un tronçon sur un tracé : les rangs de ses deux bornes dans la suite de ses arrêts. */
type Placement = { uid: number; rank: number; priority: number; start: number; end: number };

/**
 * Tranche, tracé par tracé, entre les tronçons en vigueur qui se recouvrent — qui ont au moins un
 * arrêt de leur plage en commun sur un tracé qu'ils visent tous deux. Le plus prioritaire reste,
 * l'autre est écrasé sur ce tracé ; à priorité égale, ils restent tous deux, et la publication les
 * fusionne comme avant (cf. `mergeOverlaps`). Un tronçon qui ne recouvre rien de plus prioritaire
 * n'est jamais touché, fût-il d'une modification dont un autre tronçon l'est.
 *
 * On tranche du plus prioritaire au moins prioritaire, et seul un tronçon qui reste peut en écraser
 * un autre : un tronçon écrasé n'emporte pas avec lui ceux qu'il aurait recouverts.
 *
 * Marque les tronçons écrasés sur leur modification (`overridden`), et rend, pour chaque modification
 * qui en a, les arrêts qu'elle cède sur chaque tracé : la plage de son tronçon écrasé et celle du
 * tronçon qui l'écrase, bout à bout.
 */
function resolveOverrides(
	contenders: readonly ResolvedModification[],
	gtfs: StaticGtfs,
): Map<number, Map<string, Set<string>>> {
	const yielded = new Map<number, Map<string, Set<string>>>();
	const byRouteDirection = new Map<string, ResolvedModification[]>();
	for (const modification of contenders) {
		const key = `${modification.routeId}|${modification.directionId}`;
		byRouteDirection.set(key, [...(byRouteDirection.get(key) ?? []), modification]);
	}

	for (const group of byRouteDirection.values()) {
		const { routeId, directionId } = group[0] as ResolvedModification;
		const byUid = new Map(group.map((modification) => [modification.uid, modification]));

		for (const pattern of gtfs.routePatterns.get(routeId)?.get(directionId) ?? []) {
			const placements = group
				.flatMap((modification) => placementsOn(modification, pattern))
				.sort((a, b) => b.priority - a.priority);

			const kept: Placement[] = [];
			for (const placement of placements) {
				const winner = kept.find((other) => other.priority > placement.priority && overlaps(other, placement));
				if (winner === undefined) {
					kept.push(placement);
					continue;
				}

				const modification = byUid.get(placement.uid) as ResolvedModification;
				const patterns = modification.overridden.get(placement.rank) ?? new Set<string>();
				patterns.add(pattern.patternId);
				modification.overridden.set(placement.rank, patterns);

				const ceded = yielded.get(placement.uid) ?? new Map<string, Set<string>>();
				const zone = ceded.get(pattern.patternId) ?? new Set<string>();
				const from = Math.min(placement.start, winner.start);
				const to = Math.max(placement.end, winner.end);
				for (const stop of pattern.stops.slice(from, to + 1)) zone.add(stop.stopId);
				ceded.set(pattern.patternId, zone);
				yielded.set(placement.uid, ceded);
			}
		}
	}

	return yielded;
}

/**
 * Deux modifications ont-elles des tronçons qui se recouvrent, sur un tracé qu'elles visent toutes
 * deux ? C'est là, et là seulement, que leur priorité départage — quelles que soient leurs périodes.
 */
export function collides(a: ResolvedModification, b: ResolvedModification, gtfs: StaticGtfs): boolean {
	if (a.routeId !== b.routeId || a.directionId !== b.directionId) return false;
	return patternsOf(gtfs, a).some((pattern) => {
		const theirs = placementsOn(b, pattern);
		return placementsOn(a, pattern).some((mine) => theirs.some((other) => overlaps(mine, other)));
	});
}

/** Les tracés du sens que vise une modification — aucun tracé nommé les vise tous. */
function patternsOf(gtfs: StaticGtfs, modification: ResolvedModification): RoutePattern[] {
	const patterns = gtfs.routePatterns.get(modification.routeId)?.get(modification.directionId) ?? [];
	if (modification.patternIds.length === 0) return patterns;
	return patterns.filter((pattern) => modification.patternIds.includes(pattern.patternId));
}

/**
 * Les plages des tronçons d'une modification sur un tracé : aucune s'il n'est pas visé, ni pour un
 * tronçon dont le tracé ne porte pas les deux bornes dans l'ordre — il ne s'y applique pas. Sans
 * borne aval, la plage va jusqu'au bout du tracé (cf. `rangeOn`).
 */
function placementsOn(modification: ResolvedModification, pattern: RoutePattern): Placement[] {
	if (modification.patternIds.length > 0 && !modification.patternIds.includes(pattern.patternId)) return [];

	const placements: Placement[] = [];
	modification.record.segments.forEach((segment, rank) => {
		const range = rangeOn(pattern.stops, segment);
		if (range === undefined) return;
		placements.push({ uid: modification.uid, rank, priority: modification.record.priority, ...range });
	});
	return placements;
}

/** Deux plages ont-elles au moins un arrêt en commun ? */
function overlaps(a: Placement, b: Placement): boolean {
	return a.start <= b.end && b.start <= a.end;
}
