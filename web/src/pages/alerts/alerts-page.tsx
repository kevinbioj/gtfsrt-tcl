import type { AlertDto } from "@dto";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { CircleCheckIcon, PlusIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { ChipFilter } from "@/components/chip-filter";
import { LineBadge, LineOption } from "@/components/line-badge";
import { FilterBar, PageHeader } from "@/components/page-header";
import { ALERT_PHASES, ALERT_PUBLICATIONS, StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { describePeriods, searchable } from "@/lib/format";
import { causeColor, causeLabel } from "@/lib/labels";
import { useAlerts, useModifications, useRoutes } from "@/lib/queries";
import { useSearchText } from "@/lib/search-text";
import { alertsRoute } from "@/router";

import { AlertDetail } from "./alert-detail";
import { blankAlert } from "./alert-form";

/** Où en est une alerte, pour la liste : en cours, à venir, ou terminée. */
export type AlertStatus = "current" | "planned" | "ended";

export const STATUSES: Record<AlertStatus, { label: string; color: string }> = {
	current: { label: "En cours", color: "#1D56C8" },
	planned: { label: "À venir", color: "#B54708" },
	ended: { label: "Terminées / supprimées", color: "#5B626A" },
};

/**
 * En cours : dans ses dates, fût-ce hors de ses heures. Terminée : échue, ou retirée du flux — elle n'y
 * reviendra pas, quelles que soient ses dates.
 */
function statusOf(alert: AlertDto): AlertStatus {
	if (alert.publication === "withdrawn" || alert.phase === "expired") return "ended";
	return alert.phase === "planned" ? "planned" : "current";
}

/** Une alerte reste-t-elle à traiter ? Créée à la main, elle n'a rien à vérifier : tout en est saisi. */
function isTodo(alert: AlertDto): boolean {
	return !alert.custom && alert.checkedAt === null;
}

/**
 * Les alertes de service : reçues du flux TCL, complétées à la main puis republiées — ou créées à la
 * main. La liste à gauche, filtrée par état, par cause et par ligne ; le détail de celle qu'on a
 * choisie à droite.
 */
export function AlertsPage() {
	const search = alertsRoute.useSearch();
	const { alert: selectedNumber, new: creating, todo, status = "ALL", cause = "ALL", line = "all" } = search;
	const navigate = useNavigate({ from: "/alerts" });
	const alerts = useAlerts();
	const modifications = useModifications();
	const routes = useRoutes();
	const filter = (change: Partial<typeof search>, replace = false) =>
		navigate({ search: (current) => ({ ...current, ...change }), replace });
	const [query, setQuery] = useSearchText(search.q ?? "", (q) => filter({ q: q || undefined }, true));

	const list = alerts.data ?? [];
	const causes = useMemo(() => {
		const counts = new Map<string, number>();
		for (const alert of list) {
			const key = alert.published.cause ?? "UNKNOWN_CAUSE";
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return [...counts].sort((a, b) => b[1] - a[1]);
	}, [list]);
	const statuses = (Object.keys(STATUSES) as AlertStatus[]).map(
		(key) => [key, list.filter((alert) => statusOf(alert) === key).length] as const,
	);
	// Les lignes que cite au moins une alerte, dans l'ordre du réseau.
	const lines = useMemo(() => {
		const cited = new Set(list.flatMap((alert) => alert.lines.map((entry) => entry.routeId)));
		return (routes.data ?? []).filter((route) => cited.has(route.routeId));
	}, [list, routes.data]);

	// Les alertes à traiter d'abord, les autres ensuite — chacune dans l'ordre du flux.
	const visible = list
		.filter((alert) => !todo || isTodo(alert))
		.sort((a, b) => Number(!isTodo(a)) - Number(!isTodo(b)))
		.filter(
			(alert) =>
				(status === "ALL" || statusOf(alert) === status) &&
				(cause === "ALL" || (alert.published.cause ?? "UNKNOWN_CAUSE") === cause) &&
				(line === "all" || alert.lines.some((entry) => entry.routeId === line)) &&
				(query.length === 0 ||
					searchable(
						[alert.alertNumber, alert.published.headerText, ...alert.lines.map((line) => line.line)].join(" "),
					).includes(searchable(query))),
		);
	// Une alerte à créer n'existe qu'ici, le temps de sa saisie : la quitter l'abandonne.
	const [blank] = useState(blankAlert);
	const selected = creating ? blank : (list.find((alert) => alert.alertNumber === selectedNumber) ?? visible[0]);

	return (
		<>
			<PageHeader title="Alertes de service">
				<InputGroup className="h-10 max-w-[300px] min-w-[180px] flex-[0_1_300px] bg-card">
					<InputGroupAddon>
						<SearchIcon />
					</InputGroupAddon>
					<InputGroupInput
						type="search"
						aria-label="Rechercher une alerte"
						placeholder="Alerte, ligne, numéro…"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</InputGroup>
				<NewAlertButton />
			</PageHeader>

			<FilterBar>
				<label className="flex items-center gap-2 text-[13px] font-medium text-strong">
					<Switch checked={todo === true} onCheckedChange={(on) => filter({ todo: on ? true : undefined })} />
					<span>À traiter</span>
					<span className="font-mono text-xs text-subtle">{list.filter(isTodo).length}</span>
				</label>
				<Separator orientation="vertical" className="h-6!" />
				<ChipFilter
					label="État"
					value={status}
					onChange={(next) => filter({ status: next === "ALL" ? undefined : (next as AlertStatus) })}
					total={list.length}
					options={statuses.map(([key, count]) => ({
						key,
						label: STATUSES[key].label,
						color: STATUSES[key].color,
						count,
					}))}
				/>
				<Separator orientation="vertical" className="h-6!" />
				<ChipFilter
					label="Cause"
					value={cause}
					onChange={(next) => filter({ cause: next === "ALL" ? undefined : next })}
					total={list.length}
					options={causes.map(([key, count]) => ({ key, label: causeLabel(key), color: causeColor(key), count }))}
				/>
				<Separator orientation="vertical" className="h-6!" />
				<label className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-strong">
					Ligne
					<Select value={line} onValueChange={(next) => filter({ line: next === "all" ? undefined : next })}>
						<SelectTrigger className="w-47 max-w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								<SelectItem value="all">Toutes les lignes</SelectItem>
								{lines.map((entry) => (
									<SelectItem key={entry.routeId} value={entry.routeId}>
										<LineOption route={entry} />
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</label>
			</FilterBar>

			<div className="flex flex-wrap items-start gap-5 px-6 pt-5 pb-10">
				<section
					aria-label="Liste des alertes"
					className="flex min-w-0 flex-[1_1_320px] flex-col gap-2 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:max-w-[420px] lg:overflow-y-auto lg:pr-1"
				>
					{creating ? <UnsavedCard /> : null}
					{alerts.isPending
						? [0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-28 rounded-lg" />)
						: visible.map((alert) => (
								<AlertCard
									key={alert.alertNumber}
									alert={alert}
									selected={alert.alertNumber === selected?.alertNumber}
								/>
							))}
					{!alerts.isPending && visible.length === 0 ? (
						<p className="m-0 rounded-lg border border-dashed border-input px-4 py-6 text-center text-muted-foreground">
							Aucune alerte pour ce filtre.
						</p>
					) : null}
				</section>

				<section aria-label="Détail de l'alerte" className="min-w-0 flex-[999_1_520px]">
					{selected ? (
						<AlertDetail key={selected.alertNumber} alert={selected} modifications={modifications.data ?? []} />
					) : alerts.isPending ? (
						<Skeleton className="h-96 rounded-lg" />
					) : (
						<Empty className="rounded-lg border bg-card">
							<EmptyHeader>
								<EmptyTitle>Aucune alerte</EmptyTitle>
								<EmptyDescription>
									Le flux TCL n'en porte aucune pour l'instant. « Nouvelle alerte » en crée une à la main.
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					)}
				</section>
			</div>
		</>
	);
}

/**
 * Ouvre une alerte à créer à la main : rien n'est créé avant son premier enregistrement, et la quitter
 * l'abandonne.
 */
function NewAlertButton() {
	const navigate = useNavigate({ from: "/alerts" });
	return (
		<Button size="lg" onClick={() => navigate({ search: (current) => ({ ...current, alert: undefined, new: true }) })}>
			<PlusIcon data-icon="inline-start" />
			Nouvelle alerte
		</Button>
	);
}

/** L'alerte en cours de création, en tête de liste tant qu'elle n'est pas enregistrée. */
function UnsavedCard() {
	return (
		<div
			aria-current="true"
			className="flex w-full flex-col gap-2 rounded-lg border border-[#B9CDF3] bg-[#F7F9FE] px-4 py-3.5 shadow-[inset_3px_0_0_#1D56C8]"
		>
			<span className="flex flex-wrap items-center gap-1.5">
				<StatusPill tone="inverse">Brouillon</StatusPill>
				<StatusPill tone="neutral">Personnalisée</StatusPill>
			</span>
			<span className="text-[15px] font-semibold text-foreground">Nouvelle alerte</span>
			<span className="text-xs text-muted-foreground">Non enregistrée : la quitter l'abandonne.</span>
		</div>
	);
}

function AlertCard({ alert, selected }: { alert: AlertDto; selected: boolean }) {
	const publication = ALERT_PUBLICATIONS[alert.publication];
	const phase = ALERT_PHASES[alert.phase];
	return (
		<Link
			from="/alerts"
			search={(current) => ({ ...current, alert: alert.alertNumber, new: undefined, all: undefined })}
			aria-current={selected ? "true" : undefined}
			className={cn(
				"flex w-full flex-col gap-2 rounded-lg border bg-card px-4 py-3.5 text-left text-foreground! no-underline",
				selected ? "border-[#B9CDF3] bg-[#F7F9FE] shadow-[inset_3px_0_0_#1D56C8]" : "hover:border-input",
				!alert.custom && alert.checkedAt !== null && !selected && "bg-muted opacity-75",
			)}
		>
			<span className="flex w-full items-center gap-2">
				<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
					<span
						className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold tracking-wider whitespace-nowrap uppercase"
						style={{ color: causeColor(alert.published.cause) }}
					>
						<span
							aria-hidden="true"
							className="size-2 flex-none rounded-full"
							style={{ background: causeColor(alert.published.cause) }}
						/>
						{causeLabel(alert.published.cause)}
					</span>
					<span className="font-mono text-[11px] whitespace-nowrap text-muted-foreground">N° {alert.alertNumber}</span>
				</span>
				{alert.checkedAt !== null ? (
					<span title="Traitée" className="ml-auto inline-flex flex-none text-success">
						<CircleCheckIcon aria-label="Traitée" className="size-4" />
					</span>
				) : null}
			</span>
			<span className="flex flex-wrap items-center gap-1.5">
				<StatusPill tone={phase.tone}>{phase.label}</StatusPill>
				<StatusPill tone={publication.tone}>{publication.label}</StatusPill>
				{alert.custom ? <StatusPill tone="neutral">Personnalisée</StatusPill> : null}
			</span>
			<span className="text-[15px] font-semibold text-foreground">{alert.published.headerText}</span>
			<span className="flex flex-wrap items-center gap-1.5">
				{alert.lines.slice(0, 8).map((line) => (
					<LineBadge key={line.routeId} line={line} />
				))}
				{alert.lines.length > 8 ? (
					<span className="text-xs text-muted-foreground">+{alert.lines.length - 8}</span>
				) : null}
				<span className="text-xs text-muted-foreground">{describePeriods(alert.periods)}</span>
			</span>
			{alert.warnings.length > 0 ? (
				<span className="inline-flex items-center gap-1.5 text-xs font-semibold text-warning-foreground">
					<TriangleAlertIcon aria-hidden="true" className="size-3.5" />À vérifier
				</span>
			) : null}
		</Link>
	);
}
