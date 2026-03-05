import GtfsRealtime from "gtfs-realtime-bindings";
import type { Context } from "hono";
import { stream } from "hono/streaming";

export function handleRequest(
	c: Context,
	output: "protobuf" | "json",
	feed: GtfsRealtime.transit_realtime.FeedMessage,
) {
	if (typeof feed.header.timestamp === "number") {
		const lastModified = new Date(feed.header.timestamp * 1000);
		c.res.headers.set("Last-Modified", lastModified.toUTCString());

		const ifModifiedSince = c.req.header("If-Modified-Since");
		if (ifModifiedSince && lastModified.getTime() <= new Date(ifModifiedSince).getTime()) {
			return c.body(null, 304);
		}
	}

	if (output === "json") {
		return c.json(feed, 200);
	}

	return stream(c, async (stream) => {
		const encoded = GtfsRealtime.transit_realtime.FeedMessage.encode(feed).finish();
		await stream.write(encoded);
	});
}
