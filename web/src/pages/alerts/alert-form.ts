import type { AlertDto, AlertInputDto, DirectionDto, ImpactEntityDto, RouteDto, StopGroupDto } from "@dto";

import { type PeriodForm, periodForm, periodInput } from "@/components/period-editor";
import { type TripSetForm, tripSetKey } from "@/components/trip-sets";

/** Ce qui se saisit d'une alerte, tel que le formulaire le tient jusqu'à l'enregistrement. */
export type AlertForm = {
	headerText: string;
	descriptionText: string;
	cause: string | null;
	effect: string | null;
	/** Le lien, l'image et son texte alternatif publiés ; `""` : aucun. */
	url: string;
	imageUrl: string;
	imageAlternativeText: string;
	/** `null` : les périodes que la source annonce. */
	periods: PeriodForm[] | null;
	/** « routeId|directionId|stopId » des arrêts supprimés, saisis à la main → vrai. */
	overrides: Record<string, boolean>;
	tripSets: TripSetForm[];
	modifications: number[];
	/** Les périodes propres des modifications associées, par uid ; sans entrée, celles de l'alerte. */
	modificationPeriods: Record<number, PeriodForm[]>;
	/** `null` : l'impact reçu. */
	impact: ImpactEntityDto[] | null;
	/**
	 * Quand une alerte créée à la main se dépubliera d'elle-même, telle que saisie à la main, à l'heure
	 * locale (« AAAA-MM-JJTHH:MM », comme le veut un champ `datetime-local`) ; `""` : jamais. Sans
	 * objet tant qu'elle suit les périodes (cf. {@link unpublishValue}).
	 */
	unpublishAt: string;
	/** La dépublication suit la fin de la dernière période : on n'en a pas saisi d'autre. */
	unpublishFollows: boolean;
};

const pad = (value: number) => String(value).padStart(2, "0");

/** Un instant epoch en secondes, tel qu'un champ `datetime-local` l'affiche : à l'heure locale. */
export function localDateTime(seconds: number): string {
	const date = new Date(seconds * 1000);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** La valeur d'un champ `datetime-local`, lue à l'heure locale, en secondes epoch ; `null` si vide ou illisible. */
export function epochOfLocal(value: string): number | null {
	if (value === "") return null;
	const time = new Date(value).getTime();
	return Number.isNaN(time) ? null : Math.floor(time / 1000);
}

/** « AAAA-MM-JJ » plus un jour. */
function nextDay(date: string): string {
	const [year, month, day] = date.split("-").map(Number);
	return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + 1)).toISOString().slice(0, 10);
}

/**
 * La fin de la dernière période, exclue, à l'heure locale « AAAA-MM-JJTHH:MM » — comme la calcule le
 * serveur (cf. `lastPeriodEnd`) : une fin à la journée couvre tout ce jour, jusqu'au lendemain matin
 * pour une tranche de nuit. `"open"` : l'une court à nouvel avis ; `null` : aucune période.
 */
export function lastPeriodEnd(periods: readonly PeriodForm[]): string | "open" | null {
	let last: string | null = null;
	for (const period of periods) {
		if (period.open || period.end === "") return "open";
		const end = period.end.includes("T")
			? period.end
			: `${nextDay(period.end)}T${period.hours !== null && period.hours.to <= period.hours.from ? period.hours.to : "00:00"}`;
		if (last === null || end > last) last = end;
	}
	return last;
}

/**
 * La dépublication automatique telle qu'elle s'enregistre, à l'heure locale ; `""` : aucune. Jamais
 * quand une période court à nouvel avis ; sinon la fin de la dernière période, sauf à en avoir saisi
 * une autre.
 */
export function unpublishValue(form: AlertForm): string {
	const end = lastPeriodEnd(form.periods ?? []);
	if (end === "open") return "";
	return form.unpublishFollows ? (end ?? "") : form.unpublishAt;
}

export const scopeOf = (group: { routeId: string; directionId: number }) => `${group.routeId}|${group.directionId}`;
export const stopKey = (group: { routeId: string; directionId: number }, stopId: string) =>
	`${scopeOf(group)}|${stopId}`;

/**
 * L'alerte qu'ouvre « Nouvelle alerte », avant tout enregistrement : créée à la main, vide, en
 * brouillon. Son numéro vide dit qu'elle n'existe pas encore — le premier enregistrement la crée.
 */
export function blankAlert(): AlertDto {
	const empty = {
		headerText: "",
		descriptionText: "",
		cause: null,
		effect: null,
		url: null,
		imageUrl: null,
		imageAlternativeText: null,
	};
	return {
		alertNumber: "",
		inFeed: false,
		custom: true,
		publishedAt: null,
		unpublishAt: null,
		hidden: true,
		active: false,
		publication: "draft",
		phase: "current",
		phaseDetail: "",
		received: { ...empty, descriptionHtml: "" },
		published: empty,
		overrides: empty,
		periods: [],
		sourcePeriods: [],
		periodsOverridden: true,
		feedPeriods: { received: [], communication: [], impact: [] },
		lines: [],
		stopGroups: [],
		tripSets: [],
		modifications: [],
		modificationPeriods: {},
		warnings: [],
		firstSeenAt: 0,
		checkedAt: null,
		impact: { received: [], published: [], overridden: false },
	};
}

/** L'alerte n'est-elle pas encore créée (cf. {@link blankAlert}) ? */
export const isUnsaved = (alert: AlertDto) => alert.alertNumber === "";

export function formOf(alert: AlertDto): AlertForm {
	const overrides: Record<string, boolean> = {};
	for (const group of alert.stopGroups) {
		for (const stop of group.stops) if (stop.removed) overrides[stopKey(group, stop.stopId)] = true;
	}
	// Créée à la main, elle n'a d'autres périodes que les siennes, fût-ce aucune.
	const periods = alert.custom || alert.periodsOverridden ? alert.periods.map(periodForm) : null;
	// Une dépublication enregistrée qui tombe à la fin des périodes les suit ; une autre a été saisie. Rien
	// n'a pu l'être tant qu'une période courait à nouvel avis.
	const unpublishAt = alert.unpublishAt === null ? "" : localDateTime(alert.unpublishAt);
	const end = lastPeriodEnd(periods ?? []);
	return {
		headerText: alert.published.headerText,
		descriptionText: alert.published.descriptionText,
		cause: alert.published.cause,
		effect: alert.published.effect,
		url: alert.published.url ?? "",
		imageUrl: alert.published.imageUrl ?? "",
		imageAlternativeText: alert.published.imageAlternativeText ?? "",
		periods,
		overrides,
		tripSets: alert.tripSets.map((set) => ({ ...set, key: tripSetKey() })),
		modifications: [...alert.modifications],
		modificationPeriods: Object.fromEntries(
			Object.entries(alert.modificationPeriods).map(([uid, periods]) => [uid, periods.map(periodForm)]),
		),
		impact: alert.impact.overridden ? alert.impact.published.map((entity) => ({ ...entity })) : null,
		unpublishAt,
		unpublishFollows: end === "open" ? unpublishAt === "" : (end ?? "") === unpublishAt,
	};
}

/**
 * Ce que l'API reçoit : une réécriture identique au texte reçu n'en est pas une. Un lien, une image
 * ou un texte alternatif vidés alors que le flux en porte partent à vide : ils le retirent.
 */
export function inputOf(form: AlertForm, alert: AlertDto): AlertInputDto {
	const differs = <T>(value: T, received: T) => (value === received ? null : value);
	return {
		overrides: {
			headerText: differs(form.headerText.trim(), alert.received.headerText.trim()),
			descriptionText: differs(form.descriptionText.trim(), alert.received.descriptionText.trim()),
			cause: differs(form.cause, alert.received.cause),
			effect: differs(form.effect, alert.received.effect),
			url: differs(form.url.trim(), alert.received.url ?? ""),
			imageUrl: differs(form.imageUrl.trim(), alert.received.imageUrl ?? ""),
			imageAlternativeText: differs(form.imageAlternativeText.trim(), alert.received.imageAlternativeText ?? ""),
		},
		periods: form.periods === null ? null : form.periods.map(periodInput),
		skipStops: Object.entries(form.overrides).flatMap(([key, removed]) => {
			if (!removed) return [];
			const [routeId, directionId, ...rest] = key.split("|");
			return [{ routeId: routeId ?? "", directionId: Number(directionId), stopId: rest.join("|"), removed }];
		}),
		tripSets: form.tripSets.map(({ routeId, directionId, enabled, selection }) => ({
			routeId,
			directionId,
			enabled,
			selection,
		})),
		modificationUids: form.modifications,
		// Celles d'une modification dissociée ne partent pas.
		modificationPeriods: Object.fromEntries(
			form.modifications.flatMap((uid) => {
				const periods = form.modificationPeriods[uid];
				return periods === undefined ? [] : [[uid, periods.map(periodInput)]];
			}),
		),
		impact: form.impact,
		unpublishAt: alert.custom ? epochOfLocal(unpublishValue(form)) : null,
	};
}

/** L'arrêt est-il supprimé ? */
export function isRemoved(form: AlertForm, group: StopGroupDto, stop: { stopId: string }): boolean {
	return form.overrides[stopKey(group, stop.stopId)] === true;
}

/** Bascule un arrêt : supprimé, ou de nouveau desservi. */
export function toggleStop(form: AlertForm, group: StopGroupDto, stopId: string): AlertForm {
	if (!group.stops.some((entry) => entry.stopId === stopId)) return form;
	const key = stopKey(group, stopId);
	const overrides = { ...form.overrides };
	if (isRemoved(form, group, { stopId })) delete overrides[key];
	else overrides[key] = true;
	return { ...form, overrides };
}

/** Rétablit tous les arrêts d'un sens. */
export function clearGroup(form: AlertForm, group: StopGroupDto): AlertForm {
	const prefix = `${scopeOf(group)}|`;
	const overrides = Object.fromEntries(Object.entries(form.overrides).filter(([key]) => !key.startsWith(prefix)));
	return { ...form, overrides };
}

/**
 * Les sens où suggérer une modification : ceux que l'impact cite — tous ceux d'une ligne citée sans
 * sens —, une fois chacun. Les lignes dans l'ordre du réseau (`routes` le suit déjà), les sens par
 * `direction_id`.
 */
export function suggestionsOf(
	impact: ImpactEntityDto[],
	routes: RouteDto[],
): { route: RouteDto; direction: DirectionDto }[] {
	const cited = (routeId: string, directionId: number) =>
		impact.some((entity) => entity.routeId === routeId && (entity.directionId ?? directionId) === directionId);
	return routes.flatMap((route) =>
		route.directions
			.filter((direction) => cited(route.routeId, direction.directionId))
			.sort((a, b) => a.directionId - b.directionId)
			.map((direction) => ({ route, direction })),
	);
}
