if (process.env.API_CREDENTIALS === undefined) {
	throw new Error("Environment variable 'API_CREDENTIALS' must be set!");
}

export const PORT = +(process.env.PORT ?? 3000);
export const REFRESH_INTERVAL = Temporal.Duration.from({ seconds: 30 }).total("milliseconds");
export const SIRI_LITE_API_KEY = btoa(process.env.API_CREDENTIALS);
export const SIRI_LITE_API_URL = "https://data.grandlyon.com/siri-lite/2.0";
export const SWEEP_THRESHOLD = Temporal.Duration.from({ minutes: 10 }).total("milliseconds");
