import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { ROAD_GRAPH_PATH } from "../config.js";
import {
	COORDINATE_SCALE,
	GRAPH_HEADER_LENGTH,
	type GraphBounds,
	type GraphCounts,
	graphLayout,
	writeGraphHeader,
} from "../routing/graph-format.js";
import { readOsmPbf } from "../routing/read-osm-pbf.js";
import { haversine } from "../utils/geometry.js";

/**
 * Construit le graphe routier que l'éditeur de déviations emploie pour accrocher un tracé aux rues.
 *
 *     osmium extract -b 4.0,45.47,5.35,46.36 rhone-alpes-latest.osm.pbf -o lyon.osm.pbf
 *     pnpm build:graph -- --input lyon.osm.pbf
 *
 * À lancer à la main, jamais au démarrage du producteur : la construction dure une minute et demande
 * un demi-gigaoctet, quand le service, lui, n'a plus qu'à relire le résultat. L'extrait `.osm.pbf`
 * n'a pas sa place dans le dépôt ; le fichier produit, lui, va dans `.cache`, déjà monté en volume.
 *
 * Le travail tient en trois temps : indexer tous les nœuds du fichier, retenir les chemins
 * carrossables et compter leurs nœuds, puis découper ces chemins en arêtes aux carrefours.
 */

/**
 * Les valeurs de `highway` qui décrivent une voie carrossable.
 *
 * Y figurent les voies réservées et les rues piétonnes : un autobus dévié y passe, et c'est
 * justement là que l'exploitation le fait passer. En sont exclus les cheminements où aucun véhicule
 * ne tient — trottoirs, pistes cyclables, escaliers, chemins agricoles — non pas comme une
 * restriction, mais parce qu'accrocher un tracé sur le trottoir plutôt que sur la rue qu'il longe
 * donnerait un itinéraire faux.
 */
const DRIVABLE = new Set([
	"motorway",
	"motorway_link",
	"trunk",
	"trunk_link",
	"primary",
	"primary_link",
	"secondary",
	"secondary_link",
	"tertiary",
	"tertiary_link",
	"unclassified",
	"residential",
	"living_street",
	"service",
	"busway",
	"bus_guideway",
	"pedestrian",
	"road",
]);

/**
 * Un chemin est-il une voie carrossable ?
 *
 * AUCUNE restriction de circulation n'entre en ligne de compte — ni sens unique, ni interdiction
 * d'accès, ni voie privée. Un tracé de déviation n'est pas un itinéraire calculé pour un véhicule :
 * c'est un dessin que fait quelqu'un qui sait ce que l'exploitation a décidé. Une rue inversée le
 * temps d'un chantier, un accès de service ouvert pour l'occasion, une voie fermée à tous sauf aux
 * bus : le graphe doit les offrir, et c'est au dessinateur de trancher. Lui connaît l'arrêté,
 * OpenStreetMap non.
 *
 * Seule la géométrie garde un droit de veto : une aire — parking, place — est une surface et non un
 * axe, et router sur son contour ferait faire des tours de pâté de maisons.
 */
function isDrivableRoad(tags: Map<string, string>): boolean {
	const highway = tags.get("highway");
	if (highway === undefined || !DRIVABLE.has(highway)) return false;

	return tags.get("area") !== "yes";
}

type Allocate<T> = (size: number) => T;
type NumberArray = Float64Array | Int32Array | Uint32Array | Uint8Array;

/** Un tableau typé dont on ne connaît pas la taille d'avance, doublé au fur et à mesure. */
class Growable<T extends NumberArray> {
	private data: T;
	private count = 0;

	constructor(private readonly allocate: Allocate<T>) {
		this.data = allocate(1 << 16);
	}

	get length(): number {
		return this.count;
	}

	push(value: number): void {
		if (this.count === this.data.length) {
			const next = this.allocate(this.data.length * 2);
			(next as Float64Array).set(this.data as unknown as Float64Array);
			this.data = next;
		}
		this.data[this.count] = value;
		this.count += 1;
	}

	at(index: number): number {
		return this.data[index] as number;
	}

	view(): T {
		return this.data.subarray(0, this.count) as T;
	}
}

type Bbox = { minLatitude: number; minLongitude: number; maxLatitude: number; maxLongitude: number };

function parseArguments(argv: readonly string[]) {
	let input: string | undefined;
	let output = ROAD_GRAPH_PATH;
	let bbox: Bbox | undefined;

	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index + 1];
		switch (argv[index]) {
			case "--input":
				input = value;
				index += 1;
				break;
			case "--output":
				output = value ?? output;
				index += 1;
				break;
			case "--bbox": {
				const parts = (value ?? "").split(",").map(Number);
				if (parts.length !== 4 || parts.some(Number.isNaN)) {
					throw new Error("--bbox attend « latMin,lonMin,latMax,lonMax ».");
				}
				bbox = {
					minLatitude: parts[0]!,
					minLongitude: parts[1]!,
					maxLatitude: parts[2]!,
					maxLongitude: parts[3]!,
				};
				index += 1;
				break;
			}
			// Le séparateur que pnpm transmet tel quel (`pnpm build:graph -- --input …`).
			case "--":
				break;
			default:
				throw new Error(`Argument inconnu : ${argv[index]}.`);
		}
	}

	if (input === undefined) throw new Error("--input attend le chemin d'un extrait .osm.pbf.");
	return { input, output, bbox };
}

function main(): void {
	const { input, output, bbox } = parseArguments(process.argv.slice(2));
	const started = Date.now();

	// ————— Temps 1 : l'index des nœuds —————
	//
	// TOUS les nœuds du fichier y passent, et pas seulement ceux des routes : les chemins n'arrivent
	// qu'après eux, et l'on ne sait donc pas encore lesquels serviront. Sept millions et demi de
	// nœuds tiennent en cent vingt mégaoctets ; c'est le prix d'une passe unique.
	//
	// Les identifiants arrivent triés — les nœuds « denses » les écrivent en écarts croissants, et
	// les blocs se suivent dans l'ordre. La recherche se fait donc par dichotomie, sans table de
	// hachage, qui coûterait ici plusieurs fois la place de l'index lui-même.
	const nodeIds = new Growable<Float64Array>((size) => new Float64Array(size));
	const nodeLatitudes = new Growable<Int32Array>((size) => new Int32Array(size));
	const nodeLongitudes = new Growable<Int32Array>((size) => new Int32Array(size));

	// ————— Temps 2 : les chemins carrossables —————
	const wayNodes = new Growable<Uint32Array>((size) => new Uint32Array(size));
	const wayStart = new Growable<Uint32Array>((size) => new Uint32Array(size));

	let usage: Uint8Array | undefined;
	let identifiers: Float64Array | undefined;
	let roads = 0;
	let incomplete = 0;
	let outside = 0;
	const references: number[] = [];

	readOsmPbf(input, {
		onNode(id, latitude, longitude) {
			if (usage !== undefined) throw new Error("Nœud rencontré après un chemin : trier l'extrait avec osmium.");
			if (nodeIds.length > 0 && id <= nodeIds.at(nodeIds.length - 1)) {
				throw new Error("Identifiants de nœuds non croissants : trier l'extrait avec osmium.");
			}

			nodeIds.push(id);
			nodeLatitudes.push(Math.round(latitude * COORDINATE_SCALE));
			nodeLongitudes.push(Math.round(longitude * COORDINATE_SCALE));
		},

		onWay(tags, readReferences) {
			if (!isDrivableRoad(tags)) return;

			// Le premier chemin clôt l'index des nœuds : rien n'y sera plus ajouté.
			if (usage === undefined) {
				identifiers = nodeIds.view();
				usage = new Uint8Array(identifiers.length);
			}

			const refs = readReferences();
			if (refs.length < 2) return;

			references.length = 0;
			for (const reference of refs) {
				const index = search(identifiers!, reference);
				// Un chemin dont un nœud manque déborde l'extrait. Le couper serait pire que l'écarter :
				// on obtiendrait une rue qui s'arrête au milieu de nulle part.
				if (index < 0) {
					incomplete += 1;
					return;
				}
				references.push(index);
			}

			if (bbox !== undefined && !references.some((index) => inside(bbox, nodeLatitudes, nodeLongitudes, index))) {
				outside += 1;
				return;
			}

			wayStart.push(wayNodes.length);
			roads += 1;

			for (const index of references) {
				wayNodes.push(index);
				// Compté jusqu'à deux : au-delà, seul importe que le nœud soit un carrefour.
				if (usage[index]! < 2) usage[index] = usage[index]! + 1;
			}

			// Les deux bouts d'un chemin sont des carrefours par construction — c'est là que s'arrête
			// l'arête, même si aucun autre chemin n'y aboutit.
			usage[references[0]!] = 2;
			usage[references[references.length - 1]!] = 2;
		},
	});

	if (usage === undefined) throw new Error("Aucune route trouvée dans cet extrait.");
	wayStart.push(wayNodes.length);

	console.log(
		`✓ ${nodeIds.length.toLocaleString("fr-FR")} nœuds indexés, ${roads.toLocaleString("fr-FR")} chemins retenus` +
			`${incomplete > 0 ? `, ${incomplete} incomplets écartés` : ""}` +
			`${outside > 0 ? `, ${outside} hors emprise` : ""}.`,
	);

	// ————— Temps 3 : le découpage en arêtes —————
	const graph = buildEdges({ nodeLatitudes, nodeLongitudes, wayNodes, wayStart, usage });
	const grid = buildGrid(graph);
	const arcs = buildArcs(graph);

	const counts: GraphCounts = {
		nodeCount: graph.nodeCount,
		edgeCount: graph.edgeFrom.length,
		geometryCount: graph.geometryLatitudes.length,
		arcCount: arcs.arcEdges.length,
		gridColumns: grid.columns,
		gridRows: grid.rows,
		cellEdgeCount: grid.cellEdges.length,
	};

	write(output, counts, graph.bounds, graph, grid, arcs);

	const layout = graphLayout(counts);
	console.log(
		`✓ ${counts.nodeCount.toLocaleString("fr-FR")} carrefours, ${counts.edgeCount.toLocaleString("fr-FR")} arêtes, ` +
			`${counts.geometryCount.toLocaleString("fr-FR")} points de géométrie, ` +
			`${graph.totalLength.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} km de voirie.`,
	);
	console.log(
		`✓ Grille ${grid.columns} × ${grid.rows}, ${counts.cellEdgeCount.toLocaleString("fr-FR")} appartenances.`,
	);
	console.log(
		`✓ ${output} — ${(layout.byteLength / 1e6).toFixed(1)} Mo en ${((Date.now() - started) / 1000).toFixed(1)} s, ` +
			`pic mémoire ${Math.round(process.memoryUsage().rss / 1e6)} Mo.`,
	);
}

/** Le rang d'un identifiant dans l'index trié, ou -1. */
function search(identifiers: Float64Array, id: number): number {
	let low = 0;
	let high = identifiers.length - 1;

	while (low <= high) {
		const middle = (low + high) >> 1;
		const value = identifiers[middle]!;
		if (value === id) return middle;
		if (value < id) low = middle + 1;
		else high = middle - 1;
	}

	return -1;
}

function inside(bbox: Bbox, latitudes: Growable<Int32Array>, longitudes: Growable<Int32Array>, index: number): boolean {
	const latitude = latitudes.at(index) / COORDINATE_SCALE;
	const longitude = longitudes.at(index) / COORDINATE_SCALE;
	return (
		latitude >= bbox.minLatitude &&
		latitude <= bbox.maxLatitude &&
		longitude >= bbox.minLongitude &&
		longitude <= bbox.maxLongitude
	);
}

type BuiltGraph = {
	nodeCount: number;
	nodeLatitudes: Growable<Int32Array>;
	nodeLongitudes: Growable<Int32Array>;
	edgeFrom: Growable<Uint32Array>;
	edgeTo: Growable<Uint32Array>;
	edgeLengths: Growable<Float64Array>;
	edgeGeometryStart: Growable<Uint32Array>;
	geometryLatitudes: Growable<Int32Array>;
	geometryLongitudes: Growable<Int32Array>;
	bounds: GraphBounds;
	totalLength: number;
};

/**
 * Découpe chaque chemin aux carrefours.
 *
 * Un nœud vu par deux chemins, ou deux fois par le même, ouvre et ferme une arête ; les autres
 * restent de la géométrie intermédiaire, conservée telle quelle — c'est elle qui fait qu'un tracé
 * accroché épouse la courbe de la rue au lieu de la couper en corde.
 */
function buildEdges(source: {
	nodeLatitudes: Growable<Int32Array>;
	nodeLongitudes: Growable<Int32Array>;
	wayNodes: Growable<Uint32Array>;
	wayStart: Growable<Uint32Array>;
	usage: Uint8Array;
}): BuiltGraph {
	const nodeLatitudes = new Growable<Int32Array>((size) => new Int32Array(size));
	const nodeLongitudes = new Growable<Int32Array>((size) => new Int32Array(size));
	const edgeFrom = new Growable<Uint32Array>((size) => new Uint32Array(size));
	const edgeTo = new Growable<Uint32Array>((size) => new Uint32Array(size));
	const edgeLengths = new Growable<Float64Array>((size) => new Float64Array(size));
	const edgeGeometryStart = new Growable<Uint32Array>((size) => new Uint32Array(size));
	const geometryLatitudes = new Growable<Int32Array>((size) => new Int32Array(size));
	const geometryLongitudes = new Growable<Int32Array>((size) => new Int32Array(size));

	// Le rang d'un nœud du graphe, attribué à la première arête qui l'emploie : les carrefours sont
	// vingt fois moins nombreux que les nœuds du fichier, et les numéroter à part rend la liste
	// d'adjacence compacte.
	const ranks = new Int32Array(source.usage.length).fill(-1);
	let nodeCount = 0;

	const rank = (index: number): number => {
		let known = ranks[index]!;
		if (known < 0) {
			known = nodeCount;
			ranks[index] = known;
			nodeCount += 1;
			nodeLatitudes.push(source.nodeLatitudes.at(index));
			nodeLongitudes.push(source.nodeLongitudes.at(index));
		}
		return known;
	};

	const bounds = {
		minLatitude: Number.POSITIVE_INFINITY,
		minLongitude: Number.POSITIVE_INFINITY,
		maxLatitude: Number.NEGATIVE_INFINITY,
		maxLongitude: Number.NEGATIVE_INFINITY,
	};
	const stretch = (index: number): void => {
		const latitude = source.nodeLatitudes.at(index);
		const longitude = source.nodeLongitudes.at(index);
		if (latitude < bounds.minLatitude) bounds.minLatitude = latitude;
		if (latitude > bounds.maxLatitude) bounds.maxLatitude = latitude;
		if (longitude < bounds.minLongitude) bounds.minLongitude = longitude;
		if (longitude > bounds.maxLongitude) bounds.maxLongitude = longitude;
	};

	// Réemployés à chaque segment : la longueur d'une arête se mesure sommet par sommet.
	const start = { latitude: 0, longitude: 0 };
	const end = { latitude: 0, longitude: 0 };
	const span = (from: number, to: number): number => {
		start.latitude = source.nodeLatitudes.at(from) / COORDINATE_SCALE;
		start.longitude = source.nodeLongitudes.at(from) / COORDINATE_SCALE;
		end.latitude = source.nodeLatitudes.at(to) / COORDINATE_SCALE;
		end.longitude = source.nodeLongitudes.at(to) / COORDINATE_SCALE;
		return haversine(start, end);
	};

	let totalLength = 0;
	const wayCount = source.wayStart.length - 1;

	for (let way = 0; way < wayCount; way += 1) {
		const first = source.wayStart.at(way);
		const last = source.wayStart.at(way + 1);

		let anchor = first;
		stretch(source.wayNodes.at(first));

		for (let position = first + 1; position < last; position += 1) {
			const node = source.wayNodes.at(position);
			stretch(node);
			if (source.usage[node]! < 2) continue;

			// Une arête sans longueur — deux fois le même nœud à la suite — ne décrit rien.
			if (position === anchor + 1 && source.wayNodes.at(anchor) === node) {
				anchor = position;
				continue;
			}

			edgeFrom.push(rank(source.wayNodes.at(anchor)));
			edgeTo.push(rank(node));
			edgeGeometryStart.push(geometryLatitudes.length);

			let length = 0;
			for (let step = anchor; step < position; step += 1) {
				length += span(source.wayNodes.at(step), source.wayNodes.at(step + 1));
			}
			for (let interior = anchor + 1; interior < position; interior += 1) {
				geometryLatitudes.push(source.nodeLatitudes.at(source.wayNodes.at(interior)));
				geometryLongitudes.push(source.nodeLongitudes.at(source.wayNodes.at(interior)));
			}

			edgeLengths.push(length);
			totalLength += length;
			anchor = position;
		}
	}

	edgeGeometryStart.push(geometryLatitudes.length);

	return {
		nodeCount,
		nodeLatitudes,
		nodeLongitudes,
		edgeFrom,
		edgeTo,
		edgeLengths,
		edgeGeometryStart,
		geometryLatitudes,
		geometryLongitudes,
		bounds,
		totalLength,
	};
}

type BuiltGrid = { columns: number; rows: number; cellStart: Uint32Array; cellEdges: Uint32Array };

/**
 * La grille d'accrochage : quelles arêtes traversent quelle maille.
 *
 * Sa finesse se déduit du réseau plutôt que d'être fixée en mètres — environ quatre mailles par
 * arête. Un extrait rural et un extrait urbain donnent alors des mailles de tailles différentes mais
 * une densité comparable, et c'est la densité qui décide du coût d'un accrochage.
 */
function buildGrid(graph: BuiltGraph): BuiltGrid {
	const edgeCount = graph.edgeFrom.length;
	const spanLatitude = Math.max(1, graph.bounds.maxLatitude - graph.bounds.minLatitude);
	const spanLongitude = Math.max(1, graph.bounds.maxLongitude - graph.bounds.minLongitude);

	const middle = ((graph.bounds.minLatitude + graph.bounds.maxLatitude) / 2 / COORDINATE_SCALE) * (Math.PI / 180);
	const height = spanLatitude;
	const width = spanLongitude * Math.cos(middle);

	const target = Math.max(1, edgeCount * 4);
	const rows = Math.max(1, Math.round(Math.sqrt((target * height) / width)));
	const columns = Math.max(1, Math.round(target / rows));

	const column = (longitude: number): number =>
		Math.min(columns - 1, Math.max(0, Math.floor(((longitude - graph.bounds.minLongitude) / spanLongitude) * columns)));
	const row = (latitude: number): number =>
		Math.min(rows - 1, Math.max(0, Math.floor(((latitude - graph.bounds.minLatitude) / spanLatitude) * rows)));

	// Les mailles de chaque arête, mises de côté pour n'avoir à parcourir la géométrie qu'une fois :
	// le remplissage de la compression creuse en demanderait sinon un second parcours identique.
	const edgeCells = new Growable<Uint32Array>((size) => new Uint32Array(size));
	const edgeCellStart = new Growable<Uint32Array>((size) => new Uint32Array(size));
	const counts = new Uint32Array(columns * rows);
	const seen = new Set<number>();

	for (let edge = 0; edge < edgeCount; edge += 1) {
		edgeCellStart.push(edgeCells.length);
		seen.clear();

		let previousLatitude = graph.nodeLatitudes.at(graph.edgeFrom.at(edge));
		let previousLongitude = graph.nodeLongitudes.at(graph.edgeFrom.at(edge));
		const from = graph.edgeGeometryStart.at(edge);
		const to = graph.edgeGeometryStart.at(edge + 1);

		for (let step = from; step <= to; step += 1) {
			const isLast = step === to;
			const latitude = isLast ? graph.nodeLatitudes.at(graph.edgeTo.at(edge)) : graph.geometryLatitudes.at(step);
			const longitude = isLast ? graph.nodeLongitudes.at(graph.edgeTo.at(edge)) : graph.geometryLongitudes.at(step);

			// Toutes les mailles du rectangle qui englobe le segment : une seule le plus souvent, deux
			// ou trois quand il en franchit une frontière.
			const firstColumn = Math.min(column(previousLongitude), column(longitude));
			const lastColumn = Math.max(column(previousLongitude), column(longitude));
			const firstRow = Math.min(row(previousLatitude), row(latitude));
			const lastRow = Math.max(row(previousLatitude), row(latitude));

			for (let y = firstRow; y <= lastRow; y += 1) {
				for (let x = firstColumn; x <= lastColumn; x += 1) {
					const cell = y * columns + x;
					if (seen.has(cell)) continue;
					seen.add(cell);
					edgeCells.push(cell);
					counts[cell] = counts[cell]! + 1;
				}
			}

			previousLatitude = latitude;
			previousLongitude = longitude;
		}
	}

	edgeCellStart.push(edgeCells.length);

	const cellStart = new Uint32Array(columns * rows + 1);
	for (let cell = 0; cell < counts.length; cell += 1) cellStart[cell + 1] = cellStart[cell]! + counts[cell]!;

	const cursor = cellStart.slice(0, -1);
	const cellEdges = new Uint32Array(edgeCells.length);
	for (let edge = 0; edge < edgeCount; edge += 1) {
		for (let step = edgeCellStart.at(edge); step < edgeCellStart.at(edge + 1); step += 1) {
			const cell = edgeCells.at(step);
			cellEdges[cursor[cell]!] = edge;
			cursor[cell] = cursor[cell]! + 1;
		}
	}

	return { columns, rows, cellStart, cellEdges };
}

type BuiltArcs = { arcStart: Uint32Array; arcEdges: Uint32Array };

/**
 * La liste d'adjacence : pour chaque carrefour, les arêtes qui y aboutissent.
 *
 * Chaque arête y figure DEUX fois — une par extrémité — car elle se parcourt dans les deux sens,
 * quoi qu'en dise OpenStreetMap (cf. `isDrivableRoad`). Son rang porte le sens de parcours dans son
 * bit de poids faible : l'explorateur sait ainsi, sans rien relire, s'il la prend à l'endroit ou à
 * l'envers, et donc par quel bout il en ressort.
 */
function buildArcs(graph: BuiltGraph): BuiltArcs {
	const edgeCount = graph.edgeFrom.length;
	const counts = new Uint32Array(graph.nodeCount);

	for (let edge = 0; edge < edgeCount; edge += 1) {
		counts[graph.edgeFrom.at(edge)] = counts[graph.edgeFrom.at(edge)]! + 1;
		counts[graph.edgeTo.at(edge)] = counts[graph.edgeTo.at(edge)]! + 1;
	}

	const arcStart = new Uint32Array(graph.nodeCount + 1);
	for (let node = 0; node < graph.nodeCount; node += 1) arcStart[node + 1] = arcStart[node]! + counts[node]!;

	const cursor = arcStart.slice(0, -1);
	const arcEdges = new Uint32Array(arcStart[graph.nodeCount]!);

	for (let edge = 0; edge < edgeCount; edge += 1) {
		const forward = graph.edgeFrom.at(edge);
		arcEdges[cursor[forward]!] = edge * 2;
		cursor[forward] = cursor[forward]! + 1;

		const backward = graph.edgeTo.at(edge);
		arcEdges[cursor[backward]!] = edge * 2 + 1;
		cursor[backward] = cursor[backward]! + 1;
	}

	return { arcStart, arcEdges };
}

function write(
	output: string,
	counts: GraphCounts,
	bounds: GraphBounds,
	graph: BuiltGraph,
	grid: BuiltGrid,
	arcs: BuiltArcs,
): void {
	const layout = graphLayout(counts);
	const buffer = new ArrayBuffer(layout.byteLength);
	const bytes = Buffer.from(buffer);

	writeGraphHeader(bytes.subarray(0, GRAPH_HEADER_LENGTH), counts, bounds);

	const place = (section: keyof typeof layout.offsets, values: NumberArray): void => {
		const offset = layout.offsets[section];
		const length = layout.lengths[section];
		const view =
			values instanceof Uint32Array ? new Uint32Array(buffer, offset, length) : new Int32Array(buffer, offset, length);
		view.set(values as unknown as Uint32Array);
	};

	place("nodeLatitudes", graph.nodeLatitudes.view());
	place("nodeLongitudes", graph.nodeLongitudes.view());
	place("edgeFrom", graph.edgeFrom.view());
	place("edgeTo", graph.edgeTo.view());
	place("edgeGeometryStart", graph.edgeGeometryStart.view());
	place("geometryLatitudes", graph.geometryLatitudes.view());
	place("geometryLongitudes", graph.geometryLongitudes.view());
	place("arcStart", arcs.arcStart);
	place("arcEdges", arcs.arcEdges);
	place("cellStart", grid.cellStart);
	place("cellEdges", grid.cellEdges);

	// Les longueurs se mesurent en double et se rangent en simple : un kilomètre au millimètre près,
	// là où l'on compare des itinéraires de quelques kilomètres.
	new Float32Array(buffer, layout.offsets.edgeLengths, layout.lengths.edgeLengths).set(graph.edgeLengths.view());

	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, bytes);
}

main();
