import type { ImpactEntityDto, RouteDto } from "@dto";
import { cn } from "cn";
import { PlusIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { LineBadge, LineOption, serviceOf } from "@/components/line-badge";
import { SectionCard } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { searchable } from "@/lib/format";
import { useAllStops, useRoutes } from "@/lib/queries";

const entity = (change: Partial<ImpactEntityDto>): ImpactEntityDto => ({
	agencyId: null,
	routeId: null,
	directionId: null,
	stopId: null,
	...change,
});

/**
 * L'impact d'une alerte — ses agences, ses lignes dans un sens ou les deux, ses arrêts — tel qu'il
 * sera republié. `value` nul : l'impact reçu ; la première retouche en part.
 */
export function ImpactEditor({
	value,
	received,
	onChange,
}: {
	value: ImpactEntityDto[] | null;
	received: ImpactEntityDto[];
	onChange: (value: ImpactEntityDto[] | null) => void;
}) {
	const routes = useRoutes();
	const allStops = useAllStops();
	const entities = value ?? received;
	const update = (next: ImpactEntityDto[]) => onChange(next);

	const routeById = useMemo(() => new Map((routes.data ?? []).map((route) => [route.routeId, route])), [routes.data]);
	// Les lignes arrivent triées par `route_sort_order` : leur rang dans la liste fait l'ordre de l'impact.
	const rankOf = useMemo(
		() => new Map((routes.data ?? []).map((route, index) => [route.routeId, index])),
		[routes.data],
	);
	const stopNames = useMemo(
		() => new Map((allStops.data ?? []).map(([stopId, name]) => [stopId, name])),
		[allStops.data],
	);
	// Les agences du GTFS qui exploitent au moins une ligne, avec leur nom.
	const agencies = useMemo(
		() => [
			...new Map(
				(routes.data ?? []).flatMap((route) =>
					route.agencyId === null ? [] : [[route.agencyId, route.agencyName ?? route.agencyId] as const],
				),
			),
		],
		[routes.data],
	);

	const agencyOnly = (agencyId: string) =>
		entities.some((item) => item.agencyId === agencyId && item.routeId === null && item.stopId === null);
	const rank = (item: ImpactEntityDto) => rankOf.get(item.routeId as string) ?? Number.POSITIVE_INFINITY;
	const lines = entities
		.filter((item) => item.routeId !== null)
		.sort((a, b) => rank(a) - rank(b) || (a.directionId ?? -1) - (b.directionId ?? -1));
	const stops = entities.filter((item) => item.routeId === null && item.stopId !== null);
	const without = (target: ImpactEntityDto) => entities.filter((item) => item !== target);

	return (
		<SectionCard
			title="Impact"
			actions={
				<>
					<span
						className={cn(
							"rounded-sm px-2 py-0.5 text-xs font-medium",
							value === null ? "bg-neutral text-neutral-foreground" : "bg-warning text-warning-foreground",
						)}
					>
						{value === null ? "Reçu" : "Modifié"}
					</span>
					<Button variant="outline" disabled={value === null} onClick={() => onChange(null)}>
						Reprendre l'impact reçu
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-1.5 border-t border-divider pt-3">
				<span className="text-[13px] font-medium text-strong">Agences</span>
				<div className="flex flex-wrap gap-4">
					{agencies.map(([agencyId, agencyName]) => (
						<label key={agencyId} className="flex items-center gap-2 text-sm">
							<Checkbox
								checked={agencyOnly(agencyId)}
								onCheckedChange={(on) =>
									update(
										on === true
											? [...entities, entity({ agencyId })]
											: entities.filter(
													(item) => !(item.agencyId === agencyId && item.routeId === null && item.stopId === null),
												),
									)
								}
							/>
							{agencyName}
						</label>
					))}
				</div>
			</div>

			<div className="flex flex-col gap-1.5 border-t border-divider pt-3">
				<span className="flex items-center gap-2 text-[13px] font-medium text-strong">
					Lignes
					<RoutePicker
						routes={(routes.data ?? []).filter((route) => !lines.some((item) => item.routeId === route.routeId))}
						onPick={(routeId) =>
							update([...entities, entity({ agencyId: routeById.get(routeId)?.agencyId ?? null, routeId })])
						}
					/>
				</span>
				{lines.map((item, index) => {
					const route = item.routeId === null ? undefined : routeById.get(item.routeId);
					return (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: une même ligne peut figurer dans les deux sens.
							key={`${item.routeId}-${item.directionId}-${index}`}
							className="flex items-center gap-2.5"
						>
							{route ? <LineBadge line={route} /> : <span className="font-mono text-xs">{item.routeId}</span>}
							<Select
								value={item.directionId === null ? "both" : String(item.directionId)}
								onValueChange={(next) =>
									update(
										entities.map((other) =>
											other === item ? { ...other, directionId: next === "both" ? null : Number(next) } : other,
										),
									)
								}
							>
								<SelectTrigger size="sm" className="min-w-48">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										<SelectItem value="both">Les deux sens</SelectItem>
										{(route?.directions ?? []).map((direction) => (
											<SelectItem key={direction.directionId} value={String(direction.directionId)}>
												<span className="font-mono text-xs text-subtle">{direction.directionId}</span>→{" "}
												{direction.headsigns.join(" / ")}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
							{item.stopId !== null ? (
								<span className="text-[13px]">{stopNames.get(item.stopId) ?? item.stopId}</span>
							) : null}
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Retirer la ligne"
								onClick={() => update(without(item))}
							>
								<XIcon />
							</Button>
						</div>
					);
				})}
				{lines.length === 0 ? <span className="text-[13px] text-muted-foreground">Aucune ligne.</span> : null}
			</div>

			<div className="flex flex-col gap-1.5 border-t border-divider pt-3">
				<span className="flex items-center gap-2 text-[13px] font-medium text-strong">
					Arrêts
					<StopPicker
						stops={allStops.data ?? []}
						taken={new Set(stops.map((item) => item.stopId as string))}
						onPick={(stopId) => update([...entities, entity({ stopId })])}
					/>
				</span>
				<div className="flex flex-wrap gap-1.5">
					{stops.map((item) => (
						<span
							key={item.stopId}
							className="inline-flex items-center gap-1.5 rounded-md border bg-secondary py-0.5 pr-1 pl-2 text-[13px]"
						>
							{stopNames.get(item.stopId as string) ?? item.stopId}
							<span className="font-mono text-[11px] text-subtle">{item.stopId}</span>
							<Button variant="ghost" size="icon-xs" aria-label="Retirer l'arrêt" onClick={() => update(without(item))}>
								<XIcon />
							</Button>
						</span>
					))}
					{stops.length === 0 ? <span className="text-[13px] text-muted-foreground">Aucun arrêt.</span> : null}
				</div>
			</div>
		</SectionCard>
	);
}

function RoutePicker({ routes, onPick }: { routes: RouteDto[]; onPick: (routeId: string) => void }) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="icon-xs" aria-label="Ajouter une ligne">
					<PlusIcon />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-96 p-0">
				<Command>
					<CommandInput placeholder="Ligne…" />
					<CommandList>
						<CommandEmpty>Aucune ligne.</CommandEmpty>
						<CommandGroup>
							{routes.map((route) => (
								<CommandItem
									key={route.routeId}
									value={`${route.line} ${serviceOf(route)} ${route.routeId}`}
									onSelect={() => {
										onPick(route.routeId);
										setOpen(false);
									}}
								>
									<LineOption route={route} />
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

/** Choisir un arrêt parmi tous ceux du GTFS et de la base provisoire : on filtre soi-même, ils sont des milliers. */
function StopPicker({
	stops,
	taken,
	onPick,
}: {
	stops: [string, string, number, number, boolean][];
	taken: Set<string>;
	onPick: (stopId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const matches = useMemo(() => {
		const text = searchable(query.trim());
		if (text.length < 2) return [];
		return stops
			.filter(
				([stopId, name]) =>
					!taken.has(stopId) && (searchable(name).includes(text) || searchable(stopId).includes(text)),
			)
			.slice(0, 50);
	}, [stops, taken, query]);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="icon-xs" aria-label="Ajouter un arrêt">
					<PlusIcon />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 p-0">
				<Command shouldFilter={false}>
					<CommandInput placeholder="Nom ou identifiant…" value={query} onValueChange={setQuery} />
					<CommandList>
						<CommandEmpty>{query.trim().length < 2 ? "Deux lettres au moins." : "Aucun arrêt."}</CommandEmpty>
						<CommandGroup>
							{matches.map(([stopId, name]) => (
								<CommandItem
									key={stopId}
									value={stopId}
									onSelect={() => {
										onPick(stopId);
										setQuery("");
										setOpen(false);
									}}
								>
									<span className="flex-1 truncate">{name}</span>
									<span className="font-mono text-xs text-subtle">{stopId}</span>
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
