/**
 * Ce que l'API d'administration rend, et ce qu'elle reçoit — partagé avec l'interface (`web/`), qui
 * l'importe tel quel. Des types seulement, sans rien importer : le fichier se lit des deux côtés, et
 * l'interface ne doit rien tirer de Node.
 */

/** Une ligne telle que l'interface l'affiche : son nom commercial, ses couleurs. */
export type LineDto = { routeId: string; line: string; color: string; textColor: string };

/** Une tranche horaire quotidienne, « HH:MM ». Une fin avant le début passe minuit. */
export type DailyWindowDto = { from: string; to: string };

/**
 * Une période, bornes « AAAA-MM-JJ » (journée entière, fin incluse) ou « AAAA-MM-JJTHH:MM » (instant,
 * fin exclue). `null` : ouverte de ce côté.
 */
export type PeriodDto = { start: string | null; end: string | null; dailyWindow: DailyWindowDto | null };

/** Un intervalle du flux GTFS-RT, en secondes epoch. `null` : ouvert de ce côté. */
export type TimeRangeDto = { start: number | null; end: number | null };

/** Une borne telle que le formulaire l'envoie : la date, obligatoire, et l'heure, facultative. */
export type BoundInput = { date: string; time: string | null };

/** Une période telle que le formulaire l'envoie. */
export type PeriodInput = { start: BoundInput | null; end: BoundInput | null; dailyWindow: DailyWindowDto | null };

// --- état du flux ---

export type FeedClock = { generatedAt: number | null; modifiedAt: number | null };

export type StatusDto = {
	feeds: { serviceAlerts: FeedClock; tripModifications: FeedClock; tripUpdates: FeedClock };
	/** Quand le GTFS en vigueur a été chargé, en secondes epoch. */
	gtfsImportedAt: number;
	counts: { alerts: number; uncheckedAlerts: number; modifications: number; provisionalStops: number };
	/** Le graphe routier est-il là ? Sans lui, pas d'accrochage aux rues. */
	roadRouting: boolean;
};

// --- lignes ---

export type PatternDto = {
	patternId: string;
	label: string;
	stopCount: number;
	/** Courses du tracé le prochain jour ouvré (mardi). */
	tripsPerDay: number;
};

export type DirectionDto = { directionId: number; headsigns: string[]; patterns: PatternDto[] };

/**
 * `cartridgeHref` : le pictogramme de la ligne, `null` s'il n'est pas connu. `agencyId` : l'agence qui
 * l'exploite (`routes.agency_id`), et son nom ; `null` si le GTFS n'en dit rien.
 */
export type RouteDto = LineDto & {
	cartridgeHref: string | null;
	agencyId: string | null;
	agencyName: string | null;
	directions: DirectionDto[];
};

// --- modifications ---

/**
 * Où en est la publication d'une modification : activée à la main, publiée via une info trafic en
 * vigueur, planifiée (une info trafic l'activera), ou rien de tout cela.
 */
export type ModificationState = "manual" | "live" | "planned" | "off";

/** Une info trafic associée, telle qu'une modification la cite. */
export type AlertLinkDto = {
	alertNumber: string;
	headerText: string;
	inFeed: boolean;
	/** Créée à la main : hors du flux amont, elle n'en est pas retirée pour autant. */
	custom: boolean;
	hidden: boolean;
	/** Effective, et la modification vaut en ce moment à son titre. */
	active: boolean;
	/** La modification a, au titre de cette info trafic, ses périodes propres. */
	periodsOverridden: boolean;
};

/** Une étiquette, pour classer les modifications. `color` : « #RRGGBB ». */
export type LabelDto = { labelId: number; name: string; color: string };

/** Une étiquette à créer, et les modifications sur lesquelles la poser d'emblée. */
export type NewLabelDto = { name: string; color: string; uids: number[] };

/** Poser une étiquette sur des modifications (`assigned`), ou la leur retirer. */
export type LabelAssignmentDto = { uids: number[]; assigned: boolean };

/** Le type de tracé d'une modification, d'après son premier tronçon. */
export type DetourKind = "intra" | "start" | "end";

export type ModificationSummaryDto = {
	uid: number;
	description: string | null;
	routeId: string;
	directionId: number;
	line: LineDto;
	headsigns: string[];
	state: ModificationState;
	/** Une phrase : « depuis le 24/10 à 08:30 », « dès le 26/10 », « aucune alerte, inactive »… */
	stateDetail: string;
	manual: boolean;
	/** Ni tronçon, ni arrêt supprimé, ni course annulée : rien à publier, l'activation à la main est verrouillée. */
	draft: boolean;
	alerts: AlertLinkDto[];
	/** Ses étiquettes (cf. `LabelDto`), par identifiant, dans l'ordre de leurs noms. */
	labelIds: number[];
	active: boolean;
	kind: DetourKind;
	/** Le premier arrêt modifié du premier tronçon, et le dernier du dernier. */
	fromStop: string | null;
	toStop: string | null;
	/** Les libellés des tracés visés — tous, si aucun n'est nommé. */
	patternLabels: string[];
	allPatterns: boolean;
	priority: number;
	overriddenCount: number;
	removedStopCount: number;
	segmentCount: number;
	publishableSegments: number;
	provisionalStopCount: number;
	createdAt: number;
	updatedAt: number;
};

export type SequenceStopDto = {
	stopId: string;
	name: string;
	latitude: number | null;
	longitude: number | null;
	removed: boolean;
	/** Temps théorique depuis le premier arrêt du tracé, en secondes (médiane de ses courses) ; `null` : inconnu. */
	offset: number | null;
};

export type DetailPatternDto = PatternDto & { shapeId: string; sequence: SequenceStopDto[] };

export type DesignatedStopDto = {
	stopId: string;
	travelTime: number;
	name: string;
	latitude: number | null;
	longitude: number | null;
	provisional: boolean;
};

export type WaypointDto = { latitude: number; longitude: number; mode: "route" | "free" };

export type SegmentDto = {
	startStopId: string | null;
	endStopId: string | null;
	propagatedDelay: number;
	terminus: "start" | "end" | null;
	stops: DesignatedStopDto[];
	waypoints: WaypointDto[];
	path: { latitude: number; longitude: number }[];
	publishable: boolean;
	tripsByPattern: Record<string, number>;
	overriddenOn: string[];
};

export type RivalDto = {
	uid: number;
	description: string | null;
	state: ModificationState;
	active: boolean;
	priority: number;
	segmentCount: number;
};

export type ModificationDetailDto = ModificationSummaryDto & {
	patternIds: string[];
	removedStopIds: string[];
	patterns: DetailPatternDto[];
	shapes: { shapeId: string; encodedPolyline: string }[];
	boundsCandidates: { startStopId: string; endStopId: string; itinerary: number }[];
	overrides: RivalDto[];
	overriddenBy: RivalDto[];
	segments: SegmentDto[];
	/** Les courses qu'elle annule, sur sa ligne et dans son sens. */
	tripSets: TripSetDto[];
};

/** Un tronçon tel que l'éditeur l'envoie. */
export type SegmentInput = {
	startStopId: string | null;
	endStopId: string | null;
	propagatedDelay: number;
	terminus: "start" | "end" | null;
	stops: { stopId: string; travelTime: number }[];
	path: [number, number][];
	waypoints: { point: [number, number]; mode: "route" | "free" }[];
};

export type ModificationInputDto = {
	description: string | null;
	patternIds: string[];
	removedStopIds: string[];
	segments: SegmentInput[];
	priority: number;
	/** La ligne et le sens sont ceux de la modification. */
	tripSets: { enabled: boolean; selection: TripSelectionDto }[];
};

export type NewModificationDto = Partial<ModificationInputDto> & {
	routeId: string;
	directionId: number;
	description: string | null;
	patternIds: string[];
	/** Les infos trafic auxquelles l'associer d'emblée. */
	alertNumbers?: string[];
};

// --- infos trafic ---

/**
 * Si une info trafic se republie : oui ; non car dépubliée ; non car sortie du flux ; ou non car
 * brouillon — créée à la main, pas encore publiée.
 */
export type AlertPublication = "published" | "hidden" | "withdrawn" | "draft";

/**
 * Où en est une info trafic d'après ses périodes, publiée ou non : en cours, dans ses dates mais hors
 * de ses heures, à venir, ou terminée.
 */
export type AlertPhase = "current" | "paused" | "planned" | "expired";

export type AlertTextDto = {
	headerText: string;
	descriptionText: string;
	cause: string | null;
	effect: string | null;
	/** Le lien (`url`) ; `null` : aucun. */
	url: string | null;
	/** L'adresse de l'image (`image`) ; `null` : aucune. */
	imageUrl: string | null;
	/** Ce que montre l'image (`image_alternative_text`) ; `null` : rien. */
	imageAlternativeText: string | null;
};

/**
 * Ce qui se réécrit de l'alerte : `null` garde ce qu'en dit le flux. Pour le lien, l'image et son texte
 * alternatif, `""` n'en garde aucun.
 */
export type AlertOverridesDto = {
	headerText: string | null;
	descriptionText: string | null;
	cause: string | null;
	effect: string | null;
	url: string | null;
	imageUrl: string | null;
	imageAlternativeText: string | null;
};

export type StripStopDto = {
	stopId: string;
	name: string;
	/** Supprimé, saisi à la main. */
	removed: boolean;
};

/** Les arrêts d'une ligne dans un sens, tels que le schéma de ligne les montre. */
export type StopGroupDto = {
	routeId: string;
	directionId: number;
	line: LineDto;
	headsign: string;
	stops: StripStopDto[];
	/** Les déviations associées sur cette ligne et ce sens : ce sont elles qui disent quoi supprimer. */
	replacedBy: number[];
};

export type TripSelectionDto =
	| { kind: "range"; from: number | null; to: number | null }
	| { kind: "departures"; departures: { stopId: string; departure: number }[] };

export type TripSetDto = {
	routeId: string;
	directionId: number;
	enabled: boolean;
	selection: TripSelectionDto;
	line: LineDto;
	headsign: string;
	/** Combien de courses il annule, d'après le GTFS du moment, sur les jours des périodes. */
	count: number;
	/** Les départs nommés d'un ensemble choisi un à un, chacun dit s'il est encore au GTFS. */
	departures: { stopId: string; departure: number; name: string; known: boolean }[];
};

/** Une entité touchée par une alerte (`informed_entity`) : une agence, une ligne et un sens, ou un arrêt. */
export type ImpactEntityDto = {
	agencyId: string | null;
	routeId: string | null;
	directionId: number | null;
	stopId: string | null;
};

export type AlertDto = {
	alertNumber: string;
	inFeed: boolean;
	/** Créée à la main : rien n'en est reçu, tout en est saisi. */
	custom: boolean;
	/** Depuis quand une alerte créée à la main est publiée ; `null` : brouillon, ou reçue du flux. */
	publishedAt: number | null;
	/** Quand une alerte créée à la main se dépubliera d'elle-même ; `null` : jamais, ou reçue du flux. */
	unpublishAt: number | null;
	hidden: boolean;
	active: boolean;
	publication: AlertPublication;
	phase: AlertPhase;
	/** La date qui va avec la phase, s'il y en a une. */
	phaseDetail: string;
	received: AlertTextDto & { descriptionHtml: string };
	published: AlertTextDto;
	overrides: AlertOverridesDto;
	periods: PeriodDto[];
	/** Les périodes que la source annonce ; aucune pour une alerte créée à la main. */
	sourcePeriods: PeriodDto[];
	periodsOverridden: boolean;
	/**
	 * Les périodes telles qu'elles se republient (cf. `publishedPeriods`) : la communication reçue du flux
	 * amont, et l'impact qu'on en tire. `null` hors du flux. Pour une alerte créée à la main, rien de reçu
	 * (cf. `customPublishedPeriods`).
	 */
	feedPeriods: { received: TimeRangeDto[]; communication: TimeRangeDto[]; impact: TimeRangeDto[] } | null;
	lines: LineDto[];
	stopGroups: StopGroupDto[];
	tripSets: TripSetDto[];
	modifications: number[];
	/**
	 * Les périodes propres des modifications associées qui en ont, par uid : elles y valent au lieu des
	 * périodes de l'alerte — tant que l'alerte est effective.
	 */
	modificationPeriods: Record<number, PeriodDto[]>;
	warnings: string[];
	firstSeenAt: number;
	/** Marquée traitée, et quand ; `null` : à traiter. */
	checkedAt: number | null;
	/** L'impact reçu du flux, celui qu'on republie — réécrit ou non. */
	impact: { received: ImpactEntityDto[]; published: ImpactEntityDto[]; overridden: boolean };
};

export type AlertInputDto = {
	overrides: AlertOverridesDto;
	/** `null` : les périodes que la source annonce. */
	periods: PeriodInput[] | null;
	skipStops: { routeId: string; directionId: number; stopId: string; removed: boolean }[];
	tripSets: { routeId: string; directionId: number; enabled: boolean; selection: TripSelectionDto }[];
	modificationUids: number[];
	/** Les périodes propres, par uid ; sans entrée, la modification reprend celles de l'alerte. */
	modificationPeriods: Record<number, PeriodInput[]>;
	/** `null` : l'impact reçu. */
	impact: ImpactEntityDto[] | null;
	/**
	 * Quand une alerte créée à la main se dépubliera d'elle-même, en secondes epoch, à venir ; `null` ou
	 * absent : jamais. Ignoré pour celles du flux.
	 */
	unpublishAt?: number | null;
};

export type DepartureDto = {
	stopId: string;
	departure: number;
	name: string;
	headsign: string;
	patternIds: string[];
	/** Partie et pas encore arrivée : elle roule en ce moment. */
	underway: boolean;
};

/** Les départs d'une journée de service, « AAAA-MM-JJ ». */
export type DepartureDayDto = { date: string; departures: DepartureDto[] };

// --- arrêts ---

export type StopSearchDto = { stopId: string; name: string; latitude: number; longitude: number; provisional: boolean };

/** Tous les arrêts, en tableaux : [stopId, nom, latitude, longitude, provisoire]. */
export type AllStopsDto = [string, string, number, number, boolean][];

export type UsageDto = {
	uid: number;
	line: string;
	directionId: number;
	headsigns: string[];
	label: string | null;
	open: boolean;
};

export type ProvisionalStopDto = {
	stopId: string;
	name: string;
	latitude: number;
	longitude: number;
	stopCode: string | null;
	description: string | null;
	zoneId: string | null;
	parentStation: string | null;
	wheelchairBoarding: 0 | 1 | 2;
	platformCode: string | null;
	usages: UsageDto[];
};

export type ProvisionalStopInput = Omit<ProvisionalStopDto, "stopId" | "usages">;

export type StopReferencesDto = {
	fareAreas: { areaId: string; name: string }[];
	/** [stationId, nom, latitude, longitude]. */
	stations: [string, string, number | null, number | null][];
};

export type RouteLegDto = { path: [number, number][]; distance: number; fromOffset: number; toOffset: number };

export type MessageDto = { code: number; message: string };
