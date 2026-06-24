import { PoolClient } from "pg";
import { z } from "zod";
import { zoneActualStateSchema } from "../schemas";

type ServerModule = typeof import("../server");

export type LatLngInput = { lat: number; lng: number };
export type GeoJsonPolygonInput = { type: "Polygon"; coordinates: number[][][] } | null;

const ROUTE_EARTH_RADIUS_M = 6378137;

export async function syncSingleBlockZoneToBlockBoundary(
  client: PoolClient,
  deps: { upsertBlockZoneGeometry: ServerModule["upsertBlockZoneGeometry"] },
  options: {
    blockId: number;
    farmId: number;
    coordinates: LatLngInput[];
  }
) {
  const zoneResult = await client.query<{
    id: number;
    name: string;
    planned_use: "beds" | "cover_crop" | null;
    actual_state: z.infer<typeof zoneActualStateSchema>;
    cover_crop_name_id: number | null;
    planned_cover_crop_seed_date: string | null;
    planned_cover_crop_terminate_date: string | null;
    actual_cover_crop_seed_date: string | null;
    actual_cover_crop_terminate_date: string | null;
    notes: string | null;
  }>(
    `
      select
        id,
        name,
        planned_use,
        actual_state,
        cover_crop_name_id,
        planned_cover_crop_seed_date::text,
        planned_cover_crop_terminate_date::text,
        actual_cover_crop_seed_date::text,
        actual_cover_crop_terminate_date::text,
        notes
      from block_zones
      where block_id = $1
        and block_id in (
          select block.id
          from blocks block
          join fields field on field.id = block.field_id
          where field.farm_id = $2
        )
      order by id
    `,
    [options.blockId, options.farmId]
  );

  if (zoneResult.rows.length !== 1) {
    return;
  }

  const zone = zoneResult.rows[0];
  await deps.upsertBlockZoneGeometry(client, {
    id: zone.id,
    blockId: options.blockId,
    farmId: options.farmId,
    name: zone.name,
    plannedUse: zone.planned_use,
    actualState: zone.actual_state,
    coverCropNameId: zone.cover_crop_name_id,
    coverCropName: null,
    plannedCoverCropSeedDate: zone.planned_cover_crop_seed_date,
    plannedCoverCropTerminateDate: zone.planned_cover_crop_terminate_date,
    actualCoverCropSeedDate: zone.actual_cover_crop_seed_date,
    actualCoverCropTerminateDate: zone.actual_cover_crop_terminate_date,
    notes: zone.notes,
    coordinates: options.coordinates
  });
}

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

export async function resolveBedMakingPreset(
  client: PoolClient,
  farmId: number,
  targetBed: {
    bed_preset_id: number | null;
    bed_width_m: string | null;
    path_spacing_m: string | null;
    area_sqm: string | null;
    bed_length_m: string | null;
  }
) {
  if (targetBed.bed_preset_id != null && targetBed.bed_width_m != null && targetBed.path_spacing_m != null) {
    return {
      id: targetBed.bed_preset_id,
      bedWidthM: Number(targetBed.bed_width_m),
      pathSpacingM: Number(targetBed.path_spacing_m)
    };
  }

  const existingPreset = await client.query<{ id: number; bed_width_m: string; path_spacing_m: string }>(
    `
      select id, bed_width_m, path_spacing_m
      from bed_presets
      where farm_id = $1
        and is_road = false
      order by id
      limit 1
    `,
    [farmId]
  );
  if (existingPreset.rows[0]) {
    return {
      id: existingPreset.rows[0].id,
      bedWidthM: Number(existingPreset.rows[0].bed_width_m),
      pathSpacingM: Number(existingPreset.rows[0].path_spacing_m)
    };
  }

  const inferredWidth = targetBed.area_sqm != null && targetBed.bed_length_m != null
    ? Number(targetBed.area_sqm) / Math.max(0.1, Number(targetBed.bed_length_m))
    : null;
  const bedWidthM = inferredWidth && Number.isFinite(inferredWidth) && inferredWidth > 0
    ? Math.min(3, Math.max(0.3, inferredWidth))
    : 0.9144;
  const pathSpacingM = inferredWidth && Number.isFinite(inferredWidth) && inferredWidth > 0
    ? Math.max(0.3, Math.min(1.2, bedWidthM * 0.6))
    : 0.6096;
  const inserted = await client.query<{ id: number; bed_width_m: string; path_spacing_m: string }>(
    `
      insert into bed_presets (farm_id, name, bed_width_m, path_spacing_m, is_road, notes)
      values ($1, 'Recorded beds', $2, $3, false, 'Created automatically while recording bed-making work for a block whose planned beds had no saved preset.')
      on conflict (farm_id, name)
      do update set updated_at = now()
      returning id, bed_width_m, path_spacing_m
    `,
    [farmId, bedWidthM, pathSpacingM]
  );

  return {
    id: inserted.rows[0].id,
    bedWidthM: Number(inserted.rows[0].bed_width_m),
    pathSpacingM: Number(inserted.rows[0].path_spacing_m)
  };
}

export async function loadBedMakingPreset(client: PoolClient, farmId: number, presetId: number) {
  const result = await client.query<{ id: number; bed_width_m: string; path_spacing_m: string; is_road: boolean }>(
    `
      select id, bed_width_m, path_spacing_m, is_road
      from bed_presets
      where id = $1 and farm_id = $2
    `,
    [presetId, farmId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Bed preset not found.");
  }
  if (row.is_road) {
    throw new Error("Choose a bed preset, not a road/path preset.");
  }

  return {
    id: row.id,
    bedWidthM: Number(row.bed_width_m),
    pathSpacingM: Number(row.path_spacing_m)
  };
}

export async function loadGeneratedBedBoundary(client: PoolClient, bedId: number, farmId: number) {
  const result = await client.query<{ boundary: GeoJsonPolygonInput }>(
    `
      select ST_AsGeoJSON(coalesce(bed.boundary, ST_Transform(bed.geom, 4326)))::json as boundary
      from beds bed
      join blocks block on block.id = bed.block_id
      join fields field on field.id = block.field_id
      where bed.id = $1 and field.farm_id = $2
    `,
    [bedId, farmId]
  );
  return result.rows[0]?.boundary ?? null;
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
