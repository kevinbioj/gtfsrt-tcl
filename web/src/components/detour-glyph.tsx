import type { DetourKind } from "@dto";

/** Le petit schéma d'un type de tracé : le nominal en gris, la déviation en tirets bleus. */
const GLYPHS: Record<DetourKind, { label: string; base: string; detour: string }> = {
	intra: { label: "Déviation intra-tracé", base: "M2 11H26", detour: "M7 11V3H21V11" },
	start: { label: "Nouveau début", base: "M12 11H26", detour: "M2 3H12V11" },
	end: { label: "Nouvelle fin", base: "M2 11H16", detour: "M16 11V3H26" },
};

export const DETOUR_KINDS = GLYPHS;

export function DetourGlyph({ kind }: { kind: DetourKind }) {
	const glyph = GLYPHS[kind];
	return (
		<svg width="28" height="14" viewBox="0 0 28 14" fill="none" strokeLinecap="round" aria-hidden="true">
			<path d={glyph.base} stroke="#8A9097" strokeWidth="2" />
			<path d={glyph.detour} stroke="#1D56C8" strokeWidth="2" strokeDasharray="3 2" />
		</svg>
	);
}
