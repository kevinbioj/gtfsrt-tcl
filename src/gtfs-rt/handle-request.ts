import GtfsRealtime from "gtfs-realtime-bindings";
import type { Context } from "hono";
import { stream } from "hono/streaming";

import { createFeed } from "./create-feed.js";

export function handleRequest(
	c: Context,
	output: "protobuf" | "json",
	tripUpdates: Map<string, GtfsRealtime.transit_realtime.ITripUpdate> | null,
	vehiclePositions: Map<string, GtfsRealtime.transit_realtime.IVehiclePosition> | null,
) {
	const feed = createFeed(tripUpdates, vehiclePositions);

	if (output === "json") {
		return c.json(feed, 200);
	}

	return stream(c, async (stream) => {
		const encoded = GtfsRealtime.transit_realtime.FeedMessage.encode(feed).finish();
		await stream.write(encoded);
	});
}
