import { SIRI_LITE_API_URL, siriLiteAuthorization } from "../config.js";
import type { Siri, VehicleMonitoringResponse } from "./responses.js";

export async function fetchVehicleMonitoring() {
	const response = await fetch(`${SIRI_LITE_API_URL}/vehicle-monitoring.json`, {
		headers: { Authorization: siriLiteAuthorization() },
	});

	if (!response.ok) {
		throw new Error(`Unable to fetch vehicle monitoring (http status ${response.status}).`);
	}

	const payload = (await response.json()) as Siri<VehicleMonitoringResponse>;
	return payload;
}
