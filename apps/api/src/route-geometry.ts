export type LatLngInput = { lat: number; lng: number };
export type GeoJsonPolygonInput = { type: "Polygon"; coordinates: number[][][] } | null;

const ROUTE_EARTH_RADIUS_M = 6378137;

export function geoJsonPolygonToLatLngs(value: GeoJsonPolygonInput | unknown) {
  if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "Polygon") {
    return [] as LatLngInput[];
  }

  const ring = (value as GeoJsonPolygonInput)?.coordinates?.[0] ?? [];
  return ring
    .slice(0, ring.length > 1 ? -1 : ring.length)
    .map((coordinate) => ({ lng: Number(coordinate[0]), lat: Number(coordinate[1]) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

export function projectRoutePoint(point: LatLngInput) {
  const x = (point.lng * Math.PI * ROUTE_EARTH_RADIUS_M) / 180;
  const latRadians = (point.lat * Math.PI) / 180;
  const y = ROUTE_EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + latRadians / 2));
  return { x, y };
}

export function polygonCenterForRoute(points: LatLngInput[]) {
  if (points.length === 0) {
    return null;
  }

  const totals = points.reduce((sum, point) => ({ lat: sum.lat + point.lat, lng: sum.lng + point.lng }), { lat: 0, lng: 0 });
  return { lat: totals.lat / points.length, lng: totals.lng / points.length };
}

export function routeSideOfLine(linePoints: LatLngInput[], point: LatLngInput) {
  if (linePoints.length < 2) {
    return 0;
  }

  const start = projectRoutePoint(linePoints[0]);
  const end = projectRoutePoint(linePoints[linePoints.length - 1]);
  const target = projectRoutePoint(point);
  return (end.x - start.x) * (target.y - start.y) - (end.y - start.y) * (target.x - start.x);
}

export function orientRouteLineLeftTowardPoint(linePoints: LatLngInput[], point: LatLngInput | null) {
  if (!point || linePoints.length < 2) {
    return linePoints;
  }

  return routeSideOfLine(linePoints, point) < 0 ? [...linePoints].reverse() : linePoints;
}

export function orientRouteLineLeftAwayFromPoint(linePoints: LatLngInput[], point: LatLngInput | null) {
  if (!point || linePoints.length < 2) {
    return linePoints;
  }

  return routeSideOfLine(linePoints, point) > 0 ? [...linePoints].reverse() : linePoints;
}

export function bedMakingGuideLine(
  bedBoundaryValue: GeoJsonPolygonInput | unknown,
  blockBoundaryValue: GeoJsonPolygonInput | unknown,
  mode: "replace_existing" | "add_after_existing"
) {
  const bedBoundary = geoJsonPolygonToLatLngs(bedBoundaryValue);
  const blockCenter = polygonCenterForRoute(geoJsonPolygonToLatLngs(blockBoundaryValue));
  const bedCenter = polygonCenterForRoute(bedBoundary);
  if (bedBoundary.length < 3) {
    return [] as LatLngInput[];
  }

  const projectedBlockCenter = blockCenter ? projectRoutePoint(blockCenter) : null;
  const edges = bedBoundary.map((start, index) => {
    const end = bedBoundary[(index + 1) % bedBoundary.length];
    const projectedStart = projectRoutePoint(start);
    const projectedEnd = projectRoutePoint(end);
    const midpointProjected = {
      x: (projectedStart.x + projectedEnd.x) / 2,
      y: (projectedStart.y + projectedEnd.y) / 2
    };
    return {
      start,
      end,
      length: Math.hypot(projectedEnd.x - projectedStart.x, projectedEnd.y - projectedStart.y),
      centerDistance: projectedBlockCenter
        ? Math.hypot(midpointProjected.x - projectedBlockCenter.x, midpointProjected.y - projectedBlockCenter.y)
        : 0
    };
  });

  const longestLength = Math.max(...edges.map((edge) => edge.length));
  const longEdges = edges.filter((edge) => edge.length >= longestLength * 0.8);
  const sortedEdges = [...longEdges].sort((left, right) => left.centerDistance - right.centerDistance);
  const guideEdge = mode === "replace_existing"
    ? sortedEdges[sortedEdges.length - 1]
    : sortedEdges[0];
  const line = guideEdge ? [guideEdge.start, guideEdge.end] : [];

  return mode === "replace_existing"
    ? orientRouteLineLeftTowardPoint(line, blockCenter)
    : orientRouteLineLeftAwayFromPoint(line, bedCenter);
}

export function inferHarvestRoadPatternFromBeds(
  beds: Array<{ boundary: GeoJsonPolygonInput }>,
  guideLine: LatLngInput[]
) {
  if (beds.length < 4 || guideLine.length < 2) {
    return null as { everyBeds: number; widthBeds: number } | null;
  }

  const start = projectRoutePoint(guideLine[0]);
  const end = projectRoutePoint(guideLine[guideLine.length - 1]);
  const lineLength = Math.hypot(end.x - start.x, end.y - start.y);
  if (!Number.isFinite(lineLength) || lineLength <= 0) {
    return null as { everyBeds: number; widthBeds: number } | null;
  }

  const normal = { x: -(end.y - start.y) / lineLength, y: (end.x - start.x) / lineLength };
  const offsets = beds
    .map((bed) => {
      const center = polygonCenterForRoute(geoJsonPolygonToLatLngs(bed.boundary));
      if (!center) {
        return null;
      }
      const projected = projectRoutePoint(center);
      const offset = (projected.x - start.x) * normal.x + (projected.y - start.y) * normal.y;
      return Number.isFinite(offset) ? offset : null;
    })
    .filter((offset): offset is number => offset != null);

  if (offsets.length < 4) {
    return null as { everyBeds: number; widthBeds: number } | null;
  }

  const orderedOffsets = [...offsets].sort((left, right) => left - right);
  const gaps = orderedOffsets
    .slice(1)
    .map((offset, index) => Math.abs(offset - orderedOffsets[index]))
    .filter((gap) => Number.isFinite(gap) && gap > 0.05);
  if (gaps.length < 3) {
    return null as { everyBeds: number; widthBeds: number } | null;
  }

  const sortedGaps = [...gaps].sort((left, right) => left - right);
  const nominalGap = sortedGaps[Math.max(0, Math.floor(sortedGaps.length / 3) - 1)] ?? sortedGaps[0];
  if (!Number.isFinite(nominalGap) || nominalGap <= 0) {
    return null as { everyBeds: number; widthBeds: number } | null;
  }

  const firstRoadGapIndex = gaps.findIndex((gap) => gap > nominalGap * 1.6);
  if (firstRoadGapIndex < 1) {
    return null as { everyBeds: number; widthBeds: number } | null;
  }

  const roadGap = gaps[firstRoadGapIndex];
  const widthBeds = Math.max(1, Math.min(20, Math.round(roadGap / nominalGap) - 1));
  const everyBeds = firstRoadGapIndex + 1;
  return everyBeds >= 2 && widthBeds >= 1 ? { everyBeds, widthBeds } : null;
}
