/**
 * Runtime configuration for the API.
 *
 * Values come from environment variables first, then fall back to local
 * prototype defaults. This keeps local setup simple while still allowing hosted
 * deployments to provide real secrets and database URLs.
 */
import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

const apiRoot = path.resolve(__dirname, "..");

function parseCsv(value: string | undefined, fallback: string[]) {
  const raw = value ?? fallback.join(",");
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value == null) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function parseBoundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function parseSessionMaxAgeDays(value: string | undefined) {
  return parseBoundedInteger(value, 14, 1, 90);
}

function parseSameSite(value: string | undefined) {
  const normalized = (value ?? "lax").toLowerCase();
  if (normalized === "strict") return "Strict";
  if (normalized === "none") return "None";
  return "Lax";
}

function parseTrustProxy(value: string | undefined, production: boolean) {
  if (value == null || value.trim() === "") {
    return production ? 1 : false;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "on"].includes(normalized)) return true;
  if (["false", "no", "off"].includes(normalized)) return false;
  const hops = Number(normalized);
  return Number.isInteger(hops) && hops >= 0 ? hops : value;
}

// Lets config values use either absolute paths or paths relative to apps/api.
function resolveApiPath(input: string) {
  if (path.isAbsolute(input)) {
    return input;
  }

  return path.resolve(apiRoot, input);
}

function requiredProductionUrl(name: string, value: string | undefined, fallback: string, production: boolean) {
  if (production && !value) {
    throw new Error(`${name} is required when NODE_ENV=production`);
  }
  const resolved = value ?? fallback;
  try {
    const url = new URL(resolved);
    if (production && url.protocol !== "https:") {
      throw new Error(`${name} must use https in production`);
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
}

const isProduction = process.env.NODE_ENV === "production";
const emailDeliveryMode = process.env.EMAIL_DELIVERY_MODE ?? (isProduction ? "resend" : "development");
if (!["development", "resend"].includes(emailDeliveryMode)) {
  throw new Error("EMAIL_DELIVERY_MODE must be development or resend");
}

export const config = {
  isProduction,
  port: Number(process.env.PORT ?? 4000),
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://loam_ledger:loam_ledger@localhost:5432/loam_ledger",
  corsAllowedOrigins: parseCsv(process.env.CORS_ALLOWED_ORIGINS, [
    "http://localhost:5173",
    "http://127.0.0.1:5173"
  ]),
  csrfSecret:
    process.env.CSRF_SECRET ??
    (process.env.NODE_ENV === "production" ? "" : "loam-ledger-local-dev-csrf-secret"),
  requireEmailVerification: parseBoolean(process.env.REQUIRE_EMAIL_VERIFICATION, isProduction),
  emailDeliveryMode: emailDeliveryMode as "development" | "resend",
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  emailFrom: process.env.EMAIL_FROM ?? "",
  usageRetentionDays: parseBoundedInteger(process.env.USAGE_RETENTION_DAYS, 90, 1, 365),
  usageRateLimitPerMinute: parseBoundedInteger(process.env.USAGE_RATE_LIMIT_PER_MINUTE, 30, 1, 300),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY, process.env.NODE_ENV === "production"),
  sessionCookieName: process.env.SESSION_COOKIE_NAME ?? "loam_ledger_session",
  sessionMaxAgeDays: parseSessionMaxAgeDays(process.env.SESSION_MAX_AGE_DAYS),
  sessionCookieSecure: parseBoolean(process.env.SESSION_COOKIE_SECURE, process.env.NODE_ENV === "production"),
  sessionCookieSameSite: parseSameSite(process.env.SESSION_COOKIE_SAMESITE),
  publicWebUrl: requiredProductionUrl(
    "PUBLIC_WEB_URL",
    isProduction ? process.env.PUBLIC_WEB_URL : process.env.PUBLIC_WEB_URL ?? process.env.APP_BASE_URL,
    "http://localhost:5173",
    isProduction
  ),
  publicApiUrl: requiredProductionUrl(
    "PUBLIC_API_URL",
    process.env.PUBLIC_API_URL,
    "http://localhost:4000",
    isProduction
  ),
  offlineImageryDir: resolveApiPath(process.env.OFFLINE_IMAGERY_DIR ?? "./offline-imagery-cache"),
  offlineImagerySourceUrl:
    process.env.OFFLINE_IMAGERY_SOURCE_URL ??
    "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
  offlineImageryContextSourceUrl:
    process.env.OFFLINE_IMAGERY_CONTEXT_SOURCE_URL ??
    process.env.OFFLINE_IMAGERY_SOURCE_URL ??
    "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
  offlineImageryDetailSourceUrl:
    process.env.OFFLINE_IMAGERY_DETAIL_SOURCE_URL ??
    "https://tiles.arcgis.com/tiles/hGdibHYSPO59RG1h/arcgis/rest/services/orthos2023/MapServer/tile/{z}/{y}/{x}",
  offlineImageryContextMinZoom: Number(
    process.env.OFFLINE_IMAGERY_CONTEXT_MIN_ZOOM ?? process.env.OFFLINE_IMAGERY_MIN_ZOOM ?? 14
  ),
  offlineImageryContextMaxZoom: Number(process.env.OFFLINE_IMAGERY_CONTEXT_MAX_ZOOM ?? 16),
  offlineImageryDetailMinZoom: Number(process.env.OFFLINE_IMAGERY_DETAIL_MIN_ZOOM ?? 17),
  offlineImageryDetailMaxZoom: Number(
    process.env.OFFLINE_IMAGERY_DETAIL_MAX_ZOOM ?? process.env.OFFLINE_IMAGERY_MAX_ZOOM ?? 20
  ),
  offlineImageryContextBufferMiles: Number(
    process.env.OFFLINE_IMAGERY_CONTEXT_BUFFER_MILES ?? process.env.OFFLINE_IMAGERY_BUFFER_MILES ?? 2
  ),
  offlineImageryDetailBufferMiles: Number(process.env.OFFLINE_IMAGERY_DETAIL_BUFFER_MILES ?? 0),
  offlineImageryMinZoom: Number(
    process.env.OFFLINE_IMAGERY_CONTEXT_MIN_ZOOM ?? process.env.OFFLINE_IMAGERY_MIN_ZOOM ?? 14
  ),
  offlineImageryMaxZoom: Number(
    process.env.OFFLINE_IMAGERY_DETAIL_MAX_ZOOM ?? process.env.OFFLINE_IMAGERY_MAX_ZOOM ?? 19
  ),
  offlineImageryBufferMiles: Number(
    process.env.OFFLINE_IMAGERY_CONTEXT_BUFFER_MILES ?? process.env.OFFLINE_IMAGERY_BUFFER_MILES ?? 2
  )
};

if (config.isProduction && !config.csrfSecret) {
  throw new Error("CSRF_SECRET is required when NODE_ENV=production");
}

if (config.isProduction && process.env.REQUIRE_EMAIL_VERIFICATION == null) {
  throw new Error("REQUIRE_EMAIL_VERIFICATION must be explicitly configured when NODE_ENV=production");
}

if (config.isProduction && !config.requireEmailVerification) {
  throw new Error("REQUIRE_EMAIL_VERIFICATION must be true for production deployments");
}

if (config.isProduction && config.emailDeliveryMode !== "resend") {
  throw new Error("EMAIL_DELIVERY_MODE=resend is required when NODE_ENV=production");
}

if (config.emailDeliveryMode === "resend" && (!config.resendApiKey || !config.emailFrom)) {
  throw new Error("RESEND_API_KEY and EMAIL_FROM are required when EMAIL_DELIVERY_MODE=resend");
}

if (config.sessionCookieSameSite === "None" && !config.sessionCookieSecure) {
  throw new Error("SESSION_COOKIE_SECURE=true is required when SESSION_COOKIE_SAMESITE=None");
}
