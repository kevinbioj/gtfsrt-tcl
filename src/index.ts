import { Worker } from "node:worker_threads";
import { serve } from "@hono/node-server";
import GtfsRealtime from "gtfs-realtime-bindings";
import { Hono } from "hono";
import { rateLimiter } from "hono-rate-limiter";

import { useAlertPublication } from "./alerts/publish.js";
import { siriSituationExchange } from "./alerts/siri-sx-source.js";
import {
	ADMIN_PASSWORD,
	ADMIN_USERNAME,
	DETOURS_DB_PATH,
	GTFS_CHECK_INTERVAL,
	LINE_CARTRIDGES_DIR,
	PORT,
	PYSAE_FEEDS,
	REINDEX_INTERVAL,
	ROAD_GRAPH_PATH,
	SERVICE_ALERTS_ENABLED,
	SERVICE_ALERTS_INTERVAL,
	STATIC_GTFS_URL,
	siriLiteAuthorization,
} from "./config.js";
import { adminRoutes } from "./detours/admin.js";
import { buildDetourEntities } from "./detours/build-entities.js";
import { useLineCartridges } from "./detours/line-cartridges.js";
import { useModificationIndex } from "./detours/modifications.js";
import { useDetourStore } from "./detours/store.js";
import { createFeed } from "./gtfs-rt/create-feed.js";
import { handleRequest } from "./gtfs-rt/handle-request.js";
import { postProcessTripUpdates } from "./gtfs-rt/post-process.js";
import { useChangeTracker } from "./gtfs-rt/track-changes.js";
import { useServiceAlerts } from "./gtfs-rt/use-service-alerts.js";
import { useStaticGtfs } from "./gtfs-rt/use-static-gtfs.js";
import { mergeRealtime, usePysaeFeeds } from "./pysae/use-pysae-feeds.js";
import { useRoadGraph } from "./routing/road-graph.js";
import type { FeedData, PublishedFeeds, RealtimeSnapshot } from "./types.js";

console.log(` ,----.,--------.,------.,---.        ,------.,--------. ,--------.,-----.,--.
'  .-./'--.  .--'|  .---'   .-',-----.|  .--. '--.  .--' '--.  .--'  .--./|  |
|  | .---.|  |   |  \`--,\`.  \`-.'-----'|  '--'.'  |  |       |  |  |  |    |  |
'  '--'  ||  |   |  |\`  .-'    |      |  |\\  \\   |  |       |  |  '  '--'\\|  '--.
 \`------' \`--'   \`--'   \`-----'       \`--' '--'  \`--'       \`--'   \`-----'\`-----'`);

// Sans identifiants SIRI Lite, rien ne se relève : autant le dire tout de suite.
siriLiteAuthorization();

const emptyFeed: FeedData = { pb: new Uint8Array(), json: {}, timestamp: 0 };

let feeds: PublishedFeeds = {
	global: emptyFeed,
	tripUpdates: emptyFeed,
	vehiclePositions: emptyFeed,
	serviceAlerts: emptyFeed,
};

/** Le dernier relevé de SIRI Lite, tel que le worker temps réel le transmet. */
let realtime: RealtimeSnapshot = { tripUpdates: new Map(), vehiclePositions: new Map() };

/** Les entités des déviations — arrêts provisoires, tracés, modifications de course (cf. `rebuildDetourEntities`). */
let detourEntities: GtfsRealtime.transit_realtime.IFeedEntity[] = [];

/**
 * La date de dernière modification de chaque flux : celle que portent `header.timestamp` et
 * `Last-Modified`. Elle ne bouge que si le contenu a changé (cf. `useChangeTracker`).
 */
const changes = useChangeTracker();

/** Quand chaque flux a été réassemblé pour la dernière fois, en secondes epoch : ce que l'administration affiche. */
const feedGeneratedAt = {
	serviceAlerts: null as number | null,
	tripModifications: null as number | null,
	tripUpdates: null as number | null,
};

const staticGtfs = await useStaticGtfs(STATIC_GTFS_URL, GTFS_CHECK_INTERVAL, () => refresh());
const detourStore = useDetourStore(DETOURS_DB_PATH);
// Les modifications se rebâtissent à chaque relevé d'infos trafic, chaque minute, et après chaque
// saisie : c'est ce qui tient à jour celles qui valent, et les arrêts à sauter. Le premier relevé se
// fait attendre : l'index est là avant lui, les modifications n'en dépendant pas.
const serviceAlerts = useServiceAlerts(
	SERVICE_ALERTS_ENABLED ? siriSituationExchange(SERVICE_ALERTS_INTERVAL) : null,
	staticGtfs,
	{ onPublished: () => refresh() },
);
const modificationIndex = useModificationIndex(detourStore, staticGtfs, () => serviceAlerts.alerts);
const alertPublication = useAlertPublication({
	store: detourStore,
	gtfs: staticGtfs,
	feed: serviceAlerts,
	modificationIndex,
	onChange: () => rebuild(),
});
// Sa présence est constatée ici, ses octets ne seront lus qu'au premier accrochage.
const roadGraph = useRoadGraph(ROAD_GRAPH_PATH);
const lineCartridges = useLineCartridges(LINE_CARTRIDGES_DIR);
// Les lignes que Cars Faure exploite en sous-traitance : SIRI Lite n'en a que l'horaire théorique.
const pysae = usePysaeFeeds(PYSAE_FEEDS, staticGtfs, () => publish());

/**
 * Réassemble les entités des déviations déclarées. Les journées de service tournent, les courses
 * finissent de circuler : d'où une reconstruction à chaque réindexation, et juste après une saisie.
 * Une déclaration incomplète se traduit par des entités en moins, jamais par un feed en échec.
 */
function rebuildDetourEntities() {
	try {
		detourEntities = buildDetourEntities(
			staticGtfs.data,
			modificationIndex.modifications,
			modificationIndex.cancelIndex,
			detourStore.provisionalStops,
			Math.floor(Date.now() / 1000),
		);
		feedGeneratedAt.tripModifications = Math.floor(Date.now() / 1000);
	} catch (cause) {
		console.error("✘ Failed to build detour entities:", cause);
	}
}

function encode(feed: GtfsRealtime.transit_realtime.FeedMessage): FeedData {
	return {
		pb: GtfsRealtime.transit_realtime.FeedMessage.encode(feed).finish(),
		json: feed.toJSON(),
		timestamp: Number(feed.header.timestamp),
	};
}

/**
 * Réassemble et encode les quatre feeds : le temps réel du dernier relevé — SIRI Lite et Pysae —, corrigé
 * de ce qui a été saisi, les déviations et les infos trafic. Chaque feed est daté de sa dernière modification.
 */
function publish() {
	try {
		if (alertPublication.dropStale()) modificationIndex.reindex();

		const nowSeconds = Math.floor(Date.now() / 1000);
		const sources = mergeRealtime(realtime, pysae.snapshot(nowSeconds));
		let tripUpdates = sources.tripUpdates;
		try {
			tripUpdates = postProcessTripUpdates(sources.tripUpdates, staticGtfs.data, modificationIndex, nowSeconds);
		} catch (cause) {
			console.error("✘ Failed to apply modifications to trip updates, publishing them as received:", cause);
		}
		const { vehiclePositions } = sources;
		const alertEntities = alertPublication.publishedAlerts();

		const tripUpdatesAt = changes.stamp("trip-updates", [[...tripUpdates], detourEntities]);
		const vehiclePositionsAt = changes.stamp("vehicle-positions", [...vehiclePositions]);
		const serviceAlertsAt = changes.stamp("service-alerts", alertEntities);

		feeds = {
			tripUpdates: encode(createFeed(tripUpdatesAt, tripUpdates, null, detourEntities)),
			vehiclePositions: encode(createFeed(vehiclePositionsAt, null, vehiclePositions)),
			serviceAlerts: encode(createFeed(serviceAlertsAt, null, null, null, alertEntities)),
			global: encode(
				createFeed(
					Math.max(tripUpdatesAt, vehiclePositionsAt, serviceAlertsAt),
					tripUpdates,
					vehiclePositions,
					detourEntities,
					alertEntities,
				),
			),
		};
		feedGeneratedAt.tripUpdates = nowSeconds;
		feedGeneratedAt.serviceAlerts = nowSeconds;
	} catch (cause) {
		console.error("✘ Failed to publish feeds:", cause);
	}
}

/** Après une saisie dans l'administration, qui a déjà réindexé : les déviations, puis les feeds. */
function rebuild() {
	rebuildDetourEntities();
	publish();
	// Une dépublication programmée a pu être saisie, déplacée ou retirée.
	alertPublication.scheduleUnpublication();
}

/** Réindexation complète : à chaque relevé d'infos trafic, à chaque minute, et au rechargement du GTFS. */
function refresh() {
	try {
		modificationIndex.reindex();
	} catch (cause) {
		console.error("✘ Failed to index modifications:", cause);
	}
	rebuild();
}

// ---

const hono = new Hono();

const limiter = rateLimiter({
	windowMs: 5_000,
	limit: 5,
	keyGenerator: (c) => `${c.req.header("CF-Connecting-IP")}_${c.req.method}_${c.req.path}`,
	handler: (c) => c.json({ code: 429, message: "Too many requests, please try again later." }, 429),
});

// Le limiteur ne couvre que les endpoints publics. L'interface d'administration est protégée par son
// authentification, et son usage normal dépasserait d'emblée un quota taillé pour des consommateurs de
// feed.
hono.use(async (c, next) => (c.req.path.startsWith("/admin") ? next() : limiter(c, next)));

if (ADMIN_USERNAME && ADMIN_PASSWORD) {
	hono.route(
		"/admin",
		adminRoutes({
			username: ADMIN_USERNAME,
			password: ADMIN_PASSWORD,
			store: detourStore,
			gtfs: staticGtfs,
			modificationIndex,
			roadGraph,
			cartridges: lineCartridges,
			receivedAlert: (alertNumber) =>
				serviceAlerts.entities.find((alert) => alert.alertNumber === alertNumber)?.entity.alert ?? undefined,
			feedStatus: () => ({
				serviceAlerts: { generatedAt: feedGeneratedAt.serviceAlerts, modifiedAt: changes.modifiedAt("service-alerts") },
				tripModifications: { generatedAt: feedGeneratedAt.tripModifications, modifiedAt: null },
				tripUpdates: { generatedAt: feedGeneratedAt.tripUpdates, modifiedAt: changes.modifiedAt("trip-updates") },
				gtfsImportedAt: Math.floor(staticGtfs.importedAt.epochMilliseconds / 1000),
			}),
			rebuild,
		}),
	);
	console.log("➔ Administration mounted on /admin.");
} else {
	console.warn("✘ ADMIN_USERNAME/ADMIN_PASSWORD missing — administration not mounted.");
}

hono.get("/trip-updates", (c) => handleRequest(c, "protobuf", feeds.tripUpdates));
hono.get("/trip-updates.json", (c) => handleRequest(c, "json", feeds.tripUpdates));
hono.get("/vehicle-positions", (c) => handleRequest(c, "protobuf", feeds.vehiclePositions));
hono.get("/vehicle-positions.json", (c) => handleRequest(c, "json", feeds.vehiclePositions));
hono.get("/service-alerts", (c) => handleRequest(c, "protobuf", feeds.serviceAlerts));
hono.get("/service-alerts.json", (c) => handleRequest(c, "json", feeds.serviceAlerts));
hono.get("/", (c) => handleRequest(c, c.req.query("format") === "json" ? "json" : "protobuf", feeds.global));

serve({ fetch: hono.fetch, port: PORT });
console.log(`|> Listening on :${PORT}`);

// ---

// In dev (tsx), import.meta.url ends with .ts. In prod (node), it ends with .js.
const workerPath = new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);

function startWorker() {
	const worker = new Worker(workerPath);

	worker.on("message", (message: RealtimeSnapshot) => {
		realtime = message;
		publish();
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

refresh();
setInterval(refresh, REINDEX_INTERVAL);
