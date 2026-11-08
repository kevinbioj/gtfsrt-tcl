/**
 * L'identifiant d'entité d'une course : « ET:<trip_id>:<AAAAMMJJ> », sa journée de service en suffixe
 * — « ET:<trip_id> » seul tant qu'on ne la connaît pas. La journée en fait partie, comme dans
 * gtfsrt-tcar : deux occurrences d'une même course peuvent figurer ensemble au feed — celle qui roule
 * ce soir et son homonyme de demain, reconstruit depuis le théorique ; celle d'hier qui s'achève après
 * minuit et celle d'aujourd'hui —, et sous un identifiant nu la seconde écraserait la première.
 */
export function tripEntityId(tripId: string, date?: string | null): string {
	return date ? `ET:${tripId}:${date}` : `ET:${tripId}`;
}

/** L'identifiant d'entité d'un véhicule : « VM:<vehicle.id> » — « VM:KEOLIS_LYON:3210 ». */
export function vehicleEntityId(vehicleId: string): string {
	return `VM:${vehicleId}`;
}
