import { useEffect, useRef, useState } from "react";

/**
 * Un texte de recherche reflété dans l'URL. La saisie s'affiche aussitôt ; l'URL ne la reçoit qu'une
 * fois la frappe posée, sans quoi chaque lettre y ferait un aller-retour et le curseur sauterait. Une
 * URL qui change d'elle-même — précédent, suivant — remplace la saisie, sauf si une frappe attend.
 */
export function useSearchText(value: string, commit: (next: string) => void, delay = 250) {
	const [text, setText] = useState(value);
	const [seen, setSeen] = useState(value);
	const pending = useRef<number | undefined>(undefined);

	if (value !== seen) {
		setSeen(value);
		if (pending.current === undefined) setText(value);
	}

	useEffect(() => () => window.clearTimeout(pending.current), []);

	const change = (next: string) => {
		setText(next);
		window.clearTimeout(pending.current);
		pending.current = window.setTimeout(() => {
			pending.current = undefined;
			commit(next);
		}, delay);
	};

	return [text, change] as const;
}
