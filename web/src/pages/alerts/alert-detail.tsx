import type { AlertDto, ModificationSummaryDto, StopGroupDto } from "@dto";
import { Link, useBlocker, useNavigate, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import {
	CircleCheckIcon,
	ClockIcon,
	PlusIcon,
	SendIcon,
	Trash2Icon,
	TriangleAlertIcon,
	UndoIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { LineBadge } from "@/components/line-badge";
import { copyPeriod, PeriodEditor, type PeriodForm, periodDto, periodForm } from "@/components/period-editor";
import { SectionCard, SpecName } from "@/components/section-card";
import {
	ALERT_PHASES,
	ALERT_PUBLICATIONS,
	MODIFICATION_STATES,
	STATE_BANNERS,
	StatusPill,
} from "@/components/status-pill";
import { StopStrip } from "@/components/stop-strip";
import { TripSetDialog, TripSetList } from "@/components/trip-sets";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { describePeriods, describeRanges, formatInstant, modificationId, plural } from "@/lib/format";
import { CAUSES, EFFECTS } from "@/lib/labels";
import {
	useCreateAlert,
	useCreateModification,
	useDeleteAlert,
	useRoutes,
	useSaveAlert,
	useSetAlertChecked,
	useSetAlertHidden,
} from "@/lib/queries";

import {
	type AlertForm,
	clearGroup,
	epochOfLocal,
	formOf,
	inputOf,
	isRemoved,
	isUnsaved,
	lastPeriodEnd,
	scopeOf,
	suggestionsOf,
	toggleStop,
	unpublishValue,
} from "./alert-form";
import { ImpactEditor } from "./impact-editor";
import { LinkEditor } from "./link-editor";
import { ModificationPicker } from "./modification-picker";
import { OwnPeriods } from "./own-periods";

/** Ce qu'on s'apprête à créer : la modification d'un sens suggéré, ou une page blanche. */
type Creation = { routeId: string; directionId: number } | "blank";

/**
 * Le détail d'une alerte : son texte, sa cause et son effet republiés, ses périodes, ce qu'elle
 * supprime — arrêts et courses — et les modifications qu'elle active. Tout se saisit dans un même
 * formulaire, enregistré d'un bloc ; la publication, elle, vaut tout de suite. Une modification ne se
 * crée que depuis une alerte enregistrée : elle s'y associe côté serveur.
 *
 * Une alerte créée à la main n'a rien de reçu : ni texte, ni période, ni impact à reprendre. Tout en
 * est saisi — son titre, directement en tête —, et elle se supprime à tout moment. Celle qu'ouvre
 * « Nouvelle alerte » n'existe pas encore (cf. `blankAlert`) : son premier enregistrement la crée, et la
 * quitter avant l'abandonne, sans rien demander.
 */
export function AlertDetail({ alert, modifications }: { alert: AlertDto; modifications: ModificationSummaryDto[] }) {
	const [form, setForm] = useState<AlertForm>(() => formOf(alert));
	const search = useSearch({ from: "/alerts" });
	const { custom } = alert;
	const unsaved = isUnsaved(alert);
	const update = useSaveAlert(alert.alertNumber);
	const createAlert = useCreateAlert();
	const save = unsaved ? createAlert : update;
	const setHidden = useSetAlertHidden(alert.alertNumber);
	const setChecked = useSetAlertChecked(alert.alertNumber);
	const remove = useDeleteAlert(alert.alertNumber);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const create = useCreateModification();
	const routes = useRoutes();
	const navigate = useNavigate();
	const [confirming, setConfirming] = useState<Creation | null>(null);

	const baseline = useMemo(() => JSON.stringify(inputOf(formOf(alert), alert)), [alert]);
	const current = JSON.stringify(inputOf(form, alert));
	const dirty = current !== baseline;

	// L'alerte se relit toutes les minutes. Tant qu'on n'y a rien touché, le formulaire la suit ; dès
	// qu'on l'a modifié, il garde la saisie.
	const previous = useRef(baseline);
	useEffect(() => {
		if (previous.current === baseline) return;
		if (current === previous.current) setForm(formOf(alert));
		previous.current = baseline;
	}, [baseline, current, alert]);
	// Une alerte qu'on modifie devient celle de l'URL : changer de filtre ne la quitte plus. Seul ce
	// qui en ouvre une autre, ou quitte la page, demande alors confirmation.
	// Celle qu'on crée n'a pas encore de numéro où se fixer, et s'abandonne sans rien demander.
	useEffect(() => {
		if (!unsaved && dirty && search.alert !== alert.alertNumber)
			navigate({ to: "/alerts", search: (current) => ({ ...current, alert: alert.alertNumber }), replace: true });
	}, [unsaved, dirty, search.alert, alert.alertNumber, navigate]);
	useBlocker({
		shouldBlockFn: ({ next }) =>
			!unsaved &&
			dirty &&
			!(next.routeId === "/alerts" && next.search.alert === alert.alertNumber) &&
			!window.confirm("Des changements de cette alerte ne sont pas enregistrés. Les abandonner ?"),
		enableBeforeUnload: () => !unsaved && dirty,
	});

	const patch = (change: Partial<AlertForm>) => setForm((current) => ({ ...current, ...change }));
	/** Les périodes propres d'une modification associée ; `null` : elle reprend celles de l'alerte. */
	const setOwnPeriods = (uid: number, periods: PeriodForm[] | null) =>
		setForm((current) => {
			const { [uid]: _, ...rest } = current.modificationPeriods;
			return { ...current, modificationPeriods: periods === null ? rest : { ...rest, [uid]: periods } };
		});
	// Celles que reprend une modification sans périodes propres : celles de l'alerte, telles qu'en cours de saisie.
	const inheritedPeriods = form.periods === null ? alert.sourcePeriods : form.periods.map(periodDto);
	const publication = ALERT_PUBLICATIONS[alert.publication];
	const phase = ALERT_PHASES[alert.phase];
	const byUid = new Map(modifications.map((entry) => [entry.uid, entry]));
	const lineIds = new Set(alert.lines.map((line) => line.routeId));
	const rewritten =
		!custom &&
		(form.headerText.trim() !== alert.received.headerText.trim() ||
			form.descriptionText.trim() !== alert.received.descriptionText.trim());
	const published = !alert.hidden;

	// Le premier enregistrement d'une alerte à créer la crée, et l'ouvre sous son numéro — sauf à
	// enchaîner sur autre chose (`then`), qui part ailleurs : ouvrir l'alerte démonterait ce formulaire,
	// et la suite avec lui.
	const submit = (then?: (saved: AlertDto) => void) =>
		save.mutate(inputOf(form, alert), {
			onSuccess: (saved) => {
				setForm(formOf(saved));
				if (unsaved) {
					toast.success(`Alerte ${saved.alertNumber} créée, en brouillon.`);
					if (then === undefined)
						navigate({
							to: "/alerts",
							search: (current) => ({ ...current, alert: saved.alertNumber, new: undefined }),
							replace: true,
							ignoreBlocker: true,
						});
				} else toast.success(`Alerte ${saved.alertNumber} enregistrée.`);
				then?.(saved);
			},
		});
	const savable = unsaved ? form.headerText.trim().length > 0 : dirty;

	// Les suggestions suivent l'impact tel qu'il est saisi, enregistré ou non.
	const suggestions = suggestionsOf(form.impact ?? alert.impact.received, routes.data ?? []);

	// Crée la modification d'un sens, tous tracés cochés, ou ouvre la page blanche. Juste après
	// l'enregistrement, l'alerte ne s'est pas encore relue : le garde-fou croirait la saisie perdue.
	const startCreation = (creation: Creation, alertNumber = alert.alertNumber) => {
		if (creation === "blank") {
			navigate({ to: "/modifications/new", search: { alert: alertNumber }, ignoreBlocker: true });
			return;
		}
		create.mutate(
			{ ...creation, description: null, patternIds: [], alertNumbers: [alertNumber] },
			{
				onSuccess: ({ uid }) =>
					navigate({
						to: "/modifications/$uid",
						params: { uid: String(uid) },
						search: { alert: alertNumber },
						ignoreBlocker: true,
					}),
			},
		);
	};
	// Une alerte à créer s'enregistre d'abord : une modification s'associe à une alerte qui existe.
	const mustSaveFirst = unsaved || dirty;
	const requestCreation = (creation: Creation) => (mustSaveFirst ? setConfirming(creation) : startCreation(creation));

	return (
		<div className="flex min-w-0 flex-col gap-4">
			<div className="flex flex-col gap-4 rounded-lg border bg-card px-5 py-4">
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
					{/* L'en-tête se replie dans son coin plutôt que de renvoyer les actions à la ligne. */}
					<div className="flex min-w-0 grow basis-72 flex-wrap items-center gap-2.5">
						<span className="font-mono text-xs text-muted-foreground">
							{unsaved
								? "Nouvelle alerte · non enregistrée"
								: `N° ${alert.alertNumber} · ${custom ? "créée" : "reçue"} le ${formatInstant(alert.firstSeenAt)}${
										custom && alert.publishedAt !== null ? ` · publiée le ${formatInstant(alert.publishedAt)}` : ""
									}${
										custom && alert.publishedAt !== null && alert.unpublishAt !== null
											? ` · dépubliée le ${formatInstant(alert.unpublishAt)}`
											: ""
									}`}
						</span>
						{unsaved ? null : <StatusPill tone={phase.tone}>{phase.label}</StatusPill>}
						<StatusPill tone={publication.tone}>{publication.label}</StatusPill>
						{custom ? <StatusPill tone="neutral">Personnalisée</StatusPill> : null}
						{dirty && !unsaved ? <Badge variant="outline">Modifications non enregistrées</Badge> : null}
					</div>
					<div className="ml-auto flex shrink-0 flex-wrap items-center gap-2.5">
						{custom ? null : (
							<Button
								variant="outline"
								size="lg"
								aria-pressed={alert.checkedAt !== null}
								className={cn(alert.checkedAt !== null && "border-success text-success hover:text-success")}
								disabled={setChecked.isPending}
								onClick={() => setChecked.mutate(alert.checkedAt === null)}
							>
								<CircleCheckIcon data-icon="inline-start" />
								{alert.checkedAt === null ? "Marquer traitée" : `Traitée le ${formatInstant(alert.checkedAt)}`}
							</Button>
						)}
						<Tooltip>
							<TooltipTrigger asChild>
								<span className="inline-flex">
									<Button
										variant="outline"
										size="lg"
										aria-pressed={published}
										disabled={setHidden.isPending || unsaved || (!alert.inFeed && !custom) || (!published && dirty)}
										onClick={() => setHidden.mutate(published)}
									>
										{published ? <UndoIcon data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}
										{published ? "Dépublier" : "Publier"}
									</Button>
								</span>
							</TooltipTrigger>
							{unsaved ? (
								<TooltipContent>Enregistrer d'abord l'alerte.</TooltipContent>
							) : !published && dirty ? (
								<TooltipContent>Enregistrer d'abord les modifications.</TooltipContent>
							) : null}
						</Tooltip>
						{alert.inFeed ? (
							// Un bouton désactivé ne reçoit pas le survol : c'est son enveloppe qui porte l'infobulle.
							<Tooltip>
								<TooltipTrigger asChild>
									<span className="inline-flex">
										<Button variant="outline" size="lg" disabled aria-label="Supprimer l'alerte">
											<Trash2Icon />
										</Button>
									</span>
								</TooltipTrigger>
								<TooltipContent>
									Encore au flux, elle reviendrait au prochain relevé : la dépublier plutôt.
								</TooltipContent>
							</Tooltip>
						) : unsaved ? null : (
							<Button
								variant="outline"
								size="lg"
								aria-label="Supprimer l'alerte"
								className="text-destructive hover:text-destructive"
								disabled={remove.isPending}
								onClick={() => setConfirmDelete(true)}
							>
								<Trash2Icon />
							</Button>
						)}
						{unsaved ? (
							<Button
								variant="outline"
								size="lg"
								onClick={() => navigate({ to: "/alerts", search: (current) => ({ ...current, new: undefined }) })}
							>
								Abandonner
							</Button>
						) : (
							<Button variant="outline" size="lg" disabled={!dirty} onClick={() => setForm(formOf(alert))}>
								Annuler
							</Button>
						)}
						<Button size="lg" disabled={!savable || save.isPending} onClick={() => submit()}>
							{unsaved ? "Créer" : "Enregistrer"}
						</Button>
					</div>
				</div>
				{custom ? (
					// Créée à la main, son titre se saisit en tête : c'est lui qui la nomme.
					<Field className="gap-1">
						<FieldLabel htmlFor="alert-header" className="text-xs text-muted-foreground">
							Titre <SpecName>header_text</SpecName>
						</FieldLabel>
						<Input
							id="alert-header"
							autoFocus={unsaved}
							maxLength={300}
							placeholder="Titre de l'alerte"
							aria-invalid={form.headerText.trim().length === 0 || undefined}
							className="h-12 text-[22px]! font-semibold tracking-tight"
							value={form.headerText}
							onChange={(event) => patch({ headerText: event.target.value })}
						/>
					</Field>
				) : (
					<h2 className="m-0 text-[22px] font-semibold tracking-tight">
						{form.headerText || alert.received.headerText || "Sans titre"}
					</h2>
				)}
				<div className="grid grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-x-4 gap-y-3">
					<Field className="gap-1.5">
						<FieldLabel htmlFor="alert-cause">
							Cause <SpecName>cause</SpecName>
						</FieldLabel>
						<Select value={form.cause ?? "UNKNOWN_CAUSE"} onValueChange={(value) => patch({ cause: value })}>
							<SelectTrigger id="alert-cause" className="h-10 w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{Object.entries(CAUSES).map(([value, label]) => (
										<SelectItem key={value} value={value}>
											{label} — {value}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</Field>
					<Field className="gap-1.5">
						<FieldLabel htmlFor="alert-effect">
							Effet <SpecName>effect</SpecName>
						</FieldLabel>
						<Select value={form.effect ?? "UNKNOWN_EFFECT"} onValueChange={(value) => patch({ effect: value })}>
							<SelectTrigger id="alert-effect" className="h-10 w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{Object.entries(EFFECTS).map(([value, label]) => (
										<SelectItem key={value} value={value}>
											{label} — {value}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</Field>
				</div>
				{alert.phaseDetail ? (
					<p
						className={cn(
							"m-0 flex items-center gap-2.5 rounded-md px-3 py-2.5 text-[13px]",
							STATE_BANNERS[phase.tone],
						)}
					>
						<ClockIcon aria-hidden="true" className="size-4 flex-none" />
						{alert.phaseDetail}
					</p>
				) : null}
			</div>

			{alert.warnings.length > 0 ? (
				<div className="flex items-start gap-3 rounded-lg border border-warning-border bg-warning px-4 py-3.5 text-[#6E3500]">
					<TriangleAlertIcon aria-hidden="true" className="mt-px size-[18px] flex-none" />
					<span className="flex flex-col gap-0.5">
						<strong className="font-semibold">À vérifier</strong>
						{alert.warnings.map((warning) => (
							<span key={warning} className="text-[13px]">
								{warning}
							</span>
						))}
					</span>
				</div>
			) : null}

			<ImpactEditor value={form.impact} received={alert.impact.received} onChange={(impact) => patch({ impact })} />

			<SectionCard
				title="Texte de l'alerte"
				actions={
					custom ? undefined : (
						<>
							<span
								className={cn(
									"rounded-sm px-2 py-0.5 text-xs font-medium",
									rewritten ? "bg-warning text-warning-foreground" : "bg-neutral text-neutral-foreground",
								)}
							>
								{rewritten ? "Réécrit" : "Texte reçu"}
							</span>
							<Button
								variant="outline"
								disabled={!rewritten}
								onClick={() =>
									patch({ headerText: alert.received.headerText, descriptionText: alert.received.descriptionText })
								}
							>
								Reprendre le texte reçu
							</Button>
						</>
					)
				}
			>
				<div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-4">
					{custom ? null : (
						<div className="flex flex-col gap-2.5">
							<div className="flex flex-col gap-1.5">
								<span className="text-[13px] font-medium text-strong">Titre reçu</span>
								<p className="m-0 flex min-h-10 items-center rounded-md border border-[#E2E5E1] bg-muted px-3.5 py-2 text-[13px] text-strong">
									{alert.received.headerText}
								</p>
							</div>
							<div className="flex flex-1 flex-col gap-1.5">
								<span className="text-[13px] font-medium text-strong">Description reçue</span>
								<div
									className="flex-1 rounded-md border border-[#E2E5E1] bg-muted px-3.5 py-3 text-[13px] leading-relaxed text-strong [&_a]:underline [&_img]:max-w-full [&_li]:ml-4 [&_li]:list-disc [&_p]:my-1"
									// Nettoyé côté serveur (cf. `sanitizeHtml`) : listes, liens et plans, rien qui s'exécute.
									// biome-ignore lint/security/noDangerouslySetInnerHtml: le HTML est nettoyé par le serveur.
									dangerouslySetInnerHTML={{ __html: alert.received.descriptionHtml }}
								/>
							</div>
						</div>
					)}
					<div className="flex flex-col gap-2.5">
						{custom ? null : (
							<Field className="gap-1.5">
								<FieldLabel htmlFor="alert-header">
									Titre publié <SpecName>header_text</SpecName>
								</FieldLabel>
								<Input
									id="alert-header"
									className="h-10"
									value={form.headerText}
									onChange={(event) => patch({ headerText: event.target.value })}
								/>
							</Field>
						)}
						<Field className="gap-1.5">
							<FieldLabel htmlFor="alert-description">
								Description publiée <SpecName>description_text</SpecName>
							</FieldLabel>
							<Textarea
								id="alert-description"
								rows={7}
								value={form.descriptionText}
								onChange={(event) => patch({ descriptionText: event.target.value })}
							/>
						</Field>
					</div>
				</div>
			</SectionCard>

			<LinkEditor value={form} received={alert.received} custom={custom} onChange={patch} />

			<SectionCard
				title="Périodes d'application"
				hint={<SpecName>active_period</SpecName>}
				actions={
					custom ? undefined : (
						<>
							<span
								className={cn(
									"rounded-sm px-2 py-0.5 text-xs font-medium",
									form.periods === null ? "bg-neutral text-neutral-foreground" : "bg-warning text-warning-foreground",
								)}
							>
								{form.periods === null ? "D'après le flux" : "Saisies"}
							</span>
							{form.periods !== null ? (
								<Button variant="outline" onClick={() => patch({ periods: null })}>
									Revenir au flux
								</Button>
							) : null}
						</>
					)
				}
			>
				{form.periods === null ? (
					<div className="flex flex-wrap items-center gap-3 border-t border-divider pt-3.5">
						<p className="m-0 flex-1 text-[13px] text-strong">
							{alert.sourcePeriods.length === 0
								? "Le flux n'annonce aucune période : l'alerte vaut tant qu'elle y figure."
								: `Le flux annonce : ${describePeriods(alert.sourcePeriods)}.`}
						</p>
						<Button variant="outline" onClick={() => patch({ periods: alert.sourcePeriods.map(periodForm) })}>
							Corriger les périodes
						</Button>
					</div>
				) : (
					<>
						{custom && form.periods.length === 0 ? (
							<p className="m-0 border-t border-divider pt-3.5 text-[13px] text-muted-foreground">
								Aucune période : elle vaut tant qu'elle est publiée.
							</p>
						) : null}
						<PeriodEditor periods={form.periods} onChange={(periods) => patch({ periods })} />
					</>
				)}
				{custom ? <UnpublishField form={form} onChange={patch} /> : null}
				{alert.feedPeriods !== null ? (
					<dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-divider pt-3.5 text-[13px]">
						{custom ? null : (
							<>
								<dt className="text-muted-foreground">
									Reçue du flux amont <SpecName>active_period</SpecName>
								</dt>
								<dd className="m-0 text-strong">{describeRanges(alert.feedPeriods.received)}</dd>
							</>
						)}
						<dt className="text-muted-foreground">
							Communication {custom ? "publiée" : "republiée"} <SpecName>communication_period</SpecName>
						</dt>
						<dd className="m-0 text-strong">
							{custom && alert.publishedAt === null
								? alert.unpublishAt === null
									? "Dès sa publication, tant qu'elle reste publiée"
									: `Dès sa publication, jusqu'au ${formatInstant(alert.unpublishAt)}`
								: describeRanges(alert.feedPeriods.communication)}
						</dd>
						<dt className="text-muted-foreground">
							Impact {custom ? "publié" : "republié"} <SpecName>impact_period</SpecName>
						</dt>
						<dd className="m-0 text-strong">{describeRanges(alert.feedPeriods.impact)}</dd>
					</dl>
				) : null}
			</SectionCard>

			<SectionCard title="Arrêts supprimés">
				{alert.stopGroups.map((group) => (
					<StopGroup
						key={scopeOf(group)}
						group={group}
						form={form}
						onToggle={(stopId) => setForm((current) => toggleStop(current, group, stopId))}
						onClear={() => setForm((current) => clearGroup(current, group))}
					/>
				))}
				{alert.stopGroups.length === 0 ? (
					<p className="m-0 border-t border-divider pt-3.5 text-[13px] text-muted-foreground">
						{custom ? "Aucune ligne dans l'impact enregistré." : "Aucune ligne citée."}
					</p>
				) : null}
			</SectionCard>

			<SectionCard
				title="Courses supprimées"
				hint={plural(form.tripSets.filter((set) => set.enabled).length, "ensemble actif", "ensembles actifs")}
				actions={
					<TripSetDialog
						source={`/alerts/${encodeURIComponent(alert.alertNumber)}`}
						lines={alert.lines}
						onAdd={(set) => patch({ tripSets: [...form.tripSets, set] })}
					/>
				}
			>
				<TripSetList sets={form.tripSets} onChange={(tripSets) => patch({ tripSets })} />
			</SectionCard>

			<SectionCard
				title="Modifications associées"
				actions={
					<>
						<Button variant="outline" asChild>
							<Link
								to="/modifications/new"
								search={{ alert: alert.alertNumber }}
								className="text-foreground! no-underline"
								// Une saisie en cours se propose d'abord à l'enregistrement (cf. `requestCreation`).
								onClick={(event) => {
									if (!mustSaveFirst) return;
									event.preventDefault();
									setConfirming("blank");
								}}
							>
								<PlusIcon data-icon="inline-start" />
								Nouvelle modification
							</Link>
						</Button>
						<ModificationPicker
							modifications={modifications.filter((entry) => !form.modifications.includes(entry.uid))}
							lines={lineIds}
							onPick={(uid) => patch({ modifications: [...form.modifications, uid] })}
						/>
					</>
				}
			>
				{form.modifications.map((uid) => {
					const entry = byUid.get(uid);
					const state = entry ? MODIFICATION_STATES[entry.state] : undefined;
					return (
						<div key={uid} className="flex min-h-13 flex-wrap items-center gap-2.5 border-t border-divider">
							<span className="font-mono text-[13px] font-semibold">{modificationId(uid)}</span>
							{entry ? <LineBadge line={entry.line} /> : null}
							<span className="min-w-0 flex-[1_1_220px]">
								{entry ? `→ ${entry.headsigns.join(" / ")}${entry.description ? ` · ${entry.description}` : ""}` : "…"}
							</span>
							<OwnPeriods
								label={modificationId(uid)}
								own={form.modificationPeriods[uid]}
								inherited={inheritedPeriods}
								seed={() =>
									form.periods === null ? alert.sourcePeriods.map(periodForm) : form.periods.map(copyPeriod)
								}
								onChange={(periods) => setOwnPeriods(uid, periods)}
							/>
							{state && alert.modifications.includes(uid) ? (
								<StatusPill tone={state.tone}>{state.label}</StatusPill>
							) : null}
							{!alert.modifications.includes(uid) ? <Badge variant="outline">À enregistrer</Badge> : null}
							<Link to="/modifications/$uid" params={{ uid: String(uid) }} className="px-1.5 text-[13px] font-medium">
								Ouvrir
							</Link>
							<Button
								variant="ghost"
								size="icon-lg"
								aria-label={`Dissocier ${modificationId(uid)}`}
								onClick={() => {
									const { [uid]: _, ...modificationPeriods } = form.modificationPeriods;
									patch({ modifications: form.modifications.filter((other) => other !== uid), modificationPeriods });
								}}
							>
								<XIcon />
							</Button>
						</div>
					);
				})}
				{form.modifications.length === 0 ? (
					<p className="m-0 border-t border-divider pt-3.5 text-[13px] text-muted-foreground">
						Aucune modification associée.
					</p>
				) : null}
			</SectionCard>

			<SectionCard title="Modifications suggérées" hint="un sens par ligne de l'impact" className="gap-2">
				{suggestions.map(({ route, direction }) => {
					const existing = form.modifications.filter((uid) => {
						const entry = byUid.get(uid);
						return entry?.routeId === route.routeId && entry.directionId === direction.directionId;
					});
					return (
						<div
							key={scopeOf({ routeId: route.routeId, directionId: direction.directionId })}
							className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-divider py-1"
						>
							<LineBadge line={route} />
							<span className="min-w-0 flex-[1_1_220px] text-[13px]">→ {direction.headsigns.join(" / ")}</span>
							<span className="text-[13px] text-muted-foreground">
								{existing.length > 0
									? `Déjà associée : ${existing.map(modificationId).join(", ")}`
									: plural(direction.patterns.length, "tracé")}
							</span>
							<Button
								variant="outline"
								size="sm"
								disabled={create.isPending || save.isPending}
								onClick={() => requestCreation({ routeId: route.routeId, directionId: direction.directionId })}
							>
								<PlusIcon data-icon="inline-start" />
								Créer la modification
							</Button>
						</div>
					);
				})}
				{suggestions.length === 0 ? (
					<p className="m-0 border-t border-divider pt-3.5 text-[13px] text-muted-foreground">
						Aucune ligne dans l'impact.
					</p>
				) : null}
			</SectionCard>

			<AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Supprimer l'alerte {alert.alertNumber} ?</AlertDialogTitle>
						<AlertDialogDescription>
							Ses périodes, ses arrêts supprimés et ses courses annulées disparaissent.
							{alert.modifications.length === 1
								? " La modification associée est conservée, mais n'y est plus rattachée."
								: alert.modifications.length > 1
									? ` Les ${alert.modifications.length} modifications associées sont conservées, mais n'y sont plus rattachées.`
									: ""}{" "}
							Cela ne se défait pas.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Annuler</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() =>
								remove.mutate(undefined, {
									onSuccess: () => navigate({ to: "/alerts", search: {}, ignoreBlocker: true }),
								})
							}
						>
							Supprimer
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog open={confirming !== null} onOpenChange={(open) => (open ? undefined : setConfirming(null))}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Enregistrer l'alerte d'abord ?</AlertDialogTitle>
						<AlertDialogDescription>
							{unsaved
								? "L'alerte n'existe pas encore. Elle sera créée avant la modification, qui s'y associera."
								: `Des changements de l'alerte ${alert.alertNumber} ne sont pas enregistrés. Ils le seront avant de créer la modification, qui s'y associera.`}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Annuler</AlertDialogCancel>
						<AlertDialogAction
							disabled={save.isPending || !savable}
							onClick={() => {
								const creation = confirming;
								setConfirming(null);
								if (creation !== null) submit((saved) => startCreation(creation, saved.alertNumber));
							}}
						>
							Enregistrer et créer
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

/** Les arrêts d'une ligne dans un sens, sur un schéma où chacun se bascule d'un clic. */
function StopGroup({
	group,
	form,
	onToggle,
	onClear,
}: {
	group: StopGroupDto;
	form: AlertForm;
	onToggle: (stopId: string) => void;
	onClear: () => void;
}) {
	const stops = group.stops.map((stop) => ({ ...stop, removed: isRemoved(form, group, stop) }));
	const removedCount = stops.filter((stop) => stop.removed).length;
	const tag =
		group.replacedBy.length > 0
			? {
					label: `Remplacé par ${group.replacedBy.map(modificationId).join(", ")}`,
					className: "bg-info text-info-foreground",
				}
			: null;

	return (
		<div className="flex flex-col gap-2.5 border-t border-divider pt-3.5 pb-1.5">
			<div className="flex flex-wrap items-center gap-2">
				<LineBadge line={group.line} />
				<span>
					Direction <span className="font-semibold">{group.headsign}</span>
				</span>
				<span className="text-[13px] text-muted-foreground">
					{removedCount === 0 ? "aucun arrêt supprimé" : plural(removedCount, "arrêt supprimé", "arrêts supprimés")}
				</span>
				{tag ? (
					<span className={cn("rounded-sm px-2 py-0.5 text-xs font-medium", tag.className)}>{tag.label}</span>
				) : null}
				<span className="flex-1" />
				{removedCount > 0 ? (
					<Button variant="ghost" size="sm" onClick={onClear}>
						Tout rétablir
					</Button>
				) : null}
			</div>
			<StopStrip stops={stops} color={group.line.color} onToggle={onToggle} />
		</div>
	);
}

/**
 * La dépublication programmée d'une alerte créée à la main, parmi ses périodes : à l'échéance, elle sort
 * du flux et repasse en brouillon, comme dépubliée à la main — c'est la fin de sa communication. Elle
 * suit la fin de la dernière période tant qu'on n'en saisit pas une autre, et n'est pas permise quand
 * une période court à nouvel avis (cf. `unpublishValue`). Elle s'enregistre avec le reste, et peut se
 * programmer dès le brouillon : elle ne vaudra qu'une fois l'alerte publiée.
 */
function UnpublishField({ form, onChange }: { form: AlertForm; onChange: (change: Partial<AlertForm>) => void }) {
	const end = lastPeriodEnd(form.periods ?? []);
	const open = end === "open";
	const value = unpublishValue(form);
	const at = epochOfLocal(value);
	const past = at !== null && at * 1000 <= Date.now();
	const follows = form.unpublishFollows && value !== "";
	return (
		<div className="flex flex-wrap items-end gap-x-4 gap-y-3 border-t border-divider pt-3.5">
			<label className="flex flex-col gap-1.5 text-[13px] font-medium text-strong">
				<span>
					Dépublication automatique <SpecName>communication_period.end</SpecName>
				</span>
				<Input
					type="datetime-local"
					className="h-10 w-auto"
					value={value}
					disabled={open}
					aria-invalid={past || undefined}
					onChange={(event) => onChange({ unpublishAt: event.target.value, unpublishFollows: false })}
				/>
			</label>
			<p
				className={cn(
					"m-0 flex-1 basis-60 self-center text-[13px]",
					past ? "text-destructive" : "text-muted-foreground",
				)}
			>
				{open
					? "Une période court à nouvel avis : pas de dépublication automatique."
					: past
						? "Cette date est passée : la dépublication doit être programmée dans le futur."
						: value === ""
							? "Facultative. Sans date, l'alerte reste au flux jusqu'à ce qu'on la dépublie."
							: follows
								? "La fin de la dernière période : l'alerte sort alors du flux et repasse en brouillon."
								: "À cette date, l'alerte sort du flux et repasse en brouillon."}
			</p>
			{!open && !form.unpublishFollows && end !== null && end !== value ? (
				<Button variant="outline" size="lg" onClick={() => onChange({ unpublishFollows: true })}>
					Fin des périodes
				</Button>
			) : null}
			{value === "" ? null : (
				<Button variant="outline" size="lg" onClick={() => onChange({ unpublishAt: "", unpublishFollows: false })}>
					Ne pas dépublier
				</Button>
			)}
		</div>
	);
}
