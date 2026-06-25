import { PoolClient } from "pg";
import { SpreadsheetRow } from "./spreadsheet-file-parser";
import { taskFlowScheduleProblem, validateTaskFlowGraph } from "./task-flow-validation";
import { isCurrentTaskType, isLegacyTaskType } from "./types";

type DbClient = PoolClient;
type SheetRow = Record<string, string>;
type SheetMap = Map<string, SheetRow[]>;

type FullBackupImportDeps = {
  upsertCropAndVariety: (client: DbClient, cropName: string, varietyName: string) => Promise<{ cropId: number; varietyId: number | null }>;
  learnSeedItemSpacing: (client: DbClient, farmId: number, seedItemId: number | null, spacing: string | null, fieldSpacingInRow: number | null, rowSpacing: number | null, rowsPerBed: number | null) => Promise<void>;
};

const GEOJSON_TOLERANCE_DEGREES = 0.000003;

function cleanCell(value: string | undefined) {
  return (value ?? "").trim();
}

function numberOrNull(value: string | null | undefined) {
  const clean = (value ?? "").trim();
  if (!clean) return null;
  const numeric = Number(clean);
  return Number.isFinite(numeric) ? numeric : null;
}

function integerOrNull(value: string | null | undefined) {
  const numeric = numberOrNull(value);
  return numeric == null ? null : Math.round(numeric);
}

function dateOrNull(value: string | null | undefined) {
  const clean = (value ?? "").trim();
  return clean ? clean.slice(0, 10) : null;
}

function textOrNull(value: string | null | undefined) {
  const clean = (value ?? "").trim();
  return clean || null;
}

function requireCurrentTaskType(value: string | null | undefined, label: string) {
  const taskType = textOrNull(value);
  if (!taskType) {
    throw new Error(`${label} is missing a task category.`);
  }
  if (!isCurrentTaskType(taskType)) {
    throw new Error(isLegacyTaskType(taskType)
      ? `${label} uses old task category "${taskType}". Update the backup or task flow to current categories before importing.`
      : `${label} uses unknown task category "${taskType}". Update the backup or task flow to current categories before importing.`);
  }
  return taskType;
}

function requireCurrentTaskAnchor(value: string | null | undefined, label: string) {
  const anchor = textOrNull(value) ?? "planned_sow";
  if (anchor === "planned_sow" || anchor.startsWith("after:")) {
    return anchor;
  }
  throw new Error(`${label} uses old scheduling anchor "${anchor}". Update it to seeding date or an arrow dependency before importing.`);
}

function booleanFromExport(value: string | null | undefined) {
  const clean = (value ?? "").trim().toLowerCase();
  return clean === "true" || clean === "t" || clean === "1" || clean === "yes";
}

function plannedUseFromExport(value: string | null | undefined) {
  const clean = (value ?? "").trim();
  return clean === "beds" || clean === "cover_crop" ? clean : null;
}

function idFromExport(value: string | null | undefined) {
  const numeric = Number((value ?? "").trim());
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function hasExportedColumn(row: SheetRow, column: string) {
  return Object.prototype.hasOwnProperty.call(row, column);
}

function hasAnyPlantingDetailData(detail: SheetRow) {
  return [
    "seedItemId",
    "taskFlowTemplateId",
    "intendedFieldId",
    "intendedBlockId",
    "intendedBedId"
  ].some((column) => idFromExport(detail[column]) != null) || [
    "title",
    "status",
    "spacing",
    "trayLocation",
    "bedCover",
    "notes"
  ].some((column) => textOrNull(detail[column]) != null) || [
    "plannedSowDate",
    "plannedTransplantDate",
    "expectedHarvestStart",
    "expectedHarvestEnd",
    "actualTraySeedingDate",
    "actualDirectSeedingDate",
    "actualTransplantDate",
    "actualHarvestDate",
    "actualFinishDate"
  ].some((column) => dateOrNull(detail[column]) != null) || [
    "trayCount",
    "cellsPerTray",
    "daysToHarvest",
    "fieldSpacingInRow",
    "rowSpacing",
    "rowsPerBed"
  ].some((column) => numberOrNull(detail[column]) != null);
}

function rowsBySheet(rows: SpreadsheetRow[]): SheetMap {
  const grouped = new Map<string, SpreadsheetRow[]>();
  for (const row of rows) {
    grouped.set(row.sheet, [...(grouped.get(row.sheet) ?? []), row]);
  }

  const sheets: SheetMap = new Map();
  for (const [sheetName, sheetRows] of grouped) {
    const headerRow = sheetRows.find((row) => row.cells.some((cell) => cell.trim()));
    if (!headerRow) continue;
    const headers = headerRow.cells.map((cell) => cell.trim());
    const records = sheetRows
      .filter((row) => row.rowIndex > headerRow.rowIndex)
      .map((row) => Object.fromEntries(headers.map((header, index) => [header, cleanCell(row.cells[index])])))
      .filter((row) => Object.values(row).some((value) => value.trim()));
    sheets.set(sheetName, records);
  }
  return sheets;
}

function validateTaskFlowSheets(sheets: SheetMap) {
  const nodesByOldFlowId = new Map<number, Array<{ nodeKey: string; taskType: string; label: string }>>();
  for (const row of sheets.get("Task Flow Nodes") ?? []) {
    const oldId = idFromExport(row.id);
    const oldFlowId = idFromExport(row.flowTemplateId);
    if (!oldId || !oldFlowId) continue;
    const node = {
      nodeKey: textOrNull(row.nodeKey) ?? `node-${oldId}`,
      taskType: requireCurrentTaskType(row.taskType, `Task Flow Nodes row ${oldId}`),
      label: textOrNull(row.label) ?? "Imported task"
    };
    requireCurrentTaskAnchor(row.anchor, `Task Flow Nodes row ${oldId}`);
    nodesByOldFlowId.set(oldFlowId, [...(nodesByOldFlowId.get(oldFlowId) ?? []), node]);
  }

  const edgesByOldFlowId = new Map<number, Array<{ fromNodeKey: string; toNodeKey: string; delayDays: number }>>();
  for (const row of sheets.get("Task Flow Edges") ?? []) {
    const oldId = idFromExport(row.id);
    const oldFlowId = idFromExport(row.flowTemplateId);
    if (!oldFlowId) continue;
    edgesByOldFlowId.set(oldFlowId, [
      ...(edgesByOldFlowId.get(oldFlowId) ?? []),
      {
        fromNodeKey: textOrNull(row.fromNodeKey) ?? "",
        toNodeKey: textOrNull(row.toNodeKey) ?? "",
        delayDays: Math.max(0, Math.min(9999, numberOrNull(row.delayDays) ?? 0))
      }
    ]);
    if (oldId == null && (textOrNull(row.fromNodeKey) == null || textOrNull(row.toNodeKey) == null)) {
      throw new Error("Task Flow Edges row is missing a task-flow edge id or node key.");
    }
  }

  const oldFlowIds = new Set([...nodesByOldFlowId.keys(), ...edgesByOldFlowId.keys()]);
  for (const oldFlowId of oldFlowIds) {
    const nodes = nodesByOldFlowId.get(oldFlowId) ?? [];
    const edges = edgesByOldFlowId.get(oldFlowId) ?? [];
    try {
      validateTaskFlowGraph(nodes, edges);
      const scheduleProblem = taskFlowScheduleProblem(nodes, edges);
      if (scheduleProblem) {
        throw new Error(scheduleProblem);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid task-flow graph.";
      throw new Error(`Task Flows row ${oldFlowId}: ${message}`);
    }
  }
}

export function hasFullBackupSheets(rows: SpreadsheetRow[]) {
  const sheetNames = new Set(rows.map((row) => row.sheet));
  return sheetNames.has("Fields") && sheetNames.has("Blocks") && sheetNames.has("Beds") && sheetNames.has("Planting Details");
}

function geoJsonText(value: string | null | undefined) {
  const clean = (value ?? "").trim();
  if (!clean) return null;
  try {
    const parsed = JSON.parse(clean);
    if (parsed && parsed.type === "Polygon" && Array.isArray(parsed.coordinates)) {
      return JSON.stringify(parsed);
    }
  } catch (_error) {
    return null;
  }
  return null;
}

async function findDuplicatePolygon(
  client: DbClient,
  options: {
    tableName: "fields" | "blocks" | "beds";
    farmId: number;
    name: string;
    boundary: string;
    parentColumn?: "field_id" | "block_id";
    parentId?: number | null;
  }
) {
  const parentClause = options.parentColumn ? `and target.${options.parentColumn} = $4` : "";
  const params: Array<string | number> = [options.farmId, options.name, options.boundary];
  if (options.parentColumn) {
    params.push(options.parentId ?? 0);
  }
  const result = await client.query<{ id: number }>(
    `
      select target.id
      from ${options.tableName} target
      ${options.tableName === "fields" ? "" : options.tableName === "blocks" ? "join fields field on field.id = target.field_id" : "join blocks block on block.id = target.block_id join fields field on field.id = block.field_id"}
      where ${options.tableName === "fields" ? "target.farm_id" : "field.farm_id"} = $1
        and lower(target.name) = lower($2)
        ${parentClause}
        and target.boundary is not null
        and ST_HausdorffDistance(target.boundary, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)) <= ${GEOJSON_TOLERANCE_DEGREES}
      order by target.id
      limit 1
    `,
    params
  );
  const geometryDuplicateId = result.rows[0]?.id ?? null;
  if (geometryDuplicateId != null) {
    return geometryDuplicateId;
  }

  const nameParams: Array<string | number> = [options.farmId, options.name];
  const nameParentClause = options.parentColumn ? `and target.${options.parentColumn} = $3` : "";
  if (options.parentColumn) {
    nameParams.push(options.parentId ?? 0);
  }
  const nameResult = await client.query<{ id: number }>(
    `
      select target.id
      from ${options.tableName} target
      ${options.tableName === "fields" ? "" : options.tableName === "blocks" ? "join fields field on field.id = target.field_id" : "join blocks block on block.id = target.block_id join fields field on field.id = block.field_id"}
      where ${options.tableName === "fields" ? "target.farm_id" : "field.farm_id"} = $1
        and lower(target.name) = lower($2)
        ${nameParentClause}
      order by target.id
      limit 1
    `,
    nameParams
  );
  return nameResult.rows[0]?.id ?? null;
}


async function upsertSeedItemFromExport(
  client: DbClient,
  farmId: number,
  row: SheetRow,
  cropId: number | null,
  varietyId: number | null
) {
  const cropType = textOrNull(row.cropType) ?? "Imported seed";
  const varietyName = textOrNull(row.varietyName);
  const supplier = textOrNull(row.supplier);
  const catalogNumber = textOrNull(row.catalogNumber);
  const existing = await client.query<{ id: number }>(
    `
      select id
      from seed_items
      where farm_id = $1
        and lower(crop_type) = lower($2)
        and lower(coalesce(variety_name, '')) = lower($3)
        and lower(coalesce(breed_name, '')) = lower($4)
        and lower(coalesce(supplier, '')) = lower($5)
        and lower(coalesce(catalog_number, '')) = lower($6)
      limit 1
    `,
    [farmId, cropType, varietyName ?? "", textOrNull(row.breedName) ?? "", supplier ?? "", catalogNumber ?? ""]
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  const result = await client.query<{ id: number }>(
    `
      insert into seed_items (
        farm_id, crop_id, variety_id, crop_type, variety_name, breed_name,
        family, supplier, catalog_number, lot_number, stock_quantity,
        days_to_maturity, usual_spacing, usual_field_spacing_in_row,
        usual_row_spacing, usual_rows_per_bed, archived_at, notes
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      returning id
    `,
    [
      farmId,
      cropId,
      varietyId,
      cropType,
      varietyName,
      textOrNull(row.breedName),
      textOrNull(row.family),
      supplier,
      catalogNumber,
      textOrNull(row.lotNumber),
      integerOrNull(row.stockQuantity),
      integerOrNull(row.daysToMaturity),
      textOrNull(row.usualSpacing),
      numberOrNull(row.usualFieldSpacingInRow),
      numberOrNull(row.usualRowSpacing),
      integerOrNull(row.usualRowsPerBed),
      textOrNull(row.archivedAt),
      textOrNull(row.notes)
    ]
  );
  return result.rows[0].id;
}


async function upsertSimpleByName(client: DbClient, sql: string, params: unknown[]) {
  const result = await client.query<{ id: number }>(sql, params);
  return result.rows[0].id;
}

export async function importFullBackupSpreadsheetRowsForFarm(
  client: DbClient,
  rows: SpreadsheetRow[],
  farmId: number,
  deps: FullBackupImportDeps
) {
  const { upsertCropAndVariety, learnSeedItemSpacing } = deps;
  const sheets = rowsBySheet(rows);
  validateTaskFlowSheets(sheets);
  const idMaps = {
    fields: new Map<number, number>(),
    blocks: new Map<number, number>(),
    zones: new Map<number, number>(),
    beds: new Map<number, number>(),
    bedPresets: new Map<number, number>(),
    coverCrops: new Map<number, number>(),
    crops: new Map<number, number>(),
    seedItems: new Map<number, number>(),
    plantings: new Map<number, number>(),
    placements: new Map<number, number>(),
    tasks: new Map<number, number>(),
    vehicles: new Map<number, number>(),
    taskFlows: new Map<number, number>(),
    taskFlowNodes: new Map<number, number>()
  };
  const counts = {
    parsedRows: rows.filter((row) => row.rowIndex > 1).length,
    importedPlantings: 0,
    skippedRows: 0,
    incompleteRows: 0,
    importedFields: 0,
    skippedDuplicateFields: 0,
    importedBlocks: 0,
    skippedDuplicateBlocks: 0,
    importedBeds: 0,
    skippedDuplicateBeds: 0,
    importedRecords: 0,
    importedVehicles: 0,
    warnings: [] as string[]
  };
  const addWarning = (message: string) => {
    counts.warnings.push(message);
  };

  const farmRow = sheets.get("Farm")?.[0];
  if (farmRow) {
    await client.query(
      `
        update farms
        set name = coalesce($2, name),
            notes = $3,
            maps_private = $4,
            updated_at = now()
        where id = $1
      `,
      [
        farmId,
        textOrNull(farmRow.name),
        textOrNull(farmRow.notes),
        farmRow.mapsPrivate == null || farmRow.mapsPrivate.trim() === "" ? true : booleanFromExport(farmRow.mapsPrivate)
      ]
    );
    counts.importedRecords += 1;
  }

  for (const row of sheets.get("Bed Presets") ?? []) {
    const oldId = idFromExport(row.id);
    const id = await upsertSimpleByName(
      client,
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
      [
        farmId,
        textOrNull(row.name) ?? "Imported bed preset",
        numberOrNull(row.bedWidthM) ?? 0.76,
        numberOrNull(row.pathSpacingM) ?? 0.46,
        booleanFromExport(row.isRoad),
        textOrNull(row.notes)
      ]
    );
    if (oldId) idMaps.bedPresets.set(oldId, id);
  }

  for (const row of sheets.get("Cover Crops") ?? []) {
    const oldId = idFromExport(row.id);
    const id = await upsertSimpleByName(
      client,
      `
        insert into cover_crop_names (farm_id, name, notes)
        values ($1, $2, $3)
        on conflict (farm_id, name) do update
        set notes = coalesce(cover_crop_names.notes, excluded.notes),
            updated_at = now()
        returning id
      `,
      [farmId, textOrNull(row.name) ?? "Imported cover crop", textOrNull(row.notes)]
    );
    if (oldId) idMaps.coverCrops.set(oldId, id);
  }

  for (const row of sheets.get("Fields") ?? []) {
    const oldId = idFromExport(row.id);
    const boundary = geoJsonText(row.boundary);
    if (!oldId || !boundary) {
      counts.skippedRows += 1;
      addWarning(`Skipped Fields row ${row.id || "unknown"} because it was missing an id or valid polygon boundary.`);
      continue;
    }
    const name = textOrNull(row.name) ?? `Imported field ${oldId}`;
    const duplicateId = await findDuplicatePolygon(client, { tableName: "fields", farmId, name, boundary });
    if (duplicateId) {
      idMaps.fields.set(oldId, duplicateId);
      counts.skippedDuplicateFields += 1;
      continue;
    }
    const result = await client.query<{ id: number }>(
      `
        with input as (select ST_SetSRID(ST_GeomFromGeoJSON($4), 4326) as boundary)
        insert into fields (farm_id, name, notes, x, y, width, height, geom, boundary, centroid, area_sqm)
        select
          $1, $2, $3,
          ST_XMin(boundary)::numeric(10,2),
          ST_YMin(boundary)::numeric(10,2),
          (ST_XMax(boundary) - ST_XMin(boundary))::numeric(10,2),
          (ST_YMax(boundary) - ST_YMin(boundary))::numeric(10,2),
          ST_Transform(boundary, 3857),
          boundary,
          ST_Centroid(boundary),
          ST_Area(boundary::geography)
        from input
        returning id
      `,
      [farmId, name, textOrNull(row.notes), boundary]
    );
    idMaps.fields.set(oldId, result.rows[0].id);
    counts.importedFields += 1;
  }

  for (const row of sheets.get("Blocks") ?? []) {
    const oldId = idFromExport(row.id);
    const oldFieldId = idFromExport(row.fieldId);
    const fieldId = oldFieldId == null ? null : idMaps.fields.get(oldFieldId);
    const boundary = geoJsonText(row.boundary);
    if (!oldId || !fieldId || !boundary) {
      counts.skippedRows += 1;
      addWarning(`Skipped Blocks row ${row.id || "unknown"} because it was missing a valid field reference or polygon boundary.`);
      continue;
    }
    const name = textOrNull(row.name) ?? `Imported block ${oldId}`;
    const duplicateId = await findDuplicatePolygon(client, { tableName: "blocks", farmId, name, boundary, parentColumn: "field_id", parentId: fieldId });
    if (duplicateId) {
      idMaps.blocks.set(oldId, duplicateId);
      counts.skippedDuplicateBlocks += 1;
      continue;
    }
    const result = await client.query<{ id: number }>(
      `
        with input as (select ST_SetSRID(ST_GeomFromGeoJSON($4), 4326) as boundary)
        insert into blocks (field_id, name, notes, bed_start_entrance_side, x, y, width, height, geom, boundary, centroid, area_sqm)
        select
          $1, $2, $3, $5,
          ST_XMin(boundary)::numeric(10,2),
          ST_YMin(boundary)::numeric(10,2),
          (ST_XMax(boundary) - ST_XMin(boundary))::numeric(10,2),
          (ST_YMax(boundary) - ST_YMin(boundary))::numeric(10,2),
          ST_Transform(boundary, 3857),
          boundary,
          ST_Centroid(boundary),
          ST_Area(boundary::geography)
        from input
        returning id
      `,
      [fieldId, name, textOrNull(row.notes), boundary, row.bedStartEntranceSide === "end" ? "end" : "start"]
    );
    idMaps.blocks.set(oldId, result.rows[0].id);
    counts.importedBlocks += 1;
  }

  for (const row of sheets.get("Block Areas") ?? []) {
    const oldId = idFromExport(row.id);
    const oldBlockId = idFromExport(row.blockId);
    const blockId = oldBlockId == null ? null : idMaps.blocks.get(oldBlockId);
    const boundary = geoJsonText(row.boundary);
    if (!oldId || !blockId || !boundary) {
      counts.skippedRows += 1;
      addWarning(`Skipped Block Areas row ${row.id || "unknown"} because it was missing a valid block reference or polygon boundary.`);
      continue;
    }
    const oldCoverCropId = idFromExport(row.coverCropNameId);
    const result = await client.query<{ id: number }>(
      `
        with input as (select ST_SetSRID(ST_GeomFromGeoJSON($11), 4326) as boundary)
        insert into block_zones (
          block_id, cover_crop_name_id, name, planned_use, actual_state, notes,
          planned_cover_crop_seed_date, planned_cover_crop_terminate_date,
          actual_cover_crop_seed_date, actual_cover_crop_terminate_date,
          x, y, width, height, geom, boundary, centroid, area_sqm
        )
        select
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          ST_XMin(boundary)::numeric(10,2),
          ST_YMin(boundary)::numeric(10,2),
          (ST_XMax(boundary) - ST_XMin(boundary))::numeric(10,2),
          (ST_YMax(boundary) - ST_YMin(boundary))::numeric(10,2),
          ST_Transform(boundary, 3857),
          boundary,
          ST_Centroid(boundary),
          ST_Area(boundary::geography)
        from input
        returning id
      `,
      [
        blockId,
        oldCoverCropId == null ? null : idMaps.coverCrops.get(oldCoverCropId) ?? null,
        textOrNull(row.name) ?? `Imported area ${oldId}`,
        plannedUseFromExport(row.plannedUse),
        textOrNull(row.actualState) ?? "needs_cleanup",
        textOrNull(row.notes),
        dateOrNull(row.plannedCoverCropSeedDate),
        dateOrNull(row.plannedCoverCropTerminateDate),
        dateOrNull(row.actualCoverCropSeedDate),
        dateOrNull(row.actualCoverCropTerminateDate),
        boundary
      ]
    );
    idMaps.zones.set(oldId, result.rows[0].id);
    counts.importedRecords += 1;
  }

  for (const row of sheets.get("Beds") ?? []) {
    const oldId = idFromExport(row.id);
    const oldBlockId = idFromExport(row.blockId);
    const blockId = oldBlockId == null ? null : idMaps.blocks.get(oldBlockId);
    const boundary = geoJsonText(row.boundary);
    const bedLengthM = numberOrNull(row.bedLengthM);
    if (!oldId || !blockId || !boundary || bedLengthM == null || bedLengthM <= 0) {
      counts.skippedRows += 1;
      addWarning(`Skipped Beds row ${row.id || "unknown"} because it was missing a valid block, polygon boundary, or positive bed length.`);
      continue;
    }
    const name = textOrNull(row.name) ?? `Imported bed ${oldId}`;
    const duplicateId = await findDuplicatePolygon(client, { tableName: "beds", farmId, name, boundary, parentColumn: "block_id", parentId: blockId });
    if (duplicateId) {
      idMaps.beds.set(oldId, duplicateId);
      counts.skippedDuplicateBeds += 1;
      continue;
    }
    const oldPresetId = idFromExport(row.bedPresetId);
    const oldZoneId = idFromExport(row.zoneId);
    const result = await client.query<{ id: number }>(
      `
        with input as (select ST_SetSRID(ST_GeomFromGeoJSON($8), 4326) as boundary)
        insert into beds (
          block_id, zone_id, name, source, sequence_no, bed_preset_id, bed_length_m, area_sqm, notes,
          x, y, width, height, geom, boundary, centroid
        )
        select
          $1, $2, $3, $4, $5, $6, $7, ST_Area(boundary::geography), $9,
          ST_XMin(boundary)::numeric(10,2),
          ST_YMin(boundary)::numeric(10,2),
          (ST_XMax(boundary) - ST_XMin(boundary))::numeric(10,2),
          (ST_YMax(boundary) - ST_YMin(boundary))::numeric(10,2),
          ST_Transform(boundary, 3857),
          boundary,
          ST_Centroid(boundary)
        from input
        returning id
      `,
      [
        blockId,
        oldZoneId == null ? null : idMaps.zones.get(oldZoneId) ?? null,
        name,
        textOrNull(row.source) ?? "manual",
        integerOrNull(row.sequenceNo),
        oldPresetId == null ? null : idMaps.bedPresets.get(oldPresetId) ?? null,
        bedLengthM,
        boundary,
        textOrNull(row.notes)
      ]
    );
    idMaps.beds.set(oldId, result.rows[0].id);
    counts.importedBeds += 1;
  }

  for (const row of sheets.get("Seed Bank") ?? []) {
    const oldId = idFromExport(row.id);
    if (!oldId) continue;
    const oldCropId = idFromExport(row.cropId);
    const cropName = textOrNull(row.cropType);
    const varietyName = textOrNull(row.varietyName) ?? textOrNull(row.breedName) ?? "";
    const ids = cropName ? await upsertCropAndVariety(client, cropName, varietyName) : { cropId: null, varietyId: null };
    if (oldCropId != null && ids.cropId != null) {
      idMaps.crops.set(oldCropId, ids.cropId);
    }
    const seedId = await upsertSeedItemFromExport(client, farmId, row, ids.cropId, ids.varietyId);
    idMaps.seedItems.set(oldId, seedId);
    counts.importedRecords += 1;
  }

  for (const row of sheets.get("Seed Lots") ?? []) {
    const oldSeedId = idFromExport(row.seedItemId);
    const seedItemId = oldSeedId == null ? null : idMaps.seedItems.get(oldSeedId);
    const lotNumber = textOrNull(row.lotNumber);
    if (!seedItemId || !lotNumber) continue;
    await client.query(
      `
        insert into seed_item_lots (seed_item_id, lot_number, stock_quantity)
        values ($1, $2, $3)
        on conflict (seed_item_id, lot_number) do update
        set stock_quantity = excluded.stock_quantity,
            updated_at = now()
      `,
      [seedItemId, lotNumber, integerOrNull(row.stockQuantity)]
    );
    counts.importedRecords += 1;
  }

  for (const row of sheets.get("Vehicles") ?? []) {
    const oldId = idFromExport(row.id);
    const name = textOrNull(row.name);
    if (!oldId || !name) continue;
    const profile = {
      name,
      tractorModel: textOrNull(row.tractorModel) ?? "cab",
      iconColor: textOrNull(row.iconColor) ?? "#d98c2b",
      iconSecondaryColor: textOrNull(row.iconSecondaryColor) ?? "#f4c430"
    };
    const result = await client.query<{ id: number }>(
      `
        insert into tractor_profiles (farm_id, name, tractor_model, icon_color, icon_secondary_color)
        values ($1, $2, $3, $4, $5)
        on conflict (farm_id, name) do update
        set tractor_model = excluded.tractor_model,
            icon_color = excluded.icon_color,
            icon_secondary_color = excluded.icon_secondary_color
        returning id
      `,
      [
        farmId,
        profile.name,
        profile.tractorModel,
        profile.iconColor,
        profile.iconSecondaryColor
      ]
    );
    idMaps.vehicles.set(oldId, result.rows[0].id);
    counts.importedVehicles += 1;
  }

  const taskFlowSourceUpdates: Array<{ id: number; oldSourceId: number | null }> = [];
  for (const row of sheets.get("Task Flows") ?? []) {
    const oldId = idFromExport(row.id);
    if (!oldId) continue;
    const oldCropId = idFromExport(row.cropId);
    const cropName = textOrNull(row.cropName);
    let cropId = oldCropId == null ? null : idMaps.crops.get(oldCropId) ?? null;
    if (cropId == null && cropName != null) {
      const ids = await upsertCropAndVariety(client, cropName, "");
      cropId = ids.cropId;
      if (oldCropId != null) {
        idMaps.crops.set(oldCropId, cropId);
      }
    }
    const result = await client.query<{ id: number }>(
      `
        insert into task_flow_templates (farm_id, crop_id, name, notes, is_default)
        values ($1, $2, $3, $4, $5)
        on conflict (farm_id, name) do update
        set crop_id = excluded.crop_id,
            notes = excluded.notes,
            is_default = excluded.is_default,
            updated_at = now()
        returning id
      `,
      [farmId, cropId, textOrNull(row.name) ?? `Imported flow ${oldId}`, textOrNull(row.notes), booleanFromExport(row.isDefault)]
    );
    idMaps.taskFlows.set(oldId, result.rows[0].id);
    if (hasExportedColumn(row, "sourceTaskFlowTemplateId")) {
      taskFlowSourceUpdates.push({
        id: result.rows[0].id,
        oldSourceId: idFromExport(row.sourceTaskFlowTemplateId)
      });
    }
    counts.importedRecords += 1;
  }
  for (const update of taskFlowSourceUpdates) {
    await client.query(
      `update task_flow_templates set source_task_flow_template_id = $2, updated_at = now() where id = $1`,
      [update.id, update.oldSourceId == null ? null : idMaps.taskFlows.get(update.oldSourceId) ?? null]
    );
  }

  for (const row of sheets.get("Task Flow Nodes") ?? []) {
    const oldId = idFromExport(row.id);
    const oldFlowId = idFromExport(row.flowTemplateId);
    const flowTemplateId = oldFlowId == null ? null : idMaps.taskFlows.get(oldFlowId);
    if (!oldId || !flowTemplateId) continue;
    const oldVehicleId = idFromExport(row.tractorProfileId);
    const taskType = requireCurrentTaskType(row.taskType, `Task Flow Nodes row ${oldId}`);
    const anchor = requireCurrentTaskAnchor(row.anchor, `Task Flow Nodes row ${oldId}`);
    const result = await client.query<{ id: number }>(
      `
        insert into task_flow_nodes (
          flow_template_id, node_key, task_type, label, anchor, offset_days,
          x_pos, y_pos, tractor_model, tractor_profile_id, icon_color, icon_secondary_color, notes
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        on conflict (flow_template_id, node_key) do update
        set task_type = excluded.task_type,
            label = excluded.label,
            anchor = excluded.anchor,
            offset_days = excluded.offset_days,
            x_pos = excluded.x_pos,
            y_pos = excluded.y_pos,
            tractor_model = excluded.tractor_model,
            tractor_profile_id = excluded.tractor_profile_id,
            icon_color = excluded.icon_color,
            icon_secondary_color = excluded.icon_secondary_color,
            notes = excluded.notes,
            updated_at = now()
        returning id
      `,
      [
        flowTemplateId,
        textOrNull(row.nodeKey) ?? `node-${oldId}`,
        taskType,
        textOrNull(row.label) ?? "Imported task",
        anchor,
        integerOrNull(row.offsetDays) ?? 0,
        numberOrNull(row.x) ?? 0.5,
        numberOrNull(row.y) ?? 0.5,
        textOrNull(row.tractorModel),
        oldVehicleId == null ? null : idMaps.vehicles.get(oldVehicleId) ?? null,
        textOrNull(row.iconColor) ?? "#d98c2b",
        textOrNull(row.iconSecondaryColor) ?? "#f4c430",
        textOrNull(row.notes)
      ]
    );
    idMaps.taskFlowNodes.set(oldId, result.rows[0].id);
    counts.importedRecords += 1;
  }

  for (const row of sheets.get("Task Flow Edges") ?? []) {
    const oldFlowId = idFromExport(row.flowTemplateId);
    const flowTemplateId = oldFlowId == null ? null : idMaps.taskFlows.get(oldFlowId);
    if (!flowTemplateId) continue;
    const fromNode = await client.query<{ id: number }>(
      `select id from task_flow_nodes where flow_template_id = $1 and node_key = $2`,
      [flowTemplateId, textOrNull(row.fromNodeKey) ?? ""]
    );
    const toNode = await client.query<{ id: number; offset_days: number }>(
      `select id, offset_days from task_flow_nodes where flow_template_id = $1 and node_key = $2`,
      [flowTemplateId, textOrNull(row.toNodeKey) ?? ""]
    );
    if (!fromNode.rows[0] || !toNode.rows[0]) continue;
    await client.query(
      `
        insert into task_flow_edges (flow_template_id, from_node_id, to_node_id, delay_days)
        values ($1, $2, $3, $4)
        on conflict (flow_template_id, from_node_id, to_node_id) do nothing
      `,
      [
        flowTemplateId,
        fromNode.rows[0].id,
        toNode.rows[0].id,
        Math.max(0, Math.min(9999, numberOrNull(row.delayDays) ?? toNode.rows[0].offset_days ?? 0))
      ]
    );
    counts.importedRecords += 1;
  }

  const plantingDetails = sheets.get("Planting Details") ?? [];
  for (const detail of plantingDetails) {
    const oldId = idFromExport(detail.id);
    if (!oldId) {
      counts.skippedRows += 1;
      addWarning("Skipped a Planting Details row because it had no exported id.");
      continue;
    }
    let cropId: number;
    let varietyId: number | null;
    let seedItemId: number | null = null;
    let cropName = textOrNull(detail.title) ?? "Imported planting";
    let varietyName = "";
    const oldSeedItemId = idFromExport(detail.seedItemId);
    seedItemId = oldSeedItemId == null ? null : idMaps.seedItems.get(oldSeedItemId) ?? null;
    if (seedItemId != null) {
      const seedResult = await client.query<{ crop_id: number | null; variety_id: number | null; crop_type: string; variety_name: string | null; breed_name: string | null }>(
        `select crop_id, variety_id, crop_type, variety_name, breed_name from seed_items where id = $1 and farm_id = $2`,
        [seedItemId, farmId]
      );
      const seed = seedResult.rows[0];
      cropName = seed?.crop_type ?? cropName;
      varietyName = seed?.variety_name ?? seed?.breed_name ?? "";
      if (seed?.crop_id) {
        cropId = seed.crop_id;
        varietyId = seed.variety_id;
      } else {
        const ids = await upsertCropAndVariety(client, cropName, varietyName);
        cropId = ids.cropId;
        varietyId = ids.varietyId;
      }
    } else {
      const ids = await upsertCropAndVariety(client, cropName, varietyName);
      cropId = ids.cropId;
      varietyId = ids.varietyId;
    }
    const oldFieldId = idFromExport(detail.intendedFieldId);
    const oldBlockId = idFromExport(detail.intendedBlockId);
    const oldBedId = idFromExport(detail.intendedBedId);
    const oldFlowId = idFromExport(detail.taskFlowTemplateId);
    const resolvedFieldId = oldFieldId == null ? null : idMaps.fields.get(oldFieldId) ?? null;
    const resolvedBlockId = oldBlockId == null ? null : idMaps.blocks.get(oldBlockId) ?? null;
    const resolvedBedId = oldBedId == null
      ? null
      : idMaps.beds.get(oldBedId) ?? null;
    const plantCount = integerOrNull(detail.plantCount);
    const bedLengthUsedM = numberOrNull(detail.bedLengthUsedM);
    if (plantCount == null && bedLengthUsedM == null) {
      if (!hasAnyPlantingDetailData(detail)) {
        throw new Error(`Planting Details row ${oldId} has no planting data to restore.`);
      }
      counts.incompleteRows += 1;
    }
    const result = await client.query<{ id: number }>(
      `
        insert into plantings (
          farm_id, crop_id, variety_id, seed_item_id, task_flow_template_id, title, status,
          intended_field_id, intended_block_id, intended_bed_id,
          spacing, plant_count, bed_length_used_m, notes, tray_location, tray_count,
          cells_per_tray, days_to_harvest, field_spacing_in_row, row_spacing,
          rows_per_bed, bed_cover,
          planned_sow_date, planned_transplant_date, expected_harvest_start, expected_harvest_end,
          actual_tray_seeding_date, actual_direct_seeding_date, actual_transplant_date,
          actual_harvest_date, actual_finish_date
        )
        values (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10,
          $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20,
          $21, $22,
          $23, $24, $25, $26,
          $27, $28, $29,
          $30, $31
        )
        returning id
      `,
      [
        farmId,
        cropId,
        varietyId,
        seedItemId,
        oldFlowId == null ? null : idMaps.taskFlows.get(oldFlowId) ?? null,
        textOrNull(detail.title) ?? `${cropName}${varietyName ? ` - ${varietyName}` : ""}`,
        textOrNull(detail.status) ?? "planned",
        resolvedFieldId,
        resolvedBlockId,
        resolvedBedId,
        textOrNull(detail.spacing),
        plantCount,
        bedLengthUsedM,
        textOrNull(detail.notes),
        textOrNull(detail.trayLocation),
        numberOrNull(detail.trayCount),
        integerOrNull(detail.cellsPerTray),
        integerOrNull(detail.daysToHarvest),
        numberOrNull(detail.fieldSpacingInRow),
        numberOrNull(detail.rowSpacing),
        integerOrNull(detail.rowsPerBed),
        textOrNull(detail.bedCover),
        dateOrNull(detail.plannedSowDate),
        dateOrNull(detail.plannedTransplantDate),
        dateOrNull(detail.expectedHarvestStart),
        dateOrNull(detail.expectedHarvestEnd),
        dateOrNull(detail.actualTraySeedingDate),
        dateOrNull(detail.actualDirectSeedingDate),
        dateOrNull(detail.actualTransplantDate),
        dateOrNull(detail.actualHarvestDate),
        dateOrNull(detail.actualFinishDate)
      ]
    );
    await learnSeedItemSpacing(
      client,
      farmId,
      seedItemId,
      textOrNull(detail.spacing),
      numberOrNull(detail.fieldSpacingInRow),
      numberOrNull(detail.rowSpacing),
      integerOrNull(detail.rowsPerBed)
    );
    idMaps.plantings.set(oldId, result.rows[0].id);
    counts.importedPlantings += 1;
  }

  for (const row of sheets.get("Placements") ?? []) {
    const oldId = idFromExport(row.id);
    const oldPlantingId = idFromExport(row.plantingId);
    const oldBedId = idFromExport(row.bedId);
    const plantingId = oldPlantingId == null ? null : idMaps.plantings.get(oldPlantingId);
    const bedId = oldBedId == null ? null : idMaps.beds.get(oldBedId);
    if (!oldId || !plantingId || !bedId) {
      counts.skippedRows += 1;
      addWarning(`Skipped Placements row ${row.id || "unknown"} because the referenced planting or bed was not restored.`);
      continue;
    }
    const result = await client.query<{ id: number }>(
      `
        insert into planting_placements (
          planting_id, bed_id, plant_count, bed_length_used_m, start_length_m,
          placement_order, plan_source, placed_on, location_detail, notes
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        returning id
      `,
      [
        plantingId,
        bedId,
        integerOrNull(row.plantCount),
        numberOrNull(row.bedLengthUsedM),
        numberOrNull(row.startLengthM) ?? 0,
        numberOrNull(row.placementOrder),
        textOrNull(row.planSource) ?? "manual",
        dateOrNull(row.placedOn),
        textOrNull(row.locationDetail),
        textOrNull(row.notes)
      ]
    );
    idMaps.placements.set(oldId, result.rows[0].id);
    counts.importedRecords += 1;
  }

  for (const row of sheets.get("Placement Gaps") ?? []) {
    const oldBlockId = idFromExport(row.blockId);
    const oldBedId = idFromExport(row.bedId);
    const blockId = oldBlockId == null ? null : idMaps.blocks.get(oldBlockId);
    const bedId = oldBedId == null ? null : idMaps.beds.get(oldBedId);
    if (!blockId || !bedId) {
      counts.skippedRows += 1;
      addWarning(`Skipped Placement Gaps row ${row.id || "unknown"} because the referenced block or bed was not restored.`);
      continue;
    }
    await client.query(
      `
        insert into block_placement_gaps (farm_id, block_id, bed_id, start_length_m, bed_length_used_m, placement_order, notes)
        values ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        farmId,
        blockId,
        bedId,
        numberOrNull(row.startLengthM) ?? 0,
        numberOrNull(row.bedLengthUsedM) ?? 0.01,
        numberOrNull(row.placementOrder) ?? 0,
        textOrNull(row.notes)
      ]
    );
    counts.importedRecords += 1;
  }

  for (const row of sheets.get("Placement Overflows") ?? []) {
    const oldBlockId = idFromExport(row.blockId);
    const oldPlantingId = idFromExport(row.plantingId);
    const blockId = oldBlockId == null ? null : idMaps.blocks.get(oldBlockId);
    if (!blockId) {
      counts.skippedRows += 1;
      addWarning(`Skipped Placement Overflows row ${row.id || "unknown"} because the referenced block was not restored.`);
      continue;
    }
    await client.query(
      `
        insert into block_placement_overflows (farm_id, block_id, planting_id, entry_type, bed_length_used_m, plant_count, tray_count, placement_order, notes)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        farmId,
        blockId,
        oldPlantingId == null ? null : idMaps.plantings.get(oldPlantingId) ?? null,
        textOrNull(row.entryType) ?? "gap",
        numberOrNull(row.bedLengthUsedM) ?? 0.01,
        integerOrNull(row.plantCount),
        numberOrNull(row.trayCount),
        numberOrNull(row.placementOrder) ?? 0,
        textOrNull(row.notes)
      ]
    );
    counts.importedRecords += 1;
  }

  const taskDependencyUpdates: Array<{ id: number; oldDepends: number[] }> = [];
  for (const row of sheets.get("Tasks") ?? []) {
    const oldId = idFromExport(row.id);
    if (!oldId) continue;
    const oldPlantingId = idFromExport(row.plantingId);
    const oldBedId = idFromExport(row.bedId);
    const oldNodeId = idFromExport(row.taskFlowNodeId);
    const oldVehicleId = idFromExport(row.tractorProfileId);
    const taskType = requireCurrentTaskType(row.taskType, `Tasks row ${oldId}`);
    const anchor = row.anchor == null || row.anchor.trim() === ""
      ? null
      : requireCurrentTaskAnchor(row.anchor, `Tasks row ${oldId}`);
    const result = await client.query<{ id: number }>(
      `
        insert into tasks (
          farm_id, planting_id, bed_id, task_flow_node_id, task_type, title, status,
          anchor, offset_days, depends_on_task_ids, scheduled_date, completed_date,
          is_auto_generated, tractor_model, tractor_profile_id, icon_color, icon_secondary_color, notes
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}', $10, $11, $12, $13, $14, $15, $16, $17)
        returning id
      `,
      [
        farmId,
        oldPlantingId == null ? null : idMaps.plantings.get(oldPlantingId) ?? null,
        oldBedId == null ? null : idMaps.beds.get(oldBedId) ?? null,
        oldNodeId == null ? null : idMaps.taskFlowNodes.get(oldNodeId) ?? null,
        taskType,
        textOrNull(row.title) ?? "Imported task",
        textOrNull(row.status) ?? "pending",
        anchor,
        numberOrNull(row.offsetDays),
        dateOrNull(row.scheduledDate),
        dateOrNull(row.completedDate),
        booleanFromExport(row.isAutoGenerated),
        textOrNull(row.tractorModel),
        oldVehicleId == null ? null : idMaps.vehicles.get(oldVehicleId) ?? null,
        textOrNull(row.iconColor) ?? "#4f84aa",
        textOrNull(row.iconSecondaryColor) ?? "#f4c430",
        textOrNull(row.notes)
      ]
    );
    idMaps.tasks.set(oldId, result.rows[0].id);
    const oldDepends = (row.dependsOnTaskIds ?? "").match(/\d+/g)?.map(Number) ?? [];
    if (oldDepends.length > 0) {
      taskDependencyUpdates.push({ id: result.rows[0].id, oldDepends });
    }
    counts.importedRecords += 1;
  }
  for (const update of taskDependencyUpdates) {
    const mapped = update.oldDepends.map((oldId) => idMaps.tasks.get(oldId)).filter((id): id is number => Boolean(id));
    await client.query(`update tasks set depends_on_task_ids = $2 where id = $1`, [update.id, mapped]);
  }

  for (const row of sheets.get("Harvests") ?? []) {
    const oldPlantingId = idFromExport(row.plantingId);
    const oldBedId = idFromExport(row.bedId);
    const plantingId = oldPlantingId == null ? null : idMaps.plantings.get(oldPlantingId);
    const bedId = oldBedId == null ? null : idMaps.beds.get(oldBedId);
    if (!plantingId || !bedId || !dateOrNull(row.harvestDate)) {
      counts.skippedRows += 1;
      addWarning(`Skipped Harvests row ${row.id || "unknown"} because the referenced planting, bed, or harvest date was missing.`);
      continue;
    }
    await client.query(
      `
        insert into harvest_records (farm_id, planting_id, bed_id, harvest_date, quantity, unit, notes)
        values ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        farmId,
        plantingId,
        bedId,
        dateOrNull(row.harvestDate),
        numberOrNull(row.quantity) ?? 0,
        textOrNull(row.unit) ?? "unit",
        textOrNull(row.notes)
      ]
    );
    counts.importedRecords += 1;
  }

  for (const row of sheets.get("Events") ?? []) {
    const eventDate = dateOrNull(row.eventDate);
    if (!eventDate) continue;
    const oldFieldId = idFromExport(row.fieldId);
    const oldBlockId = idFromExport(row.blockId);
    const oldZoneId = idFromExport(row.zoneId);
    const oldBedId = idFromExport(row.bedId);
    const oldPlantingId = idFromExport(row.plantingId);
    const oldPlacementId = idFromExport(row.placementId);
    const oldTaskId = idFromExport(row.taskId);
    await client.query(
      `
        insert into farm_events (
          farm_id, event_date, event_type, title, notes, metadata,
          field_id, block_id, zone_id, bed_id, planting_id, placement_id, task_id
        )
        values ($1, $2, $3, $4, $5, coalesce($6::jsonb, '{}'::jsonb), $7, $8, $9, $10, $11, $12, $13)
      `,
      [
        farmId,
        eventDate,
        textOrNull(row.eventType) ?? "note",
        textOrNull(row.title) ?? "Imported event",
        textOrNull(row.notes),
        textOrNull(row.metadata),
        oldFieldId == null ? null : idMaps.fields.get(oldFieldId) ?? null,
        oldBlockId == null ? null : idMaps.blocks.get(oldBlockId) ?? null,
        oldZoneId == null ? null : idMaps.zones.get(oldZoneId) ?? null,
        oldBedId == null ? null : idMaps.beds.get(oldBedId) ?? null,
        oldPlantingId == null ? null : idMaps.plantings.get(oldPlantingId) ?? null,
        oldPlacementId == null ? null : idMaps.placements.get(oldPlacementId) ?? null,
        oldTaskId == null ? null : idMaps.tasks.get(oldTaskId) ?? null
      ]
    );
    counts.importedRecords += 1;
  }

  return counts;
}
