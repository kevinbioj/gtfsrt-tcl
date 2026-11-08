import { cn } from "cn";
import L from "leaflet";
import { useEffect, useMemo } from "react";
import { MapContainer, TileLayer, useMap, useMapEvents } from "react-leaflet";

import type { LatLng } from "@/lib/geometry";

/** Le centre de Lyon, là où s'ouvre une carte qui n'a rien d'autre à montrer. */
const LYON: LatLng = [45.76, 4.8357];

/**
 * Une carte du réseau sur fond OpenStreetMap. Elle dessine en canvas : la base des stations en compte
 * un bon millier, et autant de marqueurs DOM ralentiraient chaque déplacement.
 */
export function BaseMap({
	children,
	className,
	cursor,
}: {
	children?: React.ReactNode;
	className?: string;
	cursor?: "crosshair";
}) {
	return (
		<MapContainer
			center={LYON}
			zoom={14}
			preferCanvas
			className={cn(
				"h-full w-full",
				cursor === "crosshair" && "cursor-crosshair [&_.leaflet-grab]:cursor-crosshair",
				className,
			)}
			style={{ cursor }}
		>
			<TileLayer
				attribution="&copy; contributeurs OpenStreetMap"
				url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
				maxZoom={19}
			/>
			{children}
		</MapContainer>
	);
}

/** Relaie les clics sur la carte. */
export function MapClick({ onClick }: { onClick: (point: LatLng) => void }) {
	useMapEvents({ click: (event) => onClick([event.latlng.lat, event.latlng.lng]) });
	return null;
}

/**
 * Cadre la carte sur ces points dès que `token` change — et seulement alors : la carte ne doit pas
 * sauter à chaque point qu'on ajoute.
 */
export function FitTo({
	points,
	token,
	maxZoom = 17,
}: {
	points: readonly LatLng[];
	token: string | number;
	maxZoom?: number;
}) {
	const map = useMap();
	// biome-ignore lint/correctness/useExhaustiveDependencies: on ne recadre que lorsque le jeton change.
	useEffect(() => {
		if (points.length === 0) return;
		if (points.length === 1) map.setView(points[0] as LatLng, Math.min(maxZoom, 17));
		else map.fitBounds(L.latLngBounds(points as LatLng[]), { padding: [32, 32], maxZoom });
	}, [token, map]);
	return null;
}

/** Recentre la carte sur un point dès qu'il change. */
export function PanTo({ point }: { point: LatLng | null }) {
	const map = useMap();
	useEffect(() => {
		if (point !== null) map.panTo(point);
	}, [point, map]);
	return null;
}

/** Une icône HTML pour un marqueur : le carré « P » d'un arrêt provisoire, un losange de jonction… */
export function useDivIcon(html: string, size: number) {
	return useMemo(
		() => L.divIcon({ html, className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
		[html, size],
	);
}

/** L'épingle d'un arrêt provisoire, la pointe sur sa position. */
export function provisionalPinIcon(color: string): L.DivIcon {
	return L.divIcon({
		html: `<svg width="20" height="30" viewBox="0 0 24 36"><path d="M12 1C5.9 1 1 5.9 1 12c0 8.3 11 23 11 23s11-14.7 11-23C23 5.9 18.1 1 12 1z" fill="${color}" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="12" r="4.5" fill="#fff"/></svg>`,
		className: "",
		iconSize: [20, 30],
		iconAnchor: [10, 29],
		tooltipAnchor: [0, -22],
	});
}
