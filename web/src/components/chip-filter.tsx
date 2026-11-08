import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { readableOn } from "@/lib/labels";

export type ChipOption = { key: string; label: string; color: string; count: number };

/**
 * Un filtre en pastilles : « Toutes », puis une par valeur, chacune à sa couleur et avec son compte. Un
 * second clic sur la pastille choisie revient à « Toutes ». Choisie, la pastille prend sa couleur en
 * fond, et le texte qui s'y lit le mieux — une couleur saisie à la main peut être claire.
 */
export function ChipFilter({
	label,
	value,
	onChange,
	total,
	options,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	total: number;
	options: ChipOption[];
}) {
	return (
		<>
			<span className="mr-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">{label}</span>
			<ToggleGroup
				type="single"
				variant="outline"
				spacing={2}
				className="flex-wrap"
				value={value}
				onValueChange={(next) => onChange(next || "ALL")}
				aria-label={`Filtrer par ${label.toLowerCase()}`}
			>
				{[{ key: "ALL", label: "Toutes", color: "#15181B", count: total }, ...options].map((option) => (
					<ToggleGroupItem
						key={option.key}
						value={option.key}
						style={{ "--chip": option.color, "--chip-text": readableOn(option.color) } as React.CSSProperties}
						className="h-8 rounded-full px-3 data-[state=on]:border-(--chip) data-[state=on]:bg-(--chip) data-[state=on]:text-(--chip-text) data-[state=on]:hover:bg-(--chip) data-[state=on]:hover:text-(--chip-text)"
					>
						{option.key === "ALL" ? null : (
							<span
								aria-hidden="true"
								className="size-2 rounded-full bg-(--chip) group-data-[state=on]/toggle:bg-(--chip-text)"
							/>
						)}
						{option.label}
						<span className="font-mono text-xs opacity-85">{option.count}</span>
					</ToggleGroupItem>
				))}
			</ToggleGroup>
		</>
	);
}
