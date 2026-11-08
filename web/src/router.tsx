import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { type AlertStatus, AlertsPage, STATUSES } from "@/pages/alerts/alerts-page";
import { ModificationEditorPage } from "@/pages/editor/editor-page";
import { ModificationsPage, type ModificationTab, TABS } from "@/pages/modifications/modifications-page";
import { StopEditorPage } from "@/pages/stops/stop-editor-page";
import { StopsPage } from "@/pages/stops/stops-page";

const rootRoute = createRootRoute({ component: AppShell });

// Ce que l'interface laisse choisir — filtres, élément ouvert, recherche — vit dans l'URL : on la
// recharge, on la partage, on y revient. Une valeur par défaut n'y figure pas.

/** Un texte, que le lecteur d'URL a pu prendre pour un nombre (« ?line=10 »). */
const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : typeof value === "number" ? String(value) : undefined;

const flag = (value: unknown): true | undefined => (value === true || value === "true" ? true : undefined);

const integer = (value: unknown): number | undefined => {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

/** Ne garde que les clés définies : l'URL ne porte pas de « ?q= » vide. */
const defined = <T extends Record<string, unknown>>(search: T): T =>
	Object.fromEntries(Object.entries(search).filter(([, value]) => value !== undefined)) as T;

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	beforeLoad: () => {
		throw redirect({ to: "/alerts" });
	},
});

export const alertsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/alerts",
	validateSearch: (
		search: Record<string, unknown>,
	): {
		/** L'alerte ouverte ; à défaut, la première de la liste. */
		alert?: string;
		/** Une alerte à créer s'ouvre, que rien n'enregistre encore. */
		new?: true;
		todo?: true;
		status?: AlertStatus;
		cause?: string;
		line?: string;
		q?: string;
		/** Le détail montre aussi les lignes et les sens sans suppression. */
		all?: true;
	} =>
		defined({
			alert: text(search.alert),
			new: flag(search.new),
			todo: flag(search.todo),
			status: Object.hasOwn(STATUSES, String(search.status)) ? (search.status as AlertStatus) : undefined,
			cause: text(search.cause),
			line: text(search.line),
			q: text(search.q),
			all: flag(search.all),
		}),
	component: AlertsPage,
});

export const modificationsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/modifications",
	validateSearch: (
		search: Record<string, unknown>,
	): {
		tab?: ModificationTab;
		line?: string;
		/** L'identifiant d'une étiquette, ou « none » : celles qui n'en portent aucune. */
		label?: string;
		q?: string;
	} =>
		defined({
			tab: TABS.some((entry) => entry.value !== "all" && entry.value === search.tab)
				? (search.tab as ModificationTab)
				: undefined,
			line: text(search.line),
			label: search.label === "none" ? "none" : integer(search.label)?.toString(),
			q: text(search.q),
		}),
	component: ModificationsPage,
});

export const newModificationRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/modifications/new",
	validateSearch: (search: Record<string, unknown>): { alert?: string; line?: string; direction?: number } =>
		defined({ alert: text(search.alert), line: text(search.line), direction: integer(search.direction) }),
	component: function NewModificationRoute() {
		const { alert } = newModificationRoute.useSearch();
		return <ModificationEditorPage uid={null} alert={alert ?? null} />;
	},
});

export const modificationRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/modifications/$uid",
	validateSearch: (search: Record<string, unknown>): { alert?: string; segment?: number } =>
		defined({
			/** L'info trafic d'où l'on vient, s'il y en a une : l'éditeur y ramène à l'enregistrement. */
			alert: text(search.alert),
			/** Le tronçon actif, compté à partir de 1 comme à l'écran ; le premier par défaut. */
			segment: (integer(search.segment) ?? 0) > 1 ? integer(search.segment) : undefined,
		}),
	component: function ModificationRoute() {
		const { uid } = modificationRoute.useParams();
		const { alert } = modificationRoute.useSearch();
		return <ModificationEditorPage key={uid} uid={Number(uid)} alert={alert ?? null} />;
	},
});

export const stopsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/stops",
	component: StopsPage,
});

export const newStopRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/stops/new",
	component: () => <StopEditorPage stopId={null} />,
});

export const stopRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/stops/$stopId",
	component: function StopRoute() {
		const { stopId } = stopRoute.useParams();
		return <StopEditorPage stopId={stopId} />;
	},
});

const routeTree = rootRoute.addChildren([
	indexRoute,
	alertsRoute,
	modificationsRoute,
	newModificationRoute,
	modificationRoute,
	stopsRoute,
	newStopRoute,
	stopRoute,
]);

/** La racine de l'interface telle que le navigateur la voit — « /gtfs-rt/tcl/admin » derrière le proxy. */
const basepath = new URL(document.baseURI).pathname.replace(/\/$/, "");

export const router = createRouter({ routeTree, basepath, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
