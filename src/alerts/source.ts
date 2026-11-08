import type GtfsRealtime from "gtfs-realtime-bindings";

import type { AlertPeriod } from "../gtfs-rt/use-service-alerts.js";
import type { StaticGtfs } from "../gtfs-rt/use-static-gtfs.js";

/**
 * Une info trafic telle qu'une alimentation la livre, déjà mise en forme GTFS-RT.
 *
 * L'alimentation ne fait que traduire : rien n'y est deviné. Ce qu'elle ne dit pas — les arrêts
 * supprimés, les courses annulées, le sens touché, les périodes exactes — se saisit à la main dans
 * l'interface d'administration.
 */
export type SourceAlert = {
	/**
	 * Le numéro sous lequel l'info trafic se règle dans l'administration. Stable d'un relevé à l'autre,
	 * et jamais de la forme « P<n> », réservée à celles créées à la main (cf. `customAlertNumber`).
	 */
	alertNumber: string;
	/** L'identifiant sous lequel elle se republie (« SA:<alertId> »), que citent les `serviceAlertId`. */
	alertId: string;
	/**
	 * L'alerte telle que la source la donne : textes (HTML toléré), lien, entités touchées — des
	 * identifiants du GTFS statique —, et période active, qui vaut fenêtre de communication.
	 */
	alert: GtfsRealtime.transit_realtime.IAlert;
	/** Les périodes de la perturbation que la source annonce — proposées par défaut, corrigeables. */
	periods: AlertPeriod[];
};

/**
 * Une alimentation d'infos trafic. Une autre source — un autre format, un autre fournisseur — n'est
 * qu'un autre adaptateur : tout ce qui suit le relevé (republication, réglages, modifications
 * associées) ne connaît que {@link SourceAlert}.
 */
export interface AlertSource {
	/** Son nom, pour les journaux et l'interface. */
	readonly label: string;
	/** Intervalle entre deux relevés, en millisecondes. */
	readonly interval: number;
	/** Le relevé, ou `null` s'il échoue : le précédent reste alors en place. */
	fetch(gtfs: StaticGtfs): Promise<SourceAlert[] | null>;
}
