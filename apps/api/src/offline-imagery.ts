/**
 * Optional offline imagery helpers.
 *
 * The main app can use normal web basemaps, but these functions support a local
 * tile cache when the user chooses to pre-download imagery. The cache is stored
 * as z/x/y image files plus a manifest that describes what was downloaded.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

export type OfflineImageryBounds = {
  south: number;
  west: number;
  north: number;
  east: number;
};

export type OfflineImageryManifest = {
  available: boolean;
  generatedAt: string | null;
  sourceName: string;
  sourceUrl: string;
  contextSourceUrl: string;
  detailSourceUrl: string;
  minZoom: number;
  maxZoom: number;
  bufferMiles: number;
  fieldCount: number;
  tileCount: number;
  downloadedCount: number;
  skippedCount: number;
  missingCount: number;
  failedCount: number;
  bounds: OfflineImageryBounds | null;
  contextMinZoom: number;
  contextMaxZoom: number;
  contextBufferMiles: number;
  detailMinZoom: number;
  detailMaxZoom: number;
  detailBufferMiles: number;
};

export const OFFLINE_IMAGERY_MANIFEST = "manifest.json";

// Returned when no tile cache exists yet.
export function defaultOfflineImageryStatus(): OfflineImageryManifest {
  return {
    available: false,
    generatedAt: null,
    sourceName: "USGS Imagery Only",
    sourceUrl: config.offlineImagerySourceUrl,
    contextSourceUrl: config.offlineImageryContextSourceUrl,
    detailSourceUrl: config.offlineImageryDetailSourceUrl,
    minZoom: config.offlineImageryMinZoom,
    maxZoom: config.offlineImageryMaxZoom,
    bufferMiles: config.offlineImageryBufferMiles,
    fieldCount: 0,
    tileCount: 0,
    downloadedCount: 0,
    skippedCount: 0,
    missingCount: 0,
    failedCount: 0,
    bounds: null,
    contextMinZoom: config.offlineImageryContextMinZoom,
    contextMaxZoom: config.offlineImageryContextMaxZoom,
    contextBufferMiles: config.offlineImageryContextBufferMiles,
    detailMinZoom: config.offlineImageryDetailMinZoom,
    detailMaxZoom: config.offlineImageryDetailMaxZoom,
    detailBufferMiles: config.offlineImageryDetailBufferMiles
  };
}

export function manifestPath() {
  return path.join(config.offlineImageryDir, OFFLINE_IMAGERY_MANIFEST);
}

export function tileDirectoryPath(z: number, x: number) {
  return path.join(config.offlineImageryDir, String(z), String(x));
}

export function tileStoragePath(z: number, x: number, y: number, extension: string) {
  return path.join(tileDirectoryPath(z, x), `${y}.${extension}`);
}

export async function ensureOfflineImageryDir() {
  await fs.mkdir(config.offlineImageryDir, { recursive: true });
}

export async function readOfflineImageryManifest() {
  try {
    const raw = await fs.readFile(manifestPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<OfflineImageryManifest>;
    return {
      ...defaultOfflineImageryStatus(),
      ...parsed,
      available: Boolean(parsed.available)
    } satisfies OfflineImageryManifest;
  } catch {
    return null;
  }
}

export async function writeOfflineImageryManifest(manifest: OfflineImageryManifest) {
  await ensureOfflineImageryDir();
  await fs.writeFile(manifestPath(), JSON.stringify(manifest, null, 2));
}

export async function findCachedTilePath(z: number, x: number, y: number) {
  const candidates = ["jpg", "jpeg", "png", "webp"];

  for (const extension of candidates) {
    const filePath = tileStoragePath(z, x, y, extension);
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      continue;
    }
  }

  return null;
}

export function extensionToContentType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  return "image/jpeg";
}

// When a high-zoom tile is missing, reuse a lower-zoom tile so the map does not go blank.
export async function findBestCachedTile(
  z: number,
  x: number,
  y: number,
  minimumZoom = config.offlineImageryMinZoom
) {
  for (let sourceZoom = z; sourceZoom >= minimumZoom; sourceZoom -= 1) {
    const zoomDelta = z - sourceZoom;
    const divisor = 2 ** zoomDelta;
    const sourceX = Math.floor(x / divisor);
    const sourceY = Math.floor(y / divisor);
    const filePath = await findCachedTilePath(sourceZoom, sourceX, sourceY);

    if (filePath) {
      return {
        filePath,
        contentType: extensionToContentType(filePath),
        sourceZoom,
        sourceX,
        sourceY,
        zoomDelta
      };
    }
  }

  return null;
}

export function tileUrl(z: number, x: number, y: number, sourceUrl = config.offlineImagerySourceUrl) {
  return sourceUrl
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

export function longitudeToTileX(longitude: number, zoom: number) {
  const tileCount = 2 ** zoom;
  return Math.floor(((longitude + 180) / 360) * tileCount);
}

export function latitudeToTileY(latitude: number, zoom: number) {
  const clamped = Math.max(Math.min(latitude, 85.05112878), -85.05112878);
  const radians = clamped * (Math.PI / 180);
  const tileCount = 2 ** zoom;
  return Math.floor(((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * tileCount);
}

export function normalizeTileCoordinate(value: number, zoom: number) {
  const max = (2 ** zoom) - 1;
  return Math.max(0, Math.min(max, value));
}

export function contentTypeToExtension(contentType: string | null) {
  if (!contentType) {
    return "jpg";
  }

  if (contentType.includes("png")) {
    return "png";
  }

  if (contentType.includes("webp")) {
    return "webp";
  }

  return "jpg";
}

export function unionBounds(
  current: OfflineImageryBounds | null,
  next: OfflineImageryBounds
): OfflineImageryBounds {
  if (!current) {
    return next;
  }

  return {
    south: Math.min(current.south, next.south),
    west: Math.min(current.west, next.west),
    north: Math.max(current.north, next.north),
    east: Math.max(current.east, next.east)
  };
}
