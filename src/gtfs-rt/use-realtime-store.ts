import type GtfsRealtime from "gtfs-realtime-bindings";
import { Temporal } from "temporal-polyfill";

import { SWEEP_THRESHOLD } from "../config.js";

let currentInterval: NodeJS.Timeout | undefined;

export function useRealtimeStore() {
	const store = {
		tripUpdates: new Map<string, GtfsRealtime.transit_realtime.ITripUpdate>(),
		vehiclePositions: new Map<string, GtfsRealtime.transit_realtime.IVehiclePosition>(),
	};

	if (currentInterval !== undefined) {
		clearInterval(currentInterval);
	}

	setInterval(() => {
		const now = Temporal.Now.instant();

		for (const [id, tripUpdate] of store.tripUpdates) {
			const lastArrival = tripUpdate.stopTimeUpdate?.at(-1)?.arrival;
			if (lastArrival?.time) {
				const scheduledAt = Temporal.Instant.fromEpochMilliseconds(+lastArrival.time * 1000).subtract({
					seconds: lastArrival.delay ?? 0,
				});

				if (Temporal.Instant.compare(now, scheduledAt.add({ minutes: 2 })) <= 0) {
					continue;
				}
			}

			if (
				now
					// biome-ignore lint/style/noNonNullAssertion: we always set timestamp in store
					.since(Temporal.Instant.fromEpochMilliseconds(+tripUpdate.timestamp! * 1000))
					.total("minutes") >= 10
			) {
				store.tripUpdates.delete(id);
			}
		}

		for (const [id, vehicle] of store.vehiclePositions) {
			if (
				Temporal.Now.instant()
					// biome-ignore lint/style/noNonNullAssertion: we always set timestamp in store
					.since(Temporal.Instant.fromEpochMilliseconds(+vehicle.timestamp! * 1000))
					.total("minutes") >= 10
			) {
				store.vehiclePositions.delete(id);
			}
		}
	}, SWEEP_THRESHOLD);

	return store;
}
