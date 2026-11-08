/**
 * La disposition du graphe routier sur disque, seule chose que le script de construction et le
 * chargeur ont à partager.
 *
 * Le fichier est fait pour être relu SANS être parcouru : un en-tête de taille fixe donne les
 * compteurs, dont se déduit la position de chaque section, et le chargement se réduit à poser des
 * vues typées sur le tampon lu. Rien n'est converti en objets — c'est ce qui fait tenir trois cent
 * mille arêtes dans quelques dizaines de mégaoctets, là où un tableau de structures JavaScript en
 * demanderait plusieurs fois plus et une seconde de construction à chaque démarrage.
 */

export const GRAPH_MAGIC = "TCARGRPH";

/**
 * À incrémenter dès que la disposition change : un fichier d'une autre version est REFUSÉ, pas
 * deviné.
 *
 * 2 — les sens de circulation disparaissent. Une arête se parcourt dans les deux sens, et la liste
 *     d'adjacence porte les deux arcs de chacune. Un graphe de version 1 n'aurait, lui, que l'arc
 *     autorisé : le relire en croyant qu'il les a tous donnerait un réseau silencieusement amputé.
 */
export const GRAPH_VERSION = 2;

export const GRAPH_HEADER_LENGTH = 64;

/**
 * Les coordonnées sont stockées en entiers de dix-millionièmes de degré : un centimètre de
 * résolution, largement au-delà de la précision d'OpenStreetMap, et la moitié de la place d'un
 * flottant double.
 */
export const COORDINATE_SCALE = 1e7;

/** Ce qu'il faut savoir pour situer chaque section. */
export type GraphCounts = {
	nodeCount: number;
	edgeCount: number;
	/** Points de géométrie intermédiaires, toutes arêtes confondues. */
	geometryCount: number;
	/** Arcs sortants, tous nœuds confondus : exactement deux par arête. */
	arcCount: number;
	gridColumns: number;
	gridRows: number;
	/** Appartenances arête-maille, toutes mailles confondues. */
	cellEdgeCount: number;
};

export type GraphSection =
	| "nodeLatitudes"
	| "nodeLongitudes"
	| "edgeFrom"
	| "edgeTo"
	| "edgeLengths"
	| "edgeGeometryStart"
	| "geometryLatitudes"
	| "geometryLongitudes"
	| "arcStart"
	| "arcEdges"
	| "cellStart"
	| "cellEdges";

type SectionShape = {
	name: GraphSection;
	/** Octets par terme, qui dit aussi l'alignement exigé par les vues typées. */
	width: 4;
	length: (counts: GraphCounts) => number;
};

/**
 * Les sections, dans l'ordre où elles s'écrivent.
 *
 * Les trois listes en « start » sont des index de compression creuse : le terme d'indice `i` donne
 * où commence ce qui appartient à `i`, et le terme suivant où cela s'arrête. D'où la sentinelle
 * finale, et d'où l'absence de longueurs à stocker.
 */
const SECTIONS: readonly SectionShape[] = [
	{ name: "nodeLatitudes", width: 4, length: (c) => c.nodeCount },
	{ name: "nodeLongitudes", width: 4, length: (c) => c.nodeCount },
	{ name: "edgeFrom", width: 4, length: (c) => c.edgeCount },
	{ name: "edgeTo", width: 4, length: (c) => c.edgeCount },
	{ name: "edgeLengths", width: 4, length: (c) => c.edgeCount },
	{ name: "edgeGeometryStart", width: 4, length: (c) => c.edgeCount + 1 },
	{ name: "geometryLatitudes", width: 4, length: (c) => c.geometryCount },
	{ name: "geometryLongitudes", width: 4, length: (c) => c.geometryCount },
	{ name: "arcStart", width: 4, length: (c) => c.nodeCount + 1 },
	{ name: "arcEdges", width: 4, length: (c) => c.arcCount },
	{ name: "cellStart", width: 4, length: (c) => c.gridColumns * c.gridRows + 1 },
	{ name: "cellEdges", width: 4, length: (c) => c.cellEdgeCount },
];

export type GraphLayout = {
	offsets: Record<GraphSection, number>;
	lengths: Record<GraphSection, number>;
	/** Taille totale du fichier, en-tête compris. */
	byteLength: number;
};

/** Où tombe chaque section, pour des compteurs donnés. */
export function graphLayout(counts: GraphCounts): GraphLayout {
	const offsets = {} as Record<GraphSection, number>;
	const lengths = {} as Record<GraphSection, number>;
	let offset = GRAPH_HEADER_LENGTH;

	for (const section of SECTIONS) {
		// Chaque section commence sur un multiple de huit : une vue typée refuse de se poser sur un
		// décalage qui n'est pas un multiple de la taille de ses termes.
		offset = Math.ceil(offset / 8) * 8;
		const length = section.length(counts);
		offsets[section.name] = offset;
		lengths[section.name] = length;
		offset += length * section.width;
	}

	return { offsets, lengths, byteLength: offset };
}

/** Écrit l'en-tête. Le reste du fichier est posé par `graphLayout`. */
export function writeGraphHeader(header: Buffer, counts: GraphCounts, bounds: GraphBounds): void {
	header.write(GRAPH_MAGIC, 0, "ascii");
	header.writeUInt32LE(GRAPH_VERSION, 8);
	header.writeUInt32LE(counts.nodeCount, 12);
	header.writeUInt32LE(counts.edgeCount, 16);
	header.writeUInt32LE(counts.geometryCount, 20);
	header.writeUInt32LE(counts.arcCount, 24);
	header.writeUInt32LE(counts.cellEdgeCount, 28);
	header.writeInt32LE(bounds.minLatitude, 32);
	header.writeInt32LE(bounds.minLongitude, 36);
	header.writeInt32LE(bounds.maxLatitude, 40);
	header.writeInt32LE(bounds.maxLongitude, 44);
	header.writeUInt32LE(counts.gridColumns, 48);
	header.writeUInt32LE(counts.gridRows, 52);
}

/** L'emprise du graphe, en dix-millionièmes de degré : c'est elle qui cale la grille. */
export type GraphBounds = {
	minLatitude: number;
	minLongitude: number;
	maxLatitude: number;
	maxLongitude: number;
};

/** Relit l'en-tête, et refuse tout ce qui n'est pas exactement ce que ce module sait lire. */
export function readGraphHeader(header: Buffer): { counts: GraphCounts; bounds: GraphBounds } {
	if (header.length < GRAPH_HEADER_LENGTH || header.toString("ascii", 0, 8) !== GRAPH_MAGIC) {
		throw new Error("Ce fichier n'est pas un graphe routier.");
	}

	const version = header.readUInt32LE(8);
	if (version !== GRAPH_VERSION) {
		throw new Error(`Graphe routier en version ${version}, attendue ${GRAPH_VERSION} : le reconstruire.`);
	}

	return {
		counts: {
			nodeCount: header.readUInt32LE(12),
			edgeCount: header.readUInt32LE(16),
			geometryCount: header.readUInt32LE(20),
			arcCount: header.readUInt32LE(24),
			cellEdgeCount: header.readUInt32LE(28),
			gridColumns: header.readUInt32LE(48),
			gridRows: header.readUInt32LE(52),
		},
		bounds: {
			minLatitude: header.readInt32LE(32),
			minLongitude: header.readInt32LE(36),
			maxLatitude: header.readInt32LE(40),
			maxLongitude: header.readInt32LE(44),
		},
	};
}
