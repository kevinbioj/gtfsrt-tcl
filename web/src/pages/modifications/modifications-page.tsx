import type { LabelDto, ModificationState, ModificationSummaryDto } from "@dto";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { EllipsisIcon, PencilIcon, PlusIcon, SearchIcon, TagIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { ChipFilter } from "@/components/chip-filter";
import { DETOUR_KINDS, DetourGlyph } from "@/components/detour-glyph";
import { LineBadge, LineOption } from "@/components/line-badge";
import { FilterBar, PageHeader } from "@/components/page-header";
import { MODIFICATION_STATES, StatusPill } from "@/components/status-pill";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { modificationId, searchable } from "@/lib/format";
import { useBulk, useLabels, useModifications, useRoutes, useSetManual } from "@/lib/queries";
import { useSearchText } from "@/lib/search-text";

import { AlertChips } from "./alert-chips";
import { LabelMenuItems, LabelPill, NewLabelDialog } from "./labels";

export type ModificationTab = "all" | "published" | "planned" | "off";

export const TABS: { value: ModificationTab; label: string; states: ModificationState[] }[] = [
	{ value: "all", label: "Toutes", states: ["manual", "live", "planned", "off"] },
	{ value: "published", label: "Publiées", states: ["manual", "live"] },
	{ value: "planned", label: "Planifiées", states: ["planned"] },
	{ value: "off", label: "Non publiées", states: ["off"] },
];

/**
 * Ce qu'une recherche peut trouver d'une modification : son identifiant, ses arrêts, ses tracés, ses
 * alertes, ses étiquettes.
 */
function haystack(row: ModificationSummaryDto, labels: ReadonlyMap<number, LabelDto>): string {
	return searchable(
		[
			modificationId(row.uid),
			String(row.uid),
			row.description ?? "",
			row.line.line,
			...row.headsigns,
			row.fromStop ?? "",
			row.toStop ?? "",
			...row.patternLabels,
			...row.alerts.flatMap((alert) => [alert.alertNumber, alert.headerText]),
			...row.labelIds.map((labelId) => labels.get(labelId)?.name ?? ""),
		].join(" "),
	);
}

/**
 * Le tableau des modifications : chacune avec son état de publication, et l'interrupteur qui l'active
 * à la main. Une modification associée à une alerte est publiée pendant ses périodes ; activée à la
 * main, elle l'est jusqu'à ce qu'on la désactive.
 */
export function ModificationsPage() {
	const { data, isPending } = useModifications();
	const routes = useRoutes();
	const labelList = useLabels();
	const setManual = useSetManual();
	const bulk = useBulk();
	const search = useSearch({ from: "/modifications" });
	const { tab = "all", line = "all", label = "ALL" } = search;
	const navigate = useNavigate({ from: "/modifications" });
	const filter = (change: Partial<typeof search>, replace = false) =>
		navigate({ search: (current) => ({ ...current, ...change }), replace });
	const [query, setQuery] = useSearchText(search.q ?? "", (q) => filter({ q: q || undefined }, true));
	const [selected, setSelected] = useState<Set<number>>(new Set());
	/** Les modifications sur lesquelles poser l'étiquette qu'on crée ; `null` : rien en cours. */
	const [labelling, setLabelling] = useState<number[] | null>(null);

	const rows = data ?? [];
	const labels = useMemo(
		() => new Map((labelList.data ?? []).map((entry) => [entry.labelId, entry])),
		[labelList.data],
	);
	// Les lignes qui ont au moins une modification, dans l'ordre du réseau.
	const lines = useMemo(() => {
		const used = new Set(rows.map((row) => row.routeId));
		return (routes.data ?? []).filter((route) => used.has(route.routeId));
	}, [rows, routes.data]);
	// La ligne et la recherche d'abord : les étiquettes se comptent là-dessus, comme les onglets.
	const searched = rows.filter(
		(row) =>
			(line === "all" || row.routeId === line) &&
			(query.length === 0 || haystack(row, labels).includes(searchable(query))),
	);
	const labelOptions = [...labels.values()]
		.map((entry) => ({
			key: String(entry.labelId),
			label: entry.name,
			color: entry.color,
			count: searched.filter((row) => row.labelIds.includes(entry.labelId)).length,
		}))
		// Une étiquette que plus rien ne porte n'a rien à filtrer — sauf celle qu'on a choisie.
		.filter((option) => option.key === label || rows.some((row) => row.labelIds.includes(Number(option.key))));
	const unlabelled = searched.filter((row) => row.labelIds.length === 0).length;
	const filtered = searched.filter(
		(row) => label === "ALL" || (label === "none" ? row.labelIds.length === 0 : row.labelIds.includes(Number(label))),
	);
	const visible = filtered.filter((row) => TABS.find((entry) => entry.value === tab)?.states.includes(row.state));
	const count = (value: ModificationTab) =>
		filtered.filter((row) => TABS.find((entry) => entry.value === value)?.states.includes(row.state)).length;
	const chosenRows = visible.filter((row) => selected.has(row.uid));
	const chosen = chosenRows.map((row) => row.uid);

	const toggle = (row: ModificationSummaryDto) => {
		const next = !row.manual;
		setManual.mutate(
			{ uid: row.uid, active: next },
			{
				onSuccess: () => toast.success(`${modificationId(row.uid)} ${next ? "activée" : "désactivée"}.`),
			},
		);
	};

	const pick = (uid: number, on: boolean) =>
		setSelected((current) => {
			const next = new Set(current);
			if (on) next.add(uid);
			else next.delete(uid);
			return next;
		});

	return (
		<>
			<PageHeader title="Modifications">
				<InputGroup className="h-10 max-w-[280px] min-w-[180px] flex-[0_1_280px] bg-card">
					<InputGroupAddon>
						<SearchIcon />
					</InputGroupAddon>
					<InputGroupInput
						type="search"
						aria-label="Rechercher une modification"
						placeholder="Identifiant, arrêt, tracé…"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</InputGroup>
				<Button size="lg" asChild>
					<Link to="/modifications/new" className="text-primary-foreground! no-underline">
						<PlusIcon data-icon="inline-start" />
						Nouvelle modification
					</Link>
				</Button>
			</PageHeader>

			<FilterBar>
				<Tabs
					value={tab}
					onValueChange={(value) => filter({ tab: value === "all" ? undefined : (value as ModificationTab) })}
				>
					<TabsList aria-label="Filtrer par publication">
						{TABS.map((entry) => (
							<TabsTrigger key={entry.value} value={entry.value} className="gap-2">
								{entry.label}
								<span className="font-mono text-xs text-subtle">{count(entry.value)}</span>
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
				<label className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-strong">
					Ligne
					<Select value={line} onValueChange={(next) => filter({ line: next === "all" ? undefined : next })}>
						<SelectTrigger className="w-64 max-w-full">
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
				{labelOptions.length > 0 ? (
					<>
						<Separator orientation="vertical" className="h-6!" />
						<ChipFilter
							label="Étiquette"
							value={label}
							onChange={(next) => filter({ label: next === "ALL" ? undefined : next })}
							total={searched.length}
							options={[...labelOptions, { key: "none", label: "Sans étiquette", color: "#667085", count: unlabelled }]}
						/>
					</>
				) : null}
				{chosen.length > 0 ? (
					<div className="ml-auto flex flex-wrap items-center gap-2">
						<span className="text-[13px] text-subtle">{chosen.length} sélectionnée(s)</span>
						<Button variant="outline" onClick={() => bulk.mutate({ action: "activate", uids: chosen })}>
							Activer
						</Button>
						<Button variant="outline" onClick={() => bulk.mutate({ action: "deactivate", uids: chosen })}>
							Désactiver
						</Button>
						<DropdownMenu modal={false}>
							<DropdownMenuTrigger asChild>
								<Button variant="outline">
									<TagIcon data-icon="inline-start" />
									Étiqueter
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-60">
								<LabelMenuItems
									labels={labelList.data ?? []}
									targets={chosenRows}
									onCreate={() => setLabelling(chosen)}
								/>
							</DropdownMenuContent>
						</DropdownMenu>
						<AlertDialog>
							<AlertDialogTrigger asChild>
								<Button variant="destructive">Supprimer</Button>
							</AlertDialogTrigger>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>Supprimer {chosen.length} modification(s) ?</AlertDialogTitle>
									<AlertDialogDescription>
										Leurs tracés et leurs associations aux alertes disparaissent. Cela ne se défait pas.
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel>Annuler</AlertDialogCancel>
									<AlertDialogAction
										variant="destructive"
										onClick={() =>
											bulk.mutate({ action: "delete", uids: chosen }, { onSuccess: () => setSelected(new Set()) })
										}
									>
										Supprimer
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					</div>
				) : null}
			</FilterBar>

			<div className="flex flex-col gap-3.5 px-6 pt-5 pb-10">
				<div className="overflow-x-auto rounded-lg border bg-card">
					<Table className="min-w-[1140px]">
						<TableHeader className="bg-muted">
							<TableRow>
								<TableHead className="w-10">
									<Checkbox
										aria-label="Tout sélectionner"
										checked={visible.length > 0 && chosen.length === visible.length}
										onCheckedChange={(on) =>
											setSelected(on === true ? new Set(visible.map((row) => row.uid)) : new Set())
										}
									/>
								</TableHead>
								{["Manuelle", "Id", "Ligne · tracés", "Arrêts modifiés", "Tracé", "Alertes", "Publication", ""].map(
									(label) => (
										<TableHead key={label} className="text-xs font-semibold tracking-wider text-subtle uppercase">
											{label}
										</TableHead>
									),
								)}
							</TableRow>
						</TableHeader>
						<TableBody>
							{isPending
								? [0, 1, 2].map((index) => (
										<TableRow key={index}>
											<TableCell colSpan={9}>
												<Skeleton className="h-10" />
											</TableCell>
										</TableRow>
									))
								: visible.map((row) => (
										<ModificationRow
											key={row.uid}
											row={row}
											checked={selected.has(row.uid)}
											onCheck={(on) => pick(row.uid, on)}
											onToggle={() => toggle(row)}
											labels={labels}
											onCreateLabel={() => setLabelling([row.uid])}
										/>
									))}
							{!isPending && visible.length === 0 ? (
								<TableRow>
									<TableCell colSpan={9} className="py-7 text-center text-muted-foreground">
										Aucune modification dans cet état.
									</TableCell>
								</TableRow>
							) : null}
						</TableBody>
					</Table>
				</div>
			</div>

			<NewLabelDialog uids={labelling} onClose={() => setLabelling(null)} />
		</>
	);
}

function ModificationRow({
	row,
	checked,
	onCheck,
	onToggle,
	labels,
	onCreateLabel,
}: {
	row: ModificationSummaryDto;
	checked: boolean;
	onCheck: (on: boolean) => void;
	onToggle: () => void;
	labels: ReadonlyMap<number, LabelDto>;
	onCreateLabel: () => void;
}) {
	const state = MODIFICATION_STATES[row.state];
	const carried = row.labelIds.flatMap((labelId) => labels.get(labelId) ?? []);
	return (
		<TableRow className={cn("align-middle", row.manual && "bg-[#F7F9FE]")}>
			<TableCell>
				<Checkbox
					aria-label={`Sélectionner ${modificationId(row.uid)}`}
					checked={checked}
					onCheckedChange={(on) => onCheck(on === true)}
				/>
			</TableCell>
			<TableCell>
				{row.draft && !row.manual ? (
					// Un interrupteur désactivé ne reçoit pas le survol : c'est son enveloppe qui porte l'infobulle.
					<Tooltip>
						<TooltipTrigger asChild>
							<span className="inline-flex">
								<Switch aria-label={`Activation manuelle de ${modificationId(row.uid)}`} checked={false} disabled />
							</span>
						</TooltipTrigger>
						<TooltipContent>Brouillon : dessinez un tracé ou supprimez un arrêt avant de l'activer.</TooltipContent>
					</Tooltip>
				) : (
					<Switch
						aria-label={`Activation manuelle de ${modificationId(row.uid)}`}
						checked={row.manual}
						onCheckedChange={onToggle}
					/>
				)}
			</TableCell>
			<TableCell>
				<span className="flex flex-col items-start gap-1">
					<span className="font-mono text-[13px] font-semibold">{modificationId(row.uid)}</span>
					{carried.map((entry) => (
						<LabelPill key={entry.labelId} label={entry} className="max-w-[140px]" />
					))}
				</span>
			</TableCell>
			<TableCell className="whitespace-normal">
				<span className="flex min-w-0 items-start gap-2.5">
					<LineBadge line={row.line} />
					<span className="flex min-w-0 flex-col gap-0.5">
						<span className="text-[13px] font-medium">→ {row.headsigns.join(" / ")}</span>
						{row.description ? <span className="text-[13px] text-subtle">{row.description}</span> : null}
						{row.allPatterns ? (
							<span className="text-xs text-subtle">Tous les tracés ({row.patternLabels.length})</span>
						) : (
							row.patternLabels.map((label) => (
								<span key={label} className="text-xs text-subtle">
									{label}
								</span>
							))
						)}
					</span>
				</span>
			</TableCell>
			<TableCell className="whitespace-normal">
				{row.fromStop === null ? (
					<span className="text-[13px] text-muted-foreground">—</span>
				) : (
					<span className="flex flex-col gap-0.5 text-[13px]">
						<span>{row.fromStop}</span>
						<span>→ {row.toStop}</span>
						{row.segmentCount > 1 ? <span className="text-xs text-subtle">{row.segmentCount} tronçons</span> : null}
					</span>
				)}
			</TableCell>
			<TableCell>
				<span className="inline-flex items-center gap-2 text-[13px]">
					<DetourGlyph kind={row.kind} />
					{DETOUR_KINDS[row.kind].label}
				</span>
			</TableCell>
			<TableCell className="whitespace-normal">
				<AlertChips alerts={row.alerts} />
			</TableCell>
			<TableCell className="whitespace-normal">
				<span className="flex flex-col items-start gap-1">
					<StatusPill tone={state.tone}>{state.label}</StatusPill>
					<span className="text-xs text-subtle">{row.stateDetail}</span>
				</span>
			</TableCell>
			<TableCell>
				<span className="flex items-center">
					<Button variant="ghost" size="icon-lg" asChild>
						<Link
							to="/modifications/$uid"
							params={{ uid: String(row.uid) }}
							aria-label={`Éditer ${modificationId(row.uid)}`}
						>
							<PencilIcon />
						</Link>
					</Button>
					<DropdownMenu modal={false}>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon-lg" aria-label={`Actions sur ${modificationId(row.uid)}`}>
								<EllipsisIcon />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-60">
							<LabelMenuItems labels={[...labels.values()]} targets={[row]} onCreate={onCreateLabel} />
						</DropdownMenuContent>
					</DropdownMenu>
				</span>
			</TableCell>
		</TableRow>
	);
}
