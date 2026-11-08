import GtfsRealtime from "gtfs-realtime-bindings";
import { FINISHED_TRIP_RETENTION, SERVICE_RUN_MARGIN, TRIP_UPDATES_HORIZON } from "../config.js";
import {
	applySkippedStops,
	type CancelIndex,
	declareCancelled,
	declareNoRealtime,
	hasSkippedStops,
	isCancelled,
	type SkipIndex,
} from "./use-service-alerts.js";
import { SERVICE_ADDED, SERVICE_REMOVED, type StaticGtfs } from "./use-static-gtfs.js";

const TIME_ZONE = "Europe/Paris";

const SCHEDULED = GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SCHEDULED;

/** Une journée de service : sa date au format GTFS, son minuit, et les services qui y circulent. */
export type ServiceDay = { date: string; midnight: number; services: Set<string> };

/**
 * Les journées de service voisines d'aujourd'hui, aux décalages demandés.
 *
 * Bornes calculées par `startOfDay` et non par tranches de 86 400 s : les jours de changement d'heure
 * ne durent pas vingt-quatre heures, et toutes leurs courses seraient décalées d'une heure.
 */
export function serviceDays(gtfs: StaticGtfs, offsets: readonly number[]): ServiceDay[] {
	const today = Temporal.Now.plainDateISO(TIME_ZONE);
	return offsets.map((offset) => serviceDay(gtfs, today.add({ days: offset })));
}

/**
 * Les journées de service susceptibles de porter une course qui circule entre `from` et `to`
 * (secondes epoch) : de la veille de `from` — une course partie à « 25:10:00 » appartient à la
 * journée d'hier et roule ce matin — jusqu'à celle de `to`.
 */
export function serviceDaysBetween(gtfs: StaticGtfs, from: number, to: number): ServiceDay[] {
	const dateOf = (seconds: number) =>
		Temporal.Instant.fromEpochMilliseconds(seconds * 1000)
			.toZonedDateTimeISO(TIME_ZONE)
			.toPlainDate();

	const last = dateOf(to);
	const days: ServiceDay[] = [];
	for (
		let date = dateOf(from).subtract({ days: 1 });
		Temporal.PlainDate.compare(date, last) <= 0;
		date = date.add({ days: 1 })
	)
		days.push(serviceDay(gtfs, date));
	return days;
}

/** La journée de service d'une date donnée. */
export function serviceDay(gtfs: StaticGtfs, plainDate: Temporal.PlainDate): ServiceDay {
	const day = plainDate.toZonedDateTime(TIME_ZONE);
	const date = plainDate.toString().replaceAll("-", "");
	return {
		date,
		midnight: Math.floor(day.epochMilliseconds / 1000),
		services: activeServices(gtfs, day.dayOfWeek, date),
	};
}

/** Une course rattachée à la journée de service où elle circule. */
export type ServiceRun = { tripId: string; date: string };

/**
 * L'exemplaire de la course qui circule vraiment, et la journée de service dont il relève.
 * `undefined` lorsqu'aucun n'est rattachable à l'une des journées candidates — course que le GTFS ne
 * décrit plus, horaire théorique en retard sur le service en cours, ou `reference` à plus de
 * {@link SERVICE_RUN_MARGIN} du créneau de la course.
 *
 * Deux corrections en une, parce que c'est le même geste.
 *
 * La première est la journée, que le flux ne nomme pas : sans elle, le consommateur doit la deviner,
 * et les journées de service se chevauchent — après minuit, celle d'hier est encore ouverte. Le GTFS
 * écrit l'horaire d'une course en secondes depuis le minuit de sa journée de service, jamais en
 * instants : posé sur deux journées différentes, le même horaire donne deux créneaux distants de
 * vingt-quatre heures. Il suffit donc de regarder lequel encadre `reference` — l'instant que le flux
 * annonce pour la course. Le retard d'un véhicule se compte en minutes, l'écart entre deux journées
 * candidates en heures : aucune confusion possible, y compris pour une course écrite « 25:10 » que le
 * GTFS range la veille du soir où elle roule.
 *
 * Encore faut-il qu'un créneau encadre `reference` : le plus proche n'y suffit pas. Un véhicule garé
 * sur sa course du matin, que la source annonce encore le soir, se trouve alors plus près du départ
 * de demain que de l'arrivée d'aujourd'hui. Au-delà de {@link SERVICE_RUN_MARGIN}, aucune journée
 * n'est retenue.
 *
 * La seconde est l'identifiant lui-même. Le GTFS décrit une même course une fois par service qui
 * l'assure, sous un `trip_id` par exemplaire, et une source peut se tromper d'exemplaire : annoncer le
 * vendredi la course du samedi, qui existe bel et bien mais ne circule pas ce jour-là. On met donc en
 * balance toutes les versions de la course (cf. `courseVersions`), et non la seule annoncée — sauf
 * `exact`, pour une source qui nomme toujours la bonne : SIRI Lite chez TCL.
 *
 * Ne sont retenues que les journées où le service de la version examinée circule réellement : le
 * calendrier écarte à lui seul la plupart des ambiguïtés, l'horaire tranche le reste.
 */
export function resolveServiceRun(
	gtfs: StaticGtfs,
	days: readonly ServiceDay[],
	tripId: string,
	reference: number,
	{ exact = false }: { exact?: boolean } = {},
): ServiceRun | undefined {
	const courseKey = gtfs.tripCourseKeys.get(tripId);
	// Course absente de l'index : elle n'a pas d'horaire, donc pas de version connue. Elle reste seule
	// candidate — le calendrier tranchera, ou personne. `exact` s'en tient à la version annoncée : une
	// source qui ne se trompe pas d'exemplaire n'a pas à voir son identifiant réécrit.
	const versions = (exact || courseKey === undefined ? undefined : gtfs.courseVersions.get(courseKey)) ?? [tripId];

	let best: ServiceRun | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;

	for (const candidate of versions) {
		const serviceId = gtfs.trips.get(candidate)?.serviceId;
		const departure = gtfs.tripDepartures.get(candidate);
		const arrival = gtfs.tripArrivals.get(candidate);
		if (serviceId === undefined || departure === undefined || arrival === undefined) continue;

		for (const { date, midnight, services } of days) {
			if (!services.has(serviceId)) continue;

			// Distance de `reference` au créneau de la course ce jour-là : nulle pendant qu'elle roule, et
			// c'est de combien elle le manque sinon.
			const distance = Math.max(0, midnight + departure - reference, reference - (midnight + arrival));
			if (distance > SERVICE_RUN_MARGIN) continue;

			// À égalité — deux versions qui circulent le même jour —, on garde celle que la source annonce :
			// un identifiant ne se réécrit que lorsqu'il le faut.
			if (distance < bestDistance || (distance === bestDistance && candidate === tripId)) {
				bestDistance = distance;
				best = { tripId: candidate, date };
			}
		}
	}

	return best;
}

/** La clé sous laquelle une course est dite servie par le flux source (cf. `covered`). */
export function tripRun(tripId: string, date: string): string {
	return `${tripId}:${date}`;
}

/**
 * Les trip updates des courses dont le flux source ne parle pas, reconstruits depuis le seul horaire
 * théorique. SIRI Lite ne parle que des courses qui roulent ou sont sur le point de partir, et une
 * suppression d'arrêt annoncée pour ce soir n'aurait sinon aucune course où s'annoncer d'ici là.
 *
 * Une course annulée par une modification y figure toujours, annulée (cf. `isCancelled`).
 *
 * Est retenue toute course qui part dans les vingt-quatre heures (cf. {@link TRIP_UPDATES_HORIZON})
 * et n'est pas arrivée à son terminus depuis plus d'une heure (cf. {@link FINISHED_TRIP_RETENTION}) :
 * la fenêtre glisse, et le soir porte déjà les courses du lendemain matin. `covered` porte les courses que
 * le flux source a déjà servies, journée de service comprise (cf. {@link tripRun}) : ce qu'il annonce
 * l'emporte toujours sur ce qu'on déduit du théorique, mais seulement pour la journée qu'il sert —
 * celle d'hier qui roule encore après minuit n'est pas couverte par son homonyme d'aujourd'hui.
 *
 * Chaque course déclare la journée de service dont elle relève. Sans elle, le consommateur doit la
 * deviner, et à minuit passé la journée d'hier est encore ouverte — une course reconstruite pour ce
 * soir passerait alors pour avoir roulé la veille au soir, les vingt-quatre heures à venir étant
 * publiées d'un bloc.
 *
 * Chaque course en ressort réduite à ce qu'on en sait de sûr (cf. {@link declareNoRealtime}) : son
 * premier arrêt en NO_DATA, puis ses arrêts supprimés — la forme même que prennent les courses du
 * flux source sur les lignes sans vrai temps réel. Encore faut-il qu'elle en supprime un : une
 * course reconstruite n'a par définition aucun temps réel, et sans suppression il ne resterait d'elle
 * que ce NO_DATA, qui n'apprend rien de plus que l'horaire théorique.
 */
export function scheduledTripUpdates(
	gtfs: StaticGtfs,
	skipIndex: SkipIndex,
	cancelIndex: CancelIndex,
	covered: ReadonlySet<string>,
	nowSeconds: number,
): GtfsRealtime.transit_realtime.ITripUpdate[] {
	const tripUpdates: GtfsRealtime.transit_realtime.ITripUpdate[] = [];
	const horizon = nowSeconds + TRIP_UPDATES_HORIZON;
	const retainedSince = nowSeconds - FINISHED_TRIP_RETENTION;

	for (const { date, midnight, services } of serviceDaysBetween(gtfs, retainedSince, horizon)) {
		for (const serviceId of services) {
			for (const tripId of gtfs.serviceTrips.get(serviceId) ?? []) {
				if (covered.has(tripRun(tripId, date))) continue;

				// La dernière arrivée, et non le départ : une course commencée il y a vingt minutes dessert
				// encore des arrêts. Arrivée à son terminus, elle reste encore une heure dans le feed.
				// Au-delà de l'horizon, elle attendra que la fenêtre la rattrape.
				const departure = gtfs.tripDepartures.get(tripId);
				const arrival = gtfs.tripArrivals.get(tripId);
				if (departure === undefined || arrival === undefined) continue;
				if (midnight + arrival < retainedSince || midnight + departure >= horizon) continue;

				const cancelled = isCancelled(cancelIndex, gtfs, tripId, midnight);
				// Sans arrêt supprimé sur sa ligne, une course qui n'est pas annulée n'a rien à annoncer : inutile
				// d'en reconstituer l'horaire — des dizaines de milliers par journée.
				if (!cancelled && !skipIndex.has(gtfs.trips.get(tripId)?.routeId ?? "")) continue;
				const tripUpdate = cancelled
					? buildCancellation(gtfs, tripId, date, nowSeconds)
					: buildTripUpdate(gtfs, skipIndex, tripId, date, midnight, departure, nowSeconds);
				if (tripUpdate === undefined) continue;

				tripUpdates.push(tripUpdate);
			}
		}
	}

	return tripUpdates;
}

/**
 * Services actifs une journée donnée : le calendrier hebdomadaire d'abord, que les exceptions datées
 * viennent ensuite amender. Le GTFS du réseau ne publie pas `calendar.txt` et énumère chaque journée
 * de chaque service en ajout : tout y vient alors des seules exceptions.
 */
function activeServices(gtfs: StaticGtfs, dayOfWeek: number, date: string): Set<string> {
	const services = new Set<string>();

	for (const [serviceId, calendar] of gtfs.calendars) {
		// `dayOfWeek` numérote la semaine à partir de 1 pour le lundi, comme les colonnes du GTFS.
		if (calendar.weekdays[dayOfWeek - 1] !== true) continue;
		if (calendar.startDate && date < calendar.startDate) continue;
		if (calendar.endDate && date > calendar.endDate) continue;
		services.add(serviceId);
	}

	for (const [serviceId, exceptions] of gtfs.calendarExceptions) {
		const exceptionType = exceptions.get(date);
		if (exceptionType === SERVICE_ADDED) services.add(serviceId);
		else if (exceptionType === SERVICE_REMOVED) services.delete(serviceId);
	}

	return services;
}

/** L'annulation d'une course absente du flux source : son descripteur, et rien d'autre. */
function buildCancellation(
	gtfs: StaticGtfs,
	tripId: string,
	startDate: string,
	nowSeconds: number,
): GtfsRealtime.transit_realtime.ITripUpdate | undefined {
	const meta = gtfs.trips.get(tripId);
	if (meta === undefined) return undefined;

	const tripUpdate: GtfsRealtime.transit_realtime.ITripUpdate = {
		trip: { tripId, routeId: meta.routeId, directionId: meta.directionId, startDate },
		timestamp: nowSeconds,
	};
	declareCancelled(tripUpdate);
	return tripUpdate;
}

/**
 * Le trip update d'une course absente du flux source. Il part de l'horaire théorique tout entier
 * pour que les suppressions d'arrêt s'y appliquent comme sur une course relayée — avec le garde-fou
 * des terminus effectifs et les exceptions de desserte — avant d'être réduit à sa forme finale.
 *
 * `undefined` pour une course que le GTFS ne décrit plus, ou qui ne supprime aucun arrêt : n'ayant
 * aucun temps réel non plus, elle n'a rien à annoncer.
 */
function buildTripUpdate(
	gtfs: StaticGtfs,
	skipIndex: SkipIndex,
	tripId: string,
	startDate: string,
	midnight: number,
	departure: number,
	nowSeconds: number,
): GtfsRealtime.transit_realtime.ITripUpdate | undefined {
	const meta = gtfs.trips.get(tripId);
	const schedule = gtfs.tripStopSequences.get(tripId);
	if (meta === undefined || schedule === undefined) return undefined;

	const tripUpdate: GtfsRealtime.transit_realtime.ITripUpdate = {
		trip: {
			tripId,
			routeId: meta.routeId,
			directionId: meta.directionId,
			startDate,
			scheduleRelationship: GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.SCHEDULED,
		},
		stopTimeUpdate: schedule.map(({ stopSequence, stopId }) => ({
			stopSequence,
			stopId,
			scheduleRelationship: SCHEDULED,
		})),
		// Le relevé date de ce poll-ci : les suppressions sont réévaluées à chaque tour, et une course
		// sans horodatage passe pour périmée chez qui écarte ce qu'il ne peut pas dater. Le flux source
		// horodate les siennes, qu'on relaie telles quelles.
		timestamp: nowSeconds,
	};

	applySkippedStops(
		tripUpdate,
		meta.routeId,
		skipIndex,
		gtfs,
		midnight,
		Temporal.Instant.fromEpochMilliseconds((midnight + departure) * 1000),
	);
	if (!hasSkippedStops(tripUpdate)) return undefined;

	declareNoRealtime(tripUpdate, schedule);

	return tripUpdate;
}
