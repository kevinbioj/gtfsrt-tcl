import { cn } from "cn";

/**
 * Une carte de la maquette : blanche, bordée, un titre, d'éventuelles actions à droite, puis le
 * contenu. Plus serrée que `Card`, et sans son ombre.
 */
export function SectionCard({
	title,
	number,
	hint,
	actions,
	children,
	className,
}: {
	title: React.ReactNode;
	number?: string;
	hint?: React.ReactNode;
	actions?: React.ReactNode;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<section className={cn("flex flex-col gap-3 rounded-lg border bg-card px-5 py-4", className)}>
			<div className="flex flex-wrap items-center gap-2.5">
				<h3 className="m-0 flex items-center gap-2.5 text-[15px] font-semibold">
					{number ? <span className="font-mono text-xs text-muted-foreground">{number}</span> : null}
					{title}
				</h3>
				{hint ? <span className="text-[13px] text-muted-foreground">{hint}</span> : null}
				{actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
			</div>
			{children}
		</section>
	);
}

/** Le nom d'un champ du GTFS-RT, en petit à côté de son libellé. */
export function SpecName({ children }: { children: React.ReactNode }) {
	return <span className="font-mono text-[11px] font-normal text-muted-foreground">{children}</span>;
}
