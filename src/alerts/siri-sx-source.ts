import GtfsRealtime from "gtfs-realtime-bindings";

import type { AlertPeriod } from "../gtfs-rt/use-service-alerts.js";
import type { StaticGtfs } from "../gtfs-rt/use-static-gtfs.js";
import type { PtSituationElement } from "../siri-lite/responses.js";
import { fetchSituationExchange } from "../siri-lite/situation-exchange.js";
import { parseSiriRef } from "../utils/parse-siri.js";
import type { AlertSource, SourceAlert } from "./source.js";

const TIME_ZONE = "Europe/Paris";

/** Longueur au-delà de laquelle un titre tiré de la description est coupé. */
const HEADER_MAX_LENGTH = 100;

/**
 * Les infos trafic de TCL, telles que les publie le Situation Exchange de SIRI Lite.
 *
 * Ce qu'on en tire se limite à ce que la source dit, mot pour mot ; rien n'y est deviné :
 *
 *  - chaque info trafic y figure en DEUX situations (`ACTIV_<n>_1` et `ACTIV_<n>_2`), qui partagent
 *    tout sauf leur texte : la première porte la description complète, la seconde un titre court
 *    (« Travaux sur les voies »). Elles se regroupent par l'info trafic qu'elles citent toutes deux
 *    (`RelatedToRef`), dont le numéro devient celui de l'alerte ;
 *  - les lignes se citent par leur `route_id`, ou à défaut par leur nom commercial — les lignes
 *    scolaires (« JD450 ») ; une ligne que le GTFS ne connaît pas est écartée, et une alerte qui n'en
 *    cite aucune avec elle ;
 *  - la période de validité est la seule que la source donne : elle sert de fenêtre de communication,
 *    et de période proposée pour la perturbation — à corriger à la main quand le texte en dit plus ;
 *  - la source ne dit ni arrêt, ni sens, ni cause, ni effet : tout cela se saisit à la main.
 *
 * Le texte arrive dépouillé de son balisage, phrases collées (« ne circule pas.Pour vos
 * déplacements… ») : on rouvre un paragraphe à chaque phrase recollée, et la première adresse
 * tcl.fr qu'il cite devient le lien de l'alerte.
 */
export function siriSituationExchange(interval: number): AlertSource {
	return {
		label: "SIRI Lite situation exchange",
		interval,
		async fetch(gtfs) {
			console.log("➔ Fetching service alerts.");
			try {
				const payload = await fetchSituationExchange();
				const situations = payload.Siri.ServiceDelivery.SituationExchangeDelivery.flatMap(
					(delivery) => delivery.Situations?.PtSituationElement ?? [],
				);
				return toSourceAlerts(situations, gtfs);
			} catch (cause) {
				console.error("✘ Failed to fetch service alerts!", cause);
				return null;
			}
		},
	};
}

function toSourceAlerts(situations: readonly PtSituationElement[], gtfs: StaticGtfs): SourceAlert[] {
	// Les situations d'une même info trafic, dans l'ordre de leur numéro : `_1` puis `_2`.
	const grouped = new Map<string, PtSituationElement[]>();
	for (const situation of situations) {
		const key = alertNumberOf(situation);
		grouped.set(key, [...(grouped.get(key) ?? []), situation]);
	}

	const routeByName = new Map<string, string>();
	for (const [routeId, name] of gtfs.routeNames) if (!routeByName.has(name)) routeByName.set(name, routeId);
	const resolveRoute = (lineId: string) =>
		gtfs.routeDirections.has(lineId) ? lineId : (routeByName.get(lineId) ?? undefined);

	const alerts: SourceAlert[] = [];
	const unknownLines = new Set<string>();

	for (const [alertNumber, group] of grouped) {
		group.sort((a, b) => a.SituationNumber.value.localeCompare(b.SituationNumber.value, "en", { numeric: true }));
		const texts = group.map(descriptionOf).filter((text) => text.length > 0);
		// La plus longue décrit, la plus courte titre. Seule, elle fait les deux.
		const description = texts.reduce((a, b) => (b.length > a.length ? b : a), "");
		const shortest = texts.reduce((a, b) => (b.length < a.length ? b : a), description);
		const header = texts.length > 1 && shortest !== description ? cleanHeader(shortest) : headerOf(description);

		const routeIds: string[] = [];
		for (const lineRef of group.flatMap(lineRefsOf)) {
			const lineId = parseSiriRef(lineRef);
			const routeId = lineId === undefined ? undefined : resolveRoute(lineId);
			if (routeId === undefined) {
				unknownLines.add(lineId ?? lineRef);
				continue;
			}
			if (!routeIds.includes(routeId)) routeIds.push(routeId);
		}
		const stopIds = [...new Set(group.flatMap(stopRefsOf).flatMap((ref) => parseSiriRef(ref) ?? []))].filter((stopId) =>
			gtfs.stopNames.has(stopId),
		);

		const validity = group[0]?.ValidityPeriod?.[0];
		const start = instantOf(validity?.StartTime);
		const end = instantOf(validity?.EndTime);
		const url = description.match(/https?:\/\/(?:www\.)?tcl\.fr\/[^\s<>"]*/)?.[0];
		const translated = (text: string) => ({ translation: [{ text, language: "fr" }] });

		alerts.push({
			alertNumber,
			alertId: alertNumber,
			alert: {
				headerText: translated(header),
				descriptionText: translated(paragraphs(description)),
				...(url === undefined ? {} : { url: translated(url.replace(/[.,;:)]+$/, "")) }),
				cause: GtfsRealtime.transit_realtime.Alert.Cause.UNKNOWN_CAUSE,
				effect: GtfsRealtime.transit_realtime.Alert.Effect.UNKNOWN_EFFECT,
				informedEntity: [
					...routeIds.map((routeId) => {
						const agencyId = gtfs.routeAgencies.get(routeId);
						return { ...(agencyId === undefined ? {} : { agencyId }), routeId };
					}),
					...stopIds.map((stopId) => ({ stopId })),
				],
				activePeriod:
					start === null && end === null
						? []
						: [{ ...(start !== null && { start: secondsOf(start) }), ...(end !== null && { end: secondsOf(end) }) }],
			},
			periods:
				start === null && end === null ? [] : [{ start: localMinute(start), end: localMinute(end), dailyWindow: null }],
		});
	}

	if (unknownLines.size > 0) {
		console.warn(`\t⚠ Service alerts cite lines unknown to the GTFS: ${[...unknownLines].sort().join(", ")}.`);
	}
	return alerts;
}

/**
 * Le numéro d'une info trafic : celui qu'elle cite en référence, partagé par ses deux situations
 * (« 87462 »), ou à défaut le numéro de la situation, son rang ôté.
 */
function alertNumberOf(situation: PtSituationElement): string {
	const related = situation.References?.RelatedToRef?.[0]?.SituationNumber?.value?.trim();
	if (related) return related;
	return situation.SituationNumber.value.replace(/_\d+$/, "");
}

function descriptionOf(situation: PtSituationElement): string {
	const values = [...(situation.Description ?? []), ...(situation.Summary ?? [])];
	return (
		(values.find((value) => !value.lang || value.lang.toLowerCase().startsWith("fr")) ?? values[0])?.value.trim() ?? ""
	);
}

function lineRefsOf(situation: PtSituationElement): string[] {
	return (situation.Consequences?.Consequence ?? []).flatMap((consequence) =>
		(consequence.Affects?.Networks?.AffectedNetwork ?? []).flatMap((network) =>
			(network.AffectedLine ?? []).map((line) => line.LineRef.value),
		),
	);
}

function stopRefsOf(situation: PtSituationElement): string[] {
	return (situation.Consequences?.Consequence ?? []).flatMap((consequence) =>
		(consequence.Affects?.StopPoints?.AffectedStopPoint ?? []).map((stop) => stop.StopPointRef.value),
	);
}

/**
 * Les endroits où une phrase se recolle à la suivante : un point, un point d'exclamation ou
 * d'interrogation entre une minuscule (ou un chiffre) et une majuscule — ou entre une minuscule et un
 * chiffre, comme dans les listes d'horaires (« 6 novembre.00h45 »). Un sigle (« Z.I. »), une adresse
 * (« www.tcl.fr ») ou un nombre décimal (« 1.5 ») n'y répondent pas.
 */
const GLUED_SENTENCE = /(?<=[a-zà-ÿ)»])[.!?](?=[A-ZÀ-Ý0-9])|(?<=[0-9])[.!?](?=[A-ZÀ-Ý])/gu;

/** La description, rouverte en paragraphes là où ses phrases ont été recollées. */
function paragraphs(text: string): string {
	return text
		.replace(GLUED_SENTENCE, (punctuation) => `${punctuation}\u0000`)
		.split("\u0000")
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.map((part) => `<p>${part}</p>`)
		.join("");
}

/** Un titre court, débarrassé des séparateurs qui le terminent (« Déviée deux sens - »). */
function cleanHeader(text: string): string {
	return text
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.replace(/[\s\-–—:]+$/u, "")
		.trim();
}

/** Faute de titre, la première phrase de la description, coupée au besoin. */
function headerOf(description: string): string {
	const plain = cleanHeader(description);
	const first = plain.split(GLUED_SENTENCE)[0]?.split(/(?<=[.!?])\s/)[0] ?? plain;
	return first.length <= HEADER_MAX_LENGTH ? first : `${first.slice(0, HEADER_MAX_LENGTH - 1).trimEnd()}…`;
}

function instantOf(value: string | undefined): Temporal.Instant | null {
	if (!value) return null;
	try {
		return Temporal.Instant.from(value);
	} catch {
		return null;
	}
}

function secondsOf(instant: Temporal.Instant): number {
	return Math.floor(instant.epochMilliseconds / 1000);
}

/** Un instant en borne de période (cf. `AlertPeriod`) : « AAAA-MM-JJTHH:MM », heure de Paris. */
function localMinute(instant: Temporal.Instant | null): AlertPeriod["start"] {
	if (instant === null) return null;
	return instant.toZonedDateTimeISO(TIME_ZONE).toPlainDateTime().toString({ smallestUnit: "minute" });
}
