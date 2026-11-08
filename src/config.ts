export const PORT = +(process.env.PORT ?? 3000);
export const REFRESH_INTERVAL = Temporal.Duration.from({ seconds: 30 }).total("milliseconds");
export const SIRI_LITE_API_URL = "https://data.grandlyon.com/siri-lite/2.0";
export const SWEEP_THRESHOLD = Temporal.Duration.from({ minutes: 10 }).total("milliseconds");

/**
 * Identifiants de l'API SIRI Lite du Grand Lyon (« utilisateur:mot de passe »), pour les courses, les
 * positions et les infos trafic. Lus à l'usage plutôt qu'à l'import : `pnpm build:graph` et le worker
 * de chargement du GTFS importent ce module sans en avoir besoin (cf. `siriLiteAuthorization`).
 */
export function siriLiteAuthorization(): string {
	const credentials = process.env.API_CREDENTIALS;
	if (credentials === undefined) {
		throw new Error("Environment variable 'API_CREDENTIALS' must be set!");
	}
	return `Basic ${btoa(credentials)}`;
}

// ---

/**
 * Le GTFS statique de TCL : les modifications et les infos trafic s'y rapportent — lignes, sens,
 * tracés, arrêts, horaires. Ses identifiants sont ceux du temps réel SIRI Lite.
 */
export const STATIC_GTFS_URL = process.env.STATIC_GTFS_URL ?? "https://gtfs.bus-tracker.fr/tcl.zip";
/**
 * Intervalle de vérification de fraîcheur du GTFS statique : une simple requête HEAD compare la
 * signature (ETag/Last-Modified) et ne déclenche un retéléchargement que si le fichier a changé.
 */
export const GTFS_CHECK_INTERVAL = Temporal.Duration.from({ minutes: 5 }).total("milliseconds");
/**
 * Plafond du tas du processus qui charge le GTFS : il lit les 195 Mo de `stop_times.txt` d'une traite,
 * et dépasse de loin le plafond par défaut le temps du chargement. Il se termine aussitôt après, et sa
 * mémoire avec lui (cf. `useStaticGtfs`).
 */
export const GTFS_LOADER_HEAP_MB = 3072;

/**
 * Marge autour du créneau théorique d'une course — de son départ à son arrivée — au-delà de laquelle
 * l'instant de référence ne la rattache à aucune journée de service (cf. `resolveServiceRun`).
 */
export const SERVICE_RUN_MARGIN = Temporal.Duration.from({ hours: 2 }).total("seconds");

/**
 * Fenêtre glissante des trip updates reconstruits depuis l'horaire théorique : toute course qui n'a
 * pas fini de circuler et part dans les vingt-quatre heures y annonce ses arrêts supprimés ou son
 * annulation. Le soir, elle porte donc déjà les courses du lendemain.
 */
export const TRIP_UPDATES_HORIZON = Temporal.Duration.from({ hours: 24 }).total("seconds");
/** Même fenêtre glissante pour les modifications de course, sur les sept jours à venir. */
export const TRIP_MODIFICATIONS_HORIZON = Temporal.Duration.from({ hours: 7 * 24 }).total("seconds");
/**
 * Durée pendant laquelle une course arrivée à son terminus garde, dans les deux fenêtres, ses arrêts
 * supprimés, son annulation et sa modification : le consommateur qui relit le feed juste après la fin
 * de la course doit encore y trouver ce qui l'a touchée.
 */
export const FINISHED_TRIP_RETENTION = Temporal.Duration.from({ hours: 1 }).total("seconds");

/**
 * Intervalle de réindexation des modifications et des infos trafic : leurs périodes basculent avec
 * l'heure (travaux de nuit, dépublication), et ce qui vaut doit suivre sans attendre une saisie.
 */
export const REINDEX_INTERVAL = Temporal.Duration.from({ minutes: 1 }).total("milliseconds");

/**
 * Alimentation des infos trafic : le Situation Exchange de SIRI Lite (cf. `siriSituationExchange`).
 * `SERVICE_ALERTS=off` la coupe — seules restent alors les infos trafic créées à la main.
 */
export const SERVICE_ALERTS_ENABLED = process.env.SERVICE_ALERTS !== "off";
export const SERVICE_ALERTS_INTERVAL = Temporal.Duration.from({ minutes: 1 }).total("milliseconds");

/**
 * Les lignes de TCL telles que Bus Tracker les présente, dont le pictogramme que l'interface de
 * gestion affiche. Il ne change qu'aux refontes, d'où un rafraîchissement espacé.
 */
export const LINE_CARTRIDGES_URL = "https://bus-tracker.fr/api/networks/91?withDetails=true";
export const LINE_CARTRIDGES_INTERVAL = Temporal.Duration.from({ hours: 12 }).total("milliseconds");

/**
 * Base des modifications, des infos trafic et des arrêts provisoires, saisis dans l'interface
 * d'administration. Elle est rangée dans `.cache`, monté en volume — SQLite y pose aussi ses fichiers
 * `-wal` et `-shm`, qu'un montage fichier par fichier ne couvrirait pas.
 */
export const DETOURS_DB_PATH = ".cache/detours.sqlite";

/**
 * Identifiants de l'interface d'administration. Sans eux, l'interface n'est PAS montée du tout : une
 * page ouverte vaudrait moins qu'une page absente, et un mot de passe par défaut encore moins.
 */
export const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

/**
 * Écart, en kilomètres, au-delà duquel le point de départ d'un tracé de déviation est SIGNALÉ comme
 * éloigné de l'itinéraire qu'il quitte. Ce n'est pas un refus : le tracé est publié quoi qu'il
 * arrive — une déviation sans tracé est bien pire qu'une déviation au raccord approximatif, et le
 * dessinateur voit le résultat dans l'éditeur. Le journal se contente donc de le mentionner.
 */
export const MAX_DETOUR_JUNCTION_OFFSET = 0.2;

/**
 * Écart, en kilomètres, en deçà duquel on considère qu'un tracé de déviation a REJOINT l'itinéraire
 * d'origine — et donc que la course le reprend au-delà (cf. `DetourSegment.terminus`).
 */
export const DETOUR_REJOIN_OFFSET = 0.05;

/**
 * Graphe routier tiré d'OpenStreetMap, dont l'éditeur de déviations se sert pour accrocher un tracé
 * aux rues. Il est rangé dans `.cache`, monté en volume, et se construit à la main — `pnpm
 * build:graph` — à partir d'un extrait `.osm.pbf` qui, lui, ne vit pas dans le dépôt.
 *
 * Son ABSENCE est un état normal : l'éditeur retombe alors sur le seul dessin libre, et le reste du
 * producteur l'ignore complètement.
 */
export const ROAD_GRAPH_PATH = ".cache/road-graph.bin";

/**
 * Écart maximal, en kilomètres, entre un point cliqué et la rue sur laquelle on l'accroche. Au-delà,
 * on refuse plutôt que d'accrocher au hasard.
 */
export const ROAD_SNAP_RADIUS = 0.15;

/**
 * Nombre de nœuds que la recherche d'itinéraire s'autorise à développer avant d'abandonner : au-delà,
 * les deux points ne communiquent pas, et mieux vaut le dire tout de suite que faire attendre l'éditeur.
 */
export const ROAD_ROUTING_MAX_EXPANSIONS = 200_000;

/**
 * Écart maximal, en kilomètres, entre un tracé accroché aux rues et la courbe qui l'arrondit : les
 * giratoires d'OpenStreetMap sont des polygones, que l'on interpole sans en déplacer aucun nœud.
 */
export const ROAD_SMOOTHING_TOLERANCE = 0.0001;

/**
 * L'interface d'administration, telle que `pnpm --filter web build` la construit — relative au dossier
 * de lancement, la racine du dépôt comme celle de l'image.
 */
export const ADMIN_UI_DIR = "dist/admin-ui";
