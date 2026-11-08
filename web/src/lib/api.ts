/** Une erreur de l'API, avec le message qu'elle rend — c'est lui que l'interface affiche. */
export class ApiError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

/**
 * Un appel à l'API d'administration. L'authentification est celle de la page : le navigateur renvoie
 * de lui-même les identifiants qu'on lui a donnés pour l'interface. L'adresse est relative à la racine
 * de l'interface (cf. `<base>`), préfixe du proxy compris.
 */
export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
	const response = await fetch(new URL(`api${path}`, document.baseURI), {
		method: init?.method ?? "GET",
		headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
		body: init?.body === undefined ? undefined : JSON.stringify(init.body),
	});
	const text = await response.text();
	let payload: unknown = null;
	try {
		payload = text.length > 0 ? JSON.parse(text) : null;
	} catch {
		// Une page d'erreur du proxy, ou rien : le statut suffira.
	}
	if (!response.ok) {
		const message =
			typeof payload === "object" && payload !== null && "message" in payload
				? String(payload.message)
				: `Erreur ${response.status}.`;
		throw new ApiError(message, response.status);
	}
	return payload as T;
}
