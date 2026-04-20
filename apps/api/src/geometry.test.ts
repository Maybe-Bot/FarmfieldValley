import test from "node:test";
import assert from "node:assert/strict";
import { boundingBox, normalizeCoordinates, polygonWkt } from "./geometry";

test("polygonWkt stores Leaflet lat/lng points in PostGIS lng/lat order", () => {
  const points = [
    { lat: 40.1, lng: -76.3 },
    { lat: 40.1, lng: -76.2 },
    { lat: 40.2, lng: -76.2 }
  ];

  assert.equal(
    polygonWkt(points),
    "POLYGON((-76.3 40.1, -76.2 40.1, -76.2 40.2, -76.3 40.1))"
  );
});

test("normalizeCoordinates removes duplicate closing point before save/load math", () => {
  const closed = [
    { lat: 1, lng: 2 },
    { lat: 1, lng: 3 },
    { lat: 2, lng: 3 },
    { lat: 1, lng: 2 }
  ];

  assert.deepEqual(normalizeCoordinates(closed), closed.slice(0, -1));
  assert.deepEqual(boundingBox(closed), { x: 2, y: 1, width: 1, height: 1 });
});
