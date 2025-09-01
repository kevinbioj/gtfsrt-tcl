if (typeof process.env.API_CREDENTIALS === "undefined") {
	throw new Error("Environment variable 'API_CREDENTIALS' is expected to be supplied!");
}

export const API_AUTH = btoa(process.env.API_CREDENTIALS);
export const API_BASE = "https://data.grandlyon.com/siri-lite/2.0";
