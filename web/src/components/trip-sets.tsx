import type { LineDto, TripSelectionDto } from "@dto";
import { PlusIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { LineBadge, LineOption } from "@/components/line-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatSeconds, parseClock, plural } from "@/lib/format";
import { useDepartures, useRoutes } from "@/lib/queries";

/** Un ensemble de courses tel qu'un formulaire le tient, avec de quoi l'afficher. */
export type TripSetForm = {
	key: string;
	routeId: string;
	directionId: number;
	enabled: boolean;
	selection: TripSelectionDto;
	line: LineDto;
	headsign: string;
	count: number | null;
	departures: { stopId: string; departure: number; name: string; known: boolean }[];
};

let sequence = 0;
export const tripSetKey = () => `set${++sequence}`;

/** La ligne et le sens qu'impose une modification, et les tracés cochés : seuls leurs départs comptent. */
export type TripSetScope = { routeId: string; directionId: number; patternIds: string[] };

/** La clé d'une course : le quai et l'horaire de son premier arrêt (cf. `courseKey`). */
const departureKey = (entry: { stopId: string; departure: number }) => `${entry.stopId}|${entry.departure}`;

const DAY_FORMAT = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });

/** « AAAA-MM-JJ » d'un instant, à l'heure du réseau. */
const ISO_DATE = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris" });

/** « Aujourd'hui · mercredi 28 octobre », « Demain · jeudi 29 octobre », puis la date seule. */
function dayLabel(date: string): string {
	const label = DAY_FORMAT.format(new Date(`${date}T12:00:00`));
	const now = new Date();
	if (date === ISO_DATE.format(now)) return `Aujourd'hui · ${label}`;
	if (date === ISO_DATE.format(new Date(now.getTime() + 86_400_000))) return `Demain · ${label}`;
	return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Le départ tombe-t-il dans la tranche ? Une fin avant le début passe minuit. */
function inWindow(from: number | null, to: number | null, departure: number): boolean {
	const clock = departure % 86_400;
	const start = from ?? 0;
	const end = to ?? 86_399;
	return start <= end ? clock >= start && clock <= end : clock >= start || clock <= end;
}

/**
 * Ajouter un ensemble de courses supprimées : une ligne, un sens, puis soit une tranche horaire —
 * toutes les courses qui partent dedans, ce qui survit aux changements de GTFS —, soit des départs
 * choisis un à un.
 *
 * `source` est la ressource dont les départs se lisent — « /alerts/87462 », « /modifications/12 » : ce
 * sont ses périodes qui disent quels jours parcourir. Une modification impose sa ligne et son sens
 * (`scope`), et ne propose que les départs de ses tracés cochés.
 */
export function TripSetDialog({
	source,
	lines,
	scope,
	onAdd,
}: {
	source: string;
	lines: LineDto[];
	scope?: TripSetScope;
	onAdd: (set: TripSetForm) => void;
}) {
	const routes = useRoutes();
	const [open, setOpen] = useState(false);
	const [routeId, setRouteId] = useState<string | null>(scope?.routeId ?? lines[0]?.routeId ?? null);
	const [directionId, setDirectionId] = useState<number | null>(scope?.directionId ?? null);
	const [mode, setMode] = useState<"range" | "departures">("range");
	const [allDay, setAllDay] = useState(false);
	const [from, setFrom] = useState("06:00");
	const [to, setTo] = useState("09:30");
	const [picked, setPicked] = useState<Set<string>>(new Set());

	const route = routes.data?.find((entry) => entry.routeId === routeId);
	const direction = route?.directions.find((entry) => entry.directionId === directionId) ?? route?.directions[0];
	const departures = useDepartures(source, route?.routeId ?? null, direction?.directionId ?? null);
	const days = (departures.data ?? [])
		.map((day) => ({
			...day,
			departures: day.departures.filter(
				(entry) => scope === undefined || entry.patternIds.some((patternId) => scope.patternIds.includes(patternId)),
			),
		}))
		.filter((day) => day.departures.length > 0);
	// Une course se désigne par son départ : la même revient d'un jour à l'autre, et ne compte qu'une fois.
	const offered = [
		...new Map(days.flatMap((day) => day.departures).map((entry) => [departureKey(entry), entry])).values(),
	];

	const cited = new Set(lines.map((line) => line.routeId));
	const sortedRoutes = useMemo(
		() => [...(routes.data ?? [])].sort((a, b) => Number(cited.has(b.routeId)) - Number(cited.has(a.routeId))),
		[routes.data, cited],
	);

	const range = allDay ? { from: null, to: null } : { from: parseClock(from), to: parseClock(to) };
	const rangeValid = allDay || (range.from !== null && range.to !== null);
	const matching = offered.filter((entry) =>
		mode === "range" ? rangeValid && inWindow(range.from, range.to, entry.departure) : picked.has(departureKey(entry)),
	);

	const add = () => {
		if (route === undefined || direction === undefined) return;
		const { directions: _, ...line } = route;
		const base = {
			key: tripSetKey(),
			routeId: route.routeId,
			directionId: direction.directionId,
			enabled: true,
			line,
			headsign: direction.headsigns.join(" / "),
			count: matching.length,
		};
		if (mode === "range") {
			onAdd({ ...base, selection: { kind: "range", ...range }, departures: [] });
		} else {
			const chosen = matching.map(({ stopId, departure, name }) => ({ stopId, departure, name, known: true }));
			onAdd({
				...base,
				selection: { kind: "departures", departures: chosen.map(({ stopId, departure }) => ({ stopId, departure })) },
				departures: chosen,
			});
		}
		setOpen(false);
		setPicked(new Set());
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<PlusIcon data-icon="inline-start" />
					Ajouter un ensemble de courses
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-xl" aria-describedby={undefined}>
				<DialogHeader>
					<DialogTitle>Ajouter un ensemble de courses</DialogTitle>
				</DialogHeader>
				<FieldGroup className="gap-4">
					{scope === undefined ? (
						<div className="grid grid-cols-2 gap-3">
							<Field className="gap-1.5">
								<FieldLabel htmlFor="set-line">Ligne</FieldLabel>
								<Select
									value={routeId ?? undefined}
									onValueChange={(value) => {
										setRouteId(value);
										setDirectionId(null);
										setPicked(new Set());
									}}
								>
									<SelectTrigger id="set-line" className="w-full">
										<SelectValue placeholder="Choisir une ligne" />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											{sortedRoutes.map((entry) => (
												<SelectItem key={entry.routeId} value={entry.routeId}>
													<LineOption route={entry} />
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
							</Field>
							<Field className="gap-1.5">
								<FieldLabel htmlFor="set-direction">Direction</FieldLabel>
								<Select
									value={direction ? String(direction.directionId) : undefined}
									onValueChange={(value) => {
										setDirectionId(Number(value));
										setPicked(new Set());
									}}
								>
									<SelectTrigger id="set-direction" className="w-full">
										<SelectValue placeholder="Choisir un sens" />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											{(route?.directions ?? []).map((entry) => (
												<SelectItem key={entry.directionId} value={String(entry.directionId)}>
													<span className="font-mono text-xs text-subtle">{entry.directionId}</span>→{" "}
													{entry.headsigns.join(" / ")}
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
							</Field>
						</div>
					) : null}

					<ToggleGroup
						type="single"
						variant="outline"
						value={mode}
						onValueChange={(value) => {
							if (value) setMode(value as "range" | "departures");
						}}
					>
						<ToggleGroupItem value="range" className="flex-1">
							Tranche horaire
						</ToggleGroupItem>
						<ToggleGroupItem value="departures" className="flex-1">
							Départs choisis
						</ToggleGroupItem>
					</ToggleGroup>

					{mode === "range" ? (
						<div className="flex flex-wrap items-center gap-3">
							<label className="flex items-center gap-1.5 text-[13px] text-strong">
								de
								<Input
									type="time"
									className="w-auto"
									value={from}
									disabled={allDay}
									onChange={(event) => setFrom(event.target.value)}
								/>
							</label>
							<label className="flex items-center gap-1.5 text-[13px] text-strong">
								à
								<Input
									type="time"
									className="w-auto"
									value={to}
									disabled={allDay}
									onChange={(event) => setTo(event.target.value)}
								/>
							</label>
							<label className="flex items-center gap-2 text-[13px] font-medium text-strong">
								<Checkbox checked={allDay} onCheckedChange={(on) => setAllDay(on === true)} />
								Toute la journée
							</label>
						</div>
					) : (
						<div className="flex flex-col gap-2">
							<p className="m-0 text-xs text-subtle">
								Une course cochée est annulée chaque jour où elle circule pendant les périodes.
							</p>
							<ScrollArea className="h-80 rounded-md border">
								{departures.isPending ? (
									<div className="flex flex-col gap-2 p-3">
										<Skeleton className="h-8" />
										<Skeleton className="h-8" />
									</div>
								) : (
									days.map((day) => (
										<section key={day.date} aria-label={dayLabel(day.date)}>
											<h4 className="sticky top-0 z-10 m-0 border-b border-divider bg-muted px-3 py-1.5 text-xs font-semibold text-strong">
												{dayLabel(day.date)}
											</h4>
											{day.departures.map((entry) => {
												const key = departureKey(entry);
												return (
													<label key={key} className="flex min-h-10 items-center gap-3 border-b border-divider px-3">
														<Checkbox
															checked={picked.has(key)}
															onCheckedChange={(on) =>
																setPicked((current) => {
																	const next = new Set(current);
																	if (on === true) next.add(key);
																	else next.delete(key);
																	return next;
																})
															}
														/>
														<span className="font-mono text-[13px] font-semibold">
															{formatSeconds(entry.departure)}
														</span>
														<span className="flex-1 truncate text-[13px]">{entry.name}</span>
														{entry.underway ? (
															<span className="text-xs font-medium text-accent-foreground">en route</span>
														) : null}
														<span className="max-w-[35%] truncate text-xs text-subtle">→ {entry.headsign}</span>
													</label>
												);
											})}
										</section>
									))
								)}
								{departures.data !== undefined && offered.length === 0 ? (
									<p className="m-0 p-4 text-[13px] text-muted-foreground">
										{scope === undefined
											? "Aucun départ pendant les périodes sur ces huit jours."
											: "Aucun départ des tracés cochés pendant les périodes sur ces huit jours."}
									</p>
								) : null}
							</ScrollArea>
						</div>
					)}
					<p className="m-0 text-[13px] text-strong">
						{departures.isPending ? "Comptage des courses…" : plural(matching.length, "course")}
					</p>
				</FieldGroup>
				<DialogFooter>
					<Button variant="outline" onClick={() => setOpen(false)}>
						Annuler
					</Button>
					<Button
						disabled={direction === undefined || (mode === "range" ? !rangeValid : picked.size === 0)}
						onClick={add}
					>
						Ajouter
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Les ensembles de courses d'un formulaire : chacun se coche, se décoche ou se retire. Dans une
 * modification, la ligne et le sens vont sans dire (`withLine` faux).
 */
export function TripSetList({
	sets,
	withLine = true,
	onChange,
}: {
	sets: TripSetForm[];
	withLine?: boolean;
	onChange: (sets: TripSetForm[]) => void;
}) {
	return (
		<>
			{sets.map((set) => (
				<div
					key={set.key}
					className="flex min-h-12 flex-wrap items-center gap-x-3.5 gap-y-2.5 border-t border-divider py-1.5"
				>
					<Checkbox
						aria-label="Ensemble actif"
						checked={set.enabled}
						onCheckedChange={(on) =>
							onChange(sets.map((other) => (other.key === set.key ? { ...other, enabled: on === true } : other)))
						}
					/>
					{withLine ? (
						<>
							<LineBadge line={set.line} />
							<span className="flex-[1_1_180px] font-medium">Direction {set.headsign}</span>
						</>
					) : null}
					<span className={withLine ? "font-mono text-[13px] text-strong" : "flex-1 font-mono text-[13px] text-strong"}>
						{set.selection.kind === "departures"
							? set.selection.departures.length <= 3
								? set.departures.map((entry) => formatSeconds(entry.departure)).join(", ")
								: `${set.selection.departures.length} départs choisis`
							: set.selection.from === null || set.selection.to === null
								? "Toute la journée"
								: `${formatSeconds(set.selection.from)} – ${formatSeconds(set.selection.to)}`}
					</span>
					<span className="min-w-[90px] text-right text-[13px] text-strong">
						{set.count === null ? "" : plural(set.count, "course")}
					</span>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Retirer l'ensemble"
						onClick={() => onChange(sets.filter((other) => other.key !== set.key))}
					>
						<XIcon />
					</Button>
				</div>
			))}
			{sets.length === 0 ? (
				<p className="m-0 border-t border-divider pt-3.5 text-[13px] text-muted-foreground">Aucune course supprimée.</p>
			) : null}
		</>
	);
}
