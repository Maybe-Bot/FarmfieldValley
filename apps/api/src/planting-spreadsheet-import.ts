/**
 * User-facing spreadsheet importer.
 *
 * It accepts the smaller crop-plan template and the app's farm backup export.
 * Both paths are append-only for crop-plan records; imports do not delete an
 * existing plan.
 */
import { PoolClient } from "pg";
import {
  hasFullBackupSheets,
  importFullBackupSpreadsheetRowsForFarm
} from "./full-backup-spreadsheet-import";
import { parsePlantingSpreadsheetFiles, SpreadsheetRow, supportedPlantingSpreadsheetExtension } from "./spreadsheet-file-parser";
import { recalculatePlantingTasks } from "./scheduler";

type ImportRow = {
  seedSupplier: string;
  crop: string | null;
  variety: string;
  catalogNumber: string;
  startDate: string | null;
  plantCount: number | null;
  bedLengthFeet: number | null;
  transplantDate: string | null;
  trayCount: number | null;
  cellsPerTray: number | null;
  daysToHarvest: number | null;
  fieldSpacingInRow: number | null;
  rowSpacing: number | null;
  rowsPerBed: number | null;
  bedCover: "plastic" | "bare" | null;
  field: string;
  block: string;
  bed: string;
  notes: string;
  completionIssues: string[];
  reviewIssues: string[];
  sourceSheet: string;
  sourceRow: number;
};

type ExistingBedLookup = {
  fieldId: number;
  fieldName: string;
  blockId: number;
  blockName: string;
  bedName: string;
  bedId: number;
};

type DbClient = PoolClient;

export const plantingImportHeaders = [
  "Seed supplier",
  "Crop",
  "Variety",
  "Catalog number",
  "Start date",
  "Plant count",
  "Bed length (ft)",
  "Transplant date",
  "Tray count",
  "Cells per tray",
  "Days to harvest",
  "Field spacing in row",
  "Row spacing",
  "Rows per bed",
  "Bed cover (plastic mulch/bare)",
  "Field",
  "Block",
  "Bed",
  "Notes"
] as const;

const unchangedTemplateExampleRow = [
  "Johnny's",
  "Lettuce",
  "Salanova Green",
  "2712G",
  "2026-03-15",
  "256",
  "",
  "2026-04-20",
  "2",
  "128",
  "55",
  "10",
  "12",
  "4",
  "plastic mulch",
  "East Field",
  "B1",
  "Bed 1",
  "Example row: replace field, block, and bed names with names already on your map."
];

function normalizeHeader(value: string) {
  return value.trim().toLowerCase();
}

function cleanCell(value: string | undefined) {
  return (value ?? "").trim();
}

function isUnchangedTemplateExampleRow(cells: string[]) {
  return unchangedTemplateExampleRow.every((value, index) => cleanCell(cells[index]) === value);
}

function parseIsoDate(value: string, rowNumber: number, columnName: string) {
  const clean = value.trim();
  if (!clean) {
    return null;
  }
  // Excel often stores typed dates as serial day numbers even when the cell is
  // displayed as YYYY-MM-DD, so accept those to avoid surprising users.
  if (/^\d+(?:\.\d+)?$/.test(clean)) {
    const serialDays = Math.floor(Number(clean));
    if (serialDays > 20000 && serialDays < 80000) {
      const date = new Date(Date.UTC(1899, 11, 30));
      date.setUTCDate(date.getUTCDate() + serialDays);
      return date.toISOString().slice(0, 10);
    }
  }
  const ymdMatch = clean.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  const mdyMatch = clean.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})$/);
  const match = ymdMatch ?? mdyMatch;
  if (!match) {
    throw new Error(`Row ${rowNumber}: ${columnName} must use YYYY-MM-DD or M/D/YYYY format`);
  }
  const year = ymdMatch
    ? Number(match[1])
    : match[3].length === 2
      ? Number(match[3]) + (Number(match[3]) < 70 ? 2000 : 1900)
      : Number(match[3]);
  const month = Number(ymdMatch ? match[2] : match[1]);
  const day = Number(ymdMatch ? match[3] : match[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`Row ${rowNumber}: ${columnName} is not a valid date`);
  }
  return date.toISOString().slice(0, 10);
}

function parseRequiredInteger(value: string, rowNumber: number, columnName: string) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`Row ${rowNumber}: ${columnName} must be a positive whole number`);
  }
  return numeric;
}

function parseOptionalInteger(value: string, rowNumber: number, columnName: string) {
  if (!value.trim()) {
    return null;
  }
  return parseRequiredInteger(value, rowNumber, columnName);
}

function parseOptionalPlantCount(value: string, rowNumber: number) {
  if (!value.trim()) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`Row ${rowNumber}: Plant count must be zero or a positive number`);
  }
  if (numeric === 0) {
    return null;
  }
  return Math.max(1, Math.round(numeric));
}

function parseOptionalNumber(value: string, rowNumber: number, columnName: string) {
  if (!value.trim()) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Row ${rowNumber}: ${columnName} must be a positive number`);
  }
  return numeric;
}

function parseOptionalBedCover(value: string, rowNumber: number, columnName: string) {
  const clean = value.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (!clean) {
    return null;
  }
  if (clean === "plastic" || clean === "plastic mulch") {
    return "plastic";
  }
  if (clean === "bare") {
    return "bare";
  }
  throw new Error(`Row ${rowNumber}: ${columnName} must be plastic mulch or bare`);
}

function addDays(value: string | null, days: number | null) {
  if (!value || days == null) {
    return null;
  }
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calculatePlantCountFromBedLength(
  bedLengthFeet: number | null,
  fieldSpacingInRow: number | null,
  rowsPerBed: number | null
) {
  if (bedLengthFeet == null || fieldSpacingInRow == null || rowsPerBed == null) {
    return null;
  }
  const bedLengthInches = bedLengthFeet * 12;
  const plants = Math.floor((bedLengthInches * rowsPerBed) / fieldSpacingInRow);
  return plants > 0 ? plants : null;
}

export function parsePlantingTemplateRows(rows: SpreadsheetRow[]) {
  const headerRow = rows.find((row) => row.cells.some((cell) => cell.trim()));
  if (!headerRow) {
    throw new Error("Spreadsheet is empty");
  }

  const headers = plantingImportHeaders.map(normalizeHeader);
  const actualHeaders = headerRow.cells.slice(0, headers.length).map(normalizeHeader);
  const missingOrWrong = headers.filter((header, index) => actualHeaders[index] !== header);
  if (missingOrWrong.length > 0) {
    throw new Error(`Spreadsheet headers must exactly match: ${plantingImportHeaders.join(", ")}`);
  }

  const templateRows: ImportRow[] = [];
  let skippedTemplateExampleRows = 0;
  for (const row of rows) {
    if (row.sheet !== headerRow.sheet || row.rowIndex <= headerRow.rowIndex) {
      continue;
    }
    const cells = row.cells;
    const isEmpty = cells.every((cell) => !cell.trim());
    if (isEmpty) {
      continue;
    }
    if (isUnchangedTemplateExampleRow(cells)) {
      skippedTemplateExampleRows += 1;
      continue;
    }

    const [
      seedSupplier,
      crop,
      variety,
      catalogNumber,
      startDateRaw,
      plantCountRaw,
      bedLengthFeetRaw,
      transplantDateRaw,
      trayCountRaw,
      cellsPerTrayRaw,
      daysToHarvestRaw,
      fieldSpacingRaw,
      rowSpacingRaw,
      rowsPerBedRaw,
      bedCoverRaw,
      field,
      block,
      bed,
      notes
    ] = plantingImportHeaders.map((_header, index) => cleanCell(cells[index]));

    const startDate = parseIsoDate(startDateRaw, row.rowIndex, "Start date");
    const plantCount = parseOptionalPlantCount(plantCountRaw, row.rowIndex);
    const bedLengthFeet = parseOptionalNumber(bedLengthFeetRaw, row.rowIndex, "Bed length (ft)");
    const fieldSpacingInRow = parseOptionalNumber(fieldSpacingRaw, row.rowIndex, "Field spacing in row");
    const rowSpacing = parseOptionalNumber(rowSpacingRaw, row.rowIndex, "Row spacing");
    const rowsPerBed = parseOptionalInteger(rowsPerBedRaw, row.rowIndex, "Rows per bed");
    const derivedPlantCount = plantCount ?? calculatePlantCountFromBedLength(bedLengthFeet, fieldSpacingInRow, rowsPerBed);
    const completionIssues = [
      !crop ? "Crop is missing" : null,
      !startDate ? "Start date is missing" : null,
      plantCount == null && bedLengthFeet == null ? "Plant count or bed length is missing" : null,
      !field ? "Field is missing" : null,
      !block ? "Block is missing" : null
    ].filter((issue): issue is string => Boolean(issue));
    const reviewIssues = [
      !variety ? "Variety is blank" : null,
      !catalogNumber ? "Catalog number is blank" : null,
      !transplantDateRaw.trim() ? "Transplant date is blank" : null,
      !daysToHarvestRaw.trim() ? "Days to harvest is blank" : null,
      !fieldSpacingRaw.trim() ? "Field spacing in row is blank" : null,
      !rowSpacingRaw.trim() ? "Row spacing is blank" : null,
      !rowsPerBedRaw.trim() ? "Rows per bed is blank" : null,
      !bedCoverRaw.trim() ? "Bed cover is blank" : null,
      !bed ? "Bed is blank" : null
    ].filter((issue): issue is string => Boolean(issue));

    templateRows.push({
      seedSupplier,
      crop: crop || null,
      variety,
      catalogNumber,
      startDate,
      plantCount: derivedPlantCount,
      bedLengthFeet,
      transplantDate: parseIsoDate(transplantDateRaw, row.rowIndex, "Transplant date"),
      trayCount: parseOptionalNumber(trayCountRaw, row.rowIndex, "Tray count"),
      cellsPerTray: parseOptionalInteger(cellsPerTrayRaw, row.rowIndex, "Cells per tray"),
      daysToHarvest: parseOptionalInteger(daysToHarvestRaw, row.rowIndex, "Days to harvest"),
      fieldSpacingInRow,
      rowSpacing,
      rowsPerBed,
      bedCover: parseOptionalBedCover(bedCoverRaw, row.rowIndex, "Bed cover (plastic mulch/bare)"),
      field,
      block,
      bed,
      notes,
      completionIssues,
      reviewIssues,
      sourceSheet: row.sheet,
      sourceRow: row.rowIndex
    });
  }

  if (templateRows.length === 0) {
    if (skippedTemplateExampleRows > 0) {
      throw new Error("Spreadsheet only contained the unchanged example row. Add or edit a row before importing.");
    }
    throw new Error("Spreadsheet did not contain any planting rows under the header");
  }

  return templateRows;
}

function lookupKey(...parts: string[]) {
  return parts.map((part) => part.trim().toLowerCase()).join("\u001f");
}

async function loadBedLookup(client: DbClient, farmId: number) {
  const result = await client.query<ExistingBedLookup>(
    `
      select
        field.id as "fieldId",
        field.name as "fieldName",
        block.id as "blockId",
        block.name as "blockName",
        bed.name as "bedName",
        bed.id as "bedId"
      from beds bed
      join blocks block on block.id = bed.block_id
      join fields field on field.id = block.field_id
      where field.farm_id = $1
        and bed.source <> 'road'
    `,
    [farmId]
  );
  return {
    byFieldBlockBed: new Map(result.rows.map((row) => [lookupKey(row.fieldName, row.blockName, row.bedName), row.bedId])),
    byBlockBed: new Map(
      result.rows.reduce<Array<[string, number | null]>>((entries, row, _index, allRows) => {
        const key = lookupKey(row.blockName, row.bedName);
        const matches = allRows.filter((item) => lookupKey(item.blockName, item.bedName) === key);
        entries.push([key, matches.length === 1 ? row.bedId : null]);
        return entries;
      }, [])
    )
  };
}

async function findFieldBlock(client: DbClient, farmId: number, row: ImportRow) {
  if (!row.block) {
    return null;
  }
  if (!row.field) {
    const result = await client.query<{ field_id: number; block_id: number; field_name: string; block_name: string }>(
      `
        select
          field.id as field_id,
          field.name as field_name,
          block.id as block_id,
          block.name as block_name
        from blocks block
        join fields field on field.id = block.field_id
        where field.farm_id = $1
          and lower(block.name) = lower($2)
        order by field.name, block.name
      `,
      [farmId, row.block]
    );
    return result.rows.length === 1 ? result.rows[0] : null;
  }
  const result = await client.query<{ field_id: number; block_id: number; field_name: string; block_name: string }>(
    `
      select block.id
        as block_id,
        field.id as field_id,
        field.name as field_name,
        block.name as block_name
      from blocks block
      join fields field on field.id = block.field_id
      where field.farm_id = $1
        and lower(field.name) = lower($2)
        and lower(block.name) = lower($3)
      limit 1
    `,
    [farmId, row.field, row.block]
  );
  return result.rows[0] ?? null;
}

async function upsertCropAndVariety(client: DbClient, cropName: string, varietyName: string) {
  const cropResult = await client.query<{ id: number }>(
    `
      insert into crops (name)
      values ($1)
      on conflict (name) do update set name = excluded.name
      returning id
    `,
    [cropName]
  );
  const cropId = cropResult.rows[0].id;
  let varietyId: number | null = null;
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
  return { cropId, varietyId };
}

async function upsertSeedItem(
  client: DbClient,
  farmId: number,
  row: ImportRow,
  cropId: number,
  varietyId: number | null
) {
  const existing = await client.query<{ id: number }>(
    `
      select id
      from seed_items
      where farm_id = $1
        and lower(crop_type) = lower($2)
        and lower(coalesce(variety_name, '')) = lower($3)
        and lower(coalesce(supplier, '')) = lower($4)
        and lower(coalesce(catalog_number, '')) = lower($5)
      limit 1
    `,
    [farmId, row.crop ?? "Needs crop", row.variety, row.seedSupplier, row.catalogNumber]
  );
  if (existing.rows[0]) {
    if (row.daysToHarvest != null) {
      await client.query(
        `
          update seed_items
          set days_to_maturity = coalesce(days_to_maturity, $2), updated_at = now()
          where id = $1
        `,
        [existing.rows[0].id, row.daysToHarvest]
      );
    }
    return existing.rows[0].id;
  }

  const result = await client.query<{ id: number }>(
    `
      insert into seed_items (
        farm_id, crop_id, variety_id, crop_type, variety_name, supplier, catalog_number, days_to_maturity, notes
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      returning id
    `,
    [
      farmId,
      cropId,
      varietyId,
      row.crop ?? "Needs crop",
      row.variety || null,
      row.seedSupplier || null,
      row.catalogNumber || null,
      row.daysToHarvest,
      "Created by planting spreadsheet import."
    ]
  );
  return result.rows[0].id;
}

async function learnSeedItemSpacing(
  client: DbClient,
  farmId: number,
  seedItemId: number | null,
  spacing: string | null,
  fieldSpacingInRow: number | null,
  rowSpacing: number | null,
  rowsPerBed: number | null
) {
  if (seedItemId == null) {
    return;
  }
  const trimmedSpacing = spacing?.trim() || null;
  if (trimmedSpacing == null && fieldSpacingInRow == null && rowSpacing == null && rowsPerBed == null) {
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
    [seedItemId, farmId, trimmedSpacing, fieldSpacingInRow, rowSpacing, rowsPerBed]
  );
}

export async function importPlantingSpreadsheetRowsForFarm(
  client: DbClient,
  rows: SpreadsheetRow[],
  farmId: number
) {
  if (hasFullBackupSheets(rows)) {
    return importFullBackupSpreadsheetRowsForFarm(client, rows, farmId, {
      upsertCropAndVariety,
      learnSeedItemSpacing
    });
  }

  const parsedRows = parsePlantingTemplateRows(rows);
  const bedLookup = await loadBedLookup(client, farmId);

  let importedPlantings = 0;
  let skippedRows = 0;
  let incompleteRows = 0;
  for (const row of parsedRows) {
    const completionIssues = [...row.completionIssues];
    const reviewIssues = [...row.reviewIssues];
    const fieldBlock = await findFieldBlock(client, farmId, row);
    if (!row.field && row.block && !fieldBlock) {
      completionIssues.push(`Block could not set location on its own: ${row.block}`);
    }
    if (row.field && row.block && !fieldBlock) {
      completionIssues.push(`Field/Block not found: ${row.field} / ${row.block}`);
    }
    const resolvedFieldName = row.field || fieldBlock?.field_name || "";
    const resolvedBlockName = row.block || fieldBlock?.block_name || "";
    const intendedBedId = row.bed
      ? (
        bedLookup.byFieldBlockBed.get(lookupKey(resolvedFieldName, resolvedBlockName, row.bed))
        ?? bedLookup.byBlockBed.get(lookupKey(resolvedBlockName, row.bed))
        ?? null
      )
      : null;
    if (row.bed && intendedBedId == null) {
      completionIssues.push(`Bed not found: ${[resolvedFieldName || "missing field", resolvedBlockName || "missing block", row.bed].join(" / ")}`);
    }

    const cropName = row.crop ?? "Needs crop";
    const { cropId, varietyId } = await upsertCropAndVariety(client, cropName, row.variety);
    const seedItemId = await upsertSeedItem(client, farmId, row, cropId, varietyId);
    const spacingParts = [
      row.fieldSpacingInRow != null ? `${row.fieldSpacingInRow} in in-row` : null,
      row.rowSpacing != null ? `${row.rowSpacing} in row spacing` : null,
      row.rowsPerBed != null ? `${row.rowsPerBed} rows/bed` : null
    ].filter(Boolean);
    const spacing = spacingParts.length > 0 ? spacingParts.join("; ") : null;
    const harvestAnchorDate = row.transplantDate ?? row.startDate;
    const expectedHarvestStart = addDays(harvestAnchorDate, row.daysToHarvest);
    const bedLengthUsedM = row.bedLengthFeet == null ? null : row.bedLengthFeet / 3.28084;
    const needsManualCompletion = completionIssues.length > 0;
    const notes = [
      `Imported from planting spreadsheet: ${row.sourceSheet} row ${row.sourceRow}.`,
      needsManualCompletion ? `Needs manual completion: ${completionIssues.join("; ")}.` : null,
      reviewIssues.length > 0 ? `Optional fields to review: ${reviewIssues.join("; ")}.` : null,
      `Field/Block/Bed: ${[resolvedFieldName || "missing field", resolvedBlockName || "missing block", row.bed || "unassigned bed"].join(" / ")}.`,
      row.catalogNumber ? `Catalog number: ${row.catalogNumber}.` : null,
      row.bedCover == null ? null : `Bed cover: ${row.bedCover}.`,
      row.bedLengthFeet == null ? null : `Bed length: ${row.bedLengthFeet} ft.`,
      row.cellsPerTray != null ? `Cells per tray: ${row.cellsPerTray}.` : null,
      row.notes ? `Spreadsheet notes: ${row.notes}` : null
    ].filter(Boolean).join("\n");
    const titleBase = row.crop ? `${row.crop}${row.variety ? ` - ${row.variety}` : ""}` : `Incomplete import row ${row.sourceRow}`;
    const title = `${titleBase}${row.bed ? ` (${row.bed})` : ""}`;

    const plantingResult = await client.query<{ id: number }>(
      `
        insert into plantings (
          farm_id, crop_id, variety_id, seed_item_id, title, status,
          intended_field_id, intended_block_id, intended_bed_id,
          spacing, plant_count, bed_length_used_m, notes, tray_count,
          cells_per_tray, days_to_harvest, field_spacing_in_row, row_spacing,
          rows_per_bed, bed_cover,
          planned_sow_date, planned_transplant_date, expected_harvest_start, expected_harvest_end
        )
        values (
          $1, $2, $3, $4, $5, 'planned',
          $6, $7, $8,
          $9, $10, $11, $12, $13,
          $14, $15, $16, $17,
          $18, $19,
          $20, $21, $22, null
        )
        returning id
      `,
      [
        farmId,
        cropId,
        varietyId,
        seedItemId,
        title,
        fieldBlock?.field_id ?? null,
        fieldBlock?.block_id ?? null,
        intendedBedId,
        spacing,
        row.plantCount,
        bedLengthUsedM,
        notes,
        row.trayCount,
        row.cellsPerTray,
        row.daysToHarvest,
        row.fieldSpacingInRow,
        row.rowSpacing,
        row.rowsPerBed,
        row.bedCover,
        row.startDate,
        row.transplantDate,
        expectedHarvestStart
      ]
    );
    await learnSeedItemSpacing(client, farmId, seedItemId, spacing, row.fieldSpacingInRow, row.rowSpacing, row.rowsPerBed);

    await recalculatePlantingTasks(client, plantingResult.rows[0].id);
    importedPlantings += 1;
    if (needsManualCompletion) {
      incompleteRows += 1;
    }
  }

  return {
    parsedRows: parsedRows.length,
    importedPlantings,
    skippedRows,
    incompleteRows
  };
}

export { parsePlantingSpreadsheetFiles, supportedPlantingSpreadsheetExtension };
export type { SpreadsheetRow };
