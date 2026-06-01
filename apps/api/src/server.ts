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
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { PoolClient } from "pg";
import { z } from "zod";
import { isEmailVerificationBypassAddress, normalizeAccountEmail } from "./account-email";
import { AuthContext, AuthenticatedRequest, clearSessionCookie, createSessionToken, csrfTokenForRequest, csrfTokenForSession, hashPassword, readSessionToken, resolveAuthContext, setSessionCookie, verifyPassword } from "./auth";
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
import { seedStarterSeedCatalog } from "./default-seed-catalog";
import { boundingBox, normalizeCoordinates, polygonWkt } from "./geometry";
import {
  defaultOfflineImageryStatus,
  findBestCachedTile,
  readOfflineImageryManifest
} from "./offline-imagery";
import { roleMeetsRequirement } from "./permissions";
import { registerFarmRoutes } from "./routes/farm-routes";
import { recalculatePlantingTasks } from "./scheduler";
import {
  accountCreateSchema,
  BlockPlacementPlanRow,
  farmSettingsSchema,
  feedbackSchema,
  loginSchema,
  PlantingInput,
  registerSchema,
  SeedItemLotInput,
  ZoneActualStateInput
} from "./schemas";
import { ActualEventType, FarmRole, PlantingStatus, TaskType } from "./types";
import { assertUndoRestoreIsAccountSafe } from "./undo-safety";

const app = express();
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

async function seedDefaultBedPresets(client: PoolClient, farmId: number) {
  await client.query(
    `
      insert into bed_presets (farm_id, name, bed_width_m, path_spacing_m, is_road, notes)
      values
        ($1, 'Bare bed 3 ft', 0.9144, 0.6096, false, 'Default bare bed: 3 ft plantable bed with 2 ft path.'),
        ($1, 'Plastic bed 3 ft', 0.9144, 0.9144, false, 'Default plastic bed: 3 ft bed with 3 ft path.'),
        ($1, 'Farm road 12 ft', 3.6576, 0, true, 'Default non-plantable farm road: 12 ft wide.')
      on conflict (farm_id, name) do update
      set bed_width_m = excluded.bed_width_m,
          path_spacing_m = excluded.path_spacing_m,
          is_road = excluded.is_road,
          notes = excluded.notes,
          updated_at = now()
    `,
    [farmId]
  );
}

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

type LoginLockoutBucket = {
  failures: number;
  failureWindowResetAt: number;
  lockedUntil: number;
};

const rateLimitBuckets = new Map<string, RateLimitBucket>();
const loginLockoutBuckets = new Map<string, LoginLockoutBucket>();

function pruneBuckets<T extends { resetAt?: number; failureWindowResetAt?: number; lockedUntil?: number }>(
  store: Map<string, T>,
  now: number
) {
  for (const [key, value] of store.entries()) {
    const expiresAt = Math.max(value.resetAt ?? 0, value.failureWindowResetAt ?? 0, value.lockedUntil ?? 0);
    if (expiresAt <= now) {
      store.delete(key);
    }
  }
}

function requestIp(req: express.Request) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function enforceRateLimit(
  req: express.Request,
  res: express.Response,
  key: string,
  options: { limit: number; windowMs: number; message: string }
) {
  const now = Date.now();
  pruneBuckets(rateLimitBuckets, now);
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + options.windowMs });
    return true;
  }
  if (bucket.count >= options.limit) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    res.status(429).json({ error: options.message });
    return false;
  }
  bucket.count += 1;
  return true;
}

function loginLockoutKey(req: express.Request, username: string) {
  return `${requestIp(req)}:${username.trim().toLowerCase()}`;
}

function enforceLoginLockout(req: express.Request, res: express.Response, username: string) {
  const now = Date.now();
  pruneBuckets(loginLockoutBuckets, now);
  const bucket = loginLockoutBuckets.get(loginLockoutKey(req, username));
  if (!bucket || bucket.lockedUntil <= now) {
    return true;
  }
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.lockedUntil - now) / 1000))));
  res.status(429).json({ error: "Too many failed login attempts. Try again later." });
  return false;
}

function recordLoginFailure(req: express.Request, username: string) {
  const now = Date.now();
  const key = loginLockoutKey(req, username);
  const existing = loginLockoutBuckets.get(key);
  if (!existing || existing.failureWindowResetAt <= now) {
    loginLockoutBuckets.set(key, {
      failures: 1,
      failureWindowResetAt: now + 15 * 60 * 1000,
      lockedUntil: 0
    });
    return;
  }
  existing.failures += 1;
  if (existing.failures >= 10) {
    existing.lockedUntil = now + 30 * 60 * 1000;
  }
}

function clearLoginFailures(req: express.Request, username: string) {
  loginLockoutBuckets.delete(loginLockoutKey(req, username));
}

function createEmailVerificationToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function emailVerificationTokenHash(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function emailVerificationUrl(token: string) {
  const url = new URL("/api/auth/verify-email", config.publicApiUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

async function sendVerificationEmail(email: string, username: string, token: string) {
  const url = emailVerificationUrl(token);
  // There is no SMTP dependency in this prototype yet. Logging the link keeps
  // local/dev signup usable and gives hosted deployments a single integration
  // point for a real mail provider later.
  console.info(`[email verification] ${email} (${username}): ${url}`);
}

async function createVerifiedSession(
  client: PoolClient,
  res: express.Response,
  user: { id: number; username: string; display_name: string | null; is_admin: boolean },
  membership: { farm_id: number; farm_name: string; role: FarmRole }
) {
  const token = createSessionToken();
  await client.query(
    `
      insert into user_sessions (user_id, farm_id, session_token, expires_at)
      values ($1, $2, $3, now() + ($4::text || ' days')::interval)
    `,
    [user.id, membership.farm_id, token, String(config.sessionMaxAgeDays)]
  );
  setSessionCookie(res, token);
  return {
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
  };
}

function stringifiedLength(value: unknown) {
  return JSON.stringify(value).length;
}

function assertFeedbackPayloadLimits(body: {
  context?: Record<string, unknown>;
  recentActivity?: Array<Record<string, unknown>>;
}) {
  const contextLength = stringifiedLength(body.context ?? {});
  const recentActivityLength = stringifiedLength(body.recentActivity ?? []);
  if (contextLength > 50_000) {
    throw new Error("Feedback context is too large");
  }
  if (recentActivityLength > 50_000) {
    throw new Error("Feedback activity details are too large");
  }
}

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

// Attach auth data to API requests. Auth bootstrap/session/offline imagery are
// allowed to run without an existing authenticated farm session.
app.use("/api", asyncHandler(async (req, _res, next) => {
  if (
    req.path === "/auth/login" ||
    req.path === "/auth/register" ||
    req.path === "/auth/verify-email" ||
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

async function ensureTractorProfileInFarm(client: PoolClient, profileId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `select id from tractor_profiles where id = $1 and farm_id = $2`,
    [profileId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Tractor not found in this farm");
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

async function ensureSeedItemLot(client: PoolClient, seedItemId: number, farmId: number, lotNumber: string) {
  await ensureSeedItemInFarm(client, seedItemId, farmId);
  await client.query(
    `
      insert into seed_item_lots (seed_item_id, lot_number)
      values ($1, $2)
      on conflict (seed_item_id, lot_number) do update set updated_at = now()
    `,
    [seedItemId, lotNumber]
  );
  await client.query(
    `
      update seed_items
      set lot_number = coalesce(lot_number, $2), updated_at = now()
      where id = $1 and farm_id = $3
    `,
    [seedItemId, lotNumber, farmId]
  );
}

async function learnSeedItemSpacingFromPlanting(client: PoolClient, farmId: number, plantingId: number) {
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
    pathSpacingOverrideM?: number | null;
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

  const linePoints = straightLineFromGuide(simplifyNearlyStraightLine(options.lineCoordinates.map((point) => projectWgs84To3857(point.lat, point.lng))));
  const lineMode: BedLineMode = "straight";
  validateBedLine(lineMode, linePoints);

  const lineWkt = lineStringWkt3857(linePoints);
  const fullLineWkt = lineMode === "straight" ? lineStringWkt3857(extendStraightLine(linePoints)) : null;
  const bedWidthM = Number(presetResult.rows[0].bed_width_m);
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
          isRoadPreset ? "road" : "generated"
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

async function fieldIdForBlock(client: PoolClient, blockId: number, farmId: number) {
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

async function plantingLocationIds(client: PoolClient, auth: AuthContext, body: PlantingInput) {
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

async function createPlantingFromInput(client: PoolClient, auth: AuthContext, body: PlantingInput) {
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
          null::integer as tray_count
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

async function reflowBlockPlacementPlan(
  client: PoolClient,
  farmId: number,
  blockId: number,
  entranceSide: "start" | "end",
  rows: BlockPlacementPlanRow[]
) {
  await ensureBlockInFarm(client, blockId, farmId);

  const bedsResult = await client.query<{ id: number; bed_length_m: string }>(
    `
      select id, bed_length_m
      from beds
      where block_id = $1
        and source <> 'road'
      order by sequence_no nulls last, id
    `,
    [blockId]
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

async function reflowExistingBlockPlacementPlan(client: PoolClient, farmId: number, blockId: number) {
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

async function moveBlockBedAssignmentsToOverflowForReplacement(
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
          null::integer as tray_count
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
        select id
        from beds
        where block_id = $2
          and ($3::integer is null or zone_id = $3)
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
        select id
        from beds
        where block_id = $2
          and ($3::integer is null or zone_id = $3)
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
        select id
        from beds
        where block_id = $2
          and ($3::integer is null or zone_id = $3)
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

async function appendPlantingToBlockPlacementPlan(client: PoolClient, farmId: number, blockId: number, plantingId: number) {
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
    currentState: ZoneActualStateInput;
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
  "seed_item_lots",
  "bed_presets",
  "tractor_profiles",
  "block_zones",
  "beds",
  "task_flow_templates",
  "task_flow_steps",
  "task_flow_nodes",
  "task_flow_edges",
  "plantings",
  "planting_placements",
  "block_placement_gaps",
  "block_placement_overflows",
  "tasks",
  "harvest_records",
  "farm_events"
] as const;

const undoSnapshotSequenceNames = [
  "fields",
  "blocks",
  "cover_crop_names",
  "seed_items",
  "seed_item_lots",
  "bed_presets",
  "tractor_profiles",
  "block_zones",
  "beds",
  "task_flow_templates",
  "task_flow_steps",
  "task_flow_nodes",
  "task_flow_edges",
  "plantings",
  "planting_placements",
  "block_placement_gaps",
  "block_placement_overflows",
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
        'seed_item_lots', (
          select coalesce(jsonb_agg(to_jsonb(lot) order by lot.id), '[]'::jsonb)
          from seed_item_lots lot
          join seed_items seed on seed.id = lot.seed_item_id
          where seed.farm_id = $1
        ),
        'bed_presets', (select coalesce(jsonb_agg(to_jsonb(preset) order by preset.id), '[]'::jsonb) from bed_presets preset where preset.farm_id = $1),
        'tractor_profiles', (select coalesce(jsonb_agg(to_jsonb(profile) order by profile.id), '[]'::jsonb) from tractor_profiles profile where profile.farm_id = $1),
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
        'block_placement_gaps', (select coalesce(jsonb_agg(to_jsonb(gap) order by gap.id), '[]'::jsonb) from block_placement_gaps gap where gap.farm_id = $1),
        'block_placement_overflows', (select coalesce(jsonb_agg(to_jsonb(overflow) order by overflow.id), '[]'::jsonb) from block_placement_overflows overflow where overflow.farm_id = $1),
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
  const snapshotHasSeedItemLots = Object.prototype.hasOwnProperty.call(snapshot, "seed_item_lots");
  const fallbackSeedItemLots = snapshotHasSeedItemLots
    ? null
    : await client.query<{ lots: unknown }>(
        `
          select coalesce(jsonb_agg(to_jsonb(lot) order by lot.id), '[]'::jsonb) as lots
          from seed_item_lots lot
          join seed_items seed on seed.id = lot.seed_item_id
          where seed.farm_id = $1
        `,
        [farmId]
      ).then((result) => result.rows[0]?.lots ?? []);
  await client.query(`delete from farm_events where farm_id = $1`, [farmId]);
  await client.query(`delete from harvest_records where farm_id = $1`, [farmId]);
  await client.query(`delete from tasks where farm_id = $1`, [farmId]);
  await client.query(`delete from block_placement_overflows where farm_id = $1`, [farmId]);
  await client.query(`delete from block_placement_gaps where farm_id = $1`, [farmId]);
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
  if (snapshotHasSeedItemLots) {
    await client.query(`delete from seed_item_lots where seed_item_id in (select id from seed_items where farm_id = $1)`, [farmId]);
  }
  await client.query(`delete from seed_items where farm_id = $1`, [farmId]);
  await client.query(`delete from bed_presets where farm_id = $1`, [farmId]);
  await client.query(`delete from tractor_profiles where farm_id = $1`, [farmId]);
  await client.query(`delete from blocks where field_id in (select id from fields where farm_id = $1)`, [farmId]);
  await client.query(`delete from fields where farm_id = $1`, [farmId]);

  // jsonb_populate_recordset lets Postgres rehydrate date, numeric, array, jsonb,
  // and PostGIS geometry columns using the same text representations it exported.
  for (const tableName of undoSnapshotTableNames) {
    if (tableName === "seed_item_lots" && !snapshotHasSeedItemLots) {
      continue;
    }
    await client.query(
      `insert into ${tableName} select * from jsonb_populate_recordset(null::${tableName}, $1::jsonb->'${tableName}')`,
      [JSON.stringify(snapshot)]
    );
  }

  if (!snapshotHasSeedItemLots && fallbackSeedItemLots) {
    await client.query(
      `
        insert into seed_item_lots
        select lot.*
        from jsonb_populate_recordset(null::seed_item_lots, $1::jsonb) as lot
        where exists (select 1 from seed_items seed where seed.id = lot.seed_item_id)
      `,
      [JSON.stringify(fallbackSeedItemLots)]
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
          tractor_model,
          tractor_profile_id,
          x_pos,
          y_pos,
          notes
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
        node.tractorModel ?? null,
        node.tractorProfileId ?? null,
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
  if (!enforceRateLimit(req, res, `login:${requestIp(req)}`, {
    limit: 20,
    windowMs: 15 * 60 * 1000,
    message: "Too many login attempts. Try again later."
  })) {
    return;
  }
  if (!enforceLoginLockout(req, res, body.username)) {
    return;
  }
  const client = await pool.connect();
  try {
    const userResult = await client.query<{
      id: number;
      username: string;
      display_name: string | null;
      email: string;
      email_verified_at: string | null;
      password_hash: string;
      is_active: boolean;
      is_admin: boolean;
    }>(
      `
        select id, username, display_name, email, email_verified_at, password_hash, is_active, is_admin
        from app_users
        where lower(username) = lower($1)
        limit 1
      `,
      [body.username]
    );
    const user = userResult.rows[0];
    if (!user || !user.is_active || !verifyPassword(body.password, user.password_hash)) {
      recordLoginFailure(req, body.username);
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }
    if (!isEmailVerificationBypassAddress(user.email) && !user.email_verified_at) {
      recordLoginFailure(req, body.username);
      res.status(403).json({ error: "Check your email to verify this account before logging in." });
      return;
    }
    clearLoginFailures(req, body.username);

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

    res.status(201).json(await createVerifiedSession(client, res, user, membership));
  } finally {
    client.release();
  }
}));

app.post("/api/auth/register", asyncHandler(async (req, res) => {
  const body = registerSchema.parse(req.body);
  const email = normalizeAccountEmail(body.email);
  const bypassEmailVerification = isEmailVerificationBypassAddress(email);
  const verificationToken = bypassEmailVerification ? null : createEmailVerificationToken();
  if (!enforceRateLimit(req, res, `register:${requestIp(req)}`, {
    limit: 8,
    windowMs: 60 * 60 * 1000,
    message: "Too many account creation attempts. Try again later."
  })) {
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const farmResult = await client.query<{ id: number; name: string }>(
      `
        insert into farms (name, notes, maps_private)
        values ($1, 'Created from the Loam Ledger landing page', true)
        returning id, name
      `,
      [body.farmName.trim()]
    );
    const farm = farmResult.rows[0];
    await seedStarterSeedCatalog(client, farm.id);
    await seedDefaultBedPresets(client, farm.id);
    const userResult = await client.query<{
      id: number;
      username: string;
      display_name: string | null;
      is_admin: boolean;
    }>(
      `
        insert into app_users (
          email,
          username,
          password_hash,
          display_name,
          email_verified_at,
          email_verification_token_hash,
          email_verification_expires_at
        )
        values ($1, $2, $3, $4, $5, $6, $7)
        returning id, username, display_name, is_admin
      `,
      [
        email,
        body.username.trim(),
        hashPassword(body.password),
        body.displayName?.trim() || null,
        bypassEmailVerification ? new Date().toISOString() : null,
        verificationToken ? emailVerificationTokenHash(verificationToken) : null,
        verificationToken ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null
      ]
    );
    const user = userResult.rows[0];

    await client.query(
      `
        insert into farm_memberships (farm_id, user_id, role)
        values ($1, $2, 'planner')
      `,
      [farm.id, user.id]
    );

    await client.query("commit");
    if (verificationToken) {
      await sendVerificationEmail(email, user.username, verificationToken);
      res.status(201).json({
        authenticated: false,
        verificationRequired: true,
        email
      });
      return;
    }

    res.status(201).json(await createVerifiedSession(client, res, user, {
      farm_id: farm.id,
      farm_name: farm.name,
      role: "planner" satisfies FarmRole
    }));
  } catch (error) {
    await client.query("rollback");
    const maybeError = error as { code?: string };
    if (maybeError.code === "23505") {
      res.status(400).json({ error: "That username or email is already in use" });
      return;
    }
    throw error;
  } finally {
    client.release();
  }
}));

async function verifyEmailTokenAndCreateSession(token: string, res: express.Response) {
  const tokenHash = emailVerificationTokenHash(token);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const userResult = await client.query<{
      id: number;
      username: string;
      display_name: string | null;
      is_admin: boolean;
    }>(
      `
        update app_users
        set
          email_verified_at = now(),
          email_verification_token_hash = null,
          email_verification_expires_at = null,
          updated_at = now()
        where email_verification_token_hash = $1
          and email_verification_expires_at > now()
          and is_active = true
        returning id, username, display_name, is_admin
      `,
      [tokenHash]
    );
    const user = userResult.rows[0];
    if (!user) {
      await client.query("rollback");
      return null;
    }

    const membershipResult = await client.query<{
      farm_id: number;
      farm_name: string;
      role: FarmRole;
    }>(
      `
        select membership.farm_id, farm.name as farm_name, membership.role
        from farm_memberships membership
        join farms farm on farm.id = membership.farm_id
        where membership.user_id = $1
        order by membership.farm_id
        limit 1
      `,
      [user.id]
    );
    const membership = membershipResult.rows[0];
    if (!membership) {
      await client.query("rollback");
      return null;
    }

    const sessionInfo = await createVerifiedSession(client, res, user, membership);
    await client.query("commit");
    return sessionInfo;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

app.post("/api/auth/verify-email", asyncHandler(async (req, res) => {
  const token = z.object({ token: z.string().min(20) }).parse(req.body).token;
  const sessionInfo = await verifyEmailTokenAndCreateSession(token, res);
  if (!sessionInfo) {
    res.status(400).json({ error: "That verification link is invalid or expired." });
    return;
  }
  res.status(201).json(sessionInfo);
}));

app.get("/api/auth/verify-email", asyncHandler(async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!token) {
    res.redirect(`${config.publicWebUrl}?verified=missing`);
    return;
  }
  const sessionInfo = await verifyEmailTokenAndCreateSession(token, res);
  res.redirect(`${config.publicWebUrl}?verified=${sessionInfo ? "1" : "invalid"}`);
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
  const email = normalizeAccountEmail(body.email);
  const bypassEmailVerification = isEmailVerificationBypassAddress(email);
  const verificationToken = bypassEmailVerification ? null : createEmailVerificationToken();
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
        insert into app_users (
          email,
          username,
          password_hash,
          display_name,
          email_verified_at,
          email_verification_token_hash,
          email_verification_expires_at
        )
        values ($1, $2, $3, $4, $5, $6, $7)
        returning id, username, display_name, created_at
      `,
      [
        email,
        body.username.trim(),
        hashPassword(body.password),
        body.displayName?.trim() || null,
        bypassEmailVerification ? new Date().toISOString() : null,
        verificationToken ? emailVerificationTokenHash(verificationToken) : null,
        verificationToken ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null
      ]
    );
    await client.query(
      `
        insert into farm_memberships (farm_id, user_id, role)
        values ($1, $2, $3)
      `,
      [auth.farmId, userResult.rows[0].id, body.role]
    );
    await client.query("commit");
    if (verificationToken) {
      await sendVerificationEmail(email, userResult.rows[0].username, verificationToken);
    }
    res.status(201).json({
      id: userResult.rows[0].id,
      username: userResult.rows[0].username,
      displayName: userResult.rows[0].display_name,
      role: body.role,
      createdAt: userResult.rows[0].created_at,
      verificationRequired: Boolean(verificationToken)
    });
  } catch (error) {
    await client.query("rollback");
    const maybeError = error as { code?: string };
    if (maybeError.code === "23505") {
      res.status(400).json({ error: "That username or email is already in use" });
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
app.put("/api/farm/settings", requireAdmin(), asyncHandler(async (req, res) => {
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
  if (!enforceRateLimit(req, res, `feedback:${requestIp(req)}`, {
    limit: 40,
    windowMs: 60 * 60 * 1000,
    message: "Too many feedback submissions. Try again later."
  })) {
    return;
  }
  const auth = currentAuth(req);
  const body = feedbackSchema.parse(req.body);
  assertFeedbackPayloadLimits(body);
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

app.get("/api/feedback", requireAdmin(), asyncHandler(async (req, res) => {
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
      where $1::boolean = true
      order by report.created_at desc, report.id desc
      limit 50
    `,
    [auth.isAdmin]
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
registerFarmRoutes(app, {
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
});

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
  if (
    error instanceof Error &&
    (
      error.message === "Feedback context is too large" ||
      error.message === "Feedback activity details are too large"
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
