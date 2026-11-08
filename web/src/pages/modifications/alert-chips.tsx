import type { AlertLinkDto } from "@dto";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useState } from "react";

import { LineBadge } from "@/components/line-badge";
import { ALERT_PHASES, ALERT_PUBLICATIONS, StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { describePeriods } from "@/lib/format";
import { useAlert } from "@/lib/queries";

/**
 * Les alertes auxquelles une modification est rattachée, par leur seul numéro. Un clic ouvre le détail
 * de l'une d'elles : une alerte sortie du flux ou dépubliée n'active rien, et se lit en retrait.
 */
export function AlertChips({ alerts }: { alerts: AlertLinkDto[] }) {
	// La dernière ouverte reste affichée le temps que la fenêtre se referme.
	const [shown, setShown] = useState<AlertLinkDto | null>(null);
	const [open, setOpen] = useState(false);

	if (alerts.length === 0) return <span className="text-[13px] text-muted-foreground">—</span>;
	return (
		<>
			<span className="flex flex-wrap gap-1.5">
				{alerts.map((alert) => (
					<button
						key={alert.alertNumber}
						type="button"
						aria-label={`Alerte ${alert.alertNumber} : ${alert.headerText}`}
						onClick={() => {
							setShown(alert);
							setOpen(true);
						}}
						className={cn(
							"rounded-sm border px-1.5 py-0.5 font-mono text-xs font-semibold hover:border-input hover:bg-muted",
							alert.active ? "border-[#B9CDF3] bg-[#F7F9FE] text-accent-foreground" : "bg-card text-strong",
							((!alert.inFeed && !alert.custom) || alert.hidden) && "text-muted-foreground line-through",
						)}
					>
						#{alert.alertNumber}
					</button>
				))}
			</span>
			<AlertDetailDialog link={shown} open={open} onClose={() => setOpen(false)} />
		</>
	);
}

/** Le détail d'une alerte rattachée, et de quoi l'ouvrir. */
function AlertDetailDialog({ link, open, onClose }: { link: AlertLinkDto | null; open: boolean; onClose: () => void }) {
	const alert = useAlert(link?.alertNumber ?? null);
	const data = alert.data?.alertNumber === link?.alertNumber ? alert.data : undefined;

	return (
		<Dialog open={open} onOpenChange={(on) => (on ? null : onClose())}>
			<DialogContent className="sm:max-w-xl" aria-describedby={undefined}>
				<DialogHeader>
					<DialogTitle className="flex items-baseline gap-2">
						<span className="font-mono">#{link?.alertNumber}</span>
						<span className="font-semibold">{data?.published.headerText ?? link?.headerText}</span>
					</DialogTitle>
				</DialogHeader>

				{data !== undefined ? (
					<div className="flex flex-col gap-3 text-[13px]">
						<span className="flex flex-wrap items-center gap-1.5">
							<StatusPill tone={ALERT_PHASES[data.phase].tone}>{ALERT_PHASES[data.phase].label}</StatusPill>
							<StatusPill tone={ALERT_PUBLICATIONS[data.publication].tone}>
								{ALERT_PUBLICATIONS[data.publication].label}
							</StatusPill>
							{data.phaseDetail ? <span className="text-subtle">{data.phaseDetail}</span> : null}
						</span>
						<span className="flex flex-col gap-0.5">
							<span className="text-subtle">Périodes{data.periodsOverridden ? " (saisies)" : ""}</span>
							<span>{describePeriods(data.periods)}</span>
						</span>
						{data.lines.length > 0 ? (
							<span className="flex flex-wrap items-center gap-1.5">
								{data.lines.map((line) => (
									<LineBadge key={line.routeId} line={line} />
								))}
							</span>
						) : null}
						{data.received.descriptionHtml ? (
							<div
								className="max-h-64 overflow-y-auto rounded-md border border-[#E2E5E1] bg-muted px-3.5 py-3 leading-relaxed text-strong [&_a]:underline [&_img]:max-w-full [&_li]:ml-4 [&_li]:list-disc [&_p]:my-1"
								// Nettoyé côté serveur (cf. `sanitizeHtml`) : listes, liens et plans, rien qui s'exécute.
								// biome-ignore lint/security/noDangerouslySetInnerHtml: le HTML est nettoyé par le serveur.
								dangerouslySetInnerHTML={{ __html: data.received.descriptionHtml }}
							/>
						) : null}
					</div>
				) : alert.isError ? (
					<p className="m-0 text-[13px] text-muted-foreground">Le détail de cette alerte n'est plus disponible.</p>
				) : (
					<div className="flex flex-col gap-2">
						<Skeleton className="h-5 w-2/3" />
						<Skeleton className="h-24" />
					</div>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						Fermer
					</Button>
					{link !== null ? (
						<Button asChild>
							<Link to="/alerts" search={{ alert: link.alertNumber }} className="text-primary-foreground! no-underline">
								Ouvrir l'alerte
							</Link>
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
