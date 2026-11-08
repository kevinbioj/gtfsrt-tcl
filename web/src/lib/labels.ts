/** Les causes du GTFS-RT, en clair. */
export const CAUSES: Record<string, string> = {
	CONSTRUCTION: "Travaux",
	DEMONSTRATION: "Manifestation",
	STRIKE: "Grève",
	MAINTENANCE: "Maintenance",
	ACCIDENT: "Accident",
	WEATHER: "Météo",
	TECHNICAL_PROBLEM: "Problème technique",
	POLICE_ACTIVITY: "Intervention police",
	MEDICAL_EMERGENCY: "Urgence médicale",
	SPECIAL_EVENT: "Événement spécial",
	HOLIDAY: "Jour férié",
	OTHER_CAUSE: "Autre",
	UNKNOWN_CAUSE: "Inconnue",
};

/** Les effets du GTFS-RT, en clair. */
export const EFFECTS: Record<string, string> = {
	DETOUR: "Déviation",
	NO_SERVICE: "Aucun service",
	REDUCED_SERVICE: "Service réduit",
	SIGNIFICANT_DELAYS: "Retards importants",
	MODIFIED_SERVICE: "Service modifié",
	STOP_MOVED: "Arrêt déplacé",
	ADDITIONAL_SERVICE: "Service supplémentaire",
	ACCESSIBILITY_ISSUE: "Accessibilité",
	NO_EFFECT: "Aucun effet",
	OTHER_EFFECT: "Autre",
	UNKNOWN_EFFECT: "Inconnu",
};

/**
 * Une couleur par cause, assez foncée pour porter un texte blanc (contraste 4,5:1 au moins) et assez
 * distincte des autres pour se reconnaître d'un coup d'œil dans la liste.
 */
export const CAUSE_COLORS: Record<string, string> = {
	CONSTRUCTION: "#B54708",
	DEMONSTRATION: "#6941C6",
	STRIKE: "#C01048",
	MAINTENANCE: "#0E7090",
	ACCIDENT: "#B42318",
	WEATHER: "#175CD3",
	TECHNICAL_PROBLEM: "#344054",
	POLICE_ACTIVITY: "#2D31A6",
	MEDICAL_EMERGENCY: "#C11574",
	SPECIAL_EVENT: "#3B7C0F",
	HOLIDAY: "#027A48",
	OTHER_CAUSE: "#4A5058",
	UNKNOWN_CAUSE: "#667085",
};

export const causeColor = (cause: string | null) =>
	CAUSE_COLORS[cause ?? "UNKNOWN_CAUSE"] ?? CAUSE_COLORS.UNKNOWN_CAUSE;

export const causeLabel = (cause: string | null) => (cause === null ? "Inconnue" : (CAUSES[cause] ?? cause));

/**
 * Le texte qui se lit le mieux sur un fond de cette couleur (« #RRGGBB ») : blanc, ou presque noir sur
 * un fond clair — d'après la luminance relative du WCAG, au seuil où les deux contrastes s'égalent.
 */
export function readableOn(color: string): string {
	const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
	if (match === null) return "#FFFFFF";
	const [r, g, b] = match.slice(1).map((hex) => {
		const channel = Number.parseInt(hex, 16) / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return luminance > 0.179 ? "#15181B" : "#FFFFFF";
}

/** Les teintes que propose la création d'une étiquette — celles des causes, qui portent un texte blanc. */
export const LABEL_SWATCHES = [
	"#1D56C8",
	"#175CD3",
	"#0E7090",
	"#027A48",
	"#3B7C0F",
	"#B54708",
	"#B42318",
	"#C01048",
	"#C11574",
	"#6941C6",
	"#2D31A6",
	"#344054",
];
