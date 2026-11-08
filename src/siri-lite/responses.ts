export type Siri<T> = {
	Siri: {
		ServiceDelivery: {
			ResponseTimestamp: string;
			ProducerRef: {
				value: string;
			};
			ResponseMessageIdentifier: {
				value: string;
			};
			MoreData: boolean;
		} & T;
	};
};

export type EstimatedTimetableResponse = {
	EstimatedTimetableDelivery: Array<{
		EstimatedJourneyVersionFrame: Array<{
			EstimatedVehicleJourney: Array<{
				RecordedAtTime: string;
				LineRef: {
					value: string;
				};
				DirectionRef: {
					value: "inbound" | "outbound";
				};
				FramedVehicleJourneyRef: {
					DataFrameRef: {
						value: string;
					};
					DatedVehicleJourneyRef: string;
				};
				Cancellation: boolean;
				JourneyPatternRef: {
					value: string;
				};
				DestinationRef: {
					value: string;
				};
				DataSource: string;
				EstimatedCalls: {
					EstimatedCall: Array<{
						StopPointRef?: {
							value: string;
						};
						Order: number;
						Cancellation: boolean;
						AimedArrivalTime: string;
						ExpectedArrivalTime?: string;
						AimedDepartureTime: string;
						ExpectedDepartureTime?: string;
					}>;
				};
			}>;
		}>;
	}>;
};

export type VehicleMonitoringResponse = {
	VehicleMonitoringDelivery: Array<{
		VehicleActivity: Array<{
			ValidUntilTime: string;
			VehicleMonitoringRef: {
				value: string;
			};
			MonitoredVehicleJourney: {
				LineRef: {
					value: string;
				};
				DirectionRef: {
					value: "inbound" | "outbound";
				};
				FramedVehicleJourneyRef: {
					DataFrameRef: {
						value: string;
					};
					DatedVehicleJourneyRef: string;
				};
				VehicleLocation: {
					Longitude: number;
					Latitude: number;
				};
				Occupancy?: string;
				Bearing: number;
				VehicleRef: {
					value: string;
				};
				Delay: string;
				MonitoredCall: {
					AimedDepartureTime: string;
					StopPointRef: {
						value: string;
					};
					Order: number;
				};
			};
			RecordedAtTime: string;
		}>;
	}>;
};

export type SituationExchangeResponse = {
	SituationExchangeDelivery: Array<{
		Situations?: {
			PtSituationElement?: Array<PtSituationElement>;
		};
	}>;
};

/**
 * Une situation du Situation Exchange de TCL. Chaque info trafic y figure en deux exemplaires, que
 * seul le texte distingue : `…_1` porte la description complète, `…_2` un titre court (cf.
 * `siriSituationExchange`).
 */
export type PtSituationElement = {
	SituationNumber: { value: string };
	Version?: { value: number };
	CreationTime?: string;
	ValidityPeriod?: Array<{ StartTime?: string; EndTime?: string }>;
	Description?: Array<{ value: string; lang?: string }>;
	Summary?: Array<{ value: string; lang?: string }>;
	References?: {
		RelatedToRef?: Array<{ SituationNumber?: { value: string }; CreationTime?: string }>;
	};
	Consequences?: {
		Consequence?: Array<{
			Affects?: {
				Networks?: {
					AffectedNetwork?: Array<{
						NetworkRef?: { value: string };
						AffectedLine?: Array<{ LineRef: { value: string } }>;
					}>;
				};
				StopPoints?: {
					AffectedStopPoint?: Array<{ StopPointRef: { value: string } }>;
				};
			};
		}>;
	};
};
