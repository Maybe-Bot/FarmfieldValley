import { LatLngTuple } from "leaflet";
import { Bed, Block, Placement } from "./types";
import { geoJsonPolygonToLatLngs } from "./map-utils";

export type CoordinateDraft = {
  lat: number;
  lng: number;
};

export type BedTravelPath = {
  bearing: number;
  lengthM: number;
};

const EARTH_RADIUS_M = 6378137;
const MAX_WEB_MERCATOR_LATITUDE = 85.05112878;
export const WEB_MERCATOR_EQUATOR_METERS_PER_PIXEL = 156543.03392;

export function polygonCenter(points: CoordinateDraft[]) {
  if (points.length === 0) {
    return null;
  }

  const total = points.reduce((sum, point) => ({
    lat: sum.lat + point.lat,
    lng: sum.lng + point.lng
  }), { lat: 0, lng: 0 });

  return {
    lat: total.lat / points.length,
    lng: total.lng / points.length
  };
}

export function polygonPositions(points: CoordinateDraft[]) {
  return points.map((point) => [point.lat, point.lng] as LatLngTuple);
}

export function plantingPlacementCount(placements: Placement[], plantingId: number) {
  return placements
    .filter((placement) => placement.plantingId === plantingId)
    .reduce((sum, placement) => sum + (placement.plantCount ?? 0), 0);
}

export function projectForEdgePicking(point: CoordinateDraft) {
  const x = (point.lng * Math.PI * EARTH_RADIUS_M) / 180;
  const latRadians = (point.lat * Math.PI) / 180;
  const y = EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + latRadians / 2));
  return { x, y };
}

export type ProjectedPoint = ReturnType<typeof projectForEdgePicking>;

export function unprojectFromWebMercator(point: { x: number; y: number }): CoordinateDraft {
  const lng = (point.x / EARTH_RADIUS_M) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(point.y / EARTH_RADIUS_M)) - Math.PI / 2) * (180 / Math.PI);
  return { lat, lng };
}

export function webMercatorScaleFactorForLatitude(lat: number) {
  const clampedLat = Math.max(-MAX_WEB_MERCATOR_LATITUDE, Math.min(MAX_WEB_MERCATOR_LATITUDE, lat));
  const cosine = Math.cos((clampedLat * Math.PI) / 180);
  return 1 / Math.max(0.01, Math.abs(cosine));
}

export function webMercatorMetersForGroundMeters(meters: number, referenceLat: number) {
  return meters * webMercatorScaleFactorForLatitude(referenceLat);
}

export function bedSectionBoundary(bed: Bed, startM: number, lengthM: number, reverseFromEnd = false): Bed["boundary"] | null {
  const boundary = geoJsonPolygonToLatLngs(bed.boundary);
  if (boundary.length < 3 || lengthM <= 0) {
    return null;
  }

  const projected = boundary.map(projectForEdgePicking);
  let longestEdge = { start: projected[0], end: projected[1], length: 0 };
  for (let index = 0; index < projected.length; index += 1) {
    const start = projected[index];
    const end = projected[(index + 1) % projected.length];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length > longestEdge.length) {
      longestEdge = { start, end, length };
    }
  }

  if (longestEdge.length === 0) {
    return null;
  }

  const bedLengthM = Number(bed.bedLengthM);
  const projectedMetersPerBedMeter =
    Number.isFinite(bedLengthM) && bedLengthM > 0
      ? Math.max(0.2, Math.min(5, longestEdge.length / bedLengthM))
      : 1;
  const projectedStartM = Math.max(0, startM) * projectedMetersPerBedMeter;
  const projectedLengthM = Math.max(0, lengthM) * projectedMetersPerBedMeter;
  const along = {
    x: (longestEdge.end.x - longestEdge.start.x) / longestEdge.length,
    y: (longestEdge.end.y - longestEdge.start.y) / longestEdge.length
  };
  const across = { x: -along.y, y: along.x };
  const projectedLocal = projected.map((point) => ({
    along: point.x * along.x + point.y * along.y,
    across: point.x * across.x + point.y * across.y
  }));
  const minAlong = Math.min(...projectedLocal.map((point) => point.along));
  const maxAlong = Math.max(...projectedLocal.map((point) => point.along));
  const minAcross = Math.min(...projectedLocal.map((point) => point.across));
  const maxAcross = Math.max(...projectedLocal.map((point) => point.across));
  const boundedStartM = reverseFromEnd
    ? Math.max(0, longestEdge.length - projectedStartM - projectedLengthM)
    : projectedStartM;
  const sectionStart = Math.min(maxAlong, minAlong + boundedStartM);
  const sectionEnd = Math.min(maxAlong, sectionStart + projectedLengthM);
  if (sectionEnd <= sectionStart) {
    return null;
  }

  const toWorld = (alongPosition: number, acrossPosition: number) => unprojectFromWebMercator({
    x: along.x * alongPosition + across.x * acrossPosition,
    y: along.y * alongPosition + across.y * acrossPosition
  });
  const corners = [
    toWorld(sectionStart, minAcross),
    toWorld(sectionEnd, minAcross),
    toWorld(sectionEnd, maxAcross),
    toWorld(sectionStart, maxAcross)
  ];

  return {
    type: "Polygon",
    coordinates: [[...corners.map((point) => [point.lng, point.lat]), [corners[0].lng, corners[0].lat]]]
  };
}

export function bedTravelPath(bed: Bed): BedTravelPath {
  const boundary = geoJsonPolygonToLatLngs(bed.boundary);
  if (boundary.length < 2) {
    return { bearing: 0, lengthM: Number.isFinite(bed.bedLengthM) ? Math.max(0, bed.bedLengthM) : 0 };
  }

  const projected = boundary.map(projectForEdgePicking);
  let longestEdge = { start: projected[0], end: projected[1], length: 0 };
  for (let index = 0; index < projected.length; index += 1) {
    const start = projected[index];
    const end = projected[(index + 1) % projected.length];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length > longestEdge.length) {
      longestEdge = { start, end, length };
    }
  }

  if (longestEdge.length === 0) {
    return { bearing: 0, lengthM: Number.isFinite(bed.bedLengthM) ? Math.max(0, bed.bedLengthM) : 0 };
  }

  // CSS rotation uses the horizontal screen axis. Web Mercator y points north,
  // so invert dy to make the tractor move along the bed visually on the map.
  return {
    bearing: Math.atan2(-(longestEdge.end.y - longestEdge.start.y), longestEdge.end.x - longestEdge.start.x) * 180 / Math.PI,
    lengthM: longestEdge.length
  };
}

export function firstBedEntrancePose(bed: Bed, entranceSide: "start" | "end") {
  const boundary = geoJsonPolygonToLatLngs(bed.boundary);
  if (boundary.length < 3) {
    return null;
  }

  const projected = boundary.map(projectForEdgePicking);
  let longestEdge = { start: projected[0], end: projected[1], length: 0 };
  for (let index = 0; index < projected.length; index += 1) {
    const start = projected[index];
    const end = projected[(index + 1) % projected.length];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length > longestEdge.length) {
      longestEdge = { start, end, length };
    }
  }

  if (longestEdge.length === 0) {
    return null;
  }

  const along = {
    x: (longestEdge.end.x - longestEdge.start.x) / longestEdge.length,
    y: (longestEdge.end.y - longestEdge.start.y) / longestEdge.length
  };
  const across = { x: -along.y, y: along.x };
  const projectedLocal = projected.map((point) => ({
    along: point.x * along.x + point.y * along.y,
    across: point.x * across.x + point.y * across.y
  }));
  const minAlong = Math.min(...projectedLocal.map((point) => point.along));
  const maxAlong = Math.max(...projectedLocal.map((point) => point.along));
  const minAcross = Math.min(...projectedLocal.map((point) => point.across));
  const maxAcross = Math.max(...projectedLocal.map((point) => point.across));
  const entranceAlong = entranceSide === "end" ? maxAlong : minAlong;
  const entranceAcross = (minAcross + maxAcross) / 2;
  const center = unprojectFromWebMercator({
    x: along.x * entranceAlong + across.x * entranceAcross,
    y: along.y * entranceAlong + across.y * entranceAcross
  });
  const baseBearing = Math.atan2(-(longestEdge.end.y - longestEdge.start.y), longestEdge.end.x - longestEdge.start.x) * 180 / Math.PI;
  return {
    center,
    bearing: entranceSide === "end" ? baseBearing + 180 : baseBearing
  };
}

export function bedSerpentineReversesFromEnd(bed: Bed, block: Block | null, blockBeds: Bed[]) {
  const orderedBeds = blockBeds
    .filter((item) => item.blockId === bed.blockId && item.source !== "road")
    .sort((left, right) => (left.sequenceNo ?? left.id) - (right.sequenceNo ?? right.id));
  const index = orderedBeds.findIndex((item) => item.id === bed.id);
  const zeroBasedIndex = index >= 0 ? index : 0;
  const firstBedStartsAtEnd = block?.bedStartEntranceSide === "end";
  return firstBedStartsAtEnd ? zeroBasedIndex % 2 === 0 : zeroBasedIndex % 2 === 1;
}

export function bedRunDistancePx(path: BedTravelPath, center: CoordinateDraft, zoom: number) {
  const metersPerPixel = WEB_MERCATOR_EQUATOR_METERS_PER_PIXEL * Math.cos(center.lat * Math.PI / 180) / (2 ** zoom);
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0 || !Number.isFinite(path.lengthM) || path.lengthM <= 0) {
    return 44;
  }

  return Math.max(36, Math.min(360, Math.round((path.lengthM / metersPerPixel) / 2)));
}

export function bedSharedVehicleTiming(index: number, count: number) {
  if (count <= 1) {
    return { runDurationSec: 9.5, animationDelaySec: 0 };
  }

  const runDurationSec = 8.8 + (index % 5) * 0.85;
  return {
    runDurationSec,
    animationDelaySec: -((index / count) * runDurationSec)
  };
}

export function buildNextBedPreview(
  linePoints: CoordinateDraft[],
  bedWidthM: number,
  pathSpacingM: number,
  nextBedIndex: number,
  edgeOffsetM: number,
  invertSide: boolean,
  harvestRoadEveryBeds: number | null,
  harvestRoadWidthBeds: number
) {
  if (linePoints.length < 2 || bedWidthM <= 0 || pathSpacingM < 0) {
    return [] as CoordinateDraft[];
  }

  const projectedLine = linePoints.map(projectForEdgePicking);
  const start = projectedLine[0];
  const end = projectedLine[projectedLine.length - 1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return [] as CoordinateDraft[];
  }

  const unit = { x: dx / length, y: dy / length };
  const sideSign = invertSide ? -1 : 1;
  const normal = { x: -unit.y * sideSign, y: unit.x * sideSign };
  const referenceLatitude = linePoints.reduce((sum, point) => sum + point.lat, 0) / linePoints.length;
  const bedWidthProjectedM = webMercatorMetersForGroundMeters(bedWidthM, referenceLatitude);
  const pathSpacingProjectedM = webMercatorMetersForGroundMeters(pathSpacingM, referenceLatitude);
  const edgeOffsetProjectedM = webMercatorMetersForGroundMeters(edgeOffsetM, referenceLatitude);
  const pitch = bedWidthProjectedM + pathSpacingProjectedM;
  const skippedBedSlots = harvestRoadEveryBeds && harvestRoadWidthBeds > 0
    ? Math.floor(nextBedIndex / harvestRoadEveryBeds) * harvestRoadWidthBeds
    : 0;
  const layoutIndex = nextBedIndex + skippedBedSlots;
  const innerOffset = edgeOffsetProjectedM + layoutIndex * pitch;
  const outerOffset = innerOffset + bedWidthProjectedM;

  const innerEdge = projectedLine.map((point) => ({
    x: point.x + normal.x * innerOffset,
    y: point.y + normal.y * innerOffset
  }));
  const outerEdge = projectedLine.map((point) => ({
    x: point.x + normal.x * outerOffset,
    y: point.y + normal.y * outerOffset
  }));

  return [...innerEdge, ...outerEdge.reverse()].map(unprojectFromWebMercator);
}

export function pointToSegmentDistance(point: CoordinateDraft, start: CoordinateDraft, end: CoordinateDraft) {
  const projectedPoint = projectForEdgePicking(point);
  const projectedStart = projectForEdgePicking(start);
  const projectedEnd = projectForEdgePicking(end);
  const dx = projectedEnd.x - projectedStart.x;
  const dy = projectedEnd.y - projectedStart.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(projectedPoint.x - projectedStart.x, projectedPoint.y - projectedStart.y);
  }

  const t = Math.max(0, Math.min(1, ((projectedPoint.x - projectedStart.x) * dx + (projectedPoint.y - projectedStart.y) * dy) / lengthSq));
  const closest = { x: projectedStart.x + t * dx, y: projectedStart.y + t * dy };
  return Math.hypot(projectedPoint.x - closest.x, projectedPoint.y - closest.y);
}

export function pointIsInsideOrOnPolygon(point: CoordinateDraft, polygon: CoordinateDraft[]) {
  if (polygon.length < 3) {
    return false;
  }

  const isOnBoundary = polygon.some((start, index) => {
    const end = polygon[(index + 1) % polygon.length];
    return pointToSegmentDistance(point, start, end) <= 0.25;
  });
  if (isOnBoundary) {
    return true;
  }

  let inside = false;
  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index, index += 1) {
    const current = polygon[index];
    const previous = polygon[previousIndex];
    const crossesRay = (current.lat > point.lat) !== (previous.lat > point.lat);
    if (!crossesRay) {
      continue;
    }

    const crossingLng = ((previous.lng - current.lng) * (point.lat - current.lat)) / (previous.lat - current.lat) + current.lng;
    if (point.lng < crossingLng) {
      inside = !inside;
    }
  }

  return inside;
}

function projectedCrossProduct(
  first: ProjectedPoint,
  second: ProjectedPoint,
  third: ProjectedPoint
) {
  return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
}

export function projectedSegmentsProperlyIntersect(
  firstStart: CoordinateDraft,
  firstEnd: CoordinateDraft,
  secondStart: CoordinateDraft,
  secondEnd: CoordinateDraft
) {
  const a = projectForEdgePicking(firstStart);
  const b = projectForEdgePicking(firstEnd);
  const c = projectForEdgePicking(secondStart);
  const d = projectForEdgePicking(secondEnd);
  const firstSideA = projectedCrossProduct(a, b, c);
  const firstSideB = projectedCrossProduct(a, b, d);
  const secondSideA = projectedCrossProduct(c, d, a);
  const secondSideB = projectedCrossProduct(c, d, b);
  const epsilon = 0.000001;

  return (
    firstSideA * firstSideB < -epsilon &&
    secondSideA * secondSideB < -epsilon
  );
}

export function polygonEdgesCrossBoundary(points: CoordinateDraft[], boundary: CoordinateDraft[]) {
  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const pointStart = points[pointIndex];
    const pointEnd = points[(pointIndex + 1) % points.length];
    for (let boundaryIndex = 0; boundaryIndex < boundary.length; boundaryIndex += 1) {
      const boundaryStart = boundary[boundaryIndex];
      const boundaryEnd = boundary[(boundaryIndex + 1) % boundary.length];
      if (projectedSegmentsProperlyIntersect(pointStart, pointEnd, boundaryStart, boundaryEnd)) {
        return true;
      }
    }
  }

  return false;
}

export function polygonIsInsideOrOnPolygon(points: CoordinateDraft[], boundary: CoordinateDraft[]) {
  return (
    points.length >= 3 &&
    boundary.length >= 3 &&
    points.every((point) => pointIsInsideOrOnPolygon(point, boundary)) &&
    !polygonEdgesCrossBoundary(points, boundary)
  );
}

export function sideOfLine(linePoints: CoordinateDraft[], point: CoordinateDraft) {
  if (linePoints.length < 2) {
    return 0;
  }

  const start = projectForEdgePicking(linePoints[0]);
  const end = projectForEdgePicking(linePoints[linePoints.length - 1]);
  const target = projectForEdgePicking(point);
  return (end.x - start.x) * (target.y - start.y) - (end.y - start.y) * (target.x - start.x);
}

export function orientLineLeftTowardPoint(linePoints: CoordinateDraft[], point: CoordinateDraft | null) {
  if (!point || linePoints.length < 2) {
    return linePoints;
  }

  return sideOfLine(linePoints, point) < 0 ? [...linePoints].reverse() : linePoints;
}

export function orientLineLeftAwayFromPoint(linePoints: CoordinateDraft[], point: CoordinateDraft | null) {
  if (!point || linePoints.length < 2) {
    return linePoints;
  }

  return sideOfLine(linePoints, point) > 0 ? [...linePoints].reverse() : linePoints;
}

export function boundaryEdgeLines(boundary: CoordinateDraft[]) {
  if (boundary.length < 3) {
    return [] as CoordinateDraft[][];
  }

  return boundary.map((point, index) => [point, boundary[(index + 1) % boundary.length]]);
}

export function selectedBedGuideLine(bed: Bed | null, block: Block | null) {
  const bedBoundary = geoJsonPolygonToLatLngs(bed?.boundary ?? null);
  const blockCenter = polygonCenter(geoJsonPolygonToLatLngs(block?.boundary ?? null));
  const bedCenter = polygonCenter(bedBoundary);
  if (bedBoundary.length < 3) {
    return [] as CoordinateDraft[];
  }

  const projectedCenter = blockCenter ? projectForEdgePicking(blockCenter) : null;
  const edges = bedBoundary.map((start, index) => {
    const end = bedBoundary[(index + 1) % bedBoundary.length];
    const projectedStart = projectForEdgePicking(start);
    const projectedEnd = projectForEdgePicking(end);
    const midpointProjected = {
      x: (projectedStart.x + projectedEnd.x) / 2,
      y: (projectedStart.y + projectedEnd.y) / 2
    };
    return {
      start,
      end,
      length: Math.hypot(projectedEnd.x - projectedStart.x, projectedEnd.y - projectedStart.y),
      centerDistance: projectedCenter
        ? Math.hypot(midpointProjected.x - projectedCenter.x, midpointProjected.y - projectedCenter.y)
        : 0
    };
  });

  const longestLength = Math.max(...edges.map((edge) => edge.length));
  const longEdges = edges.filter((edge) => edge.length >= longestLength * 0.8);
  const guideEdge = longEdges.sort((left, right) => left.centerDistance - right.centerDistance)[0] ?? edges[0];
  return guideEdge ? orientLineLeftAwayFromPoint([guideEdge.start, guideEdge.end], bedCenter) : [];
}

export function sortedPlantableBlockBeds(beds: Bed[]) {
  return beds
    .filter((bed) => bed.source !== "road")
    .sort((left, right) => (left.sequenceNo ?? left.id) - (right.sequenceNo ?? right.id));
}

export function longestBoundaryEdgeLine(boundary: CoordinateDraft[]) {
  if (boundary.length < 2) {
    return [] as CoordinateDraft[];
  }

  return boundary
    .map((start, index) => {
      const end = boundary[(index + 1) % boundary.length];
      const projectedStart = projectForEdgePicking(start);
      const projectedEnd = projectForEdgePicking(end);
      return {
        line: [start, end] as CoordinateDraft[],
        length: Math.hypot(projectedEnd.x - projectedStart.x, projectedEnd.y - projectedStart.y)
      };
    })
    .sort((left, right) => right.length - left.length)[0]?.line ?? [];
}

export function splitGuideLineForBlock(block: Block | null, beds: Bed[]) {
  const firstBed = sortedPlantableBlockBeds(beds)[0] ?? null;
  const bedGuide = selectedBedGuideLine(firstBed, block);
  if (bedGuide.length >= 2) {
    return bedGuide;
  }

  return longestBoundaryEdgeLine(geoJsonPolygonToLatLngs(block?.boundary ?? null));
}

export function firstBedSideReferencePoint(block: Block | null, beds: Bed[]) {
  const firstBed = sortedPlantableBlockBeds(beds)[0] ?? null;
  const firstBedCenter = polygonCenter(geoJsonPolygonToLatLngs(firstBed?.boundary ?? null));
  if (firstBedCenter) {
    return firstBedCenter;
  }

  const boundary = geoJsonPolygonToLatLngs(block?.boundary ?? null);
  const guideLine = splitGuideLineForBlock(block, beds);
  if (boundary.length < 3 || guideLine.length < 2) {
    return polygonCenter(boundary);
  }

  const start = projectForEdgePicking(guideLine[0]);
  const end = projectForEdgePicking(guideLine[guideLine.length - 1]);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return polygonCenter(boundary);
  }

  const along = { x: dx / length, y: dy / length };
  const across = { x: -along.y, y: along.x };
  const projected = boundary.map(projectForEdgePicking);
  const alongValues = projected.map((point) => point.x * along.x + point.y * along.y);
  const acrossValues = projected.map((point) => point.x * across.x + point.y * across.y);
  return unprojectFromWebMercator({
    x: along.x * ((Math.min(...alongValues) + Math.max(...alongValues)) / 2) + across.x * Math.min(...acrossValues),
    y: along.y * ((Math.min(...alongValues) + Math.max(...alongValues)) / 2) + across.y * Math.min(...acrossValues)
  });
}

export function bedParallelSplitLineThroughPoint(anchor: CoordinateDraft, block: Block | null, beds: Bed[]) {
  const boundary = geoJsonPolygonToLatLngs(block?.boundary ?? null);
  const guideLine = splitGuideLineForBlock(block, beds);
  if (boundary.length < 3 || guideLine.length < 2) {
    return [] as CoordinateDraft[];
  }

  const start = projectForEdgePicking(guideLine[0]);
  const end = projectForEdgePicking(guideLine[guideLine.length - 1]);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return [];
  }

  const unit = { x: dx / length, y: dy / length };
  const projectedBoundary = boundary.map(projectForEdgePicking);
  const anchorPoint = projectForEdgePicking(anchor);
  const boundaryAlongValues = projectedBoundary.map((point) => point.x * unit.x + point.y * unit.y);
  const anchorAlong = anchorPoint.x * unit.x + anchorPoint.y * unit.y;
  const minAlong = Math.min(...boundaryAlongValues);
  const maxAlong = Math.max(...boundaryAlongValues);
  const padding = Math.max(25, (maxAlong - minAlong) * 0.2);

  return [
    unprojectFromWebMercator({
      x: anchorPoint.x + unit.x * (minAlong - anchorAlong - padding),
      y: anchorPoint.y + unit.y * (minAlong - anchorAlong - padding)
    }),
    unprojectFromWebMercator({
      x: anchorPoint.x + unit.x * (maxAlong - anchorAlong + padding),
      y: anchorPoint.y + unit.y * (maxAlong - anchorAlong + padding)
    })
  ];
}

export function bedParallelSplitLinesForBlock(block: Block | null, beds: Bed[], anchors: CoordinateDraft[]) {
  return anchors
    .map((anchor) => bedParallelSplitLineThroughPoint(anchor, block, beds))
    .filter((line) => line.length === 2);
}

export function projectedLineSide(line: ProjectedPoint[], point: ProjectedPoint) {
  if (line.length < 2) {
    return 0;
  }
  const start = line[0];
  const end = line[line.length - 1];
  return (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
}

export function projectedLineIntersection(
  lineStart: ProjectedPoint,
  lineEnd: ProjectedPoint,
  segmentStart: ProjectedPoint,
  segmentEnd: ProjectedPoint
) {
  const lineDx = lineEnd.x - lineStart.x;
  const lineDy = lineEnd.y - lineStart.y;
  const segmentDx = segmentEnd.x - segmentStart.x;
  const segmentDy = segmentEnd.y - segmentStart.y;
  const denominator = lineDx * segmentDy - lineDy * segmentDx;
  if (Math.abs(denominator) < 0.000001) {
    return null;
  }
  const t = ((segmentStart.x - lineStart.x) * segmentDy - (segmentStart.y - lineStart.y) * segmentDx) / denominator;
  return {
    x: lineStart.x + t * lineDx,
    y: lineStart.y + t * lineDy
  };
}

export function clipProjectedPolygonToLineSide(polygon: ProjectedPoint[], line: ProjectedPoint[], keepSign: number) {
  if (polygon.length < 3 || line.length < 2 || keepSign === 0) {
    return polygon;
  }

  const output: ProjectedPoint[] = [];
  const inside = (point: ProjectedPoint) => projectedLineSide(line, point) * keepSign >= -0.000001;

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    const currentInside = inside(current);
    const previousInside = inside(previous);
    const intersection = projectedLineIntersection(line[0], line[line.length - 1], previous, current);

    if (currentInside) {
      if (!previousInside && intersection) {
        output.push(intersection);
      }
      output.push(current);
    } else if (previousInside && intersection) {
      output.push(intersection);
    }
  }

  return output;
}

export function clipLineToPolygon(line: CoordinateDraft[], boundary: CoordinateDraft[]) {
  if (line.length < 2 || boundary.length < 3) {
    return line;
  }

  const projectedLine = line.map(projectForEdgePicking);
  const projectedBoundary = boundary.map(projectForEdgePicking);
  const intersections: ProjectedPoint[] = [];
  for (let index = 0; index < projectedBoundary.length; index += 1) {
    const start = projectedBoundary[index];
    const end = projectedBoundary[(index + 1) % projectedBoundary.length];
    const intersection = projectedLineIntersection(projectedLine[0], projectedLine[1], start, end);
    if (!intersection) {
      continue;
    }
    const segmentDx = end.x - start.x;
    const segmentDy = end.y - start.y;
    const segmentLengthSq = segmentDx * segmentDx + segmentDy * segmentDy;
    const segmentT = segmentLengthSq === 0 ? 0 : ((intersection.x - start.x) * segmentDx + (intersection.y - start.y) * segmentDy) / segmentLengthSq;
    if (segmentT >= -0.000001 && segmentT <= 1.000001) {
      const duplicate = intersections.some((point) => Math.hypot(point.x - intersection.x, point.y - intersection.y) < 0.01);
      if (!duplicate) {
        intersections.push(intersection);
      }
    }
  }

  if (intersections.length < 2) {
    return line;
  }

  const direction = {
    x: projectedLine[1].x - projectedLine[0].x,
    y: projectedLine[1].y - projectedLine[0].y
  };
  return intersections
    .sort((left, right) => (
      ((left.x - projectedLine[0].x) * direction.x + (left.y - projectedLine[0].y) * direction.y)
      - ((right.x - projectedLine[0].x) * direction.x + (right.y - projectedLine[0].y) * direction.y)
    ))
    .slice(0, 2)
    .map(unprojectFromWebMercator);
}

export function splitAreaPreviewForBlock(
  block: Block | null,
  splitLines: CoordinateDraft[][],
  firstBedSidePoint: CoordinateDraft | null
) {
  const boundary = geoJsonPolygonToLatLngs(block?.boundary ?? null);
  if (boundary.length < 3 || splitLines.length < 1 || splitLines.length > 2 || splitLines.some((line) => line.length < 2)) {
    return [] as CoordinateDraft[];
  }

  const projectedBoundary = boundary.map(projectForEdgePicking);
  const projectedLines = splitLines.map((line) => line.map(projectForEdgePicking));
  let clippedPolygon = projectedBoundary;

  if (projectedLines.length === 1) {
    const sidePoint = firstBedSidePoint ?? polygonCenter(boundary);
    const keepSign = sidePoint ? Math.sign(projectedLineSide(projectedLines[0], projectForEdgePicking(sidePoint))) : 0;
    clippedPolygon = clipProjectedPolygonToLineSide(clippedPolygon, projectedLines[0], keepSign || 1);
  } else {
    const firstLine = projectedLines[0];
    const secondLine = projectedLines[1];
    const secondLineAnchorSide = Math.sign(projectedLineSide(firstLine, secondLine[0]));
    const firstLineAnchorSide = Math.sign(projectedLineSide(secondLine, firstLine[0]));
    clippedPolygon = clipProjectedPolygonToLineSide(clippedPolygon, firstLine, secondLineAnchorSide || 1);
    clippedPolygon = clipProjectedPolygonToLineSide(clippedPolygon, secondLine, firstLineAnchorSide || 1);
  }

  return clippedPolygon.length >= 3 ? clippedPolygon.map(unprojectFromWebMercator) : [];
}
