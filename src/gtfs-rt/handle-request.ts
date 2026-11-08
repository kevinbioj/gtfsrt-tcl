import type { Context } from "hono";
import { stream } from "hono/streaming";

import type { FeedData } from "../types.js";

export function handleRequest(c: Context, output: "protobuf" | "json", data: FeedData) {
	if (data.timestamp > 0) {
		c.header("Last-Modified", new Date(data.timestamp * 1000).toUTCString());

		const ifModifiedSince = Date.parse(c.req.header("If-Modified-Since") ?? "");
		if (!Number.isNaN(ifModifiedSince) && data.timestamp * 1000 <= ifModifiedSince) {
			return c.body(null, 304);
		}
	}

	if (c.req.method === "HEAD") {
		c.header("Content-Type", output === "json" ? "application/json" : "application/octet-stream");
		return c.body(null, 200);
	}

	if (output === "json") {
		return c.json(data.json, 200);
	}

	c.header("Content-Type", "application/octet-stream");
	return stream(c, async (stream) => {
		await stream.write(data.pb);
	});
}
