/**
 * Small geometry helpers shared by API routes and seed/import scripts.
 *
 * Leaflet and the browser usually work with `{ lat, lng }`. PostGIS WKT expects
 * coordinates as `longitude latitude`, so polygonWkt intentionally writes
 * `lng lat` order.
 */
export type Coordinate = {
  lat: number;
  lng: number;
};

export function normalizeCoordinates(input: Coordinate[]) {
  if (input.length < 3) {
    return input;
  }

  const sanitized = input.map((point) => ({
    lat: Number(point.lat),
    lng: Number(point.lng)
  }));

  const first = sanitized[0];
  const last = sanitized[sanitized.length - 1];
  if (first.lat === last.lat && first.lng === last.lng) {
    return sanitized.slice(0, -1);
  }

  return sanitized;
}

// Converts an open Leaflet-style point list into a closed PostGIS polygon ring.
export function polygonWkt(input: Coordinate[]) {
  const coordinates = normalizeCoordinates(input);
  if (coordinates.length < 3) {
    throw new Error("A polygon needs at least 3 points");
  }

  const ring = [...coordinates, coordinates[0]]
    .map((point) => `${point.lng} ${point.lat}`)
    .join(", ");

  return `POLYGON((${ring}))`;
}

// Bounding boxes are used by older/simple UI code and are not a replacement for PostGIS geometry.
export function boundingBox(input: Coordinate[]) {
  const coordinates = normalizeCoordinates(input);
  const lngs = coordinates.map((point) => point.lng);
  const lats = coordinates.map((point) => point.lat);

  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);

  return {
    x: minLng,
    y: minLat,
    width: maxLng - minLng,
    height: maxLat - minLat
  };
}
