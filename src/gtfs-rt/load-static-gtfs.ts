import { createHash } from "node:crypto";

import { unzipSync } from "fflate";

import { type Coordinates, haversine, projectOnShape, type ShapePoint } from "../utils/geometry.js";
import {
	courseKey,
	type LoadedGtfs,
	normalizeStopName,
	type OrderedStop,
	parseServiceTime,
	type RouteColors,
	type RouteDirection,
	type RoutePattern,
	type ServiceCalendar,
	type Station,
	type StopBounds,
	signatureOf,
	type TripMeta,
	type TripStop,
} from "./use-static-gtfs.js";

/** Le GTFS tel que le worker le lit, ses deux grosses tables encore en `Map` (cf. `packTables`). */
export type ParsedGtfs = LoadedGtfs & {
	tripStopSequences: Map<string, TripStop[]>;
	shapes: Map<string, ShapePoint[]>;
};

const GTFS_FILES = new Set([
	"agency.txt",
	"stops.txt",
	"routes.txt",
	"trips.txt",
	"stop_times.txt",
	"shapes.txt",
	"calendar.txt",
	"calendar_dates.txt",
	"areas.txt",
]);

/**
 * Télécharge et lit le GTFS statique. `undefined` en cas d'échec — l'appelant garde alors le GTFS
 * qu'il a déjà. Destiné au worker de chargement : la lecture tient la boucle d'événements plusieurs
 * secondes, et coûte bien plus de mémoire que ce qu'elle produit.
 */
export async function loadGtfs(url: string): Promise<{ data: ParsedGtfs; signature: string | null } | undefined> {
	console.log("➔ Fetching static GTFS.");
	const startedAt = performance.now();

	try {
		const response = await fetch(url);
		if (!response.ok) {
			console.error(`✘ Failed to fetch static GTFS (HTTP ${response.status}).`);
			return undefined;
		}

		const signature = signatureOf(response);
		const files = unzipSync(new Uint8Array(await response.arrayBuffer()), {
			filter: (file) => GTFS_FILES.has(file.name),
		});

		if (!files["stops.txt"] || !files["trips.txt"]) {
			console.error("✘ Static GTFS is missing stops.txt or trips.txt.");
			return undefined;
		}

		// Chaque fichier se lit puis se lâche : le texte de stop_times.txt pèse à lui seul près de 200 Mo.
		const decoder = new TextDecoder();
		const take = (name: string): string | undefined => {
			const file = files[name];
			if (file === undefined) return undefined;
			delete files[name];
			return decoder.decode(file);
		};

		const agencyCsv = take("agency.txt");
		const agencies = agencyCsv === undefined ? new Map<string, string>() : buildAgencies(agencyCsv);
		const { idToName, coordinates, stations, zones, bounds } = buildStops(take("stops.txt") as string);
		const { routeDirections, tripMeta, serviceTrips } = buildTrips(take("trips.txt") as string);
		const routesCsv = take("routes.txt");
		const {
			names: routeNames,
			colors: routeColors,
			sortOrders: routeSortOrders,
			agencies: routeAgencies,
		} = routesCsv === undefined
			? { names: new Map(), colors: new Map(), sortOrders: new Map(), agencies: new Map() }
			: buildRoutes(routesCsv);
		const areasCsv = take("areas.txt");
		const fareAreas = areasCsv === undefined ? zoneAreas(zones) : buildFareAreas(areasCsv);
		const calendarCsv = take("calendar.txt");
		const calendars = calendarCsv === undefined ? new Map() : buildCalendar(calendarCsv);
		const calendarDatesCsv = take("calendar_dates.txt");
		const calendarExceptions = calendarDatesCsv === undefined ? new Map() : buildCalendarDates(calendarDatesCsv);
		const shapesCsv = take("shapes.txt");
		const { shapes, scales } =
			shapesCsv === undefined
				? { shapes: new Map<string, ShapePoint[]>(), scales: new Map<string, number>() }
				: buildShapes(shapesCsv);
		const stopTimesCsv = take("stop_times.txt");
		const {
			routeStopSequences,
			routePatterns,
			tripPatterns,
			tripStopSequences,
			tripDepartures,
			tripArrivals,
			projectedStops,
		} =
			stopTimesCsv === undefined
				? {
						routeStopSequences: new Map(),
						routePatterns: new Map(),
						tripPatterns: new Map(),
						tripStopSequences: new Map(),
						tripDepartures: new Map(),
						tripArrivals: new Map(),
						projectedStops: 0,
					}
				: buildSequences(stopTimesCsv, tripMeta, idToName, shapes, scales, coordinates);

		if (projectedStops > 0) {
			console.warn(`⚠ ${projectedStops} stop distances projected onto shapes (missing shape_dist_traveled).`);
		}

		const { tripCourseKeys, courseVersions } = buildCourses(tripMeta, tripStopSequences, tripDepartures);

		console.log(
			`✓ Loaded ${idToName.size} stops, ${stations.size} stations, ${routeDirections.size} routes, ${tripStopSequences.size} trip schedules, ${shapes.size} shapes, ${serviceTrips.size} services, ${courseVersions.size} courses from GTFS in ${Math.round(performance.now() - startedAt)}ms.`,
		);
		return {
			data: {
				routeDirections,
				routeStopSequences,
				routePatterns,
				tripPatterns,
				routeNames,
				routeColors,
				routeSortOrders,
				routeAgencies,
				agencies,
				tripStopSequences,
				tripDepartures,
				tripArrivals,
				calendars,
				calendarExceptions,
				serviceTrips,
				tripCourseKeys,
				courseVersions,
				stopNames: idToName,
				stopCoordinates: coordinates,
				stopBounds: bounds,
				trips: tripMeta,
				shapes,
				fareAreas,
				stations,
			},
			signature,
		};
	} catch (cause) {
		console.error("✘ Failed to load static GTFS!", cause);
		return undefined;
	}
}

function buildAgencies(csv: string): Map<string, string> {
	const agencies = new Map<string, string>();
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return agencies;

	const idCol = header.indexOf("agency_id");
	const nameCol = header.indexOf("agency_name");
	for (const row of rows) {
		// Un GTFS à une seule agence peut taire son identifiant : il ne désigne alors rien.
		const agencyId = idCol === -1 ? "" : (row[idCol] ?? "");
		if (!agencyId) continue;
		agencies.set(agencyId, (nameCol === -1 ? "" : row[nameCol]?.trim()) || agencyId);
	}
	return agencies;
}

/**
 * Les quais, leurs noms et leurs coordonnées, et à part les stations (`location_type` = 1). Les
 * autres types de lieux — entrées, nœuds, zones d'embarquement — ne se desservent pas : ils sont
 * écartés. Au passage, les zones tarifaires que portent les quais, et leur enveloppe.
 */
function buildStops(csv: string): {
	idToName: Map<string, string>;
	coordinates: Map<string, Coordinates>;
	stations: Map<string, Station>;
	zones: Set<string>;
	bounds: StopBounds | null;
} {
	const idToName = new Map<string, string>();
	const coordinates = new Map<string, Coordinates>();
	const stations = new Map<string, Station>();
	const zones = new Set<string>();
	let bounds: StopBounds | null = null;
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return { idToName, coordinates, stations, zones, bounds };

	const idCol = header.indexOf("stop_id");
	const nameCol = header.indexOf("stop_name");
	const latitudeCol = header.indexOf("stop_lat");
	const longitudeCol = header.indexOf("stop_lon");
	const locationTypeCol = header.indexOf("location_type");
	const zoneCol = header.indexOf("zone_id");
	if (idCol === -1 || nameCol === -1) return { idToName, coordinates, stations, zones, bounds };

	for (const row of rows) {
		const stopId = row[idCol];
		const stopName = row[nameCol];
		if (!stopId || !stopName) continue;

		const latitude = latitudeCol === -1 ? Number.NaN : Number.parseFloat(row[latitudeCol] ?? "");
		const longitude = longitudeCol === -1 ? Number.NaN : Number.parseFloat(row[longitudeCol] ?? "");
		const position = Number.isNaN(latitude) || Number.isNaN(longitude) ? null : { latitude, longitude };

		const locationType = locationTypeCol === -1 ? "" : (row[locationTypeCol] ?? "");
		if (locationType === "1") {
			stations.set(stopId, { name: stopName, coordinates: position });
			continue;
		}
		if (locationType !== "" && locationType !== "0") continue;

		idToName.set(stopId, stopName);
		const zone = zoneCol === -1 ? "" : (row[zoneCol]?.trim() ?? "");
		if (zone) zones.add(zone);
		if (position === null) continue;

		coordinates.set(stopId, position);
		bounds =
			bounds === null
				? { minLatitude: latitude, maxLatitude: latitude, minLongitude: longitude, maxLongitude: longitude }
				: {
						minLatitude: Math.min(bounds.minLatitude, latitude),
						maxLatitude: Math.max(bounds.maxLatitude, latitude),
						minLongitude: Math.min(bounds.minLongitude, longitude),
						maxLongitude: Math.max(bounds.maxLongitude, longitude),
					};
	}

	return { idToName, coordinates, stations, zones, bounds };
}

/**
 * Les zones tarifaires, faute d'`areas.txt` : les `zone_id` des quais, nommés d'après eux — « 1 »
 * devient « Zone 1 », un libellé déjà parlant reste tel quel.
 */
function zoneAreas(zones: ReadonlySet<string>): Map<string, string> {
	return new Map(
		[...zones]
			.sort((a, b) => a.localeCompare(b, "fr", { numeric: true }))
			.map((zone) => [zone, /^\d+$/.test(zone) ? `Zone ${zone}` : zone]),
	);
}

/**
 * Le nom, les couleurs, le rang et l'agence de chaque ligne. Une ligne sans `route_color` n'a pas de
 * couleurs — son texte est noir par défaut quand elle en a —, une ligne sans `route_sort_order` pas de rang.
 */
function buildRoutes(csv: string): {
	names: Map<string, string>;
	colors: Map<string, RouteColors>;
	sortOrders: Map<string, number>;
	agencies: Map<string, string>;
} {
	const names = new Map<string, string>();
	const colors = new Map<string, RouteColors>();
	const sortOrders = new Map<string, number>();
	const agencies = new Map<string, string>();
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return { names, colors, sortOrders, agencies };

	const idCol = header.indexOf("route_id");
	const agencyCol = header.indexOf("agency_id");
	const nameCol = header.indexOf("route_short_name");
	const colorCol = header.indexOf("route_color");
	const textCol = header.indexOf("route_text_color");
	const orderCol = header.indexOf("route_sort_order");
	const typeCol = header.indexOf("route_type");
	if (idCol === -1) return { names, colors, sortOrders, agencies };
	const types = new Map<string, string>();

	const hex = (value: string | undefined) => (value && /^[0-9a-f]{6}$/i.test(value.trim()) ? `#${value.trim()}` : null);
	for (const row of rows) {
		const routeId = row[idCol];
		if (!routeId) continue;
		const name = nameCol === -1 ? "" : (row[nameCol]?.trim() ?? "");
		if (name) names.set(routeId, name);
		const agencyId = agencyCol === -1 ? "" : (row[agencyCol] ?? "");
		if (agencyId) agencies.set(routeId, agencyId);
		const color = colorCol === -1 ? null : hex(row[colorCol]);
		if (color) colors.set(routeId, { color, textColor: hex(textCol === -1 ? undefined : row[textCol]) ?? "#000000" });
		const order = orderCol === -1 ? "" : (row[orderCol]?.trim() ?? "");
		if (/^\d+$/.test(order)) sortOrders.set(routeId, Number(order));
		types.set(routeId, typeCol === -1 ? "" : (row[typeCol]?.trim() ?? ""));
	}

	// Le GTFS de TCL ne déclare aucun rang : on en déduit un du mode de chaque ligne, puis de son nom.
	if (sortOrders.size === 0) {
		const ranked = [...types].sort(
			([a, typeA], [b, typeB]) =>
				modeRank(typeA, names.get(a) ?? a) - modeRank(typeB, names.get(b) ?? b) ||
				(names.get(a) ?? a).localeCompare(names.get(b) ?? b, "fr", { numeric: true }),
		);
		ranked.forEach(([routeId], rank) => {
			sortOrders.set(routeId, rank);
		});
	}

	return { names, colors, sortOrders, agencies };
}

/**
 * Le rang d'un mode, dans l'ordre où TCL présente son réseau : métro, funiculaires, tramways,
 * express, lignes Chrono (« C1 »), bus, navette fluviale, puis les lignes de soirée, de nuit, de
 * substitution et scolaires.
 */
function modeRank(routeType: string, name: string): number {
	switch (routeType) {
		case "1":
			return 0;
		case "7":
			return 1;
		case "0":
			return 2;
		case "702":
			return 3;
		case "3":
		case "11":
			return /^C\d/.test(name) ? 4 : 5;
		case "4":
			return 6;
		case "705":
			return 7;
		case "711":
			return 8;
		case "714":
			return 9;
		case "713":
			return 11;
		default:
			return 10;
	}
}

/** Les zones tarifaires et leur libellé. Une zone sans `area_name` est nommée par son identifiant. */
function buildFareAreas(csv: string): Map<string, string> {
	const areas = new Map<string, string>();
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return areas;

	const idCol = header.indexOf("area_id");
	const nameCol = header.indexOf("area_name");
	if (idCol === -1) return areas;

	for (const row of rows) {
		const areaId = row[idCol];
		if (!areaId) continue;
		const name = nameCol === -1 ? "" : (row[nameCol]?.trim() ?? "");
		areas.set(areaId, name || areaId);
	}

	return areas;
}

function buildTrips(csv: string): {
	routeDirections: Map<string, RouteDirection[]>;
	tripMeta: Map<string, TripMeta>;
	serviceTrips: Map<string, string[]>;
} {
	const tripMeta = new Map<string, TripMeta>();
	const serviceTrips = new Map<string, string[]>();
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return { routeDirections: new Map(), tripMeta, serviceTrips };

	const routeCol = header.indexOf("route_id");
	const tripCol = header.indexOf("trip_id");
	const headsignCol = header.indexOf("trip_headsign");
	const directionCol = header.indexOf("direction_id");
	const shapeCol = header.indexOf("shape_id");
	const serviceCol = header.indexOf("service_id");
	if (routeCol === -1 || directionCol === -1) return { routeDirections: new Map(), tripMeta, serviceTrips };

	// routeId → directionId → set de headsigns
	const grouped = new Map<string, Map<number, Set<string>>>();

	for (const row of rows) {
		const routeId = row[routeCol];
		if (!routeId) continue;

		const directionId = Number.parseInt(row[directionCol] ?? "", 10);
		if (Number.isNaN(directionId)) continue;

		const tripId = tripCol === -1 ? "" : (row[tripCol] ?? "");
		const headsign = headsignCol === -1 ? "" : (row[headsignCol] ?? "");
		const shapeId = shapeCol === -1 ? "" : (row[shapeCol] ?? "");
		const serviceId = serviceCol === -1 ? "" : (row[serviceCol] ?? "");
		if (tripId) {
			tripMeta.set(tripId, { routeId, directionId, headsign, shapeId, serviceId });
			if (serviceId) {
				let trips = serviceTrips.get(serviceId);
				if (trips === undefined) {
					trips = [];
					serviceTrips.set(serviceId, trips);
				}
				trips.push(tripId);
			}
		}

		let directions = grouped.get(routeId);
		if (directions === undefined) {
			directions = new Map();
			grouped.set(routeId, directions);
		}

		let headsigns = directions.get(directionId);
		if (headsigns === undefined) {
			headsigns = new Set();
			directions.set(directionId, headsigns);
		}
		if (headsign) headsigns.add(headsign);
	}

	const routeDirections = new Map<string, RouteDirection[]>();
	for (const [routeId, directions] of grouped) {
		routeDirections.set(
			routeId,
			[...directions.entries()]
				.sort(([a], [b]) => a - b)
				.map(([directionId, headsigns]) => ({ directionId, headsigns: [...headsigns] })),
		);
	}

	return { routeDirections, tripMeta, serviceTrips };
}

/**
 * Regroupe les courses par ce qu'elles sont réellement, par-delà leurs identifiants : le GTFS décrit
 * une même course une fois par service qui l'assure — mêmes ligne, sens, arrêts, horaires et tracé,
 * mais un `trip_id` par exemplaire. Les annulations désignent ainsi une course, toutes versions
 * confondues (cf. `isCancelled`).
 */
function buildCourses(
	tripMeta: Map<string, TripMeta>,
	tripStopSequences: Map<string, TripStop[]>,
	tripDepartures: Map<string, number>,
): { tripCourseKeys: Map<string, string>; courseVersions: Map<string, string[]> } {
	const tripCourseKeys = new Map<string, string>();
	const courseVersions = new Map<string, string[]>();

	for (const [tripId, meta] of tripMeta) {
		const origin = tripStopSequences.get(tripId)?.[0];
		const departure = tripDepartures.get(tripId);
		// Course sans horaire : elle n'a pas de quoi être rapprochée de quoi que ce soit.
		if (origin === undefined || departure === undefined) continue;

		const key = courseKey(meta.routeId, meta.directionId, origin.stopId, departure);
		tripCourseKeys.set(tripId, key);

		const versions = courseVersions.get(key);
		if (versions === undefined) courseVersions.set(key, [tripId]);
		else versions.push(tripId);
	}

	return { tripCourseKeys, courseVersions };
}

/** Colonnes des jours de `calendar.txt`, du lundi au dimanche — l'ordre de {@link ServiceCalendar.weekdays}. */
const DAY_COLUMNS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/**
 * Calendriers hebdomadaires de `calendar.txt`. Un fichier qui ne déclare pas toutes ses colonnes de
 * jours est ignoré en bloc : un service dont on ne saurait pas quels jours il dessert ferait circuler
 * des courses n'importe quand.
 */
function buildCalendar(csv: string): Map<string, ServiceCalendar> {
	const calendars = new Map<string, ServiceCalendar>();

	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return calendars;

	const idCol = header.indexOf("service_id");
	const startCol = header.indexOf("start_date");
	const endCol = header.indexOf("end_date");
	const dayCols = DAY_COLUMNS.map((day) => header.indexOf(day));
	if (idCol === -1 || dayCols.some((col) => col === -1)) return calendars;

	for (const row of rows) {
		const serviceId = row[idCol];
		if (!serviceId) continue;

		calendars.set(serviceId, {
			weekdays: dayCols.map((col) => row[col] === "1"),
			startDate: startCol === -1 ? "" : (row[startCol] ?? ""),
			endDate: endCol === -1 ? "" : (row[endCol] ?? ""),
		});
	}

	return calendars;
}

/** Exceptions datées de `calendar_dates.txt`, indexées par service puis par date. */
function buildCalendarDates(csv: string): Map<string, Map<string, number>> {
	const exceptions = new Map<string, Map<string, number>>();

	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return exceptions;

	const idCol = header.indexOf("service_id");
	const dateCol = header.indexOf("date");
	const typeCol = header.indexOf("exception_type");
	if (idCol === -1 || dateCol === -1 || typeCol === -1) return exceptions;

	for (const row of rows) {
		const serviceId = row[idCol];
		const date = row[dateCol];
		const exceptionType = Number.parseInt(row[typeCol] ?? "", 10);
		if (!serviceId || !date || Number.isNaN(exceptionType)) continue;

		let dates = exceptions.get(serviceId);
		if (dates === undefined) {
			dates = new Map();
			exceptions.set(serviceId, dates);
		}
		dates.set(date, exceptionType);
	}

	return exceptions;
}

/** Une ligne de shapes.txt, avant tri et cumul des distances. */
type ShapeRow = Coordinates & { sequence: number; declared: number };

/**
 * À partir de shapes.txt, construit les tracés des courses et, pour chacun, le facteur qui ramène
 * les `shape_dist_traveled` du GTFS à nos kilomètres.
 *
 * L'abscisse curviligne de chaque point est **recalculée** plutôt que reprise : le GTFS ne spécifie
 * pas l'unité de `shape_dist_traveled` (des mètres chez TCL). Le rapport entre la longueur déclarée
 * du tracé et celle qu'on vient de mesurer donne cette unité, et le même facteur remet ensuite à
 * l'échelle les abscisses des arrêts (cf. {@link buildSequences}). `NaN` lorsque le tracé n'en
 * déclare aucune.
 */
function buildShapes(csv: string): { shapes: Map<string, ShapePoint[]>; scales: Map<string, number> } {
	const shapes = new Map<string, ShapePoint[]>();
	const scales = new Map<string, number>();

	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return { shapes, scales };

	const idCol = header.indexOf("shape_id");
	const latitudeCol = header.indexOf("shape_pt_lat");
	const longitudeCol = header.indexOf("shape_pt_lon");
	const seqCol = header.indexOf("shape_pt_sequence");
	const distCol = header.indexOf("shape_dist_traveled");
	if (idCol === -1 || latitudeCol === -1 || longitudeCol === -1 || seqCol === -1) return { shapes, scales };

	const collected = new Map<string, ShapeRow[]>();

	for (const row of rows) {
		const shapeId = row[idCol];
		if (!shapeId) continue;

		const latitude = Number.parseFloat(row[latitudeCol] ?? "");
		const longitude = Number.parseFloat(row[longitudeCol] ?? "");
		const sequence = Number.parseInt(row[seqCol] ?? "", 10);
		if (Number.isNaN(latitude) || Number.isNaN(longitude) || Number.isNaN(sequence)) continue;

		let points = collected.get(shapeId);
		if (points === undefined) {
			points = [];
			collected.set(shapeId, points);
		}
		points.push({
			latitude,
			longitude,
			sequence,
			declared: distCol === -1 ? Number.NaN : Number.parseFloat(row[distCol] ?? ""),
		});
	}

	for (const [shapeId, unordered] of collected) {
		unordered.sort((a, b) => a.sequence - b.sequence);
		// Un point seul ne fait pas un segment : rien à y projeter.
		if (unordered.length < 2) continue;

		const points: ShapePoint[] = [];
		let distance = 0;
		let previous: ShapeRow | undefined;

		for (const point of unordered) {
			if (previous !== undefined) distance += haversine(previous, point);
			points.push({ latitude: point.latitude, longitude: point.longitude, distance });
			previous = point;
		}

		shapes.set(shapeId, points);

		const declared = (unordered.at(-1) as ShapeRow).declared;
		scales.set(shapeId, Number.isFinite(declared) && declared > 0 ? distance / declared : Number.NaN);
	}

	return { shapes, scales };
}

/**
 * À partir de stop_times, construit :
 *  - `routeStopSequences` : par (routeId, directionId), les itinéraires distincts empruntés ;
 *  - `routePatterns` et `tripPatterns` : les tracés empruntés, services partiels compris, et celui
 *    de chaque course — une déviation peut ne viser que certains d'entre eux ;
 *  - `tripStopSequences` : par tripId, l'horaire théorique ordonné — sert à réinsérer un arrêt
 *    supprimé absent du temps réel, avec son stop_sequence ;
 *  - `tripDepartures` et `tripArrivals` : par tripId, le départ du premier arrêt et l'arrivée au
 *    dernier — les deux ensemble disent quelles courses circulent à un instant donné.
 *
 * Chaque arrêt y reçoit son abscisse curviligne sur la shape de la course, remise à l'échelle de nos
 * kilomètres par le facteur qu'a déduit {@link buildShapes}. `projectedStops` compte les arrêts pour
 * lesquels il a fallu se rabattre sur une projection des coordonnées, faute d'abscisse déclarée.
 */
function buildSequences(
	csv: string,
	tripMeta: Map<string, TripMeta>,
	idToName: Map<string, string>,
	shapes: Map<string, ShapePoint[]>,
	scales: Map<string, number>,
	stopCoordinates: Map<string, Coordinates>,
): {
	routeStopSequences: Map<string, Map<number, OrderedStop[][]>>;
	routePatterns: Map<string, Map<number, RoutePattern[]>>;
	tripPatterns: Map<string, string>;
	tripStopSequences: Map<string, TripStop[]>;
	tripDepartures: Map<string, number>;
	tripArrivals: Map<string, number>;
	projectedStops: number;
} {
	const routeStopSequences = new Map<string, Map<number, OrderedStop[][]>>();
	const routePatterns = new Map<string, Map<number, RoutePattern[]>>();
	const tripPatterns = new Map<string, string>();
	const tripStopSequences = new Map<string, TripStop[]>();
	const tripDepartures = new Map<string, number>();
	const tripArrivals = new Map<string, number>();
	let projectedStops = 0;
	const result = () => ({
		routeStopSequences,
		routePatterns,
		tripPatterns,
		tripStopSequences,
		tripDepartures,
		tripArrivals,
		projectedStops,
	});

	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return result();

	const tripCol = header.indexOf("trip_id");
	const stopCol = header.indexOf("stop_id");
	const seqCol = header.indexOf("stop_sequence");
	const distCol = header.indexOf("shape_dist_traveled");
	const timeCol = header.indexOf("departure_time");
	const arrivalCol = header.indexOf("arrival_time");
	if (tripCol === -1 || stopCol === -1 || seqCol === -1) return result();

	// Rangs des arrêts qui ont fourni le départ et l'arrivée retenus pour chaque course : le fichier
	// n'est pas tenu d'être ordonné, et seuls le premier et le dernier arrêt bornent la course.
	const departureSequences = new Map<string, number>();
	const arrivalSequences = new Map<string, number>();

	// Regroupe les arrêts par trip (uniquement les trips connus).
	for (const row of rows) {
		const tripId = row[tripCol];
		const stopId = row[stopCol];
		if (!tripId || !stopId) continue;
		if (!tripMeta.has(tripId)) continue;
		const stopSequence = Number.parseInt(row[seqCol] ?? "", 10);
		if (Number.isNaN(stopSequence)) continue;

		const departure = timeCol === -1 ? Number.NaN : parseServiceTime(row[timeCol] ?? "");
		if (Number.isFinite(departure) && stopSequence < (departureSequences.get(tripId) ?? Number.POSITIVE_INFINITY)) {
			departureSequences.set(tripId, stopSequence);
			tripDepartures.set(tripId, departure);
		}

		const arrival = arrivalCol === -1 ? Number.NaN : parseServiceTime(row[arrivalCol] ?? "");
		if (Number.isFinite(arrival) && stopSequence > (arrivalSequences.get(tripId) ?? Number.NEGATIVE_INFINITY)) {
			arrivalSequences.set(tripId, stopSequence);
			tripArrivals.set(tripId, arrival);
		}

		let stops = tripStopSequences.get(tripId);
		if (stops === undefined) {
			stops = [];
			tripStopSequences.set(tripId, stops);
		}
		// Abscisse encore dans l'unité du producteur : elle est remise à l'échelle plus bas, une fois
		// la course rattachée à sa shape.
		stops.push({
			stopSequence,
			stopId,
			distance: distCol === -1 ? Number.NaN : Number.parseFloat(row[distCol] ?? ""),
			arrival,
		});
	}

	// Itinéraires distincts de chaque (route, sens), dédupliqués par suite de quais : ce sont les
	// tracés empruntés, que l'on compte au passage.
	const patterns = new Map<string, Map<string, RoutePattern>>();
	// Un même quai revient sur toutes les courses d'une shape : sa projection ne se calcule qu'une fois.
	const projected = new Map<string, number>();

	for (const [tripId, stops] of tripStopSequences) {
		stops.sort((a, b) => a.stopSequence - b.stopSequence);

		const meta = tripMeta.get(tripId);
		if (meta === undefined) continue;

		const shape = shapes.get(meta.shapeId);
		const scale = scales.get(meta.shapeId) ?? Number.NaN;
		for (const stop of stops) {
			if (Number.isFinite(scale) && Number.isFinite(stop.distance)) {
				stop.distance *= scale;
				continue;
			}

			stop.distance =
				shape === undefined ? Number.NaN : projectStop(shape, meta.shapeId, stop.stopId, stopCoordinates, projected);
			if (Number.isFinite(stop.distance)) projectedStops += 1;
		}

		const key = `${meta.routeId}\u0000${meta.directionId}`;
		const patternId = patternIdOf(stops);
		tripPatterns.set(tripId, patternId);

		let known = patterns.get(key);
		if (known === undefined) {
			known = new Map();
			patterns.set(key, known);
		}

		const pattern = known.get(patternId);
		if (pattern !== undefined) {
			pattern.tripCount += 1;
			continue;
		}

		known.set(patternId, {
			patternId,
			shapeId: meta.shapeId,
			stops: stops.map(({ stopId }) => ({ stopId, name: normalizeStopName(idToName.get(stopId) ?? "") })),
			tripCount: 1,
		});
	}

	for (const [key, known] of patterns) {
		const [routeId, direction] = key.split("\u0000") as [string, string];
		const directionId = Number.parseInt(direction, 10);
		if (Number.isNaN(directionId)) continue;

		const list = [...known.values()].sort((a, b) => b.stops.length - a.stops.length || b.tripCount - a.tripCount);

		let sequences = routeStopSequences.get(routeId);
		if (sequences === undefined) {
			sequences = new Map();
			routeStopSequences.set(routeId, sequences);
		}
		sequences.set(directionId, maximalVariants(list.map((pattern) => pattern.stops)));

		let directions = routePatterns.get(routeId);
		if (directions === undefined) {
			directions = new Map();
			routePatterns.set(routeId, directions);
		}
		directions.set(directionId, list);
	}

	return result();
}

/**
 * Abscisse d'un quai sur une shape, obtenue en y projetant ses coordonnées. Repli employé quand
 * stop_times.txt ne déclare pas d'abscisse exploitable : il est nettement moins sûr que la valeur
 * déclarée, un quai desservi deux fois par une shape à boucle s'y projetant indifféremment sur l'un
 * ou l'autre passage.
 */
function projectStop(
	shape: ShapePoint[],
	shapeId: string,
	stopId: string,
	stopCoordinates: Map<string, Coordinates>,
	cache: Map<string, number>,
): number {
	const key = `${shapeId}|${stopId}`;
	const cached = cache.get(key);
	if (cached !== undefined) return cached;

	const coordinates = stopCoordinates.get(stopId);
	const distance =
		coordinates === undefined ? Number.NaN : (projectOnShape(shape, coordinates)?.distance ?? Number.NaN);

	cache.set(key, distance);
	return distance;
}

/**
 * L'identifiant d'un tracé emprunté : une empreinte de sa suite de quais. Elle ne dépend que des
 * arrêts, et survit donc à une régénération du GTFS qui ne les touche pas.
 */
function patternIdOf(stops: readonly { stopId: string }[]): string {
	return createHash("sha1")
		.update(stops.map(({ stopId }) => stopId).join(">"))
		.digest("hex")
		.slice(0, 12);
}

/**
 * Ne garde que les itinéraires qui ne sont pas déjà contenus dans un plus long : un service partiel
 * n'apporte rien face au parcours complet de sa branche, alors que deux branches distinctes se
 * conservent l'une l'autre.
 */
function maximalVariants(list: OrderedStop[][]): OrderedStop[][] {
	const sorted = [...list].sort((a, b) => b.length - a.length);

	const kept: OrderedStop[][] = [];
	for (const variant of sorted) {
		if (!kept.some((candidate) => isSubsequence(variant, candidate))) kept.push(variant);
	}
	return kept;
}

/** Vrai si tous les quais de `needle` apparaissent dans `haystack`, dans le même ordre. */
function isSubsequence(needle: OrderedStop[], haystack: OrderedStop[]): boolean {
	let index = 0;
	for (const stop of haystack) {
		if (index < needle.length && (needle[index] as OrderedStop).stopId === stop.stopId) index += 1;
	}
	return index === needle.length;
}

/** Parseur CSV minimal gérant les champs entre guillemets. */
export function* parseCsv(csv: string): Generator<string[]> {
	let start = 0;
	while (start < csv.length) {
		let end = csv.indexOf("\n", start);
		if (end === -1) end = csv.length;
		const line = csv.charCodeAt(end - 1) === 13 ? csv.slice(start, end - 1) : csv.slice(start, end);
		start = end + 1;
		if (line.length === 0) continue;
		yield line.includes('"') ? parseQuotedLine(line) : line.split(",");
	}
}

function parseQuotedLine(line: string): string[] {
	const out: string[] = [];
	let current = "";
	let inQuotes = false;

	for (let i = 0; i < line.length; i += 1) {
		const char = line[i];
		if (inQuotes) {
			if (char === '"') {
				if (line[i + 1] === '"') {
					current += '"';
					i += 1;
				} else {
					inQuotes = false;
				}
			} else {
				current += char;
			}
		} else if (char === '"') {
			inQuotes = true;
		} else if (char === ",") {
			out.push(current);
			current = "";
		} else {
			current += char;
		}
	}

	out.push(current);
	return out;
}
