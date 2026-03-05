export interface FeedData {
	pb: Uint8Array;
	json: unknown;
	timestamp: number;
}

export interface WorkerMessage {
	global: FeedData;
	tripUpdates: FeedData;
	vehiclePositions: FeedData;
}
