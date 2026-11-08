import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

/**
 * Lecture d'un extrait OpenStreetMap au format PBF.
 *
 * Le format tient en trois enveloppes : le fichier est une suite de blobs, chacun précédé de la
 * longueur de son en-tête sur quatre octets en gros-boutiste ; l'en-tête dit ce que le blob contient
 * et combien il pèse ; le blob, lui, porte des octets bruts ou compressés par zlib. Une fois
 * décompressé, c'est un `PrimitiveBlock` protobuf : une table de chaînes, un facteur d'échelle des
 * coordonnées, et des groupes de nœuds ou de chemins.
 *
 * Tout est décodé à la main. Le sous-ensemble utile — six messages, une quinzaine de champs — est
 * figé depuis quinze ans, et le seul vrai travail, l'inflate, est dans `node:zlib` : une dépendance
 * n'apporterait ici qu'un runtime protobuf générique pour un fichier qu'on lit une fois par
 * construction du graphe.
 *
 * Ce module ne connaît rien aux routes : il ne fait que rendre des nœuds et des chemins. Le tri,
 * c'est `tools/build-road-graph.ts` qui le fait.
 */

/**
 * Les crochets appelés au fil de la lecture. Les deux sont facultatifs : ne déclarer que `onWay`
 * évite de payer le décodage des millions de nœuds d'une première passe qui ne les regarde pas.
 */
export type OsmPbfHandlers = {
	onNode?: (id: number, latitude: number, longitude: number) => void;
	/**
	 * Un chemin, ses attributs d'abord.
	 *
	 * `tags` est une Map RÉUTILISÉE d'un chemin à l'autre : la retenir revient à retenir les attributs
	 * du chemin suivant. Ce qu'on en veut se lit dans le crochet, ou se recopie.
	 *
	 * `readReferences` décode la suite des nœuds du chemin, et n'est à appeler qu'une fois. Les
	 * attributs précèdent les références dans le flux, si bien qu'un chemin écarté sur ses seuls
	 * attributs — neuf sur dix ici — ne coûte pas le décodage de sa géométrie.
	 */
	onWay?: (tags: Map<string, string>, readReferences: () => number[]) => void;
};

/** Lit le fichier de bout en bout, une fois. */
export function readOsmPbf(path: string, handlers: OsmPbfHandlers): void {
	const file = readFileSync(path);
	let offset = 0;

	while (offset < file.length) {
		// L'unique entier du format qui ne soit pas un varint : la longueur de l'en-tête qui suit.
		if (offset + 4 > file.length) throw new Error("Fichier PBF tronqué : en-tête de blob incomplet.");
		const headerLength = file.readUInt32BE(offset);
		offset += 4;

		const header = new Reader(file, offset, offset + headerLength);
		offset += headerLength;

		let type = "";
		let blobLength = 0;
		while (!header.done) {
			const tag = header.varint();
			switch (tag >> 3) {
				case 1:
					type = header.message().text();
					break;
				case 3:
					blobLength = header.varint();
					break;
				default:
					header.skip(tag & 7);
			}
		}

		const blob = new Reader(file, offset, offset + blobLength);
		offset += blobLength;

		// Le premier blob est un `OSMHeader` : bornes de l'extrait et options du générateur, dont rien
		// ici n'a l'usage. Tout le reste est de la donnée.
		if (type !== "OSMData") continue;

		readPrimitiveBlock(new Reader(inflate(blob), 0, -1), handlers);
	}
}

/** Sort les octets d'un `Blob`, décompressés s'il le faut. */
function inflate(blob: Reader): Buffer {
	while (!blob.done) {
		const tag = blob.varint();
		switch (tag >> 3) {
			// `raw` : des blocs non compressés, que certains producteurs émettent encore.
			case 1:
				return blob.message().rest();
			case 3:
				return inflateSync(blob.message().rest());
			// `lzma_data` (4), `obsolete_bzip2_data` (5), `lz4_data` (6), `zstd_data` (7) : aucun extrait
			// public n'en produit, et les deviner en silence donnerait un graphe amputé sans le dire.
			case 4:
			case 5:
			case 6:
			case 7:
				throw new Error("Blob PBF compressé autrement qu'en zlib : recomposer l'extrait avec osmium.");
			default:
				blob.skip(tag & 7);
		}
	}

	throw new Error("Blob PBF sans contenu.");
}

/**
 * Un bloc décompressé : sa table de chaînes, l'échelle de ses coordonnées, et ses groupes.
 *
 * Les groupes sont mis de côté avant d'être lus, et non traités au fil de la rencontre : le facteur
 * d'échelle et les décalages portent les numéros de champ 17, 19 et 20, et arrivent donc APRÈS les
 * groupes dans le flux. Les lire d'abord est la seule façon de placer correctement les nœuds.
 */
function readPrimitiveBlock(block: Reader, handlers: OsmPbfHandlers): void {
	const groups: Reader[] = [];
	let table: Reader | undefined;
	let granularity = 100;
	let latitudeOffset = 0;
	let longitudeOffset = 0;

	while (!block.done) {
		const tag = block.varint();
		switch (tag >> 3) {
			case 1:
				table = block.message();
				break;
			case 2:
				groups.push(block.message());
				break;
			case 17:
				granularity = block.varint();
				break;
			case 19:
				latitudeOffset = block.varint();
				break;
			case 20:
				longitudeOffset = block.varint();
				break;
			default:
				block.skip(tag & 7);
		}
	}

	const strings = new StringTable(table);
	for (const group of groups) {
		readGroup(group, { strings, granularity, latitudeOffset, longitudeOffset }, handlers);
	}
}

type BlockScale = {
	strings: StringTable;
	granularity: number;
	latitudeOffset: number;
	longitudeOffset: number;
};

function readGroup(group: Reader, scale: BlockScale, handlers: OsmPbfHandlers): void {
	while (!group.done) {
		const tag = group.varint();
		switch (tag >> 3) {
			// Des nœuds un par un, que plus personne n'émet mais que la spécification admet toujours.
			case 1:
				readNode(group.message(), scale, handlers);
				break;
			case 2:
				readDenseNodes(group.message(), scale, handlers);
				break;
			case 3:
				readWay(group.message(), scale, handlers);
				break;
			default:
				group.skip(tag & 7);
		}
	}
}

/** Place une coordonnée entière du bloc sur le globe. */
function place(raw: number, offset: number, granularity: number): number {
	return 1e-9 * (offset + granularity * raw);
}

function readNode(node: Reader, scale: BlockScale, handlers: OsmPbfHandlers): void {
	let id = 0;
	let latitude = 0;
	let longitude = 0;

	while (!node.done) {
		const tag = node.varint();
		switch (tag >> 3) {
			case 1:
				id = node.signed();
				break;
			case 8:
				latitude = node.signed();
				break;
			case 9:
				longitude = node.signed();
				break;
			default:
				node.skip(tag & 7);
		}
	}

	handlers.onNode?.(
		id,
		place(latitude, scale.latitudeOffset, scale.granularity),
		place(longitude, scale.longitudeOffset, scale.granularity),
	);
}

// Réemployés d'un bloc à l'autre : un bloc porte jusqu'à huit mille nœuds, et trois tableaux neufs à
// chaque fois donneraient au ramasse-miettes plus de travail qu'au décodeur.
const denseIds: number[] = [];
const denseLatitudes: number[] = [];
const denseLongitudes: number[] = [];

/**
 * Les nœuds « denses » : trois listes parallèles, chacune écrite en ÉCARTS au terme précédent. C'est
 * ce qui fait tenir un extrait départemental en quatre-vingts mégaoctets — les identifiants se
 * suivent, les positions voisinent, et les écarts tiennent sur un ou deux octets là où les valeurs
 * en demanderaient cinq.
 *
 * Les trois listes doivent être décodées avant d'émettre quoi que ce soit : rien ne garantit leur
 * ordre d'arrivée dans le flux.
 */
function readDenseNodes(dense: Reader, scale: BlockScale, handlers: OsmPbfHandlers): void {
	if (handlers.onNode === undefined) return;

	denseIds.length = 0;
	denseLatitudes.length = 0;
	denseLongitudes.length = 0;

	while (!dense.done) {
		const tag = dense.varint();
		switch (tag >> 3) {
			case 1:
				readPackedSigned(dense.message(), denseIds);
				break;
			case 8:
				readPackedSigned(dense.message(), denseLatitudes);
				break;
			case 9:
				readPackedSigned(dense.message(), denseLongitudes);
				break;
			// `keys_vals` (10) : les attributs des nœuds, dont le graphe routier n'a que faire.
			default:
				dense.skip(tag & 7);
		}
	}

	let id = 0;
	let latitude = 0;
	let longitude = 0;

	for (let index = 0; index < denseIds.length; index += 1) {
		id += denseIds[index]!;
		latitude += denseLatitudes[index]!;
		longitude += denseLongitudes[index]!;

		handlers.onNode(
			id,
			place(latitude, scale.latitudeOffset, scale.granularity),
			place(longitude, scale.longitudeOffset, scale.granularity),
		);
	}
}

const wayKeys: number[] = [];
const wayValues: number[] = [];
const wayReferences: number[] = [];
/** Vidée et regarnie à chaque chemin : cf. `OsmPbfHandlers.onWay`. */
const wayTags = new Map<string, string>();

function readWay(way: Reader, scale: BlockScale, handlers: OsmPbfHandlers): void {
	const onWay = handlers.onWay;
	if (onWay === undefined) return;

	wayKeys.length = 0;
	wayValues.length = 0;
	let references: Reader | undefined;

	while (!way.done) {
		const tag = way.varint();
		switch (tag >> 3) {
			case 2:
				readPacked(way.message(), wayKeys);
				break;
			case 3:
				readPacked(way.message(), wayValues);
				break;
			case 8:
				references = way.message();
				break;
			default:
				way.skip(tag & 7);
		}
	}

	wayTags.clear();
	for (let index = 0; index < wayKeys.length; index += 1) {
		wayTags.set(scale.strings.at(wayKeys[index]!), scale.strings.at(wayValues[index]!));
	}

	onWay(wayTags, () => {
		wayReferences.length = 0;
		if (references === undefined) return wayReferences;

		// Des écarts, ici encore : les nœuds d'un chemin ont été créés à la suite, leurs identifiants
		// se suivent presque toujours.
		readPackedSigned(references, wayReferences);
		let reference = 0;
		for (let index = 0; index < wayReferences.length; index += 1) {
			reference += wayReferences[index]!;
			wayReferences[index] = reference;
		}

		return wayReferences;
	});
}

/**
 * La table de chaînes du bloc : les attributs n'y renvoient que par leur rang, et « highway » n'est
 * écrit qu'une fois pour les milliers de chemins qui le portent.
 *
 * Les chaînes sont converties à la demande et retenues : un bloc de nœuds n'en réclame aucune, un
 * bloc de chemins toujours les mêmes quelques dizaines sur les huit mille qu'il déclare.
 */
class StringTable {
	private readonly slices: Buffer[] = [];
	private readonly decoded: (string | undefined)[] = [];

	constructor(table: Reader | undefined) {
		while (table !== undefined && !table.done) {
			const tag = table.varint();
			if (tag >> 3 === 1) this.slices.push(table.message().rest());
			else table.skip(tag & 7);
		}
	}

	at(index: number): string {
		const known = this.decoded[index];
		if (known !== undefined) return known;

		const slice = this.slices[index];
		if (slice === undefined) throw new Error(`Rang ${index} hors de la table de chaînes du bloc.`);

		const text = slice.toString("utf8");
		this.decoded[index] = text;
		return text;
	}
}

function readPacked(packed: Reader, into: number[]): void {
	while (!packed.done) into.push(packed.varint());
}

function readPackedSigned(packed: Reader, into: number[]): void {
	while (!packed.done) into.push(packed.signed());
}

/**
 * Un curseur sur une portion de tampon, et de quoi y lire du protobuf.
 *
 * Chaque champ est précédé d'un varint qui porte son numéro et son type de codage :
 * `(numéro << 3) | type`. C'est ce qui permet de sauter proprement ce qu'on ne connaît pas — la
 * moitié du contenu d'un extrait OSM, ici.
 */
class Reader {
	private offset: number;
	private readonly end: number;

	/** `end` négatif : jusqu'au bout du tampon. */
	constructor(
		private readonly data: Buffer,
		offset: number,
		end: number,
	) {
		this.offset = offset;
		this.end = end < 0 ? data.length : end;
		if (this.end > data.length) throw new Error("Fichier PBF tronqué : message incomplet.");
	}

	get done(): boolean {
		return this.offset >= this.end;
	}

	/**
	 * Un entier écrit sur un nombre variable d'octets, sept bits à la fois, le bit de poids fort
	 * annonçant qu'un autre octet suit.
	 *
	 * L'accumulation se fait en flottant et non par décalages binaires : ceux-ci travaillent sur
	 * trente-deux bits, alors que les identifiants d'OSM ont dépassé les quatre milliards. Un
	 * flottant double reste exact jusqu'à 2^53, soit mille fois la marge qu'il nous faut.
	 */
	varint(): number {
		let value = 0;
		let scale = 1;

		for (let index = 0; index < 10; index += 1) {
			const byte = this.data[this.offset];
			if (byte === undefined) throw new Error("Fichier PBF tronqué : varint incomplet.");
			this.offset += 1;

			value += (byte & 0x7f) * scale;
			if ((byte & 0x80) === 0) return value;
			scale *= 128;
		}

		throw new Error("Varint de plus de dix octets : flux PBF corrompu.");
	}

	/**
	 * Un entier signé, replié en positif : le signe passe dans le bit de poids faible, pour qu'un
	 * petit écart négatif tienne sur un octet comme son équivalent positif.
	 */
	signed(): number {
		const folded = this.varint();
		return folded % 2 === 0 ? folded / 2 : -(folded + 1) / 2;
	}

	/** Le champ courant, pris comme une portion délimitée : sous-message, ou liste compactée. */
	message(): Reader {
		const length = this.varint();
		const message = new Reader(this.data, this.offset, this.offset + length);
		this.offset += length;
		return message;
	}

	/** Ce qui reste, tel quel. */
	rest(): Buffer {
		const slice = this.data.subarray(this.offset, this.end);
		this.offset = this.end;
		return slice;
	}

	text(): string {
		return this.rest().toString("utf8");
	}

	/** Passe un champ dont on n'a que faire, en se fiant à son seul type de codage. */
	skip(wireType: number): void {
		switch (wireType) {
			case 0:
				this.varint();
				break;
			case 1:
				this.offset += 8;
				break;
			// La longueur est lue AVANT d'être ajoutée : « this.offset += this.varint() » prendrait la
			// position d'avant la lecture de cette longueur, et sauterait trop court.
			case 2: {
				const length = this.varint();
				this.offset += length;
				break;
			}
			case 5:
				this.offset += 4;
				break;
			default:
				throw new Error(`Type de codage protobuf inconnu : ${wireType}.`);
		}
	}
}
