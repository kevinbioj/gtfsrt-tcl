import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// L'interface est servie par le producteur sous /admin, derrière son authentification — et, en
// exploitation, derrière un proxy qui y ajoute son propre préfixe (/gtfs-rt/tcl/admin). Ses adresses
// sont donc toutes relatives : à la base que la page déclare (cf. `<base>` dans index.html), que le
// producteur ajuste à chaque adresse servie. En développement, Vite la sert lui-même et relaie l'API
// au producteur lancé à côté (`pnpm dev`).
export default defineConfig({
	base: "./",
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@dto": resolve(import.meta.dirname, "../src/detours/admin-dto.ts"),
			"@": resolve(import.meta.dirname, "./src"),
		},
	},
	build: {
		outDir: "../dist/admin-ui",
		emptyOutDir: true,
		// Une seule application, servie derrière une authentification : rien à gagner à la découper.
		chunkSizeWarningLimit: 1500,
	},
	server: {
		proxy: {
			"/admin/api": "http://localhost:3000",
		},
	},
});
