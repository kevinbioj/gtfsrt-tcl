import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { PlusIcon } from "lucide-react";
import { useMemo } from "react";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { modificationId } from "@/lib/format";
import { useProvisionalStops, useStopReferences } from "@/lib/queries";

import { ACCESSIBILITY } from "./stop-draft";

/**
 * La base des arrêts provisoires : chacun avec les modifications qui le désignent. On en crée un, ou
 * l'on ouvre l'un d'eux, sur sa propre page.
 */
export function StopsPage() {
	const stops = useProvisionalStops();
	const references = useStopReferences();

	const stationNames = useMemo(
		() => new Map((references.data?.stations ?? []).map(([stationId, name]) => [stationId, name])),
		[references.data],
	);
	const zoneName = (zoneId: string | null) =>
		zoneId === null ? "—" : (references.data?.fareAreas.find((area) => area.areaId === zoneId)?.name ?? zoneId);
	const stationName = (stationId: string | null) =>
		stationId === null ? "—" : (stationNames.get(stationId) ?? stationId);

	return (
		<>
			<PageHeader title="Arrêts provisoires">
				<Button size="lg" asChild>
					<Link to="/stops/new" className="text-primary-foreground! no-underline">
						<PlusIcon data-icon="inline-start" />
						Nouvel arrêt
					</Link>
				</Button>
			</PageHeader>

			<div className="px-6 pt-5 pb-10">
				<section aria-label="Liste des arrêts provisoires" className="overflow-x-auto rounded-lg border bg-card">
					{stops.isPending ? (
						<div className="flex flex-col gap-2 p-4">
							<Skeleton className="h-10" />
							<Skeleton className="h-10" />
						</div>
					) : (
						<Table className="min-w-[960px]">
							<TableHeader className="bg-muted">
								<TableRow>
									{[
										"Identifiant",
										"Nom · description",
										"Code",
										"Quai",
										"Zone",
										"Station parente",
										"Accessible",
										"Utilisé par",
									].map((label) => (
										<TableHead key={label} className="text-xs font-semibold tracking-wider text-subtle uppercase">
											{label}
										</TableHead>
									))}
								</TableRow>
							</TableHeader>
							<TableBody>
								{(stops.data ?? []).map((stop) => {
									const accessibility = ACCESSIBILITY.find((option) => option.value === stop.wheelchairBoarding);
									return (
										<TableRow key={stop.stopId} className="relative">
											<TableCell className="font-mono font-semibold">
												<Link
													to="/stops/$stopId"
													params={{ stopId: stop.stopId }}
													// Étendu à toute la ligne : c'est elle qu'on clique. Les liens des usages passent au-dessus.
													className="text-foreground no-underline after:absolute after:inset-0 after:content-['']"
												>
													{stop.stopId}
												</Link>
											</TableCell>
											<TableCell className="whitespace-normal">
												<span className="flex flex-col gap-0.5">
													<span className="text-sm font-medium">{stop.name}</span>
													{stop.description ? <span className="text-subtle">{stop.description}</span> : null}
												</span>
											</TableCell>
											<TableCell className="font-mono">{stop.stopCode ?? "—"}</TableCell>
											<TableCell>{stop.platformCode ?? "—"}</TableCell>
											<TableCell>{zoneName(stop.zoneId)}</TableCell>
											<TableCell>{stationName(stop.parentStation)}</TableCell>
											<TableCell>
												<span className="inline-flex items-center gap-1.5">
													<span className={cn("size-2 rounded-full", accessibility?.dot)} />
													{accessibility?.label}
												</span>
											</TableCell>
											<TableCell>
												<span className="flex flex-wrap gap-1">
													{stop.usages.length === 0 ? <span className="text-muted-foreground">—</span> : null}
													{stop.usages.map((usage) => (
														<Link
															key={usage.uid}
															to="/modifications/$uid"
															params={{ uid: String(usage.uid) }}
															className="relative z-10 rounded-sm border bg-secondary px-1.5 py-px font-mono text-xs text-foreground no-underline"
														>
															{modificationId(usage.uid)}
														</Link>
													))}
												</span>
											</TableCell>
										</TableRow>
									);
								})}
								{stops.data?.length === 0 ? (
									<TableRow>
										<TableCell colSpan={8} className="py-7 text-center text-muted-foreground">
											Aucun arrêt provisoire pour l'instant.
										</TableCell>
									</TableRow>
								) : null}
							</TableBody>
						</Table>
					)}
				</section>
			</div>
		</>
	);
}
