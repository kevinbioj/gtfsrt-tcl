import type { LineDto, RouteDto } from "@dto";
import { cn } from "cn";
import { useState } from "react";

import { useCartridges } from "@/lib/queries";

/** Le pictogramme d'une ligne ; à défaut — inconnu, ou qui ne se charge pas —, un cartouche à ses couleurs. */
export function LineBadge({
	line,
	size = "default",
	className,
}: {
	line: LineDto;
	size?: "default" | "lg";
	className?: string;
}) {
	const cartridge = useCartridges().data?.get(line.routeId);
	const [broken, setBroken] = useState<string | null>(null);
	if (cartridge !== undefined && cartridge !== broken) {
		return (
			<img
				src={cartridge}
				alt={`Ligne ${line.line}`}
				title={`Ligne ${line.line}`}
				className={cn(
					"shrink-0 rounded-sm object-contain",
					size === "lg" ? "h-6 w-15" : "h-[22px] w-[55px]",
					className,
				)}
				onError={() => setBroken(cartridge)}
			/>
		);
	}
	return (
		<span
			title={`Ligne ${line.line}`}
			className={cn(
				"inline-flex shrink-0 items-center justify-center rounded-sm font-bold",
				size === "lg" ? "h-6 min-w-15 px-1.5 text-[13px]" : "h-[22px] min-w-[55px] px-1.5 text-xs",
				className,
			)}
			style={{ backgroundColor: line.color, color: line.textColor }}
		>
			{line.line}
		</span>
	);
}

/** La desserte d'une ligne : les terminus de ses sens, « Gare Part-Dieu V.Merle ↔ Cuire ». */
export function serviceOf(route: RouteDto): string {
	return [...new Set(route.directions.map((direction) => direction.headsigns[0]).filter(Boolean))].join(" ↔ ");
}

/** Une ligne dans un sélecteur : son cartouche, son numéro et sa desserte. */
export function LineOption({ route }: { route: RouteDto }) {
	return (
		<span className="flex min-w-0 items-center gap-2">
			<LineBadge line={route} />
			<span className="truncate">
				{route.line} - {serviceOf(route)}
			</span>
		</span>
	);
}
