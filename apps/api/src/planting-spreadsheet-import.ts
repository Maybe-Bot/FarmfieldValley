/**
 * User-facing spreadsheet importer.
 *
 * It accepts the smaller crop-plan template and the app's farm backup export.
 * Both paths are append-only for crop-plan records; imports do not delete an
 * existing plan.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { PoolClient } from "pg";
import { recalculatePlantingTasks } from "./scheduler";
import { isCurrentTaskType, isLegacyTaskType } from "./types";

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
type SheetRow = Record<string, string>;
type SheetMap = Map<string, SheetRow[]>;

const GEOJSON_TOLERANCE_DEGREES = 0.000003;

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
    throw new Error("Spreadsheet did not contain any planting rows under the header");
  }

  return templateRows;
}

function lookupKey(...parts: string[]) {
  return parts.map((part) => part.trim().toLowerCase()).join("\u001f");
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

function hasFullBackupSheets(rows: SpreadsheetRow[]) {
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

async function upsertSimpleByName(client: DbClient, sql: string, params: unknown[]) {
  const result = await client.query<{ id: number }>(sql, params);
  return result.rows[0].id;
}

async function importFullBackupSpreadsheetRowsForFarm(client: DbClient, rows: SpreadsheetRow[], farmId: number) {
  const sheets = rowsBySheet(rows);
  const idMaps = {
    fields: new Map<number, number>(),
    blocks: new Map<number, number>(),
    zones: new Map<number, number>(),
    beds: new Map<number, number>(),
    bedPresets: new Map<number, number>(),
    coverCrops: new Map<number, number>(),
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
    importedVehicles: 0
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
    if (!oldId || !blockId || !boundary) {
      counts.skippedRows += 1;
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
        numberOrNull(row.bedLengthM) ?? 0.01,
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
    const cropName = textOrNull(row.cropType);
    const varietyName = textOrNull(row.varietyName) ?? textOrNull(row.breedName) ?? "";
    const ids = cropName ? await upsertCropAndVariety(client, cropName, varietyName) : { cropId: null, varietyId: null };
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

  for (const row of sheets.get("Task Flows") ?? []) {
    const oldId = idFromExport(row.id);
    if (!oldId) continue;
    const oldCropId = idFromExport(row.cropId);
    const result = await client.query<{ id: number }>(
      `
        insert into task_flow_templates (farm_id, crop_id, name, notes, is_default)
        values ($1, null, $2, $3, $4)
        on conflict (farm_id, name) do update
        set notes = excluded.notes,
            is_default = excluded.is_default,
            updated_at = now()
        returning id
      `,
      [farmId, textOrNull(row.name) ?? `Imported flow ${oldId}`, textOrNull(row.notes), booleanFromExport(row.isDefault)]
    );
    if (oldCropId) {
      // Crop links are restored through plantings/seed rows; old global crop IDs
      // are not farm scoped, so keep this null unless a future export includes crop names here.
    }
    idMaps.taskFlows.set(oldId, result.rows[0].id);
    counts.importedRecords += 1;
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
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '#d98c2b', '#f4c430', $11)
        on conflict (flow_template_id, node_key) do update
        set task_type = excluded.task_type,
            label = excluded.label,
            anchor = excluded.anchor,
            offset_days = excluded.offset_days,
            x_pos = excluded.x_pos,
            y_pos = excluded.y_pos,
            tractor_model = excluded.tractor_model,
            tractor_profile_id = excluded.tractor_profile_id,
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
    const toNode = await client.query<{ id: number }>(
      `select id from task_flow_nodes where flow_template_id = $1 and node_key = $2`,
      [flowTemplateId, textOrNull(row.toNodeKey) ?? ""]
    );
    if (!fromNode.rows[0] || !toNode.rows[0]) continue;
    await client.query(
      `
        insert into task_flow_edges (flow_template_id, from_node_id, to_node_id)
        values ($1, $2, $3)
        on conflict (flow_template_id, from_node_id, to_node_id) do nothing
      `,
      [flowTemplateId, fromNode.rows[0].id, toNode.rows[0].id]
    );
    counts.importedRecords += 1;
  }

  const plantingDetails = sheets.get("Planting Details") ?? [];
  for (const detail of plantingDetails) {
    const oldId = idFromExport(detail.id);
    if (!oldId) {
      counts.skippedRows += 1;
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
      counts.skippedRows += 1;
      continue;
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
    if (!oldId || !plantingId || !bedId) continue;
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
    if (!blockId || !bedId) continue;
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
    if (!blockId) continue;
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
          is_auto_generated, tractor_model, tractor_profile_id, notes
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}', $10, $11, $12, $13, $14, $15)
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
        integerOrNull(row.offsetDays),
        dateOrNull(row.scheduledDate),
        dateOrNull(row.completedDate),
        booleanFromExport(row.isAutoGenerated),
        textOrNull(row.tractorModel),
        oldVehicleId == null ? null : idMaps.vehicles.get(oldVehicleId) ?? null,
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
    if (!plantingId || !bedId || !dateOrNull(row.harvestDate)) continue;
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

export async function importPlantingSpreadsheetRowsForFarm(
  client: DbClient,
  rows: SpreadsheetRow[],
  farmId: number
) {
  if (hasFullBackupSheets(rows)) {
    return importFullBackupSpreadsheetRowsForFarm(client, rows, farmId);
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
          $20, $21, $22, $22
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
