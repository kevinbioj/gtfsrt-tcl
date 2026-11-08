import type { ProvisionalStopDto } from "@dto";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import type L from "leaflet";
import { SearchIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { CircleMarker, Marker, Tooltip } from "react-leaflet";
import { toast } from "sonner";

import { BaseMap, FitTo, MapClick, useDivIcon } from "@/components/map";
import { SpecName } from "@/components/section-card";
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
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatLength, modificationId, searchable } from "@/lib/format";
import { distance, type LatLng } from "@/lib/geometry";
import {
	useDeleteProvisionalStop,
	useProvisionalStops,
	useSaveProvisionalStop,
	useStopReferences,
} from "@/lib/queries";

import { ACCESSIBILITY, type Draft, draftOf, EMPTY, optional } from "./stop-draft";

/** Les couleurs des arrêts sur la carte, celles de l'éditeur de modification. */
const PROVISIONAL = "#9A6700";
const EDITING = "#1D56C8";

/** La page d'un arrêt provisoire, à créer (`stopId` nul) ou à modifier. */
export function StopEditorPage({ stopId }: { stopId: string | null }) {
	const stops = useProvisionalStops();
	if (stopId === null) return <StopEditor stop={null} others={stops.data ?? []} />;
	if (stops.isPending) {
		return (
			<div className="flex flex-col gap-4 p-6">
				<Skeleton className="h-16" />
				<Skeleton className="h-[600px]" />
			</div>
		);
	}
	const stop = stops.data?.find((entry) => entry.stopId === stopId);
	if (stop === undefined) {
		return (
			<Empty className="m-6 rounded-lg border bg-card">
				<EmptyHeader>
					<EmptyTitle>Arrêt provisoire introuvable</EmptyTitle>
					<EmptyDescription>Il a pu être supprimé depuis.</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button variant="outline" asChild>
						<Link to="/stops">Retour aux arrêts provisoires</Link>
					</Button>
				</EmptyContent>
			</Empty>
		);
	}
	return <StopEditor key={stop.stopId} stop={stop} others={stops.data ?? []} />;
}

/**
 * Un arrêt provisoire sur la carte, et le formulaire qui le décrit. On le pose d'un clic, on l'ajuste
 * en glissant son marqueur ; un clic sur une station du GTFS l'y rattache.
 */
function StopEditor({ stop: selected, others }: { stop: ProvisionalStopDto | null; others: ProvisionalStopDto[] }) {
	const navigate = useNavigate();
	const references = useStopReferences();
	const save = useSaveProvisionalStop();
	const remove = useDeleteProvisionalStop();

	const initial = useMemo(() => (selected === null ? EMPTY : draftOf(selected)), [selected]);
	const [draft, setDraft] = useState<Draft>(initial);
	const [parentQuery, setParentQuery] = useState("");

	const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
	useBlocker({
		shouldBlockFn: () =>
			dirty && !window.confirm("Les changements de cet arrêt ne sont pas enregistrés. Les abandonner ?"),
		enableBeforeUnload: () => dirty,
	});

	const backToList = () => navigate({ to: "/stops", ignoreBlocker: true });
	const patch = (change: Partial<Draft>) => setDraft((current) => ({ ...current, ...change }));

	const stations = references.data?.stations ?? [];

	const parents = useMemo(() => {
		const query = searchable(parentQuery);
		const withDistance = stations
			.filter((station) => query.length === 0 || searchable(station[1]).includes(query))
			.map((station) => ({
				stationId: station[0],
				name: station[1],
				distance:
					draft.position !== null && station[2] !== null && station[3] !== null
						? distance(draft.position, [station[2], station[3]])
						: null,
			}));
		if (draft.position !== null) withDistance.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
		return withDistance.slice(0, 60);
	}, [stations, parentQuery, draft.position]);

	const submit = () => {
		if (draft.position === null) {
			toast.error("Positionnez l'arrêt sur la carte.");
			return;
		}
		const { position, ...fields } = draft;
		save.mutate(
			{ stopId: selected?.stopId ?? null, input: { ...fields, latitude: position[0], longitude: position[1] } },
			{
				onSuccess: (stop) => {
					toast.success(selected === null ? `Arrêt provisoire ${stop.stopId} créé.` : "Arrêt provisoire enregistré.");
					backToList();
				},
			},
		);
	};

	// Les cercles de la carte des modifications : un arrêt provisoire cerclé d'ocre, celui qu'on édite plein
	// de bleu — une icône, et non un cercle de carte, pour se glisser.
	const editingIcon = useDivIcon(
		`<span style="display:block;width:16px;height:16px;box-sizing:border-box;border-radius:50%;border:2px solid #FFFFFF;background:${EDITING};box-shadow:0 0 0 2px ${EDITING}"></span>`,
		16,
	);
	// À l'ouverture : l'arrêt qu'on modifie, ou l'ensemble des arrêts provisoires pour en poser un nouveau.
	const fitPoints = useMemo<LatLng[]>(
		() =>
			selected !== null
				? [[selected.latitude, selected.longitude]]
				: others.map((stop): LatLng => [stop.latitude, stop.longitude]),
		[selected, others],
	);

	return (
		<>
			<header className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b bg-card px-6 py-3.5">
				<div className="flex min-w-0 flex-[1_1_360px] flex-col gap-1">
					<span className="flex flex-wrap gap-1.5 text-[13px] text-muted-foreground">
						<Link to="/stops">Arrêts provisoires</Link>
						<span aria-hidden="true">/</span>
						<span className={cn(selected !== null && "font-mono")}>{selected?.stopId ?? "Nouvel arrêt"}</span>
					</span>
					<span className="flex flex-wrap items-center gap-2.5">
						<h1 className="m-0 text-xl font-semibold tracking-tight">
							{selected === null ? "Nouvel arrêt provisoire" : selected.name}
						</h1>
						<span
							className={cn(
								"rounded-sm px-2 py-0.5 text-xs font-medium",
								selected === null ? "bg-neutral text-neutral-foreground" : "bg-info text-info-foreground",
							)}
						>
							{selected === null ? "Brouillon" : `Utilisé par ${selected.usages.length} modification(s)`}
						</span>
					</span>
				</div>
				<div className="flex flex-wrap gap-2">
					{selected !== null ? <DeleteStop stop={selected} onDeleted={backToList} remove={remove} /> : null}
					<Button variant="outline" size="lg" asChild>
						<Link to="/stops" className="text-foreground! no-underline">
							Annuler
						</Link>
					</Button>
					<Button
						size="lg"
						disabled={save.isPending || draft.name.trim().length === 0 || (selected !== null && !dirty)}
						onClick={submit}
					>
						{selected === null ? "Créer l'arrêt" : "Enregistrer"}
					</Button>
				</div>
			</header>

			<div className="px-6 pt-5 pb-10">
				<div className="flex flex-wrap items-start gap-5">
					<section
						aria-label="Carte des arrêts provisoires"
						className="flex min-w-0 flex-[999_1_560px] flex-col overflow-hidden rounded-lg border bg-card"
					>
						<div className="relative h-[560px]">
							<BaseMap cursor="crosshair">
								<FitTo points={fitPoints} token={fitPoints.length > 0 ? "ready" : "empty"} />
								<MapClick onClick={(point) => patch({ position: point })} />
								{stations.map(([stationId, name, latitude, longitude]) =>
									latitude === null || longitude === null ? null : (
										<CircleMarker
											key={stationId}
											center={[latitude, longitude]}
											radius={4}
											pathOptions={{
												color: stationId === draft.parentStation ? EDITING : "#8A9097",
												weight: 2,
												fillColor: "#FFFFFF",
												fillOpacity: 1,
											}}
											eventHandlers={{ click: () => patch({ parentStation: stationId }) }}
										>
											<Tooltip direction="right" offset={[6, 0]}>
												{name}
												<br />
												<span className="font-mono text-[11px]">{stationId}</span>
											</Tooltip>
										</CircleMarker>
									),
								)}
								{others
									.filter((stop) => stop.stopId !== selected?.stopId)
									.map((stop) => (
										<CircleMarker
											key={stop.stopId}
											center={[stop.latitude, stop.longitude]}
											radius={5}
											pathOptions={{ color: PROVISIONAL, weight: 2, fillColor: "#FFFFFF", fillOpacity: 1 }}
											// Son clic ne doit pas atteindre la carte : il y poserait l'arrêt qu'on édite.
											bubblingMouseEvents={false}
										>
											<Tooltip direction="bottom" offset={[0, 6]} permanent interactive className="map-label">
												<Link to="/stops/$stopId" params={{ stopId: stop.stopId }} className="text-foreground">
													{stop.name}
												</Link>
											</Tooltip>
										</CircleMarker>
									))}
								{draft.position !== null ? (
									<Marker
										position={draft.position}
										icon={editingIcon}
										draggable
										eventHandlers={{
											dragend: (event) => {
												const { lat, lng } = (event.target as L.Marker).getLatLng();
												patch({ position: [lat, lng] });
											},
										}}
									>
										<Tooltip direction="top" offset={[0, -10]} permanent className="map-label">
											{draft.name || selected?.stopId || "Nouvel arrêt"}
										</Tooltip>
									</Marker>
								) : null}
							</BaseMap>
						</div>
						<div className="flex flex-wrap gap-x-5 gap-y-2.5 border-t px-3.5 py-3 text-xs text-strong">
							<span className="inline-flex items-center gap-2">
								<span className="size-3 rounded-full border-2 bg-white" style={{ borderColor: PROVISIONAL }} />
								Arrêt provisoire
							</span>
							<span className="inline-flex items-center gap-2">
								<span
									className="size-3.5 rounded-full border-2 border-white"
									style={{ background: EDITING, boxShadow: `0 0 0 2px ${EDITING}` }}
								/>
								Arrêt en cours d'édition
							</span>
							<span className="inline-flex items-center gap-2">
								<span className="size-2.5 rounded-full border-2 border-neutral-dot bg-white" />
								Station GTFS
							</span>
							<span className="inline-flex items-center gap-2">
								<span className="size-2.5 rounded-full border-2 bg-white" style={{ borderColor: EDITING }} />
								Station parente
							</span>
						</div>
					</section>

					<section
						aria-label="Description de l'arrêt"
						className="flex min-w-0 flex-[1_1_340px] flex-col gap-3.5 rounded-lg border bg-card px-5 py-4"
					>
						<h2 className="m-0 text-base font-semibold">Description de l'arrêt</h2>

						<FieldGroup className="gap-3">
							<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-2.5">
								<Field className="gap-1.5">
									<FieldLabel htmlFor="stop-code" className="flex-col items-start gap-0">
										Code arrêt <SpecName>stop_code</SpecName>
									</FieldLabel>
									<Input
										id="stop-code"
										className="font-mono"
										value={draft.stopCode ?? ""}
										onChange={(event) => patch({ stopCode: optional(event.target.value) })}
									/>
								</Field>
								<Field className="gap-1.5">
									<FieldLabel htmlFor="stop-name" className="flex-col items-start gap-0">
										Nom d'arrêt <SpecName>stop_name</SpecName>
									</FieldLabel>
									<Input
										id="stop-name"
										placeholder="ex. Bellecour (provisoire)"
										value={draft.name}
										onChange={(event) => patch({ name: event.target.value })}
									/>
								</Field>
							</div>
							<Field className="gap-1.5">
								<FieldLabel htmlFor="stop-desc">
									Description <SpecName>stop_desc</SpecName>
								</FieldLabel>
								<Textarea
									id="stop-desc"
									rows={2}
									placeholder="Emplacement exact du poteau, repères…"
									value={draft.description ?? ""}
									onChange={(event) => patch({ description: optional(event.target.value) })}
								/>
							</Field>
							<div className="grid grid-cols-2 gap-2.5">
								<Field className="gap-1.5">
									<FieldLabel htmlFor="stop-platform" className="flex-col items-start gap-0">
										Quai <SpecName>platform_code</SpecName>
									</FieldLabel>
									<Input
										id="stop-platform"
										placeholder="ex. Quai A"
										value={draft.platformCode ?? ""}
										onChange={(event) => patch({ platformCode: optional(event.target.value) })}
									/>
								</Field>
								<Field className="gap-1.5">
									<FieldLabel htmlFor="stop-zone" className="flex-col items-start gap-0">
										Zone tarifaire <SpecName>zone_id</SpecName>
									</FieldLabel>
									<Select
										value={draft.zoneId ?? "none"}
										onValueChange={(value) => patch({ zoneId: value === "none" ? null : value })}
									>
										<SelectTrigger id="stop-zone" className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectGroup>
												<SelectItem value="none">Aucune</SelectItem>
												{(references.data?.fareAreas ?? []).map((area) => (
													<SelectItem key={area.areaId} value={area.areaId}>
														{area.name}
													</SelectItem>
												))}
											</SelectGroup>
										</SelectContent>
									</Select>
								</Field>
							</div>

							<FieldSet className="gap-1.5">
								<FieldLegend variant="label">
									Accessibilité <SpecName>wheelchair_boarding</SpecName>
								</FieldLegend>
								<ToggleGroup
									type="single"
									variant="outline"
									className="w-full"
									value={String(draft.wheelchairBoarding)}
									onValueChange={(value) => {
										if (value) patch({ wheelchairBoarding: Number(value) as 0 | 1 | 2 });
									}}
								>
									{ACCESSIBILITY.map((option) => (
										<ToggleGroupItem key={option.value} value={String(option.value)} className="flex-1">
											{option.label}
										</ToggleGroupItem>
									))}
								</ToggleGroup>
							</FieldSet>

							<FieldSet className="gap-1.5">
								<FieldLegend variant="label">
									Station parente <SpecName>parent_station</SpecName>
								</FieldLegend>
								<InputGroup>
									<InputGroupAddon>
										<SearchIcon />
									</InputGroupAddon>
									<InputGroupInput
										aria-label="Rechercher une station"
										placeholder="Rechercher une station…"
										value={parentQuery}
										onChange={(event) => setParentQuery(event.target.value)}
									/>
								</InputGroup>
								<ScrollArea className="h-56 rounded-md border">
									<RadioGroup
										className="gap-0"
										value={draft.parentStation ?? ""}
										onValueChange={(value) => patch({ parentStation: value === "" ? null : value })}
									>
										{[{ stationId: "", name: "Aucune station parente", distance: null }, ...parents].map((option) => (
											<label
												key={option.stationId || "none"}
												className={cn(
													"flex min-h-11 items-center gap-2.5 border-b border-divider px-3 last:border-b-0",
													(draft.parentStation ?? "") === option.stationId && "bg-[#F7F9FE] font-semibold",
												)}
											>
												<RadioGroupItem value={option.stationId} />
												<span className="flex-1">{option.name}</span>
												<span className="font-mono text-xs text-strong">
													{option.distance === null ? "" : formatLength(option.distance)}
												</span>
											</label>
										))}
									</RadioGroup>
								</ScrollArea>
							</FieldSet>
						</FieldGroup>

						<div className="flex justify-between gap-2.5 rounded-md border border-[#E2E5E1] bg-muted px-3 py-2.5 text-[13px]">
							<span className="text-subtle">
								Position <SpecName>stop_lat, stop_lon</SpecName>
							</span>
							<span className="font-mono">
								{draft.position === null
									? "non positionné"
									: `${draft.position[0].toFixed(5)}, ${draft.position[1].toFixed(5)}`}
							</span>
						</div>
					</section>
				</div>
			</div>
		</>
	);
}

/** Supprimer un arrêt provisoire : il disparaît aussi de toutes les modifications qui le désignent. */
function DeleteStop({
	stop,
	onDeleted,
	remove,
}: {
	stop: ProvisionalStopDto;
	onDeleted: () => void;
	remove: ReturnType<typeof useDeleteProvisionalStop>;
}) {
	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button variant="destructive" size="lg">
					<Trash2Icon data-icon="inline-start" />
					Supprimer
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Supprimer « {stop.name} » ?</AlertDialogTitle>
					<AlertDialogDescription>
						{stop.usages.length === 0
							? "Aucune modification ne le désigne : rien d'autre ne change."
							: `Il sera retiré des ${stop.usages.length} modification(s) qui le désignent comme arrêt de remplacement : ${stop.usages.map((usage) => modificationId(usage.uid)).join(", ")}.`}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Annuler</AlertDialogCancel>
					<AlertDialogAction variant="destructive" onClick={() => remove.mutate(stop.stopId, { onSuccess: onDeleted })}>
						Supprimer
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
