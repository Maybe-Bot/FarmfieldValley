/**
 * Main API server for the Loam Ledger prototype.
 *
 * This file wires Express routes to PostgreSQL/PostGIS. In broad terms it:
 * - validates incoming JSON with zod schemas,
 * - checks the current session and farm role,
 * - reads/writes farm map objects, plantings, tasks, events, feedback, and admin data,
 * - recalculates task dates after actual work is recorded.
 *
 * It is intentionally broad because this is a fast-moving prototype. If this app
 * keeps growing, the safest refactor is to split this file into route modules
 * such as map routes, planting routes, task routes, auth routes, and admin routes.
 */
import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import { PoolClient } from "pg";
import { z } from "zod";
import { AuthContext, AuthenticatedRequest, resolveAuthContext } from "./auth";
import {
  BedLineMode,
  extendStraightLine,
  lineStringWkt3857,
  projectWgs84To3857,
  resolveBedEdgeOffsets,
  resolveSide,
  simplifyNearlyStraightLine,
  straightLineFromGuide,
  validateBedLine,
  webMercatorMetersForGroundMeters
} from "./beds";
import { pool } from "./db";
import { config } from "./config";
import {
  ensureBedInFarm,
  ensureBedPresetInFarm,
  ensureBlockInFarm,
  ensureBlockZoneInFarm,
  ensureCoverCropNameInFarm,
  ensureFieldInFarm,
  ensurePlantableBedInFarm,
  ensurePlantingInFarm,
  ensureSeedItemInFarm,
  ensureSeedItemLot,
  ensureTaskFlowInFarm,
  ensureTaskInFarm,
  ensureTractorProfileInFarm
} from "./farm-permissions";
import { seedStarterSeedCatalog } from "./default-seed-catalog";
import { boundingBox, normalizeCoordinates, polygonWkt } from "./geometry";
import {
  defaultOfflineImageryStatus,
  findBestCachedTile,
  readOfflineImageryManifest
} from "./offline-imagery";
import { publicErrorResponse } from "./public-error-response";
import { asyncHandler, requireRole, requireValidCsrfForAuthenticatedWrites } from "./route-helpers";
import { registerAdminRoutes } from "./routes/admin";
import { registerAuthRoutes } from "./routes/auth";
import { registerFarmRoutes } from "./routes/farm-routes";
import { registerAccountManagementRoutes } from "./routes/account-management";
import { registerUsageEventRoutes } from "./routes/usage-events";
import { recalculatePlantingTasks } from "./scheduler";
import { startExpiredSessionCleanup } from "./session-cleanup";
import {
  BlockPlacementPlanRow,
  PlantingInput,
  SeedItemLotInput,
  ZoneActualStateInput
} from "./schemas";
import { ActualEventType, FarmRole, isCurrentTaskType, isLegacyTaskType, PlantingStatus, TaskType } from "./types";
import { taskFlowScheduleProblem, validateTaskFlowGraph } from "./task-flow-validation";
import {
  registerUndoRoutes
} from "./undo";

const app = express();
const MAX_SYNC_TASK_FLOW_RECALCULATIONS = 100;
app.set("trust proxy", config.trustProxy);
app.use(cors({
  credentials: true,
  exposedHeaders: ["Content-Disposition"],
  origin(origin, callback) {
    // Browser requests must come from an explicitly configured frontend origin.
    // Non-browser same-origin/server-to-server requests often omit Origin.
    if (!origin || config.corsAllowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`CORS origin not allowed: ${origin}`));
  }
}));
// Spreadsheet uploads are sent as base64 JSON so the prototype does not need a multipart parser.
app.use("/api/import/spreadsheet", express.json({ limit: "12mb" }));
app.use(express.json({ limit: "512kb" }));


export function actualUpdateForTaskType(taskType: string): { eventType: ActualEventType; field: string; status: PlantingStatus } | null {
  switch (taskType) {
    case "seed_in_tray":
      return { eventType: "tray_seeding", field: "actual_tray_seeding_date", status: "seeded_in_tray" };
    case "direct_seed":
      return { eventType: "direct_seeding", field: "actual_direct_seeding_date", status: "direct_seeded" };
    case "transplant":
      return { eventType: "transplant", field: "actual_transplant_date", status: "transplanted" };
    case "cultivation":
      return { eventType: "cultivation", field: "actual_cultivation_date", status: "growing" };
    default:
      return null;
  }
}

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function assertNoFuturePlantingDate(eventType: string, actualDate: string) {
  if ((eventType === "tray_seeding" || eventType === "direct_seeding" || eventType === "transplant") && actualDate > todayIsoDate()) {
    throw new Error("Planted dates cannot be in the future");
  }
}

export function assertNoFuturePlantingStatusDate(status: string, sowDate?: string | null, transplantDate?: string | null) {
  if ((status === "seeded_in_tray" || status === "direct_seeded") && sowDate && sowDate > todayIsoDate()) {
    throw new Error("Planted dates cannot be in the future");
  }
  if (status === "transplanted" && transplantDate && transplantDate > todayIsoDate()) {
    throw new Error("Planted dates cannot be in the future");
  }
}

// Attach auth data to API requests. Auth bootstrap/session routes are allowed
// to run without an existing authenticated farm session.
app.use("/api", asyncHandler(async (req, _res, next) => {
  if (
    req.path === "/auth/login" ||
    req.path === "/auth/register" ||
    req.path === "/auth/verify-email" ||
    req.path === "/auth/capabilities" ||
    req.path === "/auth/forgot-password" ||
    req.path === "/auth/resend-verification" ||
    req.path === "/auth/reset-password" ||
    req.path === "/invitations/inspect" ||
    req.path === "/invitations/accept" ||
    req.path === "/session"
  ) {
    next();
    return;
  }

  (req as AuthenticatedRequest).auth = await resolveAuthContext(req);
  next();
}));

app.use("/api", requireValidCsrfForAuthenticatedWrites);

export function rectangleWkt(x: number, y: number, width: number, height: number) {
  const x2 = x + width;
  const y2 = y + height;
  return `POLYGON((${x} ${y}, ${x2} ${y}, ${x2} ${y2}, ${x} ${y2}, ${x} ${y}))`;
}

// "ensureXInFarm" helpers prevent users from editing records that belong to a
// different farm. Keep using this pattern when adding new farm-owned records.
function normalizedSeedLots(lots: SeedItemLotInput[] | undefined, fallbackLotNumber?: string | null, fallbackStockQuantity?: number | null) {
  const rawLots = lots && lots.length > 0
    ? lots
    : fallbackLotNumber?.trim()
      ? [{ lotNumber: fallbackLotNumber, stockQuantity: fallbackStockQuantity ?? null }]
      : [];
  const seen = new Set<string>();
  const normalized: Array<{ lotNumber: string; stockQuantity: number | null }> = [];

  for (const lot of rawLots) {
    const lotNumber = lot.lotNumber.trim();
    const stockQuantity = lot.stockQuantity ?? null;
    if (!lotNumber && stockQuantity == null) {
      continue;
    }
    if (!lotNumber) {
      throw new Error("Lot number is required when stock is entered.");
    }
    const key = lotNumber.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate lot number: ${lotNumber}`);
    }
    seen.add(key);
    normalized.push({ lotNumber, stockQuantity });
  }

  return normalized;
}

async function replaceSeedItemLots(
  client: PoolClient,
  seedItemId: number,
  farmId: number,
  lots: Array<{ lotNumber: string; stockQuantity: number | null }>
) {
  await ensureSeedItemInFarm(client, seedItemId, farmId);
  await client.query(`delete from seed_item_lots where seed_item_id = $1`, [seedItemId]);
  for (const lot of lots) {
    await client.query(
      `
        insert into seed_item_lots (seed_item_id, lot_number, stock_quantity)
        values ($1, $2, $3)
      `,
      [seedItemId, lot.lotNumber, lot.stockQuantity]
    );
  }

  const totalStock = lots.some((lot) => lot.stockQuantity != null)
    ? lots.reduce((sum, lot) => sum + (lot.stockQuantity ?? 0), 0)
    : null;
  await client.query(
    `
      update seed_items
      set
        lot_number = $2,
        stock_quantity = $3,
        updated_at = now()
      where id = $1 and farm_id = $4
    `,
    [seedItemId, lots[0]?.lotNumber ?? null, totalStock, farmId]
  );
}

export async function learnSeedItemSpacingFromPlanting(client: PoolClient, farmId: number, plantingId: number) {
  const result = await client.query<{
    seed_item_id: number | null;
    spacing: string | null;
    field_spacing_in_row: string | null;
    row_spacing: string | null;
    rows_per_bed: number | null;
  }>(
    `
      select seed_item_id, spacing, field_spacing_in_row, row_spacing, rows_per_bed
      from plantings
      where id = $1 and farm_id = $2
    `,
    [plantingId, farmId]
  );
  const row = result.rows[0];
  if (!row?.seed_item_id) {
    return;
  }

  const spacing = row.spacing?.trim() || null;
  const fieldSpacingInRow = row.field_spacing_in_row == null ? null : Number(row.field_spacing_in_row);
  const rowSpacing = row.row_spacing == null ? null : Number(row.row_spacing);
  const rowsPerBed = row.rows_per_bed;
  if (spacing == null && fieldSpacingInRow == null && rowSpacing == null && rowsPerBed == null) {
    return;
  }

  await client.query(
    `
      update seed_items
      set
        usual_spacing = coalesce($3, usual_spacing),
        usual_field_spacing_in_row = coalesce($4, usual_field_spacing_in_row),
        usual_row_spacing = coalesce($5, usual_row_spacing),
        usual_rows_per_bed = coalesce($6, usual_rows_per_bed),
        updated_at = now()
      where id = $1 and farm_id = $2
    `,
    [row.seed_item_id, farmId, spacing, fieldSpacingInRow, rowSpacing, rowsPerBed]
  );
}

export async function upsertCoverCropName(
  client: PoolClient,
  options: { farmId: number; coverCropNameId?: number | null; coverCropName?: string | null }
) {
  if (options.coverCropNameId != null) {
    await ensureCoverCropNameInFarm(client, options.coverCropNameId, options.farmId);
    return options.coverCropNameId;
  }

  const nextName = options.coverCropName?.trim();
  if (!nextName) {
    return null;
  }

  const result = await client.query<{ id: number }>(
    `
      insert into cover_crop_names (farm_id, name)
      values ($1, $2)
      on conflict (farm_id, name)
      do update set updated_at = now()
      returning id
    `,
    [options.farmId, nextName]
  );
  return result.rows[0].id;
}

// Builds bed polygons in PostGIS by offsetting the selected line, clipping each
// bed to the block, and inserting the resulting footprints.
export async function insertGeneratedBeds(
  client: PoolClient,
  options: {
    blockId: number;
    farmId: number;
    presetId: number;
    zoneId?: number | null;
    lineMode: BedLineMode;
    lineCoordinates: Array<{ lat: number; lng: number }>;
    count: number;
    layoutStartIndex: number;
    edgeOffsetM: number;
    namePrefix: string;
    startNumber: number;
    isPermanent: boolean;
    replaceExisting: boolean;
    invertSide: boolean;
    fillWholeBlock: boolean;
    harvestRoadEveryBeds?: number | null;
    harvestRoadWidthBeds: number;
    pathSpacingOverrideM?: number | null;
    bedWidthOverrideM?: number | null;
    ignoreBedIds?: number[];
  }
) {
  const presetResult = await client.query<{ bed_width_m: string; path_spacing_m: string; name: string; is_road: boolean }>(
    `select bed_width_m, path_spacing_m, name, is_road from bed_presets where id = $1 and farm_id = $2`,
    [options.presetId, options.farmId]
  );
  if (!presetResult.rows[0]) {
    throw new Error("Bed preset not found");
  }

  if (options.replaceExisting) {
    if (options.zoneId != null) {
      await client.query(
        `
          delete from beds bed
          using blocks block, fields field
          where bed.block_id = block.id
            and block.field_id = field.id
            and field.farm_id = $2
            and bed.zone_id = $1
        `,
        [options.zoneId, options.farmId]
      );
    } else {
      await client.query(
        `
          delete from beds bed
          using blocks block, fields field
          where bed.block_id = block.id
            and block.field_id = field.id
            and field.farm_id = $2
            and bed.block_id = $1
        `,
        [options.blockId, options.farmId]
      );
    }
  }

  const linePoints = straightLineFromGuide(simplifyNearlyStraightLine(options.lineCoordinates.map((point) => projectWgs84To3857(point.lat, point.lng))));
  const lineMode: BedLineMode = "straight";
  validateBedLine(lineMode, linePoints);

  const lineWkt = lineStringWkt3857(linePoints);
  const fullLineWkt = lineMode === "straight" ? lineStringWkt3857(extendStraightLine(linePoints)) : null;
  const bedWidthM = options.bedWidthOverrideM != null
    ? Math.max(0.1, options.bedWidthOverrideM)
    : Number(presetResult.rows[0].bed_width_m);
  const isRoadPreset = presetResult.rows[0].is_road;
  const pathSpacingM = isRoadPreset
    ? 0
    : options.pathSpacingOverrideM != null
      ? Math.max(0, options.pathSpacingOverrideM)
      : Number(presetResult.rows[0].path_spacing_m);
  const referenceLatitude =
    options.lineCoordinates.reduce((sum, point) => sum + point.lat, 0) / options.lineCoordinates.length;
  const bedWidthProjectedM = webMercatorMetersForGroundMeters(bedWidthM, referenceLatitude);
  const pathSpacingProjectedM = webMercatorMetersForGroundMeters(pathSpacingM, referenceLatitude);
  const edgeOffsetProjectedM = webMercatorMetersForGroundMeters(options.edgeOffsetM, referenceLatitude);

  const insertOneBed = async (side: "left" | "right", layoutBedIndex: number, sequenceIndex: number) => {
    const sideSign = side === "left" ? 1 : -1;
    const harvestRoadEveryBeds = options.harvestRoadEveryBeds && options.harvestRoadWidthBeds > 0 ? options.harvestRoadEveryBeds : null;
    const skippedBedSlots = harvestRoadEveryBeds ? Math.floor(layoutBedIndex / harvestRoadEveryBeds) * options.harvestRoadWidthBeds : 0;
    const layoutIndex = layoutBedIndex + skippedBedSlots;
    // ST_Buffer is used with side=left/right, so the offset line is the bed edge,
    // not the bed centerline. For the first bed from a block edge, start from a
    // tiny inward offset so boundary wiggles do not shorten or reject the bed.
    // When building from a selected bed edge, edgeOffsetM carries the path width
    // so the next bed starts after the walkway instead of touching the old bed.
    const { clipOffsetM } = resolveBedEdgeOffsets({
      edgeOffsetM: edgeOffsetProjectedM,
      layoutIndex,
      bedWidthM: bedWidthProjectedM,
      pathSpacingM: pathSpacingProjectedM,
      sideSign
    });
    const sql = lineMode === "straight" ? `
      with
      block_geom as (
        select ST_Transform(coalesce(zone.boundary, block.boundary), 3857) as geom
        from blocks block
        join fields field on field.id = block.field_id
        left join block_zones zone on zone.id = $13
        where block.id = $1
          and field.farm_id = $16
          and ($13::integer is null or zone.id is not null)
      ),
      base_line as (
        select ST_GeomFromText($2, 3857) as geom
      ),
      full_line as (
        select ST_GeomFromText($3, 3857) as geom
      ),
      edge_line as (
        select ST_LineMerge(ST_OffsetCurve(full_line.geom, $4::double precision)) as geom
        from full_line, base_line
      ),
      offset_segment as (
        select segment.geom
        from (
          select (ST_Dump(ST_CollectionExtract(ST_Intersection(edge_line.geom, block_geom.geom), 2))).geom
          from edge_line, block_geom
        ) as segment
        order by ST_Length(segment.geom) desc
        limit 1
      ),
      trimmed_line as (
        select offset_segment.geom
        from offset_segment
        where ST_Length(offset_segment.geom) > greatest($5::double precision * 1.2, 0.9)
      ),
      bed_poly as (
        select ST_Buffer(trimmed_line.geom, $5::double precision, $6::text) as geom
        from trimmed_line
        where trimmed_line.geom is not null
      ),
      clipped_bed as (
        select
          ST_CollectionExtract(ST_Intersection(bed_poly.geom, block_geom.geom), 3) as geom,
          ST_Area(bed_poly.geom) as raw_area
        from bed_poly, block_geom
      ),
      bounded as (
        select
          clipped_bed.geom,
          ST_Envelope(clipped_bed.geom) as envelope,
          ST_Area(ST_Transform(clipped_bed.geom, 4326)::geography) as area_sqm,
          ST_Length(ST_Transform(trimmed_line.geom, 4326)::geography) as length_m,
            GeometryType(trimmed_line.geom) = 'LINESTRING'
            and not ST_IsEmpty(clipped_bed.geom)
            and ST_Area(clipped_bed.geom) >= clipped_bed.raw_area * 0.15
            and ST_Length(trimmed_line.geom) >= greatest($5::double precision * 1.2, 0.9) as fits
        from clipped_bed, trimmed_line
      ),
      overlap_check as (
        select
          bounded.*,
          exists (
            select 1
            from beds existing
            join blocks existing_block on existing_block.id = existing.block_id
            join fields existing_field on existing_field.id = existing_block.field_id
            where existing.block_id = $1
              and existing_field.farm_id = $16
              and not (existing.id = any($15::integer[]))
              and ST_Area(ST_Intersection(existing.geom, bounded.geom)) > greatest(ST_Area(bounded.geom) * 0.01, 0.05)
          ) as overlaps_existing
        from bounded
      )
      insert into beds (
        block_id, name, is_permanent, x, y, width, height, bed_length_m, notes,
        geom, boundary, centroid, area_sqm, source, bed_preset_id, direction, sequence_no, zone_id,
        geometry_source, geometry_updated_at, geometry_notes
      )
      select
        $1,
        $7::text,
        $8::boolean,
        ST_XMin(envelope),
        ST_YMin(envelope),
        ST_XMax(envelope) - ST_XMin(envelope),
        ST_YMax(envelope) - ST_YMin(envelope),
        length_m,
        $9::text,
        geom,
        ST_Transform(geom, 4326),
        ST_Centroid(ST_Transform(geom, 4326)),
        area_sqm,
        $14::text,
        $10::integer,
        $11::text,
        $12::integer,
        $13::integer,
        'generated',
        now(),
        'Generated from picked or drawn guide line; geometry can be replaced later from survey/drone data.'
      from overlap_check
      where fits = true and overlaps_existing = false
      returning id
    ` : `
      with
      block_geom as (
        select ST_Transform(coalesce(zone.boundary, block.boundary), 3857) as geom
        from blocks block
        join fields field on field.id = block.field_id
        left join block_zones zone on zone.id = $12
        where block.id = $1
          and field.farm_id = $15
          and ($12::integer is null or zone.id is not null)
      ),
      base_line as (
        select ST_GeomFromText($2, 3857) as geom
      ),
      endpoint_clearance as (
        -- Use the first line's end clearance to define the setback. Each later bed
        -- is clipped against the same inset block, so lengths can change with the
        -- block shape while preserving the same edge margin as the reference line.
        select least(
          ST_Distance(ST_StartPoint(base_line.geom), ST_Boundary(block_geom.geom)),
          ST_Distance(ST_EndPoint(base_line.geom), ST_Boundary(block_geom.geom))
        ) as setback_m
        from base_line, block_geom
      ),
      usable_area as (
        select
          case
            when endpoint_clearance.setback_m > 0.05 then ST_Buffer(block_geom.geom, -endpoint_clearance.setback_m)
            else block_geom.geom
          end as geom
        from block_geom, endpoint_clearance
      ),
      edge_line as (
        select ST_LineMerge(ST_OffsetCurve(base_line.geom, $3::double precision)) as geom
        from base_line
      ),
      trimmed_line as (
        select segment.geom
        from (
          select (ST_Dump(ST_CollectionExtract(ST_Intersection(edge_line.geom, usable_area.geom), 2))).geom
          from edge_line, usable_area
        ) as segment
        order by ST_Length(segment.geom) desc
        limit 1
      ),
      bed_poly as (
        select ST_Buffer(trimmed_line.geom, $4::double precision, $5::text) as geom
        from trimmed_line
      ),
      clipped_bed as (
        -- Clip the buffered bed to the block boundary so tiny geometric
        -- overshoots along the edge do not cause the whole bed to be rejected.
        select
          ST_CollectionExtract(ST_Intersection(bed_poly.geom, block_geom.geom), 3) as geom,
          ST_Area(bed_poly.geom) as raw_area
        from bed_poly, block_geom
      ),
      bounded as (
        select
          clipped_bed.geom,
          ST_Envelope(clipped_bed.geom) as envelope,
          ST_Area(ST_Transform(clipped_bed.geom, 4326)::geography) as area_sqm,
          ST_Length(ST_Transform(trimmed_line.geom, 4326)::geography) as length_m,
            GeometryType(trimmed_line.geom) = 'LINESTRING'
            and not ST_IsEmpty(clipped_bed.geom)
            and ST_Area(clipped_bed.geom) >= clipped_bed.raw_area * 0.15
            and ST_Length(trimmed_line.geom) >= greatest($4::double precision * 1.2, 0.9) as fits
        from clipped_bed, trimmed_line
      ),
      overlap_check as (
        select
          bounded.*,
          exists (
            select 1
            from beds existing
            join blocks existing_block on existing_block.id = existing.block_id
            join fields existing_field on existing_field.id = existing_block.field_id
            where existing.block_id = $1
              and existing_field.farm_id = $15
              and not (existing.id = any($14::integer[]))
              and ST_Area(ST_Intersection(existing.geom, bounded.geom)) > greatest(ST_Area(bounded.geom) * 0.01, 0.05)
          ) as overlaps_existing
        from bounded
      )
      insert into beds (
        block_id, name, is_permanent, x, y, width, height, bed_length_m, notes,
        geom, boundary, centroid, area_sqm, source, bed_preset_id, direction, sequence_no, zone_id,
        geometry_source, geometry_updated_at, geometry_notes
      )
      select
        $1,
        $6::text,
        $7::boolean,
        ST_XMin(envelope),
        ST_YMin(envelope),
        ST_XMax(envelope) - ST_XMin(envelope),
        ST_YMax(envelope) - ST_YMin(envelope),
        length_m,
        $8::text,
        geom,
        ST_Transform(geom, 4326),
        ST_Centroid(ST_Transform(geom, 4326)),
        area_sqm,
        $13::text,
        $9::integer,
        $10::text,
        $11::integer,
        $12::integer,
        'generated',
        now(),
        'Generated from picked or drawn guide line; geometry can be replaced later from survey/drone data.'
      from overlap_check
      where fits = true and overlaps_existing = false
      returning id
    `;

    const sideOption = `side=${side} endcap=flat join=round`;
    const params = lineMode === "straight"
      ? [
          options.blockId,
          lineWkt,
          fullLineWkt,
          clipOffsetM,
          bedWidthProjectedM,
          sideOption,
          `${options.namePrefix}${options.startNumber + sequenceIndex}`,
          options.isPermanent,
          `Generated from preset ${presetResult.rows[0].name}`,
          options.presetId,
          side,
          options.startNumber + sequenceIndex,
          options.zoneId ?? null,
          isRoadPreset ? "road" : "generated",
          options.ignoreBedIds ?? [],
          options.farmId
        ]
      : [
          options.blockId,
          lineWkt,
          clipOffsetM,
          bedWidthProjectedM,
          sideOption,
          `${options.namePrefix}${options.startNumber + sequenceIndex}`,
          options.isPermanent,
          `Generated from preset ${presetResult.rows[0].name}`,
          options.presetId,
          side,
          options.startNumber + sequenceIndex,
          options.zoneId ?? null,
          isRoadPreset ? "road" : "generated",
          options.ignoreBedIds ?? [],
          options.farmId
        ];
    const result = await client.query<{ id: number }>(sql, params);
    return result.rows[0]?.id ?? null;
  };

  const preferredSide = resolveSide(linePoints, options.invertSide);
  const alternateSide = preferredSide === "left" ? "right" : "left";
  const limit = options.fillWholeBlock ? 1000 : options.count;

  const generateForSide = async (side: "left" | "right") => {
    const insertedIds: number[] = [];

    for (let index = 0; index < limit; index += 1) {
      const createdId = await insertOneBed(side, options.layoutStartIndex + index, index);
      if (createdId == null) {
        break;
      }
      insertedIds.push(createdId);
    }

    return insertedIds;
  };

  const primaryIds = await generateForSide(preferredSide);
  const shouldTryAlternate =
    primaryIds.length === 0 ||
    options.fillWholeBlock ||
    (!options.fillWholeBlock && primaryIds.length < options.count);

  if (!shouldTryAlternate) {
    return { inserted: primaryIds.length, insertedIds: primaryIds, isRoad: isRoadPreset };
  }

  if (primaryIds.length > 0) {
    await client.query(
      `
        delete from beds bed
        using blocks block, fields field
        where bed.block_id = block.id
          and block.field_id = field.id
          and field.farm_id = $2
          and bed.id = any($1::int[])
      `,
      [primaryIds, options.farmId]
    );
  }

  const alternateIds = await generateForSide(alternateSide);

  if (alternateIds.length > primaryIds.length) {
    return { inserted: alternateIds.length, insertedIds: alternateIds, isRoad: isRoadPreset };
  }

  if (alternateIds.length > 0) {
    await client.query(
      `
        delete from beds bed
        using blocks block, fields field
        where bed.block_id = block.id
          and block.field_id = field.id
          and field.farm_id = $2
          and bed.id = any($1::int[])
      `,
      [alternateIds, options.farmId]
    );
  }

  if (primaryIds.length > 0) {
    const restoredPrimaryIds = await generateForSide(preferredSide);
    if (restoredPrimaryIds.length > 0) {
      return { inserted: restoredPrimaryIds.length, insertedIds: restoredPrimaryIds, isRoad: isRoadPreset };
    }
  }

  if (alternateIds.length > 0) {
    return { inserted: alternateIds.length, insertedIds: alternateIds, isRoad: isRoadPreset };
  }

  throw new Error("Beds do not fit inside the selected block from the chosen line, or they overlap current beds");
}

export async function blockIdForBed(client: PoolClient, bedId: number, farmId: number) {
  const result = await client.query<{ block_id: number }>(
    `
      select bed.block_id
      from beds bed
      join blocks block on block.id = bed.block_id
      join fields field on field.id = block.field_id
      where bed.id = $1 and field.farm_id = $2
    `,
    [bedId, farmId]
  );
  return result.rows[0]?.block_id ?? null;
}

export async function fieldIdForBlock(client: PoolClient, blockId: number, farmId: number) {
  const result = await client.query<{ field_id: number }>(
    `
      select block.field_id
      from blocks block
      join fields field on field.id = block.field_id
      where block.id = $1 and field.farm_id = $2
    `,
    [blockId, farmId]
  );
  return result.rows[0]?.field_id ?? null;
}

export async function plantingLocationIds(client: PoolClient, auth: AuthContext, body: PlantingInput) {
  let intendedFieldId = body.intendedFieldId ?? null;
  let intendedBlockId = body.intendedBlockId ?? null;

  if (body.intendedBedId != null) {
    intendedBlockId = await blockIdForBed(client, body.intendedBedId, auth.farmId);
  }
  if (intendedBlockId != null) {
    intendedFieldId = await fieldIdForBlock(client, intendedBlockId, auth.farmId);
  }

  if (intendedFieldId != null) {
    await ensureFieldInFarm(client, intendedFieldId, auth.farmId);
  }
  if (intendedBlockId != null) {
    await ensureBlockInFarm(client, intendedBlockId, auth.farmId);
  }

  return { intendedFieldId, intendedBlockId };
}

export async function createPlantingFromInput(client: PoolClient, auth: AuthContext, body: PlantingInput) {
  assertNoFuturePlantingStatusDate(body.status, body.plannedSowDate, body.plannedTransplantDate);
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
  const result = await client.query<{ id: number }>(
    `
      insert into plantings (
        farm_id, crop_id, variety_id, seed_item_id, title, status,
        intended_field_id, intended_block_id, intended_bed_id, task_flow_template_id,
        spacing, plant_count, bed_length_used_m, notes,
        tray_location, tray_count, cells_per_tray, days_to_harvest,
        field_spacing_in_row, row_spacing, rows_per_bed, dead_at_frost, bed_cover,
        planned_sow_date, planned_transplant_date, expected_harvest_start, expected_harvest_end
      )
      values (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17, $18,
        $19, $20, $21, $22, $23,
        $24, $25, $26, $27
      )
      returning id
    `,
    [
      auth.farmId,
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
      body.expectedHarvestEnd ?? null
    ]
  );
  const plantingId = result.rows[0].id;
  await learnSeedItemSpacingFromPlanting(client, auth.farmId, plantingId);
  await recalculatePlantingTasks(client, plantingId);
  if (intendedBlockId != null) {
    await upsertBlockBedMakingTask(client, auth.farmId, intendedBlockId);
    await appendPlantingToBlockPlacementPlan(client, auth.farmId, intendedBlockId, plantingId);
  }
  return { plantingId, intendedBlockId };
}

export async function upsertBlockBedMakingTask(client: PoolClient, farmId: number, blockId: number) {
  const context = await client.query<{ block_name: string; field_name: string; first_bed_id: number | null; scheduled_date: string | null }>(
    `
      with first_bed as (
        select bed.id
        from beds bed
        join blocks block on block.id = bed.block_id
        join fields field on field.id = block.field_id
        where bed.block_id = $2
          and field.farm_id = $1
          and bed.source <> 'road'
        order by bed.sequence_no nulls last, bed.id
        limit 1
      ),
      first_planting_date as (
        select min(coalesce(planting.planned_transplant_date, planting.planned_sow_date))::date as date_value
        from plantings planting
        join beds bed on bed.id = planting.intended_bed_id
        where planting.farm_id = $1
          and bed.block_id = $2
          and bed.source <> 'road'
          and coalesce(planting.planned_transplant_date, planting.planned_sow_date) is not null
      )
      select
        block.name as block_name,
        field.name as field_name,
        first_bed.id as first_bed_id,
        case
          when first_planting_date.date_value is null then null
          else (first_planting_date.date_value - interval '7 days')::date
        end as scheduled_date
      from blocks block
      join fields field on field.id = block.field_id
      left join first_bed on true
      left join first_planting_date on true
      where block.id = $2 and field.farm_id = $1
    `,
    [farmId, blockId]
  );
  const row = context.rows[0];
  if (!row?.first_bed_id) {
    return;
  }

  const title = `Make beds in ${row.field_name} / ${row.block_name}`;
  const notes = "Auto-created block bed-making task. This represents making beds for the whole block.";
  const existing = await client.query<{ id: number }>(
    `
      select id
      from tasks
      where farm_id = $1
        and planting_id is null
        and task_type = 'bed_making'
        and title = $2
        and notes like 'Auto-created block bed-making task.%'
      limit 1
    `,
    [farmId, title]
  );

  if (existing.rows[0]) {
    await client.query(
      `
        update tasks
        set
          bed_id = $2,
          scheduled_date = $3,
          updated_at = now()
        where id = $1
      `,
      [existing.rows[0].id, row.first_bed_id, row.scheduled_date]
    );
    return;
  }

  await client.query(
    `
      insert into tasks (
        farm_id, bed_id, task_type, title, status, anchor, offset_days,
        scheduled_date, notes, is_auto_generated, icon_color, icon_secondary_color
      )
      values ($1, $2, 'bed_making', $3, 'pending', null, null, $4, $5, true, '#8b6f43', '#f4c430')
    `,
    [farmId, row.first_bed_id, title, row.scheduled_date, notes]
  );
}

async function blockHasPlantableBeds(client: PoolClient, blockId: number, farmId: number) {
  const result = await client.query<{ count: string }>(
    `
      select count(*) as count
      from beds bed
      join blocks block on block.id = bed.block_id
      join fields field on field.id = block.field_id
      where bed.block_id = $1
        and field.farm_id = $2
        and bed.source <> 'road'
    `,
    [blockId, farmId]
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}

async function loadExistingBlockPlacementPlanRows(client: PoolClient, farmId: number, blockId: number) {
  const result = await client.query<{
    kind: "planting" | "gap";
    planting_id: number | null;
    placement_order: string;
    bed_length_used_m: string;
    plant_count: string | null;
    tray_count: string | null;
  }>(
    `
      with raw_rows as (
        select
          'planting'::text as kind,
          pp.planting_id,
          pp.placement_order,
          pp.bed_length_used_m,
          pp.plant_count,
          planting.tray_count
        from planting_placements pp
        join beds bed on bed.id = pp.bed_id
        join plantings planting on planting.id = pp.planting_id
        where bed.block_id = $2
          and planting.farm_id = $1
          and pp.plan_source = 'auto_block_plan'

        union all

        select
          'gap'::text as kind,
          null::integer as planting_id,
          gap.placement_order,
          gap.bed_length_used_m,
          null::integer as plant_count,
          null::numeric as tray_count
        from block_placement_gaps gap
        where gap.block_id = $2
          and gap.farm_id = $1

        union all

        select
          overflow.entry_type as kind,
          overflow.planting_id,
          overflow.placement_order,
          overflow.bed_length_used_m,
          overflow.plant_count,
          overflow.tray_count
        from block_placement_overflows overflow
        where overflow.block_id = $2
          and overflow.farm_id = $1
      )
      select
        kind,
        planting_id,
        placement_order,
        sum(bed_length_used_m) as bed_length_used_m,
        sum(plant_count) as plant_count,
        max(tray_count) as tray_count
      from raw_rows
      group by kind, planting_id, placement_order
      order by placement_order, planting_id nulls last
    `,
    [farmId, blockId]
  );

  return result.rows.map((row): BlockPlacementPlanRow => ({
    kind: row.kind,
    plantingId: row.planting_id,
    bedLengthUsedM: Number(row.bed_length_used_m),
    plantCount: row.plant_count == null ? null : Number(row.plant_count),
    trayCount: row.tray_count == null ? null : Number(row.tray_count)
  })).filter((row) => Number.isFinite(row.bedLengthUsedM) && row.bedLengthUsedM > 0);
}

async function blockHasAutoPlacementPlan(client: PoolClient, farmId: number, blockId: number) {
  const result = await client.query<{ count: string }>(
    `
      select (
        (select count(*)
         from planting_placements pp
         join beds bed on bed.id = pp.bed_id
         join plantings planting on planting.id = pp.planting_id
         where bed.block_id = $2
           and planting.farm_id = $1
           and pp.plan_source = 'auto_block_plan')
        + (select count(*) from block_placement_gaps where farm_id = $1 and block_id = $2)
        + (select count(*) from block_placement_overflows where farm_id = $1 and block_id = $2)
      )::text as count
    `,
    [farmId, blockId]
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}

export async function reflowBlockPlacementPlan(
  client: PoolClient,
  farmId: number,
  blockId: number,
  entranceSide: "start" | "end",
  rows: BlockPlacementPlanRow[]
) {
  await ensureBlockInFarm(client, blockId, farmId);

  const bedsResult = await client.query<{ id: number; bed_length_m: string }>(
    `
      select bed.id, bed.bed_length_m
      from beds bed
      join blocks block on block.id = bed.block_id
      join fields field on field.id = block.field_id
      where bed.block_id = $1
        and field.farm_id = $2
        and bed.source <> 'road'
      order by bed.sequence_no nulls last, bed.id
    `,
    [blockId, farmId]
  );

  await client.query(
    `update blocks set bed_start_entrance_side = $3, updated_at = now() where id = $1 and field_id in (select id from fields where farm_id = $2)`,
    [blockId, farmId, entranceSide]
  );
  await client.query(
    `
      delete from planting_placements pp
      using beds bed, plantings planting
      where pp.bed_id = bed.id
        and pp.planting_id = planting.id
        and bed.block_id = $2
        and planting.farm_id = $1
        and pp.plan_source = 'auto_block_plan'
    `,
    [farmId, blockId]
  );
  await client.query(`delete from block_placement_gaps where farm_id = $1 and block_id = $2`, [farmId, blockId]);
  await client.query(`delete from block_placement_overflows where farm_id = $1 and block_id = $2`, [farmId, blockId]);

  const beds = bedsResult.rows.map((bed) => ({
    id: bed.id,
    lengthM: Math.max(0, Number(bed.bed_length_m))
  })).filter((bed) => Number.isFinite(bed.lengthM) && bed.lengthM > 0);
  let bedIndex = 0;
  let offsetM = 0;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const placementOrder = rowIndex + 1;
    let remainingLengthM = row.bedLengthUsedM;
    let remainingPlants = row.plantCount ?? null;
    const originalLengthM = row.bedLengthUsedM;

    if (row.kind === "planting" && row.plantingId != null) {
      await ensurePlantingInFarm(client, row.plantingId, farmId);
      await client.query(
        `
          update plantings
          set
            intended_block_id = $2,
            intended_bed_id = coalesce(intended_bed_id, $3),
            bed_length_used_m = $4,
            plant_count = $5,
            tray_count = $6,
            updated_at = now()
          where id = $1 and farm_id = $7
        `,
        [
          row.plantingId,
          blockId,
          beds[0]?.id ?? null,
          row.bedLengthUsedM,
          row.plantCount ?? null,
          row.trayCount ?? null,
          farmId
        ]
      );
    }

    while (remainingLengthM > 0.0001 && bedIndex < beds.length) {
      const bed = beds[bedIndex];
      const availableLengthM = Math.max(0, bed.lengthM - offsetM);
      if (availableLengthM <= 0.0001) {
        bedIndex += 1;
        offsetM = 0;
        continue;
      }

      const sectionLengthM = Math.min(remainingLengthM, availableLengthM);
      const sectionPlantCount = remainingPlants == null
        ? null
        : Math.max(1, Math.min(remainingPlants, Math.round((row.plantCount ?? remainingPlants) * (sectionLengthM / originalLengthM))));

      if (row.kind === "gap") {
        await client.query(
          `
            insert into block_placement_gaps (
              farm_id, block_id, bed_id, start_length_m, bed_length_used_m, placement_order, notes
            )
            values ($1, $2, $3, $4, $5, $6, 'Blank spreadsheet row')
          `,
          [farmId, blockId, bed.id, offsetM, sectionLengthM, placementOrder]
        );
      } else if (row.plantingId != null) {
        await client.query(
          `
            insert into planting_placements (
              planting_id, bed_id, plant_count, bed_length_used_m, placed_on, location_detail, notes,
              start_length_m, placement_order, plan_source
            )
            values ($1, $2, $3, $4, null, 'Block placement plan', 'Planned map placement', $5, $6, 'auto_block_plan')
          `,
          [row.plantingId, bed.id, sectionPlantCount, sectionLengthM, offsetM, placementOrder]
        );
      }

      remainingLengthM -= sectionLengthM;
      if (remainingPlants != null && sectionPlantCount != null) {
        remainingPlants = Math.max(0, remainingPlants - sectionPlantCount);
      }
      offsetM += sectionLengthM;
      if (offsetM >= bed.lengthM - 0.0001) {
        bedIndex += 1;
        offsetM = 0;
      }
    }

    if (remainingLengthM > 0.0001) {
      await client.query(
        `
          insert into block_placement_overflows (
            farm_id, block_id, planting_id, entry_type, bed_length_used_m, plant_count, tray_count, placement_order, notes
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, 'Overflow beyond mapped beds')
        `,
        [
          farmId,
          blockId,
          row.kind === "planting" ? row.plantingId ?? null : null,
          row.kind,
          remainingLengthM,
          remainingPlants,
          row.trayCount ?? null,
          placementOrder
        ]
      );
    }
  }
}

export async function reflowExistingBlockPlacementPlan(client: PoolClient, farmId: number, blockId: number) {
  if (!await blockHasAutoPlacementPlan(client, farmId, blockId)) {
    return;
  }
  const block = await client.query<{ entrance_side: "start" | "end" }>(
    `select bed_start_entrance_side as entrance_side from blocks block join fields field on field.id = block.field_id where block.id = $1 and field.farm_id = $2`,
    [blockId, farmId]
  );
  const rows = await loadExistingBlockPlacementPlanRows(client, farmId, blockId);
  await reflowBlockPlacementPlan(client, farmId, blockId, block.rows[0]?.entrance_side ?? "start", rows);
}

export async function moveBlockBedAssignmentsToOverflowForReplacement(
  client: PoolClient,
  farmId: number,
  blockId: number,
  zoneId?: number | null
) {
  await ensureBlockInFarm(client, blockId, farmId);

  const harvestUsage = await client.query<{ count: string }>(
    `
      select count(*) as count
      from harvest_records harvest
      join beds bed on bed.id = harvest.bed_id
      join plantings planting on planting.id = harvest.planting_id
      where planting.farm_id = $1
        and bed.block_id = $2
        and ($3::integer is null or bed.zone_id = $3)
    `,
    [farmId, blockId, zoneId ?? null]
  );
  if (Number(harvestUsage.rows[0]?.count ?? 0) > 0) {
    throw new Error("This block has harvest records tied to its beds. Move or remove those harvest records before replacing the beds.");
  }

  const rowsResult = await client.query<{
    kind: "planting" | "gap";
    planting_id: number | null;
    placement_order: string;
    bed_length_used_m: string;
    plant_count: string | null;
    tray_count: string | null;
  }>(
    `
      with target_beds as (
        select bed.id
        from beds bed
        where bed.block_id = $2
          and ($3::integer is null or bed.zone_id = $3)
      ),
      raw_rows as (
        select
          'planting'::text as kind,
          placement.planting_id,
          coalesce(
            placement.placement_order,
            100000 + row_number() over (order by placement.placed_on nulls last, placement.id)
          ) as placement_order,
          placement.bed_length_used_m,
          placement.plant_count,
          planting.tray_count
        from planting_placements placement
        join target_beds target on target.id = placement.bed_id
        join plantings planting on planting.id = placement.planting_id
        where planting.farm_id = $1

        union all

        select
          'planting'::text as kind,
          planting.id as planting_id,
          90000 + row_number() over (order by planting.id) as placement_order,
          planting.bed_length_used_m,
          planting.plant_count,
          planting.tray_count
        from plantings planting
        join target_beds target on target.id = planting.intended_bed_id
        where planting.farm_id = $1
          and planting.bed_length_used_m is not null
          and not exists (
            select 1
            from planting_placements placement
            join target_beds placement_target on placement_target.id = placement.bed_id
            where placement.planting_id = planting.id
          )

        union all

        select
          'gap'::text as kind,
          null::integer as planting_id,
          gap.placement_order,
          gap.bed_length_used_m,
          null::integer as plant_count,
          null::numeric as tray_count
        from block_placement_gaps gap
        join target_beds target on target.id = gap.bed_id
        where gap.farm_id = $1

        union all

        select
          overflow.entry_type as kind,
          overflow.planting_id,
          overflow.placement_order,
          overflow.bed_length_used_m,
          overflow.plant_count,
          overflow.tray_count
        from block_placement_overflows overflow
        where overflow.farm_id = $1
          and overflow.block_id = $2
      )
      select
        kind,
        planting_id,
        placement_order,
        sum(bed_length_used_m) as bed_length_used_m,
        sum(plant_count) as plant_count,
        max(tray_count) as tray_count
      from raw_rows
      where bed_length_used_m is not null
        and bed_length_used_m > 0
      group by kind, planting_id, placement_order
      order by placement_order, planting_id nulls last
    `,
    [farmId, blockId, zoneId ?? null]
  );

  await client.query(`delete from block_placement_overflows where farm_id = $1 and block_id = $2`, [farmId, blockId]);
  await client.query(
    `
      with target_beds as (
        select bed.id
        from beds bed
        join blocks block on block.id = bed.block_id
        join fields field on field.id = block.field_id
        where bed.block_id = $2
          and field.farm_id = $1
          and ($3::integer is null or bed.zone_id = $3)
      )
      delete from block_placement_gaps gap
      using target_beds target
      where gap.bed_id = target.id
        and gap.farm_id = $1
    `,
    [farmId, blockId, zoneId ?? null]
  );
  await client.query(
    `
      with target_beds as (
        select bed.id
        from beds bed
        join blocks block on block.id = bed.block_id
        join fields field on field.id = block.field_id
        where bed.block_id = $2
          and field.farm_id = $1
          and ($3::integer is null or bed.zone_id = $3)
      )
      delete from planting_placements placement
      using target_beds target, plantings planting
      where placement.bed_id = target.id
        and placement.planting_id = planting.id
        and planting.farm_id = $1
    `,
    [farmId, blockId, zoneId ?? null]
  );
  await client.query(
    `
      with target_beds as (
        select bed.id
        from beds bed
        join blocks block on block.id = bed.block_id
        join fields field on field.id = block.field_id
        where bed.block_id = $2
          and field.farm_id = $1
          and ($3::integer is null or bed.zone_id = $3)
      )
      update plantings planting
      set intended_bed_id = null, updated_at = now()
      from target_beds target
      where planting.intended_bed_id = target.id
        and planting.farm_id = $1
    `,
    [farmId, blockId, zoneId ?? null]
  );

  for (const row of rowsResult.rows) {
    const bedLengthUsedM = Number(row.bed_length_used_m);
    const placementOrder = Number(row.placement_order);
    const plantingId = row.kind === "planting" ? row.planting_id : null;
    if (!Number.isFinite(bedLengthUsedM) || bedLengthUsedM <= 0 || !Number.isFinite(placementOrder)) {
      continue;
    }
    if (row.kind === "planting" && plantingId == null) {
      continue;
    }
    await client.query(
      `
        insert into block_placement_overflows (
          farm_id, block_id, planting_id, entry_type, bed_length_used_m, plant_count, tray_count, placement_order, notes
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, 'Moved to overflow before replacing block beds')
      `,
      [
        farmId,
        blockId,
        plantingId,
        row.kind,
        bedLengthUsedM,
        row.plant_count == null ? null : Number(row.plant_count),
        row.tray_count == null ? null : Number(row.tray_count),
        placementOrder
      ]
    );
  }
}

export async function appendPlantingToBlockPlacementPlan(client: PoolClient, farmId: number, blockId: number, plantingId: number) {
  if (!await blockHasPlantableBeds(client, blockId, farmId)) {
    return;
  }
  const existingRows = await loadExistingBlockPlacementPlanRows(client, farmId, blockId);
  if (existingRows.some((row) => row.kind === "planting" && row.plantingId === plantingId)) {
    return;
  }
  const planting = await client.query<{
    plant_count: number | null;
    tray_count: number | null;
    bed_length_used_m: string | null;
  }>(
    `select plant_count, tray_count, bed_length_used_m from plantings where id = $1 and farm_id = $2`,
    [plantingId, farmId]
  );
  const row = planting.rows[0];
  const bedLengthUsedM = row?.bed_length_used_m == null ? null : Number(row.bed_length_used_m);
  if (row == null || bedLengthUsedM == null || !Number.isFinite(bedLengthUsedM) || bedLengthUsedM <= 0) {
    return;
  }
  const block = await client.query<{ entrance_side: "start" | "end" }>(
    `select bed_start_entrance_side as entrance_side from blocks block join fields field on field.id = block.field_id where block.id = $1 and field.farm_id = $2`,
    [blockId, farmId]
  );
  await reflowBlockPlacementPlan(client, farmId, blockId, block.rows[0]?.entrance_side ?? "start", [
    ...existingRows,
    {
      kind: "planting",
      plantingId,
      bedLengthUsedM,
      plantCount: row.plant_count,
      trayCount: row.tray_count
    }
  ]);
}

export async function clearIntendedBedsForField(client: PoolClient, fieldId: number, farmId: number) {
  await client.query(
    `
      update plantings
      set intended_bed_id = null, updated_at = now()
      where intended_bed_id in (
        select bed.id
        from beds bed
        join blocks block on block.id = bed.block_id
        join fields field on field.id = block.field_id
        where block.field_id = $1
          and field.farm_id = $2
      )
        and farm_id = $2
    `,
    [fieldId, farmId]
  );
}

export async function clearIntendedBedsForBlock(client: PoolClient, blockId: number, farmId: number) {
  await client.query(
    `
      update plantings
      set intended_bed_id = null, updated_at = now()
      where intended_bed_id in (
        select bed.id
        from beds bed
        join blocks block on block.id = bed.block_id
        join fields field on field.id = block.field_id
        where bed.block_id = $1
          and field.farm_id = $2
      )
        and farm_id = $2
    `,
    [blockId, farmId]
  );
}

// Field/block/zone geometry helpers write both old bounding-box columns and new
// PostGIS geometry columns so older prototype UI code and newer map code agree.
export async function upsertFieldGeometry(
  client: PoolClient,
  options: {
    id?: number;
    farmId?: number;
    name: string;
    notes?: string | null;
    coordinates: Array<{ lat: number; lng: number }>;
  }
) {
  const coordinates = normalizeCoordinates(options.coordinates);
  const wkt = polygonWkt(coordinates);
  const box = boundingBox(coordinates);
  const validity = await client.query<{ is_valid: boolean }>(
    `select ST_IsValid(ST_GeomFromText($1, 4326)) as is_valid`,
    [wkt]
  );

  if (!validity.rows[0]?.is_valid) {
    throw new Error("Polygon is not valid");
  }

  if (options.id == null || options.farmId == null) {
    const result = await client.query<{ id: number }>(
      `
        insert into fields (farm_id, name, notes, x, y, width, height, geom, boundary, centroid, area_sqm)
        values (
          $1, $2, $3, $4, $5, $6, $7,
          ST_Transform(ST_GeomFromText($8, 4326), 3857),
          ST_GeomFromText($8, 4326),
          ST_Centroid(ST_GeomFromText($8, 4326)),
          ST_Area(ST_GeomFromText($8, 4326)::geography)
        )
        returning id
      `,
      [options.farmId, options.name, options.notes ?? null, box.x, box.y, box.width, box.height, wkt]
    );
    console.info("Created field geometry", { fieldId: result.rows[0].id, pointCount: coordinates.length });
    return result.rows[0].id;
  }

  const updateResult = await client.query(
    `
      update fields
      set
        name = $2,
        notes = $3,
        x = $4,
        y = $5,
        width = $6,
        height = $7,
        geom = ST_Transform(ST_GeomFromText($8, 4326), 3857),
        boundary = ST_GeomFromText($8, 4326),
        centroid = ST_Centroid(ST_GeomFromText($8, 4326)),
        area_sqm = ST_Area(ST_GeomFromText($8, 4326)::geography),
        updated_at = now()
      where id = $1 and farm_id = $9
    `,
    [options.id, options.name, options.notes ?? null, box.x, box.y, box.width, box.height, wkt, options.farmId]
  );
  if (updateResult.rowCount !== 1) {
    throw new Error("Field not found in this farm");
  }
  console.info("Updated field geometry", { fieldId: options.id, pointCount: coordinates.length });
  return options.id;
}

async function validateBlockBoundary(
  client: PoolClient,
  fieldId: number,
  farmId: number,
  wkt: string
) {
  const result = await client.query<{ outside_sqm: number; is_valid: boolean }>(
    `
      select
        coalesce(ST_Area(ST_Difference(ST_GeomFromText($2, 4326), boundary)::geography), 0) as outside_sqm,
        ST_IsValid(ST_GeomFromText($2, 4326)) as is_valid
      from fields
      where id = $1 and farm_id = $3
    `,
    [fieldId, wkt, farmId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Parent field not found");
  }

  if (!row.is_valid) {
    throw new Error("Polygon is not valid");
  }

  if (Number(row.outside_sqm) > 0.5) {
    return `Warning: ${Math.round(Number(row.outside_sqm))} sq m of this block falls outside its field boundary.`;
  }

  return null;
}

export async function upsertBlockGeometry(
  client: PoolClient,
  options: {
    id?: number;
    fieldId: number;
    farmId: number;
    name: string;
    notes?: string | null;
    coordinates: Array<{ lat: number; lng: number }>;
  }
) {
  const coordinates = normalizeCoordinates(options.coordinates);
  const wkt = polygonWkt(coordinates);
  const box = boundingBox(coordinates);
  const warning = await validateBlockBoundary(client, options.fieldId, options.farmId, wkt);

  if (options.id == null) {
    const result = await client.query<{ id: number }>(
      `
        insert into blocks (field_id, name, notes, x, y, width, height, geom, boundary, centroid, area_sqm)
        values (
          $1, $2, $3, $4, $5, $6, $7,
          ST_Transform(ST_GeomFromText($8, 4326), 3857),
          ST_GeomFromText($8, 4326),
          ST_Centroid(ST_GeomFromText($8, 4326)),
          ST_Area(ST_GeomFromText($8, 4326)::geography)
        )
        returning id
      `,
      [options.fieldId, options.name, options.notes ?? null, box.x, box.y, box.width, box.height, wkt]
    );
    return { id: result.rows[0].id, warning };
  }

  const updateResult = await client.query(
    `
      update blocks
      set
        field_id = $2,
        name = $3,
        notes = $4,
        x = $5,
        y = $6,
        width = $7,
        height = $8,
        geom = ST_Transform(ST_GeomFromText($9, 4326), 3857),
        boundary = ST_GeomFromText($9, 4326),
        centroid = ST_Centroid(ST_GeomFromText($9, 4326)),
        area_sqm = ST_Area(ST_GeomFromText($9, 4326)::geography),
        updated_at = now()
      where id = $1
        and field_id in (select id from fields where farm_id = $10)
    `,
    [options.id, options.fieldId, options.name, options.notes ?? null, box.x, box.y, box.width, box.height, wkt, options.farmId]
  );
  if (updateResult.rowCount !== 1) {
    throw new Error("Block not found in this farm");
  }
  return { id: options.id, warning };
}

export async function ensureDefaultBlockArea(
  client: PoolClient,
  options: {
    blockId: number;
    farmId: number;
    blockName: string;
    currentState: ZoneActualStateInput;
    coordinates: Array<{ lat: number; lng: number }>;
  }
) {
  const existing = await client.query<{ id: number }>(
    `
      select zone.id
      from block_zones zone
      join blocks block on block.id = zone.block_id
      join fields field on field.id = block.field_id
      where zone.block_id = $1 and field.farm_id = $2
      limit 1
    `,
    [options.blockId, options.farmId]
  );

  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  const area = await upsertBlockZoneGeometry(client, {
    blockId: options.blockId,
    farmId: options.farmId,
    name: `${options.blockName} area`,
    plannedUse: null,
    actualState: options.currentState,
    notes: null,
    coordinates: options.coordinates
  });

  return area.id;
}

export async function getBedContext(client: PoolClient, bedId: number, farmId: number) {
  const result = await client.query<{
    field_id: number;
    block_id: number;
    zone_id: number | null;
    bed_id: number;
    bed_name: string;
  }>(
    `
      select
        field.id as field_id,
        block.id as block_id,
        bed.zone_id,
        bed.id as bed_id,
        bed.name as bed_name
      from beds bed
      join blocks block on block.id = bed.block_id
      join fields field on field.id = block.field_id
      where bed.id = $1 and field.farm_id = $2
    `,
    [bedId, farmId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Bed not found");
  }

  return row;
}

// Farm events are the dated history layer: what happened, where, and what it
// changed. The map time slider can use these records to reconstruct state.
export async function recordFarmEvent(
  client: PoolClient,
  options: {
    farmId: number;
    eventDate: string;
    eventType: string;
    title: string;
    notes?: string | null;
    metadata?: Record<string, unknown>;
    fieldId?: number | null;
    blockId?: number | null;
    zoneId?: number | null;
    bedId?: number | null;
    plantingId?: number | null;
    placementId?: number | null;
    taskId?: number | null;
    coordinates?: Array<{ lat: number; lng: number }> | null;
  }
) {
  const normalized = options.coordinates && options.coordinates.length >= 3 ? normalizeCoordinates(options.coordinates) : null;
  const wkt = normalized ? polygonWkt(normalized) : null;

  await client.query(
    `
      insert into farm_events (
        farm_id, event_date, event_type, title, notes, metadata,
        field_id, block_id, zone_id, bed_id, planting_id, placement_id, task_id,
        boundary, centroid, area_sqm
      )
      values (
        $1, $2, $3, $4, $5, $6::jsonb,
        $7, $8, $9, $10, $11, $12, $13,
        case when $14::text is null then null else ST_GeomFromText($14, 4326) end,
        case when $14::text is null then null else ST_Centroid(ST_GeomFromText($14, 4326)) end,
        case when $14::text is null then null else ST_Area(ST_GeomFromText($14, 4326)::geography) end
      )
    `,
    [
      options.farmId,
      options.eventDate,
      options.eventType,
      options.title,
      options.notes ?? null,
      JSON.stringify(options.metadata ?? {}),
      options.fieldId ?? null,
      options.blockId ?? null,
      options.zoneId ?? null,
      options.bedId ?? null,
      options.plantingId ?? null,
      options.placementId ?? null,
      options.taskId ?? null,
      wkt
    ]
  );
}


async function validateBlockZoneBoundary(
  client: PoolClient,
  blockId: number,
  farmId: number,
  wkt: string
) {
  const result = await client.query<{ outside_sqm: number; is_valid: boolean }>(
    `
      select
        coalesce(ST_Area(ST_Difference(ST_GeomFromText($2, 4326), block.boundary)::geography), 0) as outside_sqm,
        ST_IsValid(ST_GeomFromText($2, 4326)) as is_valid
      from blocks block
      join fields field on field.id = block.field_id
      where block.id = $1 and field.farm_id = $3
    `,
    [blockId, wkt, farmId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Parent block not found");
  }

  if (!row.is_valid) {
    throw new Error("Polygon is not valid");
  }

  if (Number(row.outside_sqm) > 0.5) {
    return `Warning: ${Math.round(Number(row.outside_sqm))} sq m of this area falls outside its block boundary.`;
  }

  return null;
}

export async function upsertBlockZoneGeometry(
  client: PoolClient,
  options: {
    id?: number;
    blockId: number;
    farmId: number;
    name: string;
    plannedUse?: "beds" | "cover_crop" | null;
    actualState: ZoneActualStateInput;
    coverCropNameId?: number | null;
    coverCropName?: string | null;
    plannedCoverCropSeedDate?: string | null;
    plannedCoverCropTerminateDate?: string | null;
    actualCoverCropSeedDate?: string | null;
    actualCoverCropTerminateDate?: string | null;
    notes?: string | null;
    coordinates: Array<{ lat: number; lng: number }>;
  }
) {
  const coordinates = normalizeCoordinates(options.coordinates);
  const wkt = polygonWkt(coordinates);
  const box = boundingBox(coordinates);
  const warning = await validateBlockZoneBoundary(client, options.blockId, options.farmId, wkt);
  const coverCropNameId = options.plannedUse === "cover_crop"
    ? await upsertCoverCropName(client, {
        farmId: options.farmId,
        coverCropNameId: options.coverCropNameId,
        coverCropName: options.coverCropName
      })
    : null;

  if (options.plannedUse === "cover_crop" && coverCropNameId == null) {
    throw new Error("Select or add a cover crop name for cover crop areas");
  }

  if (options.id == null) {
    const result = await client.query<{ id: number }>(
      `
        insert into block_zones (
          block_id, cover_crop_name_id, name, planned_use, actual_state, notes,
          planned_cover_crop_seed_date, planned_cover_crop_terminate_date,
          actual_cover_crop_seed_date, actual_cover_crop_terminate_date,
          x, y, width, height, geom, boundary, centroid, area_sqm
        )
        values (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10,
          $11, $12, $13, $14,
          ST_Transform(ST_GeomFromText($15, 4326), 3857),
          ST_GeomFromText($15, 4326),
          ST_Centroid(ST_GeomFromText($15, 4326)),
          ST_Area(ST_GeomFromText($15, 4326)::geography)
        )
        returning id
      `,
      [
        options.blockId,
        coverCropNameId,
        options.name,
        options.plannedUse ?? null,
        options.actualState,
        options.notes ?? null,
        options.plannedUse === "cover_crop" ? options.plannedCoverCropSeedDate ?? null : null,
        options.plannedUse === "cover_crop" ? options.plannedCoverCropTerminateDate ?? null : null,
        options.plannedUse === "cover_crop" ? options.actualCoverCropSeedDate ?? null : null,
        options.plannedUse === "cover_crop" ? options.actualCoverCropTerminateDate ?? null : null,
        box.x,
        box.y,
        box.width,
        box.height,
        wkt
      ]
    );
    return { id: result.rows[0].id, warning };
  }

  const updateResult = await client.query(
    `
      update block_zones
      set
        block_id = $2,
        cover_crop_name_id = $3,
        name = $4,
        planned_use = $5,
        actual_state = $6,
        notes = $7,
        planned_cover_crop_seed_date = $8,
        planned_cover_crop_terminate_date = $9,
        actual_cover_crop_seed_date = $10,
        actual_cover_crop_terminate_date = $11,
        x = $12,
        y = $13,
        width = $14,
        height = $15,
        geom = ST_Transform(ST_GeomFromText($16, 4326), 3857),
        boundary = ST_GeomFromText($16, 4326),
        centroid = ST_Centroid(ST_GeomFromText($16, 4326)),
        area_sqm = ST_Area(ST_GeomFromText($16, 4326)::geography),
        updated_at = now()
      where id = $1
        and block_id in (
          select block.id
          from blocks block
          join fields field on field.id = block.field_id
          where field.farm_id = $17
        )
    `,
    [
      options.id,
      options.blockId,
      coverCropNameId,
      options.name,
      options.plannedUse ?? null,
      options.actualState,
      options.notes ?? null,
      options.plannedUse === "cover_crop" ? options.plannedCoverCropSeedDate ?? null : null,
      options.plannedUse === "cover_crop" ? options.plannedCoverCropTerminateDate ?? null : null,
      options.plannedUse === "cover_crop" ? options.actualCoverCropSeedDate ?? null : null,
      options.plannedUse === "cover_crop" ? options.actualCoverCropTerminateDate ?? null : null,
      box.x,
      box.y,
      box.width,
      box.height,
      wkt,
      options.farmId
    ]
  );
  if (updateResult.rowCount !== 1) {
    throw new Error("Block zone not found in this farm");
  }

  return { id: options.id, warning };
}

// Splits one block polygon into a target zone and one or more remainder zones.
export async function splitBlockBoundaryIntoZoneCoordinates(
  client: PoolClient,
  options: {
    blockId: number;
    farmId: number;
    lineCoordinates?: Array<{ lat: number; lng: number }>;
    splitLines?: Array<Array<{ lat: number; lng: number }>>;
    firstBedSidePoint?: { lat: number; lng: number } | null;
    useLargerSide: boolean;
  }
) {
  const splitLines = options.splitLines ?? (options.lineCoordinates ? [options.lineCoordinates] : []);
  if (splitLines.length < 1 || splitLines.length > 2 || splitLines.some((line) => line.length !== 2)) {
    throw new Error("Add one or two split lines first.");
  }

  const lineWkts = splitLines.map((line) => lineStringWkt3857(extendStraightLine(line.map((point) => projectWgs84To3857(point.lat, point.lng)))));
  const anchorPoint = options.firstBedSidePoint ? projectWgs84To3857(options.firstBedSidePoint.lat, options.firstBedSidePoint.lng) : null;
  const targetOrder = splitLines.length === 2
    ? "where side_a * side_b <= 0 order by area_sqm desc, piece_no limit 1"
    : anchorPoint
      ? "order by ST_Covers(geom, anchor_geom) desc, area_sqm desc, piece_no limit 1"
      : `order by area_sqm ${options.useLargerSide ? "desc" : "asc"}, piece_no limit 1`;

  const result = await client.query<{ role: "target" | "remainder"; piece_no: string; geojson: string | null }>(
    `
      with
      block_geom as (
        select ST_Transform(block.boundary, 3857) as geom
        from blocks block
        join fields field on field.id = block.field_id
        where block.id = $1 and field.farm_id = $5
      ),
      split_line_a as (
        select ST_GeomFromText($2, 3857) as geom
      ),
      split_line_b as (
        select case when $3::text is null then null else ST_GeomFromText($3, 3857) end as geom
      ),
      split_line as (
        select case
          when split_line_b.geom is null then split_line_a.geom
          else ST_UnaryUnion(ST_Collect(split_line_a.geom, split_line_b.geom))
        end as geom
        from split_line_a, split_line_b
      ),
      anchor_point as (
        select case when $4::text is null then null else ST_GeomFromText($4, 3857) end as geom
      ),
      pieces as (
        select
          row_number() over (order by ST_Area(piece.geom) asc, ST_YMin(piece.geom), ST_XMin(piece.geom)) as piece_no,
          piece.geom,
          ST_Area(piece.geom) as area_sqm,
          anchor_point.geom as anchor_geom,
          (
            (ST_X(ST_EndPoint(split_line_a.geom)) - ST_X(ST_StartPoint(split_line_a.geom)))
            * (ST_Y(ST_PointOnSurface(piece.geom)) - ST_Y(ST_StartPoint(split_line_a.geom)))
            - (ST_Y(ST_EndPoint(split_line_a.geom)) - ST_Y(ST_StartPoint(split_line_a.geom)))
            * (ST_X(ST_PointOnSurface(piece.geom)) - ST_X(ST_StartPoint(split_line_a.geom)))
          ) as side_a,
          case when split_line_b.geom is null then null else (
            (ST_X(ST_EndPoint(split_line_b.geom)) - ST_X(ST_StartPoint(split_line_b.geom)))
            * (ST_Y(ST_PointOnSurface(piece.geom)) - ST_Y(ST_StartPoint(split_line_b.geom)))
            - (ST_Y(ST_EndPoint(split_line_b.geom)) - ST_Y(ST_StartPoint(split_line_b.geom)))
            * (ST_X(ST_PointOnSurface(piece.geom)) - ST_X(ST_StartPoint(split_line_b.geom)))
          ) end as side_b
        from (
          select (ST_Dump(ST_CollectionExtract(ST_Split(block_geom.geom, split_line.geom), 3))).geom
          from block_geom, split_line
        ) as piece,
        split_line_a,
        split_line_b,
        anchor_point
      ),
      target_piece as (
        select piece_no, geom
        from pieces
        ${targetOrder}
      )
      select
        'target' as role,
        piece_no::text,
        ST_AsGeoJSON(ST_Transform(geom, 4326)) as geojson
      from target_piece
      union all
      select
        'remainder' as role,
        piece_no::text,
        ST_AsGeoJSON(ST_Transform(geom, 4326)) as geojson
      from pieces
      where piece_no <> (select piece_no from target_piece)
      order by role desc, piece_no
    `,
    [
      options.blockId,
      lineWkts[0],
      lineWkts[1] ?? null,
      anchorPoint ? `POINT(${anchorPoint.x} ${anchorPoint.y})` : null,
      options.farmId
    ]
  );

  const targetRow = result.rows.find((row) => row.role === "target");
  const remainderRows = result.rows.filter((row) => row.role === "remainder");
  if (!targetRow?.geojson || remainderRows.length === 0 || remainderRows.some((row) => !row.geojson)) {
    throw new Error(splitLines.length === 2
      ? "The split lines must both cut across the selected block."
      : "The split line must cut across the selected block.");
  }

  const targetFeature = JSON.parse(targetRow.geojson) as { type?: string; coordinates?: number[][][] };
  const remainderFeatures = remainderRows.map((row) => JSON.parse(row.geojson ?? "") as { type?: string; coordinates?: number[][][] });

  if (targetFeature.type !== "Polygon" || remainderFeatures.some((feature) => feature.type !== "Polygon")) {
    throw new Error("The split produced an unsupported shape. Try a simpler 2-point line.");
  }

  const toCoordinates = (coordinates: number[][][]) => coordinates[0].slice(0, -1).map(([lng, lat]) => ({ lat, lng }));

  return {
    targetCoordinates: toCoordinates(targetFeature.coordinates ?? []),
    remainderCoordinates: remainderFeatures.map((feature) => toCoordinates(feature.coordinates ?? []))
  };
}

async function recalculatePlantingsForTaskFlow(
  client: PoolClient,
  taskFlowTemplateId: number
) {
  const templateResult = await client.query<{ farm_id: number; crop_id: number | null; is_default: boolean }>(
    `select farm_id, crop_id, is_default from task_flow_templates where id = $1`,
    [taskFlowTemplateId]
  );
  const template = templateResult.rows[0];
  if (!template) {
    return;
  }

  const plantings = await client.query<{ id: number }>(
    template.is_default
      ? `
          select id
          from plantings
          where farm_id = $2
            and crop_id = coalesce($3, crop_id)
            and (task_flow_template_id = $1 or task_flow_template_id is null)
          order by id
          limit $4
        `
      : `
          select id
          from plantings
          where farm_id = $2
            and task_flow_template_id = $1
          order by id
          limit $4
        `,
    [taskFlowTemplateId, template.farm_id, template.crop_id, MAX_SYNC_TASK_FLOW_RECALCULATIONS + 1]
  );
  if (plantings.rows.length > MAX_SYNC_TASK_FLOW_RECALCULATIONS) {
    throw new Error(`This task flow affects more than ${MAX_SYNC_TASK_FLOW_RECALCULATIONS} plantings. To protect the server, narrow the flow to a crop or update plantings in smaller groups before saving.`);
  }

  for (const planting of plantings.rows) {
    await recalculatePlantingTasks(client, planting.id);
  }
}

// Saving a task flow updates its graph in one transaction, then refreshes
// affected plantings so their generated tasks match the edited flow.
export async function saveTaskFlowTemplate(
  client: PoolClient,
  options: {
    id?: number;
    farmId?: number;
    cropId?: number | null;
    name: string;
    notes?: string | null;
    isDefault: boolean;
    nodes: Array<{
      nodeKey: string;
      taskType: TaskType;
      label: string;
      anchor: string;
      offsetDays: number;
      iconColor: string;
      iconSecondaryColor: string;
      tractorModel?: string | null;
      tractorProfileId?: number | null;
      x: number;
      y: number;
      notes?: string | null;
    }>;
    edges: Array<{
      fromNodeKey: string;
      toNodeKey: string;
      delayDays: number;
    }>;
  }
) {
  validateTaskFlowGraph(options.nodes, options.edges);
  for (const node of options.nodes) {
    if (!isCurrentTaskType(node.taskType)) {
      throw new Error(isLegacyTaskType(node.taskType)
        ? `The task "${node.label}" uses the old category "${node.taskType}". Change it to one of the current task categories before saving.`
        : `The task "${node.label}" uses an unknown category "${node.taskType}". Change it to one of the current task categories before saving.`);
    }
    if (node.anchor !== "planned_sow" && !node.anchor.startsWith("after:")) {
      throw new Error(`The task "${node.label}" uses an old scheduling anchor. Reconnect it with arrows or set it back to the seeding date before saving.`);
    }
  }
  const scheduleProblem = taskFlowScheduleProblem(options.nodes, options.edges);
  if (scheduleProblem) {
    throw new Error(scheduleProblem);
  }

  let flowTemplateId = options.id;
  if (flowTemplateId == null) {
    if (options.farmId == null) {
      throw new Error("Farm id is required to create a task flow");
    }
    const result = await client.query<{ id: number }>(
      `
        insert into task_flow_templates (farm_id, crop_id, name, notes, is_default)
        values ($1, $2, $3, $4, $5)
        returning id
      `,
      [options.farmId, options.cropId ?? null, options.name, options.notes ?? null, options.isDefault]
    );
    flowTemplateId = result.rows[0].id;
  } else {
    const updateResult = await client.query(
      `
        update task_flow_templates
        set
          crop_id = $2,
          name = $3,
          notes = $4,
          is_default = $5,
          updated_at = now()
        where id = $1 and ($6::integer is null or farm_id = $6)
      `,
      [flowTemplateId, options.cropId ?? null, options.name, options.notes ?? null, options.isDefault, options.farmId ?? null]
    );
    if (updateResult.rowCount !== 1) {
      throw new Error("Task flow template not found in this farm");
    }
  }

  if (options.isDefault) {
    await client.query(
      `
        update task_flow_templates
        set is_default = false, updated_at = now()
        where farm_id = (select farm_id from task_flow_templates where id = $1)
          and coalesce(crop_id, 0) = coalesce($2, 0)
          and id <> $1
      `,
      [flowTemplateId, options.cropId ?? null]
    );
  }

  if (flowTemplateId == null) {
    throw new Error("Task flow template not found");
  }

  const templateFarm = await client.query<{ farm_id: number }>(
    `select farm_id from task_flow_templates where id = $1`,
    [flowTemplateId]
  );
  const templateFarmId = templateFarm.rows[0]?.farm_id;
  if (templateFarmId == null) {
    throw new Error("Task flow template not found");
  }
  for (const node of options.nodes) {
    if (node.tractorProfileId != null) {
      await ensureTractorProfileInFarm(client, node.tractorProfileId, templateFarmId);
    }
  }

  const nextNodeKeys = options.nodes.map((node) => node.nodeKey);
  await client.query(
    `
      delete from task_flow_nodes
      where flow_template_id = $1
        and not (node_key = any($2::text[]))
    `,
    [flowTemplateId, nextNodeKeys]
  );

  const nodeIdsByKey = new Map<string, number>();
  const incomingNodeKeysByKey = new Map(options.nodes.map((node) => [node.nodeKey, [] as string[]]));
  for (const edge of options.edges) {
    incomingNodeKeysByKey.get(edge.toNodeKey)?.push(edge.fromNodeKey);
  }
  for (const node of options.nodes) {
    const incomingNodeKeys = incomingNodeKeysByKey.get(node.nodeKey) ?? [];
    const anchor = incomingNodeKeys.length > 0 ? `after:${incomingNodeKeys.join(",")}` : "planned_sow";
    const result = await client.query<{ id: number }>(
      `
        insert into task_flow_nodes (
          flow_template_id,
          node_key,
          task_type,
          label,
          anchor,
          offset_days,
          icon_color,
          icon_secondary_color,
          tractor_model,
          tractor_profile_id,
          x_pos,
          y_pos,
          notes
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        on conflict (flow_template_id, node_key) do update
        set
          task_type = excluded.task_type,
          label = excluded.label,
          anchor = excluded.anchor,
          offset_days = excluded.offset_days,
          icon_color = excluded.icon_color,
          icon_secondary_color = excluded.icon_secondary_color,
          tractor_model = excluded.tractor_model,
          tractor_profile_id = excluded.tractor_profile_id,
          x_pos = excluded.x_pos,
          y_pos = excluded.y_pos,
          notes = excluded.notes,
          updated_at = now()
        returning id
      `,
      [
        flowTemplateId,
        node.nodeKey,
        node.taskType,
        node.label,
        anchor,
        0,
        node.iconColor,
        node.iconSecondaryColor,
        node.tractorModel ?? null,
        node.tractorProfileId ?? null,
        node.x,
        node.y,
        node.notes ?? null
      ]
    );
    nodeIdsByKey.set(node.nodeKey, result.rows[0].id);
  }

  await client.query(`delete from task_flow_edges where flow_template_id = $1`, [flowTemplateId]);
  for (const edge of options.edges) {
    await client.query(
      `
        insert into task_flow_edges (
          flow_template_id,
          from_node_id,
          to_node_id,
          delay_days
        )
        values ($1, $2, $3, $4)
      `,
      [
        flowTemplateId,
        nodeIdsByKey.get(edge.fromNodeKey),
        nodeIdsByKey.get(edge.toNodeKey),
        edge.delayDays
      ]
    );
  }

  await recalculatePlantingsForTaskFlow(client, flowTemplateId);
  return flowTemplateId;
}

// Basic process/database check used by humans or hosting platforms.
app.get("/health", asyncHandler(async (_req, res) => {
  await pool.query("select 1");
  res.json({ ok: true });
}));

// Optional offline tile status and tile serving. Normal online basemaps do not
// need these routes, but the UI can fall back to them when cached imagery exists.
app.get("/api/offline-imagery/status", requireRole("worker"), asyncHandler(async (_req, res) => {
  const manifest = await readOfflineImageryManifest();
  res.json(manifest ?? defaultOfflineImageryStatus());
}));

app.get("/api/offline-imagery/tiles/:z/:x/:y", requireRole("worker"), asyncHandler(async (req, res) => {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);

  if (![z, x, y].every(Number.isInteger)) {
    res.status(400).json({ error: "Tile coordinates must be integers" });
    return;
  }

  const tile = await findBestCachedTile(z, x, y);
  if (!tile) {
    res.status(404).end();
    return;
  }

  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  if (tile.zoomDelta === 0) {
    res.type(tile.contentType);
    res.sendFile(tile.filePath);
    return;
  }

  const imageBuffer = await fs.readFile(tile.filePath);
  const base64 = imageBuffer.toString("base64");
  const scale = 2 ** tile.zoomDelta;
  const offsetX = (x - (tile.sourceX * scale)) * 256;
  const offsetY = (y - (tile.sourceY * scale)) * 256;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <image
        href="data:${tile.contentType};base64,${base64}"
        x="${-offsetX}"
        y="${-offsetY}"
        width="${256 * scale}"
        height="${256 * scale}"
        preserveAspectRatio="none"
      />
    </svg>
  `.trim();

  res.type("image/svg+xml");
  res.send(svg);
}));

// Main dashboard payload. Most frontend screens are hydrated from this one route
// instead of making many smaller requests after every save/reload.
registerUsageEventRoutes(app);
registerAuthRoutes(app);
registerAdminRoutes(app);
registerUndoRoutes(app);
registerAccountManagementRoutes(app);

registerFarmRoutes(app, {
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
});

// Last-resort error handler. Route code throws normal Errors; this turns them
// into JSON so the frontend can show a useful message instead of silently failing.
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: error.errors.map((e) => ({ path: e.path, message: e.message })) });
    return;
  }
  if (error instanceof Error && error.message === "Parent field not found") {
    res.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof Error && error.message === "Polygon is not valid") {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof Error && (error.message === "Block not found" || error.message === "Bed preset not found")) {
    res.status(404).json({ error: error.message });
    return;
  }
  if (
    error instanceof Error &&
    (
      error.message === "Feedback context is too large" ||
      error.message === "Feedback activity details are too large" ||
      error.message === "Usage event details are too large"
    )
  ) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof Error && (error.message === "Parent block not found" || error.message === "Block zone not found")) {
    res.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof Error && error.message === "Planting not found") {
    res.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof Error && error.message === "Task not found") {
    res.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof Error && error.message === "Task flow template not found") {
    res.status(404).json({ error: error.message });
    return;
  }
  if (
    error instanceof Error &&
    (
      error.message === "Field not found in this farm" ||
      error.message === "Block not found in this farm" ||
      error.message === "Bed not found in this farm" ||
      error.message === "Block zone not found in this farm" ||
      error.message === "Cover crop name not found in this farm" ||
      error.message === "Seed item not found in this farm" ||
      error.message === "Bed preset not found in this farm" ||
      error.message === "Tractor not found in this farm" ||
      error.message === "Planting not found in this farm" ||
      error.message === "Task not found in this farm" ||
      error.message === "Task flow template not found in this farm"
    )
  ) {
    res.status(404).json({ error: error.message });
    return;
  }
  if (
    error instanceof Error &&
    (
      error.message === "Planner access required" ||
      error.message === "Planner access required for planting adjustments"
    )
  ) {
    res.status(403).json({ error: error.message });
    return;
  }
  if (error instanceof Error && error.message === "Beds do not fit inside the selected block with the chosen preset and count") {
    res.status(400).json({ error: error.message });
    return;
  }
  if (
    error instanceof Error &&
    (
      error.message === "Straight bed line needs exactly 2 points" ||
      error.message === "Curved bed line needs between 3 and 12 points" ||
      error.message === "Beds do not fit inside the selected block from the chosen line" ||
      error.message === "Beds do not fit inside the selected block from the chosen line, or they overlap current beds" ||
      error.message === "Planted dates cannot be in the future" ||
      error.message === "Beds can only be generated inside bed areas" ||
      error.message === "Selected bed area does not belong to this block" ||
      error.message === "This bed has planned plantings, placements, or harvest records. Move or remove those records before deleting the bed." ||
      error.message === "This block has harvest records tied to its beds. Move or remove those harvest records before replacing the beds." ||
      error.message === "Select or add a cover crop name for cover crop areas" ||
      error.message === "Task flow node keys must be unique" ||
      error.message.startsWith("Task flow node ") ||
      error.message === "Task flow edge references a missing node" ||
      error.message === "Task flow edge cannot point to the same node" ||
      error.message === "Task flow edges must be unique" ||
      error.message === "Task flow dependencies cannot contain a loop" ||
      error.message.startsWith("Task flow schedule problem:") ||
      error.message === "Farm id is required to create a task flow" ||
      error.message === "Spreadsheet upload must be an .xlsx, .ods, or .csv file" ||
      error.message === "Spreadsheet upload was empty" ||
      error.message === "Spreadsheet upload is too large for this prototype" ||
      error.message === "Spreadsheet did not contain any readable rows" ||
      error.message === "Spreadsheet is empty" ||
      error.message === "Spreadsheet did not contain any planting rows under the header" ||
      error.message === "Spreadsheet only contained the unchanged example row. Add or edit a row before importing." ||
      error.message.startsWith("Spreadsheet headers must exactly match:") ||
      error.message.startsWith("Row ") ||
      error.message.startsWith("No existing B1/B2/B3/H2/H3/H4/H5/H6 blocks were found")
    )
  ) {
    res.status(400).json({ error: error.message });
    return;
  }
  const publicError = publicErrorResponse(error);
  res.status(publicError.status).json({ error: publicError.error });
});

// Start the HTTP server after all middleware/routes have been registered.
startExpiredSessionCleanup();
app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});
