import type { ProvisionalStopDto, ProvisionalStopInput } from "@dto";

import type { LatLng } from "@/lib/geometry";

/** Un arrêt provisoire tel que le formulaire le tient : sa position peut manquer tant qu'on ne l'a pas posé. */
export type Draft = Omit<ProvisionalStopInput, "latitude" | "longitude"> & { position: LatLng | null };

export const EMPTY: Draft = {
	name: "",
	stopCode: null,
	description: null,
	zoneId: null,
	parentStation: null,
	wheelchairBoarding: 0,
	platformCode: null,
	position: null,
};

/** L'accessibilité en fauteuil, codée comme `wheelchair_boarding`. */
export const ACCESSIBILITY = [
	{ value: 1, label: "Oui", dot: "bg-info-dot" },
	{ value: 2, label: "Non", dot: "bg-warning-dot" },
	{ value: 0, label: "Inconnue", dot: "bg-neutral-dot" },
] as const;

export function draftOf(stop: ProvisionalStopDto): Draft {
	const { stopId: _, usages: __, latitude, longitude, ...rest } = stop;
	return { ...rest, position: [latitude, longitude] };
}

/** Un champ texte facultatif : vide, il vaut `null`. */
export const optional = (value: string) => (value.trim().length === 0 ? null : value);
