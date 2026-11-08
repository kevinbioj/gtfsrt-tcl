import type GtfsRealtime from "gtfs-realtime-bindings";

/** Un feed prêt à servir : encodé une fois pour toutes, et daté de sa dernière modification. */
export interface FeedData {
	pb: Uint8Array;
	json: unknown;
	timestamp: number;
}

/** Ce que le worker temps réel transmet à chaque relevé de SIRI Lite. */
export interface RealtimeSnapshot {
	tripUpdates: Map<string, GtfsRealtime.transit_realtime.ITripUpdate>;
	vehiclePositions: Map<string, GtfsRealtime.transit_realtime.IVehiclePosition>;
}

/** Les feeds servis, réassemblés à chaque relevé et après chaque saisie. */
export interface PublishedFeeds {
	global: FeedData;
	tripUpdates: FeedData;
	vehiclePositions: FeedData;
	serviceAlerts: FeedData;
}
