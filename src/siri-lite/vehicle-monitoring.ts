import { SIRI_LITE_API_KEY, SIRI_LITE_API_URL } from "../config.js";
import type { Siri, VehicleMonitoringResponse } from "./responses.js";

export async function fetchVehicleMonitoring() {
	const response = await fetch(`${SIRI_LITE_API_URL}/vehicle-monitoring.json`, {
		headers: { Authorization: `Basic ${SIRI_LITE_API_KEY}` },
	});

	if (!response.ok) {
		throw new Error("Unable to fetch vehicle monitoring");
	}

	const payload = (await response.json()) as Siri<VehicleMonitoringResponse>;
	return payload;
}
