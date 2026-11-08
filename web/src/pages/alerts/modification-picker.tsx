import type { ModificationSummaryDto } from "@dto";
import { LinkIcon } from "lucide-react";
import { useState } from "react";

import { LineBadge } from "@/components/line-badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { modificationId } from "@/lib/format";

/**
 * Associer une modification à l'alerte : une recherche parmi celles qui ne le sont pas encore, celles
 * des lignes que l'alerte cite en premier.
 */
export function ModificationPicker({
	modifications,
	lines,
	onPick,
}: {
	modifications: ModificationSummaryDto[];
	lines: Set<string>;
	onPick: (uid: number) => void;
}) {
	const [open, setOpen] = useState(false);
	const cited = modifications.filter((entry) => lines.has(entry.routeId));
	const others = modifications.filter((entry) => !lines.has(entry.routeId));

	const item = (entry: ModificationSummaryDto) => (
		<CommandItem
			key={entry.uid}
			value={`${modificationId(entry.uid)} ${entry.line.line} ${entry.headsigns.join(" ")} ${entry.description ?? ""} ${entry.fromStop ?? ""}`}
			onSelect={() => {
				onPick(entry.uid);
				setOpen(false);
			}}
			className="gap-2.5"
		>
			<span className="font-mono text-[13px] font-semibold">{modificationId(entry.uid)}</span>
			<LineBadge line={entry.line} />
			<span className="min-w-0 flex-1 truncate">
				→ {entry.headsigns.join(" / ")}
				{entry.description ? ` · ${entry.description}` : ""}
			</span>
		</CommandItem>
	);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" aria-expanded={open}>
					<LinkIcon data-icon="inline-start" />
					Associer une modification
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-[440px] p-0">
				<Command>
					<CommandInput placeholder="Identifiant, ligne, direction, arrêt…" />
					<CommandList>
						<CommandEmpty>Aucune modification ne correspond.</CommandEmpty>
						{cited.length > 0 ? <CommandGroup heading="Lignes de l'alerte">{cited.map(item)}</CommandGroup> : null}
						{others.length > 0 ? <CommandGroup heading="Autres lignes">{others.map(item)}</CommandGroup> : null}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
