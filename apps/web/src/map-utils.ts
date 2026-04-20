/**
 * Leaflet/map display helpers.
 *
 * These functions keep geometry conversion, area estimates, vertex marker icons,
 * and task map icons out of the main App component.
 */
import L from "leaflet";
import { defaultTractorAccentColor, isTractorTask, tractorFrameForBearing, tractorModelForTask, tractorSpriteHtml } from "./tractor-icons";

export type LatLngPoint = {
  lat: number;
  lng: number;
};

export function geoJsonPolygonToLatLngs(geoJson: { coordinates: number[][][] } | null) {
  if (!geoJson?.coordinates?.[0]) {
    return [] as LatLngPoint[];
  }

  return geoJson.coordinates[0]
    .slice(0, -1)
    .map(([lng, lat]) => ({ lat, lng }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

export function polygonAreaSqM(points: LatLngPoint[]) {
  if (points.length < 3) {
    return 0;
  }

  // Leaflet stores lat/lng in WGS84. For a prototype-friendly area estimate in square meters,
  // project to Web Mercator first, then apply the standard polygon shoelace formula.
  const projected = points.map((point) => {
    const x = (point.lng * Math.PI * 6378137) / 180;
    const latRadians = (point.lat * Math.PI) / 180;
    const y = 6378137 * Math.log(Math.tan(Math.PI / 4 + latRadians / 2));
    return { x, y };
  });

  let total = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const current = projected[index];
    const next = projected[(index + 1) % projected.length];
    total += current.x * next.y - next.x * current.y;
  }

  return Math.abs(total / 2);
}

export function formatArea(areaSqM: number) {
  if (!Number.isFinite(areaSqM) || areaSqM <= 0) {
    return "—";
  }

  const acres = areaSqM / 4046.8564224;
  if (acres >= 0.1) {
    return `${acres.toFixed(acres >= 10 ? 1 : 2)} ac`;
  }

  return `${Math.round(areaSqM)} sq m`;
}

export function midpoint(a: LatLngPoint, b: LatLngPoint) {
  return {
    lat: (a.lat + b.lat) / 2,
    lng: (a.lng + b.lng) / 2
  };
}

// Small div icons are used instead of image files so colors and states can change in CSS.
export function vertexIcon(kind: "vertex" | "start" | "midpoint" | "selected") {
  const className =
    kind === "start"
      ? "vertex-icon start"
      : kind === "midpoint"
        ? "vertex-icon midpoint"
        : kind === "selected"
          ? "vertex-icon selected"
          : "vertex-icon";

  return L.divIcon({
    className: "",
    html: `<div class="${className}"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });
}

// Prototype task marker. Tractor work uses the user-recolorable tractor sprite;
// other work still uses a compact letter badge.
export function taskMapIcon(taskType: string, color: string, accentColor = defaultTractorAccentColor(), bearingDegrees?: number | null) {
  if (isTractorTask(taskType)) {
    const frame = tractorFrameForBearing(bearingDegrees);
    return L.divIcon({
      className: "",
      html: `<div class="task-map-tractor-icon tractor-bearing-${frame.frame}">${tractorSpriteHtml(color, accentColor, { bearing: bearingDegrees, animated: true, scale: 0.42, model: tractorModelForTask(taskType) })}</div>`,
      iconSize: [84, 84],
      iconAnchor: [42, 42]
    });
  }

  const label = taskType === "cultivate" || taskType === "weed"
    ? "T"
    : taskType === "transplant"
      ? "P"
      : taskType === "direct_seed" || taskType === "seed_in_tray"
        ? "S"
        : taskType === "harvest"
          ? "H"
          : taskType === "bed_prep"
            ? "B"
            : "!";

  return L.divIcon({
    className: "",
    html: `<div class="task-map-icon" style="--task-icon-color: ${color}"><span>${label}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });
}
