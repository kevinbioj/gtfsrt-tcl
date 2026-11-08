import type { PeriodDto, TimeRangeDto } from "@dto";

const pad = (value: number) => String(value).padStart(2, "0");

/** « 2026-10-26 » donne « 26/10 », « 2026-10-26T08:30 » « 26/10 à 08:30 ». */
export function formatBound(bound: string): string {
	const [date, time] = bound.split("T");
	const [, month, day] = (date ?? "").split("-");
	return time === undefined ? `${day}/${month}` : `${day}/${month} à ${time}`;
}

/** Un instant epoch en secondes, à l'heure locale : « 24/10 à 14:32 ». */
export function formatInstant(seconds: number): string {
	const date = new Date(seconds * 1000);
	return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} à ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Une heure epoch, « 14:32:05 ». */
export function formatClock(seconds: number): string {
	const date = new Date(seconds * 1000);
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Une date epoch, « 19/10/2026 ». */
export function formatDate(seconds: number): string {
	const date = new Date(seconds * 1000);
	return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/** Secondes depuis minuit, « 06:00 » — au-delà de 24 h, l'heure du lendemain. */
export function formatSeconds(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	return `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
}

/** « 06:30 » donne 23 400. */
export function parseClock(value: string): number | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (match === null) return null;
	return Number(match[1]) * 3600 + Number(match[2]) * 60;
}

/** Une durée en secondes, « 3:00 » ; négative, « −1:30 ». */
export function formatDuration(seconds: number): string {
	const sign = seconds < 0 ? "−" : "";
	const total = Math.abs(Math.round(seconds));
	return `${sign}${Math.floor(total / 60)}:${pad(total % 60)}`;
}

/** « 3:00 », « 3 », « -1:30 » donnent des secondes ; `null` si illisible. */
export function parseDuration(text: string): number | null {
	const match = /^\s*([-−]?)(\d+)(?::(\d{1,2}))?\s*$/.exec(text);
	if (match === null) return null;
	const seconds = Number(match[2]) * 60 + Number(match[3] ?? 0);
	return match[1] ? -seconds : seconds;
}

/** Une longueur en mètres : « 340 m », « 1,25 km ». */
export function formatLength(meters: number): string {
	if (!Number.isFinite(meters) || meters < 1) return "—";
	if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
	return `${(meters / 1000).toFixed(2).replace(".", ",")} km`;
}

/** Une période en clair : « du 26/10 au 29/10, de 09:00 à 12:00 », « à partir du 24/10 à 08:30 ». */
export function describePeriod(period: PeriodDto): string {
	const window = period.dailyWindow ? `, de ${period.dailyWindow.from} à ${period.dailyWindow.to}` : "";
	if (period.start === null && period.end === null) return `en continu${window}`;
	if (period.end === null) return `à partir du ${formatBound(period.start as string)}${window}`;
	if (period.start === null) return `jusqu'au ${formatBound(period.end)}${window}`;
	return `du ${formatBound(period.start)} au ${formatBound(period.end)}${window}`;
}

/** Les périodes en clair, ou « toujours » s'il n'y en a pas. */
export function describePeriods(periods: readonly PeriodDto[]): string {
	return periods.length === 0 ? "en continu" : periods.map(describePeriod).join(" ; ");
}

/** L'identifiant affiché d'une modification : MOD-0042. */
export function modificationId(uid: number): string {
	return `MOD-${String(uid).padStart(4, "0")}`;
}

/** « 1 arrêt », « 3 arrêts ». */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count > 1 ? pluralForm : singular}`;
}

/** Une recherche sans accents ni casse. */
export function searchable(text: string): string {
	return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Des intervalles du flux en clair : « du 30/10 à 00:01 au 31/12 à 23:59 », « sans borne » s'il n'y en a pas. */
export function describeRanges(ranges: readonly TimeRangeDto[]): string {
	if (ranges.length === 0) return "sans borne";
	return ranges
		.map(({ start, end }) => {
			if (start === null && end === null) return "sans borne";
			if (end === null) return `à partir du ${formatInstant(start as number)}`;
			if (start === null) return `jusqu'au ${formatInstant(end)}`;
			return `du ${formatInstant(start)} au ${formatInstant(end)}`;
		})
		.join(" ; ");
}
