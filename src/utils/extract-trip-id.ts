import { parseSiriRef } from "./parse-siri.js";

export const extractTripId = (input: string) => {
	const fixedInput = input.replaceAll("_x0040_", "@").replaceAll("_x00A3_", "£");
	const journeyRef = parseSiriRef(fixedInput);
	return journeyRef?.slice(journeyRef?.indexOf("@") + 1);
};
