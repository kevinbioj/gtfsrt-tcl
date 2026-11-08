import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import { GTFS_LOADER_HEAP_MB } from "../config.js";
import type { Coordinates, ShapePoint } from "../utils/geometry.js";
import { detachTables, type PackedTables, ScheduleTable, ShapeTable } from "./packed-tables.js";

export type { ShapePoint };

export type RouteDirection = { directionId: number; headsigns: string[] };

/** Un arrêt dans l'itinéraire d'une ligne : son quai (stopId) et son nom normalisé. */
export type OrderedStop = { stopId: string; name: string };

/**
 * Un tracé emprunté : les courses d'une ligne et d'un sens qui desservent exactement la même suite
 * de quais. C'est ce qui départage deux services d'un même sens qui ne passent pas au même endroit.
 *
 * Il s'identifie par sa suite de quais, et non par son `shape_id` : la shape est une empreinte de
 * géométrie qu'une régénération du GTFS peut renouveler sans qu'aucun arrêt ne bouge.
 */
export type RoutePattern = {
	/** Empreinte de la suite de quais (cf. `patternIdOf`). */
	patternId: string;
	/** La shape de ses courses — celle de la première rencontrée, s'il devait y en avoir plusieurs. */
	shapeId: string;
	stops: OrderedStop[];
	/** Nombre de courses du GTFS qui l'empruntent, tous services confondus. */
	tripCount: number;
};

/**
 * Un arrêt dans l'horaire théorique d'un trip : sa position (stop_sequence), son quai, son abscisse
 * curviligne sur la shape de la course, en kilomètres, et son heure d'arrivée.
 *
 * L'abscisse vaut `NaN` lorsqu'on n'a pas su la déterminer — le GTFS ne la déclare pas et l'arrêt n'a
 * pas de coordonnées. L'arrivée vaut `NaN` lorsque `stop_times.txt` ne la donne pas ; elle se compte
 * en secondes depuis le minuit de la journée de service, comme {@link StaticGtfs.tripDepartures}, et
 * dépasse donc 86 400 pour une course qui déborde sur le lendemain.
 */
export type TripStop = { stopSequence: number; stopId: string; distance: number; arrival: number };

/**
 * Ce que le GTFS statique dit d'une course : sa ligne, son sens, sa destination affichée, son tracé,
 * et le service qui décide des jours où elle circule.
 */
export type TripMeta = {
	routeId: string;
	directionId: number;
	headsign: string;
	shapeId: string;
	serviceId: string;
};

/**
 * Le calendrier hebdomadaire d'un service : les jours qu'il dessert et l'enveloppe de dates où cela
 * vaut. Les exceptions datées de `calendar_dates.txt` s'y ajoutent ou s'en retranchent ensuite (cf.
 * {@link StaticGtfs.calendarExceptions}).
 */
export type ServiceCalendar = {
	/** Jours desservis, du lundi (indice 0) au dimanche (indice 6), dans l'ordre des colonnes du GTFS. */
	weekdays: boolean[];
	/** Bornes INCLUSES de validité, au format `AAAAMMJJ` du GTFS. Vides si le fichier ne les déclare pas. */
	startDate: string;
	endDate: string;
};

/** Journée ajoutée par une exception de `calendar_dates.txt`. */
export const SERVICE_ADDED = 1;
/** Journée retirée par une exception de `calendar_dates.txt`. */
export const SERVICE_REMOVED = 2;

/**
 * Une table qu'on ne fait que consulter : une `Map`, ou l'une des tables compactées que le processus
 * de chargement transmet (cf. `ScheduleTable`, `ShapeTable`). Ce qu'elle rend se lit sans se modifier.
 */
export interface Lookup<K, V> {
	get(key: K): V | undefined;
	has(key: K): boolean;
	readonly size: number;
}

/** L'enveloppe des quais du GTFS, en degrés. */
export type StopBounds = { minLatitude: number; maxLatitude: number; minLongitude: number; maxLongitude: number };

export type StaticGtfs = {
	/** routeId → directions desservies avec leurs terminus (headsigns). */
	routeDirections: Map<string, RouteDirection[]>;
	/**
	 * routeId → directionId → itinéraires ordonnés des arrêts, services partiels exclus. Plusieurs par
	 * sens : une ligne à branches ne se résume pas à un seul parcours.
	 */
	routeStopSequences: Map<string, Map<number, OrderedStop[][]>>;
	/**
	 * routeId → directionId → tracés empruntés, du plus long au plus court. Contrairement à
	 * {@link routeStopSequences}, les services partiels y restent : ce sont des courses à part entière,
	 * qu'une déviation peut viser ou non.
	 */
	routePatterns: Map<string, Map<number, RoutePattern[]>>;
	/** tripId → identifiant du tracé qu'il emprunte (cf. {@link RoutePattern}). */
	tripPatterns: Map<string, string>;
	/** routeId → nom commercial de la ligne (`route_short_name`) : « C1 », « T3 ». */
	routeNames: Map<string, string>;
	/**
	 * routeId → couleurs de la ligne (`route_color`, `route_text_color`), en « #RRGGBB ». Une ligne qui
	 * n'en déclare pas n'y figure pas.
	 */
	routeColors: Map<string, RouteColors>;
	/** routeId → rang de la ligne (`route_sort_order`). Une ligne qui n'en déclare pas n'y figure pas. */
	routeSortOrders: Map<string, number>;
	/** routeId → agence qui l'exploite (`routes.agency_id`). */
	routeAgencies: Map<string, string>;
	/** agencyId → nom de l'agence (`agency.txt`). */
	agencies: Map<string, string>;
	/** tripId → horaire théorique ordonné (pour réinsérer un arrêt supprimé absent du temps réel). */
	tripStopSequences: Lookup<string, TripStop[]>;
	/**
	 * tripId → départ théorique du premier arrêt, en secondes depuis minuit de la journée de service
	 * — donc au-delà de 86 400 pour une course qui déborde sur le lendemain, comme le GTFS l'écrit.
	 */
	tripDepartures: Map<string, number>;
	/** tripId → arrivée théorique au dernier arrêt, dans la même unité que {@link tripDepartures}. */
	tripArrivals: Map<string, number>;
	/** serviceId → jours desservis et enveloppe de validité (`calendar.txt`). */
	calendars: Map<string, ServiceCalendar>;
	/**
	 * serviceId → date `AAAAMMJJ` → {@link SERVICE_ADDED} ou {@link SERVICE_REMOVED}, depuis
	 * `calendar_dates.txt`.
	 */
	calendarExceptions: Map<string, Map<string, number>>;
	/** serviceId → courses de ce service : l'index inverse de `trips.txt`. */
	serviceTrips: Map<string, string[]>;
	/** tripId → clé de la course qu'il assure, celle que toutes ses versions partagent (cf. {@link courseVersions}). */
	tripCourseKeys: Map<string, string>;
	/**
	 * Clé de course → les identifiants qui la décrivent, un par service : mêmes ligne, sens, quai de
	 * départ et horaire, mais un `trip_id` différent par service qui l'assure.
	 */
	courseVersions: Map<string, string[]>;
	/** stopId → libellé de l'arrêt, tel que le GTFS l'écrit. Les stations n'y figurent pas. */
	stopNames: Map<string, string>;
	/** stopId → coordonnées du quai. */
	stopCoordinates: Map<string, Coordinates>;
	/** L'enveloppe des quais, ou `null` pour un GTFS qui n'en situe aucun. */
	stopBounds: StopBounds | null;
	/** tripId → ligne, sens et destination théoriques. */
	trips: Map<string, TripMeta>;
	/** shapeId → tracé de la course, chaque point portant son abscisse curviligne en kilomètres. */
	shapes: Lookup<string, ShapePoint[]>;
	/**
	 * areaId → libellé des zones tarifaires : celles d'`areas.txt` (Fares v2) s'il y en a, sinon les
	 * `zone_id` que portent les quais. C'est ce parmi quoi l'on choisit la zone d'un arrêt provisoire.
	 */
	fareAreas: Map<string, string>;
	/**
	 * Les stations (`location_type` = 1) : leur libellé et, si le GTFS les donne, leurs coordonnées.
	 * Ce ne sont pas des quais — rien ne s'y dessert —, mais ce à quoi un arrêt provisoire peut se
	 * rattacher comme `parent_station`.
	 */
	stations: Map<string, Station>;
};

/** Les couleurs d'une ligne, en « #RRGGBB ». */
export type RouteColors = { color: string; textColor: string };

/** Une station du GTFS : un pôle qui regroupe des quais. */
export type Station = { name: string; coordinates: Coordinates | null };

/**
 * Ce que le processus de chargement transmet : le GTFS sans ses deux grosses tables, qui voyagent à
 * part, compactées (cf. `packTables`).
 */
export type LoadedGtfs = Omit<StaticGtfs, "tripStopSequences" | "shapes">;

/** Le message du processus de chargement : le GTFS et sa signature, ou rien en cas d'échec. */
export type LoaderMessage =
	| { ok: true; data: LoadedGtfs; packed: PackedTables; signature: string | null }
	| { ok: false; signature: null };

/** Un GTFS vide : celui que l'on sert faute d'avoir jamais pu en charger un. */
export function emptyGtfs(): StaticGtfs {
	return {
		routeDirections: new Map(),
		routeStopSequences: new Map(),
		routePatterns: new Map(),
		tripPatterns: new Map(),
		routeNames: new Map(),
		routeColors: new Map(),
		routeSortOrders: new Map(),
		routeAgencies: new Map(),
		agencies: new Map(),
		tripStopSequences: new Map(),
		tripDepartures: new Map(),
		tripArrivals: new Map(),
		calendars: new Map(),
		calendarExceptions: new Map(),
		serviceTrips: new Map(),
		tripCourseKeys: new Map(),
		courseVersions: new Map(),
		stopNames: new Map(),
		stopCoordinates: new Map(),
		stopBounds: null,
		trips: new Map(),
		shapes: new Map(),
		fareAreas: new Map(),
		stations: new Map(),
	};
}

let currentInterval: NodeJS.Timeout | undefined;

/**
 * Le GTFS statique, tenu à jour : rechargé dès que sa version publiée change, sans quoi les
 * identifiants de course et d'arrêt finissent par ne plus correspondre au temps réel.
 *
 * Il se charge dans un processus à part (cf. `loadGtfs`) : le GTFS de TCL est lourd — près de trois
 * millions d'horaires —, et le lire ici gèlerait les feeds et l'interface plusieurs secondes, puis
 * garderait des centaines de mégaoctets d'objets. Le processus rend ses deux grosses tables compactées
 * en tableaux typés, et se termine en emportant ce que leur lecture lui a coûté.
 *
 * Un chargement en échec garde le GTFS précédent. Faute du tout premier, c'est un GTFS vide : le temps
 * réel se publie alors tel que SIRI Lite le donne, sans rien de ce qui se saisit, jusqu'à ce que la
 * vérification suivante en charge un.
 */
export async function useStaticGtfs(url: string, checkInterval: number, onReload?: () => void) {
	const loaded = await loadGtfs(url);
	if (loaded === undefined) console.error("✘ Static GTFS unavailable — starting without it, retrying later.");

	const resource = {
		data: loaded?.data ?? emptyGtfs(),
		importedAt: Temporal.Now.instant(),
	};
	// Signature de la version chargée (ETag/Last-Modified) : sert à détecter un changement sans
	// retélécharger l'archive à chaque vérification. `null` : rien de chargé, la prochaine vérification
	// retente.
	let signature = loaded?.signature ?? null;
	let reloading = false;

	if (currentInterval !== undefined) {
		clearInterval(currentInterval);
	}

	currentInterval = setInterval(async () => {
		if (reloading) return;
		reloading = true;
		try {
			// Vérification légère par HEAD : on ne retélécharge que si la version publiée a changé.
			const remote = await fetchSignature(url);
			if (remote === null || (remote === signature && resource.data.trips.size > 0)) return; // inchangé, ou signature indisponible → on garde

			const next = await loadGtfs(url);
			if (next === undefined || next.data.trips.size === 0) return; // chargement échoué → on garde l'ancien
			resource.data = next.data;
			resource.importedAt = Temporal.Now.instant();
			signature = next.signature;
			console.log("✓ Static GTFS updated (new version published).");
			onReload?.();
		} finally {
			reloading = false;
		}
	}, checkInterval);

	return resource;
}

/**
 * Charge le GTFS dans un processus à part (cf. `static-gtfs.loader.ts`), et le reconstitue ici.
 * `undefined` si le chargement échoue — archive introuvable, mal formée, ou processus à court de
 * mémoire.
 *
 * Un processus, et non un worker : la lecture coûte plus d'un gigaoctet, et l'allocateur garde pour
 * le processus ce qu'un worker lui a rendu en se terminant — près de 600 Mo de plus, à demeure. Un
 * processus qui se termine, lui, rend tout au système. Le GTFS revient sérialisé par V8, tables
 * compactées comprises (cf. `packTables`).
 */
async function loadGtfs(url: string): Promise<{ data: StaticGtfs; signature: string | null } | undefined> {
	// En développement (tsx), le module se lit en .ts ; construit, en .js. Le processus hérite des
	// options de celui-ci — le chargeur de tsx compris —, plafond du tas en plus.
	const loaderPath = fileURLToPath(
		new URL(import.meta.url.endsWith(".ts") ? "./static-gtfs.loader.ts" : "./static-gtfs.loader.js", import.meta.url),
	);

	const message = await new Promise<LoaderMessage | undefined>((resolve) => {
		const child = fork(loaderPath, [url], {
			serialization: "advanced",
			execArgv: [...process.execArgv, `--max-old-space-size=${GTFS_LOADER_HEAP_MB}`],
		});
		let received: LoaderMessage | undefined;
		child.once("message", (value) => {
			received = value as LoaderMessage;
		});
		child.once("error", (cause) => {
			console.error("✘ Static GTFS loader failed!", cause);
		});
		child.once("exit", (code, signal) => {
			if (received === undefined) console.error(`✘ Static GTFS loader exited (code ${code}, signal ${signal}).`);
			resolve(received);
		});
	});

	if (message === undefined || !message.ok) return undefined;

	const startedAt = performance.now();
	const packed = detachTables(message.packed);
	const data: StaticGtfs = {
		...message.data,
		tripStopSequences: new ScheduleTable(packed.schedules),
		shapes: new ShapeTable(packed.shapes),
	};
	console.log(
		`✓ Static GTFS ready in the main thread in ${Math.round(performance.now() - startedAt)}ms (heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB, rss ${Math.round(process.memoryUsage().rss / 1e6)} MB).`,
	);
	return { data, signature: message.signature };
}

/** Normalise un nom d'arrêt : minuscules, sans accents, alphanumérique compacté. */
export function normalizeStopName(name: string): string {
	return name
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** Version publiée du GTFS (ETag de préférence, sinon Last-Modified). `null` si aucun en-tête exploitable. */
export function signatureOf(response: { headers: Headers }): string | null {
	return response.headers.get("etag") ?? response.headers.get("last-modified");
}

/** Requête HEAD légère : renvoie la signature de la version publiée, ou `null` si indisponible. */
export async function fetchSignature(url: string): Promise<string | null> {
	try {
		const response = await fetch(url, { method: "HEAD" });
		if (!response.ok) return null;
		return signatureOf(response);
	} catch {
		return null;
	}
}

/**
 * La clé d'une course : sa ligne, son sens, le quai de son premier arrêt et son départ en secondes
 * depuis le minuit de la journée de service (cf. `buildCourses`).
 */
export function courseKey(routeId: string, directionId: number, stopId: string, departure: number): string {
	return `${routeId}|${directionId}|${stopId}|${departure}`;
}

/**
 * Un horaire GTFS (« 07:04:00 ») en secondes depuis minuit de la journée de service, ou `NaN` s'il
 * ne s'écrit pas ainsi. Les heures au-delà de 24 sont légitimes et se conservent telles quelles :
 * « 25:10:00 » est une course de la journée de la veille qui déborde sur le lendemain.
 */
export function parseServiceTime(value: string): number {
	const parts = value.split(":");
	if (parts.length < 2) return Number.NaN;

	const hours = Number.parseInt(parts[0] ?? "", 10);
	const minutes = Number.parseInt(parts[1] ?? "", 10);
	const seconds = parts.length > 2 ? Number.parseInt(parts[2] ?? "", 10) : 0;
	if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds)) return Number.NaN;

	return hours * 3600 + minutes * 60 + seconds;
}
