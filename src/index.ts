import { serve } from "@hono/node-server";
import DraftLog from "draftlog";
import GtfsRealtime from "gtfs-realtime-bindings";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { Temporal } from "temporal-polyfill";

import { createFeed } from "./gtfs-rt/create-feed.js";
import { fetchEstimatedTimetable } from "./siri-lite/estimated-timetable.js";
import { fetchVehicleMonitoring } from "./siri-lite/vehicle-monitoring.js";
import { extractTripId } from "./utils/extract-trip-id.js";
import { parseSiriRef } from "./utils/parse-siri.js";

DraftLog(console);

const tripUpdates = new Map<string, GtfsRealtime.transit_realtime.ITripUpdate>();
const vehiclePositions = new Map<string, GtfsRealtime.transit_realtime.IVehiclePosition>();

// ---

const hono = new Hono();
hono.get("/", async (c) => {
	const feed = createFeed(tripUpdates, vehiclePositions);
	if (c.req.query("format") === "json") return c.json(feed);

	return stream(c, async (stream) => {
		const encoded = GtfsRealtime.transit_realtime.FeedMessage.encode(feed).finish();
		await stream.write(encoded);
	});
});

const port = +(process.env.PORT ?? 3000);
serve({ fetch: hono.fetch, port });
console.log(`Listening on ${port}`);

// ---

async function updateEntities() {
	const log = console.draft("> Updating entities...");

	try {
		const estimatedTimetable = await fetchEstimatedTimetable();

		const timetableVehicleJourneys = estimatedTimetable.Siri.ServiceDelivery.EstimatedTimetableDelivery.flatMap(
			({ EstimatedJourneyVersionFrame }) => EstimatedJourneyVersionFrame,
		).flatMap(({ EstimatedVehicleJourney }) => EstimatedVehicleJourney);

		for (const vehicleJourney of timetableVehicleJourneys) {
			tripUpdates.set(vehicleJourney.FramedVehicleJourneyRef.DatedVehicleJourneyRef, {
				stopTimeUpdate: vehicleJourney.EstimatedCalls.EstimatedCall.toSorted((a, b) => a.Order - b.Order).flatMap(
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
											time: Math.floor(
												Temporal.Instant.from(estimatedCall.ExpectedArrivalTime).epochMilliseconds / 1000,
											),
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
				),
				timestamp: Math.floor(Temporal.Instant.from(vehicleJourney.RecordedAtTime).epochMilliseconds / 1000),
				trip: {
					routeId: parseSiriRef(vehicleJourney.LineRef.value),
					directionId: vehicleJourney.DirectionRef.value === "outbound" ? 0 : 1,
					tripId: extractTripId(vehicleJourney.FramedVehicleJourneyRef.DatedVehicleJourneyRef),
					scheduleRelationship: GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.SCHEDULED,
				},
			});
		}

		const vehicleMonitoring = await fetchVehicleMonitoring();

		const vehicleActivities = vehicleMonitoring.Siri.ServiceDelivery.VehicleMonitoringDelivery.flatMap(
			({ VehicleActivity }) => VehicleActivity,
		);

		for (const vehicleActivity of vehicleActivities) {
			vehiclePositions.set(vehicleActivity.VehicleMonitoringRef.value, {
				position: {
					latitude: vehicleActivity.MonitoredVehicleJourney.VehicleLocation.Latitude,
					longitude: vehicleActivity.MonitoredVehicleJourney.VehicleLocation.Longitude,
					bearing: vehicleActivity.MonitoredVehicleJourney.Bearing,
				},
				timestamp: Math.floor(Temporal.Instant.from(vehicleActivity.RecordedAtTime).epochMilliseconds / 1000),
				trip: {
					routeId: parseSiriRef(vehicleActivity.MonitoredVehicleJourney.LineRef.value),
					directionId: vehicleActivity.MonitoredVehicleJourney.DirectionRef.value === "outbound" ? 0 : 1,
					tripId: extractTripId(vehicleActivity.MonitoredVehicleJourney.FramedVehicleJourneyRef.DatedVehicleJourneyRef),
					scheduleRelationship: GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.SCHEDULED,
				},
				vehicle: {
					id: vehicleActivity.VehicleMonitoringRef.value,
					label: vehicleActivity.VehicleMonitoringRef.value,
				},
			});
		}

		log("v Done updating entities!");
	} catch (e) {
		log("x Failed to update entities", e);
	}

	for (const [key, tripUpdate] of tripUpdates) {
		const now = Math.floor(Date.now() / 1000);
		if (now - (tripUpdate.timestamp as number) > 3600) tripUpdates.delete(key);
	}

	for (const [key, vehiclePosition] of vehiclePositions) {
		const now = Math.floor(Date.now() / 1000);
		if (now - (vehiclePosition.timestamp as number) > 3600) vehiclePositions.delete(key);
	}
}

await updateEntities();
setInterval(updateEntities, 30_000);
