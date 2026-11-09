import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { unzipSync } from "fflate";

import { LINE_CARTRIDGES_DIR, STATIC_GTFS_URL } from "../config.js";
import { parseCsv } from "../gtfs-rt/load-static-gtfs.js";

/**
 * Télécharge le pictogramme de chaque ligne du GTFS statique depuis la carte interactive de TCL, et le
 * range dans `LINE_CARTRIDGES_DIR` sous le nom `<route_id>.svg`.
 *
 *     pnpm fetch:cartridges
 *
 * À relancer à la main quand le GTFS gagne des lignes, puis à versionner : le producteur ne fait que
 * relire le dossier. Rien n'y est jamais supprimé — une ligne qui disparaît du GTFS le temps d'une
 * saison garde son pictogramme pour son retour —, et un échec laisse en place le fichier déjà présent.
 */

const MAP_ORIGIN = "https://carte-interactive.tcl.fr";
/** La page des lignes de la carte : elle embarque l'adresse de chaque pictogramme (cf. `fetchSources`). */
const MAP_LINES_PAGE = `${MAP_ORIGIN}/public-transport/lines?go=1&lang=fr`;
/** La carte désigne ses lignes par le `route_id` du GTFS, préfixé de son réseau. */
const ASSET_PREFIX = "lines/line:SYTNEX:";

/** Les lignes que la carte ne connaît que sous un autre identifiant que leur `route_id`. */
const ALIASES: Record<string, string> = {
	// « 106. » dans le GTFS : la 106 express.
	"106E": "106EX",
};

const CONCURRENCY = 8;

const routeIds = await fetchRouteIds();
const sources = await fetchSources();
console.log(`➔ Fetching ${routeIds.length} line cartridges.`);
mkdirSync(LINE_CARTRIDGES_DIR, { recursive: true });

const failures: string[] = [];
const queue = [...routeIds];
await Promise.all(
	Array.from({ length: CONCURRENCY }, async () => {
		for (let routeId = queue.shift(); routeId !== undefined; routeId = queue.shift()) {
			const lineId = ALIASES[routeId] ?? routeId;
			const svg = await fetchCartridge(
				sources.get(lineId) ?? `${MAP_ORIGIN}/api/valkyrie/assets/${ASSET_PREFIX}${encodeURIComponent(lineId)}.svg`,
			);
			if (svg === undefined) failures.push(routeId);
			else writeFileSync(join(LINE_CARTRIDGES_DIR, `${routeId}.svg`), svg);
		}
	}),
);

console.log(`✓ Saved ${routeIds.length - failures.length} line cartridges to ${LINE_CARTRIDGES_DIR}.`);
if (failures.length > 0) {
	console.error(`✘ ${failures.length} line(s) without cartridge: ${failures.sort().join(", ")}`);
	process.exitCode = 1;
}

// ---

async function fetchRouteIds(): Promise<string[]> {
	console.log("➔ Fetching static GTFS.");
	const response = await fetch(STATIC_GTFS_URL);
	if (!response.ok) throw new Error(`Failed to fetch static GTFS (HTTP ${response.status}).`);

	const files = unzipSync(new Uint8Array(await response.arrayBuffer()), {
		filter: (file) => file.name === "routes.txt",
	});
	const routes = files["routes.txt"];
	if (routes === undefined) throw new Error("Static GTFS has no routes.txt.");

	const rows = parseCsv(new TextDecoder().decode(routes));
	const header = rows.next().value;
	const idCol = header ? header.indexOf("route_id") : -1;
	if (idCol === -1) throw new Error("routes.txt has no route_id column.");

	const routeIds = new Set<string>();
	for (const row of rows) {
		const routeId = row[idCol];
		if (routeId) routeIds.add(routeId);
	}
	return [...routeIds];
}

/**
 * L'adresse du pictogramme de chaque ligne, telle que la page des lignes la déclare dans ses données de
 * rendu (`<script id="ssr-data">`, `state.assets`). Elle porte un `sha1` sans lequel certains
 * pictogrammes ne se servent pas — le serveur renvoie alors vers l'accueil de tcl.fr. Si la page a
 * changé de forme, on s'en passe : l'adresse nue suffit pour la plupart des lignes.
 */
async function fetchSources(): Promise<Map<string, string>> {
	const sources = new Map<string, string>();
	try {
		const response = await fetch(MAP_LINES_PAGE, { headers: { "User-Agent": "gtfsrt-tcl" } });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const match = /<script id="ssr-data" type="application\/json">(.*?)<\/script>/s.exec(await response.text());
		if (match?.[1] === undefined) throw new Error("no ssr-data");

		const assets = (JSON.parse(match[1]) as { state?: { assets?: Record<string, { url?: string }> } }).state?.assets;
		for (const [key, asset] of Object.entries(assets ?? {})) {
			if (key.startsWith(ASSET_PREFIX) && key.endsWith(".svg") && asset.url) {
				sources.set(key.slice(ASSET_PREFIX.length, -".svg".length), new URL(asset.url, MAP_ORIGIN).href);
			}
		}
	} catch (cause) {
		console.warn("⚠ Line cartridge addresses unavailable, falling back to bare URLs.", cause);
	}
	return sources;
}

/** Le SVG d'une ligne, `undefined` si la carte n'en a pas. */
async function fetchCartridge(url: string): Promise<string | undefined> {
	try {
		const response = await fetch(url, { headers: { "User-Agent": "gtfsrt-tcl" } });
		if (!response.ok) return undefined;
		const svg = await response.text();
		return svg.trimStart().startsWith("<svg") ? svg : undefined;
	} catch {
		return undefined;
	}
}
