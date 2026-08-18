import { Worker } from "node:worker_threads";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { rateLimiter } from "hono-rate-limiter";

import { PORT } from "./config.js";
import { handleRequest } from "./gtfs-rt/handle-request.js";
import type { FeedData, WorkerMessage } from "./types.js";

console.log(` ,----.,--------.,------.,---.        ,------.,--------. ,--------.,-----.,--.    
'  .-./'--.  .--'|  .---'   .-',-----.|  .--. '--.  .--' '--.  .--'  .--./|  |    
|  | .---.|  |   |  \`--,\`.  \`-.'-----'|  '--'.'  |  |       |  |  |  |    |  |    
'  '--'  ||  |   |  |\`  .-'    |      |  |\\  \\   |  |       |  |  '  '--'\\|  '--. 
 \`------' \`--'   \`--'   \`-----'       \`--' '--'  \`--'       \`--'   \`-----'\`-----'`);

const emptyFeed: FeedData = {
	pb: new Uint8Array(),
	json: {},
	timestamp: 0,
};

let latestFeeds: WorkerMessage = {
	global: emptyFeed,
	tripUpdates: emptyFeed,
	vehiclePositions: emptyFeed,
};

// Start the worker
// In dev (tsx), import.meta.url ends with .ts. In prod (node), it ends with .js.
const workerPath = new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);

function startWorker() {
	const worker = new Worker(workerPath);

	worker.on("message", (message: WorkerMessage) => {
		latestFeeds = message;
	});

	worker.on("error", (err) => {
		console.error("Worker error:", err);
	});

	worker.on("exit", (code) => {
		if (code !== 0) {
			console.error(`Worker stopped with exit code ${code}. Restarting in 5s...`);
			setTimeout(startWorker, 5000);
		} else {
			console.log("Worker exited normally.");
		}
	});

	return worker;
}

startWorker();

const hono = new Hono();
hono.use(
	rateLimiter({
		windowMs: 5_000,
		limit: 5,
		keyGenerator: (c) => `${c.req.header("CF-Connecting-IP")}_${c.req.method}_${c.req.path}`,
		handler: (c) => c.json({ code: 429, message: "Too many requests, please try again later." }, 429),
	}),
);
hono.get("/trip-updates", (c) => handleRequest(c, "protobuf", latestFeeds.tripUpdates));
hono.get("/trip-updates.json", (c) => handleRequest(c, "json", latestFeeds.tripUpdates));
hono.get("/vehicle-positions", (c) => handleRequest(c, "protobuf", latestFeeds.vehiclePositions));
hono.get("/vehicle-positions.json", (c) => handleRequest(c, "json", latestFeeds.vehiclePositions));
hono.get("/", (c) => handleRequest(c, c.req.query("format") === "json" ? "json" : "protobuf", latestFeeds.global));

serve({ fetch: hono.fetch, port: PORT });
console.log(`|> Listening on :${PORT}`);
