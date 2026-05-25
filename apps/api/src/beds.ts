/**
 * Geometry helpers for bed generation.
 *
 * Beds can be generated from a selected block edge, a manually drawn line, or a
 * selected existing bed. The API stores the resulting bed footprint in PostGIS
 * so later drone/photo-derived corrections can update exact placement without
 * changing the higher-level plan.
 */
export type BedLineMode = "straight" | "curved";
export type ProjectedPoint = { x: number; y: number };

export type LegacyBedDirection = "north_south" | "east_west";
export type BlockBounds3857 = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type BedGenerationInput = {
  bedWidthM: number;
  pathSpacingM: number;
  count: number;
  namePrefix: string;
  startNumber: number;
  invertSide: boolean;
  fillWholeBlock: boolean;
  lineMode: BedLineMode;
  linePoints: ProjectedPoint[];
};

export type BedLayoutRow = {
  name: string;
  sequenceNo: number;
  bedLengthM: number;
  wkt3857: string;
};

export type LegacyBedLayoutRow = {
  name: string;
  sequenceNo: number;
  x: number;
  y: number;
  width: number;
  height: number;
  bedLengthM: number;
};

const FIRST_BED_CLIP_NUDGE_M = 0.15;

export function projectWgs84To3857(lat: number, lng: number): ProjectedPoint {
  const x = (lng * Math.PI * 6378137) / 180;
  const latRadians = (lat * Math.PI) / 180;
  const y = 6378137 * Math.log(Math.tan(Math.PI / 4 + latRadians / 2));
  return { x, y };
}

// PostGIS functions that offset/clip generated beds run in Web Mercator meters.
export function lineStringWkt3857(points: ProjectedPoint[]) {
  return `LINESTRING(${points.map((point) => `${point.x} ${point.y}`).join(", ")})`;
}

// Extending the line gives PostGIS enough length to clip beds cleanly to irregular blocks.
export function extendStraightLine(points: ProjectedPoint[], extensionM = 100000): ProjectedPoint[] {
  if (points.length !== 2) {
    throw new Error("Straight bed line needs exactly 2 points");
  }

  const start = points[0];
  const end = points[1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);

  if (length === 0) {
    throw new Error("Bed line must have distinct points");
  }

  const ux = dx / length;
  const uy = dy / length;

  return [
    { x: start.x - ux * extensionM, y: start.y - uy * extensionM },
    { x: end.x + ux * extensionM, y: end.y + uy * extensionM }
  ];
}

// The UI uses "normal side" vs "other side"; this helper maps that to a PostGIS offset side.
export function resolveSide(points: ProjectedPoint[], invertSide: boolean) {
  const start = points[0];
  const end = points[points.length - 1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);

  if (length === 0) {
    throw new Error("Bed line must have distinct points");
  }

  const preferred = "left";

  if (!invertSide) {
    return preferred;
  }

  return preferred === "left" ? "right" : "left";
}

function pointToLineDistance(point: ProjectedPoint, start: ProjectedPoint, end: ProjectedPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / length;
}

export function simplifyNearlyStraightLine(points: ProjectedPoint[]) {
  if (points.length <= 2) {
    return points;
  }

  const start = points[0];
  const end = points[points.length - 1];
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (length <= 0) {
    return points;
  }

  const maxDeviation = Math.max(...points.slice(1, -1).map((point) => pointToLineDistance(point, start, end)));
  return maxDeviation <= Math.max(3, length * 0.06) ? [start, end] : points;
}

export function straightLineFromGuide(points: ProjectedPoint[]) {
  if (points.length <= 2) {
    return points;
  }

  return [points[0], points[points.length - 1]];
}

export function resolveBedEdgeOffsets(options: {
  edgeOffsetM: number;
  layoutIndex: number;
  bedWidthM: number;
  pathSpacingM: number;
  sideSign: 1 | -1;
}) {
  const boundaryClipNudgeM =
    options.edgeOffsetM === 0 && options.layoutIndex === 0
      ? Math.min(FIRST_BED_CLIP_NUDGE_M, Math.max(0, options.bedWidthM * 0.04))
      : 0;
  const unsignedOffset = options.edgeOffsetM + options.layoutIndex * (options.bedWidthM + options.pathSpacingM);

  return {
    clipOffsetM: (unsignedOffset + boundaryClipNudgeM) * options.sideSign
  };
}

export function validateBedLine(lineMode: BedLineMode, linePoints: ProjectedPoint[]) {
  const minimum = lineMode === "straight" ? 2 : 3;
  const maximum = lineMode === "straight" ? 2 : 12;

  if (linePoints.length < minimum || linePoints.length > maximum) {
    throw new Error(
      lineMode === "straight"
        ? "Straight bed line needs exactly 2 points"
        : "Curved bed line needs between 3 and 12 points"
    );
  }
}

// Older rectangular bed generator kept for compatibility with seed/demo code.
export function generateBedLayouts(
  bounds: BlockBounds3857,
  options: {
    bedWidthM: number;
    pathSpacingM: number;
    count: number;
    direction: LegacyBedDirection;
    namePrefix: string;
    startNumber: number;
  }
): LegacyBedLayoutRow[] {
  const rows: LegacyBedLayoutRow[] = [];
  const pitch = options.bedWidthM + options.pathSpacingM;

  for (let index = 0; index < options.count; index += 1) {
    if (options.direction === "north_south") {
      const x = bounds.minX + index * pitch;
      rows.push({
        name: `${options.namePrefix}${options.startNumber + index}`,
        sequenceNo: options.startNumber + index,
        x,
        y: bounds.minY,
        width: options.bedWidthM,
        height: bounds.maxY - bounds.minY,
        bedLengthM: bounds.maxY - bounds.minY
      });
      continue;
    }

    const y = bounds.minY + index * pitch;
    rows.push({
      name: `${options.namePrefix}${options.startNumber + index}`,
      sequenceNo: options.startNumber + index,
      x: bounds.minX,
      y,
      width: bounds.maxX - bounds.minX,
      height: options.bedWidthM,
      bedLengthM: bounds.maxX - bounds.minX
    });
  }

  return rows;
}
