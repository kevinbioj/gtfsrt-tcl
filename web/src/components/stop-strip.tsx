import { cn } from "cn";
import { useLayoutEffect, useRef } from "react";

export type StripStop = { stopId: string; name: string; removed: boolean };

/**
 * Le schéma d'une ligne dans un sens : ses arrêts dans l'ordre, chacun cliquable pour basculer entre
 * desservi et supprimé. Le trait passe en pointillés gris entre deux arrêts supprimés.
 *
 * À l'ouverture, le défilement s'arrête un arrêt avant le premier supprimé : la zone touchée se lit
 * d'emblée, avec l'arrêt qui l'annonce. Il ne suit pas les bascules — le schéma sauterait sous le clic.
 */
export function StopStrip({
	stops,
	color,
	disabled,
	onToggle,
}: {
	stops: StripStop[];
	color: string;
	disabled?: boolean;
	onToggle: (stopId: string) => void;
}) {
	const scroller = useRef<HTMLDivElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: on ne cale le défilement qu'à l'ouverture.
	useLayoutEffect(() => {
		const container = scroller.current;
		const first = stops.findIndex((stop) => stop.removed);
		const anchor = container?.querySelectorAll("button")[first - 1];
		if (container === null || anchor === undefined) return;
		container.scrollLeft += anchor.getBoundingClientRect().left - container.getBoundingClientRect().left;
	}, []);

	return (
		<div ref={scroller} className="overflow-x-auto pb-1">
			<div className="flex min-w-min">
				{stops.map((stop, index) => {
					const previous = stops[index - 1];
					const next = stops[index + 1];
					const leftCut = previous !== undefined && (previous.removed || stop.removed);
					const rightCut = next !== undefined && (next.removed || stop.removed);
					const dashed = "repeating-linear-gradient(90deg, #C4C8C3 0 6px, transparent 6px 10px)";
					return (
						<button
							key={stop.stopId}
							type="button"
							disabled={disabled}
							aria-pressed={stop.removed}
							aria-label={`${stop.name} : ${stop.removed ? "supprimé" : "desservi"}. Cliquer pour basculer.`}
							title={`${stop.name} · ${stop.stopId}`}
							onClick={() => onToggle(stop.stopId)}
							className="flex min-w-[84px] flex-[1_1_0] flex-col items-center gap-1.5 rounded-md border-0 bg-transparent px-0.5 pt-1.5 pb-2 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
						>
							<span className="relative block h-4 w-full">
								<span
									className="absolute top-1.5 left-0 h-1 w-1/2"
									style={{ background: leftCut ? dashed : color, visibility: previous ? "visible" : "hidden" }}
								/>
								<span
									className="absolute top-1.5 right-0 h-1 w-1/2"
									style={{ background: rightCut ? dashed : color, visibility: next ? "visible" : "hidden" }}
								/>
								<span
									className="absolute top-0 left-1/2 -ml-2 box-border size-4 rounded-full border-[3px]"
									style={{
										background: stop.removed ? "#F1F2F0" : "#FFFFFF",
										borderColor: stop.removed ? "#8A9097" : color,
									}}
								/>
							</span>
							<span
								className={cn(
									"text-center text-xs leading-tight text-balance",
									stop.removed ? "font-semibold text-muted-foreground line-through" : "font-medium text-foreground",
								)}
							>
								{stop.name}
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}
