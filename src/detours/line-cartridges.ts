import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LineCartridges = {
	/** L'adresse du pictogramme d'une ligne, relative à la racine de l'interface ; `null` s'il n'y en a pas. */
	of(routeId: string): string | null;
	/** Le SVG d'une ligne, `undefined` s'il n'y en a pas. */
	svg(routeId: string): string | undefined;
};

/**
 * Les pictogrammes des lignes, un `<route_id>.svg` chacun dans `dir` (cf. `pnpm fetch:cartridges`). Ils
 * se lisent une fois pour toutes, au démarrage — quelques mégaoctets à peine : ils ne changent qu'avec
 * le dépôt. Un dossier absent n'empêche rien, les lignes s'affichent alors à leurs couleurs.
 */
export function useLineCartridges(dir: string): LineCartridges {
	const cartridges = new Map<string, string>();

	try {
		for (const file of readdirSync(dir)) {
			if (file.endsWith(".svg")) cartridges.set(file.slice(0, -".svg".length), readFileSync(join(dir, file), "utf8"));
		}
		console.log(`✓ Loaded ${cartridges.size} line cartridges.`);
	} catch (cause) {
		console.error("✘ Failed to load line cartridges!", cause);
	}

	return {
		of: (routeId) => (cartridges.has(routeId) ? `line-cartridges/${encodeURIComponent(routeId)}.svg` : null),
		svg: (routeId) => cartridges.get(routeId),
	};
}
