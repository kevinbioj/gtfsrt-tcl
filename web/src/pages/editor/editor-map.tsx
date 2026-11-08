import type { AllStopsDto, DetailPatternDto, SequenceStopDto } from "@dto";
import { cn } from "cn";
import L from "leaflet";
import { Undo2Icon, XIcon } from "lucide-react";
import { Fragment, useMemo, useRef } from "react";
import { CircleMarker, Marker, Polyline, Tooltip, useMap } from "react-leaflet";

import { BaseMap, FitTo, MapClick, provisionalPinIcon, useDivIcon } from "@/components/map";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TooltipContent, TooltipTrigger, Tooltip as UiTooltip } from "@/components/ui/tooltip";
import { formatDuration } from "@/lib/format";
import { type LatLng, project, slice } from "@/lib/geometry";

import { type Geometry, pathOf, type Reading, type SegmentState, type Terminus } from "./editor-state";

export type MapMode = "draw" | "pick" | "place";

/** Un point lâché à moins de tant de pixels du tracé nominal est posé dessus — l'épaisseur du trait, à peu près. */
const ON_SHAPE_PIXELS = 5;

/** Expose la carte Leaflet au composant qui l'englobe. */
function MapHandle({ handle }: { handle: React.RefObject<L.Map | null> }) {
	handle.current = useMap();
	return null;
}

/** Les icônes des bornes, une par lettre et par couleur : le cercle de l'arrêt, sa lettre dedans. */
const boundIcons = new Map<string, L.DivIcon>();
function boundIcon(letter: "D" | "F", color: string, off: boolean): L.DivIcon {
	const key = `${letter}${color}${off}`;
	let icon = boundIcons.get(key);
	if (icon === undefined) {
		icon = L.divIcon({
			html: `<span style="display:flex;width:16px;height:16px;box-sizing:border-box;border-radius:50%;border:2px solid ${color};background:${off ? color : "#FFFFFF"};color:${off ? "#FFFFFF" : "#15181B"};font:700 9px/1 'IBM Plex Sans',sans-serif;align-items:center;justify-content:center">${letter}</span>`,
			className: "",
			iconSize: [16, 16],
			iconAnchor: [8, 8],
		});
		boundIcons.set(key, icon);
	}
	return icon;
}

/** Les couleurs de la carte, celles de l'ancienne interface : le nominal en gris, ce qu'on dessine en orange. */
const NOMINAL = "#8B949E";
const NOMINAL_STOP = "#57606A";
const DEVIATION = "#FB8500";
const REMOVED = "#D1242F";
const REPLACEMENT = "#1A7F37";
const PROVISIONAL = "#1F6FEB";
const AVAILABLE = "#1F6FEB";
const AVAILABLE_PROVISIONAL = "#9A6700";

function legendSwatch(
	kind: "nominal" | "avoided" | "detour" | "junction" | "skipped" | "replacement" | "provisional" | "available",
) {
	switch (kind) {
		case "nominal":
			return <span className="h-1 w-[22px] rounded-full opacity-70" style={{ background: NOMINAL }} />;
		case "avoided":
			return <span className="w-[22px] border-t-[3px] border-dashed" style={{ borderColor: NOMINAL_STOP }} />;
		case "detour":
			return <span className="h-[5px] w-[22px] rounded-full" style={{ background: DEVIATION }} />;
		case "junction":
			return <span className="size-2.5 rotate-45 rounded-[1px]" style={{ background: DEVIATION }} />;
		case "skipped":
			return <span className="size-3 rounded-full" style={{ background: REMOVED }} />;
		case "replacement":
			return <span className="size-3.5 rounded-full opacity-85" style={{ background: REPLACEMENT }} />;
		case "provisional":
			return (
				<svg width="12" height="18" viewBox="0 0 24 36" aria-hidden="true">
					<path
						d="M12 1C5.9 1 1 5.9 1 12c0 8.3 11 23 11 23s11-14.7 11-23C23 5.9 18.1 1 12 1z"
						fill={PROVISIONAL}
						stroke="#fff"
						strokeWidth="1.5"
					/>
					<circle cx="12" cy="12" r="4.5" fill="#fff" />
				</svg>
			);
		case "available":
			return <span className="size-2.5 rounded-full border-2 bg-white" style={{ borderColor: AVAILABLE }} />;
	}
}

/**
 * La carte de l'éditeur : le tracé nominal des tracés cochés, la portion que la déviation évite, le
 * dessin du tronçon en cours et ceux des autres, les arrêts de la ligne — barrés quand ils sont
 * supprimés —, et les arrêts de remplacement. Chaque clic pose un point de passage ; sur le trait
 * même du tracé nominal, il s'y accroche : c'est une jonction.
 */
export function EditorMap({
	patterns,
	allPatterns,
	geometry,
	segments,
	active,
	reading,
	skipped,
	referenceStopId,
	mode,
	pen,
	roadRouting,
	pickable,
	fitToken,
	onMapClick,
	onPen,
	onTerminus,
	onSelectSegment,
	onAddSegment,
	onRemoveSegment,
	onUndo,
	onClear,
	onMoveWaypoint,
	onRemoveWaypoint,
	onPickStop,
	hint,
}: {
	patterns: DetailPatternDto[];
	allPatterns: DetailPatternDto[];
	geometry: Geometry;
	segments: SegmentState[];
	active: number;
	reading: Reading | null;
	skipped: Set<string>;
	referenceStopId: string | null;
	mode: MapMode;
	pen: "route" | "free";
	roadRouting: boolean;
	pickable: AllStopsDto | null;
	fitToken: string;
	onMapClick: (point: LatLng, onShape?: boolean) => void;
	onPen: (pen: "route" | "free") => void;
	onTerminus: (terminus: Terminus) => void;
	onSelectSegment: (index: number) => void;
	onAddSegment: () => void;
	onRemoveSegment: (index: number) => void;
	onUndo: () => void;
	onClear: () => void;
	onMoveWaypoint: (index: number, point: LatLng, onShape: boolean) => void;
	onRemoveWaypoint: (index: number) => void;
	onPickStop: (stop: AllStopsDto[number]) => void;
	hint: string | null;
}) {
	const segment = segments[active];
	const checkedShapes = useMemo(() => [...new Set(patterns.map((pattern) => pattern.shapeId))], [patterns]);
	const otherShapes = useMemo(
		() =>
			[...new Set(allPatterns.map((pattern) => pattern.shapeId))].filter((shapeId) => !checkedShapes.includes(shapeId)),
		[allPatterns, checkedShapes],
	);
	const stops = useMemo(() => {
		const seen = new Set<string>();
		const result: SequenceStopDto[] = [];
		for (const pattern of patterns) {
			for (const stop of pattern.sequence) {
				if (seen.has(stop.stopId) || stop.latitude === null || stop.longitude === null) continue;
				seen.add(stop.stopId);
				result.push(stop);
			}
		}
		return result;
	}, [patterns]);
	const fitPoints = useMemo<LatLng[]>(() => {
		const drawn = segments.flatMap((entry) => pathOf(entry));
		if (drawn.length >= 2) return drawn;
		return stops.map((stop) => [stop.latitude as number, stop.longitude as number]);
	}, [segments, stops]);
	const onRoute = useMemo(() => new Set(stops.map((stop) => stop.stopId)), [stops]);

	const avoided =
		reading !== null && reading.joins - reading.leaves > 1 ? slice(reading.shape, reading.leaves, reading.joins) : [];
	const path = segment === undefined ? [] : pathOf(segment);
	const designated = new Set(segment?.stops.map((stop) => stop.stopId) ?? []);
	const primaryShape = patterns[0] ? geometry.get(patterns[0].shapeId) : undefined;

	const junctionIcon = useDivIcon(
		`<span style="display:block;width:11px;height:11px;transform:rotate(45deg);border-radius:1px;background:${DEVIATION}"></span>`,
		11,
	);
	const vertexIcon = useDivIcon(
		`<span style="display:block;width:12px;height:12px;border-radius:50%;background:${DEVIATION}"></span>`,
		12,
	);
	const provisionalIcon = useMemo(() => provisionalPinIcon(PROVISIONAL), []);

	const isJunction = (point: LatLng) => primaryShape !== undefined && project(primaryShape, point).offset <= 2;

	const map = useRef<L.Map | null>(null);
	/** Le point tombe-t-il sur le trait du tracé nominal, à l'écran ? */
	const onPrimaryShape = (point: LatLng) => {
		if (primaryShape === undefined || map.current === null) return false;
		const at = project(primaryShape, point).at;
		return (
			map.current.latLngToContainerPoint(at).distanceTo(map.current.latLngToContainerPoint(point)) <= ON_SHAPE_PIXELS
		);
	};

	return (
		<section
			aria-label="Carte du tracé"
			className="flex min-w-0 flex-[999_1_560px] flex-col overflow-hidden rounded-lg border bg-card lg:sticky lg:top-4"
		>
			<div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 border-b px-3 py-2.5">
				<ToggleGroup
					type="single"
					variant="outline"
					size="sm"
					value={pen}
					onValueChange={(value) => {
						if (value) onPen(value as "route" | "free");
					}}
					aria-label="Mode de dessin"
				>
					<ToggleGroupItem value="free">Libre</ToggleGroupItem>
					<UiTooltip>
						<TooltipTrigger asChild>
							<span>
								<ToggleGroupItem value="route" disabled={!roadRouting}>
									Ancre · voirie OSM
								</ToggleGroupItem>
							</span>
						</TooltipTrigger>
						{!roadRouting ? (
							<TooltipContent>Graphe routier absent : le construire avec « pnpm build:graph ».</TooltipContent>
						) : null}
					</UiTooltip>
				</ToggleGroup>
				<ToggleGroup
					type="single"
					variant="outline"
					size="sm"
					value={segment?.terminus ?? "intra"}
					onValueChange={(value) => {
						if (value) onTerminus(value === "intra" ? null : (value as Terminus));
					}}
					aria-label="Type de tracé"
				>
					<ToggleGroupItem value="intra">Déviation intra-tracé</ToggleGroupItem>
					<ToggleGroupItem value="start">Nouveau début</ToggleGroupItem>
					<ToggleGroupItem value="end">Nouvelle fin</ToggleGroupItem>
				</ToggleGroup>
				<span className="flex-1" />
				<Button variant="outline" disabled={!segment || segment.waypoints.length === 0} onClick={onUndo}>
					<Undo2Icon data-icon="inline-start" />
					Annuler le point
				</Button>
				<Button variant="outline" disabled={!segment || segment.waypoints.length === 0} onClick={onClear}>
					Effacer
				</Button>
			</div>
			<div className="flex flex-wrap items-center gap-1.5 border-b bg-muted px-3 py-2 text-[13px]">
				<span className="mr-1 font-medium text-strong">Tronçons</span>
				{segments.map((entry, index) => {
					const empty = pathOf(entry).length < 2 && entry.stops.length === 0 && entry.startStopId === null;
					// Un tronçon seul et vierge n'a rien à retirer : c'est la page blanche.
					const removable = segments.length > 1 || !empty;
					const variant = index === active ? "default" : "outline";
					return (
						<span key={entry.key} className="inline-flex">
							<Button
								size="sm"
								variant={variant}
								className={cn(removable && "rounded-r-none")}
								onClick={() => onSelectSegment(index)}
							>
								{index + 1}
								{pathOf(entry).length < 2 && entry.stops.length === 0 ? " (vide)" : ""}
							</Button>
							{removable ? (
								<Button
									size="icon-sm"
									variant={variant}
									aria-label={`Supprimer le tronçon ${index + 1}`}
									title={`Supprimer le tronçon ${index + 1}`}
									className={cn(
										"w-6 rounded-l-none",
										index === active ? "border-l border-l-primary-foreground/30" : "border-l-0",
									)}
									onClick={() => onRemoveSegment(index)}
								>
									<XIcon className="size-3" />
								</Button>
							) : null}
						</span>
					);
				})}
				<Button size="sm" variant="ghost" onClick={onAddSegment}>
					+ Ajouter un tronçon
				</Button>
			</div>

			<div className="relative h-[620px]">
				<BaseMap cursor="crosshair">
					<FitTo points={fitPoints} token={fitToken} />
					<MapHandle handle={map} />
					<MapClick onClick={onMapClick} />
					{otherShapes.map((shapeId) => (
						<Polyline
							key={shapeId}
							positions={geometry.get(shapeId) ?? []}
							pathOptions={{ color: NOMINAL, weight: 4, opacity: 0.2 }}
						/>
					))}
					{/* Un clic sur le trait même s'accroche au tracé, quel que soit le mode de dessin. */}
					{checkedShapes.map((shapeId) => (
						<Polyline
							key={shapeId}
							positions={geometry.get(shapeId) ?? []}
							pathOptions={{ color: NOMINAL, weight: 4, opacity: 0.7 }}
							bubblingMouseEvents={false}
							eventHandlers={{ click: (event) => onMapClick([event.latlng.lat, event.latlng.lng], true) }}
						/>
					))}
					{avoided.length >= 2 ? (
						<>
							<Polyline positions={avoided} pathOptions={{ color: "#FFFFFF", weight: 6, opacity: 1 }} />
							<Polyline
								positions={avoided}
								pathOptions={{ color: NOMINAL_STOP, weight: 3, opacity: 0.7, dashArray: "6 5" }}
							/>
						</>
					) : null}
					{segments.map((entry, index) =>
						index === active ? null : (
							<Polyline
								key={entry.key}
								positions={pathOf(entry)}
								pathOptions={{ color: DEVIATION, weight: 3, opacity: 0.35 }}
								eventHandlers={{ click: () => onSelectSegment(index) }}
							/>
						),
					)}
					{/* Le pointillé dit la ligne droite : ce qui ne suit aucune rue, qu'on l'ait voulu ou que le routage ait échoué. */}
					{path.length >= 2
						? segment?.legs.map((leg, index) => (
								<Polyline
									// biome-ignore lint/suspicious/noArrayIndexKey: une jambe n'a pas d'autre identité que son rang.
									key={index}
									positions={leg.points}
									interactive={false}
									pathOptions={{
										color: leg.status === "failed" ? REMOVED : DEVIATION,
										weight: 5,
										opacity: leg.status === "pending" ? 0.45 : 1,
										dashArray: leg.status === "ok" && segment.waypoints[index]?.mode === "route" ? undefined : "6 4",
									}}
								/>
							))
						: null}

					{pickable?.map((stop) => {
						const [stopId, name, latitude, longitude, provisional] = stop;
						if (onRoute.has(stopId) || designated.has(stopId)) return null;
						return (
							<CircleMarker
								key={stopId}
								center={[latitude, longitude]}
								radius={4}
								pathOptions={{
									color: provisional ? AVAILABLE_PROVISIONAL : AVAILABLE,
									weight: 2,
									fillColor: "#FFFFFF",
									fillOpacity: 1,
								}}
								eventHandlers={{ click: () => onPickStop(stop) }}
							>
								<Tooltip direction="top">
									{name}
									{provisional ? " (provisoire)" : ""} — cliquer pour l'ajouter
									<br />
									<span className="font-mono text-[11px]">{stopId}</span>
								</Tooltip>
							</CircleMarker>
						);
					})}

					{stops.map((stop) => {
						const off = skipped.has(stop.stopId);
						const reference = stop.stopId === referenceStopId;
						const bound = stop.stopId === segment?.startStopId ? "D" : stop.stopId === segment?.endStopId ? "F" : null;
						const position: LatLng = [stop.latitude as number, stop.longitude as number];
						const color = off ? REMOVED : NOMINAL_STOP;
						// Un clic sur un arrêt vaut un clic sur la carte, sauf quand on choisit un arrêt de remplacement.
						const click = (event: L.LeafletMouseEvent) => {
							if (mode === "pick") onPickStop([stop.stopId, stop.name, position[0], position[1], false]);
							else onMapClick([event.latlng.lat, event.latlng.lng]);
						};
						const label = (
							<Tooltip key="label" direction="right" offset={[bound ? 12 : 8, 0]} className="map-label">
								<span style={{ textDecoration: off ? "line-through" : undefined, color: off ? "#5B626A" : undefined }}>
									{stop.name}
									{reference ? " · réf." : ""}
									{bound === "D" ? " · début" : bound === "F" ? " · fin" : ""}
								</span>
								<br />
								<span className="font-mono text-[11px] font-normal text-subtle">{stop.stopId}</span>
							</Tooltip>
						);
						return bound === null ? (
							<CircleMarker
								key={stop.stopId}
								center={position}
								radius={off ? 6 : 4}
								pathOptions={{ color, weight: 2, fillColor: off ? REMOVED : "#FFFFFF", fillOpacity: 1 }}
								eventHandlers={{ click }}
							>
								{label}
							</CircleMarker>
						) : (
							<Marker
								key={stop.stopId}
								position={position}
								icon={boundIcon(bound, color, off)}
								zIndexOffset={500}
								eventHandlers={{ click }}
							>
								{label}
							</Marker>
						);
					})}

					{segment?.stops.map((stop, index) => {
						if (stop.latitude === null || stop.longitude === null) return null;
						const label = (
							<Tooltip key="label" direction="top">
								{index + 1}. {stop.name} · +{formatDuration(stop.travelTime)}
								{stop.provisional ? "" : " (GTFS)"}
								<br />
								<span className="font-mono text-[11px]">{stop.stopId}</span>
							</Tooltip>
						);
						// Un arrêt du GTFS est un quai : un rond. Un arrêt provisoire, une épingle.
						return stop.provisional ? (
							<Marker
								key={stop.stopId}
								position={[stop.latitude, stop.longitude]}
								icon={provisionalIcon}
								zIndexOffset={600}
							>
								{label}
							</Marker>
						) : (
							<CircleMarker
								key={stop.stopId}
								center={[stop.latitude, stop.longitude]}
								radius={8}
								pathOptions={{ color: REPLACEMENT, weight: 2, fillColor: REPLACEMENT, fillOpacity: 0.85 }}
							>
								{label}
							</CircleMarker>
						);
					})}

					{segment?.waypoints.map((waypoint, index) => (
						<Marker
							// biome-ignore lint/suspicious/noArrayIndexKey: un point de passage se désigne par son rang.
							key={`${segment.key}-${index}`}
							position={waypoint.point}
							icon={isJunction(waypoint.point) ? junctionIcon : vertexIcon}
							draggable
							eventHandlers={{
								dragend: (event) => {
									const { lat, lng } = (event.target as L.Marker).getLatLng();
									onMoveWaypoint(index, [lat, lng], onPrimaryShape([lat, lng]));
								},
								contextmenu: () => onRemoveWaypoint(index),
							}}
						>
							<Tooltip direction="top" offset={[0, -8]}>
								Point {index + 1} — glisser pour déplacer, clic droit pour retirer
							</Tooltip>
						</Marker>
					))}
				</BaseMap>
				{hint !== null ? (
					<span className="pointer-events-none absolute top-3 left-14 z-[500] max-w-[calc(100%-68px)] rounded-md bg-[rgba(21,24,27,0.86)] px-3 py-2 text-[13px] text-white">
						{hint}
					</span>
				) : null}
			</div>

			<div className="flex flex-wrap gap-x-5 gap-y-2.5 border-t px-3.5 py-3 text-xs text-strong">
				{(
					[
						["nominal", "Tracé nominal"],
						["avoided", "Tronçon évité"],
						["detour", "Tracé dévié"],
						["junction", "Jonction avec le nominal"],
						["skipped", "Arrêt non desservi"],
						["replacement", "Arrêt de remplacement"],
						["provisional", "Arrêt provisoire"],
						["available", "Arrêt disponible"],
					] as const
				).map(([kind, label]) => (
					<Fragment key={kind}>
						<span className="inline-flex items-center gap-2">
							{legendSwatch(kind)}
							{label}
						</span>
					</Fragment>
				))}
				<span className="ml-auto text-muted-foreground">Fond : © contributeurs OpenStreetMap</span>
			</div>
		</section>
	);
}
