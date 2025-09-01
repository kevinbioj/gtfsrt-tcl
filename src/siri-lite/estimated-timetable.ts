import { API_AUTH, API_BASE } from "./constants.js";
import type { EstimatedTimetableResponse, Siri } from "./responses.js";

export async function fetchEstimatedTimetable() {
	const response = await fetch(`${API_BASE}/estimated-timetables.json`, {
		headers: { Authorization: `Basic ${API_AUTH}` },
	});

	if (!response.ok) {
		throw new Error("Unable to fetch estimated timetables");
	}

	const payload = (await response.json()) as Siri<EstimatedTimetableResponse>;
	return payload;
}
