import type { AlertPhase, AlertPublication, ModificationState } from "@dto";
import { cn } from "cn";

type Tone = "info" | "warning" | "neutral" | "inverse" | "solid";

const TONES: Record<Tone, { pill: string; dot: string }> = {
	info: { pill: "bg-info text-info-foreground", dot: "bg-info-dot" },
	warning: { pill: "bg-warning text-warning-foreground", dot: "bg-warning-dot" },
	neutral: { pill: "bg-neutral text-neutral-foreground", dot: "bg-neutral-dot" },
	inverse: { pill: "bg-inverse text-inverse-foreground", dot: "bg-white" },
	solid: { pill: "bg-primary text-primary-foreground", dot: "bg-white" },
};

/** Une pastille d'état : un point de couleur et un libellé. */
export function StatusPill({
	tone,
	children,
	className,
}: {
	tone: Tone;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-semibold whitespace-nowrap",
				TONES[tone].pill,
				className,
			)}
		>
			<span aria-hidden="true" className={cn("size-1.5 rounded-full", TONES[tone].dot)} />
			{children}
		</span>
	);
}

export const ALERT_PUBLICATIONS: Record<AlertPublication, { tone: Tone; label: string }> = {
	published: { tone: "solid", label: "Publiée" },
	hidden: { tone: "inverse", label: "Dépubliée" },
	withdrawn: { tone: "neutral", label: "Retirée du flux" },
	draft: { tone: "inverse", label: "Brouillon" },
};

export const ALERT_PHASES: Record<AlertPhase, { tone: Tone; label: string }> = {
	current: { tone: "info", label: "En cours" },
	paused: { tone: "warning", label: "Hors plage horaire" },
	planned: { tone: "warning", label: "Planifiée" },
	expired: { tone: "neutral", label: "Expirée" },
};

export const MODIFICATION_STATES: Record<ModificationState, { tone: Tone; label: string }> = {
	manual: { tone: "solid", label: "Publiée · manuelle" },
	live: { tone: "info", label: "Publiée · via alerte" },
	planned: { tone: "warning", label: "Planifiée · via alerte" },
	off: { tone: "neutral", label: "Non publiée" },
};

/** Le bandeau d'état d'une alerte, aux couleurs de sa pastille. */
export const STATE_BANNERS: Record<Tone, string> = {
	info: "bg-info text-info-foreground",
	warning: "bg-warning text-warning-foreground",
	neutral: "bg-neutral text-neutral-foreground",
	inverse: "bg-inverse text-inverse-foreground",
	solid: "bg-primary text-primary-foreground",
};
