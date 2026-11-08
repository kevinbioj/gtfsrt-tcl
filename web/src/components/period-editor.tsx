import type { PeriodDto, PeriodInput } from "@dto";
import { ClockIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

/**
 * Une période telle que le formulaire la tient : les bornes en « AAAA-MM-JJTHH:MM » (ou « AAAA-MM-JJ »
 * avec une tranche horaire, qui se saisit à la journée), « à nouvel avis » pour une fin ouverte.
 */
export type PeriodForm = {
	id: string;
	start: string;
	end: string;
	open: boolean;
	hours: { from: string; to: string } | null;
};

let sequence = 0;
const nextId = () => `p${++sequence}`;

const today = () => new Date().toISOString().slice(0, 10);
const dateOf = (bound: string) => bound.slice(0, 10);
const withTime = (bound: string) => (bound.includes("T") ? bound : `${bound}T00:00`);

/** Une période relue, prête à remplir le formulaire. */
export function periodForm(period: PeriodDto): PeriodForm {
	const hours = period.dailyWindow;
	const start = period.start ?? today();
	return {
		id: nextId(),
		start: hours ? dateOf(start) : withTime(start),
		end: period.end === null ? "" : hours ? dateOf(period.end) : withTime(period.end),
		open: period.end === null,
		hours: hours ? { ...hours } : null,
	};
}

export function emptyPeriod(): PeriodForm {
	const now = new Date();
	now.setMinutes(0, 0, 0);
	const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
	return { id: nextId(), start: local, end: "", open: true, hours: null };
}

/** Une borne « AAAA-MM-JJ[THH:MM] » telle que l'API l'attend. */
function boundInput(value: string) {
	const [date, time] = value.split("T");
	return { date: date ?? "", time: time && time.length > 0 ? time : null };
}

/** La période telle que l'API l'attend. */
export function periodInput(period: PeriodForm): PeriodInput {
	return {
		start: period.start ? boundInput(period.start) : null,
		end: period.open || !period.end ? null : boundInput(period.end),
		dailyWindow: period.hours,
	};
}

/** La période telle qu'on la relit, de quoi la dire en clair (cf. `describePeriods`). */
export function periodDto(period: PeriodForm): PeriodDto {
	return {
		start: period.start || null,
		end: period.open || !period.end ? null : period.end,
		dailyWindow: period.hours,
	};
}

/** Une copie de la période, à éditer à part. */
export function copyPeriod(period: PeriodForm): PeriodForm {
	return { ...period, id: nextId(), hours: period.hours ? { ...period.hours } : null };
}

/**
 * Les périodes d'application d'une alerte : chacune un début, une fin ou « à nouvel avis », et au
 * besoin une tranche horaire répétée chaque jour — les dates se saisissent alors à la journée.
 */
export function PeriodEditor({
	periods,
	onChange,
}: {
	periods: PeriodForm[];
	onChange: (periods: PeriodForm[]) => void;
}) {
	const update = (id: string, patch: Partial<PeriodForm>) =>
		onChange(periods.map((period) => (period.id === id ? { ...period, ...patch } : period)));

	return (
		<div className="flex flex-col">
			{periods.map((period, index) => (
				<div key={period.id} className="flex flex-col gap-2.5 border-t border-divider py-3.5">
					<div className="flex flex-wrap items-end gap-x-4 gap-y-3">
						<span className="min-w-6 self-center font-mono text-xs font-semibold text-subtle">P{index + 1}</span>
						<label className="flex flex-col gap-1.5 text-[13px] font-medium text-strong">
							Début
							<Input
								type={period.hours ? "date" : "datetime-local"}
								className="h-10 w-auto"
								value={period.start}
								onChange={(event) => update(period.id, { start: event.target.value })}
							/>
						</label>
						<label className="flex flex-col gap-1.5 text-[13px] font-medium text-strong">
							Fin
							<Input
								type={period.hours ? "date" : "datetime-local"}
								className="h-10 w-auto"
								value={period.open ? "" : period.end}
								disabled={period.open}
								onChange={(event) => update(period.id, { end: event.target.value })}
							/>
						</label>
						<label className="flex h-10 items-center gap-2 text-[13px] font-medium text-strong">
							<Checkbox checked={period.open} onCheckedChange={(on) => update(period.id, { open: on === true })} />À
							nouvel avis
						</label>
						<Button
							variant="outline"
							size="icon-lg"
							className="ml-auto"
							aria-label={`Supprimer la période P${index + 1}`}
							onClick={() => onChange(periods.filter((other) => other.id !== period.id))}
						>
							<Trash2Icon />
						</Button>
					</div>
					<div className="flex flex-wrap items-center gap-x-3 gap-y-2.5 pl-10">
						{period.hours ? (
							<>
								<span className="text-[13px] font-medium text-strong">Heures applicables</span>
								<label className="flex items-center gap-1.5 text-[13px] text-strong">
									de
									<Input
										type="time"
										aria-label="Heure de début"
										className="w-auto"
										value={period.hours.from}
										onChange={(event) =>
											update(period.id, { hours: { from: event.target.value, to: period.hours?.to ?? "" } })
										}
									/>
								</label>
								<label className="flex items-center gap-1.5 text-[13px] text-strong">
									à
									<Input
										type="time"
										aria-label="Heure de fin"
										className="w-auto"
										value={period.hours.to}
										onChange={(event) =>
											update(period.id, { hours: { from: period.hours?.from ?? "", to: event.target.value } })
										}
									/>
								</label>
								<Button
									variant="link"
									onClick={() =>
										update(period.id, {
											hours: null,
											start: withTime(period.start),
											end: period.end ? withTime(period.end) : "",
										})
									}
								>
									Toute la journée
								</Button>
							</>
						) : (
							<Button
								variant="outline"
								className="border-dashed"
								onClick={() =>
									update(period.id, {
										hours: { from: "09:00", to: "17:00" },
										start: dateOf(period.start),
										end: period.end ? dateOf(period.end) : "",
									})
								}
							>
								<ClockIcon data-icon="inline-start" />
								Restreindre à des heures
							</Button>
						)}
					</div>
				</div>
			))}
			{periods.length === 0 ? (
				<p className="m-0 border-t border-divider pt-3.5 text-[13px] text-muted-foreground">Aucune période.</p>
			) : null}
			<div className="pt-2">
				<Button variant="outline" onClick={() => onChange([...periods, emptyPeriod()])}>
					<PlusIcon data-icon="inline-start" />
					Ajouter une période
				</Button>
			</div>
		</div>
	);
}
