import { setTimeout } from "node:timers/promises";
import { serve } from "@hono/node-server";
import GtfsRealtime from "gtfs-realtime-bindings";
import { Hono } from "hono";
import { Temporal } from "temporal-polyfill";
import { match, P } from "ts-pattern";

import { PORT, REFRESH_INTERVAL } from "./config.js";
import { handleRequest } from "./gtfs-rt/handle-request.js";
import { useRealtimeStore } from "./gtfs-rt/use-realtime-store.js";
import { fetchEstimatedTimetable } from "./siri-lite/estimated-timetable.js";
import { fetchVehicleMonitoring } from "./siri-lite/vehicle-monitoring.js";
import { extractTripId } from "./utils/extract-trip-id.js";
import { lineIdToNumber } from "./utils/line-id-2-number.js";
import { operatorByLine } from "./utils/operator-by-line.js";
import { parseSiriRef } from "./utils/parse-siri.js";

console.log(` ,----.,--------.,------.,---.        ,------.,--------. ,--------.,-----.,--.    
'  .-./'--.  .--'|  .---'   .-',-----.|  .--. '--.  .--' '--.  .--'  .--./|  |    
|  | .---.|  |   |  \`--,\`.  \`-.'-----'|  '--'.'  |  |       |  |  |  |    |  |    
'  '--'  ||  |   |  |\`  .-'    |      |  |\\  \\   |  |       |  |  '  '--'\\|  '--. 
 \`------' \`--'   \`--'   \`-----'       \`--' '--'  \`--'       \`--'   \`-----'\`-----'`);

const store = useRealtimeStore();

const hono = new Hono();
hono.get("/trip-updates", (c) => handleRequest(c, "protobuf", store.tripUpdates, null));
hono.get("/trip-updates.json", (c) => handleRequest(c, "json", store.tripUpdates, null));
hono.get("/vehicle-positions", (c) => handleRequest(c, "protobuf", null, store.vehiclePositions));
hono.get("/vehicle-positions.json", (c) => handleRequest(c, "json", null, store.vehiclePositions));
hono.get("/", (c) =>
	handleRequest(c, c.req.query("format") === "json" ? "json" : "protobuf", store.tripUpdates, store.vehiclePositions),
);
serve({ fetch: hono.fetch, port: PORT });
console.log(`|> Listening on :${PORT}`);

// ---

while (true) {
	console.log("|> Updating entities");
	const startedAt = Date.now();
	let error: unknown | undefined;

	try {
		console.log("		◘ Fetching estimated timetable");
		const estimatedTimetable = await fetchEstimatedTimetable();

		const timetableVehicleJourneys = estimatedTimetable.Siri.ServiceDelivery.EstimatedTimetableDelivery.flatMap(
			({ EstimatedJourneyVersionFrame }) => EstimatedJourneyVersionFrame ?? [],
		).flatMap(({ EstimatedVehicleJourney }) => EstimatedVehicleJourney ?? []);

		const firstCallByJourney = new Map<string, { Order: number; StopPointRef?: string }>();

		console.log("			• Computing trip updates");
		for (const vehicleJourney of timetableVehicleJourneys) {
			const tripId = extractTripId(vehicleJourney.FramedVehicleJourneyRef.DatedVehicleJourneyRef);

			const stopTimeUpdates = vehicleJourney.EstimatedCalls.EstimatedCall.toSorted((a, b) => a.Order - b.Order).flatMap(
				(estimatedCall) => {
					const hasRealtime =
						typeof estimatedCall.ExpectedArrivalTime !== "undefined" ||
						typeof estimatedCall.ExpectedDepartureTime !== "undefined";

					const partialStopTime = {
						stopId: estimatedCall.StopPointRef ? parseSiriRef(estimatedCall.StopPointRef.value) : undefined,
						stopSequence: estimatedCall.Order,
					} as const;

					if (!hasRealtime) {
						return [];
						// return {
						// 	...partialStopTime,
						// 	scheduleRelationship:
						// 		GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.NO_DATA,
						// };
					}

					return {
						arrival:
							typeof estimatedCall.ExpectedArrivalTime !== "undefined"
								? {
										time: Math.floor(Temporal.Instant.from(estimatedCall.ExpectedArrivalTime).epochMilliseconds / 1000),
										delay: Temporal.Instant.from(estimatedCall.ExpectedArrivalTime)
											.since(estimatedCall.AimedArrivalTime)
											.total("seconds"),
									}
								: undefined,
						departure:
							typeof estimatedCall.ExpectedDepartureTime !== "undefined"
								? {
										time: Math.floor(
											Temporal.Instant.from(estimatedCall.ExpectedDepartureTime).epochMilliseconds / 1000,
										),
										delay: Temporal.Instant.from(estimatedCall.ExpectedDepartureTime)
											.since(estimatedCall.AimedDepartureTime)
											.total("seconds"),
									}
								: undefined,
						...partialStopTime,
						scheduleRelationship:
							GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SCHEDULED,
					};
				},
			);

			store.tripUpdates.set(`TCL:VehicleJourney::${tripId}:LOC`, {
				stopTimeUpdate: stopTimeUpdates,
				timestamp: Math.floor(Temporal.Instant.from(vehicleJourney.RecordedAtTime).epochMilliseconds / 1000),
				trip: {
					routeId: parseSiriRef(vehicleJourney.LineRef.value),
					directionId: vehicleJourney.DirectionRef.value === "outbound" ? 0 : 1,
					tripId,
					scheduleRelationship: GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.SCHEDULED,
				},
			});

			const firstJourneyCall = stopTimeUpdates[0];
			if (tripId !== undefined && firstJourneyCall !== undefined) {
				firstCallByJourney.set(tripId, {
					Order: firstJourneyCall.stopSequence,
					StopPointRef: firstJourneyCall.stopId,
				});
			}
		}
		console.log(`			✓ Processed ${timetableVehicleJourneys.length} trip updates`);

		// ---

		console.log("		◘ Fetching vehicle monitoring");
		const vehicleMonitoring = await fetchVehicleMonitoring();

		const vehicleActivities = vehicleMonitoring.Siri.ServiceDelivery.VehicleMonitoringDelivery.flatMap(
			({ VehicleActivity }) => VehicleActivity ?? [],
		);

		console.log("			• Computing vehicle positions");
		for (const vehicleActivity of vehicleActivities) {
			const routeId = parseSiriRef(vehicleActivity.MonitoredVehicleJourney.LineRef.value);
			const [, , , vehicleId] = vehicleActivity.VehicleMonitoringRef.value.split(":");

			let operatorRef = "INCONNU";

			if (routeId !== undefined) {
				const routeNumber = lineIdToNumber[routeId];
				if (routeNumber !== undefined) {
					operatorRef = operatorByLine[routeNumber] ?? "INCONNU";
				}
			}

			const tripId = extractTripId(
				vehicleActivity.MonitoredVehicleJourney.FramedVehicleJourneyRef.DatedVehicleJourneyRef,
			);

			const firstJourneyCall = tripId !== undefined ? firstCallByJourney.get(tripId) : undefined;
			let currentStatus: GtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus | undefined;
			let currentStopSequence: number | undefined;
			let stopId: string | undefined;

			if (firstJourneyCall !== undefined) {
				const atStop = firstJourneyCall.Order === vehicleActivity.MonitoredVehicleJourney.MonitoredCall.Order;
				currentStatus = atStop
					? GtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.STOPPED_AT
					: GtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.INCOMING_AT;
				currentStopSequence = atStop
					? vehicleActivity.MonitoredVehicleJourney.MonitoredCall.Order
					: firstJourneyCall.Order;
				stopId = atStop
					? vehicleActivity.MonitoredVehicleJourney.MonitoredCall.StopPointRef.value
					: firstJourneyCall.StopPointRef;
			}

			store.vehiclePositions.set(`TCL:Vehicle:${operatorRef}:${vehicleId}:LOC`, {
				currentStatus,
				currentStopSequence,
				occupancyStatus: match(vehicleActivity.MonitoredVehicleJourney.Occupancy)
					.with("FULL", () => GtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.FULL)
					.with(
						"CRUSH_STANDING_ROOM_ONLY",
						() => GtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.CRUSHED_STANDING_ROOM_ONLY,
					)
					.with(
						"STANDING_ROOM_ONLY",
						() => GtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.STANDING_ROOM_ONLY,
					)
					.with(
						P.union("FEW_SEATS_AVAILABLE", "STANDING_AVAILABLE"),
						() => GtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.FEW_SEATS_AVAILABLE,
					)
					.with(
						P.union("SEATS_AVAILABLE", "MANY_SEATS_AVAILABLE"),
						() => GtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.MANY_SEATS_AVAILABLE,
					)
					.with("EMPTY", () => GtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.EMPTY)
					.with(
						"NOT_ACCEPTING_PASSENGERS",
						() => GtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.NOT_ACCEPTING_PASSENGERS,
					)
					.otherwise(() => undefined),
				position: {
					latitude: vehicleActivity.MonitoredVehicleJourney.VehicleLocation.Latitude,
					longitude: vehicleActivity.MonitoredVehicleJourney.VehicleLocation.Longitude,
					bearing: vehicleActivity.MonitoredVehicleJourney.Bearing,
				},
				stopId,
				timestamp: Math.floor(Temporal.Instant.from(vehicleActivity.RecordedAtTime).epochMilliseconds / 1000),
				trip: {
					routeId: parseSiriRef(vehicleActivity.MonitoredVehicleJourney.LineRef.value),
					directionId: vehicleActivity.MonitoredVehicleJourney.DirectionRef.value === "outbound" ? 0 : 1,
					tripId,
					scheduleRelationship: GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.SCHEDULED,
				},
				vehicle: {
					id: `${operatorRef}:${vehicleId}`,
					label: `${operatorRef}:${vehicleId}`,
				},
			});
		}
		console.log(`			✓ Processed ${vehicleActivities.length} vehicle positions`);
	} catch (cause) {
		error = cause;
	} finally {
		const duration = Date.now() - startedAt;
		const waitingTime = Math.max(REFRESH_INTERVAL - duration, 5000);

		if (error === undefined) {
			console.log(`✓ Done updating in ${duration}ms, waiting for ${waitingTime}ms.`);
		} else {
			console.error(`✘ Unable to update entities, retrying in ${waitingTime}ms.`, error);
		}

		await setTimeout(waitingTime);
	}
}
