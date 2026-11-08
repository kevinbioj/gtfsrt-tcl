import { loadGtfs } from "./load-static-gtfs.js";
import { packSchedules, packShapes } from "./packed-tables.js";
import type { LoaderMessage } from "./use-static-gtfs.js";

/**
 * Lit le GTFS statique dans un processus à part, compacte ses deux grosses tables et les transmet au
 * processus parent, puis se termine (cf. `useStaticGtfs`). L'adresse du GTFS est son seul argument.
 */
const url = process.argv[2] as string;
const loaded = await loadGtfs(url);

let message: LoaderMessage;
if (loaded === undefined) {
	message = { ok: false, signature: null };
} else {
	const { tripStopSequences, shapes, ...data } = loaded.data;
	message = {
		ok: true,
		data,
		packed: { schedules: packSchedules(tripStopSequences), shapes: packShapes(shapes) },
		signature: loaded.signature,
	};
}

process.send?.(message, () => process.exit(0));
