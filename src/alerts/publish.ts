import GtfsRealtime from "gtfs-realtime-bindings";

import type { ModificationIndex } from "../detours/modifications.js";
import {
	type AlertSettings,
	canonicalImpact,
	type DetourStore,
	type ImpactEntity,
	impactKey,
	informedEntities,
} from "../detours/store.js";
import {
	type AlertEntity,
	alertSourceKey,
	customPublishedPeriods,
	imageMediaType,
	publishedPeriods,
	republishedAlertId,
} from "../gtfs-rt/use-service-alerts.js";
import type { StaticGtfs } from "../gtfs-rt/use-static-gtfs.js";

type FeedEntity = GtfsRealtime.transit_realtime.IFeedEntity;

export type AlertPublication = ReturnType<typeof useAlertPublication>;

/**
 * Les infos trafic telles qu'elles se republient — celles de l'alimentation, réglées, et celles créées
 * à la main —, et ce qui veille sur leurs réglages : un impact réécrit que la source a repris, une
 * alerte traitée qui change, une dépublication programmée.
 */
export function useAlertPublication({
	store,
	gtfs,
	feed,
	modificationIndex,
	onChange,
}: {
	store: DetourStore;
	gtfs: { data: StaticGtfs };
	/** Les infos trafic de l'alimentation, prêtes à être republiées (cf. `useServiceAlerts`). */
	feed: { entities: readonly AlertEntity[] };
	modificationIndex: ModificationIndex;
	/** Ce qui se publie a changé hors de toute saisie : une dépublication programmée est échue. */
	onChange: () => void;
}) {
	/**
	 * L'impact qu'une info trafic reçoit de la source, sous sa forme canonique : celle que l'on republie,
	 * et à laquelle se compare un impact réécrit.
	 */
	const receivedImpact = (alert: GtfsRealtime.transit_realtime.IAlert | null | undefined) =>
		canonicalImpact(informedEntities(alert?.informedEntity ?? []), (routeId) =>
			(gtfs.data.routeDirections.get(routeId) ?? []).map((direction) => direction.directionId),
		);

	/**
	 * Une info trafic de l'alimentation telle qu'elle se republie : dépubliée, elle ne l'est pas du tout ;
	 * ses périodes active, de communication et d'impact se déduisent de celles que la source annonce, ou
	 * de celles saisies s'il y en a — ce sont aussi elles qui décident de ce qu'elle active (cf.
	 * `ResolvedAlert.periods`). Son texte, sa cause et son effet réécrits remplacent ceux de la source.
	 */
	const republished = ({ alertNumber, entity, periods }: AlertEntity): FeedEntity[] => {
		const settings = store.alertSettings(alertNumber);
		if (settings.hidden) return [];
		if (entity.alert == null) return [entity];

		const alert: GtfsRealtime.transit_realtime.IAlert = { ...entity.alert };
		Object.assign(
			alert,
			publishedPeriods(settings.periods ?? periods, entity.alert.communicationPeriod ?? [], Temporal.Now.instant()),
		);
		applySettings(alert, settings, receivedImpact(entity.alert));
		return [{ ...entity, alert }];
	};

	/**
	 * Les infos trafic créées à la main et publiées, telles qu'elles sortent : tout ce qu'elles disent a
	 * été saisi, et elles restent au feed tant qu'elles sont publiées (cf. `customPublishedPeriods`). Une
	 * sans impact ne sort pas : GTFS-RT veut au moins une entité touchée — la publication l'exige déjà.
	 * Une dont la dépublication programmée est échue ne sort plus, même dans l'instant qui précède celui
	 * où elle se dépublie (cf. `scheduleUnpublication`).
	 */
	const customAlertEntities = (): FeedEntity[] => {
		const now = Temporal.Now.instant();
		const nowSeconds = Math.floor(now.epochMilliseconds / 1000);
		return [...modificationIndex.alerts.values()].flatMap((resolved) => {
			if (!resolved.custom || resolved.hidden || resolved.publishedAt === null) return [];
			if (resolved.unpublishAt !== null && resolved.unpublishAt <= nowSeconds) return [];
			const settings = store.alertSettings(resolved.alertNumber);
			if (settings.impact === null || settings.impact.entities.length === 0) return [];

			const alert: GtfsRealtime.transit_realtime.IAlert = customPublishedPeriods(
				resolved.periods,
				resolved.publishedAt,
				resolved.unpublishAt,
				now,
			);
			applySettings(alert, settings, []);
			return [{ id: republishedAlertId(resolved.alertNumber), alert }];
		});
	};

	let unpublicationTimer: NodeJS.Timeout | undefined;

	/**
	 * Arme la dépublication programmée la plus proche des infos trafic créées à la main : à l'échéance,
	 * elle sort du flux et repasse en brouillon (cf. `unpublishDue`), et ce qu'elle activait cesse. Une
	 * minuterie à la seconde plutôt qu'une ronde : un client qui interroge avec If-Modified-Since doit
	 * voir le flux changer dès l'échéance. `setTimeout` ne tient pas plus de 24,8 jours : au-delà, elle se
	 * réarme en route.
	 */
	const scheduleUnpublication = () => {
		clearTimeout(unpublicationTimer);
		const pending = [...store.customAlerts.values()].flatMap(({ unpublishAt }) =>
			unpublishAt === null ? [] : [unpublishAt],
		);
		if (pending.length === 0) return;

		const delay = Math.max(0, Math.min(Math.min(...pending) * 1000 - Date.now(), 2 ** 31 - 1));
		unpublicationTimer = setTimeout(() => {
			try {
				const unpublished = store.unpublishDue(Math.floor(Date.now() / 1000));
				if (unpublished.length > 0) {
					console.log(`➔ Alerts ${unpublished.join(", ")}: scheduled unpublication reached, unpublished.`);
					modificationIndex.reindex();
					onChange();
				}
			} catch (cause) {
				// L'échéance reste due : se réarmer tout de suite tournerait en boucle.
				console.error("✘ Scheduled unpublication failed, retrying in a minute:", cause);
				unpublicationTimer = setTimeout(scheduleUnpublication, 60_000);
				return;
			}
			scheduleUnpublication();
		}, delay);
	};

	return {
		receivedImpact,

		/**
		 * Les infos trafic à émettre : celles de l'alimentation, puis celles créées à la main. Elles ont leur
		 * propre endpoint, et la racine les reprend avec tout le reste ; `/trip-updates` ne les porte pas —
		 * le `serviceAlertId` de ses modifications y cite alors une info trafic absente, le champ ne valant
		 * que renvoi.
		 */
		publishedAlerts(): FeedEntity[] {
			return [...feed.entities.flatMap(republished), ...customAlertEntities()];
		},

		/**
		 * Abandonne les impacts réécrits des infos trafic dont la source a changé l'impact, et rend à traiter
		 * celles traitées qui ont changé. Rend vrai si l'index est à rebâtir : un impact réécrit a sauté.
		 */
		dropStale(): boolean {
			const received = new Map(
				feed.entities.map(({ alertNumber, entity }) => [alertNumber, impactKey(receivedImpact(entity.alert))]),
			);
			const dropped = store.dropStaleImpacts(received);

			const unchecked = store.dropStaleChecks(
				new Map(
					feed.entities.flatMap(({ alertNumber, entity }) =>
						entity.alert ? [[alertNumber, alertSourceKey(entity.alert)] as const] : [],
					),
				),
			);
			if (unchecked.length > 0) console.log(`➔ Alerts ${unchecked.join(", ")}: source changed, back to unchecked.`);

			if (dropped.length === 0) return false;
			console.log(`➔ Alerts ${dropped.join(", ")}: received impact changed, rewritten impact dropped.`);
			return true;
		},

		scheduleUnpublication,
	};
}

/**
 * Pose sur une alerte ce qui s'en réécrit : son texte, sa cause, son effet, son lien, son image et son
 * impact. Un lien, une image ou un texte alternatif réécrits à vide retirent ceux de la source.
 * Réécrit ou non, l'impact sort sous sa forme canonique : une ligne citée dans tous ses sens n'y figure
 * qu'une fois, sans sens (cf. `canonicalImpact`).
 */
function applySettings(
	alert: GtfsRealtime.transit_realtime.IAlert,
	settings: AlertSettings,
	received: readonly ImpactEntity[],
) {
	const { headerText, descriptionText, cause, effect, url, imageUrl, imageAlternativeText } = settings.overrides;
	const Alert = GtfsRealtime.transit_realtime.Alert;
	const translated = (text: string) => ({ translation: [{ text, language: "fr" }] });
	if (headerText !== null) alert.headerText = translated(headerText);
	if (descriptionText !== null) alert.descriptionText = translated(descriptionText);
	if (cause !== null && cause in Alert.Cause) alert.cause = Alert.Cause[cause as keyof typeof Alert.Cause];
	if (effect !== null && effect in Alert.Effect) alert.effect = Alert.Effect[effect as keyof typeof Alert.Effect];
	if (url !== null) alert.url = url === "" ? null : translated(url);
	if (imageUrl !== null) {
		// La saisie l'a contrôlé : une image sans type connu n'a pas pu s'enregistrer.
		const mediaType = imageUrl === "" ? undefined : imageMediaType(imageUrl);
		alert.image = mediaType === undefined ? null : { localizedImage: [{ url: imageUrl, mediaType, language: "fr" }] };
	}
	if (imageAlternativeText !== null) {
		alert.imageAlternativeText = imageAlternativeText === "" ? null : translated(imageAlternativeText);
	}
	const impact = settings.impact?.entities ?? received;
	alert.informedEntity = impact.map(({ agencyId, routeId, directionId, stopId }) => ({
		...(agencyId === null ? {} : { agencyId }),
		...(routeId === null ? {} : { routeId }),
		...(directionId === null ? {} : { directionId }),
		...(stopId === null ? {} : { stopId }),
	}));
}
