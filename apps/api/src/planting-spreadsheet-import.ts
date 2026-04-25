/**
 * Strict user-facing planting spreadsheet importer.
 *
 * This replaces the old demo spreadsheet scraper for uploads. The importer is
 * intentionally simple: the first row must contain the exact template headers,
 * and each later non-empty row becomes one parent planting. It does not import
 * fertility plans or field-work records.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { PoolClient } from "pg";
import { recalculatePlantingTasks } from "./scheduler";

type SpreadsheetRow = {
  sheet: string;
  rowIndex: number;
  cells: string[];
};

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
  deadAtFrost: boolean | null;
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
  "Dead at frost (y/n)",
  "Bed cover (plastic/bare)",
  "Field",
  "Block",
  "Bed",
  "Notes"
] as const;

// Dependency-free spreadsheet reader. Python stdlib reads xlsx/ods zip/xml
// contents and returns raw cell strings; TypeScript does the template checks.
const genericSpreadsheetParser = String.raw`
import csv
import json
import sys
import zipfile
import xml.etree.ElementTree as ET

ODS_NS = {
    "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
    "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
}
XLSX_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
XLSX_REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

def ods_cell_text(cell):
    parts = []
    for paragraph in cell.findall("text:p", ODS_NS):
        text = "".join(paragraph.itertext()).strip()
        if text:
            parts.append(text)
    return " ".join(parts).strip()

def parse_ods(filename):
    rows = []
    with zipfile.ZipFile(filename) as archive:
        content = archive.read("content.xml")
    root = ET.fromstring(content)
    for sheet in root.findall(".//table:table", ODS_NS):
        sheet_name = sheet.attrib.get("{" + ODS_NS["table"] + "}name", "Sheet")
        for row_index, row in enumerate(sheet.findall("table:table-row", ODS_NS), start=1):
            cells = []
            for cell in row:
                if not cell.tag.endswith("table-cell"):
                    continue
                repeated = int(cell.attrib.get("{" + ODS_NS["table"] + "}number-columns-repeated", "1"))
                value = ods_cell_text(cell)
                for _ in range(min(repeated, 80 - len(cells))):
                    cells.append(value)
                if len(cells) >= 80:
                    break
            if any(cells):
                rows.append({"sheet": sheet_name, "rowIndex": row_index, "cells": cells})
    return rows

def xlsx_column_index(cell_ref):
    letters = "".join(ch for ch in cell_ref if ch.isalpha())
    index = 0
    for char in letters:
        index = index * 26 + ord(char.upper()) - 64
    return max(0, index - 1)

def xlsx_cell_text(cell, shared_strings):
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        inline = cell.find(XLSX_NS + "is")
        return "" if inline is None else "".join(inline.itertext()).strip()
    value = cell.find(XLSX_NS + "v")
    text = "" if value is None or value.text is None else value.text.strip()
    if cell_type == "s" and text:
        return shared_strings[int(text)]
    return text

def parse_xlsx(filename):
    rows = []
    with zipfile.ZipFile(filename) as archive:
        names = set(archive.namelist())
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        rel_map = {rel.attrib["Id"]: rel.attrib["Target"] for rel in rels}
        shared_strings = []
        if "xl/sharedStrings.xml" in names:
            shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in shared_root.findall(XLSX_NS + "si"):
                shared_strings.append("".join(item.itertext()).strip())
        sheets = workbook.find(XLSX_NS + "sheets")
        if sheets is None:
            return rows
        for sheet in sheets:
            sheet_name = sheet.attrib.get("name", "Sheet")
            rel_id = sheet.attrib.get(XLSX_REL_NS + "id")
            target = rel_map.get(rel_id, "")
            if target.startswith("/"):
                sheet_path = target.lstrip("/")
            elif target.startswith("xl/"):
                sheet_path = target
            else:
                sheet_path = "xl/" + target
            if sheet_path not in names:
                continue
            sheet_root = ET.fromstring(archive.read(sheet_path))
            for row in sheet_root.findall(".//" + XLSX_NS + "row"):
                cells = []
                for cell in row.findall(XLSX_NS + "c"):
                    column_index = xlsx_column_index(cell.attrib.get("r", "A1"))
                    while len(cells) < column_index:
                        cells.append("")
                    cells.append(xlsx_cell_text(cell, shared_strings))
                    if len(cells) >= 80:
                        break
                if any(cells):
                    rows.append({"sheet": sheet_name, "rowIndex": int(float(row.attrib.get("r", "0"))), "cells": cells})
    return rows

def parse_csv(filename):
    rows = []
    with open(filename, newline="", encoding="utf-8-sig") as handle:
        for row_index, row in enumerate(csv.reader(handle), start=1):
            cells = [cell.strip() for cell in row]
            if any(cells):
                rows.append({"sheet": "CSV", "rowIndex": row_index, "cells": cells})
    return rows

rows = []
for filename in sys.argv[1:]:
    lower = filename.lower()
    if lower.endswith(".xlsx"):
        rows.extend(parse_xlsx(filename))
    elif lower.endswith(".ods"):
        rows.extend(parse_ods(filename))
    elif lower.endswith(".csv"):
        rows.extend(parse_csv(filename))
print(json.dumps(rows))
`;

export function supportedPlantingSpreadsheetExtension(fileName: string) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx")) return ".xlsx";
  if (lower.endsWith(".ods")) return ".ods";
  if (lower.endsWith(".csv")) return ".csv";
  throw new Error("Spreadsheet upload must be an .xlsx, .ods, or .csv file");
}

export function parsePlantingSpreadsheetFiles(files: string[]) {
  if (files.length === 0) {
    throw new Error("No planting spreadsheet file was provided");
  }
  for (const file of files) {
    if (!fs.existsSync(file)) {
      throw new Error(`Missing spreadsheet: ${file}`);
    }
  }

  const output = execFileSync("python3", ["-c", genericSpreadsheetParser, ...files], {
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024
  });
  return JSON.parse(output) as SpreadsheetRow[];
}

function normalizeHeader(value: string) {
  return value.trim().toLowerCase();
}

function cleanCell(value: string | undefined) {
  return (value ?? "").trim();
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
  const match = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Row ${rowNumber}: ${columnName} must use YYYY-MM-DD format`);
  }
  const date = new Date(`${clean}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== clean) {
    throw new Error(`Row ${rowNumber}: ${columnName} is not a valid date`);
  }
  return clean;
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

function parseOptionalPositiveWholeNumber(value: string, rowNumber: number, columnName: string) {
  if (!value.trim()) {
    return null;
  }
  return parseRequiredInteger(value, rowNumber, columnName);
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

function parseOptionalBoolean(value: string, rowNumber: number, columnName: string) {
  const clean = value.trim().toLowerCase();
  if (!clean) {
    return null;
  }
  if (["y", "yes", "true"].includes(clean)) {
    return true;
  }
  if (["n", "no", "false"].includes(clean)) {
    return false;
  }
  throw new Error(`Row ${rowNumber}: ${columnName} must be y or n`);
}

function parseOptionalBedCover(value: string, rowNumber: number, columnName: string) {
  const clean = value.trim().toLowerCase();
  if (!clean) {
    return null;
  }
  if (clean === "plastic" || clean === "bare") {
    return clean;
  }
  throw new Error(`Row ${rowNumber}: ${columnName} must be plastic or bare`);
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
  for (const row of rows) {
    if (row.sheet !== headerRow.sheet || row.rowIndex <= headerRow.rowIndex) {
      continue;
    }
    const cells = row.cells;
    const isEmpty = cells.every((cell) => !cell.trim());
    if (isEmpty) {
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
      deadAtFrostRaw,
      bedCoverRaw,
      field,
      block,
      bed,
      notes
    ] = plantingImportHeaders.map((_header, index) => cleanCell(cells[index]));

    const startDate = parseIsoDate(startDateRaw, row.rowIndex, "Start date");
    const plantCount = parseOptionalPositiveWholeNumber(plantCountRaw, row.rowIndex, "Plant count");
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
      !deadAtFrostRaw.trim() ? "Dead at frost is blank" : null,
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
      trayCount: parseOptionalInteger(trayCountRaw, row.rowIndex, "Tray count"),
      cellsPerTray: parseOptionalInteger(cellsPerTrayRaw, row.rowIndex, "Cells per tray"),
      daysToHarvest: parseOptionalInteger(daysToHarvestRaw, row.rowIndex, "Days to harvest"),
      fieldSpacingInRow,
      rowSpacing,
      rowsPerBed,
      deadAtFrost: parseOptionalBoolean(deadAtFrostRaw, row.rowIndex, "Dead at frost (y/n)"),
      bedCover: parseOptionalBedCover(bedCoverRaw, row.rowIndex, "Bed cover (plastic/bare)"),
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
    return existing.rows[0].id;
  }

  const result = await client.query<{ id: number }>(
    `
      insert into seed_items (
        farm_id, crop_id, variety_id, crop_type, variety_name, supplier, catalog_number, notes
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8)
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
      "Created by planting spreadsheet import."
    ]
  );
  return result.rows[0].id;
}

async function clearPreviousPlantingSpreadsheetImport(client: DbClient, farmId: number) {
  await client.query(
    `delete from farm_events where farm_id = $1 and metadata->>'source' = 'planting_spreadsheet_import'`,
    [farmId]
  );
  await client.query(
    `
      delete from plantings
      where farm_id = $1
        and notes like 'Imported from planting spreadsheet:%'
    `,
    [farmId]
  );
}

export async function importPlantingSpreadsheetRowsForFarm(client: DbClient, rows: SpreadsheetRow[], farmId: number) {
  const parsedRows = parsePlantingTemplateRows(rows);
  const bedLookup = await loadBedLookup(client, farmId);
  await clearPreviousPlantingSpreadsheetImport(client, farmId);

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
      row.deadAtFrost == null ? null : `Dead at frost: ${row.deadAtFrost ? "yes" : "no"}.`,
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
          rows_per_bed, dead_at_frost, bed_cover,
          planned_sow_date, planned_transplant_date, expected_harvest_start, expected_harvest_end
        )
        values (
          $1, $2, $3, $4, $5, 'planned',
          $6, $7, $8,
          $9, $10, $11, $12, $13,
          $14, $15, $16, $17,
          $18, $19, $20,
          $21, $22, $23, $23
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
        row.deadAtFrost,
        row.bedCover,
        row.startDate,
        row.transplantDate,
        expectedHarvestStart
      ]
    );

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
