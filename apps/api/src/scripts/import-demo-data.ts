/**
 * Imports farm-specific demo spreadsheet data.
 *
 * The importer intentionally supports only the known demo spreadsheet shape.
 * It is not a general spreadsheet parser. The API route reuses the core helpers
 * below, but still expects a perfectly formatted Start Chart / Fertility workbook.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PoolClient } from "pg";
import { pool } from "../db";
import { hashPassword } from "../auth";
import { boundingBox, Coordinate, polygonWkt } from "../geometry";
import { recalculatePlantingTasks } from "../scheduler";
import { TaskAnchor, TaskType } from "../types";

type DemoRow = {
  file: string;
  sheet: string;
  rowIndex: number;
  cells: string[];
};

type DemoLocation = "B1" | "B2" | "B3" | "H2" | "H3" | "H4" | "H5" | "H6";

type DbClient = PoolClient;
type GeoJsonPolygon = {
  type: "Polygon";
  coordinates: number[][][];
};

const demoUsername = "username";
const demoPassword = "passord1";
const demoFarmName = "B/H Demo Farm";
const allowedLocations = new Set<DemoLocation>(["B1", "B2", "B3", "H2", "H3", "H4", "H5", "H6"]);
const feetToMeters = 0.3048;
const projectRoot = path.resolve(__dirname, "../../../..");
const demoDataDir = path.join(projectRoot, "demo data");
const defaultBedLengthM = 340 * feetToMeters;
const demoImportYear = 2026;

function collectDemoDataFiles() {
  if (!fs.existsSync(demoDataDir)) {
    fail(`Missing demo data folder: ${demoDataDir}`);
  }

  const filenames = fs.readdirSync(demoDataDir).filter((name) => name.endsWith(".xlsx") || name.endsWith(".ods"));
  const xlsxYears = new Set(
    filenames
      .filter((name) => name.endsWith(".xlsx"))
      .map((name) => name.match(/20\d{2}/)?.[0])
      .filter((year): year is string => year != null)
  );

  return filenames
    .filter((name) => {
      if (name.endsWith(".xlsx")) {
        return true;
      }
      const year = name.match(/20\d{2}/)?.[0];
      return year == null || !xlsxYears.has(year);
    })
    .sort()
    .map((name) => path.join(demoDataDir, name));
}

// Keep this dependency-free for the prototype: Python stdlib reads the ODS/XLSX zip/XML,
// then TypeScript handles the farm-specific filtering and database writes.
const spreadsheetParser = String.raw`
import json
import os
import sys
import zipfile
import xml.etree.ElementTree as ET

ODS_NS = {
    "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
    "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
}
XLSX_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
XLSX_REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

def canonical_sheet_name(name):
    normalized = name.strip().replace("_", " ").replace(".", "").lower()
    if normalized == "start chart":
        return "Start Chart"
    if normalized == "fertility needs":
        return "Fertility Needs"
    if normalized == "fertilization plan":
        return "Fertilization Plan"
    return None

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
        sheet_name = canonical_sheet_name(sheet.attrib.get("{" + ODS_NS["table"] + "}name", ""))
        if sheet_name is None:
            continue
        for row_index, row in enumerate(sheet.findall("table:table-row", ODS_NS), start=1):
            cells = []
            for cell in row:
                if not cell.tag.endswith("table-cell"):
                    continue
                repeated = int(cell.attrib.get("{" + ODS_NS["table"] + "}number-columns-repeated", "1"))
                value = ods_cell_text(cell)
                for _ in range(min(repeated, 40 - len(cells))):
                    cells.append(value)
                if len(cells) >= 40:
                    break
            if any(cells):
                rows.append({
                    "file": filename,
                    "sheet": sheet_name,
                    "rowIndex": row_index,
                    "cells": cells,
                })
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
            sheet_name = canonical_sheet_name(sheet.attrib.get("name", ""))
            if sheet_name is None:
                continue
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
                    if len(cells) >= 40:
                        break
                if any(cells):
                    rows.append({
                        "file": filename,
                        "sheet": sheet_name,
                        "rowIndex": int(float(row.attrib.get("r", "0"))),
                        "cells": cells,
                    })
    return rows

rows = []
for filename in sys.argv[1:]:
    if filename.endswith(".xlsx"):
        rows.extend(parse_xlsx(filename))
    elif filename.endswith(".ods"):
        rows.extend(parse_ods(filename))
print(json.dumps(rows))
`;

function fail(message: string): never {
  throw new Error(message);
}

export function parseSpreadsheetFiles(files: string[]) {
  if (files.length === 0) {
    fail("No .xlsx or .ods files were provided");
  }

  for (const file of files) {
    if (!fs.existsSync(file)) {
      fail(`Missing spreadsheet: ${file}`);
    }
  }

  const output = execFileSync("python3", ["-c", spreadsheetParser, ...files], {
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024
  });
  return JSON.parse(output) as DemoRow[];
}

function readDemoRows() {
  const demoFiles = collectDemoDataFiles();
  if (demoFiles.length === 0) {
    fail(`No .xlsx or .ods files found in ${demoDataDir}`);
  }

  return parseSpreadsheetFiles(demoFiles);
}

function inferredYear(row: DemoRow) {
  const match = path.basename(row.file).match(/20\d{2}/);
  return match ? Number(match[0]) : 2026;
}

function normalizeYear(input: number) {
  if (input < 100) {
    return input < 50 ? 2000 + input : 1900 + input;
  }
  return input;
}

function dateOnly(year: number, month: number, day: number) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseDate(value: string | undefined, fallbackYear: number) {
  const clean = (value ?? "").trim();
  if (!clean || clean.startsWith("#")) {
    return null;
  }

  const serial = clean.match(/^\d+(?:\.\d+)?$/);
  if (serial) {
    const days = Math.floor(Number(clean));
    if (days > 20000 && days < 80000) {
      const date = new Date(Date.UTC(1899, 11, 30));
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    }
  }

  const iso = clean.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return dateOnly(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  const monthNames: Record<string, number> = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12
  };
  const named = clean.match(/^(\d{1,2})-([A-Za-z]+)-(\d{2,4})/);
  if (named) {
    const month = monthNames[named[2].toLowerCase()];
    if (!month) {
      return null;
    }
    return dateOnly(normalizeYear(Number(named[3])), month, Number(named[1]));
  }

  // Fertility rows sometimes use ranges like "4/5-5/30"; import the first date.
  const slash = clean.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (slash) {
    return dateOnly(normalizeYear(slash[3] ? Number(slash[3]) : fallbackYear), Number(slash[1]), Number(slash[2]));
  }

  return null;
}

export function parseNumber(value: string | undefined) {
  const clean = (value ?? "").replace(/,/g, "").trim();
  if (!clean || clean.startsWith("#")) {
    return null;
  }
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseLocationReference(value: string | undefined): DemoLocation[] {
  const source = (value ?? "").toUpperCase().replace(/\s+/g, "");
  const found = new Set<DemoLocation>();

  const addLocation = (prefix: string, digit: number) => {
    const location = `${prefix}${digit}` as DemoLocation;
    if (allowedLocations.has(location)) {
      found.add(location);
    }
  };

  for (const match of source.matchAll(/([BH])(\d)\s*[-/]\s*([BH])?(\d)/g)) {
    const prefix = match[1];
    const start = Number(match[2]);
    const end = Number(match[4]);
    const min = Math.min(start, end);
    const max = Math.max(start, end);
    for (let digit = min; digit <= max; digit += 1) {
      addLocation(prefix, digit);
    }
  }

  for (const match of source.matchAll(/([BH])([1-9]{2,})/g)) {
    for (const digit of match[2].split("")) {
      addLocation(match[1], Number(digit));
    }
  }

  for (const match of source.matchAll(/([BH])(\d)/g)) {
    addLocation(match[1], Number(match[2]));
  }

  return [...found].sort();
}

function centroidOf(points: Coordinate[]) {
  const lat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const lng = points.reduce((sum, point) => sum + point.lng, 0) / points.length;
  return { lat, lng };
}

function coordinatesFromGeoJson(geojson: GeoJsonPolygon | null) {
  const ring = geojson?.coordinates?.[0] ?? [];
  const coordinates = ring
    .map(([lng, lat]) => ({ lng, lat }))
    .filter((point) => Number.isFinite(point.lng) && Number.isFinite(point.lat));
  if (coordinates.length >= 2) {
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    if (first.lng === last.lng && first.lat === last.lat) {
      return coordinates.slice(0, -1);
    }
  }
  return coordinates;
}

async function insertZone(client: DbClient, blockId: number, name: string, notes: string, coordinates: Coordinate[]) {
  const box = boundingBox(coordinates);
  const centroid = centroidOf(coordinates);
  const result = await client.query<{ id: number }>(
    `
      insert into block_zones (
        block_id, name, planned_use, actual_state, notes,
        x, y, width, height, geom, boundary, centroid, area_sqm
      )
      values (
        $1, $2, 'beds', 'beds_made', $3,
        $4, $5, $6, $7,
        ST_Transform(ST_GeomFromText($8, 4326), 3857),
        ST_GeomFromText($8, 4326),
        ST_SetSRID(ST_MakePoint($9, $10), 4326),
        ST_Area(ST_GeomFromText($8, 4326)::geography)
      )
      returning id
    `,
    [blockId, name, notes, box.x, box.y, box.width, box.height, polygonWkt(coordinates), centroid.lng, centroid.lat]
  );
  return result.rows[0].id;
}

async function insertBed(
  client: DbClient,
  blockId: number,
  zoneId: number,
  name: string,
  notes: string,
  bedLengthM: number,
  coordinates: Coordinate[]
) {
  const box = boundingBox(coordinates);
  const centroid = centroidOf(coordinates);
  const result = await client.query<{ id: number }>(
    `
      insert into beds (
        block_id, zone_id, name, is_permanent, notes, x, y, width, height, bed_length_m,
        geom, boundary, centroid, area_sqm, source
      )
      values (
        $1, $2, $3, true, $4, $5, $6, $7, $8, $9,
        ST_Transform(ST_GeomFromText($10, 4326), 3857),
        ST_GeomFromText($10, 4326),
        ST_SetSRID(ST_MakePoint($11, $12), 4326),
        ST_Area(ST_GeomFromText($10, 4326)::geography),
        'demo_import'
      )
      returning id
    `,
    [
      blockId,
      zoneId,
      name,
      notes,
      box.x,
      box.y,
      box.width,
      box.height,
      bedLengthM,
      polygonWkt(coordinates),
      centroid.lng,
      centroid.lat
    ]
  );
  return result.rows[0].id;
}

async function insertFarmEvent(
  client: DbClient,
  options: {
    farmId: number;
    eventDate: string;
    eventType: string;
    title: string;
    notes: string;
    metadata: Record<string, unknown>;
    blockId?: number | null;
    zoneId?: number | null;
    bedId?: number | null;
    plantingId?: number | null;
    coordinates?: Coordinate[] | null;
  }
) {
  const wkt = options.coordinates && options.coordinates.length >= 3 ? polygonWkt(options.coordinates) : null;
  await client.query(
    `
      insert into farm_events (
        farm_id, event_date, event_type, title, notes, metadata,
        block_id, zone_id, bed_id, planting_id,
        boundary, centroid, area_sqm
      )
      values (
        $1, $2, $3, $4, $5, $6::jsonb,
        $7, $8, $9, $10,
        case when $11::text is null then null else ST_GeomFromText($11, 4326) end,
        case when $11::text is null then null else ST_Centroid(ST_GeomFromText($11, 4326)) end,
        case when $11::text is null then null else ST_Area(ST_GeomFromText($11, 4326)::geography) end
      )
    `,
    [
      options.farmId,
      options.eventDate,
      options.eventType,
      options.title,
      options.notes,
      JSON.stringify(options.metadata),
      options.blockId ?? null,
      options.zoneId ?? null,
      options.bedId ?? null,
      options.plantingId ?? null,
      wkt
    ]
  );
}

async function upsertCrop(client: DbClient, name: string) {
  const result = await client.query<{ id: number }>(
    `
      insert into crops (name)
      values ($1)
      on conflict (name) do update set name = excluded.name
      returning id
    `,
    [name]
  );
  return result.rows[0].id;
}

async function upsertVariety(client: DbClient, cropId: number, name: string | null) {
  if (!name) {
    return null;
  }
  const result = await client.query<{ id: number }>(
    `
      insert into varieties (crop_id, name)
      values ($1, $2)
      on conflict (crop_id, name) do update set name = excluded.name
      returning id
    `,
    [cropId, name]
  );
  return result.rows[0].id;
}

async function insertTaskFlowTemplate(
  client: DbClient,
  farmId: number,
  options: {
    name: string;
    notes: string;
    cropId?: number | null;
    isDefault?: boolean;
    nodes: Array<{
      nodeKey: string;
      taskType: TaskType;
      label: string;
      anchor: TaskAnchor;
      offsetDays: number;
      x: number;
      y: number;
    }>;
    edges: Array<{ fromNodeKey: string; toNodeKey: string }>;
  }
) {
  const template = await client.query<{ id: number }>(
    `
      insert into task_flow_templates (farm_id, crop_id, name, notes, is_default)
      values ($1, $2, $3, $4, $5)
      on conflict (farm_id, name) do update
      set notes = excluded.notes,
          is_default = excluded.is_default,
          updated_at = now()
      returning id
    `,
    [farmId, options.cropId ?? null, options.name, options.notes, options.isDefault ?? false]
  );
  const templateId = template.rows[0].id;
  await client.query(`delete from task_flow_edges where flow_template_id = $1`, [templateId]);
  await client.query(`delete from task_flow_nodes where flow_template_id = $1`, [templateId]);

  const nodeIds = new Map<string, number>();
  for (const node of options.nodes) {
    const result = await client.query<{ id: number }>(
      `
        insert into task_flow_nodes (
          flow_template_id, node_key, task_type, label, anchor, offset_days, x_pos, y_pos
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        returning id
      `,
      [templateId, node.nodeKey, node.taskType, node.label, node.anchor, node.offsetDays, node.x, node.y]
    );
    nodeIds.set(node.nodeKey, result.rows[0].id);
  }

  for (const edge of options.edges) {
    const fromNodeId = nodeIds.get(edge.fromNodeKey);
    const toNodeId = nodeIds.get(edge.toNodeKey);
    if (!fromNodeId || !toNodeId) {
      continue;
    }
    await client.query(
      `insert into task_flow_edges (flow_template_id, from_node_id, to_node_id) values ($1, $2, $3)`,
      [templateId, fromNodeId, toNodeId]
    );
  }

  return templateId;
}

function sourceLabel(row: DemoRow) {
  return `${path.basename(row.file)}:${row.sheet}:row ${row.rowIndex}`;
}

async function prepareDemoAccount(client: DbClient) {
  const user = await client.query<{ id: number }>(
    `
      insert into app_users (email, username, password_hash, display_name, is_active)
      values ($1, $2, $3, 'Demo B/H Planner', true)
      on conflict (username) do update
      set email = excluded.email,
          password_hash = excluded.password_hash,
          display_name = excluded.display_name,
          is_active = true,
          updated_at = now()
      returning id
    `,
    [`${demoUsername}@farmfield-valley.local`, demoUsername, hashPassword(demoPassword)]
  );
  const userId = user.rows[0].id;

  const existingFarm = await client.query<{ farm_id: number }>(
    `
      select membership.farm_id
      from farm_memberships membership
      join farms farm on farm.id = membership.farm_id
      where membership.user_id = $1
      order by farm.id
      limit 1
    `,
    [userId]
  );

  if (existingFarm.rows[0]) {
    const farmId = existingFarm.rows[0].farm_id;
    await client.query(
      `
        insert into farm_memberships (farm_id, user_id, role)
        values ($1, $2, 'planner')
        on conflict (farm_id, user_id) do update set role = 'planner'
      `,
      [farmId, userId]
    );
    return farmId;
  }

  const farm = await client.query<{ id: number }>(
    `insert into farms (name, notes) values ($1, 'Demo import from local B/H spreadsheets') returning id`,
    [demoFarmName]
  );
  const farmId = farm.rows[0].id;
  await client.query(`insert into farm_memberships (farm_id, user_id, role) values ($1, $2, 'planner')`, [farmId, userId]);
  return farmId;
}

async function backupExistingFarmMap(client: DbClient, farmId: number) {
  await client.query(`
    create table if not exists demo_import_map_backups (
      id serial primary key,
      farm_id integer not null references farms(id) on delete cascade,
      username text not null,
      snapshot jsonb not null,
      created_at timestamptz not null default now()
    )
  `);

  await client.query(
    `
      insert into demo_import_map_backups (farm_id, username, snapshot)
      values (
        $1,
        $2,
        jsonb_build_object(
          'fields', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', field.id,
              'name', field.name,
              'notes', field.notes,
              'boundary', ST_AsGeoJSON(field.boundary)::jsonb
            ) order by field.id), '[]'::jsonb)
            from fields field
            where field.farm_id = $1
          ),
          'blocks', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', block.id,
              'fieldId', block.field_id,
              'name', block.name,
              'notes', block.notes,
              'boundary', ST_AsGeoJSON(block.boundary)::jsonb
            ) order by block.id), '[]'::jsonb)
            from blocks block
            join fields field on field.id = block.field_id
            where field.farm_id = $1
          ),
          'blockZones', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', zone.id,
              'blockId', zone.block_id,
              'name', zone.name,
              'plannedUse', zone.planned_use,
              'actualState', zone.actual_state,
              'boundary', ST_AsGeoJSON(zone.boundary)::jsonb
            ) order by zone.id), '[]'::jsonb)
            from block_zones zone
            join blocks block on block.id = zone.block_id
            join fields field on field.id = block.field_id
            where field.farm_id = $1
          ),
          'beds', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', bed.id,
              'blockId', bed.block_id,
              'zoneId', bed.zone_id,
              'name', bed.name,
              'source', bed.source,
              'boundary', ST_AsGeoJSON(coalesce(bed.boundary, ST_Transform(bed.geom, 4326)))::jsonb
            ) order by bed.id), '[]'::jsonb)
            from beds bed
            join blocks block on block.id = bed.block_id
            join fields field on field.id = block.field_id
            where field.farm_id = $1
          )
        )
      )
    `,
    [farmId, demoUsername]
  );
}

async function clearImportedData(client: DbClient, farmId: number) {
  await client.query(
    `delete from farm_events where farm_id = $1 and metadata->>'source' = 'demo_spreadsheet'`,
    [farmId]
  );
  await client.query(
    `delete from plantings where farm_id = $1 and notes like 'Imported from %'`,
    [farmId]
  );
  await client.query(
    `delete from task_flow_edges where flow_template_id in (select id from task_flow_templates where farm_id = $1 and name = 'Imported crop default flow')`,
    [farmId]
  );
  await client.query(
    `delete from task_flow_nodes where flow_template_id in (select id from task_flow_templates where farm_id = $1 and name = 'Imported crop default flow')`,
    [farmId]
  );
  await client.query(
    `delete from task_flow_steps where flow_template_id in (select id from task_flow_templates where farm_id = $1 and name = 'Imported crop default flow')`,
    [farmId]
  );
  await client.query(`delete from task_flow_templates where farm_id = $1 and name = 'Imported crop default flow'`, [farmId]);
}

async function ensureZoneForBlock(client: DbClient, blockId: number, location: DemoLocation, blockBoundary: Coordinate[]) {
  const existing = await client.query<{ id: number }>(
    `select id from block_zones where block_id = $1 order by id limit 1`,
    [blockId]
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  return insertZone(
    client,
    blockId,
    `${location} imported current area`,
    "Created by the demo spreadsheet importer because this block did not have a zone yet.",
    blockBoundary
  );
}

async function ensureBedForBlock(
  client: DbClient,
  blockId: number,
  zoneId: number,
  location: DemoLocation,
  blockBoundary: Coordinate[],
  allowAnyExistingBed: boolean
) {
  const exact = await client.query<{ id: number; boundary: GeoJsonPolygon | null }>(
    `
      select id, ST_AsGeoJSON(coalesce(boundary, ST_Transform(geom, 4326)))::json as boundary
      from beds
      where block_id = $1 and upper(name) = upper($2)
      order by id
      limit 1
    `,
    [blockId, location]
  );
  if (exact.rows[0]) {
    return {
      id: exact.rows[0].id,
      boundary: coordinatesFromGeoJson(exact.rows[0].boundary)
    };
  }

  if (allowAnyExistingBed) {
    const existing = await client.query<{ id: number; boundary: GeoJsonPolygon | null }>(
      `
        select id, ST_AsGeoJSON(coalesce(boundary, ST_Transform(geom, 4326)))::json as boundary
        from beds
        where block_id = $1
        order by case when source = 'demo_import' then 0 else 1 end, id
        limit 1
      `,
      [blockId]
    );
    if (existing.rows[0]) {
      return {
        id: existing.rows[0].id,
        boundary: coordinatesFromGeoJson(existing.rows[0].boundary)
      };
    }
  }

  const bedId = await insertBed(
    client,
    blockId,
    zoneId,
    location,
    "Created by the demo spreadsheet importer so crop rows can attach to this existing block.",
    defaultBedLengthM,
    blockBoundary
  );
  return { id: bedId, boundary: blockBoundary };
}

async function upsertDemoBedPresets(client: DbClient, farmId: number) {
  await client.query(
    `
      insert into bed_presets (farm_id, name, bed_width_m, path_spacing_m, notes)
      values
        ($1, 'Demo 4 ft bed', 1.22, 0.46, 'Imported demo default bed width'),
        ($1, 'Demo narrow bed', 0.91, 0.46, 'Imported demo narrower bed width')
      on conflict (farm_id, name) do update
      set bed_width_m = excluded.bed_width_m,
          path_spacing_m = excluded.path_spacing_m,
          notes = excluded.notes,
          updated_at = now()
    `,
    [farmId]
  );
}

async function loadExistingDemoMap(client: DbClient, farmId: number) {
  const blockIds = new Map<DemoLocation, number>();
  const zoneIds = new Map<DemoLocation, number>();
  const bedIds = new Map<DemoLocation, number>();
  const bedBoundaries = new Map<DemoLocation, Coordinate[]>();

  const blocks = await client.query<{ id: number; name: string; boundary: GeoJsonPolygon | null }>(
    `
      select block.id, block.name, ST_AsGeoJSON(block.boundary)::json as boundary
      from blocks block
      join fields field on field.id = block.field_id
      where field.farm_id = $1
      order by block.id
    `,
    [farmId]
  );

  for (const block of blocks.rows) {
    const locations = parseLocationReference(block.name);
    if (locations.length === 0) {
      continue;
    }

    const blockBoundary = coordinatesFromGeoJson(block.boundary);
    if (blockBoundary.length < 3) {
      continue;
    }

    for (const location of locations) {
      if (blockIds.has(location)) {
        continue;
      }

      const zoneId = await ensureZoneForBlock(client, block.id, location, blockBoundary);
      const bed = await ensureBedForBlock(client, block.id, zoneId, location, blockBoundary, locations.length === 1);
      blockIds.set(location, block.id);
      zoneIds.set(location, zoneId);
      bedIds.set(location, bed.id);
      bedBoundaries.set(location, bed.boundary.length >= 3 ? bed.boundary : blockBoundary);
    }
  }

  await upsertDemoBedPresets(client, farmId);

  const missingLocations = [...allowedLocations].filter((location) => !blockIds.has(location));
  if (missingLocations.length > 0) {
    console.warn(`Demo import warning: missing existing blocks for ${missingLocations.join(", ")}. Rows for those locations will be skipped.`);
  }
  if (blockIds.size === 0) {
    fail("No existing B1/B2/B3/H2/H3/H4/H5/H6 blocks were found. I did not create replacement fields or blocks.");
  }

  return { blockIds, zoneIds, bedIds, bedBoundaries };
}

async function createDefaultTaskFlow(client: DbClient, farmId: number) {
  return insertTaskFlowTemplate(client, farmId, {
    name: "Imported crop default flow",
    notes: "Simple default flow used by the B/H spreadsheet demo import.",
    isDefault: true,
    nodes: [
      { nodeKey: "bed_prep", taskType: "bed_prep", label: "Prep bed or block", anchor: "planned_transplant", offsetDays: -7, x: 0.14, y: 0.34 },
      { nodeKey: "seed", taskType: "seed_in_tray", label: "Seed or start crop", anchor: "actual_tray_seeding", offsetDays: 0, x: 0.14, y: 0.68 },
      { nodeKey: "transplant", taskType: "transplant", label: "Plant in field", anchor: "actual_transplant", offsetDays: 0, x: 0.42, y: 0.52 },
      { nodeKey: "cultivate", taskType: "cultivate", label: "Cultivate or weed", anchor: "actual_transplant", offsetDays: 12, x: 0.66, y: 0.34 },
      { nodeKey: "harvest", taskType: "harvest", label: "Harvest start", anchor: "actual_transplant", offsetDays: 45, x: 0.66, y: 0.68 },
      { nodeKey: "finish", taskType: "finish_crop", label: "Finish crop", anchor: "actual_harvest", offsetDays: 21, x: 0.9, y: 0.68 }
    ],
    edges: [
      { fromNodeKey: "bed_prep", toNodeKey: "transplant" },
      { fromNodeKey: "seed", toNodeKey: "transplant" },
      { fromNodeKey: "transplant", toNodeKey: "cultivate" },
      { fromNodeKey: "transplant", toNodeKey: "harvest" },
      { fromNodeKey: "harvest", toNodeKey: "finish" }
    ]
  });
}

async function importPlantings(
  client: DbClient,
  rows: DemoRow[],
  farmId: number,
  taskFlowTemplateId: number,
  bedIds: Map<DemoLocation, number>
) {
  let imported = 0;
  const plantingIds: number[] = [];

  for (const row of rows) {
    if (row.sheet !== "Start Chart") {
      continue;
    }

    const [
      cropNameRaw,
      varietyNameRaw,
      fieldDateRaw,
      bedLengthFtRaw,
      ,
      locationRaw,
      harvestStartRaw,
      expectedYieldRaw,
      expectedUnitRaw,
      ,
      transplantsPer100FtRaw,
      transplantCountRaw,
      sowDateRaw,
      traySizeRaw,
      spacingRaw,
      ,
      totalBedFeetRaw
    ] = row.cells;
    const cropName = cropNameRaw?.trim();
    if (!cropName || cropName.toLowerCase() === "crop" || cropName.startsWith("#")) {
      continue;
    }

    const locations = parseLocationReference(locationRaw);
    if (locations.length === 0) {
      continue;
    }

    const year = inferredYear(row);
    if (year !== demoImportYear) {
      continue;
    }

    const bedLengthFt = parseNumber(bedLengthFtRaw) ?? parseNumber(totalBedFeetRaw);
    const transplantsPer100Ft = parseNumber(transplantsPer100FtRaw);
    const spreadsheetTransplantCount = parseNumber(transplantCountRaw);
    const plantCount = spreadsheetTransplantCount
      ?? (transplantsPer100Ft != null && bedLengthFt != null ? (transplantsPer100Ft * bedLengthFt) / 100 : null);
    const totalBedFeet = parseNumber(totalBedFeetRaw);
    const plannedTransplantDate = parseDate(fieldDateRaw, year);
    const plannedSowDate = parseDate(sowDateRaw, year);
    const expectedHarvestStart = parseDate(harvestStartRaw, year);
    const expectedHarvestEnd = expectedHarvestStart;
    const bedLengthUsedM = bedLengthFt != null ? Number((bedLengthFt * feetToMeters).toFixed(2)) : null;
    const parentPlantCount = plantCount != null ? Math.round(plantCount) : null;

    if (parentPlantCount == null && bedLengthUsedM == null) {
      continue;
    }

    const cropId = await upsertCrop(client, cropName);
    const varietyId = await upsertVariety(client, cropId, varietyNameRaw?.trim() || null);
    const intendedBedId = bedIds.get(locations[0]) ?? null;
    const transplantedAlready = plannedTransplantDate != null && plannedTransplantDate <= new Date().toISOString().slice(0, 10);
    const notes = [
      `Imported from ${sourceLabel(row)}.`,
      `Spreadsheet location: ${locationRaw}.`,
      expectedYieldRaw || expectedUnitRaw ? `Expected yield: ${[expectedYieldRaw, expectedUnitRaw].filter(Boolean).join(" ")}.` : null,
      transplantsPer100Ft != null ? `Source TP/100ft: ${transplantsPer100Ft}.` : null,
      spreadsheetTransplantCount != null ? `Source TP Needed: ${spreadsheetTransplantCount}.` : null,
      totalBedFeet != null ? `Source total bed feet: ${totalBedFeet}.` : null,
      traySizeRaw ? `Source tray/cell note: ${traySizeRaw}.` : null,
      spacingRaw ? `Source spacing note: ${spacingRaw}.` : null
    ].filter(Boolean).join("\n");

    const result = await client.query<{ id: number }>(
      `
        insert into plantings (
          farm_id, crop_id, variety_id, title, status, intended_bed_id, task_flow_template_id,
          spacing, plant_count, bed_length_used_m, notes,
          planned_sow_date, planned_transplant_date, expected_harvest_start, expected_harvest_end,
          actual_tray_seeding_date, actual_transplant_date, actual_harvest_date, actual_finish_date
        )
        values (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11,
          $12, $13, $14, $15,
          $16, $17, $18, $19
        )
        returning id
      `,
      [
        farmId,
        cropId,
        varietyId,
        `${year} ${cropName}${varietyNameRaw?.trim() ? ` - ${varietyNameRaw.trim()}` : ""} (${locationRaw})`,
        transplantedAlready ? "transplanted" : "planned",
        intendedBedId,
        taskFlowTemplateId,
        spacingRaw ? `Source spacing/cell value: ${spacingRaw}` : null,
        parentPlantCount,
        bedLengthUsedM,
        notes,
        plannedSowDate,
        plannedTransplantDate,
        expectedHarvestStart,
        expectedHarvestEnd,
        transplantedAlready ? plannedSowDate : null,
        transplantedAlready ? plannedTransplantDate : null,
        null,
        null
      ]
    );

    const plantingId = result.rows[0].id;
    plantingIds.push(plantingId);
    imported += 1;

    const placementCount = locations.length;
    for (const location of locations) {
      const bedId = bedIds.get(location);
      if (!bedId) {
        continue;
      }
      const placementPlantCount = parentPlantCount != null ? Math.max(1, Math.round(parentPlantCount / placementCount)) : null;
      const placementBedLengthM = bedLengthUsedM != null ? Number((bedLengthUsedM / placementCount).toFixed(2)) : null;
      await client.query(
        `
          insert into planting_placements (
            planting_id, bed_id, plant_count, bed_length_used_m, placed_on, location_detail, notes
          )
          values ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          plantingId,
          bedId,
          placementPlantCount,
          placementBedLengthM,
          transplantedAlready ? plannedTransplantDate : null,
          `Imported ${location} share of ${locationRaw}`,
          `Imported from ${sourceLabel(row)}`
        ]
      );
    }

    await recalculatePlantingTasks(client, plantingId);
  }

  return { imported, plantingIds };
}

async function importFertilityEvents(
  client: DbClient,
  rows: DemoRow[],
  farmId: number,
  blockIds: Map<DemoLocation, number>,
  zoneIds: Map<DemoLocation, number>,
  bedIds: Map<DemoLocation, number>,
  bedBoundaries: Map<DemoLocation, Coordinate[]>
) {
  let imported = 0;

  for (const row of rows) {
    if (row.sheet !== "Fertility Needs" && row.sheet !== "Fertilization Plan") {
      continue;
    }
    const locations = parseLocationReference(row.cells[0]);
    if (locations.length === 0) {
      continue;
    }

    const year = inferredYear(row);
    if (year !== demoImportYear) {
      continue;
    }
    const eventDate = parseDate(row.sheet === "Fertilization Plan" ? row.cells[5] : row.cells[2], year);
    if (!eventDate) {
      continue;
    }

    const title = row.sheet === "Fertilization Plan"
      ? `${row.cells[4] || "Fertility"} for ${row.cells[1] || row.cells[0]}`
      : `Fertility plan for ${row.cells[1] || row.cells[0]}`;
    const notes = [
      `Imported from ${sourceLabel(row)}.`,
      `Spreadsheet location: ${row.cells[0]}.`,
      row.sheet === "Fertilization Plan" ? `Amount: ${[row.cells[6], row.cells[7]].filter(Boolean).join(" ")}.` : null,
      row.sheet === "Fertilization Plan" ? `Method: ${row.cells[8] || "not listed"}.` : null,
      row.sheet === "Fertility Needs" ? `Materials: ${[row.cells[4], row.cells[5], row.cells[6], row.cells[7]].filter(Boolean).join("; ")}.` : null,
      row.sheet === "Fertility Needs" ? `Cover crop notes: ${[row.cells[9], row.cells[10]].filter(Boolean).join("; ")}.` : null
    ].filter(Boolean).join("\n");

    for (const location of locations) {
      await insertFarmEvent(client, {
        farmId,
        eventDate,
        eventType: row.sheet === "Fertilization Plan" ? "fertility_application" : "fertility_plan",
        title: `${title} (${location})`,
        notes,
        metadata: {
          source: "demo_spreadsheet",
          sourceSheet: row.sheet,
          sourceRow: row.rowIndex,
          location,
          timelineVisible: true,
          stateCategory: "amendment"
        },
        blockId: blockIds.get(location) ?? null,
        zoneId: zoneIds.get(location) ?? null,
        bedId: bedIds.get(location) ?? null,
        coordinates: bedBoundaries.get(location) ?? null
      });
      imported += 1;
    }
  }

  return imported;
}

/**
 * Imports a perfectly formatted crop-plan spreadsheet into an existing farm.
 *
 * This is the reusable core used by both the terminal demo-import script and the
 * user-facing upload route. It intentionally does not create fields or blocks:
 * the workbook location names must match already-drawn block names such as B1,
 * B2, H4, or similar references the importer understands.
 */
export async function importSpreadsheetRowsForFarm(client: DbClient, rows: DemoRow[], farmId: number) {
  await clearImportedData(client, farmId);
  const { blockIds, zoneIds, bedIds, bedBoundaries } = await loadExistingDemoMap(client, farmId);
  const taskFlowTemplateId = await createDefaultTaskFlow(client, farmId);
  const plantings = await importPlantings(client, rows, farmId, taskFlowTemplateId, bedIds);
  const fertilityEvents = await importFertilityEvents(client, rows, farmId, blockIds, zoneIds, bedIds, bedBoundaries);

  return {
    parsedRows: rows.length,
    importedPlantings: plantings.imported,
    importedFertilityEvents: fertilityEvents
  };
}

async function run() {
  const rows = readDemoRows();
  const client = await pool.connect();
  let farmId: number | null = null;

  try {
    await client.query("begin");
    const preparedFarmId = await prepareDemoAccount(client);
    farmId = preparedFarmId;
    await backupExistingFarmMap(client, preparedFarmId);
    await client.query("commit");

    await client.query("begin");
    const importResult = await importSpreadsheetRowsForFarm(client, rows, preparedFarmId);
    await client.query("commit");

    console.log(`Demo import complete for ${demoUsername}`);
    console.log(`Farm ID: ${farmId}`);
    console.log(`Map backup saved in demo_import_map_backups`);
    console.log(`Imported plantings: ${importResult.importedPlantings}`);
    console.log(`Imported fertility events: ${importResult.importedFertilityEvents}`);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
