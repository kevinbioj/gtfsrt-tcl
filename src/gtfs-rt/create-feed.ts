import GtfsRealtime from "gtfs-realtime-bindings";

const CANCELED = GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED;
const SCHEDULED = GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SCHEDULED;

export function createFeed(
	/** La dernière modification du contenu, en secondes epoch (cf. `useChangeTracker`). */
	timestamp: number,
	tripUpdates: Map<string, GtfsRealtime.transit_realtime.ITripUpdate> | null,
	vehiclePositions: Map<string, GtfsRealtime.transit_realtime.IVehiclePosition> | null,
	/**
	 * Les entités des déviations déclarées — arrêts provisoires, tracés, modifications de course. Déjà
	 * assemblées et ordonnées (cf. `buildDetourEntities`) : elles accompagnent les trip updates, dont
	 * elles disent ce que les arrêts supprimés ne disent pas — par où passe le véhicule à la place.
	 */
	detourEntities: readonly GtfsRealtime.transit_realtime.IFeedEntity[] | null = null,
	/**
	 * Les infos trafic du réseau, republiées sous un identifiant préfixé (cf. `republishedAlertId`) :
	 * ce sont elles que citent les `serviceAlertId` des modifications.
	 */
	alertEntities: readonly GtfsRealtime.transit_realtime.IFeedEntity[] | null = null,
) {
	return GtfsRealtime.transit_realtime.FeedMessage.create({
		header: {
			gtfsRealtimeVersion: "2.0",
			incrementality: GtfsRealtime.transit_realtime.FeedHeader.Incrementality.FULL_DATASET,
			timestamp,
		},
		entity: [
			...(tripUpdates !== null
				? tripUpdates
						.entries()
						// Une course sans arrêt n'a rien à dire — sauf annulée : le descripteur dit tout.
						.flatMap(([id, tripUpdate]) =>
							tripUpdate.stopTimeUpdate?.length || tripUpdate.trip?.scheduleRelationship === CANCELED
								? [{ id, tripUpdate: withScheduleRelationships(tripUpdate) }]
								: [],
						)
						.toArray()
				: []),
			...(vehiclePositions !== null
				? vehiclePositions
						.entries()
						.map(([id, vehicle]) => ({ id, vehicle }))
						.toArray()
				: []),
			...(detourEntities ?? []),
			...(alertEntities ?? []),
		],
	});
}

/**
 * Renseigne `SCHEDULED` sur les arrêts qui ne disent rien de leur desserte — arrêts rendus, courses
 * relayées ou rattachées à l'ancien GTFS-RT. C'est ce que le protobuf sous-entend, mais le JSON le
 * tait, et tous les consommateurs ne s'y fient pas. La course est copiée : celle du store reste
 * telle que la source l'a dite.
 */
function withScheduleRelationships(
	tripUpdate: GtfsRealtime.transit_realtime.ITripUpdate,
): GtfsRealtime.transit_realtime.ITripUpdate {
	if (tripUpdate.stopTimeUpdate?.every(({ scheduleRelationship }) => scheduleRelationship != null) ?? true)
		return tripUpdate;

	return {
		...tripUpdate,
		stopTimeUpdate: tripUpdate.stopTimeUpdate?.map((stopTimeUpdate) =>
			stopTimeUpdate.scheduleRelationship == null
				? { ...stopTimeUpdate, scheduleRelationship: SCHEDULED }
				: stopTimeUpdate,
		),
	};
}
