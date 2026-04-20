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

function parseSameSite(value: string | undefined) {
  const normalized = (value ?? "lax").toLowerCase();
  if (normalized === "strict") return "Strict";
  if (normalized === "none") return "None";
  return "Lax";
}

// Lets config values use either absolute paths or paths relative to apps/api.
function resolveApiPath(input: string) {
  if (path.isAbsolute(input)) {
    return input;
  }

  return path.resolve(apiRoot, input);
}

export const config = {
  isProduction: process.env.NODE_ENV === "production",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://farmman:farmman@localhost:5432/farmman",
  corsAllowedOrigins: parseCsv(process.env.CORS_ALLOWED_ORIGINS, [
    "http://localhost:5173",
    "http://127.0.0.1:5173"
  ]),
  csrfSecret:
    process.env.CSRF_SECRET ??
    (process.env.NODE_ENV === "production" ? "" : "farmman-local-dev-csrf-secret"),
  sessionCookieName: process.env.SESSION_COOKIE_NAME ?? "farmman_session",
  sessionMaxAgeDays: Number(process.env.SESSION_MAX_AGE_DAYS ?? 14),
  sessionCookieSecure: parseBoolean(process.env.SESSION_COOKIE_SECURE, process.env.NODE_ENV === "production"),
  sessionCookieSameSite: parseSameSite(process.env.SESSION_COOKIE_SAMESITE),
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

if (config.sessionCookieSameSite === "None" && !config.sessionCookieSecure) {
  throw new Error("SESSION_COOKIE_SECURE=true is required when SESSION_COOKIE_SAMESITE=None");
}
