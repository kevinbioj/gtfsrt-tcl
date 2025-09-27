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
					value: "Forward" | "Backward";
				};
				DatedVehicleJourneyRef: {
					value: string;
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
					value: "Forward" | "Backward";
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
