import type { AllStopsDto, ModificationDetailDto } from "@dto";
import { useQuery } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import {
	ArrowDownIcon,
	ArrowUpIcon,
	CheckIcon,
	EllipsisIcon,
	MapPinPlusIcon,
	PlusIcon,
	SearchIcon,
	Trash2Icon,
	TriangleAlertIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { LineBadge } from "@/components/line-badge";
import { SectionCard, SpecName } from "@/components/section-card";
import { MODIFICATION_STATES, StatusPill } from "@/components/status-pill";
import { TripSetDialog, TripSetList } from "@/components/trip-sets";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { formatDuration, formatLength, modificationId, parseDuration, plural, searchable } from "@/lib/format";
import { type LatLng, lengthOf, project } from "@/lib/geometry";
import {
	useAllStops,
	useDeleteModification,
	useModification,
	useSaveModification,
	useSaveProvisionalStop,
	useSetManual,
	useStatus,
} from "@/lib/queries";

import { EditorMap, type MapMode } from "./editor-map";
import {
	geometryOf,
	inputOf,
	nominalTravel,
	pathOf,
	rangeStops,
	readSegment,
	referenceOf,
	routeStops,
	stateOf,
} from "./editor-state";
import { NewModification } from "./new-modification";
import { useEditor } from "./use-editor";

/** L'éditeur d'une modification, ou le formulaire qui en crée une. */
export function ModificationEditorPage({ uid, alert }: { uid: number | null; alert: string | null }) {
	const detail = useModification(uid);
	if (uid === null) return <NewModification alert={alert} />;
	if (detail.isPending) {
		return (
			<div className="flex flex-col gap-4 p-6">
				<Skeleton className="h-16" />
				<Skeleton className="h-[600px]" />
			</div>
		);
	}
	if (detail.isError || detail.data === undefined) {
		return (
			<Empty className="m-6 rounded-lg border bg-card">
				<EmptyHeader>
					<EmptyTitle>Modification introuvable</EmptyTitle>
					<EmptyDescription>Elle a pu être supprimée depuis.</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button variant="outline" asChild>
						<Link to="/modifications">Retour aux modifications</Link>
					</Button>
				</EmptyContent>
			</Empty>
		);
	}
	return <Editor detail={detail.data} alert={alert} />;
}

/**
 * L'éditeur d'une modification. Ouvert depuis une info trafic (`alert`), il y ramène à
 * l'enregistrement, comme à l'abandon.
 */
function Editor({ detail, alert }: { detail: ModificationDetailDto; alert: string | null }) {
	const navigate = useNavigate();
	const search = useSearch({ from: "/modifications/$uid" });
	const geometry = useMemo(() => geometryOf(detail), [detail]);
	const editor = useEditor(detail, geometry, (search.segment ?? 1) - 1);
	const { state, patterns, active } = editor;

	// Le tronçon actif se lit dans l'URL, sans ajouter d'étape à l'historique.
	const segment = state.active + 1;
	useEffect(() => {
		if ((search.segment ?? 1) !== segment)
			navigate({
				to: "/modifications/$uid",
				params: { uid: String(detail.uid) },
				search: (current) => ({ ...current, segment: segment > 1 ? segment : undefined }),
				replace: true,
			});
	}, [segment, search.segment, detail.uid, navigate]);
	const status = useStatus();
	const roadRouting = status.data?.roadRouting ?? false;
	const [pen, setPen] = useState<"route" | "free">("free");
	const [mode, setMode] = useState<MapMode>("draw");
	const [placing, setPlacing] = useState<LatLng | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [base, setBase] = useState(detail);

	// L'accrochage aux rues est ce qu'on veut presque toujours, dès que le graphe est là.
	useEffect(() => {
		if (roadRouting) setPen("route");
	}, [roadRouting]);

	const save = useSaveModification(detail.uid);
	const remove = useDeleteModification();
	const setManual = useSetManual();
	const allStops = useAllStops();

	const total = detail.patterns.length;
	const baseline = useMemo(() => {
		const initial = stateOf(base, geometryOf(base));
		const initialPatterns = base.patterns.filter((pattern) => initial.patternIds.includes(pattern.patternId));
		return JSON.stringify(inputOf(initial, initialPatterns, base.patterns.length));
	}, [base]);
	const input = inputOf(state, patterns, total);
	const dirty = JSON.stringify(input) !== baseline;
	useBlocker({
		// Rester sur la modification — changer de tronçon — ne perd rien.
		shouldBlockFn: ({ current, next }) =>
			dirty &&
			next.pathname !== current.pathname &&
			!window.confirm("Des changements de cette modification ne sont pas enregistrés. Les abandonner ?"),
		enableBeforeUnload: () => dirty,
	});

	const reading = readSegment(active, patterns, geometry);
	const path = pathOf(active);
	const skipped = new Set([
		...state.extraRemoved,
		...state.segments.flatMap((segment) => (segment.removes ? rangeStops(segment, patterns) : [])),
	]);
	const reference = referenceOf(active, patterns);
	const stops = routeStops(patterns);
	const nameOf = (stopId: string | null) =>
		stopId === null ? null : (stops.find((stop) => stop.stopId === stopId)?.name ?? stopId);
	const activeRange = active.removes ? rangeStops(active, patterns) : [];

	const tripCount = useQuery({
		queryKey: ["trip-count", detail.routeId, detail.directionId, active.startStopId, active.endStopId],
		queryFn: () =>
			api<{ tripsByPattern: Record<string, number> }>(
				`/trip-count?routeId=${encodeURIComponent(detail.routeId)}&directionId=${detail.directionId}&start=${encodeURIComponent(active.startStopId ?? "")}&end=${encodeURIComponent(active.endStopId ?? "")}`,
			),
		enabled: active.startStopId !== null,
	});
	const trips = state.patternIds.reduce((sum, patternId) => sum + (tripCount.data?.tripsByPattern[patternId] ?? 0), 0);

	const submit = () => {
		if (state.patternIds.length === 0) {
			toast.error("Cochez au moins un tracé.");
			return;
		}
		save.mutate(input, {
			onSuccess: (saved) => {
				setBase(saved);
				editor.reset(saved);
				const blocking = saved.segments.findIndex((segment) => !segment.publishable);
				if (blocking === -1) toast.success(saved.segmentCount === 0 ? "Enregistré, sans tronçon." : "Enregistré.");
				else
					toast.warning(
						`Enregistré. Le tronçon ${blocking + 1} ne sera pas publié : bornes, arrêts ou tracé manquants.`,
					);
				if (alert !== null) navigate({ to: "/alerts", search: { alert }, ignoreBlocker: true });
			},
		});
	};

	const onMapClick = (point: LatLng, onShape = false) => {
		if (mode === "place") setPlacing(point);
		else if (mode === "draw") editor.addWaypoint(point, pen, onShape);
	};

	const pickStop = ([stopId, name, latitude, longitude, provisional]: AllStopsDto[number]) => {
		editor.addStop({ stopId, name, latitude, longitude, provisional });
		setMode("draw");
	};

	const state_ = MODIFICATION_STATES[detail.state];
	const hint = mode === "place" ? "Cliquez où poser l'arrêt provisoire." : mode === "pick" ? "Cliquez un arrêt." : null;

	return (
		<>
			<header className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b bg-card px-6 py-3.5">
				<div className="flex min-w-0 flex-[1_1_360px] flex-col gap-1">
					<span className="flex flex-wrap gap-1.5 text-[13px] text-muted-foreground">
						{alert !== null ? (
							<Link to="/alerts" search={{ alert }}>
								Alerte {alert}
							</Link>
						) : (
							<Link to="/modifications">Modifications</Link>
						)}
						<span aria-hidden="true">/</span>
						<span className="font-mono">{modificationId(detail.uid)}</span>
					</span>
					<span className="flex flex-wrap items-center gap-2.5">
						<LineBadge line={detail.line} size="lg" />
						<h1 className="m-0 text-xl font-semibold tracking-tight">
							Direction {detail.headsigns.join(" / ")}
							{state.description.trim() ? ` · ${state.description.trim()}` : ""}
						</h1>
						<StatusPill tone={state_.tone}>{state_.label}</StatusPill>
						{dirty ? <Badge variant="outline">Non enregistrée</Badge> : null}
					</span>
					<span className="text-[13px] text-subtle">
						{detail.alerts.length > 0 ? (
							<>
								Publiée avec l'alerte{" "}
								{detail.alerts.map((alert, index) => (
									<span key={alert.alertNumber}>
										{index > 0 ? ", " : ""}
										<Link to="/alerts" search={{ alert: alert.alertNumber }}>
											{alert.headerText}
										</Link>
										{alert.periodsOverridden ? " (périodes propres)" : null}
									</span>
								))}{" "}
								· {detail.stateDetail}
							</>
						) : (
							detail.stateDetail
						)}
					</span>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<label className="mr-2 flex items-center gap-2 text-[13px] font-medium text-strong">
						<Switch
							checked={detail.manual}
							disabled={setManual.isPending || (detail.draft && !detail.manual)}
							onCheckedChange={(on) => setManual.mutate({ uid: detail.uid, active: on })}
						/>
						Activée à la main
					</label>
					{dirty ? (
						<Button variant="outline" size="lg" onClick={() => editor.reset(base)}>
							Annuler
						</Button>
					) : (
						<Button variant="outline" size="lg" asChild>
							{alert !== null ? (
								<Link to="/alerts" search={{ alert }} className="text-foreground! no-underline">
									Annuler
								</Link>
							) : (
								<Link to="/modifications" className="text-foreground! no-underline">
									Annuler
								</Link>
							)}
						</Button>
					)}
					<Button size="lg" disabled={!dirty || save.isPending} onClick={submit}>
						Enregistrer
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon-lg" aria-label="Plus d'actions">
								<EllipsisIcon />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuGroup>
								<DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
									<Trash2Icon />
									Supprimer la modification
								</DropdownMenuItem>
							</DropdownMenuGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</header>

			<div className="flex flex-wrap items-start gap-5 px-6 pt-5 pb-10">
				<section aria-label="Paramètres de la modification" className="flex min-w-0 flex-[1_1_340px] flex-col gap-4">
					<SectionCard number="01" title="Ligne et tracés">
						<div className="flex flex-col gap-1 rounded-md border border-[#E2E5E1] bg-muted px-3 py-2.5 text-[13px]">
							<span className="flex items-center gap-2">
								<LineBadge line={detail.line} />
								<span className="font-semibold">Ligne {detail.line.line}</span>
								<span className="ml-auto font-mono text-xs text-subtle">direction_id {detail.directionId}</span>
							</span>
							<span className="text-subtle">→ {detail.headsigns.join(" / ")}</span>
						</div>
						<fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
							<legend className="pb-1.5 text-[13px] font-medium text-strong">Tracés de cette direction</legend>
							{detail.patterns.map((pattern) => {
								const on = state.patternIds.includes(pattern.patternId);
								return (
									<label
										key={pattern.patternId}
										className={cn(
											"flex items-start gap-2.5 rounded-md border px-3 py-2.5",
											on ? "border-[#B9CDF3] bg-[#F7F9FE]" : "bg-card",
										)}
									>
										<Checkbox
											className="mt-0.5"
											checked={on}
											onCheckedChange={(checked) => editor.togglePattern(pattern.patternId, checked === true)}
										/>
										<span className="flex min-w-0 flex-col gap-0.5">
											<span className="text-sm font-medium">{pattern.label}</span>
											<span className="text-xs text-subtle">
												{plural(pattern.stopCount, "arrêt")} · {plural(pattern.tripsPerDay, "course")} par jour ouvré
											</span>
										</span>
									</label>
								);
							})}
						</fieldset>
					</SectionCard>

					<SectionCard number="02" title="Réglages">
						<FieldGroup className="gap-3">
							<Field className="gap-1.5">
								<FieldLabel htmlFor="description">Description</FieldLabel>
								<Input
									id="description"
									maxLength={80}
									placeholder="ex. déviation par cours Lafayette"
									value={state.description}
									onChange={(event) => editor.patch({ description: event.target.value })}
								/>
							</Field>
							<Field className="gap-1.5">
								<FieldLabel htmlFor="priority">Priorité</FieldLabel>
								<Input
									id="priority"
									type="number"
									step={1}
									className="max-w-32"
									value={state.priority}
									onChange={(event) => editor.patch({ priority: Math.trunc(Number(event.target.value) || 0) })}
								/>
							</Field>
						</FieldGroup>
						{detail.overrides.length + detail.overriddenBy.length > 0 ? (
							<div className="flex flex-col gap-1.5 border-t border-divider pt-3 text-[13px]">
								{detail.overriddenBy.map((other) => (
									<span key={other.uid}>
										Écrasée par{" "}
										<Link to="/modifications/$uid" params={{ uid: String(other.uid) }}>
											{modificationId(other.uid)}
										</Link>{" "}
										(priorité {other.priority}) là où leurs tronçons se recouvrent.
									</span>
								))}
								{detail.overrides.map((other) => (
									<span key={other.uid}>
										L'emporte sur{" "}
										<Link to="/modifications/$uid" params={{ uid: String(other.uid) }}>
											{modificationId(other.uid)}
										</Link>{" "}
										(priorité {other.priority}).
									</span>
								))}
							</div>
						) : null}
					</SectionCard>

					<SectionCard
						number="03"
						title="Arrêts de début et de fin"
						hint={state.segments.length > 1 ? `tronçon ${state.active + 1}` : undefined}
					>
						<div className="grid grid-cols-[repeat(auto-fit,minmax(min(140px,100%),1fr))] gap-2.5">
							<Field className="gap-1.5">
								<FieldLabel htmlFor="start-stop" className="flex-col items-start gap-0">
									Premier arrêt modifié <SpecName>start_stop_selector</SpecName>
								</FieldLabel>
								<Select
									value={active.startStopId ?? "none"}
									onValueChange={(value) => editor.setBounds({ startStopId: value === "none" ? null : value })}
								>
									<SelectTrigger id="start-stop" className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											<SelectItem value="none">— choisir —</SelectItem>
											{stops.map((stop) => (
												<SelectItem key={stop.stopId} value={stop.stopId}>
													{stop.name}
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
							</Field>
							<Field className="gap-1.5">
								<FieldLabel htmlFor="end-stop" className="flex-col items-start gap-0">
									Dernier arrêt modifié <SpecName>end_stop_selector</SpecName>
								</FieldLabel>
								<Select
									value={active.endStopId ?? "none"}
									onValueChange={(value) => editor.setBounds({ endStopId: value === "none" ? null : value })}
								>
									<SelectTrigger id="end-stop" className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											<SelectItem value="none">— jusqu'au terminus —</SelectItem>
											{stops.map((stop) => (
												<SelectItem key={stop.stopId} value={stop.stopId}>
													{stop.name}
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
							</Field>
						</div>
						<label className="flex items-center gap-2 text-[13px] font-medium text-strong">
							<Checkbox
								checked={active.removes}
								disabled={active.endStopId === null}
								onCheckedChange={(on) => editor.setBounds({ removes: on === true })}
							/>
							Arrêts de la plage supprimés
						</label>
						<div className="flex flex-col gap-1 rounded-md border border-[#E2E5E1] bg-muted px-3 py-2.5 text-[13px]">
							<span className="flex justify-between gap-2.5">
								<span className="text-subtle">Arrêt de référence</span>
								<strong className="font-semibold">
									{active.startStopId === null ? "—" : (reference?.name ?? "premier arrêt de la course")}
								</strong>
							</span>
							<span className="flex justify-between gap-2.5">
								<span className="text-subtle">Non desservis</span>
								<span className="text-right">
									{activeRange.length > 0
										? activeRange.map((stopId) => nameOf(stopId)).join(", ")
										: active.startStopId === null
											? "aucun (tracé incomplet)"
											: "aucun : le chemin seul change"}
								</span>
							</span>
							<span className="flex justify-between gap-2.5">
								<span className="text-subtle">Courses concernées</span>
								<span>
									{active.startStopId === null ? "—" : tripCount.isPending ? "…" : `${trips} sur les tracés cochés`}
								</span>
							</span>
							{active.boundsOverridden ? (
								<Button variant="link" className="h-8 self-start px-0" onClick={editor.resetBounds}>
									Reprendre les arrêts déduits du tracé
								</Button>
							) : null}
						</div>
						{state.extraRemoved.length > 0 ? (
							<div className="flex flex-col gap-1.5 text-[13px]">
								<span className="text-subtle">Autres arrêts supprimés :</span>
								<span className="flex flex-wrap gap-1.5">
									{state.extraRemoved.map((stopId) => (
										<Badge key={stopId} variant="secondary" className="gap-1">
											{nameOf(stopId)}
											<button
												type="button"
												aria-label={`Desservir ${nameOf(stopId)}`}
												onClick={() =>
													editor.patch({ extraRemoved: state.extraRemoved.filter((other) => other !== stopId) })
												}
											>
												<XIcon />
											</button>
										</Badge>
									))}
								</span>
							</div>
						) : null}
					</SectionCard>

					<SectionCard number="04" title="Tracé dévié">
						<Checks reading={reading} terminus={active.terminus} />
						{active.legs.some((leg) => leg.status === "failed") ? (
							<div className="flex items-center gap-2 rounded-md bg-warning px-3 py-2 text-[13px] text-warning-foreground">
								<TriangleAlertIcon aria-hidden="true" className="size-4 flex-none" />
								<span className="flex-1">Une jambe n'a pas pu suivre les rues.</span>
								<Button variant="outline" size="sm" onClick={editor.straighten}>
									Tout en lignes droites
								</Button>
							</div>
						) : null}
						<div className="grid grid-cols-3 gap-2">
							{[
								["Points", String(active.waypoints.length)],
								["Tracé dévié", formatLength(lengthOf(path))],
								["Nominal évité", reading === null ? "—" : formatLength(reading.joins - reading.leaves)],
							].map(([label, value]) => (
								<span key={label} className="flex flex-col gap-0.5 rounded-md bg-muted p-2.5">
									<span className="text-xs text-subtle">{label}</span>
									<span className="font-mono text-[15px] font-semibold">{value}</span>
								</span>
							))}
						</div>
						{state.segments.length > 1 ? (
							<Button variant="outline" className="self-start" onClick={() => editor.removeSegment(state.active)}>
								<Trash2Icon data-icon="inline-start" />
								Supprimer le tronçon {state.active + 1}
							</Button>
						) : null}
					</SectionCard>

					<ReplacementStops
						editor={editor}
						nominal={nominalTravel(active, patterns)}
						path={path}
						allStops={allStops.data ?? null}
						picking={mode === "pick"}
						onPicking={(on) => setMode(on ? "pick" : "draw")}
						onPlace={() => setMode("place")}
					/>

					<SectionCard
						number="06"
						title="Courses supprimées"
						hint={plural(state.tripSets.filter((set) => set.enabled).length, "ensemble actif", "ensembles actifs")}
						actions={
							<TripSetDialog
								source={`/modifications/${detail.uid}`}
								lines={[detail.line]}
								scope={{ routeId: detail.routeId, directionId: detail.directionId, patternIds: state.patternIds }}
								onAdd={(set) => editor.patch({ tripSets: [...state.tripSets, set] })}
							/>
						}
					>
						<p className="m-0 text-[13px] text-subtle">
							Annulées sur les tracés cochés, chaque jour où la modification vaut — avec ses infos trafic, ou activée à
							la main.
						</p>
						<TripSetList sets={state.tripSets} withLine={false} onChange={(tripSets) => editor.patch({ tripSets })} />
					</SectionCard>
				</section>

				<EditorMap
					patterns={patterns}
					allPatterns={detail.patterns}
					geometry={geometry}
					segments={state.segments}
					active={state.active}
					reading={reading}
					skipped={skipped}
					referenceStopId={reference?.stopId ?? null}
					mode={mode}
					pen={pen}
					roadRouting={roadRouting}
					pickable={mode === "pick" ? (allStops.data ?? null) : null}
					fitToken={String(detail.uid)}
					onMapClick={onMapClick}
					onPen={setPen}
					onTerminus={editor.setTerminus}
					onSelectSegment={editor.selectSegment}
					onAddSegment={editor.addSegment}
					onRemoveSegment={editor.removeSegment}
					onUndo={editor.undo}
					onClear={editor.clear}
					onMoveWaypoint={(index, point, onShape) => editor.moveWaypoint(index, point, onShape)}
					onRemoveWaypoint={editor.removeWaypoint}
					onPickStop={pickStop}
					hint={hint}
				/>
			</div>

			<PlaceProvisionalStop
				point={placing}
				onClose={() => {
					setPlacing(null);
					setMode("draw");
				}}
				onCreated={(stop) => {
					editor.addStop({ ...stop, provisional: true });
					setPlacing(null);
					setMode("draw");
				}}
			/>

			<AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Supprimer {modificationId(detail.uid)} ?</AlertDialogTitle>
						<AlertDialogDescription>
							Ses tronçons et ses associations aux alertes disparaissent. Cela ne se défait pas.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Annuler</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() =>
								remove.mutate(detail.uid, {
									onSuccess: () => {
										setBase(detail);
										editor.reset(detail);
										navigate({ to: "/modifications", ignoreBlocker: true });
									},
								})
							}
						>
							Supprimer
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

/** Ce que le dessin respecte, ou non, pour le type de tracé choisi. */
function Checks({ reading, terminus }: { reading: ReturnType<typeof readSegment>; terminus: "start" | "end" | null }) {
	const checks: [boolean, string][] =
		terminus === "start"
			? [
					[reading !== null, "Un nouveau terminus de départ est posé"],
					[reading?.joinsOnRoute ?? false, "Le tracé rejoint le tracé nominal"],
				]
			: terminus === "end"
				? [
						[reading?.leavesOnRoute ?? false, "Le tracé quitte le tracé nominal"],
						[reading !== null, "Un nouveau terminus d'arrivée est posé"],
					]
				: [
						[reading?.leavesOnRoute ?? false, "Le tracé part du tracé nominal"],
						[reading?.joinsOnRoute ?? false, "Le tracé revient sur le tracé nominal"],
					];
	return (
		<div className="flex flex-col gap-2">
			{checks.map(([ok, label]) => (
				<span
					key={label}
					className={cn("flex items-center gap-2.5 text-[13px]", ok ? "text-foreground" : "text-warning-foreground")}
				>
					<span
						className={cn(
							"inline-flex size-5 flex-none items-center justify-center rounded-full text-xs font-bold text-white",
							ok ? "bg-primary" : "bg-[#C2620C]",
						)}
					>
						{ok ? <CheckIcon className="size-3" /> : "!"}
					</span>
					{label}
				</span>
			))}
		</div>
	);
}

/** Un temps de parcours, saisi en « m:ss » et relu à la sortie du champ. */
function TravelTimeInput({
	id,
	value,
	label,
	onChange,
}: {
	id?: string;
	value: number;
	label: string;
	onChange: (seconds: number) => void;
}) {
	const [text, setText] = useState(formatDuration(value));
	useEffect(() => setText(formatDuration(value)), [value]);
	return (
		<Input
			id={id}
			inputMode="numeric"
			aria-label={label}
			className="h-8 w-14 px-2 text-right font-mono text-[13px]"
			value={text}
			onChange={(event) => setText(event.target.value)}
			onBlur={() => {
				const seconds = parseDuration(text);
				if (seconds === null) setText(formatDuration(value));
				else onChange(seconds);
			}}
		/>
	);
}

function ReplacementStops({
	editor,
	nominal,
	path,
	allStops,
	picking,
	onPicking,
	onPlace,
}: {
	editor: ReturnType<typeof useEditor>;
	nominal: ReturnType<typeof nominalTravel>;
	path: LatLng[];
	allStops: AllStopsDto | null;
	picking: boolean;
	onPicking: (on: boolean) => void;
	onPlace: () => void;
}) {
	const [query, setQuery] = useState("");
	const chosen = editor.active.stops;
	const suggestions = useMemo(() => {
		if (allStops === null) return [];
		const taken = new Set(chosen.map((stop) => stop.stopId));
		const text = searchable(query);
		return allStops
			.filter(([stopId, name]) => !taken.has(stopId) && (text.length === 0 || searchable(name).includes(text)))
			.map((stop) => ({ stop, distance: path.length >= 2 ? project(path, [stop[2], stop[3]]).offset : Number.NaN }))
			.sort((a, b) => (Number.isNaN(a.distance) ? 0 : a.distance - b.distance))
			.slice(0, 8);
	}, [allStops, chosen, query, path]);

	return (
		<SectionCard
			number="05"
			title="Arrêts de remplacement"
			actions={
				<Button variant="outline" aria-expanded={picking} onClick={() => onPicking(!picking)}>
					<PlusIcon data-icon="inline-start" />
					{picking ? "Fermer" : "Ajouter"}
				</Button>
			}
		>
			{picking ? (
				<div className="flex flex-col gap-1.5 rounded-md border border-[#E2E5E1] bg-muted p-2.5">
					<InputGroup className="bg-card">
						<InputGroupAddon>
							<SearchIcon />
						</InputGroupAddon>
						<InputGroupInput
							type="search"
							aria-label="Rechercher un arrêt"
							placeholder="Arrêt nominal ou provisoire…"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</InputGroup>
					{suggestions.map(({ stop, distance }) => {
						const [stopId, name, latitude, longitude, provisional] = stop;
						return (
							<button
								key={stopId}
								type="button"
								onClick={() => {
									editor.addStop({ stopId, name, latitude, longitude, provisional });
									onPicking(false);
								}}
								className="flex min-h-11 items-center gap-2.5 rounded-md border bg-card px-2.5 py-1.5 text-left hover:border-input"
							>
								<StopGlyph provisional={provisional} />
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="font-medium">{name}</span>
									<span className="text-xs text-subtle">{stopId}</span>
								</span>
								<span className="font-mono text-xs text-strong">
									{Number.isNaN(distance) ? "" : `à ${formatLength(Math.max(distance, 5))}`}
								</span>
							</button>
						);
					})}
					<Button variant="link" className="self-start px-0.5" onClick={onPlace}>
						<MapPinPlusIcon data-icon="inline-start" />
						Créer un arrêt provisoire sur la carte…
					</Button>
				</div>
			) : null}
			<div className="flex flex-col">
				{chosen.map((stop, index) => (
					<div key={stop.stopId} className={STOP_ROW}>
						<span className="font-mono text-xs text-subtle">{index + 1}</span>
						<StopGlyph provisional={stop.provisional} />
						<StopName name={stop.name} stopId={stop.stopId} />
						<span className="flex items-center gap-1 text-[13px] text-strong">
							<span className="font-mono">+</span>
							<TravelTimeInput
								value={stop.travelTime}
								label={`Temps depuis l'arrêt de référence pour ${stop.name}`}
								onChange={(seconds) => editor.setTravelTime(stop.stopId, seconds)}
							/>
							min
						</span>
						<span className="flex justify-end">
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={`Monter ${stop.name}`}
								disabled={index === 0}
								onClick={() => editor.moveStop(index, -1)}
							>
								<ArrowUpIcon />
							</Button>
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={`Descendre ${stop.name}`}
								disabled={index === chosen.length - 1}
								onClick={() => editor.moveStop(index, 1)}
							>
								<ArrowDownIcon />
							</Button>
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={`Retirer ${stop.name}`}
								onClick={() => editor.removeStop(stop.stopId)}
							>
								<XIcon />
							</Button>
						</span>
					</div>
				))}
				{chosen.some((stop, index) => index > 0 && stop.travelTime <= (chosen[index - 1]?.travelTime ?? 0)) ? (
					<p className="m-0 border-t border-divider py-2 text-[13px] text-warning-foreground">
						Les temps doivent croître d'un arrêt au suivant.
					</p>
				) : null}
				<div className={STOP_ROW}>
					<span />
					<span />
					<label htmlFor="propagated-delay" className="font-medium">
						Délai
					</label>
					<span className="flex items-center gap-1 text-[13px] text-strong">
						<span className="font-mono">+</span>
						<TravelTimeInput
							id="propagated-delay"
							value={editor.active.propagatedDelay}
							label="Délai"
							onChange={editor.setDelay}
						/>
						min
					</span>
					<span />
				</div>
				{nominal !== null ? (
					<div className={STOP_ROW}>
						<span />
						<StopGlyph provisional={false} />
						<StopName name={nominal.to.name} stopId={nominal.to.stopId} />
						<span className="flex items-center gap-1 text-[13px] text-strong">
							<span className="font-mono">+</span>
							<span className="w-14 pr-[9px] text-right font-mono font-semibold text-foreground">
								{formatDuration(nominal.seconds + editor.active.propagatedDelay)}
							</span>
							min
						</span>
						<span />
					</div>
				) : null}
			</div>
		</SectionCard>
	);
}

/** Une ligne de la liste des arrêts de remplacement : rang, glyphe, nom, temps, actions — les mêmes colonnes partout. */
const STOP_ROW =
	"grid grid-cols-[0.75rem_1.125rem_minmax(0,1fr)_auto_4.5rem] items-center gap-x-2 border-t border-divider py-2";

function StopName({ name, stopId }: { name: string; stopId: string }) {
	return (
		<span className="flex min-w-0 flex-col">
			<span className="line-clamp-2 leading-tight font-medium break-words">{name}</span>
			<span className="truncate font-mono text-xs text-subtle">{stopId}</span>
		</span>
	);
}

function StopGlyph({ provisional }: { provisional: boolean }) {
	return (
		<span
			className={cn(
				"inline-flex size-[18px] flex-none items-center justify-center bg-foreground text-[10px] font-bold text-white",
				provisional ? "rounded-[3px]" : "rounded-full",
			)}
		>
			{provisional ? "P" : "N"}
		</span>
	);
}

/** Créer un arrêt provisoire là où l'on a cliqué, et l'ajouter aussitôt au tronçon. */
function PlaceProvisionalStop({
	point,
	onClose,
	onCreated,
}: {
	point: LatLng | null;
	onClose: () => void;
	onCreated: (stop: { stopId: string; name: string; latitude: number; longitude: number }) => void;
}) {
	const [name, setName] = useState("");
	const save = useSaveProvisionalStop();
	return (
		<Dialog open={point !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
			<DialogContent aria-describedby={undefined}>
				<DialogHeader>
					<DialogTitle>Nouvel arrêt provisoire</DialogTitle>
				</DialogHeader>
				<Field className="gap-1.5">
					<FieldLabel htmlFor="place-name">Nom d'arrêt</FieldLabel>
					<Input
						id="place-name"
						placeholder="ex. Bellecour (provisoire)"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</Field>
				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						Annuler
					</Button>
					<Button
						disabled={name.trim().length === 0 || save.isPending || point === null}
						onClick={() => {
							if (point === null) return;
							save.mutate(
								{
									stopId: null,
									input: {
										name: name.trim(),
										latitude: point[0],
										longitude: point[1],
										stopCode: null,
										description: null,
										zoneId: null,
										parentStation: null,
										wheelchairBoarding: 0,
										platformCode: null,
									},
								},
								{
									onSuccess: (stop) => {
										setName("");
										onCreated(stop);
									},
								},
							);
						}}
					>
						Créer et ajouter
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
