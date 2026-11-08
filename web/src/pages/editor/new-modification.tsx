import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { useState } from "react";

import { LineOption } from "@/components/line-badge";
import { SectionCard } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { plural } from "@/lib/format";
import { useAlerts, useCreateModification, useRoutes } from "@/lib/queries";

/**
 * Une nouvelle modification : sa ligne et son sens — ce qui ne change plus ensuite —, et une
 * description. Elle vise d'abord tous les tracés du sens ; on les choisit, et on dessine, une fois
 * créée, dans l'éditeur.
 */
export function NewModification({ alert }: { alert: string | null }) {
	const navigate = useNavigate();
	const search = useSearch({ from: "/modifications/new" });
	const routes = useRoutes();
	const alerts = useAlerts();
	const create = useCreateModification();
	// Depuis une info trafic, la première ligne qu'elle cite est proposée d'emblée.
	const cited = alerts.data?.find((entry) => entry.alertNumber === alert)?.lines[0]?.routeId ?? null;
	const routeId = search.line ?? cited;
	const directionId = search.direction ?? null;
	// Ligne et sens se lisent dans l'URL ; les choisir n'ajoute pas d'étape à l'historique.
	const choose = (change: { line?: string; direction?: number }) =>
		navigate({ to: "/modifications/new", search: (current) => ({ ...current, ...change }), replace: true });
	const [description, setDescription] = useState("");

	const route = routes.data?.find((entry) => entry.routeId === routeId);
	const direction = route?.directions.find((entry) => entry.directionId === directionId);

	const submit = () => {
		if (route === undefined || direction === undefined) return;
		create.mutate(
			{
				routeId: route.routeId,
				directionId: direction.directionId,
				description: description.trim() || null,
				patternIds: [],
				alertNumbers: alert === null ? [] : [alert],
			},
			{
				onSuccess: ({ uid }) =>
					navigate({
						to: "/modifications/$uid",
						params: { uid: String(uid) },
						search: alert === null ? {} : { alert },
					}),
			},
		);
	};

	return (
		<>
			<header className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b bg-card px-6 py-3.5">
				<div className="flex min-w-0 flex-[1_1_360px] flex-col gap-1">
					<span className="flex gap-1.5 text-[13px] text-muted-foreground">
						{alert !== null ? (
							<Link to="/alerts" search={{ alert }}>
								Alerte {alert}
							</Link>
						) : (
							<Link to="/modifications">Modifications</Link>
						)}
						<span aria-hidden="true">/</span>
						<span>Nouvelle</span>
					</span>
					<h1 className="m-0 text-xl font-semibold tracking-tight">Nouvelle modification</h1>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button variant="outline" size="lg" asChild>
						{alert !== null ? (
							<Link to="/alerts" search={{ alert }} className="text-foreground! no-underline">
								Annuler
							</Link>
						) : (
							<Link to="/modifications" className="text-foreground! no-underline">
								Annuler
							</Link>
						)}
					</Button>
					<Button size="lg" disabled={direction === undefined || create.isPending} onClick={submit}>
						Créer et dessiner le tracé
					</Button>
				</div>
			</header>
			<div className="max-w-2xl px-6 pt-5 pb-10">
				<SectionCard number="01" title="Ligne et sens">
					{routes.isPending ? (
						<Skeleton className="h-10" />
					) : (
						<Field className="gap-1.5">
							<FieldLabel htmlFor="new-line">Ligne</FieldLabel>
							<Select
								value={routeId ?? undefined}
								onValueChange={(value) => choose({ line: value, direction: undefined })}
							>
								<SelectTrigger id="new-line" className="h-10 w-full">
									<SelectValue placeholder="Choisir une ligne" />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										{(routes.data ?? []).map((entry) => (
											<SelectItem key={entry.routeId} value={entry.routeId}>
												<LineOption route={entry} />
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</Field>
					)}
					{route ? (
						<fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
							<legend className="pb-1.5 text-[13px] font-medium text-strong">Direction</legend>
							{route.directions.map((entry) => {
								const on = entry.directionId === directionId;
								return (
									<button
										key={entry.directionId}
										type="button"
										aria-pressed={on}
										onClick={() => choose({ line: route.routeId, direction: entry.directionId })}
										className={cn(
											"flex min-h-11 w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left",
											on ? "border-[#B9CDF3] bg-[#F7F9FE]" : "bg-card",
										)}
									>
										<span
											className={cn(
												"size-4 flex-none rounded-full bg-white",
												on ? "border-[5px] border-primary" : "border-2 border-neutral-dot",
											)}
										/>
										<span className="flex min-w-0 flex-1 flex-col gap-0.5">
											<span className="text-sm font-semibold">→ {entry.headsigns.join(" / ")}</span>
											<span className="text-xs text-subtle">{plural(entry.patterns.length, "tracé")}</span>
										</span>
										<span className="font-mono text-xs text-subtle">{entry.directionId}</span>
									</button>
								);
							})}
						</fieldset>
					) : null}
					<Field className="gap-1.5">
						<FieldLabel htmlFor="new-description">Description</FieldLabel>
						<Input
							id="new-description"
							maxLength={80}
							placeholder="ex. déviation par cours Lafayette"
							value={description}
							onChange={(event) => setDescription(event.target.value)}
						/>
					</Field>
				</SectionCard>
			</div>
		</>
	);
}
