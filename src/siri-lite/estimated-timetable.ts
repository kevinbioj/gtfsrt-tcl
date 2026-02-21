import { SIRI_LITE_API_KEY, SIRI_LITE_API_URL } from "../config.js";
import type { EstimatedTimetableResponse, Siri } from "./responses.js";

export async function fetchEstimatedTimetable() {
	const response = await fetch(`${SIRI_LITE_API_URL}/estimated-timetables.json`, {
		headers: { Authorization: `Basic ${SIRI_LITE_API_KEY}` },
	});

	if (!response.ok) {
		throw new Error("Unable to fetch estimated timetables");
	}

	const payload = (await response.json()) as Siri<EstimatedTimetableResponse>;
	return payload;
}
