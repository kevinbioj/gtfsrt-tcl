import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
	type AlertText,
	alertTextChange,
	type DailyWindow,
	type FeedAlert,
	readableAlertText,
	sameAlertText,
} from "../gtfs-rt/use-service-alerts.js";
import type { Coordinates } from "../utils/geometry.js";

/**
 * Le schéma, dans l'ordre où il s'applique. Chaque entrée fait passer la base de la version qu'elle
 * occupe à la suivante, et `PRAGMA user_version` retient où l'on en est : une base déjà à jour ne
 * rejoue rien. La première reprend d'un bloc le schéma de gtfsrt-tcar, sans ce qui ne servait qu'à
 * l'analyse IA ; les suivantes s'ajoutent à la suite.
 *
 * C'est tout ce qu'il faut de migration ici — la base n'a qu'un écrivain, et son
 * contenu se resaisit en quelques minutes s'il fallait la refaire.
 *
 * Les tables sont `STRICT` : SQLite refuse alors d'écrire un texte dans une colonne numérique, là où
 * il l'accepterait et le convertirait en silence. C'est le pendant du `strict` de TypeScript, à la
 * frontière où les types cessent d'exister.
 */
const MIGRATIONS: readonly (string | ((db: DatabaseSync) => void))[] = [
	`
	-- Une modification : une ligne, un sens, éventuellement des tracés précis, des arrêts supprimés et
	-- des tronçons. Elle ne porte pas de période : elle vaut tant qu'une info trafic à laquelle elle est
	-- associée est en vigueur, ou tant qu'elle est activée à la main.
	CREATE TABLE modifications (
		uid          INTEGER PRIMARY KEY AUTOINCREMENT,
		route_id     TEXT    NOT NULL,
		direction_id INTEGER NOT NULL,
		-- Pour la reconnaître dans la liste ; rien n'en est publié. NULL : aucune.
		description  TEXT,
		-- 1 : activée à la main, rien d'automatique ne l'éteint.
		manual       INTEGER NOT NULL DEFAULT 0,
		-- En vigueur, elle écrase celles de priorité moindre qui touchent les mêmes courses
		-- (cf. indexModifications).
		priority     INTEGER NOT NULL DEFAULT 0,
		created_at   INTEGER NOT NULL,
		-- Le last_modified_time publié.
		updated_at   INTEGER NOT NULL
	) STRICT;

	-- Les infos trafic auxquelles une modification est associée, par numéro. L'association survit à la
	-- sortie du flux de l'info trafic.
	CREATE TABLE modification_alerts (
		uid                INTEGER NOT NULL REFERENCES modifications (uid) ON DELETE CASCADE,
		alert_number       TEXT    NOT NULL,
		-- 1 : au titre de cette info trafic, la modification vaut pendant les périodes de
		-- modification_alert_periods, fût-ce aucune — et non pendant celles de l'info trafic. Celle-ci doit
		-- rester effective : sortie du flux ou masquée, elle n'active plus rien, quoi qu'en disent ces périodes.
		periods_overridden INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (uid, alert_number)
	) STRICT;

	-- Les périodes propres d'une association, quand periods_overridden vaut 1 — comme alert_periods.
	CREATE TABLE modification_alert_periods (
		uid          INTEGER NOT NULL,
		alert_number TEXT    NOT NULL,
		position     INTEGER NOT NULL,
		start_date   TEXT    NOT NULL,
		start_time   TEXT,
		end_date     TEXT,
		end_time     TEXT,
		daily_from   TEXT,
		daily_to     TEXT,
		PRIMARY KEY (uid, alert_number, position),
		FOREIGN KEY (uid, alert_number) REFERENCES modification_alerts (uid, alert_number) ON DELETE CASCADE
	) STRICT;

	-- Les tracés visés, par leur empreinte (cf. RoutePattern). Aucun : tous.
	CREATE TABLE modification_patterns (
		uid        INTEGER NOT NULL REFERENCES modifications (uid) ON DELETE CASCADE,
		pattern_id TEXT    NOT NULL,
		PRIMARY KEY (uid, pattern_id)
	) STRICT;

	CREATE TABLE modification_removed_stops (
		uid     INTEGER NOT NULL REFERENCES modifications (uid) ON DELETE CASCADE,
		stop_id TEXT    NOT NULL,
		PRIMARY KEY (uid, stop_id)
	) STRICT;

	-- Les tronçons déviés d'une modification. Le rang ne sert qu'à les ordonner : save les réécrit
	-- tous, et rien au dehors ne désigne un tronçon en particulier.
	CREATE TABLE segments (
		uid              INTEGER NOT NULL REFERENCES modifications (uid) ON DELETE CASCADE,
		segment          INTEGER NOT NULL,
		-- Bornes du tronçon, incluses. NULL tant qu'elles n'ont pas été choisies : il n'est pas publiable.
		start_stop_id    TEXT,
		end_stop_id      TEXT,
		propagated_delay INTEGER NOT NULL DEFAULT 0,
		-- Le tracé ouvre ou ferme la course (cf. DetourSegment.terminus). NULL : le raccord se lit de la
		-- géométrie.
		terminus         TEXT    CHECK (terminus IN ('start', 'end')),
		PRIMARY KEY (uid, segment)
	) STRICT;

	-- Les arrêts de substitution, dans l'ordre de desserte.
	CREATE TABLE segment_stops (
		uid         INTEGER NOT NULL,
		segment     INTEGER NOT NULL,
		position    INTEGER NOT NULL,
		-- Un quai du GTFS, ou « PROV:<stop_uid> » : le tronçon ne fait que désigner.
		stop_id     TEXT    NOT NULL,
		-- Secondes depuis l'arrivée à l'arrêt de référence (cf. DetourStop.travelTime).
		travel_time INTEGER NOT NULL,
		PRIMARY KEY (uid, segment, position),
		FOREIGN KEY (uid, segment) REFERENCES segments (uid, segment) ON DELETE CASCADE
	) STRICT;

	-- Le tracé publié, point par point.
	CREATE TABLE segment_path (
		uid       INTEGER NOT NULL,
		segment   INTEGER NOT NULL,
		position  INTEGER NOT NULL,
		latitude  REAL    NOT NULL,
		longitude REAL    NOT NULL,
		PRIMARY KEY (uid, segment, position),
		FOREIGN KEY (uid, segment) REFERENCES segments (uid, segment) ON DELETE CASCADE
	) STRICT;

	-- Les points de passage cliqués, de quoi reprendre le tracé.
	CREATE TABLE segment_waypoints (
		uid       INTEGER NOT NULL,
		segment   INTEGER NOT NULL,
		position  INTEGER NOT NULL,
		latitude  REAL    NOT NULL,
		longitude REAL    NOT NULL,
		-- Le mode de la jambe qui SUIT ce point : « route » ou « free ». Sans objet pour le dernier.
		mode      TEXT    NOT NULL,
		PRIMARY KEY (uid, segment, position),
		FOREIGN KEY (uid, segment) REFERENCES segments (uid, segment) ON DELETE CASCADE
	) STRICT;

	-- Les arrêts provisoires : des points de report qui n'existent dans aucun GTFS, publiés sous
	-- « PROV:<stop_uid> ». Ils n'appartiennent à aucune modification — un arrêt de report sert souvent
	-- à plusieurs : les deux sens d'un rebroussement, deux infos trafic successives sur le même chantier.
	-- Les colonnes facultatives suivent ProvisionalStop ; NULL : rien à publier.
	CREATE TABLE provisional_stops (
		-- AUTOINCREMENT : un identifiant publié ne se réattribue jamais.
		stop_uid            INTEGER PRIMARY KEY AUTOINCREMENT,
		name                TEXT    NOT NULL,
		latitude            REAL    NOT NULL,
		longitude           REAL    NOT NULL,
		stop_code           TEXT,
		description         TEXT,
		-- Une zone du GTFS (cf. StaticGtfs.fareAreas), publiée comme zone_id.
		zone_id             TEXT,
		parent_station      TEXT,
		-- 0 : inconnue, comme dans le GTFS.
		wheelchair_boarding INTEGER NOT NULL DEFAULT 0 CHECK (wheelchair_boarding IN (0, 1, 2)),
		platform_code       TEXT,
		created_at          INTEGER NOT NULL
	) STRICT;

	-- Chaque info trafic jamais relevée ou créée, et ce qui s'en règle (cf. AlertSettings).
	CREATE TABLE alert_first_seen (
		alert_number         TEXT    PRIMARY KEY,
		-- Le premier relevé où elle a été vue : c'est l'ordre chronologique de la liste.
		first_seen_at        INTEGER NOT NULL,
		-- Son dernier titre relevé : il la nomme encore une fois sortie du flux.
		header_text          TEXT,
		-- Son dernier relevé (cf. FeedAlert) : elle se résout encore d'après lui une fois sortie du flux.
		snapshot             TEXT,
		-- 1 : masquée, elle n'a plus aucun effet et n'est plus republiée.
		hidden               INTEGER NOT NULL DEFAULT 0,
		-- 1 : ses périodes sont celles d'alert_periods, fût-ce aucune, et non celles que la source annonce.
		periods_overridden   INTEGER NOT NULL DEFAULT 0,
		-- Le texte, la cause et l'effet republiés. NULL : ceux du flux.
		header_override      TEXT,
		description_override TEXT,
		cause_override       TEXT,
		effect_override      TEXT,
		-- Le lien, l'image et son texte alternatif republiés (cf. AlertOverrides). NULL : ceux du flux ;
		-- '' : aucun, quoi que porte le flux.
		url_override         TEXT,
		image_override       TEXT,
		image_alt_override   TEXT,
		-- Le texte reçu au moment où titre ou description ont été réécrits, tel qu'il se lit — JSON d'un
		-- AlertText (cf. readableAlertText) : qu'il s'en écarte, et la réécriture saute (cf. recordAlerts).
		text_basis           TEXT,
		-- L'impact republié, JSON d'une liste d'ImpactEntity ; NULL : celui du flux. impact_basis
		-- retient l'impact reçu au moment de la réécriture : s'il change, elle saute (cf. dropStaleImpacts).
		impact_override      TEXT,
		impact_basis         TEXT,
		-- Marquée traitée : quand, et l'empreinte de l'alerte reçue alors — qu'elle change, et elle
		-- redevient à traiter (cf. dropStaleChecks). NULL : à traiter.
		checked_at           INTEGER,
		checked_basis        TEXT
	) STRICT;

	-- Les périodes saisies d'une info trafic, quand periods_overridden vaut 1. Aucune : elle vaut tant
	-- qu'elle est au flux, ou publiée.
	CREATE TABLE alert_periods (
		alert_number TEXT    NOT NULL,
		position     INTEGER NOT NULL,
		-- AAAA-MM-JJ et HH:MM. Sans fin, la période est ouverte.
		start_date   TEXT    NOT NULL,
		start_time   TEXT,
		end_date     TEXT,
		end_time     TEXT,
		-- Une tranche horaire, HH:MM, chaque jour de ses dates. NULL : d'une borne à l'autre.
		daily_from   TEXT,
		daily_to     TEXT,
		PRIMARY KEY (alert_number, position)
	) STRICT;

	-- Un arrêt qu'une info trafic supprime, sur une ligne et dans un sens : 1, supprimé. Saisi à la main.
	CREATE TABLE alert_skip_stops (
		alert_number TEXT    NOT NULL,
		route_id     TEXT    NOT NULL,
		direction_id INTEGER NOT NULL,
		stop_id      TEXT    NOT NULL,
		removed      INTEGER NOT NULL CHECK (removed IN (0, 1)),
		PRIMARY KEY (alert_number, route_id, direction_id, stop_id)
	) STRICT;

	-- Un ensemble de courses annulées par une info trafic (cf. TripSet) : « range », celles dont le
	-- départ tombe dans la tranche (secondes depuis minuit, heure locale ; NULL l'une et l'autre : toute
	-- la journée) ; « departures », celles de alert_set_departures. Décoché (enabled = 0), il n'annule rien.
	CREATE TABLE alert_trip_sets (
		set_id       INTEGER PRIMARY KEY AUTOINCREMENT,
		alert_number TEXT    NOT NULL,
		position     INTEGER NOT NULL,
		route_id     TEXT    NOT NULL,
		direction_id INTEGER NOT NULL,
		enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
		kind         TEXT    NOT NULL CHECK (kind IN ('range', 'departures')),
		from_time    INTEGER,
		to_time      INTEGER
	) STRICT;

	-- Les départs d'un ensemble « departures », par leur clé de course (cf. courseKey) avec la ligne et
	-- le sens de l'ensemble : le quai et l'horaire du premier arrêt, en secondes depuis le minuit de la
	-- journée de service — au-delà de 86 400 après minuit.
	CREATE TABLE alert_set_departures (
		set_id    INTEGER NOT NULL REFERENCES alert_trip_sets (set_id) ON DELETE CASCADE,
		stop_id   TEXT    NOT NULL,
		departure INTEGER NOT NULL,
		PRIMARY KEY (set_id, stop_id, departure)
	) STRICT;

	-- Un ensemble de courses annulées par une modification, comme alert_trip_sets, la ligne et le sens
	-- en moins : ce sont ceux de la modification, sur ses tracés, tant qu'elle vaut.
	CREATE TABLE modification_trip_sets (
		set_id    INTEGER PRIMARY KEY AUTOINCREMENT,
		uid       INTEGER NOT NULL REFERENCES modifications (uid) ON DELETE CASCADE,
		position  INTEGER NOT NULL,
		enabled   INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
		kind      TEXT    NOT NULL CHECK (kind IN ('range', 'departures')),
		from_time INTEGER,
		to_time   INTEGER
	) STRICT;

	-- Les départs d'un ensemble « departures », comme alert_set_departures.
	CREATE TABLE modification_set_departures (
		set_id    INTEGER NOT NULL REFERENCES modification_trip_sets (set_id) ON DELETE CASCADE,
		stop_id   TEXT    NOT NULL,
		departure INTEGER NOT NULL,
		PRIMARY KEY (set_id, stop_id, departure)
	) STRICT;

	-- Une étiquette, pour classer les modifications dans la liste. Rien n'en est publié. Le nom ne se
	-- répète pas, casse comprise ; la couleur est « #RRGGBB ».
	CREATE TABLE labels (
		label_id   INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
		color      TEXT    NOT NULL,
		created_at INTEGER NOT NULL
	) STRICT;

	-- Les étiquettes d'une modification, autant qu'on veut.
	CREATE TABLE modification_labels (
		uid      INTEGER NOT NULL REFERENCES modifications (uid) ON DELETE CASCADE,
		label_id INTEGER NOT NULL REFERENCES labels (label_id) ON DELETE CASCADE,
		PRIMARY KEY (uid, label_id)
	) STRICT;

	-- Les infos trafic créées à la main, numérotées « P<custom_id> » (cf. customAlertNumber). Ce qui s'en
	-- saisit se range dans alert_first_seen et ses tables, comme pour celles du flux. AUTOINCREMENT : un
	-- numéro ne se réattribue jamais, et « SA:P3 » ne désigne jamais deux alertes dans le feed.
	CREATE TABLE custom_alerts (
		custom_id    INTEGER PRIMARY KEY AUTOINCREMENT,
		created_at   INTEGER NOT NULL,
		-- Depuis quand elle est publiée ; NULL : brouillon, ou dépubliée.
		published_at INTEGER,
		-- Quand elle se dépublie d'elle-même (cf. unpublishDue) ; NULL : jamais.
		unpublish_at INTEGER
	) STRICT;
	`,
];

/** Une étiquette, pour classer les modifications dans la liste. */
export type Label = { labelId: number; name: string; color: string };

/**
 * Une info trafic créée à la main : quand, depuis quand elle est publiée (`null` : brouillon, ou
 * dépubliée), et quand elle se dépubliera d'elle-même (`null` : jamais). Elle reste au feed tant
 * qu'elle est publiée.
 */
export type CustomAlert = { createdAt: number; publishedAt: number | null; unpublishAt: number | null };

/** Un arrêt provisoire : un point de report qui n'existe dans aucun GTFS, et que l'on publie. */
export type ProvisionalStop = {
	/** L'identifiant publié, « PROV:<n> ». Il ne se réattribue jamais. */
	stopId: string;
	name: string;
	latitude: number;
	longitude: number;
	/** Le code affiché aux voyageurs (`stop_code`), saisi librement ; `null` : aucun. */
	stopCode: string | null;
	/** La description (`stop_desc`), saisie librement ; `null` : aucune. */
	description: string | null;
	/** La zone tarifaire, une `area_id` du GTFS publiée comme `zone_id` ; `null` : aucune. */
	zoneId: string | null;
	/** La station du GTFS (`location_type` = 1) à laquelle il se rattache ; `null` : aucune. */
	parentStation: string | null;
	/** L'accessibilité en fauteuil, codée comme `wheelchair_boarding`. */
	wheelchairBoarding: WheelchairBoarding;
	/** Le quai ou la voie (`platform_code`), saisi librement ; `null` : aucun. */
	platformCode: string | null;
};

/** Ce qui se saisit d'un arrêt provisoire : tout, sauf son identifiant. */
export type ProvisionalStopFields = Omit<ProvisionalStop, "stopId">;

/** 0 : inconnue. 1 : accessible. 2 : inaccessible. Les valeurs du GTFS, et de `Stop.WheelchairBoarding`. */
export type WheelchairBoarding = 0 | 1 | 2;

/** Un arrêt que la déviation dessert à la place des arrêts supprimés. */
export type DetourStop = {
	/** Un quai du GTFS, ou un arrêt provisoire (« PROV:<n> ») — la déviation ne fait que désigner. */
	stopId: string;
	/**
	 * Secondes écoulées depuis l'arrivée à l'arrêt de référence — l'arrêt desservi juste AVANT la
	 * borne amont, comme le veut `ReplacementStop.travel_time_to_stop`. La suite doit être
	 * strictement croissante ; c'est la seule contrainte contrôlée à la saisie.
	 *
	 * La valeur peut être NÉGATIVE, pour un arrêt que la course atteint avant l'arrêt de référence —
	 * le cas d'une déviation qui quitte l'itinéraire en amont du premier arrêt supprimé. La
	 * spécification ne les prévoit que lorsque la référence est le premier arrêt de la course ;
	 * l'interface le signale sans l'interdire, l'exploitant sachant seul par où passe son véhicule.
	 *
	 * Il appartient à la déviation, et non à l'arrêt : un même arrêt de report n'est pas atteint au
	 * bout du même temps dans les deux sens.
	 *
	 * L'arrêt de référence peut CHANGER à la publication : lorsqu'un autre tronçon le supprime, les
	 * deux sont fusionnés en une seule `Modification` et ces temps sont recomptés depuis la référence
	 * de celle-là, d'après l'horaire théorique de chaque course (cf. `mergeOverlaps`).
	 */
	travelTime: number;
};

/**
 * Un tronçon dévié : les arrêts qu'il supprime, ceux qu'il dessert à la place, et par où le véhicule
 * passe. C'est très exactement une `Modification` du GTFS-RT, et une modification en porte autant
 * qu'elle dévie la ligne en d'endroits distincts — deux chantiers sur le même axe ne font pas un
 * seul détour.
 */
export type DetourSegment = {
	/**
	 * Premier arrêt de la plage, borne comprise. Toujours publié comme `start_stop_selector` : lorsque
	 * la plage ne supprime rien, c'est la modification de tracé seul, dont le délai propagé part de
	 * l'arrêt qui le suit (cf. `removesStops`).
	 */
	startStopId: string | null;
	/**
	 * Dernier arrêt de la plage, borne incluse — `end_stop_selector`. Facultatif : sans lui, la plage
	 * court jusqu'au dernier arrêt de chaque course, et le tronçon ne supprime rien — un tracé repris
	 * ou une course rallongée (cf. `removesStops`).
	 */
	endStopId: string | null;
	/** Secondes à répercuter sur tous les horaires suivant la modification. */
	propagatedDelay: number;
	/**
	 * Le bout de la course que le tracé remplace, s'il en remplace un : « start », la course part de
	 * son premier point ; « end », elle s'achève à son dernier. Rien de l'itinéraire ne s'y raccorde
	 * alors, quand bien même le tracé y toucherait. `null` : le raccord se lit de la géométrie (cf.
	 * `spliceShape`).
	 */
	terminus: DetourTerminus | null;
	stops: DetourStop[];
	/**
	 * Les points cliqués, et pour chacun le mode de la jambe qui le suit. C'est le PLAN DE MONTAGE du
	 * tracé, conservé pour pouvoir le reprendre ; rien en aval ne le regarde.
	 */
	waypoints: DetourWaypoint[];
	/**
	 * Le tracé publié, aplati. Il est calculé par l'interface — elle seule sait ce que le routage a
	 * rendu — et rangé tel quel : le reconstruire ici demanderait le graphe routier, qui peut être
	 * absent, et reconstruire le graphe déplacerait alors en silence un tracé déjà publié.
	 */
	path: Coordinates[];
};

/** Un point de passage, et le mode de la jambe qui le SUIT. La dernière ne suit rien. */
export type DetourWaypoint = Coordinates & { mode: DetourLegMode };

/** Le bout de la course qu'un tracé remplace : son début, ou sa fin. */
export type DetourTerminus = "start" | "end";

/** Accrochée aux rues d'OpenStreetMap, ou tirée droit d'un point de passage au suivant. */
export type DetourLegMode = "route" | "free";

/**
 * Une période saisie, bornes au format « AAAA-MM-JJ » ou « AAAA-MM-JJTHH:MM » — celui des périodes
 * d'info trafic, qui se jaugent de la même façon (cf. `isActive`). Sans fin, elle est ouverte. Avec
 * une tranche horaire, elle ne vaut que celle-ci, chaque jour de ses dates.
 */
export type SavedPeriod = { start: string; end: string | null; dailyWindow: DailyWindow | null };

/**
 * Une modification — une déviation : ses tronçons, ses arrêts supprimés, ses courses annulées —, telle
 * qu'elle a été saisie. Elle ne porte ni période ni info trafic à elle : elle vaut tant que l'une des
 * infos trafic auxquelles elle est associée est en vigueur, ou qu'on l'a activée à la main (cf.
 * `indexModifications`).
 */
export type Modification = {
	uid: number;
	routeId: string;
	directionId: number;
	/** Une description courte, pour la reconnaître dans la liste. Rien n'en est publié ; `null` : aucune. */
	description: string | null;
	/**
	 * Les tracés empruntés visés (cf. `RoutePattern`), ou aucun pour les viser tous. La modification
	 * ne touche que les courses de ces tracés — ses tronçons comme ses arrêts supprimés.
	 */
	patternIds: string[];
	/** Les quais supprimés, fût-ce aucun. */
	removedStopIds: string[];
	/** Activée à la main : rien d'automatique ne l'éteint, elle vaut jusqu'à ce qu'on la désactive. */
	manual: boolean;
	/** Les infos trafic auxquelles elle est associée, par numéro. */
	alertNumbers: string[];
	/**
	 * Ses périodes propres, par info trafic associée : elle vaut alors pendant celles-ci, et non
	 * pendant celles de l'info trafic — tant que celle-ci est effective. Sans entrée : celles de l'info
	 * trafic. Une liste vide vaut tant que l'info trafic est au flux.
	 */
	alertPeriods: Map<string, SavedPeriod[]>;
	/** Ses étiquettes (cf. `Label`), par identifiant. Rien n'en est publié. */
	labelIds: number[];
	/**
	 * Plus elle est élevée, plus la déviation l'emporte : active, elle écrase celles de priorité
	 * moindre qui touchent les mêmes courses. 0 par défaut.
	 */
	priority: number;
	createdAt: number;
	/** Date du dernier enregistrement, en secondes epoch — c'est le `last_modified_time` publié. */
	updatedAt: number;
	/** Les tronçons déviés, dans l'ordre où la course les rencontre. */
	segments: DetourSegment[];
	/**
	 * Les courses qu'elle annule, sur sa ligne, dans son sens et sur ses tracés, chaque jour où elle vaut
	 * — que son info trafic en annule d'autres ou non.
	 */
	tripSets: ModificationTripSet[];
};

/** Un ensemble de courses qu'une modification annule : celles de sa ligne et de son sens (cf. `TripSet`). */
export type ModificationTripSet = Omit<TripSet, "routeId" | "directionId">;

/** Ce que l'on saisit d'un ensemble de courses d'une modification : tout, sauf son identifiant. */
export type ModificationTripSetInput = Omit<ModificationTripSet, "setId">;

/** Ce qu'un enregistrement porte : tout ce qui se saisit, d'un bloc. */
export type ModificationInput = Pick<
	Modification,
	"description" | "patternIds" | "removedStopIds" | "segments" | "priority"
> & { tripSets: ModificationTripSetInput[] };

/** Ce qu'il faut pour créer une modification. Le reste se saisit ensuite. */
export type NewModification = Pick<Modification, "routeId" | "directionId" | "description" | "patternIds">;

/**
 * Une course désignée par son départ : le quai et l'horaire de son premier arrêt, en secondes depuis
 * le minuit de la journée de service. Avec la ligne et le sens, c'est la clé de course du GTFS (cf.
 * `courseKey`) : toutes les versions de la course, une par service, en relèvent.
 */
export type Departure = { stopId: string; departure: number };

/**
 * Les courses d'un ensemble : celles dont le départ tombe dans une tranche horaire — heure locale,
 * secondes depuis minuit, bornes comprises ; `null` l'une et l'autre : toute la journée ; une fin
 * avant le début passe minuit —, ou des départs choisis un à un.
 */
export type TripSelection =
	| { kind: "range"; from: number | null; to: number | null }
	| { kind: "departures"; departures: Departure[] };

/**
 * Un ensemble de courses qu'une info trafic annule, sur une ligne et dans un sens, chaque jour où elle
 * vaut. Décoché, il n'annule rien : on le garde sous la main sans le défaire.
 *
 * Les annulations appartiennent à l'info trafic, et non à une modification : quelles courses supprimer
 * change à chaque GTFS, et ne vaut que le temps d'une perturbation.
 */
export type TripSet = {
	setId: number;
	routeId: string;
	directionId: number;
	enabled: boolean;
	selection: TripSelection;
};

/** Ce qui se saisit d'un ensemble : tout, sauf son identifiant. */
export type TripSetInput = Omit<TripSet, "setId">;

/** Un arrêt qu'une info trafic supprime (`removed`), sur une ligne et dans un sens, saisi à la main. */
export type SkipOverride = { routeId: string; directionId: number; stopId: string; removed: boolean };

/**
 * Ce qui se réécrit de l'alerte republiée : son titre, sa description, sa cause et son effet (les noms
 * des énumérations du GTFS-RT, « CONSTRUCTION », « DETOUR »…), son lien, son image et le texte
 * alternatif de celle-ci. `null` : ceux du flux. Pour le lien, l'image et son texte alternatif, `""` :
 * aucun, quoi que porte le flux.
 */
export type AlertOverrides = {
	headerText: string | null;
	descriptionText: string | null;
	cause: string | null;
	effect: string | null;
	/** Le lien (`url`), en https:// ou http://. */
	url: string | null;
	/** L'adresse de l'image (`image`), en https://. */
	imageUrl: string | null;
	/** Ce que montre l'image (`image_alternative_text`). */
	imageAlternativeText: string | null;
};

/**
 * Une entité touchée par une info trafic, comme le GTFS-RT la désigne (`EntitySelector`) : une agence
 * seule, une ligne — dans un sens ou les deux —, ou un arrêt. `null` : le champ n'est pas renseigné.
 */
export type ImpactEntity = {
	agencyId: string | null;
	routeId: string | null;
	directionId: number | null;
	stopId: string | null;
};

/** L'impact réécrit d'une info trafic, et l'empreinte de l'impact reçu sur lequel il a été fait. */
export type ImpactOverride = { entities: ImpactEntity[]; basis: string };

/**
 * Les entités qu'une alerte du flux touche (`informed_entity`), telles qu'un impact les désigne. Un champ
 * vide ou absent vaut `null`.
 *
 * Absent du flux, le sens se lit 0 : c'est la valeur par défaut que le décodeur pose sur le prototype, et
 * seul un sens renseigné est une propriété de l'entité. Sans ce garde, un arrêt seul devient « un sens
 * sans ligne », et une ligne citée dans les deux sens, sa seule direction 0.
 *
 * L'empreinte d'un impact réécrit se prend sur cette lecture-là, et se compare à chaque relevé à cette
 * même lecture (cf. `dropStaleImpacts`) : il n'en faut qu'une.
 */
export function informedEntities(
	entities: readonly {
		agencyId?: string | null;
		routeId?: string | null;
		directionId?: number | null;
		stopId?: string | null;
	}[],
): ImpactEntity[] {
	return entities.map((entity) => ({
		agencyId: entity.agencyId || null,
		routeId: entity.routeId || null,
		directionId: Object.hasOwn(entity, "directionId") ? (entity.directionId ?? null) : null,
		stopId: entity.stopId || null,
	}));
}

/**
 * Un impact sous sa forme canonique : une ligne citée dans tous ses sens — le flux en fait une entité
 * par sens — n'en fait plus qu'une, sans sens, ce qui veut dire la même chose en GTFS-RT. Les doublons
 * disparaissent. `directionsOf` donne les sens d'une ligne ; une ligne qu'il ne connaît pas reste telle
 * quelle.
 */
export function canonicalImpact(
	entities: readonly ImpactEntity[],
	directionsOf: (routeId: string) => readonly number[],
): ImpactEntity[] {
	const lineKey = (entity: ImpactEntity) => `${entity.agencyId}|${entity.routeId}`;
	const coversAll = new Set<string>();
	for (const entity of entities) {
		if (entity.routeId === null || entity.stopId !== null) continue;
		const cited = new Set(
			entities
				.filter((other) => other.stopId === null && lineKey(other) === lineKey(entity))
				.map((other) => other.directionId),
		);
		const directions = directionsOf(entity.routeId);
		if (cited.has(null) || (directions.length > 0 && directions.every((direction) => cited.has(direction)))) {
			coversAll.add(lineKey(entity));
		}
	}

	const result: ImpactEntity[] = [];
	const seen = new Set<string>();
	for (const entity of entities) {
		const collapsed =
			entity.routeId !== null && entity.stopId === null && coversAll.has(lineKey(entity))
				? { ...entity, directionId: null }
				: entity;
		const key = JSON.stringify([collapsed.agencyId, collapsed.routeId, collapsed.directionId, collapsed.stopId]);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(collapsed);
	}
	return result;
}

/**
 * L'empreinte d'un impact : ses entités ramenées à leurs quatre champs, sans doublon, dans un ordre
 * fixe. Deux impacts qui désignent la même chose ont la même empreinte, quel que soit leur ordre.
 */
export function impactKey(
	entities: Iterable<{
		agencyId?: string | null;
		routeId?: string | null;
		directionId?: number | null;
		stopId?: string | null;
	}>,
): string {
	const keys = [...entities].map((entity) =>
		JSON.stringify([
			entity.agencyId || null,
			entity.routeId || null,
			entity.directionId ?? null,
			entity.stopId || null,
		]),
	);
	return JSON.stringify([...new Set(keys)].sort());
}

/**
 * Ce qui se règle d'une info trafic : masquée, elle n'a plus aucun effet et n'est plus republiée ;
 * avec des périodes saisies, ce sont elles qui valent, et non celles que la source annonce (`null` :
 * celles de la source) ; ce qui se réécrit de l'alerte republiée.
 */
export type AlertSettings = {
	hidden: boolean;
	periods: SavedPeriod[] | null;
	overrides: AlertOverrides;
	/**
	 * Le texte reçu sur lequel titre et description ont été réécrits, tel qu'il se lit (cf.
	 * `readableAlertText`) ; `null` : aucune réécriture, ou une base encore inconnue.
	 */
	textBasis: AlertText | null;
	/** L'impact réécrit ; `null` : celui du flux. */
	impact: ImpactOverride | null;
	/** Marquée traitée : quand, et l'empreinte de l'alerte reçue alors ; `null` : à traiter. */
	checked: { at: number; basis: string } | null;
};

/**
 * Tout ce qui s'enregistre d'une info trafic d'un bloc, masquage excepté : il se bascule à part, et
 * tout de suite.
 */
export type AlertInput = {
	overrides: AlertOverrides;
	periods: SavedPeriod[] | null;
	skipStops: SkipOverride[];
	tripSets: TripSetInput[];
	modificationUids: number[];
	/**
	 * Les périodes propres des modifications associées, par uid (cf. `Modification.alertPeriods`). Sans
	 * entrée : celles de l'info trafic.
	 */
	modificationPeriods: Map<number, SavedPeriod[]>;
	impact: ImpactOverride | null;
	/**
	 * Quand une info trafic créée à la main se dépubliera d'elle-même, en secondes epoch ; `null` :
	 * jamais. Sans objet pour celles du flux.
	 */
	unpublishAt: number | null;
};

export type DetourStore = ReturnType<typeof useDetourStore>;

/** Un trio info trafic × ligne × sens. */
export type Scope = { alertNumber: string; routeId: string; directionId: number };

/** La clé d'un trio info trafic × ligne × sens : c'est à cette maille que se saisissent les arrêts supprimés. */
export function scopeKey(alertNumber: string, routeId: string, directionId: number): string {
	return `${alertNumber}:${routeId}:${directionId}`;
}

/** Les réglages d'une info trafic que rien n'a touchée. */
const DEFAULT_SETTINGS: AlertSettings = {
	hidden: false,
	periods: null,
	overrides: {
		headerText: null,
		descriptionText: null,
		cause: null,
		effect: null,
		url: null,
		imageUrl: null,
		imageAlternativeText: null,
	},
	textBasis: null,
	impact: null,
	checked: null,
};

/**
 * Les modifications, telles qu'elles sont retenues d'un démarrage à l'autre, ce qui se règle des
 * infos trafic, et la base des arrêts provisoires.
 *
 * Tout est relu en mémoire à l'ouverture, puis après chaque écriture : la boucle de publication lit
 * ainsi un instantané, sans toucher à SQLite vingt fois par minute ni avoir de cache à invalider. Le
 * volume s'y prête — quelques dizaines de modifications, quelques centaines de points.
 *
 * `DatabaseSync` est synchrone, et c'est ce qui rend la chose sûre : deux requêtes HTTP ne peuvent
 * pas s'entrelacer au milieu d'une transaction, la première tient la boucle d'événements le temps de
 * la sienne — quelques centaines de microsecondes. Le WAL ne sert donc pas à départager des
 * écrivains concurrents, il n'y en a qu'un ; il évite qu'un arrêt brutal laisse la base en plan.
 */
export function useDetourStore(path: string) {
	mkdirSync(dirname(path), { recursive: true });

	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	// Sans lui, les `ON DELETE CASCADE` ci-dessus sont lettre morte : SQLite les ignore par défaut.
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA busy_timeout = 2000");

	migrate(db);

	const modifications = new Map<number, Modification>();
	const provisional = new Map<string, ProvisionalStop>();
	const firstSeen = new Map<string, number>();
	const headers = new Map<string, string>();
	/** Le dernier relevé de chaque info trafic, tel qu'il est rangé : de quoi ne réécrire que ce qui change. */
	const encoded = new Map<string, string>();
	const snapshots = new Map<string, FeedAlert>();
	const settings = new Map<string, AlertSettings>();
	const skipStops = new Map<string, SkipOverride[]>();
	const tripSets = new Map<string, TripSet[]>();
	const labels = new Map<number, Label>();
	const customAlerts = new Map<string, CustomAlert>();

	const reload = () => {
		modifications.clear();
		customAlerts.clear();
		labels.clear();
		provisional.clear();
		firstSeen.clear();
		headers.clear();
		encoded.clear();
		snapshots.clear();
		settings.clear();
		skipStops.clear();
		tripSets.clear();

		for (const row of db.prepare("SELECT * FROM provisional_stops ORDER BY stop_uid").all() as ProvisionalRow[]) {
			const stopId = provisionalStopId(row.stop_uid);
			provisional.set(stopId, {
				stopId,
				name: row.name,
				latitude: row.latitude,
				longitude: row.longitude,
				stopCode: row.stop_code,
				description: row.description,
				zoneId: row.zone_id,
				parentStation: row.parent_station,
				wheelchairBoarding:
					row.wheelchair_boarding === 1 || row.wheelchair_boarding === 2 ? row.wheelchair_boarding : 0,
				platformCode: row.platform_code,
			});
		}

		for (const row of db.prepare("SELECT * FROM custom_alerts ORDER BY custom_id").all() as CustomAlertRow[]) {
			customAlerts.set(customAlertNumber(row.custom_id), {
				createdAt: row.created_at,
				publishedAt: row.published_at,
				unpublishAt: row.unpublish_at,
			});
		}

		for (const row of db.prepare("SELECT * FROM alert_first_seen").all() as FirstSeenRow[]) {
			firstSeen.set(row.alert_number, row.first_seen_at);
			if (row.header_text !== null) headers.set(row.alert_number, row.header_text);
			if (row.snapshot !== null) {
				encoded.set(row.alert_number, row.snapshot);
				snapshots.set(row.alert_number, decodeAlert(row.snapshot));
			}
			settings.set(row.alert_number, {
				hidden: row.hidden === 1,
				periods: row.periods_overridden === 1 ? [] : null,
				overrides: {
					headerText: row.header_override,
					descriptionText: row.description_override,
					cause: row.cause_override,
					effect: row.effect_override,
					url: row.url_override,
					imageUrl: row.image_override,
					imageAlternativeText: row.image_alt_override,
				},
				textBasis: row.text_basis === null ? null : (JSON.parse(row.text_basis) as AlertText),
				impact:
					row.impact_override === null
						? null
						: { entities: JSON.parse(row.impact_override) as ImpactEntity[], basis: row.impact_basis ?? "" },
				checked: row.checked_at === null ? null : { at: row.checked_at, basis: row.checked_basis ?? "" },
			});
		}

		for (const row of db
			.prepare("SELECT * FROM alert_periods ORDER BY alert_number, position")
			.all() as AlertPeriodRow[]) {
			settings.get(row.alert_number)?.periods?.push(savedPeriodOf(row));
		}

		for (const row of db.prepare("SELECT * FROM modifications ORDER BY uid").all() as ModificationRow[]) {
			modifications.set(row.uid, {
				uid: row.uid,
				routeId: row.route_id,
				directionId: row.direction_id,
				description: row.description,
				patternIds: [],
				removedStopIds: [],
				manual: row.manual === 1,
				alertNumbers: [],
				alertPeriods: new Map(),
				labelIds: [],
				priority: row.priority,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				segments: [],
				tripSets: [],
			});
		}

		for (const row of db
			.prepare("SELECT * FROM modification_alerts ORDER BY uid, alert_number")
			.all() as AssociationRow[]) {
			const modification = modifications.get(row.uid);
			modification?.alertNumbers.push(row.alert_number);
			if (row.periods_overridden === 1) modification?.alertPeriods.set(row.alert_number, []);
		}

		for (const row of db
			.prepare("SELECT * FROM modification_alert_periods ORDER BY uid, alert_number, position")
			.all() as AssociationPeriodRow[]) {
			modifications.get(row.uid)?.alertPeriods.get(row.alert_number)?.push(savedPeriodOf(row));
		}

		// Dans l'ordre des noms, accents compris — ce que SQLite ne sait pas faire seul.
		const labelRows = (db.prepare("SELECT * FROM labels").all() as LabelRow[]).sort((a, b) =>
			a.name.localeCompare(b.name, "fr", { sensitivity: "base" }),
		);
		const labelRank = new Map(labelRows.map((row, rank) => [row.label_id, rank]));
		for (const row of labelRows) {
			labels.set(row.label_id, { labelId: row.label_id, name: row.name, color: row.color });
		}
		for (const row of db.prepare("SELECT * FROM modification_labels").all() as ModificationLabelRow[]) {
			modifications.get(row.uid)?.labelIds.push(row.label_id);
		}
		for (const modification of modifications.values()) {
			modification.labelIds.sort((a, b) => (labelRank.get(a) ?? 0) - (labelRank.get(b) ?? 0));
		}

		for (const row of db
			.prepare("SELECT * FROM modification_patterns ORDER BY uid, pattern_id")
			.all() as PatternRow[]) {
			modifications.get(row.uid)?.patternIds.push(row.pattern_id);
		}

		for (const row of db
			.prepare("SELECT * FROM modification_removed_stops ORDER BY uid, stop_id")
			.all() as RemovedRow[]) {
			modifications.get(row.uid)?.removedStopIds.push(row.stop_id);
		}

		// Les segments d'abord, arrêts et points ensuite : les uns se rangent dans les autres par leur
		// rang, que l'écriture garde contigu depuis zéro.
		for (const row of db.prepare("SELECT * FROM segments ORDER BY uid, segment").all() as SegmentRow[]) {
			modifications.get(row.uid)?.segments.push({
				startStopId: row.start_stop_id,
				endStopId: row.end_stop_id,
				propagatedDelay: row.propagated_delay,
				terminus: row.terminus === "start" || row.terminus === "end" ? row.terminus : null,
				stops: [],
				waypoints: [],
				path: [],
			});
		}

		for (const row of db.prepare("SELECT * FROM segment_stops ORDER BY uid, segment, position").all() as StopRow[]) {
			modifications
				.get(row.uid)
				?.segments[row.segment]?.stops.push({ stopId: row.stop_id, travelTime: row.travel_time });
		}

		for (const row of db.prepare("SELECT * FROM segment_path ORDER BY uid, segment, position").all() as PathRow[]) {
			modifications
				.get(row.uid)
				?.segments[row.segment]?.path.push({ latitude: row.latitude, longitude: row.longitude });
		}

		for (const row of db
			.prepare("SELECT * FROM segment_waypoints ORDER BY uid, segment, position")
			.all() as WaypointRow[]) {
			modifications.get(row.uid)?.segments[row.segment]?.waypoints.push({
				latitude: row.latitude,
				longitude: row.longitude,
				mode: row.mode === "route" ? "route" : "free",
			});
		}

		const modificationSets = new Map<number, ModificationTripSet>();
		for (const row of db
			.prepare("SELECT * FROM modification_trip_sets ORDER BY uid, position")
			.all() as ModificationTripSetRow[]) {
			const set: ModificationTripSet = {
				setId: row.set_id,
				enabled: row.enabled === 1,
				selection: selectionOf(row),
			};
			modificationSets.set(row.set_id, set);
			modifications.get(row.uid)?.tripSets.push(set);
		}

		for (const row of db
			.prepare("SELECT * FROM modification_set_departures ORDER BY set_id, departure, stop_id")
			.all() as SetDepartureRow[]) {
			const selection = modificationSets.get(row.set_id)?.selection;
			if (selection?.kind === "departures")
				selection.departures.push({ stopId: row.stop_id, departure: row.departure });
		}

		for (const row of db
			.prepare("SELECT * FROM alert_skip_stops ORDER BY alert_number, route_id, direction_id, stop_id")
			.all() as SkipStopRow[]) {
			const list = skipStops.get(row.alert_number) ?? [];
			list.push({
				routeId: row.route_id,
				directionId: row.direction_id,
				stopId: row.stop_id,
				removed: row.removed === 1,
			});
			skipStops.set(row.alert_number, list);
		}

		const sets = new Map<number, TripSet>();
		for (const row of db
			.prepare("SELECT * FROM alert_trip_sets ORDER BY alert_number, position")
			.all() as TripSetRow[]) {
			const set: TripSet = {
				setId: row.set_id,
				routeId: row.route_id,
				directionId: row.direction_id,
				enabled: row.enabled === 1,
				selection: selectionOf(row),
			};
			sets.set(row.set_id, set);
			const list = tripSets.get(row.alert_number) ?? [];
			list.push(set);
			tripSets.set(row.alert_number, list);
		}

		for (const row of db
			.prepare("SELECT * FROM alert_set_departures ORDER BY set_id, departure, stop_id")
			.all() as SetDepartureRow[]) {
			const selection = sets.get(row.set_id)?.selection;
			if (selection?.kind === "departures")
				selection.departures.push({ stopId: row.stop_id, departure: row.departure });
		}
	};

	/** Exécute `work` dans une transaction : tout ou rien, puis relit l'instantané. */
	const transaction = <T>(work: () => T): T => {
		db.exec("BEGIN");
		let result: T;
		try {
			result = work();
			db.exec("COMMIT");
		} catch (cause) {
			db.exec("ROLLBACK");
			throw cause;
		}
		reload();
		return result;
	};

	const writePatterns = (uid: number, patternIds: readonly string[]) => {
		db.prepare("DELETE FROM modification_patterns WHERE uid = ?").run(uid);
		const insert = db.prepare("INSERT INTO modification_patterns (uid, pattern_id) VALUES (?, ?)");
		for (const patternId of new Set(patternIds)) insert.run(uid, patternId);
	};

	const writeRemoved = (uid: number, removedStopIds: readonly string[]) => {
		db.prepare("DELETE FROM modification_removed_stops WHERE uid = ?").run(uid);
		const insert = db.prepare("INSERT INTO modification_removed_stops (uid, stop_id) VALUES (?, ?)");
		for (const stopId of new Set(removedStopIds)) insert.run(uid, stopId);
	};

	/**
	 * Remplace les tronçons en entier plutôt que de les rapprocher un à un — la liste est courte, et
	 * l'interface renvoie de toute façon son état complet. Effacer les segments emporte leurs arrêts
	 * et leurs points, par cascade.
	 */
	const writeSegments = (uid: number, segments: readonly DetourSegment[]) => {
		db.prepare("DELETE FROM segments WHERE uid = ?").run(uid);
		const insertSegment = db.prepare(
			"INSERT INTO segments (uid, segment, start_stop_id, end_stop_id, propagated_delay, terminus) VALUES (?, ?, ?, ?, ?, ?)",
		);
		const insertStop = db.prepare(
			"INSERT INTO segment_stops (uid, segment, position, stop_id, travel_time) VALUES (?, ?, ?, ?, ?)",
		);
		const insertPoint = db.prepare(
			"INSERT INTO segment_path (uid, segment, position, latitude, longitude) VALUES (?, ?, ?, ?, ?)",
		);
		const insertWaypoint = db.prepare(
			"INSERT INTO segment_waypoints (uid, segment, position, latitude, longitude, mode) VALUES (?, ?, ?, ?, ?, ?)",
		);

		segments.forEach((segment, rank) => {
			insertSegment.run(uid, rank, segment.startStopId, segment.endStopId, segment.propagatedDelay, segment.terminus);
			segment.stops.forEach((stop, position) => {
				insertStop.run(uid, rank, position, stop.stopId, stop.travelTime);
			});
			segment.path.forEach((point, position) => {
				insertPoint.run(uid, rank, position, point.latitude, point.longitude);
			});
			segment.waypoints.forEach((waypoint, position) => {
				insertWaypoint.run(uid, rank, position, waypoint.latitude, waypoint.longitude, waypoint.mode);
			});
		});
	};

	/** Les ensembles se réécrivent en entier, départs compris par cascade : rien au dehors ne les désigne. */
	const writeTripSets = (uid: number, sets: readonly ModificationTripSetInput[]) => {
		db.prepare("DELETE FROM modification_trip_sets WHERE uid = ?").run(uid);
		const insertSet = db.prepare(
			`INSERT INTO modification_trip_sets (uid, position, enabled, kind, from_time, to_time)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);
		const insertDeparture = db.prepare(
			"INSERT OR IGNORE INTO modification_set_departures (set_id, stop_id, departure) VALUES (?, ?, ?)",
		);
		sets.forEach(({ enabled, selection }, position) => {
			const { lastInsertRowid } = insertSet.run(
				uid,
				position,
				enabled ? 1 : 0,
				selection.kind,
				selection.kind === "range" ? selection.from : null,
				selection.kind === "range" ? selection.to : null,
			);
			if (selection.kind !== "departures") return;
			for (const { stopId, departure } of selection.departures) {
				insertDeparture.run(Number(lastInsertRowid), stopId, departure);
			}
		});
	};

	/**
	 * Écrit ce qui se règle d'une info trafic déjà rangée — à appeler dans une transaction (cf.
	 * `saveAlert`, `createCustomAlert`).
	 */
	const writeAlert = (alertNumber: string, input: AlertInput, nowSeconds: number) => {
		const wanted = new Set(input.modificationUids.filter((uid) => modifications.has(uid)));
		const current = new Set(
			[...modifications.values()]
				.filter((modification) => modification.alertNumbers.includes(alertNumber))
				.map((modification) => modification.uid),
		);
		const added = [...wanted].filter((uid) => !current.has(uid));
		const removed = [...current].filter((uid) => !wanted.has(uid));
		const ownPeriods = (uid: number) => input.modificationPeriods.get(uid) ?? null;
		// Celles qui restent associées mais dont les périodes propres changent : elles ne valent plus
		// aux mêmes moments.
		const reperiodized = [...wanted].filter(
			(uid) =>
				current.has(uid) &&
				JSON.stringify(modifications.get(uid)?.alertPeriods.get(alertNumber) ?? null) !==
					JSON.stringify(ownPeriods(uid)),
		);

		// Le texte réécrit l'est sur le dernier texte relevé : c'est de lui qu'il ne doit pas s'écarter.
		const { headerText, descriptionText, cause, effect, url, imageUrl, imageAlternativeText } = input.overrides;
		const source = snapshots.get(alertNumber);
		const textBasis =
			(headerText !== null || descriptionText !== null) && source !== undefined
				? JSON.stringify(readableAlertText(source))
				: null;

		db.prepare(
			`UPDATE alert_first_seen
					 SET header_override = ?, description_override = ?, cause_override = ?, effect_override = ?,
						 url_override = ?, image_override = ?, image_alt_override = ?, text_basis = ?, periods_overridden = ?, impact_override = ?, impact_basis = ?
					 WHERE alert_number = ?`,
		).run(
			headerText,
			descriptionText,
			cause,
			effect,
			url,
			imageUrl,
			imageAlternativeText,
			textBasis,
			input.periods === null ? 0 : 1,
			input.impact === null ? null : JSON.stringify(input.impact.entities),
			input.impact?.basis ?? null,
			alertNumber,
		);

		db.prepare("DELETE FROM alert_periods WHERE alert_number = ?").run(alertNumber);
		const insertPeriod = db.prepare(
			`INSERT INTO alert_periods (alert_number, position, start_date, start_time, end_date, end_time, daily_from, daily_to)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		(input.periods ?? []).forEach((period, position) => {
			insertPeriod.run(alertNumber, position, ...periodColumns(period));
		});

		db.prepare("DELETE FROM alert_skip_stops WHERE alert_number = ?").run(alertNumber);
		const insertSkip = db.prepare(
			`INSERT OR REPLACE INTO alert_skip_stops (alert_number, route_id, direction_id, stop_id, removed)
					 VALUES (?, ?, ?, ?, ?)`,
		);
		for (const { routeId, directionId, stopId, removed } of input.skipStops) {
			insertSkip.run(alertNumber, routeId, directionId, stopId, removed ? 1 : 0);
		}

		// Les ensembles se réécrivent en entier, départs compris par cascade : rien au dehors ne les
		// désigne.
		db.prepare("DELETE FROM alert_trip_sets WHERE alert_number = ?").run(alertNumber);
		const insertSet = db.prepare(
			`INSERT INTO alert_trip_sets (alert_number, position, route_id, direction_id, enabled, kind, from_time, to_time)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const insertDeparture = db.prepare(
			"INSERT OR IGNORE INTO alert_set_departures (set_id, stop_id, departure) VALUES (?, ?, ?)",
		);
		input.tripSets.forEach((set, position) => {
			const { selection } = set;
			const { lastInsertRowid } = insertSet.run(
				alertNumber,
				position,
				set.routeId,
				set.directionId,
				set.enabled ? 1 : 0,
				selection.kind,
				selection.kind === "range" ? selection.from : null,
				selection.kind === "range" ? selection.to : null,
			);
			if (selection.kind !== "departures") return;
			for (const { stopId, departure } of selection.departures) {
				insertDeparture.run(Number(lastInsertRowid), stopId, departure);
			}
		});

		const insert = db.prepare("INSERT INTO modification_alerts (uid, alert_number) VALUES (?, ?)");
		const remove = db.prepare("DELETE FROM modification_alerts WHERE uid = ? AND alert_number = ?");
		const touch = db.prepare("UPDATE modifications SET updated_at = ? WHERE uid = ?");
		for (const uid of added) insert.run(uid, alertNumber);
		// Leurs périodes propres suivent, par cascade.
		for (const uid of removed) remove.run(uid, alertNumber);

		// Les périodes propres se réécrivent en entier, comme celles de l'info trafic.
		db.prepare("DELETE FROM modification_alert_periods WHERE alert_number = ?").run(alertNumber);
		const flag = db.prepare("UPDATE modification_alerts SET periods_overridden = ? WHERE uid = ? AND alert_number = ?");
		const insertOwnPeriod = db.prepare(
			`INSERT INTO modification_alert_periods
						(uid, alert_number, position, start_date, start_time, end_date, end_time, daily_from, daily_to)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const uid of wanted) {
			const periods = ownPeriods(uid);
			flag.run(periods === null ? 0 : 1, uid, alertNumber);
			(periods ?? []).forEach((period, position) => {
				insertOwnPeriod.run(uid, alertNumber, position, ...periodColumns(period));
			});
		}

		for (const uid of [...added, ...removed, ...reperiodized]) touch.run(nowSeconds, uid);

		const customId = customAlertId(alertNumber);
		if (customId !== undefined) {
			db.prepare("UPDATE custom_alerts SET unpublish_at = ? WHERE custom_id = ?").run(input.unpublishAt, customId);
		}
	};

	reload();
	console.log(`✓ ${modifications.size} modifications restored from ${path}.`);

	return {
		/** L'instantané des modifications, par uid. */
		modifications: modifications as ReadonlyMap<number, Modification>,

		/** La base des arrêts provisoires, par identifiant publié. */
		provisionalStops: provisional as ReadonlyMap<string, ProvisionalStop>,

		/** Les étiquettes, par identifiant, dans l'ordre de leurs noms. */
		labels: labels as ReadonlyMap<number, Label>,

		/** Les infos trafic créées à la main, par numéro (« P1 »…). */
		customAlerts: customAlerts as ReadonlyMap<string, CustomAlert>,

		/**
		 * Crée une info trafic à la main, en brouillon — non publiée —, avec tout ce qui s'en saisit, d'un
		 * bloc : rien n'en existe tant qu'elle n'est pas enregistrée une première fois. Ses périodes sont
		 * les siennes, fût-ce aucune : elle vaudra alors tant qu'elle sera publiée. Rend son numéro.
		 */
		createCustomAlert(input: AlertInput, nowSeconds: number): string {
			return transaction(() => {
				const { lastInsertRowid } = db
					.prepare("INSERT INTO custom_alerts (created_at, published_at) VALUES (?, NULL)")
					.run(nowSeconds);
				const alertNumber = customAlertNumber(Number(lastInsertRowid));
				db.prepare(
					`INSERT INTO alert_first_seen (alert_number, first_seen_at, header_text, hidden, periods_overridden)
					 VALUES (?, ?, ?, 1, 1)`,
				).run(alertNumber, nowSeconds, input.overrides.headerText);
				writeAlert(alertNumber, { ...input, periods: input.periods ?? [] }, nowSeconds);
				return alertNumber;
			});
		},

		/**
		 * Crée une étiquette, et la pose d'emblée sur des modifications. Renvoie `undefined` si le nom est
		 * déjà pris, casse comprise.
		 */
		createLabel(fields: Omit<Label, "labelId">, uids: Iterable<number>, nowSeconds: number): Label | undefined {
			// Comme la colonne, `COLLATE NOCASE` : « travaux » et « Travaux » sont une même étiquette.
			const lower = fields.name.toLowerCase();
			if ([...labels.values()].some((label) => label.name.toLowerCase() === lower)) return undefined;
			const labelId = transaction(() => {
				const { lastInsertRowid } = db
					.prepare("INSERT INTO labels (name, color, created_at) VALUES (?, ?, ?)")
					.run(fields.name, fields.color, nowSeconds);
				const labelId = Number(lastInsertRowid);
				const insert = db.prepare("INSERT OR IGNORE INTO modification_labels (uid, label_id) VALUES (?, ?)");
				for (const uid of new Set(uids)) if (modifications.has(uid)) insert.run(uid, labelId);
				return labelId;
			});
			return labels.get(labelId);
		},

		/**
		 * Pose une étiquette sur des modifications, ou la leur retire. Elles ne sont pas réhorodatées :
		 * rien de ce qui est publié ne change. Renvoie faux pour une étiquette inconnue.
		 */
		setLabel(labelId: number, uids: Iterable<number>, assigned: boolean): boolean {
			if (!labels.has(labelId)) return false;
			transaction(() => {
				const statement = db.prepare(
					assigned
						? "INSERT OR IGNORE INTO modification_labels (uid, label_id) VALUES (?, ?)"
						: "DELETE FROM modification_labels WHERE uid = ? AND label_id = ?",
				);
				for (const uid of new Set(uids)) if (modifications.has(uid)) statement.run(uid, labelId);
			});
			return true;
		},

		/** Numéro d'info trafic → premier relevé où elle a été vue, en secondes epoch. */
		alertFirstSeen: firstSeen as ReadonlyMap<string, number>,

		/** Numéro d'info trafic → dernier titre relevé, qu'elle soit encore au flux ou non. */
		alertHeaders: headers as ReadonlyMap<string, string>,

		/** Numéro d'info trafic → dernier relevé, qu'elle soit encore au flux ou non. */
		alertSnapshots: snapshots as ReadonlyMap<string, FeedAlert>,

		/** Ce qui a été réglé d'une info trafic : masquée, ou ses périodes saisies. */
		alertSettings(alertNumber: string): AlertSettings {
			return settings.get(alertNumber) ?? DEFAULT_SETTINGS;
		},

		/** Les arrêts qu'une info trafic supprime, saisis à la main. */
		alertSkipStops(alertNumber: string): readonly SkipOverride[] {
			return skipStops.get(alertNumber) ?? [];
		},

		/** Les ensembles de courses qu'une info trafic annule, chaque jour où elle vaut. */
		alertTripSets(alertNumber: string): readonly TripSet[] {
			return tripSets.get(alertNumber) ?? [];
		},

		/**
		 * Retient la première apparition des infos trafic du flux, et leur dernier relevé. Une info trafic
		 * déjà vue garde sa date : c'est l'ordre dans lequel elles sont arrivées, pas celui de leur
		 * dernier passage.
		 *
		 * Quand le texte reçu d'une info trafic s'écarte de celui sur lequel elle a été réécrite, sa
		 * réécriture — titre et description — saute, tout de suite : elle disait autre chose que ce
		 * qu'annonce désormais le réseau, et republier l'ancienne version serait pire que republier la
		 * nouvelle telle quelle. On la refait au besoin. La cause et l'effet réécrits, eux, restent.
		 *
		 * Les périodes saisies, elles, restent : rien d'automatique ne les touche. Qu'une info trafic
		 * traitée change à la source, et elle redevient à traiter (cf. `dropStaleChecks`).
		 *
		 * Le texte se compare tel qu'il se lit (cf. `sameAlertText`) : un autre balisage de la même info
		 * n'est pas un nouveau texte. Le journal dit ce qui a changé, pour qu'une réécriture qui saute
		 * sans raison apparente se comprenne après coup.
		 */
		recordAlerts(alerts: Iterable<FeedAlert>, nowSeconds: number) {
			const upsert = db.prepare(
				`INSERT INTO alert_first_seen (alert_number, first_seen_at, header_text, snapshot) VALUES (?, ?, ?, ?)
				 ON CONFLICT (alert_number) DO UPDATE SET header_text = excluded.header_text, snapshot = excluded.snapshot`,
			);
			const dropRewrite = db.prepare(
				`UPDATE alert_first_seen SET header_override = NULL, description_override = NULL, text_basis = NULL
				 WHERE alert_number = ?`,
			);
			const setBasis = db.prepare("UPDATE alert_first_seen SET text_basis = ? WHERE alert_number = ?");
			for (const alert of alerts) {
				const { alertNumber, headerText } = alert;
				const snapshot = encodeAlert(alert);
				if (firstSeen.has(alertNumber) && encoded.get(alertNumber) === snapshot) continue;

				const previous = snapshots.get(alertNumber);
				const entry = settings.get(alertNumber);
				if (entry !== undefined && (entry.overrides.headerText !== null || entry.overrides.descriptionText !== null)) {
					const received = readableAlertText(alert);
					// Sans base retenue, c'est le dernier texte relevé qui en tient lieu.
					const basis = entry.textBasis ?? readableAlertText(previous ?? alert);
					if (!sameAlertText(basis, received)) {
						dropRewrite.run(alertNumber);
						entry.overrides.headerText = null;
						entry.overrides.descriptionText = null;
						entry.textBasis = null;
						console.log(
							`➔ Alert ${alertNumber}: source text changed, rewritten text dropped — ${alertTextChange(basis, received)}`,
						);
					} else if (entry.textBasis === null) {
						setBasis.run(JSON.stringify(basis), alertNumber);
						entry.textBasis = basis;
					}
				}

				const seenAt = firstSeen.get(alertNumber) ?? nowSeconds;
				upsert.run(alertNumber, seenAt, headerText, snapshot);
				firstSeen.set(alertNumber, seenAt);
				headers.set(alertNumber, headerText);
				encoded.set(alertNumber, snapshot);
				snapshots.set(alertNumber, decodeAlert(snapshot));
			}
		},

		/**
		 * Crée une modification, que rien n'active encore — vide, ou déjà saisie : l'éditeur crée d'un
		 * seul enregistrement ce qu'il a fait dessiner. Les associations données sont reprises.
		 */
		create(
			input: NewModification & Partial<ModificationInput> & { alertNumbers?: readonly string[] },
			nowSeconds: number,
		): Modification {
			const uid = transaction(() => {
				const { lastInsertRowid } = db
					.prepare(
						`INSERT INTO modifications (route_id, direction_id, description, priority, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?)`,
					)
					.run(input.routeId, input.directionId, input.description, input.priority ?? 0, nowSeconds, nowSeconds);
				const uid = Number(lastInsertRowid);
				writePatterns(uid, input.patternIds);
				if (input.removedStopIds !== undefined) writeRemoved(uid, input.removedStopIds);
				if (input.segments !== undefined) writeSegments(uid, input.segments);
				if (input.tripSets !== undefined) writeTripSets(uid, input.tripSets);
				const associate = db.prepare("INSERT OR IGNORE INTO modification_alerts (uid, alert_number) VALUES (?, ?)");
				for (const alertNumber of input.alertNumbers ?? []) associate.run(uid, alertNumber);
				return uid;
			});

			return modifications.get(uid) as Modification;
		},

		/**
		 * Enregistre une modification, d'un bloc : la boucle de publication ne peut jamais en lire une
		 * dont les tronçons auraient été effacés mais pas encore réécrits.
		 */
		save(uid: number, input: ModificationInput, nowSeconds: number): Modification | undefined {
			if (!modifications.has(uid)) return undefined;

			transaction(() => {
				db.prepare("UPDATE modifications SET description = ?, priority = ?, updated_at = ? WHERE uid = ?").run(
					input.description,
					input.priority,
					nowSeconds,
					uid,
				);
				writePatterns(uid, input.patternIds);
				writeRemoved(uid, input.removedStopIds);
				writeSegments(uid, input.segments);
				writeTripSets(uid, input.tripSets);
			});

			return modifications.get(uid);
		},

		/** Efface des modifications, et tout ce qu'elles portent, associations comprises, par cascade. */
		remove(uids: Iterable<number>): number {
			return transaction(() => {
				const remove = db.prepare("DELETE FROM modifications WHERE uid = ?");
				let changes = 0;
				for (const uid of new Set(uids)) changes += Number(remove.run(uid).changes);
				return changes;
			});
		},

		/**
		 * Active des modifications à la main, ou les désactive. Elles sont réhorodatées : c'est le début
		 * de leur période de communication, et leur `last_modified_time`.
		 */
		setManual(uids: Iterable<number>, manual: boolean, nowSeconds: number): number {
			return transaction(() => {
				const update = db.prepare("UPDATE modifications SET manual = ?, updated_at = ? WHERE uid = ? AND manual <> ?");
				let changes = 0;
				for (const uid of new Set(uids)) {
					changes += Number(update.run(manual ? 1 : 0, nowSeconds, uid, manual ? 1 : 0).changes);
				}
				return changes;
			});
		},

		/**
		 * Marque une info trafic traitée, sur l'alerte reçue dont `basis` est l'empreinte — ou la rend à
		 * traiter (`basis` nul). Renvoie faux pour une info trafic jamais relevée.
		 */
		setAlertChecked(alertNumber: string, basis: string | null, nowSeconds: number): boolean {
			const entry = settings.get(alertNumber);
			if (entry === undefined) return false;
			db.prepare("UPDATE alert_first_seen SET checked_at = ?, checked_basis = ? WHERE alert_number = ?").run(
				basis === null ? null : nowSeconds,
				basis,
				alertNumber,
			);
			entry.checked = basis === null ? null : { at: nowSeconds, basis };
			return true;
		},

		/**
		 * Rend à traiter les infos trafic dont l'alerte reçue a changé depuis qu'on les a marquées traitées.
		 * `received` : numéro → empreinte de l'alerte reçue, pour celles du flux. Rend les numéros touchés.
		 */
		dropStaleChecks(received: ReadonlyMap<string, string>): string[] {
			const stale = [...settings].filter(([alertNumber, { checked }]) => {
				const key = received.get(alertNumber);
				return checked !== null && key !== undefined && key !== checked.basis;
			});
			const uncheck = db.prepare(
				"UPDATE alert_first_seen SET checked_at = NULL, checked_basis = NULL WHERE alert_number = ?",
			);
			for (const [alertNumber, entry] of stale) {
				uncheck.run(alertNumber);
				entry.checked = null;
			}
			return stale.map(([alertNumber]) => alertNumber);
		},

		/**
		 * Abandonne les impacts réécrits dont l'impact reçu a changé depuis : ils corrigeaient un impact que
		 * le réseau a lui-même repris. `received` : numéro d'info trafic → empreinte de l'impact reçu (cf.
		 * `impactKey`), pour celles du flux. Rend les numéros dont la réécriture a sauté.
		 */
		dropStaleImpacts(received: ReadonlyMap<string, string>): string[] {
			const stale = [...settings].filter(([alertNumber, { impact }]) => {
				const key = received.get(alertNumber);
				return impact !== null && key !== undefined && key !== impact.basis;
			});
			if (stale.length === 0) return [];
			const drop = db.prepare(
				"UPDATE alert_first_seen SET impact_override = NULL, impact_basis = NULL WHERE alert_number = ?",
			);
			for (const [alertNumber, entry] of stale) {
				drop.run(alertNumber);
				entry.impact = null;
			}
			return stale.map(([alertNumber]) => alertNumber);
		},

		/**
		 * Dépublie une info trafic, ou la publie. Seule une info trafic déjà relevée ou créée se règle : il lui
		 * faut une ligne où le retenir. Renvoie faux sinon.
		 */
		setAlertHidden(alertNumber: string, hidden: boolean, nowSeconds: number): boolean {
			return transaction(() => {
				const { changes } = db
					.prepare("UPDATE alert_first_seen SET hidden = ? WHERE alert_number = ?")
					.run(hidden ? 1 : 0, alertNumber);
				// Une info trafic créée à la main est au feed depuis sa publication : c'est le début de sa
				// période de communication. Republiée, elle repart de là.
				const customId = customAlertId(alertNumber);
				if (customId !== undefined && changes > 0) {
					db.prepare(
						hidden
							? "UPDATE custom_alerts SET published_at = NULL WHERE custom_id = ?"
							: "UPDATE custom_alerts SET published_at = COALESCE(published_at, ?) WHERE custom_id = ?",
					).run(...(hidden ? [customId] : [nowSeconds, customId]));
				}
				return changes > 0;
			});
		},

		/**
		 * Dépublie les infos trafic créées à la main dont la dépublication programmée est échue, comme on
		 * le ferait à la main (cf. `setAlertHidden`) : elles repassent en brouillon. L'échéance s'oublie,
		 * brouillon ou non : passée, elle dépublierait aussitôt toute republication. Rend les numéros des
		 * infos trafic dépubliées.
		 */
		unpublishDue(nowSeconds: number): string[] {
			const due = [...customAlerts].filter(([, { unpublishAt }]) => unpublishAt !== null && unpublishAt <= nowSeconds);
			if (due.length === 0) return [];
			return transaction(() => {
				const unpublished: string[] = [];
				for (const [alertNumber, { publishedAt }] of due) {
					const customId = customAlertId(alertNumber) as number;
					db.prepare("UPDATE custom_alerts SET unpublish_at = NULL WHERE custom_id = ?").run(customId);
					if (publishedAt === null) continue;
					db.prepare("UPDATE alert_first_seen SET hidden = 1 WHERE alert_number = ?").run(alertNumber);
					db.prepare("UPDATE custom_alerts SET published_at = NULL WHERE custom_id = ?").run(customId);
					unpublished.push(alertNumber);
				}
				return unpublished;
			});
		},

		/**
		 * Efface une info trafic, et tout ce qui s'en était réglé : ses périodes, ses arrêts supprimés, ses
		 * courses annulées, ses associations. Les modifications qu'elle activait restent —
		 * détachées, et réhorodatées comme toute modification qui sort d'une association. Renvoie faux pour
		 * une info trafic jamais relevée.
		 *
		 * Revenue au flux, elle serait relevée comme neuve : c'est à l'appelant de ne l'effacer qu'une fois
		 * sortie (cf. la route d'administration).
		 */
		deleteAlert(alertNumber: string, nowSeconds: number): boolean {
			if (!firstSeen.has(alertNumber)) return false;
			const associated = [...modifications.values()].filter((modification) =>
				modification.alertNumbers.includes(alertNumber),
			);
			transaction(() => {
				const touch = db.prepare("UPDATE modifications SET updated_at = ? WHERE uid = ?");
				for (const modification of associated) touch.run(nowSeconds, modification.uid);
				for (const table of [
					"modification_alerts",
					"alert_periods",
					"alert_skip_stops",
					// Les départs suivent, par cascade.
					"alert_trip_sets",
					"alert_first_seen",
				]) {
					db.prepare(`DELETE FROM ${table} WHERE alert_number = ?`).run(alertNumber);
				}
				const customId = customAlertId(alertNumber);
				if (customId !== undefined) db.prepare("DELETE FROM custom_alerts WHERE custom_id = ?").run(customId);
			});
			return true;
		},

		/**
		 * Enregistre ce qui se règle d'une info trafic, d'un bloc : la boucle de publication ne la lit
		 * jamais à moitié réécrite. Seule une info trafic déjà relevée se règle — il lui faut une ligne où
		 * le retenir ; renvoie faux sinon.
		 *
		 * Les modifications qui entrent dans l'association ou en sortent, ou dont les périodes propres changent,
		 * sont réhorodatées : l'info trafic qu'elles citent, ou les périodes où elles valent, viennent de changer.
		 */
		saveAlert(alertNumber: string, input: AlertInput, nowSeconds: number): boolean {
			if (!firstSeen.has(alertNumber)) return false;

			transaction(() => writeAlert(alertNumber, input, nowSeconds));
			return true;
		},

		/** Verse un arrêt provisoire dans la base. Il est aussitôt désignable par toutes les déviations. */
		createProvisionalStop(fields: ProvisionalStopFields, nowSeconds: number): ProvisionalStop {
			const { lastInsertRowid } = db
				.prepare(
					`INSERT INTO provisional_stops
						(name, latitude, longitude, stop_code, description, zone_id, parent_station, wheelchair_boarding,
						 platform_code, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(...provisionalColumns(fields), nowSeconds);

			reload();
			return provisional.get(provisionalStopId(Number(lastInsertRowid))) as ProvisionalStop;
		},

		/**
		 * Renomme, déplace ou redécrit un arrêt provisoire. Le changement vaut pour TOUTES les déviations
		 * qui le désignent : c'est le même arrêt sur le terrain, il n'a pas à être entretenu deux fois.
		 */
		updateProvisionalStop(stopId: string, fields: ProvisionalStopFields): boolean {
			const uid = provisionalStopUid(stopId);
			if (uid === undefined) return false;

			const { changes } = db
				.prepare(
					`UPDATE provisional_stops
					 SET name = ?, latitude = ?, longitude = ?, stop_code = ?, description = ?, zone_id = ?, parent_station = ?,
						 wheelchair_boarding = ?, platform_code = ?
					 WHERE stop_uid = ?`,
				)
				.run(...provisionalColumns(fields), uid);

			reload();
			return changes > 0;
		},

		/**
		 * Retire un arrêt provisoire de la base, et de toutes les modifications qui le désignent : le
		 * garder dans l'une d'elles laisserait dans le feed des `replacement_stops` pointant vers un
		 * arrêt que rien ne définit. Les temps de parcours des arrêts restants n'ont pas à être repris —
		 * une suite strictement croissante le reste une fois un terme ôté.
		 *
		 * Les modifications touchées sont réhorodatées : c'est leur `last_modified_time`, et elles
		 * viennent de changer. Renvoie leur nombre, ou `undefined` pour un arrêt inconnu.
		 */
		deleteProvisionalStop(stopId: string, nowSeconds: number): number | undefined {
			const uid = provisionalStopUid(stopId);
			if (uid === undefined || !provisional.has(stopId)) return undefined;

			const designating = [...modifications.values()].filter((modification) =>
				modification.segments.some((segment) => segment.stops.some((stop) => stop.stopId === stopId)),
			);

			return transaction(() => {
				const touch = db.prepare("UPDATE modifications SET updated_at = ? WHERE uid = ?");
				for (const modification of designating) touch.run(nowSeconds, modification.uid);

				// Les rangs des arrêts restants gardent un trou là où il était : ils ne servent qu'à ordonner,
				// et le prochain enregistrement de la modification les réécrit de toute façon.
				db.prepare("DELETE FROM segment_stops WHERE stop_id = ?").run(stopId);
				db.prepare("DELETE FROM provisional_stops WHERE stop_uid = ?").run(uid);
				return designating.length;
			});
		},
	};
}

/**
 * L'identifiant publié d'un arrêt provisoire. Sans réseau : un arrêt de report peut servir aux lignes
 * de plusieurs d'entre eux.
 */
export function provisionalStopId(stopUid: number): string {
	return `PROV:${stopUid}`;
}

/**
 * Le numéro d'une info trafic créée à la main. Le flux amont numérote les siennes en chiffres seuls :
 * le préfixe les tient à l'écart.
 */
export function customAlertNumber(customId: number): string {
	return `P${customId}`;
}

/** L'identifiant d'une info trafic créée à la main d'après son numéro, ou `undefined` si ce n'en est pas une. */
export function customAlertId(alertNumber: string): number | undefined {
	const match = /^P(\d+)$/.exec(alertNumber);
	return match === null ? undefined : Number(match[1]);
}

/** Le numéro d'un arrêt provisoire d'après son identifiant publié, ou `undefined` si ce n'en est pas un. */
export function provisionalStopUid(stopId: string): number | undefined {
	const match = /^PROV:(\d+)$/.exec(stopId);
	return match === null ? undefined : Number(match[1]);
}

/** Les colonnes saisies d'un arrêt provisoire, dans l'ordre où l'insertion et la mise à jour les citent. */
function provisionalColumns(fields: ProvisionalStopFields) {
	return [
		fields.name,
		fields.latitude,
		fields.longitude,
		fields.stopCode,
		fields.description,
		fields.zoneId,
		fields.parentStation,
		fields.wheelchairBoarding,
		fields.platformCode,
	] as const;
}

/** Le relevé d'une info trafic en JSON, tel que la base le range. */
function encodeAlert(alert: FeedAlert): string {
	return JSON.stringify(alert);
}

function decodeAlert(snapshot: string): FeedAlert {
	return JSON.parse(snapshot) as FeedAlert;
}

/** La sélection d'un ensemble de courses, départs à verser ensuite pour un ensemble « departures ». */
function selectionOf(row: { kind: string; from_time: number | null; to_time: number | null }): TripSelection {
	return row.kind === "range"
		? { kind: "range", from: row.from_time, to: row.to_time }
		: { kind: "departures", departures: [] };
}

/** « 2026-09-24 » et « 08:30 » donnent « 2026-09-24T08:30 » ; sans heure, la date seule. */
function joinBound(date: string, time: string | null): string {
	return time === null ? date : `${date}T${time}`;
}

function splitBound(bound: string): [string, string | null] {
	const [date, time] = bound.split("T");
	return [date as string, time ?? null];
}

/** Les six colonnes d'une période saisie, dans l'ordre de la table. */
function periodColumns(
	period: SavedPeriod,
): [string, string | null, string | null, string | null, string | null, string | null] {
	const [startDate, startTime] = splitBound(period.start);
	const [endDate, endTime] = period.end === null ? [null, null] : splitBound(period.end);
	return [startDate, startTime, endDate, endTime, period.dailyWindow?.from ?? null, period.dailyWindow?.to ?? null];
}

// ---

type ModificationRow = {
	uid: number;
	route_id: string;
	direction_id: number;
	description: string | null;
	manual: number;
	priority: number;
	created_at: number;
	updated_at: number;
};

type AssociationRow = { uid: number; alert_number: string; periods_overridden: number };

type PeriodRow = {
	start_date: string;
	start_time: string | null;
	end_date: string | null;
	end_time: string | null;
	daily_from: string | null;
	daily_to: string | null;
};

type AlertPeriodRow = PeriodRow & { alert_number: string; position: number };

type AssociationPeriodRow = PeriodRow & { uid: number; alert_number: string; position: number };

/** Une période telle que la base la range, relue. */
function savedPeriodOf(row: PeriodRow): SavedPeriod {
	return {
		start: joinBound(row.start_date, row.start_time),
		end: row.end_date === null ? null : joinBound(row.end_date, row.end_time),
		dailyWindow: row.daily_from === null || row.daily_to === null ? null : { from: row.daily_from, to: row.daily_to },
	};
}

type PatternRow = { uid: number; pattern_id: string };

type LabelRow = { label_id: number; name: string; color: string; created_at: number };

type CustomAlertRow = {
	custom_id: number;
	created_at: number;
	published_at: number | null;
	unpublish_at: number | null;
};

type ModificationLabelRow = { uid: number; label_id: number };

type RemovedRow = { uid: number; stop_id: string };

type FirstSeenRow = {
	alert_number: string;
	first_seen_at: number;
	header_text: string | null;
	snapshot: string | null;
	hidden: number;
	periods_overridden: number;
	header_override: string | null;
	description_override: string | null;
	cause_override: string | null;
	effect_override: string | null;
	url_override: string | null;
	image_override: string | null;
	image_alt_override: string | null;
	impact_override: string | null;
	impact_basis: string | null;
	text_basis: string | null;
	checked_at: number | null;
	checked_basis: string | null;
};

type ProvisionalRow = {
	stop_uid: number;
	name: string;
	latitude: number;
	longitude: number;
	stop_code: string | null;
	description: string | null;
	zone_id: string | null;
	parent_station: string | null;
	wheelchair_boarding: number;
	platform_code: string | null;
	created_at: number;
};

type SegmentRow = {
	uid: number;
	segment: number;
	start_stop_id: string | null;
	end_stop_id: string | null;
	propagated_delay: number;
	terminus: string | null;
};

type StopRow = { uid: number; segment: number; position: number; stop_id: string; travel_time: number };

type PathRow = { uid: number; segment: number; position: number; latitude: number; longitude: number };

type WaypointRow = PathRow & { mode: string };

type SkipStopRow = { alert_number: string; route_id: string; direction_id: number; stop_id: string; removed: number };

type TripSetRow = {
	set_id: number;
	alert_number: string;
	position: number;
	route_id: string;
	direction_id: number;
	enabled: number;
	kind: string;
	from_time: number | null;
	to_time: number | null;
};

type ModificationTripSetRow = Omit<TripSetRow, "alert_number" | "route_id" | "direction_id"> & { uid: number };

type SetDepartureRow = { set_id: number; stop_id: string; departure: number };

/**
 * Applique les migrations qui manquent. Chacune passe dans sa propre transaction, `user_version`
 * comprise : une migration interrompue ne laisse pas la base à mi-chemin d'un schéma.
 *
 * `PRAGMA user_version = ?` n'accepte pas de paramètre lié — d'où l'interpolation, sur un index de
 * boucle qui ne vient de nulle part ailleurs.
 */
function migrate(db: DatabaseSync) {
	const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };

	for (let index = version; index < MIGRATIONS.length; index += 1) {
		const migration = MIGRATIONS[index] as string | ((db: DatabaseSync) => void);
		db.exec("BEGIN");
		try {
			if (typeof migration === "string") db.exec(migration);
			else migration(db);
			db.exec(`PRAGMA user_version = ${index + 1}`);
			db.exec("COMMIT");
		} catch (cause) {
			db.exec("ROLLBACK");
			throw cause;
		}
	}
}
