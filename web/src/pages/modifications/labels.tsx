import type { LabelDto } from "@dto";
import { cn } from "cn";
import { CheckIcon, MinusIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { LABEL_SWATCHES, readableOn } from "@/lib/labels";
import { useCreateLabel, useSetLabel } from "@/lib/queries";

/** Une étiquette, à sa couleur. */
export function LabelPill({ label, className }: { label: LabelDto; className?: string }) {
	return (
		<span
			className={cn(
				"inline-flex h-5 max-w-full shrink-0 items-center rounded-full px-2 text-[11px] font-semibold whitespace-nowrap",
				className,
			)}
			style={{ background: label.color, color: readableOn(label.color) }}
			title={label.name}
		>
			<span className="truncate">{label.name}</span>
		</span>
	);
}

/**
 * Le contenu d'un menu d'étiquettes, pour une ou plusieurs modifications : chaque étiquette se coche ou
 * se décoche pour toutes à la fois — une étiquette que certaines portent seulement se pose sur toutes.
 * Le menu reste ouvert, pour en poser plusieurs d'un coup.
 */
export function LabelMenuItems({
	labels,
	targets,
	onCreate,
}: {
	labels: LabelDto[];
	/** Les modifications visées, et leurs étiquettes. */
	targets: { uid: number; labelIds: number[] }[];
	onCreate: () => void;
}) {
	const setLabel = useSetLabel();
	const uids = targets.map((target) => target.uid);

	return (
		<>
			<DropdownMenuLabel>Étiquettes</DropdownMenuLabel>
			{labels.length === 0 ? (
				<p className="m-0 px-1.5 pb-1 text-xs text-muted-foreground">Aucune étiquette pour l'instant.</p>
			) : (
				labels.map((label) => {
					const carrying = targets.filter((target) => target.labelIds.includes(label.labelId)).length;
					const all = carrying > 0 && carrying === targets.length;
					return (
						<DropdownMenuItem
							key={label.labelId}
							role="menuitemcheckbox"
							aria-checked={all ? true : carrying > 0 ? "mixed" : false}
							onSelect={(event) => {
								event.preventDefault();
								setLabel.mutate({ labelId: label.labelId, uids, assigned: !all });
							}}
						>
							<span
								aria-hidden="true"
								className="size-2.5 flex-none rounded-full"
								style={{ background: label.color }}
							/>
							<span className="min-w-0 flex-1 truncate">{label.name}</span>
							{all ? (
								<CheckIcon aria-hidden="true" />
							) : carrying > 0 ? (
								<MinusIcon aria-hidden="true" className="text-muted-foreground" />
							) : (
								<span aria-hidden="true" className="size-4" />
							)}
						</DropdownMenuItem>
					);
				})
			)}
			<DropdownMenuSeparator />
			<DropdownMenuItem onSelect={onCreate}>
				<PlusIcon aria-hidden="true" />
				Nouvelle étiquette…
			</DropdownMenuItem>
		</>
	);
}

/**
 * Crée une étiquette — un nom, une couleur — et la pose d'emblée sur les modifications `uids`. Ouvert
 * tant que `uids` n'est pas nul.
 */
export function NewLabelDialog({ uids, onClose }: { uids: number[] | null; onClose: () => void }) {
	return (
		<Dialog open={uids !== null} onOpenChange={(open) => !open && onClose()}>
			<DialogContent aria-describedby={undefined}>
				{uids === null ? null : <NewLabelForm uids={uids} onDone={onClose} />}
			</DialogContent>
		</Dialog>
	);
}

function NewLabelForm({ uids, onDone }: { uids: number[]; onDone: () => void }) {
	const id = useId();
	const create = useCreateLabel();
	const [name, setName] = useState("");
	const [color, setColor] = useState(() => LABEL_SWATCHES[Math.floor(Math.random() * LABEL_SWATCHES.length)] as string);
	const trimmed = name.trim();

	const submit = (event: React.FormEvent) => {
		event.preventDefault();
		if (trimmed.length === 0) return;
		create.mutate(
			{ name: trimmed, color, uids },
			{
				onSuccess: (label) => {
					toast.success(
						uids.length === 0
							? `Étiquette « ${label.name} » créée.`
							: `Étiquette « ${label.name} » posée sur ${uids.length} modification(s).`,
					);
					onDone();
				},
			},
		);
	};

	return (
		<form onSubmit={submit} className="contents">
			<DialogHeader>
				<DialogTitle>Nouvelle étiquette</DialogTitle>
			</DialogHeader>
			<FieldGroup className="gap-4">
				<Field className="gap-1.5">
					<FieldLabel htmlFor={`${id}-name`}>Nom</FieldLabel>
					<Input
						id={`${id}-name`}
						autoFocus
						maxLength={40}
						placeholder="Travaux, à vérifier, été 2026…"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</Field>
				<Field className="gap-1.5">
					<FieldLabel htmlFor={`${id}-color`}>Couleur</FieldLabel>
					<div className="flex flex-wrap items-center gap-1.5">
						{LABEL_SWATCHES.map((swatch) => (
							<button
								key={swatch}
								type="button"
								aria-label={swatch}
								aria-pressed={color === swatch}
								onClick={() => setColor(swatch)}
								className={cn(
									"size-6 rounded-full ring-offset-2 ring-offset-popover outline-none focus-visible:ring-2 focus-visible:ring-ring",
									color === swatch && "ring-2 ring-foreground",
								)}
								style={{ background: swatch }}
							/>
						))}
						<label
							className="relative ml-1 inline-flex h-7 cursor-pointer items-center gap-2 rounded-lg border px-2 text-xs font-medium focus-within:ring-2 focus-within:ring-ring"
							title="Autre couleur"
						>
							<span aria-hidden="true" className="size-4 rounded-full border" style={{ background: color }} />
							<span className="font-mono">{color}</span>
							<input
								id={`${id}-color`}
								type="color"
								value={color.toLowerCase()}
								onChange={(event) => setColor(event.target.value.toUpperCase())}
								className="absolute inset-0 size-full cursor-pointer opacity-0"
							/>
						</label>
					</div>
				</Field>
				<div className="flex items-center gap-2 text-xs text-muted-foreground">
					Aperçu
					<LabelPill label={{ labelId: 0, name: trimmed || "Étiquette", color }} />
				</div>
			</FieldGroup>
			<DialogFooter>
				<Button type="button" variant="outline" onClick={onDone}>
					Annuler
				</Button>
				<Button type="submit" disabled={trimmed.length === 0 || create.isPending}>
					{uids.length === 0 ? "Créer" : "Créer et poser"}
				</Button>
			</DialogFooter>
		</form>
	);
}
