import GtfsRealtime from "gtfs-realtime-bindings";
import { Temporal } from "temporal-polyfill";

export function createFeed(
	tripUpdates: Map<string, GtfsRealtime.transit_realtime.ITripUpdate>,
	vehiclePositions: Map<string, GtfsRealtime.transit_realtime.IVehiclePosition>,
): GtfsRealtime.transit_realtime.IFeedMessage {
	return {
		header: {
			gtfsRealtimeVersion: "2.0",
			incrementality: GtfsRealtime.transit_realtime.FeedHeader.Incrementality.FULL_DATASET,
			timestamp: Math.floor(Temporal.Now.instant().epochMilliseconds / 1000),
		},
		entity: [
			...tripUpdates
				.entries()
				.flatMap(([id, tripUpdate]) => (tripUpdate.stopTimeUpdate?.length ? [{ id, tripUpdate }] : []))
				.toArray(),
			...vehiclePositions
				.entries()
				.map(([id, vehicle]) => ({ id, vehicle }))
				.toArray(),
		],
	};
}
