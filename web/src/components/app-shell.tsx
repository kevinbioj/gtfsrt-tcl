import type { FeedClock } from "@dto";
import { Link, Outlet } from "@tanstack/react-router";
import { cn } from "cn";
import { MapPinnedIcon, RouteIcon, TriangleAlertIcon } from "lucide-react";

import tclLogo from "@/assets/tcl.png";
import { formatClock, formatDate } from "@/lib/format";
import { useStatus } from "@/lib/queries";

const NAV = [
	{ to: "/alerts", label: "Alertes de service", icon: TriangleAlertIcon, count: "uncheckedAlerts" },
	{ to: "/modifications", label: "Modifications", icon: RouteIcon, count: "modifications" },
	{ to: "/stops", label: "Arrêts provisoires", icon: MapPinnedIcon, count: "provisionalStops" },
] as const;

/** Un flux et l'heure à laquelle il a été réassemblé pour la dernière fois. */
function FeedLine({ label, clock }: { label: string; clock: FeedClock | undefined }) {
	const generatedAt = clock?.generatedAt ?? null;
	// Un flux réassemblé il y a plus de cinq minutes ne suit plus : le relevé s'est arrêté.
	const fresh = generatedAt !== null && Date.now() / 1000 - generatedAt < 300;
	return (
		<span className="flex items-center gap-2">
			<span
				aria-hidden="true"
				className={cn(
					"size-[7px] rounded-full",
					fresh ? "bg-success" : generatedAt === null ? "bg-neutral-dot" : "bg-warning-dot",
				)}
			/>
			<span className="flex-1">{label}</span>
			<span className="font-mono">{generatedAt === null ? "—" : formatClock(generatedAt)}</span>
		</span>
	);
}

/**
 * La charpente de l'interface : la navigation à gauche, avec ce que compte chaque section et l'état des
 * flux, et la page à droite. Sous 800 px environ, la navigation passe au-dessus.
 */
export function AppShell() {
	const { data: status } = useStatus();

	return (
		<div className="flex min-h-screen flex-wrap">
			<nav
				aria-label="Navigation principale"
				className="flex flex-[1_1_220px] flex-col gap-6 border-r bg-card px-3.5 py-5 md:sticky md:top-0 md:h-screen md:max-w-[260px]"
			>
				<div className="flex items-center gap-2.5 px-1.5">
					<img src={tclLogo} alt="TCL" className="size-8 flex-none object-contain" />
					<span className="flex flex-col">
						<span className="text-sm font-semibold">GTFS-RT TCL</span>
						<span className="text-xs text-muted-foreground">Gestion des perturbations</span>
					</span>
				</div>
				<div className="flex flex-col gap-0.5">
					{NAV.map((item) => (
						<Link
							key={item.to}
							to={item.to}
							className="flex min-h-11 items-center gap-2.5 rounded-md px-2.5 text-strong no-underline hover:bg-muted hover:text-foreground"
							activeProps={{ className: "bg-accent font-semibold text-accent-foreground! hover:bg-accent" }}
						>
							<item.icon aria-hidden="true" className="size-[18px]" strokeWidth={1.8} />
							<span className="flex-1">{item.label}</span>
							<span className="font-mono text-xs">{status?.counts[item.count] ?? ""}</span>
						</Link>
					))}
				</div>
				<div className="mt-auto flex flex-col gap-2 border-t px-1.5 pt-3.5 text-xs text-muted-foreground">
					<span className="font-semibold tracking-wider text-foreground uppercase">Flux GTFS-RT</span>
					<FeedLine label="Service Alerts" clock={status?.feeds.serviceAlerts} />
					<FeedLine label="Trip Modifications" clock={status?.feeds.tripModifications} />
					<FeedLine label="Trip Updates" clock={status?.feeds.tripUpdates} />
					<span>{status ? `GTFS théorique : chargé le ${formatDate(status.gtfsImportedAt)}` : " "}</span>
				</div>
			</nav>
			<main className="flex min-w-0 flex-[999_1_560px] flex-col">
				<Outlet />
			</main>
		</div>
	);
}
