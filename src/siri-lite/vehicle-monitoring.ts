import { API_AUTH, API_BASE } from "./constants.js";
import type { Siri, VehicleMonitoringResponse } from "./responses.js";

export async function fetchVehicleMonitoring() {
	const response = await fetch(`${API_BASE}/vehicle-monitoring.json`, {
		headers: { Authorization: `Basic ${API_AUTH}` },
	});

	if (!response.ok) {
		throw new Error("Unable to fetch vehicle monitoring");
	}

	const payload = (await response.json()) as Siri<VehicleMonitoringResponse>;
	return payload;
}
