import type GtfsRealtime from "gtfs-realtime-bindings";

import { resolveServiceRun, scheduledTripUpdates, serviceDays, tripRun } from "./scheduled-trips.js";
import {
	applySkippedStops,
	type CancelIndex,
	declareCancelled,
	isCancelled,
	type SkipIndex,
} from "./use-service-alerts.js";
import type { StaticGtfs } from "./use-static-gtfs.js";

type TripUpdate = GtfsRealtime.transit_realtime.ITripUpdate;

/**
 * Les trip updates tels qu'ils se publient : ceux de SIRI Lite, corrigés de ce que les modifications et
 * les infos trafic déclarent — courses annulées, arrêts supprimés —, puis ceux que l'horaire théorique
 * doit porter faute que SIRI Lite en parle (cf. `scheduledTripUpdates`).
 *
 * Chaque course de SIRI Lite reçoit au passage la journée de service dont elle relève (`start_date`),
 * que la source ne donne pas : après minuit, celle d'hier est encore ouverte, et une course
 * reconstruite pour ce soir se confondrait sans elle avec celle d'hier soir. Son sens et sa ligne sont
 * ceux du GTFS, auxquels se rapportent les suppressions.
 *
 * `realtime` n'est pas touché : il se reprend tel quel au tour suivant — une saisie, une période qui
 * bascule —, et ce qui s'en déduit change alors.
 *
 * Sans GTFS chargé, rien ne s'en déduit : le temps réel sort tel quel.
 */
export function postProcessTripUpdates(
	realtime: ReadonlyMap<string, TripUpdate>,
	gtfs: StaticGtfs,
	index: { skipIndex: SkipIndex; cancelIndex: CancelIndex },
	nowSeconds: number,
): Map<string, TripUpdate> {
	if (gtfs.trips.size === 0) return new Map(realtime);

	const published = new Map<string, TripUpdate>();
	// Journées de service auxquelles une course annoncée peut appartenir. Le lendemain en fait partie :
	// une course de « 00:20 » annoncée dix minutes plus tôt relève déjà de la journée suivante.
	const days = serviceDays(gtfs, [-1, 0, 1]);
	// Les courses dont SIRI Lite dit quelque chose : celles-là n'ont pas à être reconstruites depuis
	// l'horaire théorique, ce qu'il en annonce l'emportant toujours.
	const covered = new Set<string>();
	let cancelled = 0;
	let unresolved = 0;

	for (const [id, source] of realtime) {
		const tripUpdate = structuredClone(source);
		const tripId = tripUpdate.trip?.tripId ?? undefined;
		const meta = tripId === undefined ? undefined : gtfs.trips.get(tripId);
		// SIRI Lite nomme la bonne version de la course (cf. `resolveServiceRun`) : seule la journée reste
		// à trouver, d'après l'horaire annoncé.
		const run =
			tripId === undefined
				? undefined
				: resolveServiceRun(gtfs, days, tripId, announcedTime(tripUpdate) ?? nowSeconds, { exact: true });
		if (tripId !== undefined && run === undefined) unresolved += 1;

		if (tripUpdate.trip) {
			if (run !== undefined) tripUpdate.trip.startDate = run.date;
			if (meta !== undefined) {
				tripUpdate.trip.routeId = meta.routeId;
				tripUpdate.trip.directionId = meta.directionId;
			}
		}

		const midnight = run === undefined ? undefined : days.find((day) => day.date === run.date)?.midnight;

		// Annulée par une modification ou une info trafic : ce que la source en dit ne tient plus.
		if (tripId !== undefined && run !== undefined && midnight !== undefined) {
			if (isCancelled(index.cancelIndex, gtfs, tripId, midnight)) {
				declareCancelled(tripUpdate);
				published.set(id, tripUpdate);
				covered.add(tripRun(run.tripId, run.date));
				cancelled += 1;
				continue;
			}
		}

		// Les suppressions se jaugent au passage de la course aux bornes de chaque tronçon dévié ; faute de
		// connaître sa journée de service, à son départ, et faute de celui-ci, à l'instant présent.
		const departure = tripId === undefined ? undefined : gtfs.tripDepartures.get(tripId);
		const departsAt = midnight !== undefined && departure !== undefined ? midnight + departure : nowSeconds;
		applySkippedStops(
			tripUpdate,
			tripUpdate.trip?.routeId ?? "",
			index.skipIndex,
			gtfs,
			midnight,
			Temporal.Instant.fromEpochMilliseconds(departsAt * 1000),
		);
		published.set(id, tripUpdate);

		// Une course sans arrêt n'est pas publiée (cf. `createFeed`) : elle ne couvre rien, et c'est
		// l'horaire théorique qui annonce ses suppressions.
		if (run !== undefined && tripUpdate.stopTimeUpdate?.length) covered.add(tripRun(run.tripId, run.date));
	}

	const scheduled = scheduledTripUpdates(gtfs, index.skipIndex, index.cancelIndex, covered, nowSeconds);
	for (const [id, tripUpdate] of scheduled) published.set(id, tripUpdate);

	if (cancelled > 0 || scheduled.size > 0 || unresolved > 0) {
		console.log(
			`\t• ${realtime.size} realtime trip updates (${cancelled} cancelled, ${unresolved} without service day), ${scheduled.size} rebuilt from schedule.`,
		);
	}
	return published;
}

/**
 * Le premier horaire que la source annonce pour cette course, en secondes epoch, ou `undefined` s'il
 * n'en annonce aucun. N'importe lequel de ses arrêts fait l'affaire pour la rapporter à sa journée de
 * service : tous tombent dans le même créneau, et les journées candidates sont distantes de
 * vingt-quatre heures.
 */
function announcedTime(tripUpdate: TripUpdate): number | undefined {
	for (const stopTimeUpdate of tripUpdate.stopTimeUpdate ?? []) {
		const time = Number(stopTimeUpdate.departure?.time ?? stopTimeUpdate.arrival?.time ?? 0);
		if (time > 0) return time;
	}
	return undefined;
}
