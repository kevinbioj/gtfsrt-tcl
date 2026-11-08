import { SIRI_LITE_API_URL, siriLiteAuthorization } from "../config.js";
import type { Siri, SituationExchangeResponse } from "./responses.js";

export async function fetchSituationExchange() {
	const response = await fetch(`${SIRI_LITE_API_URL}/situation-exchange.json`, {
		headers: { Authorization: siriLiteAuthorization() },
		signal: AbortSignal.timeout(30_000),
	});

	if (!response.ok) {
		throw new Error(`Unable to fetch situation exchange (http status ${response.status}).`);
	}

	const payload = (await response.json()) as Siri<SituationExchangeResponse>;
	return payload;
}
