import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { FeedData } from "../types.js";

export function handleRequest(c: Context, output: "protobuf" | "json", data: FeedData) {
	if (typeof data.timestamp === "number") {
		const lastModified = new Date(data.timestamp * 1000);
		c.res.headers.set("Last-Modified", lastModified.toUTCString());

		const ifModifiedSince = c.req.header("If-Modified-Since");
		if (ifModifiedSince && lastModified.getTime() <= new Date(ifModifiedSince).getTime()) {
			return c.body(null, 304);
		}
	}

	if (output === "json") {
		return c.json(data.json, 200);
	}

	return stream(c, async (stream) => {
		await stream.write(data.pb);
	});
}
