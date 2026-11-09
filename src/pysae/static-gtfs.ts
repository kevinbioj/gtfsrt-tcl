import { unzipSync } from "fflate";

import { parseCsv } from "../gtfs-rt/load-static-gtfs.js";
import { parseServiceTime, signatureOf } from "../gtfs-rt/use-static-gtfs.js";
import type { Coordinates } from "../utils/geometry.js";

/**
 * Un arrêt de l'horaire théorique d'une course selon Pysae. Les horaires se comptent en secondes
 * depuis le minuit de la journée de service, comme dans le GTFS de TCL ; `NaN` quand le fichier ne
 * les donne pas.
 *
 * Son nom et sa position sont ceux que Pysae lui donne : ses arrêts sont ceux de TCL, sous les mêmes
 * identifiants, mais il en crée parfois — un terminus, un report —, sous des identifiants que TCL
 * donne à d'autres arrêts (cf. `placeWeight`).
 */
export type PysaeStop = {
	stopSequence: number;
	stopId: string;
	arrival: number;
	departure: number;
	name: string | undefined;
	position: Coordinates | undefined;
};

/** Une course du GTFS de Pysae : sa ligne et ses arrêts, dans l'ordre. */
export type PysaeTrip = { routeId: string; stops: PysaeStop[] };

/**
 * Ce que le GTFS de Pysae apprend de ses courses : de quoi les retrouver dans celui de TCL, et rien de
 * plus. Le GTFS-RT ne dit pas l'horaire théorique de ce qu'il annonce ; c'est lui qui le dit.
 */
export type PysaeGtfs = {
	/** routeId → nom commercial (`route_short_name`), par lequel la ligne se retrouve chez TCL. */
	routeNames: Map<string, string>;
	trips: Map<string, PysaeTrip>;
};

const FILES = new Set(["routes.txt", "stops.txt", "trips.txt", "stop_times.txt"]);

/**
 * Télécharge le GTFS d'un groupe Pysae, à moins qu'il n'ait pas changé depuis la version `signature` —
 * Pysae ne répond pas aux requêtes HEAD, mais honore `If-None-Match`. `"unchanged"` dans ce cas,
 * `undefined` en cas d'échec.
 */
export async function fetchPysaeGtfs(
	url: string,
	signature: string | null,
): Promise<{ gtfs: PysaeGtfs; signature: string | null } | "unchanged" | undefined> {
	try {
		const response = await fetch(url, { headers: signature === null ? {} : { "If-None-Match": signature } });
		if (response.status === 304) return "unchanged";
		if (!response.ok) {
			console.error(`✘ Failed to fetch Pysae GTFS ${url} (HTTP ${response.status}).`);
			return undefined;
		}

		const files = unzipSync(new Uint8Array(await response.arrayBuffer()), {
			filter: (file) => FILES.has(file.name),
		});
		const decoder = new TextDecoder();
		const read = (name: string) => (files[name] === undefined ? "" : decoder.decode(files[name]));

		const gtfs = { routeNames: buildRouteNames(read("routes.txt")), trips: buildTrips(read("trips.txt")) };
		attachStopTimes(read("stop_times.txt"), buildStops(read("stops.txt")), gtfs.trips);
		return { gtfs, signature: signatureOf(response) };
	} catch (cause) {
		console.error(`✘ Failed to load Pysae GTFS ${url}!`, cause);
		return undefined;
	}
}

function buildRouteNames(csv: string): Map<string, string> {
	const names = new Map<string, string>();
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return names;

	const idCol = header.indexOf("route_id");
	const nameCol = header.indexOf("route_short_name");
	if (idCol === -1 || nameCol === -1) return names;

	for (const row of rows) {
		const routeId = row[idCol];
		const name = row[nameCol]?.trim();
		if (routeId && name) names.set(routeId, name);
	}
	return names;
}

function buildStops(csv: string): Map<string, { name: string; position: Coordinates | undefined }> {
	const stops = new Map<string, { name: string; position: Coordinates | undefined }>();
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return stops;

	const idCol = header.indexOf("stop_id");
	const nameCol = header.indexOf("stop_name");
	const latitudeCol = header.indexOf("stop_lat");
	const longitudeCol = header.indexOf("stop_lon");
	if (idCol === -1 || nameCol === -1) return stops;

	for (const row of rows) {
		const stopId = row[idCol];
		const name = row[nameCol];
		if (!stopId || !name) continue;

		const latitude = latitudeCol === -1 ? Number.NaN : Number.parseFloat(row[latitudeCol] ?? "");
		const longitude = longitudeCol === -1 ? Number.NaN : Number.parseFloat(row[longitudeCol] ?? "");
		const position = Number.isNaN(latitude) || Number.isNaN(longitude) ? undefined : { latitude, longitude };
		stops.set(stopId, { name, position });
	}
	return stops;
}

function buildTrips(csv: string): Map<string, PysaeTrip> {
	const trips = new Map<string, PysaeTrip>();
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return trips;

	const tripCol = header.indexOf("trip_id");
	const routeCol = header.indexOf("route_id");
	if (tripCol === -1 || routeCol === -1) return trips;

	for (const row of rows) {
		const tripId = row[tripCol];
		const routeId = row[routeCol];
		if (tripId && routeId) trips.set(tripId, { routeId, stops: [] });
	}
	return trips;
}

function attachStopTimes(
	csv: string,
	stops: ReadonlyMap<string, { name: string; position: Coordinates | undefined }>,
	trips: Map<string, PysaeTrip>,
) {
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return;

	const tripCol = header.indexOf("trip_id");
	const sequenceCol = header.indexOf("stop_sequence");
	const stopCol = header.indexOf("stop_id");
	const arrivalCol = header.indexOf("arrival_time");
	const departureCol = header.indexOf("departure_time");
	if (tripCol === -1 || sequenceCol === -1 || stopCol === -1) return;

	for (const row of rows) {
		const trip = trips.get(row[tripCol] ?? "");
		const stopSequence = Number.parseInt(row[sequenceCol] ?? "", 10);
		const stopId = row[stopCol];
		if (trip === undefined || Number.isNaN(stopSequence) || !stopId) continue;

		trip.stops.push({
			stopSequence,
			stopId,
			arrival: arrivalCol === -1 ? Number.NaN : parseServiceTime(row[arrivalCol] ?? ""),
			departure: departureCol === -1 ? Number.NaN : parseServiceTime(row[departureCol] ?? ""),
			name: stops.get(stopId)?.name,
			position: stops.get(stopId)?.position,
		});
	}

	for (const trip of trips.values()) trip.stops.sort((a, b) => a.stopSequence - b.stopSequence);
}
