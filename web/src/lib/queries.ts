import type {
	AlertDto,
	AlertInputDto,
	AllStopsDto,
	DepartureDayDto,
	LabelAssignmentDto,
	LabelDto,
	MessageDto,
	ModificationDetailDto,
	ModificationInputDto,
	ModificationSummaryDto,
	NewLabelDto,
	NewModificationDto,
	ProvisionalStopDto,
	ProvisionalStopInput,
	RouteDto,
	StatusDto,
	StopReferencesDto,
} from "@dto";
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ApiError, api } from "./api";

/** Les clés du cache : une saisie invalide ce qu'elle a pu changer, et ce qui en dépend. */
export const keys = {
	status: ["status"] as const,
	routes: ["routes"] as const,
	alerts: ["alerts"] as const,
	alert: (alertNumber: string) => ["alerts", alertNumber] as const,
	/** Rangés sous leur source — « /alerts/87462 » sous `alerts` —, ils tombent avec elle. */
	departures: (source: string, routeId: string, directionId: number) =>
		[...source.split("/").filter(Boolean), "departures", routeId, directionId] as const,
	modifications: ["modifications"] as const,
	modification: (uid: number) => ["modifications", uid] as const,
	labels: ["labels"] as const,
	provisionalStops: ["provisional-stops"] as const,
	stopReferences: ["stop-references"] as const,
	allStops: ["stops", "all"] as const,
};

export function useStatus() {
	return useQuery({ queryKey: keys.status, queryFn: () => api<StatusDto>("/status"), refetchInterval: 30_000 });
}

const routesQuery = queryOptions({
	queryKey: keys.routes,
	queryFn: () => api<RouteDto[]>("/routes"),
	staleTime: 10 * 60_000,
});

export function useRoutes() {
	return useQuery(routesQuery);
}

const cartridgesOf = (routes: RouteDto[]) =>
	new Map(routes.flatMap((route) => (route.cartridgeHref === null ? [] : [[route.routeId, route.cartridgeHref]])));

/** routeId → pictogramme de la ligne, lu dans la même requête que les lignes. */
export function useCartridges() {
	return useQuery({ ...routesQuery, select: cartridgesOf });
}

export function useAlerts() {
	return useQuery({ queryKey: keys.alerts, queryFn: () => api<AlertDto[]>("/alerts"), refetchInterval: 60_000 });
}

/** Une alerte seule, quand on l'ouvre : `null` n'interroge rien. */
export function useAlert(alertNumber: string | null) {
	return useQuery({
		queryKey: keys.alert(alertNumber ?? ""),
		queryFn: () => api<AlertDto>(`/alerts/${encodeURIComponent(alertNumber ?? "")}`),
		enabled: alertNumber !== null,
		retry: false,
	});
}

/** Les départs qu'une info trafic ou une modification (`source`, « /alerts/87462 ») peut annuler. */
export function useDepartures(source: string, routeId: string | null, directionId: number | null) {
	return useQuery({
		queryKey: keys.departures(source, routeId ?? "", directionId ?? -1),
		queryFn: () =>
			api<DepartureDayDto[]>(
				`${source}/departures?routeId=${encodeURIComponent(routeId ?? "")}&directionId=${directionId}`,
			),
		enabled: routeId !== null && directionId !== null,
		placeholderData: keepPreviousData,
	});
}

export function useModifications() {
	return useQuery({
		queryKey: keys.modifications,
		queryFn: async () => (await api<{ modifications: ModificationSummaryDto[] }>("/modifications")).modifications,
		refetchInterval: 60_000,
	});
}

export function useLabels() {
	return useQuery({ queryKey: keys.labels, queryFn: () => api<LabelDto[]>("/labels") });
}

/** Crée une étiquette, posée d'emblée sur les modifications données. */
export function useCreateLabel() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (input: NewLabelDto) => api<LabelDto>("/labels", { method: "POST", body: input }),
		onSuccess: () =>
			Promise.all([
				client.invalidateQueries({ queryKey: keys.labels }),
				client.invalidateQueries({ queryKey: keys.modifications }),
			]),
		onError: reportError,
	});
}

/** Pose une étiquette sur des modifications, ou la leur retire. Rien de publié n'en dépend. */
export function useSetLabel() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: ({ labelId, ...body }: LabelAssignmentDto & { labelId: number }) =>
			api<MessageDto>(`/labels/${labelId}/modifications`, { method: "PUT", body }),
		onSuccess: () => client.invalidateQueries({ queryKey: keys.modifications }),
		onError: reportError,
	});
}

export function useModification(uid: number | null) {
	return useQuery({
		queryKey: keys.modification(uid ?? 0),
		queryFn: () => api<ModificationDetailDto>(`/modifications/${uid}`),
		enabled: uid !== null,
	});
}

export function useProvisionalStops() {
	return useQuery({ queryKey: keys.provisionalStops, queryFn: () => api<ProvisionalStopDto[]>("/provisional-stops") });
}

export function useStopReferences() {
	return useQuery({
		queryKey: keys.stopReferences,
		queryFn: () => api<StopReferencesDto>("/stop-references"),
		staleTime: 10 * 60_000,
	});
}

export function useAllStops() {
	return useQuery({ queryKey: keys.allStops, queryFn: () => api<AllStopsDto>("/stops/all"), staleTime: 5 * 60_000 });
}

/** Une erreur de saisie se dit dans un toast ; le formulaire, lui, reste tel quel. */
function reportError(error: unknown) {
	toast.error(error instanceof ApiError ? error.message : "La requête a échoué.");
}

/**
 * Après une saisie, tout ce qui en dépend se relit : une modification associée change l'état d'une
 * alerte, une alerte dépubliée celui de ses modifications, et la barre latérale compte les deux.
 */
function useInvalidateAll() {
	const client = useQueryClient();
	return () =>
		Promise.all([
			client.invalidateQueries({ queryKey: keys.alerts }),
			client.invalidateQueries({ queryKey: keys.modifications }),
			client.invalidateQueries({ queryKey: keys.status }),
			client.invalidateQueries({ queryKey: keys.provisionalStops }),
		]);
}

export function useSaveAlert(alertNumber: string) {
	const invalidate = useInvalidateAll();
	return useMutation({
		mutationFn: (input: AlertInputDto) =>
			api<AlertDto>(`/alerts/${encodeURIComponent(alertNumber)}`, { method: "PUT", body: input }),
		onSuccess: () => invalidate(),
		onError: reportError,
	});
}

/**
 * Crée une alerte à la main, en brouillon, d'après tout ce qui s'en saisit : c'est son premier
 * enregistrement. Elle entre aussitôt dans la liste en cache, pour s'ouvrir sans attendre sa relecture.
 */
export function useCreateAlert() {
	const client = useQueryClient();
	const invalidate = useInvalidateAll();
	return useMutation({
		mutationFn: (input: AlertInputDto) => api<AlertDto>("/alerts", { method: "POST", body: input }),
		onSuccess: (created) => {
			client.setQueryData<AlertDto[]>(keys.alerts, (list) => [created, ...(list ?? [])]);
			return invalidate();
		},
		onError: reportError,
	});
}

export function useSetAlertHidden(alertNumber: string) {
	const invalidate = useInvalidateAll();
	return useMutation({
		mutationFn: (hidden: boolean) =>
			api<MessageDto>(`/alerts/${encodeURIComponent(alertNumber)}/hidden`, { method: "PUT", body: { hidden } }),
		onSuccess: (result) => {
			toast.success(result.message);
			return invalidate();
		},
		onError: reportError,
	});
}

export function useDeleteAlert(alertNumber: string) {
	const invalidate = useInvalidateAll();
	return useMutation({
		mutationFn: () => api<MessageDto>(`/alerts/${encodeURIComponent(alertNumber)}`, { method: "DELETE" }),
		onSuccess: (result) => {
			toast.success(result.message);
			return invalidate();
		},
		onError: reportError,
	});
}

export function useSetAlertChecked(alertNumber: string) {
	const invalidate = useInvalidateAll();
	return useMutation({
		mutationFn: (checked: boolean) =>
			api<MessageDto>(`/alerts/${encodeURIComponent(alertNumber)}/checked`, { method: "PUT", body: { checked } }),
		onSuccess: () => invalidate(),
		onError: reportError,
	});
}

export function useSetManual() {
	const invalidate = useInvalidateAll();
	return useMutation({
		mutationFn: ({ uid, active }: { uid: number; active: boolean }) =>
			api<MessageDto>(`/modifications/${uid}/manual`, { method: "PUT", body: { active } }),
		onSuccess: () => invalidate(),
		onError: reportError,
	});
}

export function useBulk() {
	const invalidate = useInvalidateAll();
	return useMutation({
		mutationFn: (body: { action: "delete" | "activate" | "deactivate"; uids: number[] }) =>
			api<MessageDto>("/bulk", { method: "POST", body }),
		onSuccess: (result) => {
			toast.success(result.message);
			return invalidate();
		},
		onError: reportError,
	});
}

export function useCreateModification() {
	const invalidate = useInvalidateAll();
	return useMutation({
		mutationFn: (input: NewModificationDto) => api<{ uid: number }>("/modifications", { method: "POST", body: input }),
		onSuccess: () => invalidate(),
		onError: reportError,
	});
}

export function useSaveModification(uid: number) {
	const client = useQueryClient();
	const invalidate = useInvalidateAll();
	return useMutation({
		mutationFn: (input: ModificationInputDto) =>
			api<ModificationDetailDto>(`/modifications/${uid}`, { method: "PUT", body: input }),
		onSuccess: (detail) => {
			client.setQueryData(keys.modification(uid), detail);
			return invalidate();
		},
		onError: reportError,
	});
}

export function useDeleteModification() {
	const invalidate = useInvalidateAll();
	return useMutation({
		mutationFn: (uid: number) => api<MessageDto>(`/modifications/${uid}`, { method: "DELETE" }),
		onSuccess: (result) => {
			toast.success(result.message);
			return invalidate();
		},
		onError: reportError,
	});
}

export function useSaveProvisionalStop() {
	const client = useQueryClient();
	const invalidate = useInvalidateAll();
	return useMutation({
		mutationFn: ({ stopId, input }: { stopId: string | null; input: ProvisionalStopInput }) =>
			stopId === null
				? api<ProvisionalStopDto>("/provisional-stops", { method: "POST", body: input })
				: api<ProvisionalStopDto>(`/provisional-stops/${encodeURIComponent(stopId)}`, { method: "PUT", body: input }),
		onSuccess: () => Promise.all([invalidate(), client.invalidateQueries({ queryKey: keys.allStops })]),
		onError: reportError,
	});
}

export function useDeleteProvisionalStop() {
	const client = useQueryClient();
	const invalidate = useInvalidateAll();
	return useMutation({
		mutationFn: (stopId: string) =>
			api<MessageDto & { withdrawn: number }>(`/provisional-stops/${encodeURIComponent(stopId)}`, { method: "DELETE" }),
		onSuccess: (result) => {
			toast.success(result.message);
			return Promise.all([invalidate(), client.invalidateQueries({ queryKey: keys.allStops })]);
		},
		onError: reportError,
	});
}
