/**
 * Main API server for the FarmMan prototype.
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
import { AuthContext, AuthenticatedRequest, clearSessionCookie, createSessionToken, csrfTokenForRequest, csrfTokenForSession, hashPassword, readSessionToken, resolveAuthContext, setSessionCookie, verifyPassword } from "./auth";
import {
  BedLineMode,
  extendStraightLine,
  lineStringWkt3857,
  projectWgs84To3857,
  resolveSide,
  validateBedLine
} from "./beds";
import { pool } from "./db";
import { config } from "./config";
import { boundingBox, normalizeCoordinates, polygonWkt } from "./geometry";
import {
  defaultOfflineImageryStatus,
  findBestCachedTile,
  readOfflineImageryManifest
} from "./offline-imagery";
import { roleMeetsRequirement } from "./permissions";
import { registerSpreadsheetImportRoutes } from "./routes/spreadsheet-import";
import { recalculatePlantingTasks } from "./scheduler";
import { ActualEventType, FarmRole, PlantingStatus, TaskAnchor, TaskType, taskAnchors, taskTypes } from "./types";
import { assertUndoRestoreIsAccountSafe } from "./undo-safety";

const app = express();
app.use(cors({
  credentials: true,
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
app.use(express.json({ limit: "12mb" }));

function actualUpdateForTaskType(taskType: string): { eventType: ActualEventType; field: string; status: PlantingStatus } | null {
  switch (taskType) {
    case "seed_in_tray":
      return { eventType: "tray_seeding", field: "actual_tray_seeding_date", status: "seeded_in_tray" };
    case "direct_seed":
      return { eventType: "direct_seeding", field: "actual_direct_seeding_date", status: "direct_seeded" };
    case "transplant":
      return { eventType: "transplant", field: "actual_transplant_date", status: "transplanted" };
    case "cultivate":
      return { eventType: "cultivation", field: "actual_cultivation_date", status: "growing" };
    case "harvest":
      return { eventType: "harvest", field: "actual_harvest_date", status: "harvested" };
    case "finish_crop":
      return { eventType: "finish", field: "actual_finish_date", status: "finished" };
    default:
      return null;
  }
}

function asyncHandler(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function assertNoFuturePlantingDate(eventType: string, actualDate: string) {
  if ((eventType === "tray_seeding" || eventType === "direct_seeding" || eventType === "transplant") && actualDate > todayIsoDate()) {
    throw new Error("Planted dates cannot be in the future");
  }
}

function assertNoFuturePlantingStatusDate(status: string, sowDate?: string | null, transplantDate?: string | null) {
  if ((status === "seeded_in_tray" || status === "direct_seeded") && sowDate && sowDate > todayIsoDate()) {
    throw new Error("Planted dates cannot be in the future");
  }
  if (status === "transplanted" && transplantDate && transplantDate > todayIsoDate()) {
    throw new Error("Planted dates cannot be in the future");
  }
}

function currentAuth(req: express.Request) {
  return (req as AuthenticatedRequest).auth ?? null;
}

function requireRole(role: FarmRole = "worker") {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const auth = currentAuth(req);
    if (!auth) {
      res.status(401).json({ error: "Login required" });
      return;
    }

    if (!roleMeetsRequirement(auth, role)) {
      res.status(403).json({ error: "Planner access required" });
      return;
    }

    next();
  };
}

function requireAdmin() {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const auth = currentAuth(req);
    if (!auth) {
      res.status(401).json({ error: "Login required" });
      return;
    }

    if (!auth.isAdmin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }

    next();
  };
}

// Zod schemas define what each API route accepts. They are the first line of
// defense against malformed form/map data reaching the database.
const plantingStatusSchema = z.enum([
  "planned",
  "seeded_in_tray",
  "direct_seeded",
  "germinating",
  "ready_to_transplant",
  "transplanted",
  "growing",
  "harvested",
  "finished"
]);

const actualEventTypeSchema = z.enum([
  "tray_seeding",
  "direct_seeding",
  "transplant",
  "cultivation",
  "harvest",
  "finish"
]);

const taskTypeSchema = z.enum(taskTypes as [TaskType, ...TaskType[]]);
const taskAnchorSchema = z.enum(taskAnchors as [TaskAnchor, ...TaskAnchor[]]);
const futureUseSchema = z.enum(["beds", "cover_crop"]);
const zoneActualStateSchema = z.enum([
  "needs_cleanup",
  "needs_amendment",
  "needs_tillage",
  "ready_for_bed_making",
  "beds_made",
  "partially_planted",
  "fully_planted",
  "cover_crop_established",
  "finished"
]);
const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180)
});

const polygonSchema = z.object({
  coordinates: z.array(latLngSchema).min(3).max(50)
});

const geometrySchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive()
});

const plantingSchema = z
  .object({
    cropId: z.number(),
    varietyId: z.number().nullable().optional(),
    title: z.string().min(1),
    status: plantingStatusSchema,
    intendedBedId: z.number().nullable().optional(),
    seedItemId: z.number().nullable().optional(),
    taskFlowTemplateId: z.number().nullable().optional(),
    spacing: z.string().nullable().optional(),
    plantCount: z.number().int().positive().nullable().optional(),
    bedLengthUsedM: z.number().positive().nullable().optional(),
    trayLocation: z.string().nullable().optional(),
    trayCount: z.number().int().positive().nullable().optional(),
    notes: z.string().nullable().optional(),
    plannedSowDate: z.string().nullable().optional(),
    plannedTransplantDate: z.string().nullable().optional(),
    expectedHarvestStart: z.string().nullable().optional(),
    expectedHarvestEnd: z.string().nullable().optional()
  })
  .refine((value) => value.plantCount != null || value.bedLengthUsedM != null, {
    message: "Plant count or bed length used is required"
  });

const placementSchema = z
  .object({
    bedId: z.number(),
    plantCount: z.number().int().positive().nullable().optional(),
    bedLengthUsedM: z.number().positive().nullable().optional(),
    actualDate: z.string().nullable().optional(),
    locationDetail: z.string().nullable().optional(),
    coordinates: z.array(latLngSchema).min(3).max(50).nullable().optional(),
    notes: z.string().nullable().optional()
  })
  .refine((value) => value.plantCount != null || value.bedLengthUsedM != null, {
    message: "Plant count or bed length used is required"
  });

const actualEventSchema = z.object({
  eventType: actualEventTypeSchema,
  actualDate: z.string(),
  notes: z.string().nullable().optional()
});

const taskRecordSchema = z.object({
  actualDate: z.string(),
  notes: z.string().nullable().optional(),
  intendedBedId: z.number().nullable().optional(),
  plantCount: z.number().int().positive().nullable().optional(),
  bedLengthUsedM: z.number().positive().nullable().optional(),
  spacing: z.string().nullable().optional(),
  placementBedId: z.number().nullable().optional(),
  placementPlantCount: z.number().int().positive().nullable().optional(),
  placementBedLengthUsedM: z.number().positive().nullable().optional(),
  placementLocationDetail: z.string().nullable().optional(),
  placementCoordinates: z.array(latLngSchema).min(3).max(50).nullable().optional(),
  placementNotes: z.string().nullable().optional()
}).refine((value) => {
  if (value.placementBedId == null) {
    return true;
  }

  return value.placementPlantCount != null || value.placementBedLengthUsedM != null;
}, {
  message: "Placement needs plant count or bed length used"
});

const harvestSchema = z.object({
  plantingId: z.number(),
  bedId: z.number(),
  harvestDate: z.string(),
  quantity: z.number().positive(),
  unit: z.string().min(1),
  notes: z.string().nullable().optional()
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  farmId: z.number().nullable().optional()
});

const usernameSchema = z.string().trim().min(3, "Username must be at least 3 characters").max(50);
const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(200)
  .regex(/[A-Za-z]/, "Password must include at least one letter")
  .regex(/\d/, "Password must include at least one number");

const registerSchema = z.object({
  farmName: z.string().trim().min(1).max(120),
  displayName: z.string().trim().min(1).max(100).nullable().optional(),
  username: usernameSchema,
  password: passwordSchema
});

const accountCreateSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(100).nullable().optional(),
  role: z.enum(["planner", "worker"])
});

const adminBootstrapSchema = z.object({
  username: z.string().trim().min(3).max(80),
  password: z.string().min(8).refine((value) => /[A-Za-z]/.test(value) && /\d/.test(value), "Password must include at least one letter and one number"),
  displayName: z.string().trim().max(160).nullable().optional()
});

const farmSettingsSchema = z.object({
  mapsPrivate: z.boolean()
});

const feedbackSchema = z.object({
  page: z.string().trim().min(1).max(80),
  comment: z.string().max(4000).nullable().optional(),
  context: z.record(z.unknown()).optional(),
  recentActivity: z.array(z.record(z.unknown())).max(50).optional()
});

const fieldPolygonSchema = polygonSchema.extend({
  farmId: z.number(),
  name: z.string().min(1),
  notes: z.string().nullable().optional()
});

const fieldPolygonUpdateSchema = polygonSchema.extend({
  name: z.string().min(1),
  notes: z.string().nullable().optional()
});

const blockPolygonSchema = polygonSchema.extend({
  fieldId: z.number(),
  name: z.string().min(1),
  notes: z.string().nullable().optional(),
  currentState: zoneActualStateSchema
});

const blockPolygonUpdateSchema = polygonSchema.extend({
  name: z.string().min(1),
  notes: z.string().nullable().optional()
});

const coverCropNameSchema = z.object({
  farmId: z.number(),
  name: z.string().trim().min(1).max(120),
  notes: z.string().nullable().optional()
});

const seedItemSchema = z.object({
  farmId: z.number(),
  family: z.string().trim().max(120).nullable().optional(),
  cropType: z.string().trim().min(1).max(120),
  varietyName: z.string().trim().max(160).nullable().optional(),
  breedName: z.string().trim().max(160).nullable().optional(),
  supplier: z.string().trim().max(160).nullable().optional(),
  catalogNumber: z.string().trim().max(160).nullable().optional(),
  lotNumber: z.string().trim().max(160).nullable().optional(),
  notes: z.string().nullable().optional()
});

const blockZoneSchema = polygonSchema.extend({
  blockId: z.number(),
  name: z.string().min(1),
  plannedUse: futureUseSchema.nullable().optional(),
  actualState: zoneActualStateSchema,
  coverCropNameId: z.number().nullable().optional(),
  coverCropName: z.string().trim().min(1).max(120).nullable().optional(),
  plannedCoverCropSeedDate: z.string().nullable().optional(),
  plannedCoverCropTerminateDate: z.string().nullable().optional(),
  notes: z.string().nullable().optional()
});

const blockZoneUpdateSchema = polygonSchema.extend({
  name: z.string().min(1),
  plannedUse: futureUseSchema.nullable().optional(),
  actualState: zoneActualStateSchema,
  coverCropNameId: z.number().nullable().optional(),
  coverCropName: z.string().trim().min(1).max(120).nullable().optional(),
  plannedCoverCropSeedDate: z.string().nullable().optional(),
  plannedCoverCropTerminateDate: z.string().nullable().optional(),
  actualCoverCropSeedDate: z.string().nullable().optional(),
  actualCoverCropTerminateDate: z.string().nullable().optional(),
  notes: z.string().nullable().optional()
});

const blockZoneSplitSchema = z.object({
  name: z.string().trim().min(1).max(160),
  plannedUse: futureUseSchema.nullable().optional(),
  actualState: zoneActualStateSchema,
  coverCropNameId: z.number().nullable().optional(),
  coverCropName: z.string().trim().min(1).max(120).nullable().optional(),
  plannedCoverCropSeedDate: z.string().nullable().optional(),
  plannedCoverCropTerminateDate: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  lineCoordinates: z.array(latLngSchema).length(2),
  useLargerSide: z.boolean().default(false)
});

const coverCropWorkSchema = z.object({
  actualState: zoneActualStateSchema.optional(),
  actualCoverCropSeedDate: z.string().nullable().optional(),
  actualCoverCropTerminateDate: z.string().nullable().optional(),
  notes: z.string().nullable().optional()
});

const bedLineModeSchema = z.enum(["straight", "curved"]);

const bedPresetSchema = z.object({
  farmId: z.number(),
  name: z.string().min(1),
  bedWidthM: z.number().positive(),
  pathSpacingM: z.number().min(0),
  isRoad: z.boolean().default(false),
  notes: z.string().nullable().optional()
});

const taskFlowNodeSchema = z.object({
  nodeKey: z.string().min(1),
  taskType: taskTypeSchema,
  label: z.string().min(1),
  anchor: taskAnchorSchema,
  offsetDays: z.number().int(),
  iconColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#4f84aa"),
  iconSecondaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#f4c430"),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  notes: z.string().nullable().optional()
});

const taskFlowEdgeSchema = z.object({
  fromNodeKey: z.string().min(1),
  toNodeKey: z.string().min(1)
});

const taskFlowSchema = z.object({
  farmId: z.number(),
  cropId: z.number().nullable().optional(),
  name: z.string().min(1),
  notes: z.string().nullable().optional(),
  isDefault: z.boolean().default(false),
  nodes: z.array(taskFlowNodeSchema).min(1),
  edges: z.array(taskFlowEdgeSchema).default([])
});

const taskFlowUpdateSchema = z.object({
  cropId: z.number().nullable().optional(),
  name: z.string().min(1),
  notes: z.string().nullable().optional(),
  isDefault: z.boolean().default(false),
  nodes: z.array(taskFlowNodeSchema).min(1),
  edges: z.array(taskFlowEdgeSchema).default([])
});

const bedGenerationSchema = z.object({
  presetId: z.number(),
  zoneId: z.number().nullable().optional(),
  lineMode: bedLineModeSchema,
  lineCoordinates: z.array(latLngSchema).min(2).max(12),
  count: z.number().int().positive().max(100),
  layoutStartIndex: z.number().int().min(0).max(1000).default(0),
  edgeOffsetM: z.number().min(0).max(100).default(0),
  namePrefix: z.string().min(1),
  startNumber: z.number().int().positive().default(1),
  isPermanent: z.boolean().default(true),
  replaceExisting: z.boolean().default(false),
  invertSide: z.boolean().default(false),
  fillWholeBlock: z.boolean().default(false),
  harvestRoadEveryBeds: z.number().int().positive().nullable().optional(),
  harvestRoadWidthBeds: z.number().int().min(0).max(20).default(0)
});

// Attach auth data to API requests. Login/session/offline imagery are allowed to
// run without an existing authenticated farm session.
app.use("/api", asyncHandler(async (req, _res, next) => {
  if (
    req.path === "/auth/login" ||
    req.path === "/session" ||
    req.path.startsWith("/offline-imagery/")
  ) {
    next();
    return;
  }

  (req as AuthenticatedRequest).auth = await resolveAuthContext(req);
  next();
}));

app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }

  // Login/register do not have a session yet. Once a cookie-authenticated
  // session exists, unsafe methods must include the matching CSRF header.
  if (!(req as AuthenticatedRequest).auth) {
    next();
    return;
  }

  const expectedToken = csrfTokenForRequest(req);
  const providedToken = req.header("x-csrf-token");
  if (!expectedToken || providedToken !== expectedToken) {
    res.status(403).json({ error: "Invalid CSRF token" });
    return;
  }

  next();
});

function rectangleWkt(x: number, y: number, width: number, height: number) {
  const x2 = x + width;
  const y2 = y + height;
  return `POLYGON((${x} ${y}, ${x2} ${y}, ${x2} ${y2}, ${x} ${y2}, ${x} ${y}))`;
}

// "ensureXInFarm" helpers prevent users from editing records that belong to a
// different farm. Keep using this pattern when adding new farm-owned records.
async function ensureFieldInFarm(client: PoolClient, fieldId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `select id from fields where id = $1 and farm_id = $2`,
    [fieldId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Field not found in this farm");
  }
}

async function ensureBlockInFarm(client: PoolClient, blockId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `
      select block.id
      from blocks block
      join fields field on field.id = block.field_id
      where block.id = $1 and field.farm_id = $2
    `,
    [blockId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Block not found in this farm");
  }
}

async function ensureBlockZoneInFarm(client: PoolClient, zoneId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `
      select zone.id
      from block_zones zone
      join blocks block on block.id = zone.block_id
      join fields field on field.id = block.field_id
      where zone.id = $1 and field.farm_id = $2
    `,
    [zoneId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Block zone not found in this farm");
  }
}

async function ensureBedInFarm(client: PoolClient, bedId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `
      select bed.id
      from beds bed
      join blocks block on block.id = bed.block_id
      join fields field on field.id = block.field_id
      where bed.id = $1 and field.farm_id = $2
    `,
    [bedId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Bed not found in this farm");
  }
}

async function ensurePlantableBedInFarm(client: PoolClient, bedId: number, farmId: number) {
  const result = await client.query<{ id: number; source: string }>(
    `
      select bed.id, bed.source
      from beds bed
      join blocks block on block.id = bed.block_id
      join fields field on field.id = block.field_id
      where bed.id = $1 and field.farm_id = $2
    `,
    [bedId, farmId]
  );
  const bed = result.rows[0];
  if (!bed) {
    throw new Error("Bed not found in this farm");
  }
  if (bed.source === "road") {
    throw new Error("Road/path presets are not plantable beds");
  }
}

async function ensurePlantingInFarm(client: PoolClient, plantingId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `select id from plantings where id = $1 and farm_id = $2`,
    [plantingId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Planting not found in this farm");
  }
}

async function ensureTaskInFarm(client: PoolClient, taskId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `select id from tasks where id = $1 and farm_id = $2`,
    [taskId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Task not found in this farm");
  }
}

async function ensureTaskFlowInFarm(client: PoolClient, taskFlowId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `select id from task_flow_templates where id = $1 and farm_id = $2`,
    [taskFlowId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Task flow template not found in this farm");
  }
}

async function ensureBedPresetInFarm(client: PoolClient, presetId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `select id from bed_presets where id = $1 and farm_id = $2`,
    [presetId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Bed preset not found in this farm");
  }
}

async function ensureCoverCropNameInFarm(client: PoolClient, coverCropNameId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `select id from cover_crop_names where id = $1 and farm_id = $2`,
    [coverCropNameId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Cover crop name not found in this farm");
  }
}

async function ensureSeedItemInFarm(client: PoolClient, seedItemId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `select id from seed_items where id = $1 and farm_id = $2`,
    [seedItemId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Seed item not found in this farm");
  }
}

async function upsertCoverCropName(
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
async function insertGeneratedBeds(
  client: PoolClient,
  options: {
    blockId: number;
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
  }
) {
  const presetResult = await client.query<{ bed_width_m: string; path_spacing_m: string; name: string; is_road: boolean }>(
    `select bed_width_m, path_spacing_m, name, is_road from bed_presets where id = $1`,
    [options.presetId]
  );
  if (!presetResult.rows[0]) {
    throw new Error("Bed preset not found");
  }

  if (options.replaceExisting) {
    if (options.zoneId != null) {
      await client.query(`delete from beds where zone_id = $1`, [options.zoneId]);
    } else {
      await client.query(`delete from beds where block_id = $1`, [options.blockId]);
    }
  }

  const linePoints = options.lineCoordinates.map((point) => projectWgs84To3857(point.lat, point.lng));
  validateBedLine(options.lineMode, linePoints);

  const lineWkt = lineStringWkt3857(linePoints);
  const fullLineWkt = options.lineMode === "straight" ? lineStringWkt3857(extendStraightLine(linePoints)) : null;
  const bedWidthM = Number(presetResult.rows[0].bed_width_m);
  const isRoadPreset = presetResult.rows[0].is_road;
  const pathSpacingM = isRoadPreset ? 0 : Number(presetResult.rows[0].path_spacing_m);

  const insertOneBed = async (side: "left" | "right", layoutBedIndex: number, sequenceIndex: number) => {
    const sideSign = side === "left" ? 1 : -1;
    const harvestRoadEveryBeds = options.harvestRoadEveryBeds && options.harvestRoadWidthBeds > 0 ? options.harvestRoadEveryBeds : null;
    const skippedBedSlots = harvestRoadEveryBeds ? Math.floor(layoutBedIndex / harvestRoadEveryBeds) * options.harvestRoadWidthBeds : 0;
    const layoutIndex = layoutBedIndex + skippedBedSlots;
    // ST_Buffer is used with side=left/right, so the offset line is the bed edge,
    // not the bed centerline. The first bed should start directly from the picked
    // block edge; later beds move by one bed plus one path each time.
    // When building from a selected bed edge, edgeOffsetM carries the path width
    // so the next bed starts after the walkway instead of touching the old bed.
    const startOffset = (options.edgeOffsetM + layoutIndex * (bedWidthM + pathSpacingM)) * sideSign;
    const sql = options.lineMode === "straight" ? `
      with
      block_geom as (
        select ST_Transform(coalesce(zone.boundary, block.boundary), 3857) as geom
        from blocks block
        left join block_zones zone on zone.id = $13
        where block.id = $1
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
          ST_Length(trimmed_line.geom) as length_m,
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
            where existing.block_id = $1
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
        left join block_zones zone on zone.id = $12
        where block.id = $1
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
          ST_Length(trimmed_line.geom) as length_m,
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
            where existing.block_id = $1
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
    const params = options.lineMode === "straight"
      ? [
          options.blockId,
          lineWkt,
          fullLineWkt,
          startOffset,
          bedWidthM,
          sideOption,
          `${options.namePrefix}${options.startNumber + sequenceIndex}`,
          options.isPermanent,
          `Generated from preset ${presetResult.rows[0].name}`,
          options.presetId,
          side,
          options.startNumber + sequenceIndex,
          options.zoneId ?? null,
          isRoadPreset ? "road" : "generated"
        ]
      : [
          options.blockId,
          lineWkt,
          startOffset,
          bedWidthM,
          sideOption,
          `${options.namePrefix}${options.startNumber + sequenceIndex}`,
          options.isPermanent,
          `Generated from preset ${presetResult.rows[0].name}`,
          options.presetId,
          side,
          options.startNumber + sequenceIndex,
          options.zoneId ?? null,
          isRoadPreset ? "road" : "generated"
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
    await client.query(`delete from beds where id = any($1::int[])`, [primaryIds]);
  }

  const alternateIds = await generateForSide(alternateSide);

  if (alternateIds.length > primaryIds.length) {
    return { inserted: alternateIds.length, insertedIds: alternateIds, isRoad: isRoadPreset };
  }

  if (alternateIds.length > 0) {
    await client.query(`delete from beds where id = any($1::int[])`, [alternateIds]);
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

async function blockIdForBed(client: PoolClient, bedId: number, farmId: number) {
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

async function upsertBlockBedMakingTask(client: PoolClient, farmId: number, blockId: number) {
  const context = await client.query<{ block_name: string; field_name: string; first_bed_id: number | null; scheduled_date: string | null }>(
    `
      with first_bed as (
        select id
        from beds
        where block_id = $2 and source <> 'road'
        order by sequence_no nulls last, id
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
        and task_type = 'bed_prep'
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
      values ($1, $2, 'bed_prep', $3, 'pending', null, null, $4, $5, true, '#8b6f43', '#f4c430')
    `,
    [farmId, row.first_bed_id, title, row.scheduled_date, notes]
  );
}

async function clearIntendedBedsForField(client: PoolClient, fieldId: number) {
  await client.query(
    `
      update plantings
      set intended_bed_id = null, updated_at = now()
      where intended_bed_id in (
        select bed.id
        from beds bed
        join blocks block on block.id = bed.block_id
        where block.field_id = $1
      )
    `,
    [fieldId]
  );
}

async function clearIntendedBedsForBlock(client: PoolClient, blockId: number) {
  await client.query(
    `
      update plantings
      set intended_bed_id = null, updated_at = now()
      where intended_bed_id in (
        select id
        from beds
        where block_id = $1
      )
    `,
    [blockId]
  );
}

// Field/block/zone geometry helpers write both old bounding-box columns and new
// PostGIS geometry columns so older prototype UI code and newer map code agree.
async function upsertFieldGeometry(
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

  await client.query(
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
      where id = $1
    `,
    [options.id, options.name, options.notes ?? null, box.x, box.y, box.width, box.height, wkt]
  );
  console.info("Updated field geometry", { fieldId: options.id, pointCount: coordinates.length });
  return options.id;
}

async function validateBlockBoundary(
  client: PoolClient,
  fieldId: number,
  wkt: string
) {
  const result = await client.query<{ outside_sqm: number; is_valid: boolean }>(
    `
      select
        coalesce(ST_Area(ST_Difference(ST_GeomFromText($2, 4326), boundary)::geography), 0) as outside_sqm,
        ST_IsValid(ST_GeomFromText($2, 4326)) as is_valid
      from fields
      where id = $1
    `,
    [fieldId, wkt]
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

async function upsertBlockGeometry(
  client: PoolClient,
  options: {
    id?: number;
    fieldId: number;
    name: string;
    notes?: string | null;
    coordinates: Array<{ lat: number; lng: number }>;
  }
) {
  const coordinates = normalizeCoordinates(options.coordinates);
  const wkt = polygonWkt(coordinates);
  const box = boundingBox(coordinates);
  const warning = await validateBlockBoundary(client, options.fieldId, wkt);

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

  await client.query(
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
    `,
    [options.id, options.fieldId, options.name, options.notes ?? null, box.x, box.y, box.width, box.height, wkt]
  );
  return { id: options.id, warning };
}

async function ensureDefaultBlockArea(
  client: PoolClient,
  options: {
    blockId: number;
    farmId: number;
    blockName: string;
    currentState: z.infer<typeof zoneActualStateSchema>;
    coordinates: Array<{ lat: number; lng: number }>;
  }
) {
  const existing = await client.query<{ id: number }>(
    `select id from block_zones where block_id = $1 limit 1`,
    [options.blockId]
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

async function getBedContext(client: PoolClient, bedId: number) {
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
      where bed.id = $1
    `,
    [bedId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Bed not found");
  }

  return row;
}

// Farm events are the dated history layer: what happened, where, and what it
// changed. The map time slider can use these records to reconstruct state.
async function recordFarmEvent(
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

const undoSnapshotTableNames = [
  "fields",
  "blocks",
  "cover_crop_names",
  "seed_items",
  "bed_presets",
  "block_zones",
  "beds",
  "task_flow_templates",
  "task_flow_steps",
  "task_flow_nodes",
  "task_flow_edges",
  "plantings",
  "planting_placements",
  "tasks",
  "harvest_records",
  "farm_events"
] as const;

const undoSnapshotSequenceNames = [
  "fields",
  "blocks",
  "cover_crop_names",
  "seed_items",
  "bed_presets",
  "block_zones",
  "beds",
  "task_flow_templates",
  "task_flow_steps",
  "task_flow_nodes",
  "task_flow_edges",
  "plantings",
  "planting_placements",
  "tasks",
  "harvest_records",
  "farm_events"
] as const;

async function captureFarmSnapshot(
  client: PoolClient,
  farmId: number
) {
  const result = await client.query<{ snapshot: Record<string, unknown> }>(
    `
      select jsonb_build_object(
        'fields', (select coalesce(jsonb_agg(to_jsonb(field) order by field.id), '[]'::jsonb) from fields field where field.farm_id = $1),
        'blocks', (
          select coalesce(jsonb_agg(to_jsonb(block) order by block.id), '[]'::jsonb)
          from blocks block
          join fields field on field.id = block.field_id
          where field.farm_id = $1
        ),
        'cover_crop_names', (select coalesce(jsonb_agg(to_jsonb(cover_crop) order by cover_crop.id), '[]'::jsonb) from cover_crop_names cover_crop where cover_crop.farm_id = $1),
        'seed_items', (select coalesce(jsonb_agg(to_jsonb(seed) order by seed.id), '[]'::jsonb) from seed_items seed where seed.farm_id = $1),
        'bed_presets', (select coalesce(jsonb_agg(to_jsonb(preset) order by preset.id), '[]'::jsonb) from bed_presets preset where preset.farm_id = $1),
        'block_zones', (
          select coalesce(jsonb_agg(to_jsonb(zone) order by zone.id), '[]'::jsonb)
          from block_zones zone
          join blocks block on block.id = zone.block_id
          join fields field on field.id = block.field_id
          where field.farm_id = $1
        ),
        'beds', (
          select coalesce(jsonb_agg(to_jsonb(bed) order by bed.id), '[]'::jsonb)
          from beds bed
          join blocks block on block.id = bed.block_id
          join fields field on field.id = block.field_id
          where field.farm_id = $1
        ),
        'task_flow_templates', (select coalesce(jsonb_agg(to_jsonb(template) order by template.id), '[]'::jsonb) from task_flow_templates template where template.farm_id = $1),
        'task_flow_steps', (
          select coalesce(jsonb_agg(to_jsonb(step) order by step.id), '[]'::jsonb)
          from task_flow_steps step
          join task_flow_templates template on template.id = step.flow_template_id
          where template.farm_id = $1
        ),
        'task_flow_nodes', (
          select coalesce(jsonb_agg(to_jsonb(node) order by node.id), '[]'::jsonb)
          from task_flow_nodes node
          join task_flow_templates template on template.id = node.flow_template_id
          where template.farm_id = $1
        ),
        'task_flow_edges', (
          select coalesce(jsonb_agg(to_jsonb(edge) order by edge.id), '[]'::jsonb)
          from task_flow_edges edge
          join task_flow_templates template on template.id = edge.flow_template_id
          where template.farm_id = $1
        ),
        'plantings', (select coalesce(jsonb_agg(to_jsonb(planting) order by planting.id), '[]'::jsonb) from plantings planting where planting.farm_id = $1),
        'planting_placements', (
          select coalesce(jsonb_agg(to_jsonb(placement) order by placement.id), '[]'::jsonb)
          from planting_placements placement
          join plantings planting on planting.id = placement.planting_id
          where planting.farm_id = $1
        ),
        'tasks', (select coalesce(jsonb_agg(to_jsonb(task) order by task.id), '[]'::jsonb) from tasks task where task.farm_id = $1),
        'harvest_records', (select coalesce(jsonb_agg(to_jsonb(harvest) order by harvest.id), '[]'::jsonb) from harvest_records harvest where harvest.farm_id = $1),
        'farm_events', (select coalesce(jsonb_agg(to_jsonb(event) order by event.id), '[]'::jsonb) from farm_events event where event.farm_id = $1)
      ) as snapshot
    `,
    [farmId]
  );

  return result.rows[0]?.snapshot ?? {};
}

// Undo/redo is snapshot-based. Before a change, we capture the important farm
// tables, then restore that JSON later if the user clicks Undo.
async function createUndoSnapshot(
  client: PoolClient,
  auth: AuthContext,
  label: string
) {
  // This is a prototype-friendly undo model: capture the farm's mutable planning
  // tables before a write, then restore the latest snapshot if the user clicks Undo.
  // A new write after Undo clears the redo branch, matching normal undo/redo behavior.
  await client.query(
    `delete from undo_snapshots where farm_id = $1 and user_id = $2 and undone_at is not null`,
    [auth.farmId, auth.userId]
  );
  const snapshot = await captureFarmSnapshot(client, auth.farmId);

  await client.query(
    `
      insert into undo_snapshots (farm_id, user_id, label, snapshot)
      values ($1, $2, $3, $4::jsonb)
    `,
    [auth.farmId, auth.userId, label, JSON.stringify(snapshot)]
  );
}

async function pruneUndoSnapshots(client: PoolClient, auth: AuthContext) {
  await client.query(
    `
      delete from undo_snapshots
      where farm_id = $1
        and user_id = $2
        and id not in (
          select id
          from undo_snapshots
          where farm_id = $1 and user_id = $2 and undone_at is null
          order by created_at desc, id desc
          limit 8
        )
        and id not in (
          select id
          from undo_snapshots
          where farm_id = $1 and user_id = $2 and undone_at is not null
          order by created_at desc, id desc
          limit 4
        )
    `,
    [auth.farmId, auth.userId]
  );
}

async function resetSerialSequence(client: PoolClient, tableName: string) {
  await client.query(`
    select setval(
      pg_get_serial_sequence('${tableName}', 'id'),
      greatest(coalesce((select max(id) from ${tableName}), 0), 1),
      coalesce((select max(id) from ${tableName}), 0) > 0
    )
  `);
}

async function restoreFarmSnapshot(
  client: PoolClient,
  farmId: number,
  snapshot: Record<string, unknown>
) {
  await client.query(`delete from farm_events where farm_id = $1`, [farmId]);
  await client.query(`delete from harvest_records where farm_id = $1`, [farmId]);
  await client.query(`delete from tasks where farm_id = $1`, [farmId]);
  await client.query(`delete from planting_placements where planting_id in (select id from plantings where farm_id = $1)`, [farmId]);
  await client.query(`delete from plantings where farm_id = $1`, [farmId]);
  await client.query(`delete from task_flow_edges where flow_template_id in (select id from task_flow_templates where farm_id = $1)`, [farmId]);
  await client.query(`delete from task_flow_nodes where flow_template_id in (select id from task_flow_templates where farm_id = $1)`, [farmId]);
  await client.query(`delete from task_flow_steps where flow_template_id in (select id from task_flow_templates where farm_id = $1)`, [farmId]);
  await client.query(`delete from task_flow_templates where farm_id = $1`, [farmId]);
  await client.query(
    `
      delete from beds
      where block_id in (
        select block.id
        from blocks block
        join fields field on field.id = block.field_id
        where field.farm_id = $1
      )
    `,
    [farmId]
  );
  await client.query(
    `
      delete from block_zones
      where block_id in (
        select block.id
        from blocks block
        join fields field on field.id = block.field_id
        where field.farm_id = $1
      )
    `,
    [farmId]
  );
  await client.query(`delete from cover_crop_names where farm_id = $1`, [farmId]);
  await client.query(`delete from seed_items where farm_id = $1`, [farmId]);
  await client.query(`delete from bed_presets where farm_id = $1`, [farmId]);
  await client.query(`delete from blocks where field_id in (select id from fields where farm_id = $1)`, [farmId]);
  await client.query(`delete from fields where farm_id = $1`, [farmId]);

  // jsonb_populate_recordset lets Postgres rehydrate date, numeric, array, jsonb,
  // and PostGIS geometry columns using the same text representations it exported.
  for (const tableName of undoSnapshotTableNames) {
    await client.query(
      `insert into ${tableName} select * from jsonb_populate_recordset(null::${tableName}, $1::jsonb->'${tableName}')`,
      [JSON.stringify(snapshot)]
    );
  }

  for (const tableName of undoSnapshotSequenceNames) {
    await resetSerialSequence(client, tableName);
  }
}

async function runWithUndoSnapshot<T>(
  auth: AuthContext,
  label: string,
  work: (client: PoolClient) => Promise<T>
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await createUndoSnapshot(client, auth, label);
    const result = await work(client);
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function validateBlockZoneBoundary(
  client: PoolClient,
  blockId: number,
  wkt: string
) {
  const result = await client.query<{ outside_sqm: number; is_valid: boolean }>(
    `
      select
        coalesce(ST_Area(ST_Difference(ST_GeomFromText($2, 4326), boundary)::geography), 0) as outside_sqm,
        ST_IsValid(ST_GeomFromText($2, 4326)) as is_valid
      from blocks
      where id = $1
    `,
    [blockId, wkt]
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

async function upsertBlockZoneGeometry(
  client: PoolClient,
  options: {
    id?: number;
    blockId: number;
    farmId: number;
    name: string;
    plannedUse?: "beds" | "cover_crop" | null;
    actualState: z.infer<typeof zoneActualStateSchema>;
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
  const warning = await validateBlockZoneBoundary(client, options.blockId, wkt);
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

  await client.query(
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
      wkt
    ]
  );

  return { id: options.id, warning };
}

// Splits one block polygon into two zone polygons using a user-drawn edge-to-edge line.
async function splitBlockBoundaryIntoZoneCoordinates(
  client: PoolClient,
  options: {
    blockId: number;
    lineCoordinates: Array<{ lat: number; lng: number }>;
    useLargerSide: boolean;
  }
) {
  const endpointToleranceM = 3;
  const linePoints = options.lineCoordinates.map((point) => projectWgs84To3857(point.lat, point.lng));
  const startPoint = linePoints[0];
  const endPoint = linePoints[1];
  const endpointCheck = await client.query<{ start_distance_m: string; end_distance_m: string }>(
    `
      with
      block_geom as (
        select ST_Transform(boundary, 3857) as geom
        from blocks
        where id = $1
      ),
      endpoints as (
        select
          ST_GeomFromText($2, 3857) as start_geom,
          ST_GeomFromText($3, 3857) as end_geom
      )
      select
        ST_Distance(ST_Boundary(block_geom.geom), endpoints.start_geom)::text as start_distance_m,
        ST_Distance(ST_Boundary(block_geom.geom), endpoints.end_geom)::text as end_distance_m
      from block_geom, endpoints
    `,
    [
      options.blockId,
      `POINT(${startPoint.x} ${startPoint.y})`,
      `POINT(${endPoint.x} ${endPoint.y})`
    ]
  );

  const startDistance = Number(endpointCheck.rows[0]?.start_distance_m ?? Number.POSITIVE_INFINITY);
  const endDistance = Number(endpointCheck.rows[0]?.end_distance_m ?? Number.POSITIVE_INFINITY);
  if (startDistance > endpointToleranceM || endDistance > endpointToleranceM) {
    throw new Error("Split points must be placed on the selected block edge.");
  }

  const extendedLineWkt = lineStringWkt3857(extendStraightLine(linePoints));
  const result = await client.query<{ piece_count: string; target_geojson: string | null; remainder_geojson: string | null }>(
    `
      with
      block_geom as (
        select ST_Transform(boundary, 3857) as geom
        from blocks
        where id = $1
      ),
      split_line as (
        select ST_GeomFromText($2, 3857) as geom
      ),
      pieces as (
        select
          row_number() over (order by ST_Area(piece.geom) asc, ST_YMin(piece.geom), ST_XMin(piece.geom)) as piece_no,
          piece.geom,
          ST_Area(piece.geom) as area_sqm
        from (
          select (ST_Dump(ST_CollectionExtract(ST_Split(block_geom.geom, split_line.geom), 3))).geom
          from block_geom, split_line
        ) as piece
      ),
      target_piece as (
        select piece_no, geom
        from pieces
        order by area_sqm ${options.useLargerSide ? "desc" : "asc"}, piece_no
        limit 1
      ),
      remainder_piece as (
        select geom
        from pieces
        where piece_no <> (select piece_no from target_piece)
      )
      select
        (select count(*)::text from pieces) as piece_count,
        ST_AsGeoJSON(ST_Transform((select geom from target_piece), 4326)) as target_geojson,
        ST_AsGeoJSON(ST_Transform((select geom from remainder_piece), 4326)) as remainder_geojson
    `,
    [options.blockId, extendedLineWkt]
  );

  const row = result.rows[0];
  if (!row || Number(row.piece_count) !== 2 || !row.target_geojson || !row.remainder_geojson) {
    throw new Error("The split line must cut the selected block into 2 parts.");
  }

  const targetFeature = JSON.parse(row.target_geojson) as { type?: string; coordinates?: number[][][] };
  const remainderFeature = JSON.parse(row.remainder_geojson) as { type?: string; coordinates?: number[][][] };

  if (targetFeature.type !== "Polygon" || remainderFeature.type !== "Polygon") {
    throw new Error("The split produced an unsupported shape. Try a simpler 2-point line.");
  }

  const toCoordinates = (coordinates: number[][][]) => coordinates[0].slice(0, -1).map(([lng, lat]) => ({ lat, lng }));

  return {
    targetCoordinates: toCoordinates(targetFeature.coordinates ?? []),
    remainderCoordinates: toCoordinates(remainderFeature.coordinates ?? [])
  };
}

function validateTaskFlowGraph(
  nodes: Array<{ nodeKey: string; label: string }>,
  edges: Array<{ fromNodeKey: string; toNodeKey: string }>
) {
  const nodeKeys = new Set(nodes.map((node) => node.nodeKey));
  if (nodeKeys.size !== nodes.length) {
    throw new Error("Task flow node keys must be unique");
  }

  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    if (!nodeKeys.has(edge.fromNodeKey) || !nodeKeys.has(edge.toNodeKey)) {
      throw new Error("Task flow edge references a missing node");
    }
    if (edge.fromNodeKey === edge.toNodeKey) {
      throw new Error("Task flow edge cannot point to the same node");
    }
    const edgeKey = `${edge.fromNodeKey}->${edge.toNodeKey}`;
    if (edgeKeys.has(edgeKey)) {
      throw new Error("Task flow edges must be unique");
    }
    edgeKeys.add(edgeKey);
  }

  const downstreamByNode = new Map<string, string[]>();
  for (const nodeKey of nodeKeys) {
    downstreamByNode.set(nodeKey, []);
  }
  for (const edge of edges) {
    downstreamByNode.get(edge.fromNodeKey)?.push(edge.toNodeKey);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeKey: string): boolean => {
    if (visiting.has(nodeKey)) {
      return true;
    }
    if (visited.has(nodeKey)) {
      return false;
    }

    visiting.add(nodeKey);
    for (const downstreamNodeKey of downstreamByNode.get(nodeKey) ?? []) {
      if (visit(downstreamNodeKey)) {
        return true;
      }
    }
    visiting.delete(nodeKey);
    visited.add(nodeKey);
    return false;
  };

  for (const nodeKey of nodeKeys) {
    if (visit(nodeKey)) {
      throw new Error("Task flow dependencies cannot contain a loop");
    }
  }
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
        `
      : `
          select id
          from plantings
          where farm_id = $2
            and task_flow_template_id = $1
          order by id
        `,
    [taskFlowTemplateId, template.farm_id, template.crop_id]
  );

  for (const planting of plantings.rows) {
    await recalculatePlantingTasks(client, planting.id);
  }
}

// Saving a task flow replaces its graph in one transaction, then refreshes
// affected plantings so their generated tasks match the edited flow.
async function saveTaskFlowTemplate(
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
      anchor: TaskAnchor;
      offsetDays: number;
      iconColor: string;
      iconSecondaryColor: string;
      x: number;
      y: number;
      notes?: string | null;
    }>;
    edges: Array<{
      fromNodeKey: string;
      toNodeKey: string;
    }>;
  }
) {
  validateTaskFlowGraph(options.nodes, options.edges);

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
    await client.query(
      `
        update task_flow_templates
        set
          crop_id = $2,
          name = $3,
          notes = $4,
          is_default = $5,
          updated_at = now()
        where id = $1
      `,
      [flowTemplateId, options.cropId ?? null, options.name, options.notes ?? null, options.isDefault]
    );
    await client.query(`delete from task_flow_edges where flow_template_id = $1`, [flowTemplateId]);
    await client.query(`delete from task_flow_nodes where flow_template_id = $1`, [flowTemplateId]);
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

  const nodeIdsByKey = new Map<string, number>();
  for (const node of options.nodes) {
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
          x_pos,
          y_pos,
          notes
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        returning id
      `,
      [
        flowTemplateId,
        node.nodeKey,
        node.taskType,
        node.label,
        node.anchor,
        node.offsetDays,
        node.iconColor,
        node.iconSecondaryColor,
        node.x,
        node.y,
        node.notes ?? null
      ]
    );
    nodeIdsByKey.set(node.nodeKey, result.rows[0].id);
  }

  for (const edge of options.edges) {
    await client.query(
      `
        insert into task_flow_edges (
          flow_template_id,
          from_node_id,
          to_node_id
        )
        values ($1, $2, $3)
      `,
      [
        flowTemplateId,
        nodeIdsByKey.get(edge.fromNodeKey),
        nodeIdsByKey.get(edge.toNodeKey)
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

// Authentication and account setup routes.
app.get("/api/session", asyncHandler(async (req, res) => {
  const auth = await resolveAuthContext(req);
  if (!auth) {
    res.json({ authenticated: false });
    return;
  }

  res.json({
    authenticated: true,
    user: {
      id: auth.userId,
      username: auth.username,
      displayName: auth.displayName,
      farmId: auth.farmId,
      farmName: auth.farmName,
      role: auth.role,
      isAdmin: auth.isAdmin
    },
    csrfToken: csrfTokenForRequest(req)
  });
}));

app.post("/api/auth/login", asyncHandler(async (req, res) => {
  const body = loginSchema.parse(req.body);
  const client = await pool.connect();
  try {
    const userResult = await client.query<{
      id: number;
      username: string;
      display_name: string | null;
      password_hash: string;
      is_active: boolean;
      is_admin: boolean;
    }>(
      `
        select id, username, display_name, password_hash, is_active, is_admin
        from app_users
        where lower(username) = lower($1)
        limit 1
      `,
      [body.username]
    );
    const user = userResult.rows[0];
    if (!user || !user.is_active || !verifyPassword(body.password, user.password_hash)) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    const membershipsResult = await client.query<{
      farm_id: number;
      farm_name: string;
      role: FarmRole;
    }>(
      `
        select membership.farm_id, farm.name as farm_name, membership.role
        from farm_memberships membership
        join farms farm on farm.id = membership.farm_id
        where membership.user_id = $1
          and ($2::integer is null or membership.farm_id = $2)
        order by membership.farm_id
      `,
      [user.id, body.farmId ?? null]
    );
    const membership = membershipsResult.rows[0];
    if (!membership) {
      res.status(403).json({ error: "This account does not belong to the requested farm" });
      return;
    }

    const token = createSessionToken();
    await client.query(
      `
        insert into user_sessions (user_id, farm_id, session_token, expires_at)
        values ($1, $2, $3, now() + ($4::text || ' days')::interval)
      `,
      [user.id, membership.farm_id, token, String(config.sessionMaxAgeDays)]
    );
    setSessionCookie(res, token);
    res.status(201).json({
      authenticated: true,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        farmId: membership.farm_id,
        farmName: membership.farm_name,
        role: membership.role,
        isAdmin: user.is_admin
      },
      csrfToken: csrfTokenForSession(token)
    });
  } finally {
    client.release();
  }
}));

app.post("/api/auth/register", asyncHandler(async (req, res) => {
  const body = registerSchema.parse(req.body);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const farmResult = await client.query<{ id: number; name: string }>(
      `
        insert into farms (name, notes)
        values ($1, 'Created from the FarmMan landing page')
        returning id, name
      `,
      [body.farmName.trim()]
    );
    const farm = farmResult.rows[0];
    const userResult = await client.query<{
      id: number;
      username: string;
      display_name: string | null;
    }>(
      `
        insert into app_users (username, password_hash, display_name)
        values ($1, $2, $3)
        returning id, username, display_name
      `,
      [body.username.trim(), hashPassword(body.password), body.displayName?.trim() || null]
    );
    const user = userResult.rows[0];

    await client.query(
      `
        insert into farm_memberships (farm_id, user_id, role)
        values ($1, $2, 'planner')
      `,
      [farm.id, user.id]
    );

    const token = createSessionToken();
    await client.query(
      `
        insert into user_sessions (user_id, farm_id, session_token, expires_at)
        values ($1, $2, $3, now() + ($4::text || ' days')::interval)
      `,
      [user.id, farm.id, token, String(config.sessionMaxAgeDays)]
    );

    await client.query("commit");
    setSessionCookie(res, token);
    res.status(201).json({
      authenticated: true,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        farmId: farm.id,
        farmName: farm.name,
        role: "planner" satisfies FarmRole,
        isAdmin: false
      },
      csrfToken: csrfTokenForSession(token)
    });
  } catch (error) {
    await client.query("rollback");
    const maybeError = error as { code?: string };
    if (maybeError.code === "23505") {
      res.status(400).json({ error: "Username already exists" });
      return;
    }
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/admin/bootstrap", asyncHandler(async (req, res) => {
  const body = adminBootstrapSchema.parse(req.body);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const adminCount = await client.query<{ count: string }>(`select count(*)::text as count from app_users where is_admin = true`);
    if (Number(adminCount.rows[0]?.count ?? "0") > 0) {
      res.status(403).json({ error: "An admin account already exists. Log in with that account." });
      await client.query("rollback");
      return;
    }

    const farmResult = await client.query<{ id: number; name: string }>(
      `
        insert into farms (name, notes, maps_private)
        values ('FarmMan Administration', 'Internal admin account farm', true)
        returning id, name
      `
    );
    const farm = farmResult.rows[0];
    const userResult = await client.query<{
      id: number;
      username: string;
      display_name: string | null;
    }>(
      `
        insert into app_users (username, password_hash, display_name, is_admin)
        values ($1, $2, $3, true)
        returning id, username, display_name
      `,
      [body.username.trim(), hashPassword(body.password), body.displayName?.trim() || null]
    );
    const user = userResult.rows[0];

    await client.query(
      `
        insert into farm_memberships (farm_id, user_id, role)
        values ($1, $2, 'planner')
      `,
      [farm.id, user.id]
    );

    const token = createSessionToken();
    await client.query(
      `
        insert into user_sessions (user_id, farm_id, session_token, expires_at)
        values ($1, $2, $3, now() + ($4::text || ' days')::interval)
      `,
      [user.id, farm.id, token, String(config.sessionMaxAgeDays)]
    );

    await client.query("commit");
    setSessionCookie(res, token);
    res.status(201).json({
      authenticated: true,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        farmId: farm.id,
        farmName: farm.name,
        role: "planner" satisfies FarmRole,
        isAdmin: true
      },
      csrfToken: csrfTokenForSession(token)
    });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    const maybeError = error as { code?: string };
    if (maybeError.code === "23505") {
      res.status(400).json({ error: "Username already exists" });
      return;
    }
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/auth/logout", asyncHandler(async (req, res) => {
  const sessionToken = readSessionToken(req);
  if (sessionToken) {
    await pool.query(`delete from user_sessions where session_token = $1`, [sessionToken]);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
}));

// Farm user management: planners can create worker/planner accounts for their farm.
app.get("/api/accounts", requireRole("planner"), asyncHandler(async (req, res) => {
  const auth = currentAuth(req) as AuthContext;
  const result = await pool.query<{
    id: number;
    username: string;
    display_name: string | null;
    role: FarmRole;
    created_at: string;
  }>(
    `
      select
        app_user.id,
        app_user.username,
        app_user.display_name,
        membership.role,
        app_user.created_at
      from farm_memberships membership
      join app_users app_user on app_user.id = membership.user_id
      where membership.farm_id = $1
      order by
        case when membership.role = 'planner' then 0 else 1 end,
        app_user.username
    `,
    [auth.farmId]
  );

  res.json(result.rows.map((row: {
    id: number;
    username: string;
    display_name: string | null;
    role: FarmRole;
    created_at: string;
  }) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at
  })));
}));

app.post("/api/accounts", requireRole("planner"), asyncHandler(async (req, res) => {
  const auth = currentAuth(req) as AuthContext;
  const body = accountCreateSchema.parse(req.body);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const userResult = await client.query<{
      id: number;
      username: string;
      display_name: string | null;
      created_at: string;
    }>(
      `
        insert into app_users (username, password_hash, display_name)
        values ($1, $2, $3)
        returning id, username, display_name, created_at
      `,
      [body.username.trim(), hashPassword(body.password), body.displayName?.trim() || null]
    );
    await client.query(
      `
        insert into farm_memberships (farm_id, user_id, role)
        values ($1, $2, $3)
      `,
      [auth.farmId, userResult.rows[0].id, body.role]
    );
    await client.query("commit");
    res.status(201).json({
      id: userResult.rows[0].id,
      username: userResult.rows[0].username,
      displayName: userResult.rows[0].display_name,
      role: body.role,
      createdAt: userResult.rows[0].created_at
    });
  } catch (error) {
    await client.query("rollback");
    const maybeError = error as { code?: string };
    if (maybeError.code === "23505") {
      res.status(400).json({ error: "Username already exists" });
      return;
    }
    throw error;
  } finally {
    client.release();
  }
}));

// Admin panel routes. Admin is separate from the normal farm planner/worker role.
app.get("/api/admin/users", requireAdmin(), asyncHandler(async (_req, res) => {
  const result = await pool.query<{
    id: number;
    username: string;
    display_name: string | null;
    is_active: boolean;
    is_admin: boolean;
    created_at: string;
    last_session_at: string | null;
    feedback_count: string;
    memberships: Array<{ farmId: number; farmName: string; role: FarmRole }>;
  }>(
    `
      select
        app_user.id,
        app_user.username,
        app_user.display_name,
        app_user.is_active,
        app_user.is_admin,
        app_user.created_at,
        max(session.created_at) as last_session_at,
        count(distinct feedback.id)::text as feedback_count,
        coalesce(
          jsonb_agg(
            distinct jsonb_build_object(
              'farmId', farm.id,
              'farmName', farm.name,
              'role', membership.role
            )
          ) filter (where farm.id is not null),
          '[]'::jsonb
        ) as memberships
      from app_users app_user
      left join farm_memberships membership on membership.user_id = app_user.id
      left join farms farm on farm.id = membership.farm_id
      left join user_sessions session on session.user_id = app_user.id
      left join feedback_reports feedback on feedback.user_id = app_user.id
      group by app_user.id
      order by app_user.is_admin desc, app_user.is_active desc, app_user.created_at desc, app_user.username
    `
  );

  res.json(result.rows.map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isActive: row.is_active,
    isAdmin: row.is_admin,
    createdAt: row.created_at,
    lastSessionAt: row.last_session_at,
    feedbackCount: Number(row.feedback_count),
    memberships: row.memberships
  })));
}));

app.delete("/api/admin/users/:id", requireAdmin(), asyncHandler(async (req, res) => {
  const auth = currentAuth(req) as AuthContext;
  const userId = Number(req.params.id);
  if (userId === auth.userId) {
    res.status(400).json({ error: "You cannot delete the admin account you are currently using." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from user_sessions where user_id = $1`, [userId]);
    await client.query(
      `
        update app_users
        set is_active = false, updated_at = now()
        where id = $1
      `,
      [userId]
    );
    await client.query("commit");
    res.json({ ok: true });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

// Farm-wide settings and feedback/suggestion reporting.
app.put("/api/farm/settings", requireRole("planner"), asyncHandler(async (req, res) => {
  const auth = currentAuth(req) as AuthContext;
  const body = farmSettingsSchema.parse(req.body);
  await pool.query(
    `
      update farms
      set maps_private = $2, updated_at = now()
      where id = $1
    `,
    [auth.farmId, body.mapsPrivate]
  );
  res.json({ ok: true });
}));

app.post("/api/feedback", asyncHandler(async (req, res) => {
  const auth = currentAuth(req);
  const body = feedbackSchema.parse(req.body);
  const result = await pool.query<{ id: number }>(
    `
      insert into feedback_reports (
        farm_id, user_id, page, comment, context, recent_activity, user_agent
      )
      values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
      returning id
    `,
    [
      auth?.farmId ?? null,
      auth?.userId ?? null,
      body.page,
      body.comment?.trim() || null,
      JSON.stringify(body.context ?? {}),
      JSON.stringify(body.recentActivity ?? []),
      req.get("user-agent") ?? null
    ]
  );

  res.status(201).json({ id: result.rows[0].id });
}));

app.get("/api/feedback", requireRole("planner"), asyncHandler(async (req, res) => {
  const auth = currentAuth(req) as AuthContext;
  const result = await pool.query<{
    id: number;
    farm_id: number | null;
    user_id: number | null;
    username: string | null;
    display_name: string | null;
    page: string;
    comment: string | null;
    context: Record<string, unknown>;
    recent_activity: Array<Record<string, unknown>>;
    user_agent: string | null;
    created_at: string;
  }>(
    `
      select
        report.id,
        report.farm_id,
        report.user_id,
        app_user.username,
        app_user.display_name,
        report.page,
        report.comment,
        report.context,
        report.recent_activity,
        report.user_agent,
        report.created_at
      from feedback_reports report
      left join app_users app_user on app_user.id = report.user_id
      where $2::boolean = true or report.farm_id = $1 or report.farm_id is null
      order by report.created_at desc, report.id desc
      limit 50
    `,
    [auth.farmId, auth.isAdmin]
  );

  res.json(result.rows.map((row: {
    id: number;
    farm_id: number | null;
    user_id: number | null;
    username: string | null;
    display_name: string | null;
    page: string;
    comment: string | null;
    context: Record<string, unknown>;
    recent_activity: Array<Record<string, unknown>>;
    user_agent: string | null;
    created_at: string;
  }) => ({
    id: row.id,
    farmId: row.farm_id,
    userId: row.user_id,
    username: row.username ?? "anonymous",
    displayName: row.display_name,
    page: row.page,
    comment: row.comment,
    context: row.context,
    recentActivity: row.recent_activity,
    userAgent: row.user_agent,
    createdAt: row.created_at
  })));
}));

// Recent undo/redo controls for the current farm user.
app.get("/api/undo", requireRole("worker"), asyncHandler(async (req, res) => {
  const auth = currentAuth(req) as AuthContext;
  const [undoResult, redoResult] = await Promise.all([
    pool.query(
      `
        select
          id,
          label,
          created_at as "createdAt"
        from undo_snapshots
        where farm_id = $1
          and user_id = $2
          and undone_at is null
        order by created_at desc, id desc
        limit 8
      `,
      [auth.farmId, auth.userId]
    ),
    pool.query(
      `
        select
          id,
          label,
          undone_at as "createdAt"
        from undo_snapshots
        where farm_id = $1
          and user_id = $2
          and undone_at is not null
          and redo_snapshot is not null
        order by undone_at desc, id desc
        limit 8
      `,
      [auth.farmId, auth.userId]
    )
  ]);
  res.json({ undo: undoResult.rows, redo: redoResult.rows });
}));

app.post("/api/undo", requireRole("worker"), asyncHandler(async (req, res) => {
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<{ id: number; label: string; snapshot: Record<string, unknown>; created_at: string }>(
      `
        select id, label, snapshot, created_at
        from undo_snapshots
        where farm_id = $1
          and user_id = $2
          and undone_at is null
        order by created_at desc, id desc
        limit 1
        for update
      `,
      [auth.farmId, auth.userId]
    );
    const snapshot = result.rows[0];
    if (!snapshot) {
      await client.query("rollback");
      res.status(404).json({ error: "Nothing to undo" });
      return;
    }

    await assertUndoRestoreIsAccountSafe(client, auth, snapshot.created_at, "undo");
    const redoSnapshot = await captureFarmSnapshot(client, auth.farmId);
    await restoreFarmSnapshot(client, auth.farmId, snapshot.snapshot);
    await client.query(
      `update undo_snapshots set undone_at = now(), redo_snapshot = $2::jsonb, redone_at = null where id = $1`,
      [snapshot.id, JSON.stringify(redoSnapshot)]
    );
    await client.query("commit");
    res.json({ ok: true, label: snapshot.label });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/redo", requireRole("worker"), asyncHandler(async (req, res) => {
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<{ id: number; label: string; redo_snapshot: Record<string, unknown>; undone_at: string }>(
      `
        select id, label, redo_snapshot, undone_at
        from undo_snapshots
        where farm_id = $1
          and user_id = $2
          and undone_at is not null
          and redo_snapshot is not null
        order by undone_at desc, id desc
        limit 1
        for update
      `,
      [auth.farmId, auth.userId]
    );
    const snapshot = result.rows[0];
    if (!snapshot) {
      await client.query("rollback");
      res.status(404).json({ error: "Nothing to redo" });
      return;
    }

    await assertUndoRestoreIsAccountSafe(client, auth, snapshot.undone_at, "redo");
    await restoreFarmSnapshot(client, auth.farmId, snapshot.redo_snapshot);
    await client.query(`update undo_snapshots set undone_at = null, redone_at = now() where id = $1`, [snapshot.id]);
    await client.query("commit");
    res.json({ ok: true, label: snapshot.label });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}));

// Optional offline tile status and tile serving. Normal online basemaps do not
// need these routes, but the UI can fall back to them when cached imagery exists.
app.get("/api/offline-imagery/status", asyncHandler(async (_req, res) => {
  const manifest = await readOfflineImageryManifest();
  res.json(manifest ?? defaultOfflineImageryStatus());
}));

app.get("/api/offline-imagery/tiles/:z/:x/:y", asyncHandler(async (req, res) => {
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

  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
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
app.get("/api/dashboard", requireRole("worker"), asyncHandler(async (req, res) => {
  const auth = currentAuth(req) as AuthContext;
  const [farm, fields, blocks, blockZones, beds, bedPresets, coverCropNames, seedItems, crops, varieties, taskFlowTemplates, taskFlowNodes, taskFlowEdges, plantings, placements, events, tasks, harvests] = await Promise.all([
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
      where field.farm_id = $1 or farm.maps_private = false
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
        b.area_sqm as "areaSqM",
        f.name as "fieldName",
        ST_AsGeoJSON(b.boundary)::json as boundary,
        ST_AsGeoJSON(b.centroid)::json as centroid
      from blocks b
      join fields f on f.id = b.field_id
      join farms farm on farm.id = f.farm_id
      where f.farm_id = $1 or farm.maps_private = false
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
      where field.farm_id = $1 or farm.maps_private = false
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
      where field.farm_id = $1 or farm.maps_private = false
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
        notes,
        concat_ws(' / ', crop_type, variety_name, breed_name, supplier, nullif(catalog_number, ''), nullif(lot_number, '')) as "displayName"
      from seed_items
      where farm_id = $1
      order by crop_type, variety_name nulls last, breed_name nulls last, supplier nulls last
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
        to_node.node_key as "toNodeKey"
      from task_flow_edges e
      join task_flow_nodes from_node on from_node.id = e.from_node_id
      join task_flow_nodes to_node on to_node.id = e.to_node_id
      where e.flow_template_id in (select id from task_flow_templates where farm_id = $1)
      order by e.flow_template_id, e.id
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
        p.intended_bed_id as "intendedBedId",
        ib.name as "intendedBedName",
        p.task_flow_template_id as "taskFlowTemplateId",
        tft.name as "taskFlowTemplateName",
        p.spacing,
        p.plant_count as "plantCount",
        p.bed_length_used_m as "bedLengthUsedM",
        p.tray_location as "trayLocation",
        p.tray_count as "trayCount",
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
    plantings: plantings.rows,
    placements: placements.rows,
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

    const seedResult = await client.query<{ id: number }>(
      `
        insert into seed_items (
          farm_id, crop_id, variety_id, family, crop_type, variety_name, breed_name, supplier, catalog_number, lot_number, notes
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
        body.lotNumber?.trim() || null,
        body.notes ?? null
      ]
    );

    return { id: seedResult.rows[0].id, cropId, varietyId };
  });

  res.status(201).json(result);
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
    await upsertBlockZoneGeometry(client, {
      blockId,
      farmId: auth.farmId,
      name: `Area ${existingZoneCount + 2}`,
      plannedUse: null,
      actualState: body.actualState,
      plannedCoverCropSeedDate: null,
      plannedCoverCropTerminateDate: null,
      notes: null,
      coordinates: remainderCoordinates
    });
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
      anchor: TaskAnchor;
      offset_days: number;
      icon_color: string;
      icon_secondary_color: string;
      x_pos: number;
      y_pos: number;
      notes: string | null;
    }>(
      `
        select node_key, task_type, label, anchor, offset_days, icon_color, icon_secondary_color, x_pos, y_pos, notes
        from task_flow_nodes
        where flow_template_id = $1
        order by y_pos, x_pos, id
      `,
      [id]
    );
    const edgesResult = await client.query<{
      from_node_key: string;
      to_node_key: string;
    }>(
      `
        select from_node.node_key as from_node_key, to_node.node_key as to_node_key
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
        anchor: TaskAnchor;
        offset_days: number;
        icon_color: string;
        icon_secondary_color: string;
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
        x: Number(node.x_pos),
        y: Number(node.y_pos),
        notes: node.notes
      })),
      edges: edgesResult.rows.map((edge: { from_node_key: string; to_node_key: string }) => ({
        fromNodeKey: edge.from_node_key,
        toNodeKey: edge.to_node_key
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
      await upsertBlockBedMakingTask(client, auth.farmId, blockId);
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
    await createUndoSnapshot(client, auth, "Create planting");
    const result = await client.query<{ id: number }>(
      `
        insert into plantings (
          farm_id, crop_id, variety_id, seed_item_id, title, status, intended_bed_id, task_flow_template_id, spacing, plant_count, bed_length_used_m, notes,
          tray_location, tray_count, planned_sow_date, planned_transplant_date, expected_harvest_start, expected_harvest_end
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        returning id
      `,
      [
        auth.farmId,
        body.cropId,
        body.varietyId ?? null,
        body.seedItemId ?? null,
        body.title,
        body.status,
        body.intendedBedId ?? null,
        body.taskFlowTemplateId ?? null,
        body.spacing ?? null,
        body.plantCount ?? null,
        body.bedLengthUsedM ?? null,
        body.notes ?? null,
        body.trayLocation ?? null,
        body.trayCount ?? null,
        body.plannedSowDate ?? null,
        body.plannedTransplantDate ?? null,
        body.expectedHarvestStart ?? null,
        body.expectedHarvestEnd ?? null
      ]
    );
    await recalculatePlantingTasks(client, result.rows[0].id);
    if (body.intendedBedId != null) {
      const blockId = await blockIdForBed(client, body.intendedBedId, auth.farmId);
      if (blockId != null) {
        await upsertBlockBedMakingTask(client, auth.farmId, blockId);
      }
    }
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    res.status(201).json({ id: result.rows[0].id });
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
    if (body.intendedBedId != null) {
      await ensurePlantableBedInFarm(client, body.intendedBedId, auth.farmId);
    }
    if (body.seedItemId != null) {
      await ensureSeedItemInFarm(client, body.seedItemId, auth.farmId);
    }
    if (body.taskFlowTemplateId != null) {
      await ensureTaskFlowInFarm(client, body.taskFlowTemplateId, auth.farmId);
    }
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
          intended_bed_id = $7,
          task_flow_template_id = $8,
          spacing = $9,
          plant_count = $10,
          bed_length_used_m = $11,
          notes = $12,
          tray_location = $13,
          tray_count = $14,
          planned_sow_date = $15,
          planned_transplant_date = $16,
          expected_harvest_start = $17,
          expected_harvest_end = $18,
          updated_at = now()
        where id = $1 and farm_id = $19
      `,
      [
        id,
        body.cropId,
        body.varietyId ?? null,
        body.seedItemId ?? null,
        body.title,
        body.status,
        body.intendedBedId ?? null,
        body.taskFlowTemplateId ?? null,
        body.spacing ?? null,
        body.plantCount ?? null,
        body.bedLengthUsedM ?? null,
        body.notes ?? null,
        body.trayLocation ?? null,
        body.trayCount ?? null,
        body.plannedSowDate ?? null,
        body.plannedTransplantDate ?? null,
        body.expectedHarvestStart ?? null,
        body.expectedHarvestEnd ?? null,
        auth.farmId
      ]
    );
    await recalculatePlantingTasks(client, id);
    if (body.intendedBedId != null) {
      const blockId = await blockIdForBed(client, body.intendedBedId, auth.farmId);
      if (blockId != null) {
        await upsertBlockBedMakingTask(client, auth.farmId, blockId);
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

app.delete("/api/plantings/:id", requireRole("planner"), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const auth = currentAuth(req) as AuthContext;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ id: number }>(`select id from plantings where id = $1 and farm_id = $2`, [id, auth.farmId]);
    if (!existing.rows[0]) {
      await client.query("rollback");
      res.status(404).json({ error: "Planting not found" });
      return;
    }
    await createUndoSnapshot(client, auth, "Delete planting");
    await client.query(`delete from plantings where id = $1`, [id]);
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
    }>(
      `select id, planting_id, bed_id, task_type from tasks where id = $1 and farm_id = $2`,
      [id, auth.farmId]
    );

    const task = taskResult.rows[0];
    if (!task) {
      await client.query("rollback");
      res.status(404).json({ error: "Task not found" });
      return;
    }

    if (task.planting_id != null) {
      const taskActualUpdate = actualUpdateForTaskType(task.task_type);
      if (taskActualUpdate) {
        assertNoFuturePlantingDate(taskActualUpdate.eventType, body.actualDate);
      }
      const plantingResult = await client.query<{ title: string }>(
        `select title from plantings where id = $1`,
        [task.planting_id]
      );
      const plantingTitle = plantingResult.rows[0]?.title ?? "Planting";
      const hasPlantingAdjustments =
        body.intendedBedId !== undefined ||
        body.plantCount !== undefined ||
        body.bedLengthUsedM !== undefined ||
        body.spacing !== undefined;

      if (hasPlantingAdjustments) {
        if (auth.role !== "planner") {
          throw new Error("Planner access required for planting adjustments");
        }
        if (body.intendedBedId != null) {
          await ensurePlantableBedInFarm(client, body.intendedBedId, auth.farmId);
        }
        await client.query(
          `
            update plantings
            set
              intended_bed_id = case when $2::boolean then $3::integer else intended_bed_id end,
              plant_count = case when $4::boolean then $5::integer else plant_count end,
              bed_length_used_m = case when $6::boolean then $7::numeric else bed_length_used_m end,
              spacing = case when $8::boolean then $9::text else spacing end,
              updated_at = now()
            where id = $1
          `,
          [
            task.planting_id,
            body.intendedBedId !== undefined,
            body.intendedBedId ?? null,
            body.plantCount !== undefined,
            body.plantCount ?? null,
            body.bedLengthUsedM !== undefined,
            body.bedLengthUsedM ?? null,
            body.spacing !== undefined,
            body.spacing ?? null
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
          updated_at = now()
        where id = $1
      `,
      [id, body.actualDate, body.notes ?? null]
    );

    await recordFarmEvent(client, {
      farmId: auth.farmId,
      eventDate: body.actualDate,
      eventType: "task_recorded",
      title: task.task_type.replaceAll("_", " "),
      notes: body.notes ?? null,
      metadata: {
        taskType: task.task_type
      },
      bedId: task.bed_id ?? null,
      plantingId: task.planting_id ?? null,
      taskId: id
    });

    if (task.planting_id != null) {
      await recalculatePlantingTasks(client, task.planting_id);
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

// Last-resort error handler. Route code throws normal Errors; this turns them
// into JSON so the frontend can show a useful message instead of silently failing.
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: error.errors });
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
      error.message === "Select or add a cover crop name for cover crop areas" ||
      error.message === "Task flow node keys must be unique" ||
      error.message === "Task flow edge references a missing node" ||
      error.message === "Task flow edge cannot point to the same node" ||
      error.message === "Task flow edges must be unique" ||
      error.message === "Task flow dependencies cannot contain a loop" ||
      error.message === "Farm id is required to create a task flow" ||
      error.message === "Spreadsheet upload must be an .xlsx, .ods, or .csv file" ||
      error.message === "Spreadsheet upload was empty" ||
      error.message === "Spreadsheet upload is too large for this prototype" ||
      error.message === "Spreadsheet did not contain any readable rows" ||
      error.message === "Spreadsheet is empty" ||
      error.message === "Spreadsheet did not contain any planting rows under the header" ||
      error.message.startsWith("Spreadsheet headers must exactly match:") ||
      error.message.startsWith("Row ") ||
      error.message.startsWith("No existing B1/B2/B3/H2/H3/H4/H5/H6 blocks were found")
    )
  ) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = typeof error.message === "string" ? error.message : "Internal server error";
    const detail = "detail" in error && typeof error.detail === "string" ? error.detail : undefined;
    res.status(500).json({ error: detail ? `${message}: ${detail}` : message });
    return;
  }
  res.status(500).json({ error: "Internal server error" });
});

// Start the HTTP server after all middleware/routes have been registered.
app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});
