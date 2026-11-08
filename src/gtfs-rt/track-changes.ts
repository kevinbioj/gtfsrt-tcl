import { createHash } from "node:crypto";

/**
 * Retient l'empreinte du dernier contenu publié sous chaque clé, pour que l'horodatage d'un flux date
 * sa dernière modification et non son dernier relevé : un client qui interroge avec If-Modified-Since
 * n'a rien à recharger tant que le contenu n'a pas changé.
 */
export function useChangeTracker() {
	const clocks = new Map<string, { digest: string; modifiedAt: number }>();

	return {
		/**
		 * Constate le contenu publié sous `key` et rend la date de sa dernière modification, en secondes
		 * epoch. Une modification survenue dans la seconde même de la précédente avance la date d'une
		 * seconde, pour qu'un client servi entre les deux ne s'entende pas répondre 304.
		 */
		stamp(key: string, content: unknown): number {
			const digest = createHash("sha1").update(JSON.stringify(content)).digest("base64");
			const clock = clocks.get(key);
			if (clock?.digest === digest) return clock.modifiedAt;

			const nowSeconds = Math.floor(Date.now() / 1000);
			const modifiedAt = clock === undefined ? nowSeconds : Math.max(nowSeconds, clock.modifiedAt + 1);
			clocks.set(key, { digest, modifiedAt });
			return modifiedAt;
		},

		/** La date de la dernière modification constatée sous `key`, ou 0 si rien ne l'a encore été. */
		modifiedAt(key: string): number {
			return clocks.get(key)?.modifiedAt ?? 0;
		},
	};
}
