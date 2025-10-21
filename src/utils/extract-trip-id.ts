import { parseSiriRef } from "./parse-siri.js";

export const extractTripId = (input: string) => {
	const fixedInput = input.replace(/_x([0-9A-Fa-f]{4})_/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
	return parseSiriRef(fixedInput);
};
