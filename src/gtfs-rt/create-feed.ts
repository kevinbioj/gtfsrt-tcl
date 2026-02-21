import GtfsRealtime from "gtfs-realtime-bindings";
import { Temporal } from "temporal-polyfill";

export function createFeed(
	tripUpdates: Map<string, GtfsRealtime.transit_realtime.ITripUpdate> | null,
	vehiclePositions: Map<string, GtfsRealtime.transit_realtime.IVehiclePosition> | null,
) {
	return GtfsRealtime.transit_realtime.FeedMessage.create({
		header: {
			gtfsRealtimeVersion: "2.0",
			incrementality: GtfsRealtime.transit_realtime.FeedHeader.Incrementality.FULL_DATASET,
			timestamp: Math.floor(Temporal.Now.instant().epochMilliseconds / 1000),
		},
		entity: [
			...(tripUpdates !== null
				? tripUpdates
						.entries()
						.flatMap(([id, tripUpdate]) => (tripUpdate.stopTimeUpdate?.length ? [{ id, tripUpdate }] : []))
						.toArray()
				: []),
			...(vehiclePositions !== null
				? vehiclePositions
						.entries()
						.map(([id, vehicle]) => ({ id, vehicle }))
						.toArray()
				: []),
		],
	});
}
