import express from "express";
import { PoolClient } from "pg";
import { z } from "zod";
import { AuthContext } from "../auth";
import { seedStarterSeedCatalog } from "../default-seed-catalog";
import { pool } from "../db";
import { polygonWkt } from "../geometry";
import { recalculatePlantingTasks } from "../scheduler";
import { ActualEventType, FarmRole, isCurrentTaskType, isLegacyTaskType, PlantingStatus, TaskType } from "../types";
import { registerSpreadsheetImportRoutes } from "./spreadsheet-import";
import {
  actualEventSchema,
  bedGenerationSchema,
  bedPresetSchema,
  blockPlacementPlanSchema,
  blockPolygonSchema,
  blockPolygonUpdateSchema,
  blockZoneSchema,
  blockZoneSplitSchema,
  blockZoneUpdateSchema,
  coverCropNameSchema,
  coverCropWorkSchema,
  fieldPolygonSchema,
  fieldPolygonUpdateSchema,
  geometrySchema,
  harvestSchema,
  placementSchema,
  plantingSchema,
  plantingWorkflowSchema,
  seedItemSchema,
  SeedItemLotInput,
  taskFlowSchema,
  taskFlowUpdateSchema,
  taskRecordSchema,
  tractorProfileSchema,
  unplannedWorkSchema,
  zoneActualStateSchema
} from "../schemas";

type NormalizedSeedLot = { lotNumber: string; stockQuantity: number | null };

type FarmRouteDeps = {
  asyncHandler: (
    handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>
  ) => express.RequestHandler;
  currentAuth: (req: express.Request) => AuthContext | null;
  requireRole: (role?: FarmRole) => express.RequestHandler;
  runWithUndoSnapshot: <T>(
    auth: AuthContext,
    label: string,
    work: (client: PoolClient) => Promise<T>
  ) => Promise<T>;
  createUndoSnapshot: (client: PoolClient, auth: AuthContext, label: string) => Promise<void>;
  pruneUndoSnapshots: (client: PoolClient, auth: AuthContext) => Promise<void>;
  normalizedSeedLots: (
    lots: SeedItemLotInput[] | undefined,
    fallbackLotNumber?: string | null,
    fallbackStockQuantity?: number | null
  ) => NormalizedSeedLot[];
  replaceSeedItemLots: (
    client: PoolClient,
    seedItemId: number,
    farmId: number,
    lots: NormalizedSeedLot[]
  ) => Promise<void>;
  ensureFieldInFarm: any;
  ensureBlockInFarm: any;
  ensureBlockZoneInFarm: any;
  ensureBedInFarm: any;
  ensurePlantableBedInFarm: any;
  ensurePlantingInFarm: any;
  ensureTaskInFarm: any;
  ensureTaskFlowInFarm: any;
  ensureBedPresetInFarm: any;
  ensureTractorProfileInFarm: any;
  ensureSeedItemInFarm: any;
  ensureSeedItemLot: any;
  learnSeedItemSpacingFromPlanting: any;
  upsertCoverCropName: any;
  insertGeneratedBeds: any;
  blockIdForBed: any;
  fieldIdForBlock: any;
  upsertBlockBedMakingTask: any;
  reflowBlockPlacementPlan: any;
  reflowExistingBlockPlacementPlan: any;
  moveBlockBedAssignmentsToOverflowForReplacement: any;
  appendPlantingToBlockPlacementPlan: any;
  clearIntendedBedsForField: any;
  clearIntendedBedsForBlock: any;
  upsertFieldGeometry: any;
  upsertBlockGeometry: any;
  ensureDefaultBlockArea: any;
  getBedContext: any;
  recordFarmEvent: any;
  rectangleWkt: any;
  upsertBlockZoneGeometry: any;
  splitBlockBoundaryIntoZoneCoordinates: any;
  saveTaskFlowTemplate: any;
  plantingLocationIds: any;
  createPlantingFromInput: any;
  actualUpdateForTaskType: any;
  todayIsoDate: any;
  assertNoFuturePlantingDate: any;
  assertNoFuturePlantingStatusDate: any;
};

type LatLngInput = { lat: number; lng: number };
type GeoJsonPolygonInput = { type: "Polygon"; coordinates: number[][][] } | null;

const ROUTE_EARTH_RADIUS_M = 6378137;

async function syncSingleBlockZoneToBlockBoundary(
  client: PoolClient,
  deps: Pick<FarmRouteDeps, "upsertBlockZoneGeometry">,
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
      order by id
    `,
    [options.blockId]
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

function geoJsonPolygonToLatLngs(value: GeoJsonPolygonInput | unknown) {
  if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "Polygon") {
    return [] as LatLngInput[];
  }

  const ring = (value as GeoJsonPolygonInput)?.coordinates?.[0] ?? [];
  return ring
    .slice(0, ring.length > 1 ? -1 : ring.length)
    .map((coordinate) => ({ lng: Number(coordinate[0]), lat: Number(coordinate[1]) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

function projectRoutePoint(point: LatLngInput) {
  const x = (point.lng * Math.PI * ROUTE_EARTH_RADIUS_M) / 180;
  const latRadians = (point.lat * Math.PI) / 180;
  const y = ROUTE_EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + latRadians / 2));
  return { x, y };
}

function polygonCenterForRoute(points: LatLngInput[]) {
  if (points.length === 0) {
    return null;
  }

  const totals = points.reduce((sum, point) => ({ lat: sum.lat + point.lat, lng: sum.lng + point.lng }), { lat: 0, lng: 0 });
  return { lat: totals.lat / points.length, lng: totals.lng / points.length };
}

function routeSideOfLine(linePoints: LatLngInput[], point: LatLngInput) {
  if (linePoints.length < 2) {
    return 0;
  }

  const start = projectRoutePoint(linePoints[0]);
  const end = projectRoutePoint(linePoints[linePoints.length - 1]);
  const target = projectRoutePoint(point);
  return (end.x - start.x) * (target.y - start.y) - (end.y - start.y) * (target.x - start.x);
}

function orientRouteLineLeftTowardPoint(linePoints: LatLngInput[], point: LatLngInput | null) {
  if (!point || linePoints.length < 2) {
    return linePoints;
  }

  return routeSideOfLine(linePoints, point) < 0 ? [...linePoints].reverse() : linePoints;
}

function orientRouteLineLeftAwayFromPoint(linePoints: LatLngInput[], point: LatLngInput | null) {
  if (!point || linePoints.length < 2) {
    return linePoints;
  }

  return routeSideOfLine(linePoints, point) > 0 ? [...linePoints].reverse() : linePoints;
}

function bedMakingGuideLine(
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

async function resolveBedMakingPreset(
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

async function loadBedMakingPreset(client: PoolClient, farmId: number, presetId: number) {
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

async function loadGeneratedBedBoundary(client: PoolClient, bedId: number) {
  const result = await client.query<{ boundary: GeoJsonPolygonInput }>(
    `select ST_AsGeoJSON(coalesce(boundary, ST_Transform(geom, 4326)))::json as boundary from beds where id = $1`,
    [bedId]
  );
  return result.rows[0]?.boundary ?? null;
}

function inferHarvestRoadPatternFromBeds(
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

export function registerFarmRoutes(app: express.Express, deps: FarmRouteDeps) {
  const {
    asyncHandler,
    currentAuth,
    requireRole,
    runWithUndoSnapshot,
    createUndoSnapshot,
    pruneUndoSnapshots,
    normalizedSeedLots,
    replaceSeedItemLots,
    ensureFieldInFarm,
    ensureBlockInFarm,
    ensureBlockZoneInFarm,
    ensureBedInFarm,
    ensurePlantableBedInFarm,
    ensurePlantingInFarm,
    ensureTaskInFarm,
    ensureTaskFlowInFarm,
    ensureBedPresetInFarm,
    ensureTractorProfileInFarm,
    ensureSeedItemInFarm,
    ensureSeedItemLot,
    learnSeedItemSpacingFromPlanting,
    upsertCoverCropName,
    insertGeneratedBeds,
    blockIdForBed,
    fieldIdForBlock,
    upsertBlockBedMakingTask,
    reflowBlockPlacementPlan,
    reflowExistingBlockPlacementPlan,
    moveBlockBedAssignmentsToOverflowForReplacement,
    appendPlantingToBlockPlacementPlan,
    clearIntendedBedsForField,
    clearIntendedBedsForBlock,
    upsertFieldGeometry,
    upsertBlockGeometry,
    ensureDefaultBlockArea,
    getBedContext,
    recordFarmEvent,
    rectangleWkt,
    upsertBlockZoneGeometry,
    splitBlockBoundaryIntoZoneCoordinates,
    saveTaskFlowTemplate,
    plantingLocationIds,
    createPlantingFromInput,
    actualUpdateForTaskType,
    todayIsoDate,
    assertNoFuturePlantingDate,
    assertNoFuturePlantingStatusDate
  } = deps;

app.get("/api/dashboard", requireRole("worker"), asyncHandler(async (req, res) => {
  const auth = currentAuth(req) as AuthContext;
  const [farm, fields, blocks, blockZones, beds, bedPresets, coverCropNames, seedItems, crops, varieties, taskFlowTemplates, taskFlowNodes, taskFlowEdges, tractorProfiles, plantings, placements, placementGaps, placementOverflows, events, tasks, harvests] = await Promise.all([
    pool.query(`
      select
        id,
        name,
        notes,
        maps_private as "mapsPrivate"
      from farms
      where id = $1
      limit 1
    `, [auth.farmId]),
    pool.query(`
      select
        field.id,
        field.farm_id as "farmId",
        farm.name as "farmName",
        field.name,
        field.notes,
        field.area_sqm as "areaSqM",
        ST_AsGeoJSON(field.boundary)::json as boundary,
        ST_AsGeoJSON(field.centroid)::json as centroid
      from fields field
      join farms farm on farm.id = field.farm_id
      where field.farm_id = $1
      order by farm.name, field.id
    `, [auth.farmId]),
    pool.query(`
      select
        b.id,
        f.farm_id as "farmId",
        farm.name as "farmName",
        b.field_id as "fieldId",
        b.name,
        b.notes,
        b.bed_start_entrance_side as "bedStartEntranceSide",
        b.area_sqm as "areaSqM",
        f.name as "fieldName",
        ST_AsGeoJSON(b.boundary)::json as boundary,
        ST_AsGeoJSON(b.centroid)::json as centroid
      from blocks b
      join fields f on f.id = b.field_id
      join farms farm on farm.id = f.farm_id
      where f.farm_id = $1
      order by farm.name, f.id, b.id
    `, [auth.farmId]),
    pool.query(`
      select
        zone.id,
        field.farm_id as "farmId",
        farm.name as "farmName",
        zone.block_id as "blockId",
        block.name as "blockName",
        field.id as "fieldId",
        field.name as "fieldName",
        zone.name,
        zone.planned_use as "plannedUse",
        zone.actual_state as "actualState",
        zone.cover_crop_name_id as "coverCropNameId",
        cover_crop.name as "coverCropName",
        zone.planned_cover_crop_seed_date as "plannedCoverCropSeedDate",
        zone.planned_cover_crop_terminate_date as "plannedCoverCropTerminateDate",
        zone.actual_cover_crop_seed_date as "actualCoverCropSeedDate",
        zone.actual_cover_crop_terminate_date as "actualCoverCropTerminateDate",
        zone.notes,
        zone.area_sqm as "areaSqM",
        ST_AsGeoJSON(zone.boundary)::json as boundary,
        ST_AsGeoJSON(zone.centroid)::json as centroid
      from block_zones zone
      join blocks block on block.id = zone.block_id
      join fields field on field.id = block.field_id
      join farms farm on farm.id = field.farm_id
      left join cover_crop_names cover_crop on cover_crop.id = zone.cover_crop_name_id
      where field.farm_id = $1
      order by farm.name, field.id, block.id, zone.id
    `, [auth.farmId]),
    pool.query(`
      select
        b.id,
        field.farm_id as "farmId",
        farm.name as "farmName",
        b.block_id as "blockId",
        bl.name as "blockName",
        b.zone_id as "zoneId",
        zone.name as "zoneName",
        b.name,
        b.is_permanent as "isPermanent",
        b.notes,
        b.x,
        b.y,
        b.width,
        b.height,
        b.bed_length_m as "bedLengthM",
        b.source,
        b.direction,
        b.sequence_no as "sequenceNo",
        b.bed_preset_id as "bedPresetId",
        bp.name as "bedPresetName",
        b.area_sqm as "areaSqM",
        b.geometry_source as "geometrySource",
        b.geometry_updated_at as "geometryUpdatedAt",
        b.geometry_notes as "geometryNotes",
        ST_AsGeoJSON(coalesce(b.boundary, ST_Transform(b.geom, 4326)))::json as boundary,
        coalesce(sum(pp.bed_length_used_m), 0) as "occupiedLengthM"
      from beds b
      join blocks bl on bl.id = b.block_id
      join fields field on field.id = bl.field_id
      join farms farm on farm.id = field.farm_id
      left join block_zones zone on zone.id = b.zone_id
      left join bed_presets bp on bp.id = b.bed_preset_id
      left join planting_placements pp on pp.bed_id = b.id and field.farm_id = $1
      where field.farm_id = $1
      group by b.id, field.id, field.farm_id, farm.name, bl.id, bl.name, zone.id, zone.name, bp.id, bp.name
      order by farm.name, field.id, bl.id, b.id
    `, [auth.farmId]),
    pool.query(`
      select
        id,
        farm_id as "farmId",
        name,
        bed_width_m as "bedWidthM",
        path_spacing_m as "pathSpacingM",
        is_road as "isRoad",
        notes
      from bed_presets
      where farm_id = $1
      order by name
    `, [auth.farmId]),
    pool.query(`
      select
        id,
        farm_id as "farmId",
        name,
        notes
      from cover_crop_names
      where farm_id = $1
      order by name
    `, [auth.farmId]),
    pool.query(`
      select
        id,
        farm_id as "farmId",
        crop_id as "cropId",
        variety_id as "varietyId",
        family,
        crop_type as "cropType",
        variety_name as "varietyName",
        breed_name as "breedName",
        supplier,
        catalog_number as "catalogNumber",
        lot_number as "lotNumber",
        coalesce(
          (select sum(lot.stock_quantity)::integer from seed_item_lots lot where lot.seed_item_id = seed_items.id),
          stock_quantity
        ) as "stockQuantity",
        (
          select coalesce(json_agg(json_build_object(
            'id', lot.id,
            'seedItemId', lot.seed_item_id,
            'lotNumber', lot.lot_number,
            'stockQuantity', lot.stock_quantity
          ) order by lot.lot_number), '[]'::json)
          from seed_item_lots lot
          where lot.seed_item_id = seed_items.id
        ) as lots,
        days_to_maturity as "daysToMaturity",
        usual_spacing as "usualSpacing",
        usual_field_spacing_in_row as "usualFieldSpacingInRow",
        usual_row_spacing as "usualRowSpacing",
        usual_rows_per_bed as "usualRowsPerBed",
        notes,
        archived_at as "archivedAt",
        concat_ws(' / ', crop_type, variety_name, breed_name, supplier, nullif(catalog_number, ''), nullif(lot_number, '')) as "displayName"
      from seed_items
      where farm_id = $1
      order by archived_at nulls first, crop_type, variety_name nulls last, breed_name nulls last, supplier nulls last
    `, [auth.farmId]),
    pool.query(`select id, name from crops order by name`),
    pool.query(`
      select id, crop_id as "cropId", name
      from varieties
      order by name
    `),
    pool.query(`
      select
        tft.id,
        tft.farm_id as "farmId",
        tft.crop_id as "cropId",
        c.name as "cropName",
        tft.name,
        tft.notes,
        tft.is_default as "isDefault",
        tft.source_task_flow_template_id as "sourceTaskFlowTemplateId"
      from task_flow_templates tft
      left join crops c on c.id = tft.crop_id
      where tft.farm_id = $1
      order by coalesce(c.name, 'General'), tft.name
    `, [auth.farmId]),
    pool.query(`
      select
        id,
        flow_template_id as "flowTemplateId",
        node_key as "nodeKey",
        task_type as "taskType",
        label,
        anchor,
        offset_days as "offsetDays",
        icon_color as "iconColor",
        icon_secondary_color as "iconSecondaryColor",
        tractor_model as "tractorModel",
        tractor_profile_id as "tractorProfileId",
        x_pos as "x",
        y_pos as "y",
        notes
      from task_flow_nodes
      where flow_template_id in (select id from task_flow_templates where farm_id = $1)
      order by flow_template_id, y_pos, x_pos, id
    `, [auth.farmId]),
    pool.query(`
      select
        e.id,
        e.flow_template_id as "flowTemplateId",
        from_node.node_key as "fromNodeKey",
        to_node.node_key as "toNodeKey",
        e.delay_days::float8 as "delayDays"
      from task_flow_edges e
      join task_flow_nodes from_node on from_node.id = e.from_node_id
      join task_flow_nodes to_node on to_node.id = e.to_node_id
      where e.flow_template_id in (select id from task_flow_templates where farm_id = $1)
      order by e.flow_template_id, e.id
    `, [auth.farmId]),
    pool.query(`
      select
        id,
        farm_id as "farmId",
        name,
        tractor_model as "tractorModel",
        icon_color as "iconColor",
        icon_secondary_color as "iconSecondaryColor"
      from tractor_profiles
      where farm_id = $1
      order by name, id
    `, [auth.farmId]),
    pool.query(`
      select
        p.id,
        p.farm_id as "farmId",
        p.crop_id as "cropId",
        p.variety_id as "varietyId",
        p.seed_item_id as "seedItemId",
        c.name as "cropName",
        v.name as "varietyName",
        concat_ws(' / ', seed.crop_type, seed.variety_name, seed.breed_name, seed.supplier, nullif(seed.lot_number, '')) as "seedName",
        p.title,
        p.status,
        p.intended_field_id as "intendedFieldId",
        pf.name as "intendedFieldName",
        p.intended_block_id as "intendedBlockId",
        pb.name as "intendedBlockName",
        p.intended_bed_id as "intendedBedId",
        ib.name as "intendedBedName",
        p.task_flow_template_id as "taskFlowTemplateId",
        tft.name as "taskFlowTemplateName",
        p.spacing,
        p.plant_count as "plantCount",
        p.bed_length_used_m as "bedLengthUsedM",
        p.tray_location as "trayLocation",
        p.tray_count as "trayCount",
        p.cells_per_tray as "cellsPerTray",
        p.days_to_harvest as "daysToHarvest",
        p.field_spacing_in_row as "fieldSpacingInRow",
        p.row_spacing as "rowSpacing",
        p.rows_per_bed as "rowsPerBed",
        p.dead_at_frost as "deadAtFrost",
        p.bed_cover as "bedCover",
        p.notes,
        p.planned_sow_date as "plannedSowDate",
        p.planned_transplant_date as "plannedTransplantDate",
        p.expected_harvest_start as "expectedHarvestStart",
        p.expected_harvest_end as "expectedHarvestEnd",
        p.actual_tray_seeding_date as "actualTraySeedingDate",
        p.actual_direct_seeding_date as "actualDirectSeedingDate",
        p.actual_transplant_date as "actualTransplantDate",
        p.actual_cultivation_date as "actualCultivationDate",
        p.actual_harvest_date as "actualHarvestDate",
        p.actual_finish_date as "actualFinishDate"
      from plantings p
      join crops c on c.id = p.crop_id
      left join varieties v on v.id = p.variety_id
      left join seed_items seed on seed.id = p.seed_item_id
      left join fields pf on pf.id = p.intended_field_id
      left join blocks pb on pb.id = p.intended_block_id
      left join beds ib on ib.id = p.intended_bed_id
      left join task_flow_templates tft on tft.id = p.task_flow_template_id
      where p.farm_id = $1
      order by coalesce(p.planned_transplant_date, p.planned_sow_date), p.id
    `, [auth.farmId]),
    pool.query(`
      select
        pp.id,
        pp.planting_id as "plantingId",
        pp.bed_id as "bedId",
        b.name as "bedName",
        pp.plant_count as "plantCount",
        pp.bed_length_used_m as "bedLengthUsedM",
        pp.start_length_m as "startLengthM",
        pp.placement_order as "placementOrder",
        pp.plan_source as "planSource",
        pp.placed_on as "placedOn",
        pp.location_detail as "locationDetail",
        pp.notes,
        case when pp.boundary is not null then ST_AsGeoJSON(pp.boundary)::json else null end as boundary
      from planting_placements pp
      join beds b on b.id = pp.bed_id
      join plantings p on p.id = pp.planting_id
      where p.farm_id = $1
      order by pp.id
    `, [auth.farmId]),
    pool.query(`
      select
        gap.id,
        gap.farm_id as "farmId",
        gap.block_id as "blockId",
        block.name as "blockName",
        gap.bed_id as "bedId",
        bed.name as "bedName",
        gap.start_length_m as "startLengthM",
        gap.bed_length_used_m as "bedLengthUsedM",
        gap.placement_order as "placementOrder",
        gap.notes
      from block_placement_gaps gap
      join blocks block on block.id = gap.block_id
      join beds bed on bed.id = gap.bed_id
      where gap.farm_id = $1
      order by gap.block_id, gap.placement_order, gap.id
    `, [auth.farmId]),
    pool.query(`
      select
        overflow.id,
        overflow.farm_id as "farmId",
        overflow.block_id as "blockId",
        block.name as "blockName",
        overflow.planting_id as "plantingId",
        planting.title as "plantingTitle",
        overflow.entry_type as "entryType",
        overflow.bed_length_used_m as "bedLengthUsedM",
        overflow.plant_count as "plantCount",
        overflow.tray_count as "trayCount",
        overflow.placement_order as "placementOrder",
        overflow.notes
      from block_placement_overflows overflow
      join blocks block on block.id = overflow.block_id
      left join plantings planting on planting.id = overflow.planting_id
      where overflow.farm_id = $1
      order by overflow.block_id, overflow.placement_order, overflow.id
    `, [auth.farmId]),
    pool.query(`
      select
        event.id,
        event.farm_id as "farmId",
        event.event_date as "eventDate",
        event.event_type as "eventType",
        event.title,
        event.notes,
        event.metadata,
        event.field_id as "fieldId",
        event.block_id as "blockId",
        event.zone_id as "zoneId",
        event.bed_id as "bedId",
        bed.name as "bedName",
        event.planting_id as "plantingId",
        planting.title as "plantingTitle",
        event.placement_id as "placementId",
        event.task_id as "taskId",
        case when event.boundary is not null then ST_AsGeoJSON(event.boundary)::json else null end as boundary
      from farm_events event
      left join beds bed on bed.id = event.bed_id
      left join plantings planting on planting.id = event.planting_id
      where event.farm_id = $1
      order by event.event_date desc, event.id desc
    `, [auth.farmId]),
    pool.query(`
      select
        t.id,
        t.farm_id as "farmId",
        t.planting_id as "plantingId",
        t.bed_id as "bedId",
        t.task_flow_node_id as "taskFlowNodeId",
        t.task_type as "taskType",
        t.title,
        t.status,
        t.anchor,
        t.offset_days as "offsetDays",
        coalesce(t.icon_color, node.icon_color, '#4f84aa') as "iconColor",
        coalesce(t.icon_secondary_color, node.icon_secondary_color, '#f4c430') as "iconSecondaryColor",
        coalesce(t.tractor_model, node.tractor_model) as "tractorModel",
        coalesce(t.tractor_profile_id, node.tractor_profile_id) as "tractorProfileId",
        t.depends_on_task_ids as "dependsOnTaskIds",
        t.scheduled_date as "scheduledDate",
        t.completed_date as "completedDate",
        t.notes,
        t.is_auto_generated as "isAutoGenerated",
        p.title as "plantingTitle",
        b.name as "bedName"
      from tasks t
      left join plantings p on p.id = t.planting_id
      left join beds b on b.id = t.bed_id
      left join task_flow_nodes node on node.id = t.task_flow_node_id
      where t.farm_id = $1
      order by t.scheduled_date nulls last, t.id
    `, [auth.farmId]),
    pool.query(`
      select
        h.id,
        h.farm_id as "farmId",
        h.planting_id as "plantingId",
        h.bed_id as "bedId",
        h.harvest_date as "harvestDate",
        h.quantity,
        h.unit,
        h.notes,
        p.title as "plantingTitle",
        b.name as "bedName"
      from harvest_records h
      join plantings p on p.id = h.planting_id
      join beds b on b.id = h.bed_id
      where h.farm_id = $1
      order by h.harvest_date desc, h.id desc
    `, [auth.farmId])
  ]);

  res.json({
    farm: farm.rows[0] ?? null,
    fields: fields.rows,
    blocks: blocks.rows,
    blockZones: blockZones.rows,
    beds: beds.rows,
    bedPresets: bedPresets.rows,
    coverCropNames: coverCropNames.rows,
    seedItems: seedItems.rows,
    crops: crops.rows,
    varieties: varieties.rows,
    taskFlowTemplates: taskFlowTemplates.rows,
    taskFlowNodes: taskFlowNodes.rows,
    taskFlowEdges: taskFlowEdges.rows,
    tractorProfiles: tractorProfiles.rows,
    plantings: plantings.rows,
    placements: placements.rows,
    placementGaps: placementGaps.rows,
    placementOverflows: placementOverflows.rows,
    events: events.rows,
    tasks: tasks.rows,
    harvests: harvests.rows
  });
}));

// Small lookup/create routes used by planning forms.
app.post("/api/bed-presets", requireRole("planner"), asyncHandler(async (req, res) => {
  const body = bedPresetSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const result = await runWithUndoSnapshot(auth, "Create bed preset", async (client) => {
    const insert = await client.query<{ id: number }>(
      `
        insert into bed_presets (farm_id, name, bed_width_m, path_spacing_m, is_road, notes)
        values ($1, $2, $3, $4, $5, $6)
        on conflict (farm_id, name) do update
        set bed_width_m = excluded.bed_width_m,
            path_spacing_m = excluded.path_spacing_m,
            is_road = excluded.is_road,
            notes = excluded.notes,
            updated_at = now()
        returning id
      `,
      [auth.farmId, body.name, body.bedWidthM, body.pathSpacingM, body.isRoad, body.notes ?? null]
    );
    return insert.rows[0];
  });
  res.status(201).json({ id: result.id });
}));

app.delete("/api/bed-presets/:id", requireRole("planner"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const auth = currentAuth(req) as AuthContext;
  await runWithUndoSnapshot(auth, "Delete bed preset", async (client) => {
    await ensureBedPresetInFarm(client, id, auth.farmId);
    await client.query(`update beds set bed_preset_id = null, updated_at = now() where bed_preset_id = $1`, [id]);
    await client.query(`delete from bed_presets where id = $1 and farm_id = $2`, [id, auth.farmId]);
  });
  res.json({ ok: true });
}));

app.get("/api/tractor-profiles", requireRole("worker"), asyncHandler(async (req, res) => {
  const auth = currentAuth(req) as AuthContext;
  const result = await pool.query(
    `
      select
        id,
        farm_id as "farmId",
        name,
        tractor_model as "tractorModel",
        icon_color as "iconColor",
        icon_secondary_color as "iconSecondaryColor"
      from tractor_profiles
      where farm_id = $1
      order by name, id
    `,
    [auth.farmId]
  );
  res.json(result.rows);
}));

app.post("/api/tractor-profiles", requireRole("planner"), asyncHandler(async (req, res) => {
  const body = tractorProfileSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const result = await runWithUndoSnapshot(auth, "Create vehicle", async (client) => {
    const insert = await client.query<{
      id: number;
      farmId: number;
      name: string;
      tractorModel: string;
      iconColor: string;
      iconSecondaryColor: string;
    }>(
      `
        insert into tractor_profiles (farm_id, name, tractor_model, icon_color, icon_secondary_color)
        values ($1, $2, $3, $4, $5)
        returning
          id,
          farm_id as "farmId",
          name,
          tractor_model as "tractorModel",
          icon_color as "iconColor",
          icon_secondary_color as "iconSecondaryColor"
      `,
      [auth.farmId, body.name.trim(), body.tractorModel, body.iconColor, body.iconSecondaryColor]
    );
    return insert.rows[0];
  });
  res.status(201).json(result);
}));

app.put("/api/tractor-profiles/:id", requireRole("planner"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const body = tractorProfileSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const result = await runWithUndoSnapshot(auth, "Update vehicle", async (client) => {
    await ensureTractorProfileInFarm(client, id, auth.farmId);
    const result = await client.query<{
      id: number;
      farmId: number;
      name: string;
      tractorModel: string;
      iconColor: string;
      iconSecondaryColor: string;
    }>(
      `
        update tractor_profiles
        set
          name = $3,
          tractor_model = $4,
          icon_color = $5,
          icon_secondary_color = $6
        where id = $1 and farm_id = $2
        returning
          id,
          farm_id as "farmId",
          name,
          tractor_model as "tractorModel",
          icon_color as "iconColor",
          icon_secondary_color as "iconSecondaryColor"
      `,
      [id, auth.farmId, body.name.trim(), body.tractorModel, body.iconColor, body.iconSecondaryColor]
    );
    await client.query(
      `
        update task_flow_nodes
        set
          tractor_model = $2,
          icon_color = $3,
          icon_secondary_color = $4
        where tractor_profile_id = $1
      `,
      [id, body.tractorModel, body.iconColor, body.iconSecondaryColor]
    );
    await client.query(
      `
        update tasks
        set
          tractor_model = $2,
          icon_color = $3,
          icon_secondary_color = $4,
          updated_at = now()
        where tractor_profile_id = $1
      `,
      [id, body.tractorModel, body.iconColor, body.iconSecondaryColor]
    );
    return result.rows[0];
  });
  res.json(result);
}));

app.delete("/api/tractor-profiles/:id", requireRole("planner"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const auth = currentAuth(req) as AuthContext;
  await runWithUndoSnapshot(auth, "Delete vehicle", async (client) => {
    await ensureTractorProfileInFarm(client, id, auth.farmId);
    await client.query(`update task_flow_nodes set tractor_profile_id = null where tractor_profile_id = $1`, [id]);
    await client.query(`update tasks set tractor_profile_id = null where tractor_profile_id = $1`, [id]);
    await client.query(`delete from tractor_profiles where id = $1 and farm_id = $2`, [id, auth.farmId]);
  });
  res.json({ ok: true });
}));

app.post("/api/cover-crops", requireRole("planner"), asyncHandler(async (req, res) => {
  const body = coverCropNameSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  if (body.farmId !== auth.farmId) {
    res.status(403).json({ error: "Planner access required" });
    return;
  }

  const result = await runWithUndoSnapshot(auth, "Create cover crop name", async (client) => {
    const insert = await client.query<{ id: number; name: string; notes: string | null }>(
      `
        insert into cover_crop_names (farm_id, name, notes)
        values ($1, $2, $3)
        on conflict (farm_id, name)
        do update set notes = coalesce(excluded.notes, cover_crop_names.notes), updated_at = now()
        returning id, name, notes
      `,
      [body.farmId, body.name.trim(), body.notes ?? null]
    );
    return insert.rows[0];
  });
  res.status(201).json({
    id: result.id,
    farmId: body.farmId,
    name: result.name,
    notes: result.notes
  });
}));

app.post("/api/seed-items", requireRole("planner"), asyncHandler(async (req, res) => {
  const body = seedItemSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  if (body.farmId !== auth.farmId) {
    res.status(403).json({ error: "Planner access required" });
    return;
  }

  const result = await runWithUndoSnapshot(auth, "Create seed genetics item", async (client) => {
    const cropResult = await client.query<{ id: number }>(
      `
        insert into crops (name)
        values ($1)
        on conflict (name) do update set name = excluded.name
        returning id
      `,
      [body.cropType.trim()]
    );
    const cropId = cropResult.rows[0].id;

    let varietyId: number | null = null;
    const varietyName = body.varietyName?.trim();
    if (varietyName) {
      const varietyResult = await client.query<{ id: number }>(
        `
          insert into varieties (crop_id, name)
          values ($1, $2)
          on conflict (crop_id, name) do update set name = excluded.name
          returning id
        `,
        [cropId, varietyName]
      );
      varietyId = varietyResult.rows[0].id;
    }
    const lots = normalizedSeedLots(body.lots, body.lotNumber ?? null, body.stockQuantity ?? null);
    const totalStock = lots.some((lot) => lot.stockQuantity != null)
      ? lots.reduce((sum, lot) => sum + (lot.stockQuantity ?? 0), 0)
      : null;

    const seedResult = await client.query<{ id: number }>(
      `
        insert into seed_items (
          farm_id, crop_id, variety_id, family, crop_type, variety_name, breed_name, supplier, catalog_number, lot_number, stock_quantity, days_to_maturity, notes
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        returning id
      `,
      [
        auth.farmId,
        cropId,
        varietyId,
        body.family?.trim() || null,
        body.cropType.trim(),
        varietyName || null,
        body.breedName?.trim() || null,
        body.supplier?.trim() || null,
        body.catalogNumber?.trim() || null,
        lots[0]?.lotNumber ?? null,
        totalStock,
        body.daysToMaturity ?? null,
        body.notes ?? null
      ]
    );
    await replaceSeedItemLots(client, seedResult.rows[0].id, auth.farmId, lots);

    return { id: seedResult.rows[0].id, cropId, varietyId };
  });

  res.status(201).json(result);
}));

app.put("/api/seed-items/:id", requireRole("planner"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const body = seedItemSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  if (body.farmId !== auth.farmId) {
    res.status(403).json({ error: "Planner access required" });
    return;
  }

  await runWithUndoSnapshot(auth, "Update seed item", async (client) => {
    await ensureSeedItemInFarm(client, id, auth.farmId);
    const cropResult = await client.query<{ id: number }>(
      `
        insert into crops (name)
        values ($1)
        on conflict (name) do update set name = excluded.name
        returning id
      `,
      [body.cropType.trim()]
    );
    const cropId = cropResult.rows[0].id;

    let varietyId: number | null = null;
    const varietyName = body.varietyName?.trim();
    if (varietyName) {
      const varietyResult = await client.query<{ id: number }>(
        `
          insert into varieties (crop_id, name)
          values ($1, $2)
          on conflict (crop_id, name) do update set name = excluded.name
          returning id
        `,
        [cropId, varietyName]
      );
      varietyId = varietyResult.rows[0].id;
    }
    const lots = normalizedSeedLots(body.lots, body.lotNumber ?? null, body.stockQuantity ?? null);
    const totalStock = lots.some((lot) => lot.stockQuantity != null)
      ? lots.reduce((sum, lot) => sum + (lot.stockQuantity ?? 0), 0)
      : null;

    await client.query(
      `
        update seed_items
        set
          crop_id = $2,
          variety_id = $3,
          family = $4,
          crop_type = $5,
          variety_name = $6,
          breed_name = $7,
          supplier = $8,
          catalog_number = $9,
          lot_number = $10,
          stock_quantity = $11,
          days_to_maturity = $12,
          notes = $13,
          updated_at = now()
        where id = $1 and farm_id = $14
      `,
      [
        id,
        cropId,
        varietyId,
        body.family?.trim() || null,
        body.cropType.trim(),
        varietyName || null,
        body.breedName?.trim() || null,
        body.supplier?.trim() || null,
        body.catalogNumber?.trim() || null,
        lots[0]?.lotNumber ?? null,
        totalStock,
        body.daysToMaturity ?? null,
        body.notes ?? null,
        auth.farmId
      ]
    );
    await replaceSeedItemLots(client, id, auth.farmId, lots);
  });

  res.json({ ok: true });
}));

app.delete("/api/seed-items/:id", requireRole("planner"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const auth = currentAuth(req) as AuthContext;
  await runWithUndoSnapshot(auth, "Archive seed item", async (client) => {
    await ensureSeedItemInFarm(client, id, auth.farmId);
    await client.query(
      `update seed_items set archived_at = coalesce(archived_at, now()), updated_at = now() where id = $1 and farm_id = $2`,
      [id, auth.farmId]
    );
  });
  res.json({ ok: true });
}));

app.post("/api/seed-items/:id/restore", requireRole("planner"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const auth = currentAuth(req) as AuthContext;
  await runWithUndoSnapshot(auth, "Restore seed item", async (client) => {
    await ensureSeedItemInFarm(client, id, auth.farmId);
    await client.query(
      `update seed_items set archived_at = null, updated_at = now() where id = $1 and farm_id = $2`,
      [id, auth.farmId]
    );
  });
  res.json({ ok: true });
}));

registerSpreadsheetImportRoutes(app, {
  asyncHandler,
  currentAuth,
  requireRole,
  createUndoSnapshot,
  pruneUndoSnapshots
});

// Block zones represent planned/current sub-areas inside a block.
app.post("/api/block-zones", requireRole("planner"), asyncHandler(async (req, res) => {
  const body = blockZoneSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const result = await runWithUndoSnapshot(auth, "Create block area", async (client) => {
    await ensureBlockInFarm(client, body.blockId, auth.farmId);
    return upsertBlockZoneGeometry(client, {
      blockId: body.blockId,
      farmId: auth.farmId,
      name: body.name,
      plannedUse: body.plannedUse,
      actualState: body.actualState,
      coverCropNameId: body.coverCropNameId ?? null,
      coverCropName: body.coverCropName ?? null,
      plannedCoverCropSeedDate: body.plannedCoverCropSeedDate ?? null,
      plannedCoverCropTerminateDate: body.plannedCoverCropTerminateDate ?? null,
      notes: body.notes ?? null,
      coordinates: body.coordinates
    });
  });
  res.status(201).json(result);
}));

app.post("/api/blocks/:id/split-zone", requireRole("planner"), asyncHandler(async (req, res) => {
  const blockId = Number(req.params.id);
  const body = blockZoneSplitSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await ensureBlockInFarm(client, blockId, auth.farmId);
    const existingZoneCountResult = await client.query<{ count: string }>(
      `select count(*)::text as count from block_zones where block_id = $1`,
      [blockId]
    );
    const existingZoneCount = Number(existingZoneCountResult.rows[0]?.count ?? "0");
    const { targetCoordinates, remainderCoordinates } = await splitBlockBoundaryIntoZoneCoordinates(client, {
      blockId,
      lineCoordinates: body.lineCoordinates,
      splitLines: body.splitLines,
      firstBedSidePoint: body.firstBedSidePoint,
      useLargerSide: body.useLargerSide
    });

    await client.query("begin");
    await createUndoSnapshot(client, auth, "Split block area");
    const primaryZone = await upsertBlockZoneGeometry(client, {
      blockId,
      farmId: auth.farmId,
      name: body.name,
      plannedUse: body.plannedUse,
      actualState: body.actualState,
      coverCropNameId: body.coverCropNameId ?? null,
      coverCropName: body.coverCropName ?? null,
      plannedCoverCropSeedDate: body.plannedCoverCropSeedDate ?? null,
      plannedCoverCropTerminateDate: body.plannedCoverCropTerminateDate ?? null,
      notes: body.notes ?? null,
      coordinates: targetCoordinates
    });
    for (const [index, coordinates] of remainderCoordinates.entries()) {
      await upsertBlockZoneGeometry(client, {
        blockId,
        farmId: auth.farmId,
        name: `Area ${existingZoneCount + 2 + index}`,
        plannedUse: null,
        actualState: body.actualState,
        plannedCoverCropSeedDate: null,
        plannedCoverCropTerminateDate: null,
        notes: null,
        coordinates
      });
    }
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.status(201).json(primaryZone);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

app.put("/api/block-zones/:id", requireRole("planner"), asyncHandler(async (req, res) => {
  const zoneId = Number(req.params.id);
  const body = blockZoneUpdateSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const result = await runWithUndoSnapshot(auth, "Update block area", async (client) => {
    await ensureBlockZoneInFarm(client, zoneId, auth.farmId);
    const zoneResult = await client.query<{ block_id: number }>(
      `select block_id from block_zones where id = $1`,
      [zoneId]
    );
    const zone = zoneResult.rows[0];
    if (!zone) {
      throw new Error("Block zone not found");
    }
    return upsertBlockZoneGeometry(client, {
      id: zoneId,
      blockId: zone.block_id,
      farmId: auth.farmId,
      name: body.name,
      plannedUse: body.plannedUse,
      actualState: body.actualState,
      coverCropNameId: body.coverCropNameId ?? null,
      coverCropName: body.coverCropName ?? null,
      plannedCoverCropSeedDate: body.plannedCoverCropSeedDate ?? null,
      plannedCoverCropTerminateDate: body.plannedCoverCropTerminateDate ?? null,
      actualCoverCropSeedDate: body.actualCoverCropSeedDate ?? null,
      actualCoverCropTerminateDate: body.actualCoverCropTerminateDate ?? null,
      notes: body.notes ?? null,
      coordinates: body.coordinates
    });
  });
  res.json(result);
}));

app.put("/api/block-zones/:id/cover-crop-work", requireRole(), asyncHandler(async (req, res) => {
  const zoneId = Number(req.params.id);
  const body = coverCropWorkSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;

  if (body.actualCoverCropSeedDate && body.actualCoverCropSeedDate > todayIsoDate()) {
    throw new Error("Actual cover crop seeded date cannot be in the future");
  }
  if (body.actualCoverCropTerminateDate && body.actualCoverCropTerminateDate > todayIsoDate()) {
    throw new Error("Actual cover crop terminated date cannot be in the future");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await ensureBlockZoneInFarm(client, zoneId, auth.farmId);
    await createUndoSnapshot(client, auth, "Record cover crop work");

    const zoneResult = await client.query<{
      block_id: number;
      block_name: string;
      field_id: number;
      field_name: string;
      name: string;
      planned_use: string | null;
      actual_state: z.infer<typeof zoneActualStateSchema>;
      notes: string | null;
      boundary_wkt: string | null;
    }>(
      `
        select
          zone.block_id,
          block.name as block_name,
          field.id as field_id,
          field.name as field_name,
          zone.name,
          zone.planned_use,
          zone.actual_state,
          zone.notes,
          ST_AsText(zone.boundary) as boundary_wkt
        from block_zones zone
        join blocks block on block.id = zone.block_id
        join fields field on field.id = block.field_id
        where zone.id = $1
      `,
      [zoneId]
    );
    const zone = zoneResult.rows[0];
    if (!zone) {
      throw new Error("Cover crop area not found");
    }
    if (zone.planned_use !== "cover_crop") {
      throw new Error("Selected area is not assigned to cover crop.");
    }

    const nextActualState = body.actualState ?? zone.actual_state;
    const nextNotes = body.notes === undefined ? zone.notes : body.notes;
    await client.query(
      `
        update block_zones
        set
          actual_state = $2,
          actual_cover_crop_seed_date = $3::date,
          actual_cover_crop_terminate_date = $4::date,
          notes = $5,
          updated_at = now()
        where id = $1
      `,
      [
        zoneId,
        nextActualState,
        body.actualCoverCropSeedDate ?? null,
        body.actualCoverCropTerminateDate ?? null,
        nextNotes ?? null
      ]
    );

    await client.query(
      `delete from farm_events where farm_id = $1 and zone_id = $2 and event_type in ('cover_crop_seeded', 'cover_crop_terminated')`,
      [auth.farmId, zoneId]
    );

    const coordinates = zone.boundary_wkt ? null : null;
    if (body.actualCoverCropSeedDate) {
      await recordFarmEvent(client, {
        farmId: auth.farmId,
        eventDate: body.actualCoverCropSeedDate,
        eventType: "cover_crop_seeded",
        title: `Cover crop seeded: ${zone.name}`,
        notes: nextNotes ?? null,
        metadata: { timelineVisible: true, stateCategory: "cover_crop", source: "cover_crop_work" },
        fieldId: zone.field_id,
        blockId: zone.block_id,
        zoneId,
        coordinates
      });
    }
    if (body.actualCoverCropTerminateDate) {
      await recordFarmEvent(client, {
        farmId: auth.farmId,
        eventDate: body.actualCoverCropTerminateDate,
        eventType: "cover_crop_terminated",
        title: `Cover crop terminated: ${zone.name}`,
        notes: nextNotes ?? null,
        metadata: { timelineVisible: true, stateCategory: "cleanup", source: "cover_crop_work" },
        fieldId: zone.field_id,
        blockId: zone.block_id,
        zoneId,
        coordinates
      });
    }

    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.json({ ok: true });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/work-events/unplanned", requireRole("worker"), asyncHandler(async (req, res) => {
  const body = unplannedWorkSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;

  if (body.eventDate > todayIsoDate()) {
    throw new Error("Work date cannot be in the future");
  }

  const result = await runWithUndoSnapshot(auth, "Record unplanned work", async (client) => {
    let fieldId = body.fieldId ?? null;
    let blockId = body.blockId ?? null;
    let zoneId = body.zoneId ?? null;
    let bedId = body.bedId ?? null;
    let locationName = "selected area";
    let coordinates: LatLngInput[] | null = null;

    if (bedId != null) {
      await ensureBedInFarm(client, bedId, auth.farmId);
      const bedResult = await client.query<{
        id: number;
        name: string;
        block_id: number;
        block_name: string;
        field_id: number;
        boundary: GeoJsonPolygonInput;
      }>(
        `
          select
            bed.id,
            bed.name,
            bed.block_id,
            block.name as block_name,
            field.id as field_id,
            ST_AsGeoJSON(coalesce(bed.boundary, ST_Transform(bed.geom, 4326)))::json as boundary
          from beds bed
          join blocks block on block.id = bed.block_id
          join fields field on field.id = block.field_id
          where bed.id = $1
        `,
        [bedId]
      );
      const bed = bedResult.rows[0];
      if (!bed) {
        throw new Error("Bed not found");
      }
      blockId = bed.block_id;
      fieldId = bed.field_id;
      locationName = `${bed.name} in ${bed.block_name}`;
      coordinates = geoJsonPolygonToLatLngs(bed.boundary);
    } else if (zoneId != null) {
      await ensureBlockZoneInFarm(client, zoneId, auth.farmId);
      const zoneResult = await client.query<{
        id: number;
        name: string;
        block_id: number;
        block_name: string;
        field_id: number;
        boundary: GeoJsonPolygonInput;
      }>(
        `
          select
            zone.id,
            zone.name,
            zone.block_id,
            block.name as block_name,
            field.id as field_id,
            ST_AsGeoJSON(zone.boundary)::json as boundary
          from block_zones zone
          join blocks block on block.id = zone.block_id
          join fields field on field.id = block.field_id
          where zone.id = $1
        `,
        [zoneId]
      );
      const zone = zoneResult.rows[0];
      if (!zone) {
        throw new Error("Block area not found");
      }
      blockId = zone.block_id;
      fieldId = zone.field_id;
      locationName = `${zone.name} in ${zone.block_name}`;
      coordinates = geoJsonPolygonToLatLngs(zone.boundary);
    } else if (blockId != null) {
      await ensureBlockInFarm(client, blockId, auth.farmId);
      const blockResult = await client.query<{
        id: number;
        name: string;
        field_id: number;
        boundary: GeoJsonPolygonInput;
      }>(
        `
          select
            block.id,
            block.name,
            field.id as field_id,
            ST_AsGeoJSON(block.boundary)::json as boundary
          from blocks block
          join fields field on field.id = block.field_id
          where block.id = $1
        `,
        [blockId]
      );
      const block = blockResult.rows[0];
      if (!block) {
        throw new Error("Block not found");
      }
      fieldId = block.field_id;
      locationName = block.name;
      coordinates = geoJsonPolygonToLatLngs(block.boundary);
    } else if (fieldId != null) {
      await ensureFieldInFarm(client, fieldId, auth.farmId);
      const fieldResult = await client.query<{
        id: number;
        name: string;
        boundary: GeoJsonPolygonInput;
      }>(
        `
          select
            id,
            name,
            ST_AsGeoJSON(boundary)::json as boundary
          from fields
          where id = $1
        `,
        [fieldId]
      );
      const field = fieldResult.rows[0];
      if (!field) {
        throw new Error("Field not found");
      }
      locationName = field.name;
      coordinates = geoJsonPolygonToLatLngs(field.boundary);
    }

    const applicationBedIds = [...new Set(body.applicationBedIds ?? [])];
    const transplantBedIds = [...new Set(body.transplantBedIds ?? [])];
    const cultivationBedIds = [...new Set(body.cultivationBedIds ?? [])];
    const workBedIds = [...new Set([...applicationBedIds, ...transplantBedIds, ...cultivationBedIds])];
    if (workBedIds.length > 0) {
      const bedsResult = await client.query<{
        id: number;
        block_id: number;
        field_id: number;
      }>(
        `
          select bed.id, bed.block_id, field.id as field_id
          from beds bed
          join blocks block on block.id = bed.block_id
          join fields field on field.id = block.field_id
          where bed.id = any($1::int[]) and field.farm_id = $2 and bed.source <> 'road'
        `,
        [workBedIds, auth.farmId]
      );
      if (bedsResult.rows.length !== workBedIds.length) {
        throw new Error("One or more selected work beds are not valid for this farm.");
      }
      const firstBed = bedsResult.rows[0];
      if (firstBed) {
        blockId = blockId ?? firstBed.block_id;
        fieldId = fieldId ?? firstBed.field_id;
      }
    }
    if (body.plantingId != null) {
      await ensurePlantingInFarm(client, body.plantingId, auth.farmId);
    }
    if (body.transplantPlantingId != null) {
      await ensurePlantingInFarm(client, body.transplantPlantingId, auth.farmId);
    }

    const workType = body.workType.trim();
    const title = body.title?.trim() || `${workType} at ${locationName}`;
    const metadata = {
      timelineVisible: true,
      source: "unplanned_work",
      workType,
      taskType: body.taskType?.trim() || null,
      workSubcategory: body.workSubcategory?.trim() || null,
      bedMakingBedCount: body.bedMakingBedCount ?? null,
      bedMakingBlockFull: body.bedMakingBlockFull ?? null,
      bedMakingBedCover: body.bedMakingBedCover ?? null,
      plantingId: body.plantingId ?? null,
      applicationRateUsed: body.applicationRateUsed ?? null,
      applicationAmountUsed: body.applicationAmountUsed ?? null,
      applicationProduct: body.applicationProduct?.trim() || null,
      applicationUnit: body.applicationUnit?.trim() || null,
      applicationAreaSqM: body.applicationAreaSqM ?? null,
      transplantPlantingId: body.transplantPlantingId ?? null,
      transplantCrop: body.transplantCrop?.trim() || null,
      transplantVariety: body.transplantVariety?.trim() || null,
      transplantPlantCount: body.transplantPlantCount ?? null,
      transplantTrayCount: body.transplantTrayCount ?? null,
      transplantInRowSpacing: body.transplantInRowSpacing ?? null,
      transplantRowsPerBed: body.transplantRowsPerBed ?? null,
      applicationBedIds,
      transplantBedIds,
      cultivationBedIds
    };
    await recordFarmEvent(client, {
      farmId: auth.farmId,
      eventDate: body.eventDate,
      eventType: "unplanned_work",
      title,
      notes: body.notes?.trim() || null,
      metadata,
      fieldId,
      blockId,
      zoneId,
      bedId,
      plantingId: body.plantingId ?? body.transplantPlantingId ?? null,
      coordinates
    });

    return { ok: true };
  });

  res.status(201).json(result);
}));

app.delete("/api/block-zones/:id", requireRole("planner"), asyncHandler(async (req, res) => {
  const zoneId = Number(req.params.id);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await ensureBlockZoneInFarm(client, zoneId, auth.farmId);
    await createUndoSnapshot(client, auth, "Delete block area");
    await client.query(
      `
        update plantings
        set intended_bed_id = null, updated_at = now()
        where intended_bed_id in (select id from beds where zone_id = $1)
      `,
      [zoneId]
    );
    await client.query(`delete from block_zones where id = $1`, [zoneId]);
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.json({ ok: true });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

// Visual task-flow editor routes.
app.post("/api/task-flows", requireRole("planner"), asyncHandler(async (req, res) => {
  const body = taskFlowSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await createUndoSnapshot(client, auth, "Create task flow");
    const id = await saveTaskFlowTemplate(client, {
      farmId: auth.farmId,
      cropId: body.cropId ?? null,
      name: body.name,
      notes: body.notes ?? null,
      isDefault: body.isDefault,
      nodes: body.nodes,
      edges: body.edges
    });
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.status(201).json({ id });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.put("/api/task-flows/:id", requireRole("planner"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const body = taskFlowUpdateSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ id: number }>(`select id from task_flow_templates where id = $1 and farm_id = $2`, [id, auth.farmId]);
    if (!existing.rows[0]) {
      await client.query("rollback");
      res.status(404).json({ error: "Task flow template not found" });
      return;
    }
    await createUndoSnapshot(client, auth, "Update task flow");
    await saveTaskFlowTemplate(client, {
      id,
      cropId: body.cropId ?? null,
      name: body.name,
      notes: body.notes ?? null,
      isDefault: body.isDefault,
      nodes: body.nodes,
      edges: body.edges
    });
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.json({ ok: true });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/task-flows/:id/copy", requireRole("planner"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const templateResult = await client.query<{
      farm_id: number;
      crop_id: number | null;
      name: string;
      notes: string | null;
    }>(
      `select farm_id, crop_id, name, notes from task_flow_templates where id = $1 and farm_id = $2`,
      [id, auth.farmId]
    );
    const template = templateResult.rows[0];
    if (!template) {
      await client.query("rollback");
      res.status(404).json({ error: "Task flow template not found" });
      return;
    }
    await createUndoSnapshot(client, auth, "Copy task flow");

    const nodesResult = await client.query<{
      node_key: string;
      task_type: TaskType;
      label: string;
      anchor: string;
      offset_days: number;
      icon_color: string;
      icon_secondary_color: string;
      tractor_model: string | null;
      tractor_profile_id: number | null;
      x_pos: number;
      y_pos: number;
      notes: string | null;
    }>(
      `
        select node_key, task_type, label, anchor, offset_days, icon_color, icon_secondary_color, tractor_model, tractor_profile_id, x_pos, y_pos, notes
        from task_flow_nodes
        where flow_template_id = $1
        order by y_pos, x_pos, id
      `,
      [id]
    );
    const edgesResult = await client.query<{
      from_node_key: string;
      to_node_key: string;
      delay_days: number;
    }>(
      `
        select from_node.node_key as from_node_key, to_node.node_key as to_node_key, e.delay_days::float8 as delay_days
        from task_flow_edges e
        join task_flow_nodes from_node on from_node.id = e.from_node_id
        join task_flow_nodes to_node on to_node.id = e.to_node_id
        where e.flow_template_id = $1
        order by e.id
      `,
      [id]
    );

    const copyId = await saveTaskFlowTemplate(client, {
      farmId: template.farm_id,
      cropId: template.crop_id,
      name: `${template.name} Copy`,
      notes: template.notes,
      isDefault: false,
      nodes: nodesResult.rows.map((node: {
        node_key: string;
        task_type: TaskType;
        label: string;
        anchor: string;
        offset_days: number;
        icon_color: string;
        icon_secondary_color: string;
        tractor_model: string | null;
        tractor_profile_id: number | null;
        x_pos: number;
        y_pos: number;
        notes: string | null;
      }) => ({
        nodeKey: node.node_key,
        taskType: node.task_type,
        label: node.label,
        anchor: node.anchor,
        offsetDays: node.offset_days,
        iconColor: node.icon_color,
        iconSecondaryColor: node.icon_secondary_color,
        tractorModel: node.tractor_model,
        tractorProfileId: node.tractor_profile_id,
        x: Number(node.x_pos),
        y: Number(node.y_pos),
        notes: node.notes
      })),
      edges: edgesResult.rows.map((edge: { from_node_key: string; to_node_key: string; delay_days: number }) => ({
        fromNodeKey: edge.from_node_key,
        toNodeKey: edge.to_node_key,
        delayDays: Number(edge.delay_days)
      }))
    });

    await client.query(
      `update task_flow_templates set source_task_flow_template_id = $2 where id = $1`,
      [copyId, id]
    );
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.status(201).json({ id: copyId });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.delete("/api/task-flows/:id", requireRole("planner"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const templateResult = await client.query<{ crop_id: number | null; is_default: boolean }>(
      `select crop_id, is_default from task_flow_templates where id = $1 and farm_id = $2`,
      [id, auth.farmId]
    );
    const template = templateResult.rows[0];
    if (!template) {
      await client.query("rollback");
      res.status(404).json({ error: "Task flow template not found" });
      return;
    }
    await createUndoSnapshot(client, auth, "Delete task flow");
    const plantings = await client.query<{ id: number }>(
      template?.is_default
        ? `
            select id
            from plantings
            where farm_id = $2
              and crop_id = coalesce($3, crop_id)
              and (task_flow_template_id = $1 or task_flow_template_id is null)
          `
        : `
            select id
            from plantings
            where farm_id = $2 and task_flow_template_id = $1
          `,
      [id, auth.farmId, template.crop_id]
    );
    await client.query(`delete from task_flow_templates where id = $1 and farm_id = $2`, [id, auth.farmId]);
    for (const planting of plantings.rows) {
      await recalculatePlantingTasks(client, planting.id);
    }
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.json({ ok: true });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

// Map hierarchy routes: fields, blocks, generated beds, and editable bed geometry.
app.post("/api/fields", requireRole("planner"), asyncHandler(async (req, res) => {
  const body = fieldPolygonSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const farmResult = await client.query<{ id: number }>(`select id from farms where id = $1`, [auth.farmId]);
    if (!farmResult.rows[0]) {
      await client.query("rollback");
      res.status(400).json({ error: "Farm not found. Seed the database or create a farm first." });
      return;
    }
    await createUndoSnapshot(client, auth, "Create field");
    const id = await upsertFieldGeometry(client, { ...body, farmId: auth.farmId });
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.status(201).json({ id });
  } catch (error) {
    console.error("Field save failed", { body, error });
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.put("/api/fields/:id", requireRole("planner"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const body = fieldPolygonUpdateSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const farmResult = await client.query<{ farm_id: number }>(`select farm_id from fields where id = $1 and farm_id = $2`, [id, auth.farmId]);
    if (!farmResult.rows[0]) {
      res.status(404).json({ error: "Field not found" });
      await client.query("rollback");
      return;
    }
    await createUndoSnapshot(client, auth, "Update field");
    await upsertFieldGeometry(client, {
      id,
      farmId: farmResult.rows[0].farm_id,
      name: body.name,
      notes: body.notes ?? null,
      coordinates: body.coordinates
    });
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.json({ ok: true });
  } catch (error) {
    console.error("Field update failed", { fieldId: id, body, error });
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.delete("/api/fields/:id", requireRole("planner"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ id: number }>(`select id from fields where id = $1 and farm_id = $2`, [id, auth.farmId]);
    if (!existing.rows[0]) {
      await client.query("rollback");
      res.status(404).json({ error: "Field not found" });
      return;
    }
    await createUndoSnapshot(client, auth, "Delete field");
    await clearIntendedBedsForField(client, id);
    await client.query(`delete from fields where id = $1`, [id]);
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.json({ ok: true });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/blocks", requireRole("planner"), asyncHandler(async (req, res) => {
  const body = blockPolygonSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await ensureFieldInFarm(client, body.fieldId, auth.farmId);
    await createUndoSnapshot(client, auth, "Create block");
    const result = await upsertBlockGeometry(client, body);
    await ensureDefaultBlockArea(client, {
      blockId: result.id,
      farmId: auth.farmId,
      blockName: body.name,
      currentState: body.currentState,
      coordinates: body.coordinates
    });
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.status(201).json(result);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/blocks/:id/generate-beds", requireRole("planner"), asyncHandler(async (req, res) => {
  const blockId = Number(req.params.id);
  const body = bedGenerationSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await ensureBlockInFarm(client, blockId, auth.farmId);
    await ensureBedPresetInFarm(client, body.presetId, auth.farmId);
    if (body.zoneId != null) {
      await ensureBlockZoneInFarm(client, body.zoneId, auth.farmId);
      const zoneResult = await client.query<{ block_id: number; planned_use: string }>(
        `select block_id, planned_use from block_zones where id = $1`,
        [body.zoneId]
      );
      const zone = zoneResult.rows[0];
      if (!zone || zone.block_id !== blockId) {
        throw new Error("Selected bed area does not belong to this block");
      }
      if (zone.planned_use !== "beds") {
        throw new Error("Beds can only be generated inside bed areas");
      }
    }
    await createUndoSnapshot(client, auth, "Generate beds");
    if (body.replaceExisting) {
      await moveBlockBedAssignmentsToOverflowForReplacement(client, auth.farmId, blockId, body.zoneId ?? null);
    }
    const result = await insertGeneratedBeds(client, {
      blockId,
      presetId: body.presetId,
      zoneId: body.zoneId ?? null,
      lineMode: body.lineMode,
      lineCoordinates: body.lineCoordinates,
      count: body.count,
      layoutStartIndex: body.layoutStartIndex,
      edgeOffsetM: body.edgeOffsetM,
      namePrefix: body.namePrefix,
      startNumber: body.startNumber,
      isPermanent: body.isPermanent,
      replaceExisting: body.replaceExisting,
      invertSide: body.invertSide,
      fillWholeBlock: body.fillWholeBlock,
      harvestRoadEveryBeds: body.harvestRoadEveryBeds ?? null,
      harvestRoadWidthBeds: body.harvestRoadWidthBeds
    });
    if (result.inserted > 0 && !result.isRoad) {
      await client.query(
        `update blocks set bed_start_entrance_side = $3, updated_at = now() where id = $1 and field_id in (select id from fields where farm_id = $2)`,
        [blockId, auth.farmId, body.entranceSide]
      );
      await upsertBlockBedMakingTask(client, auth.farmId, blockId);
      await reflowExistingBlockPlacementPlan(client, auth.farmId, blockId);
    }
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.status(201).json(result);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.put("/api/blocks/:id/placement-plan", requireRole("planner"), asyncHandler(async (req, res) => {
  const blockId = Number(req.params.id);
  const body = blockPlacementPlanSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await createUndoSnapshot(client, auth, "Update block placement plan");
    await reflowBlockPlacementPlan(client, auth.farmId, blockId, body.entranceSide, body.rows);
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.json({ ok: true });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.put("/api/blocks/:id", requireRole("planner"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const body = blockPolygonUpdateSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const parent = await client.query<{ field_id: number }>(
      `
        select block.field_id
        from blocks block
        join fields field on field.id = block.field_id
        where block.id = $1 and field.farm_id = $2
      `,
      [id, auth.farmId]
    );
    if (!parent.rows[0]) {
      res.status(404).json({ error: "Block not found" });
      await client.query("rollback");
      return;
    }
    await createUndoSnapshot(client, auth, "Update block");
    const result = await upsertBlockGeometry(client, {
      id,
      fieldId: parent.rows[0].field_id,
      name: body.name,
      notes: body.notes ?? null,
      coordinates: body.coordinates
    });
    await syncSingleBlockZoneToBlockBoundary(client, deps, {
      blockId: id,
      farmId: auth.farmId,
      coordinates: body.coordinates
    });
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.json({ ok: true, warning: result.warning });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.delete("/api/blocks/:id", requireRole("planner"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ id: number }>(
      `
        select block.id
        from blocks block
        join fields field on field.id = block.field_id
        where block.id = $1 and field.farm_id = $2
      `,
      [id, auth.farmId]
    );
    if (!existing.rows[0]) {
      await client.query("rollback");
      res.status(404).json({ error: "Block not found" });
      return;
    }
    await createUndoSnapshot(client, auth, "Delete block");
    await clearIntendedBedsForBlock(client, id);
    await client.query(`delete from blocks where id = $1`, [id]);
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.json({ ok: true });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/beds", requireRole("planner"), asyncHandler(async (req, res) => {
  const body = geometrySchema.extend({
    blockId: z.number(),
    name: z.string().min(1),
    isPermanent: z.boolean(),
    bedLengthM: z.number().positive(),
    notes: z.string().nullable().optional()
  }).parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const result = await runWithUndoSnapshot(auth, "Create bed", async (client) => {
    await ensureBlockInFarm(client, body.blockId, auth.farmId);
    return client.query(
      `
        insert into beds (
          block_id, name, is_permanent, notes, x, y, width, height, bed_length_m,
          geom, geometry_source, geometry_updated_at, geometry_notes
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, ST_GeomFromText($10, 3857), 'manual', now(), 'Manual bed geometry')
        returning id
      `,
      [body.blockId, body.name, body.isPermanent, body.notes ?? null, body.x, body.y, body.width, body.height, body.bedLengthM, rectangleWkt(body.x, body.y, body.width, body.height)]
    );
  });
  res.status(201).json({ id: result.rows[0].id });
}));

app.put("/api/beds/:id", requireRole("planner"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const body = geometrySchema.extend({
    name: z.string().min(1),
    isPermanent: z.boolean(),
    bedLengthM: z.number().positive(),
    notes: z.string().nullable().optional()
  }).parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  await runWithUndoSnapshot(auth, "Update bed", async (client) => {
    await ensureBedInFarm(client, id, auth.farmId);
    await client.query(
      `
        update beds
        set
          name = $2,
          is_permanent = $3,
          notes = $4,
          x = $5,
          y = $6,
          width = $7,
          height = $8,
          bed_length_m = $9,
          geom = ST_GeomFromText($10, 3857),
          geometry_source = 'manual_update',
          geometry_updated_at = now(),
          geometry_notes = 'Manually updated bed geometry',
          updated_at = now()
        where id = $1
      `,
      [id, body.name, body.isPermanent, body.notes ?? null, body.x, body.y, body.width, body.height, body.bedLengthM, rectangleWkt(body.x, body.y, body.width, body.height)]
    );
  });
  res.json({ ok: true });
}));

app.delete("/api/beds/:id", requireRole("planner"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const auth = currentAuth(req) as AuthContext;
  await runWithUndoSnapshot(auth, "Delete bed", async (client) => {
    await ensureBedInFarm(client, id, auth.farmId);
    const usage = await client.query<{
      intended_plantings: string;
      placements: string;
      harvests: string;
    }>(
      `
        select
          (select count(*) from plantings where farm_id = $2 and intended_bed_id = $1) as intended_plantings,
          (
            select count(*)
            from planting_placements placement
            join plantings planting on planting.id = placement.planting_id
            where planting.farm_id = $2 and placement.bed_id = $1
          ) as placements,
          (select count(*) from harvest_records where farm_id = $2 and bed_id = $1) as harvests
      `,
      [id, auth.farmId]
    );
    const row = usage.rows[0];
    const intendedPlantings = Number(row?.intended_plantings ?? 0);
    const placements = Number(row?.placements ?? 0);
    const harvests = Number(row?.harvests ?? 0);
    if (intendedPlantings > 0 || placements > 0 || harvests > 0) {
      throw new Error("This bed has planned plantings, placements, or harvest records. Move or remove those records before deleting the bed.");
    }

    const bed = await client.query<{ block_id: number }>(`select block_id from beds where id = $1`, [id]);
    await client.query(`delete from beds where id = $1`, [id]);
    const blockId = bed.rows[0]?.block_id;
    if (blockId != null) {
      await upsertBlockBedMakingTask(client, auth.farmId, blockId);
    }
  });
  res.json({ ok: true });
}));

// Crop planning, task recording, placements, actual dates, and harvest logging.
app.post("/api/plantings", requireRole("planner"), asyncHandler(async (req, res) => {
  const body = plantingSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await createUndoSnapshot(client, auth, "Create planting");
    const result = await createPlantingFromInput(client, auth, body);
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.status(201).json({ id: result.plantingId });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/workflows/plantings", requireRole("planner"), asyncHandler(async (req, res) => {
  const body = plantingWorkflowSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await createUndoSnapshot(client, auth, "Create planting with placements");
    const result = await createPlantingFromInput(client, auth, body);
    const placementBlockIds = new Set<number>();
    const plantingResult = await client.query<{ title: string }>(`select title from plantings where id = $1`, [result.plantingId]);
    const plantingTitle = plantingResult.rows[0]?.title ?? "Planting";

    for (const placement of body.placements) {
      await ensurePlantableBedInFarm(client, placement.bedId, auth.farmId);
      if (placement.actualDate && placement.actualDate > todayIsoDate()) {
        throw new Error("Planted dates cannot be in the future");
      }
      const placementInsert = await client.query<{ id: number }>(
        `
          insert into planting_placements (
            planting_id, bed_id, plant_count, bed_length_used_m, placed_on, location_detail, notes,
            boundary, centroid, area_sqm
          )
          values (
            $1, $2, $3, $4, $5, $6, $7,
            case when $8::text is null then null else ST_GeomFromText($8, 4326) end,
            case when $8::text is null then null else ST_Centroid(ST_GeomFromText($8, 4326)) end,
            case when $8::text is null then null else ST_Area(ST_GeomFromText($8, 4326)::geography) end
          )
          returning id
        `,
        [
          result.plantingId,
          placement.bedId,
          placement.plantCount ?? null,
          placement.bedLengthUsedM ?? null,
          placement.actualDate ?? null,
          placement.locationDetail ?? null,
          placement.notes ?? null,
          placement.coordinates && placement.coordinates.length >= 3 ? polygonWkt(placement.coordinates) : null
        ]
      );
      const bedContext = await getBedContext(client, placement.bedId);
      placementBlockIds.add(bedContext.block_id);
      await recordFarmEvent(client, {
        farmId: auth.farmId,
        eventDate: placement.actualDate ?? new Date().toISOString().slice(0, 10),
        eventType: "placement_recorded",
        title: `Placement recorded for ${plantingTitle}`,
        notes: placement.notes ?? null,
        metadata: {
          plantCount: placement.plantCount ?? null,
          bedLengthUsedM: placement.bedLengthUsedM ?? null,
          locationDetail: placement.locationDetail ?? null,
          source: "planting_workflow"
        },
        fieldId: bedContext.field_id,
        blockId: bedContext.block_id,
        zoneId: bedContext.zone_id,
        bedId: placement.bedId,
        plantingId: result.plantingId,
        placementId: placementInsert.rows[0].id,
        coordinates: placement.coordinates ?? null
      });
    }

    for (const blockId of placementBlockIds) {
      await upsertBlockBedMakingTask(client, auth.farmId, blockId);
    }
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.status(201).json({ id: result.plantingId, placementsCreated: body.placements.length });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.put("/api/plantings/:id", requireRole("planner"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const body = plantingSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    assertNoFuturePlantingStatusDate(body.status, body.plannedSowDate, body.plannedTransplantDate);
    await ensurePlantingInFarm(client, id, auth.farmId);
    const existingPlanting = await client.query<{ intended_block_id: number | null }>(
      `select intended_block_id from plantings where id = $1 and farm_id = $2`,
      [id, auth.farmId]
    );
    const previousBlockId = existingPlanting.rows[0]?.intended_block_id ?? null;
    if (body.intendedBedId != null) {
      await ensurePlantableBedInFarm(client, body.intendedBedId, auth.farmId);
    }
    if (body.seedItemId != null) {
      await ensureSeedItemInFarm(client, body.seedItemId, auth.farmId);
    }
    if (body.taskFlowTemplateId != null) {
      await ensureTaskFlowInFarm(client, body.taskFlowTemplateId, auth.farmId);
    }
    const { intendedFieldId, intendedBlockId } = await plantingLocationIds(client, auth, body);
    await createUndoSnapshot(client, auth, "Update planting");
    await client.query(
      `
        update plantings
        set
          crop_id = $2,
          variety_id = $3,
          seed_item_id = $4,
          title = $5,
          status = $6,
          intended_field_id = $7,
          intended_block_id = $8,
          intended_bed_id = $9,
          task_flow_template_id = $10,
          spacing = $11,
          plant_count = $12,
          bed_length_used_m = $13,
          notes = $14,
          tray_location = $15,
          tray_count = $16,
          cells_per_tray = $17,
          days_to_harvest = $18,
          field_spacing_in_row = $19,
          row_spacing = $20,
          rows_per_bed = $21,
          dead_at_frost = $22,
          bed_cover = $23,
          planned_sow_date = $24,
          planned_transplant_date = $25,
          expected_harvest_start = $26,
          expected_harvest_end = $27,
          updated_at = now()
        where id = $1 and farm_id = $28
      `,
      [
        id,
        body.cropId,
        body.varietyId ?? null,
        body.seedItemId ?? null,
        body.title,
        body.status,
        intendedFieldId,
        intendedBlockId,
        body.intendedBedId ?? null,
        body.taskFlowTemplateId ?? null,
        body.spacing ?? null,
        body.plantCount ?? null,
        body.bedLengthUsedM ?? null,
        body.notes ?? null,
        body.trayLocation ?? null,
        body.trayCount ?? null,
        body.cellsPerTray ?? null,
        body.daysToHarvest ?? null,
        body.fieldSpacingInRow ?? null,
        body.rowSpacing ?? null,
        body.rowsPerBed ?? null,
        body.deadAtFrost ?? null,
        body.bedCover ?? null,
        body.plannedSowDate ?? null,
        body.plannedTransplantDate ?? null,
        body.expectedHarvestStart ?? null,
        body.expectedHarvestEnd ?? null,
        auth.farmId
      ]
    );
    await learnSeedItemSpacingFromPlanting(client, auth.farmId, id);
    await recalculatePlantingTasks(client, id);
    const blockIdsToReflow = new Set<number>();
    if (previousBlockId != null) blockIdsToReflow.add(previousBlockId);
    if (intendedBlockId != null) blockIdsToReflow.add(intendedBlockId);
    for (const blockIdToReflow of blockIdsToReflow) {
      await reflowExistingBlockPlacementPlan(client, auth.farmId, blockIdToReflow);
    }
    if (intendedBlockId != null) {
      await upsertBlockBedMakingTask(client, auth.farmId, intendedBlockId);
    }
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.json({ ok: true });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.delete("/api/plantings/:id", requireRole("planner"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ id: number; intended_block_id: number | null }>(
      `select id, intended_block_id from plantings where id = $1 and farm_id = $2`,
      [id, auth.farmId]
    );
    if (!existing.rows[0]) {
      await client.query("rollback");
      res.status(404).json({ error: "Planting not found" });
      return;
    }
    await createUndoSnapshot(client, auth, "Delete planting");
    await client.query(`delete from plantings where id = $1`, [id]);
    if (existing.rows[0].intended_block_id != null) {
      await reflowExistingBlockPlacementPlan(client, auth.farmId, existing.rows[0].intended_block_id);
    }
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.json({ ok: true });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/tasks/:id/record", requireRole("worker"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const body = taskRecordSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await ensureTaskInFarm(client, id, auth.farmId);
    await createUndoSnapshot(client, auth, "Record task");

    const taskResult = await client.query<{
      id: number;
      planting_id: number | null;
      bed_id: number | null;
      task_type: string;
      title: string;
      notes: string | null;
    }>(
      `select id, planting_id, bed_id, task_type, title, notes from tasks where id = $1 and farm_id = $2`,
      [id, auth.farmId]
    );

    const task = taskResult.rows[0];
    if (!task) {
      await client.query("rollback");
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (!isCurrentTaskType(task.task_type)) {
      throw new Error(isLegacyTaskType(task.task_type)
        ? `This task uses the old category "${task.task_type}". Update its task flow to a current category before recording work.`
        : `This task uses the unknown category "${task.task_type}". Update its task flow to a current category before recording work.`);
    }

    let bedMakingMetadata: Record<string, unknown> | null = null;
    let recordedTaskBedId = task.bed_id;
    const bedMakingCompletedPlantingIds = new Set<number>();
    if (body.bedMakingBedCount != null || body.bedMakingMode != null || body.bedMakingBlockFull != null || body.bedMakingRows != null) {
      if (auth.role !== "planner") {
        throw new Error("Planner access required for bed-making adjustments");
      }
      if (task.task_type !== "bed_making") {
        throw new Error("Bed counts can only be recorded on bed-making tasks.");
      }

      const requestedRows = body.bedMakingRows?.filter((row) => row.count > 0) ?? [];
      const requestedRowCount = requestedRows.reduce((sum, row) => sum + row.count, 0);
      const bedCount = requestedRowCount > 0 ? requestedRowCount : body.bedMakingBedCount ?? null;
      if (bedCount == null || bedCount <= 0) {
        throw new Error("Enter the number of beds made.");
      }
      const requestedBlockFull = body.bedMakingBlockFull === true;
      const inferredMode = task.title.toLowerCase().includes("more beds") ? "add_after_existing" : "replace_existing";
      const mode = requestedBlockFull ? "replace_existing" : body.bedMakingMode ?? inferredMode;

      const blockResult = await client.query<{
        id: number;
        name: string;
        field_name: string;
        boundary: GeoJsonPolygonInput;
      }>(
        `
          with task_location as (
            select
              coalesce(task_bed.block_id, planting_bed.block_id, planting.intended_block_id) as block_id
            from tasks task
            left join plantings planting on planting.id = task.planting_id and planting.farm_id = task.farm_id
            left join beds task_bed on task_bed.id = task.bed_id
            left join beds planting_bed on planting_bed.id = planting.intended_bed_id
            where task.id = $1 and task.farm_id = $2
          )
          select
            block.id,
            block.name,
            field.name as field_name,
            ST_AsGeoJSON(block.boundary)::json as boundary
          from task_location
          join blocks block on block.id = task_location.block_id
          join fields field on field.id = block.field_id
          where field.farm_id = $2
        `,
        [task.id, auth.farmId]
      );
      const block = blockResult.rows[0];
      if (!block) {
        throw new Error("This bed-making task is not tied to a mapped block.");
      }

      const existingBeds = await client.query<{
        id: number;
        zone_id: number | null;
        bed_preset_id: number | null;
        is_permanent: boolean;
        sequence_no: number | null;
        bed_width_m: string | null;
        path_spacing_m: string | null;
        area_sqm: string | null;
        bed_length_m: string | null;
        boundary: GeoJsonPolygonInput;
      }>(
        `
          select
            bed.id,
            bed.zone_id,
            bed.bed_preset_id,
            bed.is_permanent,
            bed.sequence_no,
            preset.bed_width_m,
            preset.path_spacing_m,
            bed.area_sqm,
            bed.bed_length_m,
            ST_AsGeoJSON(coalesce(bed.boundary, ST_Transform(bed.geom, 4326)))::json as boundary
          from beds bed
          left join bed_presets preset on preset.id = bed.bed_preset_id
          where bed.block_id = $1
            and bed.source <> 'road'
          order by bed.sequence_no nulls last, bed.id
        `,
        [block.id]
      );
      if (existingBeds.rows.length === 0) {
        throw new Error("Make at least one planned bed before recording actual bed-making.");
      }

      const plannedBedCount = existingBeds.rows.length;
      const unfinishedPlannedMatch = task.notes?.match(/(\d+)\s+planned beds were not made/i) ?? null;
      const plannedReferenceCount = unfinishedPlannedMatch
        ? existingBeds.rows.length + Number(unfinishedPlannedMatch[1])
        : plannedBedCount;
      const blockFull = requestedBlockFull || (mode === "replace_existing" && bedCount >= plannedReferenceCount);
      const targetBed = mode === "replace_existing" ? existingBeds.rows[0] : existingBeds.rows[existingBeds.rows.length - 1];
      const fallbackPreset = await resolveBedMakingPreset(client, auth.farmId, targetBed);
      const rowPresets = new Map<number, Awaited<ReturnType<typeof loadBedMakingPreset>>>();
      for (const row of requestedRows) {
        if (!rowPresets.has(row.presetId)) {
          rowPresets.set(row.presetId, await loadBedMakingPreset(client, auth.farmId, row.presetId));
        }
      }
      const recordedRows = requestedRows.length > 0
        ? requestedRows.map((row) => ({ count: row.count, preset: rowPresets.get(row.presetId) ?? fallbackPreset }))
        : [{ count: bedCount, preset: fallbackPreset }];
      const existingRowsForBlockFull: Array<{ count: number; preset: typeof fallbackPreset }> = [];
      if (blockFull && inferredMode === "add_after_existing") {
        for (const bed of existingBeds.rows) {
          let preset = fallbackPreset;
          if (bed.bed_preset_id != null) {
            if (!rowPresets.has(bed.bed_preset_id)) {
              rowPresets.set(bed.bed_preset_id, await loadBedMakingPreset(client, auth.farmId, bed.bed_preset_id));
            }
            preset = rowPresets.get(bed.bed_preset_id) ?? fallbackPreset;
          }
          existingRowsForBlockFull.push({ count: 1, preset });
        }
      }
      const rowsToGenerate = [...existingRowsForBlockFull, ...recordedRows];

      const lineCoordinates = bedMakingGuideLine(targetBed.boundary, block.boundary, mode);
      if (lineCoordinates.length < 2) {
        throw new Error("Could not read the planned bed edge for actual bed-making.");
      }
      const harvestRoadPattern = inferHarvestRoadPatternFromBeds(
        existingBeds.rows,
        bedMakingGuideLine(existingBeds.rows[0].boundary, block.boundary, "replace_existing")
      );

      if (mode === "replace_existing") {
        await moveBlockBedAssignmentsToOverflowForReplacement(client, auth.farmId, block.id, null);
      }

      const startNumber = mode === "replace_existing"
        ? 1
        : Math.max(
            existingBeds.rows.length + 1,
            ...existingBeds.rows.map((bed) => Number(bed.sequence_no ?? 0) + 1)
          );
      const bedsToGenerate = rowsToGenerate.flatMap((row) => Array.from({ length: row.count }, () => row.preset));
      const generatedBedCount = bedsToGenerate.length;
      const referencePreset = rowsToGenerate[0]?.preset ?? fallbackPreset;
      const plannedRoadSlotCount = harvestRoadPattern
        ? Math.floor(Math.max(0, plannedReferenceCount - 1) / harvestRoadPattern.everyBeds) * harvestRoadPattern.widthBeds
        : 0;
      const plannedSpanM =
        plannedReferenceCount * referencePreset.bedWidthM +
        Math.max(0, plannedReferenceCount - 1) * referencePreset.pathSpacingM +
        plannedRoadSlotCount * (referencePreset.bedWidthM + referencePreset.pathSpacingM);
      const generatedBedWidthM = rowsToGenerate.reduce((sum, row) => sum + row.count * row.preset.bedWidthM, 0);
      const generatedRoadSlotCount = harvestRoadPattern
        ? Math.floor(Math.max(0, generatedBedCount - 1) / harvestRoadPattern.everyBeds) * harvestRoadPattern.widthBeds
        : 0;
      const overTargetBlockFull = blockFull && mode === "replace_existing" && generatedBedCount > plannedReferenceCount;
      const overTargetScale = overTargetBlockFull
        ? Math.min(
            1,
            plannedSpanM / Math.max(
              0.1,
              generatedBedWidthM +
                Math.max(0, generatedBedCount - 1) * referencePreset.pathSpacingM +
                generatedRoadSlotCount * (referencePreset.bedWidthM + referencePreset.pathSpacingM)
            )
          )
        : null;
      const stretchedPathSpacingM = blockFull && generatedBedCount > 1
        ? overTargetScale != null
          ? referencePreset.pathSpacingM * overTargetScale
          : Math.max(
              0,
              (plannedSpanM - generatedBedWidthM - generatedRoadSlotCount * referencePreset.bedWidthM) /
                Math.max(1, generatedBedCount - 1 + generatedRoadSlotCount)
            )
        : null;
      const bedWidthScale = overTargetScale;
      const insertedIds: number[] = [];
      let nextLineCoordinates = lineCoordinates;
      let nextStartNumber = startNumber;
      let replaceOnThisRun = mode === "replace_existing";
      const canBatchReplaceFromOriginalEdge = mode === "replace_existing"
        && bedsToGenerate.length > 0
        && bedsToGenerate.every((preset) => preset.id === bedsToGenerate[0].id);
      if (canBatchReplaceFromOriginalEdge) {
        const result = await insertGeneratedBeds(client, {
          blockId: block.id,
          presetId: bedsToGenerate[0].id,
          zoneId: targetBed.zone_id ?? null,
          lineMode: "straight",
          lineCoordinates,
          count: generatedBedCount,
          layoutStartIndex: 0,
          edgeOffsetM: 0,
          namePrefix: `${block.name}-`,
          startNumber,
          isPermanent: targetBed.is_permanent,
          replaceExisting: true,
          invertSide: false,
          fillWholeBlock: blockFull,
          harvestRoadEveryBeds: harvestRoadPattern?.everyBeds ?? null,
          harvestRoadWidthBeds: harvestRoadPattern?.widthBeds ?? 0,
          pathSpacingOverrideM: stretchedPathSpacingM,
          bedWidthOverrideM: bedWidthScale == null ? null : bedsToGenerate[0].bedWidthM * bedWidthScale
        });
        const generatedIds = result.insertedIds ?? [];
        const keptIds = blockFull ? generatedIds.slice(0, generatedBedCount) : generatedIds;
        const extraIds = blockFull ? generatedIds.slice(generatedBedCount) : [];
        if (extraIds.length > 0) {
          await client.query(`delete from beds where id = any($1::int[])`, [extraIds]);
        }
        if (keptIds.length !== generatedBedCount) {
          throw new Error(`Only ${keptIds.length} of ${generatedBedCount} beds fit from the planned bed edge.`);
        }
        insertedIds.push(...keptIds);
      } else {
        let plantableBedsBefore = mode === "replace_existing" ? 0 : existingBeds.rows.length;
        for (const preset of bedsToGenerate) {
          const basePathSpacingM = stretchedPathSpacingM ?? preset.pathSpacingM;
          const roadOffsetM = harvestRoadPattern && plantableBedsBefore > 0 && plantableBedsBefore % harvestRoadPattern.everyBeds === 0
            ? harvestRoadPattern.widthBeds * (preset.bedWidthM + basePathSpacingM)
            : 0;
          const rowEdgeOffsetM = replaceOnThisRun && mode === "replace_existing"
            ? 0
            : basePathSpacingM + roadOffsetM;
          const result = await insertGeneratedBeds(client, {
            blockId: block.id,
            presetId: preset.id,
            zoneId: targetBed.zone_id ?? null,
            lineMode: "straight",
            lineCoordinates: nextLineCoordinates,
            count: 1,
            layoutStartIndex: 0,
            edgeOffsetM: rowEdgeOffsetM,
            namePrefix: `${block.name}-`,
            startNumber: nextStartNumber,
            isPermanent: targetBed.is_permanent,
            replaceExisting: replaceOnThisRun,
            invertSide: false,
            fillWholeBlock: false,
            harvestRoadEveryBeds: null,
            harvestRoadWidthBeds: 0,
            pathSpacingOverrideM: basePathSpacingM,
            bedWidthOverrideM: bedWidthScale == null ? null : preset.bedWidthM * bedWidthScale,
            ignoreBedIds: insertedIds
          });
          if (result.inserted !== 1) {
            throw new Error(`Only ${insertedIds.length + result.inserted} of ${generatedBedCount} beds fit from the planned bed edge.`);
          }
          insertedIds.push(...(result.insertedIds ?? []));
          const lastInsertedId = result.insertedIds?.[result.insertedIds.length - 1] ?? null;
          if (lastInsertedId != null) {
            const lastBoundary = await loadGeneratedBedBoundary(client, lastInsertedId);
            nextLineCoordinates = bedMakingGuideLine(lastBoundary, block.boundary, "add_after_existing");
          }
          nextStartNumber += 1;
          plantableBedsBefore += 1;
          replaceOnThisRun = false;
        }
      }
      if (insertedIds.length !== generatedBedCount) {
        throw new Error(`Only ${insertedIds.length} of ${generatedBedCount} beds fit from the planned bed edge.`);
      }
      if (insertedIds.length) {
        recordedTaskBedId = mode === "replace_existing"
          ? insertedIds[0]
          : insertedIds[insertedIds.length - 1];
      }

      if (targetBed.zone_id != null) {
        await client.query(
          `update block_zones set actual_state = 'beds_made', updated_at = now() where id = $1`,
          [targetBed.zone_id]
        );
        await learnSeedItemSpacingFromPlanting(client, auth.farmId, task.planting_id);
      }
      await reflowExistingBlockPlacementPlan(client, auth.farmId, block.id);

      if (!blockFull && mode === "replace_existing" && bedCount < plannedBedCount && insertedIds.length) {
        await client.query(
          `
            insert into tasks (
              farm_id, bed_id, task_type, title, status, anchor, offset_days,
              scheduled_date, notes, is_auto_generated, icon_color, icon_secondary_color
            )
            select $1, $2, 'bed_making', $3, 'pending', null, null, null, $4, true, '#8b6f43', '#f4c430'
            where not exists (
              select 1
              from tasks
              where farm_id = $1
                and planting_id is null
                and task_type = 'bed_making'
                and status <> 'done'
                and title = $3
            )
          `,
          [
            auth.farmId,
            insertedIds[insertedIds.length - 1],
            `Make more beds in ${block.field_name} / ${block.name}`,
            `Auto-created follow-up bed-making task. ${plannedBedCount - bedCount} planned beds were not made yet. Original planned bed count: ${plannedBedCount}.`
          ]
        );
      }

      bedMakingMetadata = {
        mode,
        bedCount,
        blockFull,
        plannedBedCount,
        plannedReferenceCount,
        generatedBedCount,
        insertedBedCount: insertedIds.length,
        rows: recordedRows.map((row) => ({ count: row.count, presetId: row.preset.id })),
        harvestRoadPattern,
        blockId: block.id
      };

      if (blockFull && task.planting_id != null) {
        const completedRelatedTasks = await client.query<{ planting_id: number }>(
          `
            update tasks related_task
            set
              status = 'done',
              completed_date = $3,
              notes = concat_ws(E'\n', related_task.notes, $4::text),
              bed_id = coalesce(related_task.bed_id, $5::integer),
              updated_at = now()
            from plantings planting
            left join beds intended_bed on intended_bed.id = planting.intended_bed_id
            where related_task.farm_id = $1
              and related_task.id <> $2
              and related_task.task_type = 'bed_making'
              and related_task.status <> 'done'
              and related_task.planting_id = planting.id
              and (
                planting.intended_block_id = $6
                or intended_bed.block_id = $6
                or related_task.bed_id in (select id from beds where block_id = $6)
              )
            returning related_task.planting_id
          `,
          [
            auth.farmId,
            id,
            body.actualDate,
            `Block beds made from ${task.title}; marked complete because Block full was recorded.`,
            recordedTaskBedId,
            block.id
          ]
        );
        for (const row of completedRelatedTasks.rows) {
          bedMakingCompletedPlantingIds.add(row.planting_id);
        }
      }
    }

    if (task.planting_id != null) {
      const taskActualUpdate = actualUpdateForTaskType(task.task_type);
      if (taskActualUpdate) {
        assertNoFuturePlantingDate(taskActualUpdate.eventType, body.actualDate);
      }
      const plantingResult = await client.query<{
        title: string;
        crop_id: number;
        variety_id: number | null;
        seed_item_id: number | null;
        crop_name: string;
        variety_name: string | null;
        seed_lot_number: string | null;
      }>(
        `
          select
            planting.title,
            planting.crop_id,
            planting.variety_id,
            planting.seed_item_id,
            crop.name as crop_name,
            variety.name as variety_name,
            seed.lot_number as seed_lot_number
          from plantings planting
          join crops crop on crop.id = planting.crop_id
          left join varieties variety on variety.id = planting.variety_id
          left join seed_items seed on seed.id = planting.seed_item_id
          where planting.id = $1
        `,
        [task.planting_id]
      );
      const plantingRow = plantingResult.rows[0];
      const plantingTitle = plantingRow?.title ?? "Planting";
      const lotNumber = body.lotNumber?.trim() || null;
      const taskRequiresLotNumber = ["seed_in_tray", "direct_seed", "transplant"].includes(task.task_type);
      if (taskRequiresLotNumber) {
        if (!lotNumber) {
          throw new Error("Lot number is required when recording this planting task.");
        }
        if (!plantingRow) {
          throw new Error("Planting not found");
        }
        if (plantingRow.seed_item_id != null && (!plantingRow.seed_lot_number || plantingRow.seed_lot_number === lotNumber)) {
          await ensureSeedItemLot(client, plantingRow.seed_item_id, auth.farmId, lotNumber);
        } else {
          const matchingSeed = await client.query<{ id: number }>(
            `
              select seed.id
              from seed_items seed
              left join seed_item_lots lot on lot.seed_item_id = seed.id
              where seed.farm_id = $1
                and seed.crop_id = $2
                and (($3::integer is null and seed.variety_id is null) or seed.variety_id = $3)
                and (seed.lot_number = $4 or lot.lot_number = $4)
              order by seed.id
              limit 1
            `,
            [auth.farmId, plantingRow.crop_id, plantingRow.variety_id, lotNumber]
          );
          const seedItemId = matchingSeed.rows[0]?.id ?? (await client.query<{ id: number }>(
            `
              insert into seed_items (
                farm_id, crop_id, variety_id, family, crop_type, variety_name, breed_name, supplier, catalog_number, lot_number, notes
              )
              values ($1, $2, $3, null, $4, $5, null, null, null, $6, $7)
              returning id
            `,
            [
              auth.farmId,
              plantingRow.crop_id,
              plantingRow.variety_id,
              plantingRow.crop_name,
              plantingRow.variety_name,
              lotNumber,
              "Created from field work task completion."
            ]
          )).rows[0].id;
          await ensureSeedItemLot(client, seedItemId, auth.farmId, lotNumber);
          await client.query(
            `update plantings set seed_item_id = $2, updated_at = now() where id = $1 and farm_id = $3`,
            [task.planting_id, seedItemId, auth.farmId]
          );
        }
      }
      const hasPlantingAdjustments =
        body.intendedBedId !== undefined ||
        body.plantCount !== undefined ||
        body.bedLengthUsedM !== undefined ||
        body.trayCount !== undefined ||
        body.cellsPerTray !== undefined ||
        body.spacing !== undefined;

      if (hasPlantingAdjustments) {
        if (auth.role !== "planner") {
          throw new Error("Planner access required for planting adjustments");
        }
        if (body.intendedBedId != null) {
          await ensurePlantableBedInFarm(client, body.intendedBedId, auth.farmId);
        }
        const adjustedBlockId = body.intendedBedId != null ? await blockIdForBed(client, body.intendedBedId, auth.farmId) : null;
        const adjustedFieldId = adjustedBlockId != null ? await fieldIdForBlock(client, adjustedBlockId, auth.farmId) : null;
        await client.query(
          `
            update plantings
            set
              intended_field_id = case when $2::boolean then $3::integer else intended_field_id end,
              intended_block_id = case when $2::boolean then $4::integer else intended_block_id end,
              intended_bed_id = case when $2::boolean then $5::integer else intended_bed_id end,
              plant_count = case when $6::boolean then $7::integer else plant_count end,
              bed_length_used_m = case when $8::boolean then $9::numeric else bed_length_used_m end,
              spacing = case when $10::boolean then $11::text else spacing end,
              tray_count = case when $12::boolean then $13::numeric else tray_count end,
              cells_per_tray = case when $14::boolean then $15::integer else cells_per_tray end,
              updated_at = now()
            where id = $1
          `,
          [
            task.planting_id,
            body.intendedBedId !== undefined,
            adjustedFieldId,
            adjustedBlockId,
            body.intendedBedId ?? null,
            body.plantCount !== undefined,
            body.plantCount ?? null,
            body.bedLengthUsedM !== undefined,
            body.bedLengthUsedM ?? null,
            body.spacing !== undefined,
            body.spacing ?? null,
            body.trayCount !== undefined,
            body.trayCount ?? null,
            body.cellsPerTray !== undefined,
            body.cellsPerTray ?? null
          ]
        );
      }

      if (body.placementBedId != null && (body.placementPlantCount != null || body.placementBedLengthUsedM != null)) {
        if (auth.role !== "planner") {
          throw new Error("Planner access required for planting adjustments");
        }
        await ensurePlantableBedInFarm(client, body.placementBedId, auth.farmId);
        const placementInsert = await client.query<{ id: number }>(
          `
            insert into planting_placements (
              planting_id, bed_id, plant_count, bed_length_used_m, placed_on, location_detail, notes,
              boundary, centroid, area_sqm
            )
            values (
              $1, $2, $3, $4, $5, $6, $7,
              case when $8::text is null then null else ST_GeomFromText($8, 4326) end,
              case when $8::text is null then null else ST_Centroid(ST_GeomFromText($8, 4326)) end,
              case when $8::text is null then null else ST_Area(ST_GeomFromText($8, 4326)::geography) end
            )
            returning id
          `,
          [
            task.planting_id,
            body.placementBedId,
            body.placementPlantCount ?? null,
            body.placementBedLengthUsedM ?? null,
            body.actualDate,
            body.placementLocationDetail ?? null,
            body.placementNotes ?? null,
            body.placementCoordinates && body.placementCoordinates.length >= 3 ? polygonWkt(body.placementCoordinates) : null
          ]
        );
        const bedContext = await getBedContext(client, body.placementBedId);
        await recordFarmEvent(client, {
          farmId: auth.farmId,
          eventDate: body.actualDate,
          eventType: "placement_recorded",
          title: `Placement recorded for ${plantingTitle}`,
          notes: body.placementNotes ?? null,
          metadata: {
            plantCount: body.placementPlantCount ?? null,
            bedLengthUsedM: body.placementBedLengthUsedM ?? null,
            locationDetail: body.placementLocationDetail ?? null,
            source: "task_record"
          },
          fieldId: bedContext.field_id,
          blockId: bedContext.block_id,
          zoneId: bedContext.zone_id,
          bedId: body.placementBedId,
          plantingId: task.planting_id,
          placementId: placementInsert.rows[0].id,
          taskId: id,
          coordinates: body.placementCoordinates ?? null
        });
      }

      const actualUpdate = actualUpdateForTaskType(task.task_type);
      if (actualUpdate) {
        await client.query(
          `
            update plantings
            set ${actualUpdate.field} = $2, status = $3, notes = concat_ws(E'\n', notes, $4::text), updated_at = now()
            where id = $1
          `,
          [task.planting_id, body.actualDate, actualUpdate.status, body.notes ?? null]
        );
      }

      const bedIdForBlockTask = body.placementBedId ?? body.intendedBedId ?? null;
      if (bedIdForBlockTask != null) {
        const blockId = await blockIdForBed(client, bedIdForBlockTask, auth.farmId);
        if (blockId != null) {
          await upsertBlockBedMakingTask(client, auth.farmId, blockId);
        }
      }

    }

    await client.query(
      `
        update tasks
        set
          status = 'done',
          completed_date = $2,
          notes = concat_ws(E'\n', notes, $3::text),
          bed_id = $4,
          updated_at = now()
        where id = $1
      `,
      [id, body.actualDate, body.notes ?? null, recordedTaskBedId]
    );

    await recordFarmEvent(client, {
      farmId: auth.farmId,
      eventDate: body.actualDate,
      eventType: "task_recorded",
      title: task.task_type.replaceAll("_", " "),
      notes: body.notes ?? null,
      metadata: {
        taskType: task.task_type,
        plantCount: body.plantCount ?? null,
        trayCount: body.trayCount ?? null,
        cellsPerTray: body.cellsPerTray ?? null,
        bedMaking: bedMakingMetadata
      },
      bedId: recordedTaskBedId ?? null,
      plantingId: task.planting_id ?? null,
      taskId: id
    });

    if (task.planting_id != null) {
      bedMakingCompletedPlantingIds.add(task.planting_id);
      await recalculatePlantingTasks(client, task.planting_id);
      const plantingBlock = await client.query<{ intended_block_id: number | null }>(
        `select intended_block_id from plantings where id = $1 and farm_id = $2`,
        [task.planting_id, auth.farmId]
      );
      const blockId = plantingBlock.rows[0]?.intended_block_id ?? null;
      if (blockId != null) {
        await reflowExistingBlockPlacementPlan(client, auth.farmId, blockId);
      }
    }
    for (const plantingId of bedMakingCompletedPlantingIds) {
      if (plantingId !== task.planting_id) {
        await recalculatePlantingTasks(client, plantingId);
      }
    }

    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.json({ ok: true });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/plantings/:id/placements", requireRole("planner"), asyncHandler(async (req, res) => {
  const plantingId = Number(req.params.id);
  const body = placementSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
      await ensurePlantingInFarm(client, plantingId, auth.farmId);
      await ensurePlantableBedInFarm(client, body.bedId, auth.farmId);
      if (body.actualDate && body.actualDate > todayIsoDate()) {
        throw new Error("Planted dates cannot be in the future");
      }
      await createUndoSnapshot(client, auth, "Add planting placement");
    const plantingResult = await client.query<{ title: string }>(`select title from plantings where id = $1`, [plantingId]);
    const plantingTitle = plantingResult.rows[0]?.title ?? "Planting";
    const placementInsert = await client.query<{ id: number }>(
      `
        insert into planting_placements (
          planting_id, bed_id, plant_count, bed_length_used_m, placed_on, location_detail, notes,
          boundary, centroid, area_sqm
        )
        values (
          $1, $2, $3, $4, $5, $6, $7,
          case when $8::text is null then null else ST_GeomFromText($8, 4326) end,
          case when $8::text is null then null else ST_Centroid(ST_GeomFromText($8, 4326)) end,
          case when $8::text is null then null else ST_Area(ST_GeomFromText($8, 4326)::geography) end
        )
        returning id
      `,
      [
        plantingId,
        body.bedId,
        body.plantCount ?? null,
        body.bedLengthUsedM ?? null,
        body.actualDate ?? null,
        body.locationDetail ?? null,
        body.notes ?? null,
        body.coordinates && body.coordinates.length >= 3 ? polygonWkt(body.coordinates) : null
      ]
    );
    const bedContext = await getBedContext(client, body.bedId);
    await recordFarmEvent(client, {
      farmId: auth.farmId,
      eventDate: body.actualDate ?? new Date().toISOString().slice(0, 10),
      eventType: "placement_recorded",
      title: `Placement recorded for ${plantingTitle}`,
      notes: body.notes ?? null,
      metadata: {
        plantCount: body.plantCount ?? null,
        bedLengthUsedM: body.bedLengthUsedM ?? null,
        locationDetail: body.locationDetail ?? null,
        source: "placement_form"
      },
      fieldId: bedContext.field_id,
      blockId: bedContext.block_id,
      zoneId: bedContext.zone_id,
      bedId: body.bedId,
      plantingId,
      placementId: placementInsert.rows[0].id,
      coordinates: body.coordinates ?? null
    });
    const blockId = await blockIdForBed(client, body.bedId, auth.farmId);
    if (blockId != null) {
      await upsertBlockBedMakingTask(client, auth.farmId, blockId);
    }
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.status(201).json({ ok: true });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/plantings/:id/actuals", requireRole("planner"), asyncHandler(async (req, res) => {
  const plantingId = Number(req.params.id);
  const body = actualEventSchema.parse(req.body);
  assertNoFuturePlantingDate(body.eventType, body.actualDate);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await ensurePlantingInFarm(client, plantingId, auth.farmId);
    await createUndoSnapshot(client, auth, "Record planting actual");

    const updates: Record<ActualEventType, { field: string; status: PlantingStatus }> = {
      tray_seeding: { field: "actual_tray_seeding_date", status: "seeded_in_tray" },
      direct_seeding: { field: "actual_direct_seeding_date", status: "direct_seeded" },
      transplant: { field: "actual_transplant_date", status: "transplanted" },
      cultivation: { field: "actual_cultivation_date", status: "growing" },
      harvest: { field: "actual_harvest_date", status: "harvested" },
      finish: { field: "actual_finish_date", status: "finished" }
    };

    const update = updates[body.eventType];
    await client.query(
      `
        update plantings
        set ${update.field} = $2, status = $3, notes = concat_ws(E'\n', notes, $4::text), updated_at = now()
        where id = $1
      `,
      [plantingId, body.actualDate, update.status, body.notes ?? null]
    );

    const plantingResult = await client.query<{ title: string }>(`select title from plantings where id = $1`, [plantingId]);
    await recordFarmEvent(client, {
      farmId: auth.farmId,
      eventDate: body.actualDate,
      eventType: "planting_actual_recorded",
      title: `${body.eventType.replaceAll("_", " ")} recorded for ${plantingResult.rows[0]?.title ?? "planting"}`,
      notes: body.notes ?? null,
      metadata: {
        actualEventType: body.eventType,
        resultingStatus: update.status
      },
      plantingId
    });

    await recalculatePlantingTasks(client, plantingId);
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.json({ ok: true });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/harvests", requireRole("worker"), asyncHandler(async (req, res) => {
  const body = harvestSchema.parse(req.body);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await ensurePlantingInFarm(client, body.plantingId, auth.farmId);
    await ensurePlantableBedInFarm(client, body.bedId, auth.farmId);
    await createUndoSnapshot(client, auth, "Log harvest");
    await client.query(
      `
        insert into harvest_records (farm_id, planting_id, bed_id, harvest_date, quantity, unit, notes)
        values ($1, $2, $3, $4, $5, $6, $7)
      `,
      [auth.farmId, body.plantingId, body.bedId, body.harvestDate, body.quantity, body.unit, body.notes ?? null]
    );
    await client.query(
      `update plantings set actual_harvest_date = coalesce(actual_harvest_date, $2), status = 'harvested', updated_at = now() where id = $1`,
      [body.plantingId, body.harvestDate]
    );
    const plantingResult = await client.query<{ title: string }>(`select title from plantings where id = $1`, [body.plantingId]);
    const bedContext = await getBedContext(client, body.bedId);
    await recordFarmEvent(client, {
      farmId: auth.farmId,
      eventDate: body.harvestDate,
      eventType: "harvest_logged",
      title: `Harvest logged for ${plantingResult.rows[0]?.title ?? "planting"}`,
      notes: body.notes ?? null,
      metadata: {
        quantity: body.quantity,
        unit: body.unit
      },
      fieldId: bedContext.field_id,
      blockId: bedContext.block_id,
      zoneId: bedContext.zone_id,
      bedId: body.bedId,
      plantingId: body.plantingId
    });
    await recalculatePlantingTasks(client, body.plantingId);
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.status(201).json({ ok: true });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));
}
