/** Une ligne de `/api/networks/:id?withDetails=true`, réduite à ce qu'on en lit. */
type NetworkLine = { references?: string[]; cartridgeHref?: string | null; archivedAt?: string | null };

export type LineCartridges = { of(routeId: string): string | null };

let currentInterval: NodeJS.Timeout | undefined;

/**
 * Tient à jour le pictogramme de chaque ligne, d'après Bus Tracker. Un échec ponctuel laisse les
 * pictogrammes précédents en place ; d'ici au premier relevé, aucun n'est connu.
 */
export function useLineCartridges(url: string, interval: number): LineCartridges {
	let cartridges = new Map<string, string>();

	const refresh = async () => {
		cartridges = (await loadCartridges(url)) ?? cartridges;
	};
	void refresh();

	if (currentInterval !== undefined) {
		clearInterval(currentInterval);
	}
	currentInterval = setInterval(refresh, interval);

	return {
		/** « C1 », « T3 » : la ligne se retrouve par son `route_id`, que Bus Tracker cite en « TCL:Line:C1 ». */
		of: (routeId) => cartridges.get(routeId) ?? null,
	};
}

/** Code de ligne → pictogramme, lignes archivées exclues. `undefined` en cas d'échec. */
async function loadCartridges(url: string): Promise<Map<string, string> | undefined> {
	console.log("➔ Fetching line cartridges.");

	try {
		// Cloudflare refuse l'agent par défaut de Node (« node »).
		const response = await fetch(url, { headers: { "User-Agent": "gtfsrt-tcl" } });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);

		const { lines } = (await response.json()) as { lines?: NetworkLine[] };
		const cartridges = new Map<string, string>();

		for (const line of lines ?? []) {
			if (line.archivedAt || !line.cartridgeHref) continue;
			for (const reference of line.references ?? []) {
				const match = /^[^:]+:Line:(.+)$/.exec(reference);
				if (match?.[1] !== undefined) cartridges.set(match[1], line.cartridgeHref);
			}
		}

		console.log(`✓ Loaded ${cartridges.size} line cartridges.`);
		return cartridges;
	} catch (cause) {
		console.error("✘ Failed to update line cartridges!", cause);
		return undefined;
	}
}
