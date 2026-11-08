/** L'en-tête d'une page : titre, sous-titre, et ce qu'on y fait. */
export function PageHeader({
	title,
	description,
	children,
}: {
	title: React.ReactNode;
	description?: React.ReactNode;
	children?: React.ReactNode;
}) {
	return (
		<header className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b bg-card px-6 py-4">
			<div className="flex min-w-0 flex-[1_1_260px] flex-col gap-0.5">
				<h1 className="m-0 text-xl font-semibold tracking-tight">{title}</h1>
				{description ? <p className="m-0 text-[13px] text-muted-foreground">{description}</p> : null}
			</div>
			{children}
		</header>
	);
}

/** Une barre de filtres sous l'en-tête. */
export function FilterBar({ children }: { children: React.ReactNode }) {
	return <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b bg-card px-6 py-3">{children}</div>;
}
