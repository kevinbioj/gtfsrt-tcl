import type { AlertTextDto } from "@dto";
import { cn } from "cn";
import { ExternalLinkIcon } from "lucide-react";

import { SectionCard, SpecName } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/** Ce que la section saisit : le lien, l'image et son texte alternatif ; `""` : aucun. */
export type LinkForm = { url: string; imageUrl: string; imageAlternativeText: string };

/** Les extensions dont le serveur sait tirer le type de média de l'image (cf. `imageMediaType`). */
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)(?:[?#]|$)/i;

/** Ce qui cloche dans une adresse d'image saisie, ou `null`. */
function imageProblem(url: string): string | null {
	if (url.length === 0) return null;
	if (!/^https:\/\/\S+$/i.test(url)) return "Une adresse en https:// est attendue.";
	if (!IMAGE_EXTENSION.test(url)) return "L'adresse doit finir par .png, .jpg, .jpeg, .gif ou .webp.";
	return null;
}

/** Ce qui cloche dans un lien saisi, ou `null`. */
function linkProblem(url: string): string | null {
	if (url.length === 0) return null;
	return /^https?:\/\/\S+$/i.test(url) ? null : "Une adresse en https:// ou http:// est attendue.";
}

/**
 * Le lien et l'image d'une alerte, tels qu'ils seront publiés. Pour une alerte du flux, ce qu'il en
 * porte se montre sous chaque champ : le vider le retire, et « Reprendre » le rétablit. Une alerte
 * créée à la main n'a rien de reçu.
 */
export function LinkEditor({
	value,
	received,
	custom,
	onChange,
}: {
	value: LinkForm;
	received: Pick<AlertTextDto, "url" | "imageUrl" | "imageAlternativeText">;
	custom: boolean;
	onChange: (change: Partial<LinkForm>) => void;
}) {
	const receivedForm: LinkForm = {
		url: received.url ?? "",
		imageUrl: received.imageUrl ?? "",
		imageAlternativeText: received.imageAlternativeText ?? "",
	};
	const rewritten =
		!custom && (Object.keys(receivedForm) as (keyof LinkForm)[]).some((key) => value[key].trim() !== receivedForm[key]);
	const imageUrl = value.imageUrl.trim();
	const imageError = imageProblem(imageUrl);
	const linkError = linkProblem(value.url.trim());

	/** Ce que porte le flux, sous un champ d'une alerte qui en vient. */
	const receivedHint = (text: string, none: string) =>
		custom ? null : <FieldDescription className="text-xs break-all">{text ? `Reçu : ${text}` : none}</FieldDescription>;

	return (
		<SectionCard
			title="Lien et image"
			actions={
				custom ? undefined : (
					<>
						<span
							className={cn(
								"rounded-sm px-2 py-0.5 text-xs font-medium",
								rewritten ? "bg-warning text-warning-foreground" : "bg-neutral text-neutral-foreground",
							)}
						>
							{rewritten ? "Réécrit" : "Reçu"}
						</span>
						<Button variant="outline" disabled={!rewritten} onClick={() => onChange(receivedForm)}>
							Reprendre le reçu
						</Button>
					</>
				)
			}
		>
			<div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-4">
				<div className="flex flex-col gap-3">
					<Field className="gap-1.5" data-invalid={linkError !== null || undefined}>
						<FieldLabel htmlFor="alert-url">
							Lien <SpecName>url</SpecName>
						</FieldLabel>
						<div className="flex items-center gap-2">
							<Input
								id="alert-url"
								type="url"
								className="h-10"
								placeholder="https://…"
								aria-invalid={linkError !== null || undefined}
								value={value.url}
								onChange={(event) => onChange({ url: event.target.value })}
							/>
							{value.url.trim() && linkError === null ? (
								<Button variant="outline" size="icon-lg" asChild>
									<a href={value.url.trim()} target="_blank" rel="noreferrer" aria-label="Ouvrir le lien">
										<ExternalLinkIcon />
									</a>
								</Button>
							) : null}
						</div>
						{linkError ? <FieldDescription className="text-destructive">{linkError}</FieldDescription> : null}
						{receivedHint(receivedForm.url, "Le flux n'en porte aucun.")}
					</Field>
					<Field className="gap-1.5" data-invalid={imageError !== null || undefined}>
						<FieldLabel htmlFor="alert-image">
							Image <SpecName>image</SpecName>
						</FieldLabel>
						<Input
							id="alert-image"
							type="url"
							className="h-10"
							placeholder="https://…/plan.png"
							aria-invalid={imageError !== null || undefined}
							value={value.imageUrl}
							onChange={(event) => onChange({ imageUrl: event.target.value })}
						/>
						{imageError ? <FieldDescription className="text-destructive">{imageError}</FieldDescription> : null}
						{receivedHint(receivedForm.imageUrl, "Le flux n'en porte aucune.")}
					</Field>
					<Field className="gap-1.5">
						<FieldLabel htmlFor="alert-image-alt">
							Texte alternatif <SpecName>image_alternative_text</SpecName>
						</FieldLabel>
						<Input
							id="alert-image-alt"
							className="h-10"
							maxLength={300}
							placeholder="Ce que montre l'image : plan de la déviation…"
							value={value.imageAlternativeText}
							onChange={(event) => onChange({ imageAlternativeText: event.target.value })}
						/>
						{receivedHint(receivedForm.imageAlternativeText, "Le flux n'en porte aucun.")}
					</Field>
				</div>
				<div className="flex min-h-40 items-center justify-center overflow-hidden rounded-md border border-[#E2E5E1] bg-muted p-2">
					{imageUrl && imageError === null ? (
						<img
							src={imageUrl}
							alt={value.imageAlternativeText.trim()}
							className="max-h-72 max-w-full rounded-sm object-contain"
						/>
					) : (
						<span className="text-[13px] text-muted-foreground">Aucune image</span>
					)}
				</div>
			</div>
		</SectionCard>
	);
}
