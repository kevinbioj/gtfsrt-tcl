import type { PeriodDto } from "@dto";
import { cn } from "cn";
import { ClockIcon, PencilIcon } from "lucide-react";
import { useState } from "react";

import { copyPeriod, PeriodEditor, type PeriodForm, periodDto } from "@/components/period-editor";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { describePeriods } from "@/lib/format";

/**
 * Les périodes d'une modification associée, au titre de l'alerte, dites sur la ligne de la
 * modification : discrètement quand elle reprend celles de l'alerte, sur fond d'avertissement quand elle
 * a les siennes. Le crayon les fait saisir dans une boîte de dialogue, sur un brouillon que seul
 * « Appliquer » reporte dans le formulaire de l'alerte.
 */
export function OwnPeriods({
	label,
	own,
	inherited,
	seed,
	onChange,
}: {
	/** L'identifiant affiché de la modification. */
	label: string;
	/** Ses périodes propres ; `undefined` : celles de l'alerte. */
	own: PeriodForm[] | undefined;
	/** Celles de l'alerte, telles qu'en cours de saisie. */
	inherited: readonly PeriodDto[];
	/** De quoi amorcer des périodes propres : celles de l'alerte, à éditer à part. */
	seed: () => PeriodForm[];
	/** `null` : revient aux périodes de l'alerte. */
	onChange: (periods: PeriodForm[] | null) => void;
}) {
	const [open, setOpen] = useState(false);
	/** `null` : celles de l'alerte. */
	const [draft, setDraft] = useState<PeriodForm[] | null>(null);

	const openWith = (next: boolean) => {
		if (next) setDraft(own === undefined ? null : own.map(copyPeriod));
		setOpen(next);
	};

	return (
		<span className="inline-flex min-w-0 items-center gap-0.5">
			<span
				className={cn(
					"inline-flex min-w-0 items-center gap-1.5 rounded-sm px-2 py-0.5 text-[13px]",
					own === undefined ? "text-muted-foreground" : "bg-warning text-warning-foreground",
				)}
			>
				<ClockIcon className="size-3.5 shrink-0" />
				<span className="truncate">
					{own === undefined ? "pendant toute la durée d'impact de l'alerte" : describePeriods(own.map(periodDto))}
				</span>
			</span>
			<Dialog open={open} onOpenChange={openWith}>
				<DialogTrigger asChild>
					<Button variant="ghost" size="icon-sm" aria-label={`Modifier les périodes de ${label}`}>
						<PencilIcon />
					</Button>
				</DialogTrigger>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>Périodes de {label}</DialogTitle>
						<DialogDescription>
							Quand cette modification s'applique au titre de l'alerte. Quelles que soient ses périodes, elle cesse dès
							que l'alerte sort du flux ou est dépubliée.
						</DialogDescription>
					</DialogHeader>

					<RadioGroup
						className="gap-0 rounded-md border"
						value={draft === null ? "inherited" : "own"}
						onValueChange={(value) => setDraft(value === "inherited" ? null : seed())}
					>
						<label
							className={cn(
								"flex min-h-11 items-center gap-2.5 border-b border-divider px-3 py-2",
								draft === null && "bg-[#F7F9FE]",
							)}
						>
							<RadioGroupItem value="inherited" />
							<span className="flex flex-1 flex-col">
								<span className="font-medium">Pendant toute la durée d'impact de l'alerte</span>
								<span className="text-[13px] text-muted-foreground">{describePeriods(inherited)}</span>
							</span>
						</label>
						<label className={cn("flex min-h-11 items-center gap-2.5 px-3 py-2", draft !== null && "bg-[#F7F9FE]")}>
							<RadioGroupItem value="own" />
							<span className="flex-1 font-medium">Sur des périodes propres</span>
						</label>
					</RadioGroup>

					{draft !== null ? <PeriodEditor periods={draft} onChange={setDraft} /> : null}

					<DialogFooter>
						<Button variant="outline" onClick={() => setOpen(false)}>
							Annuler
						</Button>
						<Button
							onClick={() => {
								onChange(draft);
								setOpen(false);
							}}
						>
							Appliquer
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</span>
	);
}
