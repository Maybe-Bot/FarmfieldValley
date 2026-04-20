/**
 * Downloads map tiles around saved fields for the optional offline imagery mode.
 *
 * This is not required for normal web-based map use. It exists so the prototype
 * can be tested without internet in areas that have already been cached.
 */
import fs from "node:fs/promises";
import { config } from "../config";
import { pool } from "../db";
import {
  OfflineImageryBounds,
  contentTypeToExtension,
  ensureOfflineImageryDir,
  findCachedTilePath,
  latitudeToTileY,
  longitudeToTileX,
  normalizeTileCoordinate,
  tileDirectoryPath,
  tileStoragePath,
  tileUrl,
  unionBounds,
  writeOfflineImageryManifest
} from "../offline-imagery";

type FieldExtentRow = {
  id: number;
  name: string;
  south: string;
  west: string;
  north: string;
  east: string;
};

type TileCoordinate = {
  z: number;
  x: number;
  y: number;
};

type CoverageSpec = {
  label: "context" | "detail";
  minZoom: number;
  maxZoom: number;
  sourceUrl: string;
  boundsList: Array<{ id: number; name: string; bounds: OfflineImageryBounds }>;
};

const MAX_CONCURRENT_DOWNLOADS = 4;

async function fetchFieldBounds(bufferMiles: number) {
  const bufferMeters = bufferMiles * 1609.344;
  const result = await pool.query<FieldExtentRow>(
    `
      select
        id,
        name,
        ST_YMin(buffered) as south,
        ST_XMin(buffered) as west,
        ST_YMax(buffered) as north,
        ST_XMax(buffered) as east
      from (
        select
          id,
          name,
          ST_Transform(
            ST_Envelope(ST_Buffer(ST_Transform(boundary, 3857), $1)),
            4326
          ) as buffered
        from fields
        where boundary is not null
      ) extents
      order by id
    `,
    [bufferMeters]
  );

  return result.rows.map((row: FieldExtentRow) => ({
    id: row.id,
    name: row.name,
    bounds: {
      south: Number(row.south),
      west: Number(row.west),
      north: Number(row.north),
      east: Number(row.east)
    } satisfies OfflineImageryBounds
  }));
}

function buildTileList(specs: CoverageSpec[]) {
  const tiles = new Set<string>();
  let combinedBounds: OfflineImageryBounds | null = null;

  for (const spec of specs) {
    if (spec.minZoom > spec.maxZoom) {
      continue;
    }

    for (const field of spec.boundsList) {
      combinedBounds = unionBounds(combinedBounds, field.bounds);

      for (let zoom = spec.minZoom; zoom <= spec.maxZoom; zoom += 1) {
        const minX = normalizeTileCoordinate(longitudeToTileX(field.bounds.west, zoom), zoom);
        const maxX = normalizeTileCoordinate(longitudeToTileX(field.bounds.east, zoom), zoom);
        const minY = normalizeTileCoordinate(latitudeToTileY(field.bounds.north, zoom), zoom);
        const maxY = normalizeTileCoordinate(latitudeToTileY(field.bounds.south, zoom), zoom);

        for (let x = minX; x <= maxX; x += 1) {
          for (let y = minY; y <= maxY; y += 1) {
            tiles.add(`${zoom}/${x}/${y}`);
          }
        }
      }
    }
  }

  return {
    bounds: combinedBounds,
    tiles: Array.from(tiles, (entry) => {
      const [z, x, y] = entry.split("/").map(Number);
      return { z, x, y } satisfies TileCoordinate;
    })
  };
}

async function downloadTile(tile: TileCoordinate, sourceUrl: string) {
  const cached = await findCachedTilePath(tile.z, tile.x, tile.y);
  if (cached) {
    return { status: "cached" as const };
  }

  const response = await fetch(tileUrl(tile.z, tile.x, tile.y, sourceUrl));
  if (response.status === 404) {
    return { status: "missing" as const };
  }

  if (!response.ok) {
    throw new Error(`Tile ${tile.z}/${tile.x}/${tile.y} failed with ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = contentTypeToExtension(response.headers.get("content-type"));
  const directory = tileDirectoryPath(tile.z, tile.x);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(tileStoragePath(tile.z, tile.x, tile.y, extension), buffer);
  return { status: "downloaded" as const };
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
) {
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });

  await Promise.all(runners);
}

async function run() {
  await ensureOfflineImageryDir();

  const [contextBounds, detailBounds] = await Promise.all([
    fetchFieldBounds(config.offlineImageryContextBufferMiles),
    fetchFieldBounds(config.offlineImageryDetailBufferMiles)
  ]);
  const specs: CoverageSpec[] = [
    {
      label: "context",
      minZoom: config.offlineImageryContextMinZoom,
      maxZoom: config.offlineImageryContextMaxZoom,
      sourceUrl: config.offlineImageryContextSourceUrl,
      boundsList: contextBounds
    },
    {
      label: "detail",
      minZoom: config.offlineImageryDetailMinZoom,
      maxZoom: config.offlineImageryDetailMaxZoom,
      sourceUrl: config.offlineImageryDetailSourceUrl,
      boundsList: detailBounds
    }
  ];
  const { bounds, tiles } = buildTileList(specs);
  const tileSourceByKey = new Map<string, string>();
  for (const spec of specs) {
    for (const field of spec.boundsList) {
      for (let zoom = spec.minZoom; zoom <= spec.maxZoom; zoom += 1) {
        const minX = normalizeTileCoordinate(longitudeToTileX(field.bounds.west, zoom), zoom);
        const maxX = normalizeTileCoordinate(longitudeToTileX(field.bounds.east, zoom), zoom);
        const minY = normalizeTileCoordinate(latitudeToTileY(field.bounds.north, zoom), zoom);
        const maxY = normalizeTileCoordinate(latitudeToTileY(field.bounds.south, zoom), zoom);
        for (let x = minX; x <= maxX; x += 1) {
          for (let y = minY; y <= maxY; y += 1) {
            tileSourceByKey.set(`${zoom}/${x}/${y}`, spec.sourceUrl);
          }
        }
      }
    }
  }

  let downloadedCount = 0;
  let skippedCount = 0;
  let missingCount = 0;
  let failedCount = 0;

  console.log(`Caching ${tiles.length} tiles for ${detailBounds.length} fields from ${config.offlineImagerySourceUrl}`);
  console.log(
    `Context: zoom ${config.offlineImageryContextMinZoom}-${config.offlineImageryContextMaxZoom} with ${config.offlineImageryContextBufferMiles} mile buffer`
  );
  console.log(
    `Detail: zoom ${config.offlineImageryDetailMinZoom}-${config.offlineImageryDetailMaxZoom} with ${config.offlineImageryDetailBufferMiles} mile buffer`
  );

  await runWithConcurrency(tiles, MAX_CONCURRENT_DOWNLOADS, async (tile, index) => {
    try {
      const sourceUrl = tileSourceByKey.get(`${tile.z}/${tile.x}/${tile.y}`) ?? config.offlineImageryContextSourceUrl;
      const result = await downloadTile(tile, sourceUrl);
      if (result.status === "downloaded") {
        downloadedCount += 1;
      } else if (result.status === "missing") {
        missingCount += 1;
      } else {
        skippedCount += 1;
      }

      if ((index + 1) % 250 === 0 || index === tiles.length - 1) {
        console.log(
          `Processed ${index + 1}/${tiles.length} tiles ` +
          `(downloaded ${downloadedCount}, cached ${skippedCount}, missing ${missingCount}, failed ${failedCount})`
        );
      }
    } catch (error) {
      failedCount += 1;
      console.error(`Failed tile ${tile.z}/${tile.x}/${tile.y}`, error);
    }
  });

  await writeOfflineImageryManifest({
    available: tiles.length > 0 && downloadedCount + skippedCount > 0,
    generatedAt: new Date().toISOString(),
    sourceName: "USGS Imagery Only",
    sourceUrl: config.offlineImagerySourceUrl,
    contextSourceUrl: config.offlineImageryContextSourceUrl,
    detailSourceUrl: config.offlineImageryDetailSourceUrl,
    minZoom: config.offlineImageryMinZoom,
    maxZoom: config.offlineImageryMaxZoom,
    bufferMiles: config.offlineImageryBufferMiles,
    fieldCount: detailBounds.length,
    tileCount: tiles.length,
    downloadedCount,
    skippedCount,
    missingCount,
    failedCount,
    bounds,
    contextMinZoom: config.offlineImageryContextMinZoom,
    contextMaxZoom: config.offlineImageryContextMaxZoom,
    contextBufferMiles: config.offlineImageryContextBufferMiles,
    detailMinZoom: config.offlineImageryDetailMinZoom,
    detailMaxZoom: config.offlineImageryDetailMaxZoom,
    detailBufferMiles: config.offlineImageryDetailBufferMiles
  });

  await pool.end();

  console.log(
    `Imagery cache complete: downloaded ${downloadedCount}, cached ${skippedCount}, missing ${missingCount}, failed ${failedCount}`
  );

  if (failedCount > 0) {
    process.exitCode = 1;
  }
}

run().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
