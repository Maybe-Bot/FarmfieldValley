import { PoolClient, QueryResult } from "pg";
import { plantingImportHeaders } from "./planting-spreadsheet-import";

type CellValue = string | number | boolean | null | undefined;

type WorkbookSheet = {
  name: string;
  rows: CellValue[][];
};

const METERS_TO_FEET = 3.280839895;

function formatDateCell(value: unknown) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function formatNumberCell(value: unknown, digits = 2) {
  if (value == null || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return Number.isInteger(number) ? String(number) : number.toFixed(digits).replace(/\.?0+$/, "");
}

function formatBedCover(value: unknown) {
  if (value === "plastic") return "plastic mulch";
  if (value === "bare") return "bare";
  return "";
}

function cellText(value: CellValue) {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

function safeSheetName(name: string, usedNames: Set<string>) {
  const cleaned = name.replace(/[\[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Sheet";
  let candidate = cleaned;
  let index = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    const suffix = ` ${index}`;
    candidate = `${cleaned.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`;
    index += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function columnName(index: number) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function sheetXml(rows: CellValue[][]) {
  const rowXml = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const text = cellText(value);
      const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
      return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>${rowXml}</sheetData></worksheet>`;
}

function workbookXml(sheetNames: string[]) {
  const sheets = sheetNames.map((name, index) => (
    `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
  )).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`;
}

function workbookRelsXml(sheetCount: number) {
  const rels = Array.from({ length: sheetCount }, (_item, index) => (
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  )).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
}

function contentTypesXml(sheetCount: number) {
  const overrides = Array.from({ length: sheetCount }, (_item, index) => (
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`;
}

const crcTable = (() => {
  const table: number[] = [];
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function zipFiles(files: Array<{ path: string; content: string | Buffer }>) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const { dosDate, dosTime } = dosDateTime();

  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8");
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

export function buildXlsxWorkbook(sheets: WorkbookSheet[]) {
  const usedNames = new Set<string>();
  const normalizedSheets = sheets.map((sheet) => ({
    name: safeSheetName(sheet.name, usedNames),
    rows: sheet.rows
  }));
  const files = [
    { path: "[Content_Types].xml", content: contentTypesXml(normalizedSheets.length) },
    { path: "_rels/.rels", content: rootRelsXml() },
    { path: "xl/workbook.xml", content: workbookXml(normalizedSheets.map((sheet) => sheet.name)) },
    { path: "xl/_rels/workbook.xml.rels", content: workbookRelsXml(normalizedSheets.length) },
    ...normalizedSheets.map((sheet, index) => ({
      path: `xl/worksheets/sheet${index + 1}.xml`,
      content: sheetXml(sheet.rows)
    }))
  ];
  return zipFiles(files);
}

function queryRowsToSheet(name: string, result: QueryResult<Record<string, unknown>>): WorkbookSheet {
  const columns = result.fields.map((field) => field.name);
  return {
    name,
    rows: [
      columns,
      ...result.rows.map((row) => columns.map((column) => {
        const value = row[column];
        if (value == null) return "";
        if (value instanceof Date) return value.toISOString();
        if (typeof value === "object") return JSON.stringify(value);
        return String(value);
      }))
    ]
  };
}

export async function buildFarmExportWorkbook(client: PoolClient, farmId: number) {
  const plantings = await client.query<Record<string, unknown>>(`
    select
      coalesce(seed.supplier, '') as "Seed supplier",
      c.name as "Crop",
      coalesce(seed.variety_name, seed.breed_name, v.name, '') as "Variety",
      coalesce(seed.catalog_number, '') as "Catalog number",
      p.planned_sow_date as "Start date",
      p.plant_count as "Plant count",
      p.bed_length_used_m as "Bed length m",
      p.planned_transplant_date as "Transplant date",
      p.tray_count as "Tray count",
      p.cells_per_tray as "Cells per tray",
      p.days_to_harvest as "Days to harvest",
      p.field_spacing_in_row as "Field spacing in row",
      p.row_spacing as "Row spacing",
      p.rows_per_bed as "Rows per bed",
      p.bed_cover as "Bed cover",
      coalesce(field.name, '') as "Field",
      coalesce(block.name, '') as "Block",
      coalesce(bed.name, '') as "Bed",
      coalesce(p.notes, '') as "Notes"
    from plantings p
    join crops c on c.id = p.crop_id
    left join varieties v on v.id = p.variety_id
    left join seed_items seed on seed.id = p.seed_item_id
    left join fields field on field.id = p.intended_field_id
    left join blocks block on block.id = p.intended_block_id
    left join beds bed on bed.id = p.intended_bed_id
    where p.farm_id = $1
    order by coalesce(p.planned_sow_date, p.planned_transplant_date), p.id
  `, [farmId]);

  const plantingRows: CellValue[][] = [
    [...plantingImportHeaders],
    ...plantings.rows.map((row) => [
      row["Seed supplier"] as string,
      row.Crop as string,
      row.Variety as string,
      row["Catalog number"] as string,
      formatDateCell(row["Start date"]),
      formatNumberCell(row["Plant count"], 0),
      row["Bed length m"] == null ? "" : formatNumberCell(Number(row["Bed length m"]) * METERS_TO_FEET, 2),
      formatDateCell(row["Transplant date"]),
      formatNumberCell(row["Tray count"], 2),
      formatNumberCell(row["Cells per tray"], 0),
      formatNumberCell(row["Days to harvest"], 0),
      formatNumberCell(row["Field spacing in row"], 2),
      formatNumberCell(row["Row spacing"], 2),
      formatNumberCell(row["Rows per bed"], 0),
      formatBedCover(row["Bed cover"]),
      row.Field as string,
      row.Block as string,
      row.Bed as string,
      row.Notes as string
    ])
  ];

  const sheetQueries: Array<Promise<WorkbookSheet>> = [
    client.query<Record<string, unknown>>(`select id, name, notes, maps_private as "mapsPrivate" from farms where id = $1`, [farmId]).then((result) => queryRowsToSheet("Farm", result)),
    client.query<Record<string, unknown>>(`select id, name, notes, area_sqm as "areaSqM", ST_AsGeoJSON(boundary)::json as boundary from fields where farm_id = $1 order by id`, [farmId]).then((result) => queryRowsToSheet("Fields", result)),
    client.query<Record<string, unknown>>(`
      select block.id, block.field_id as "fieldId", field.name as "fieldName", block.name, block.notes, block.bed_start_entrance_side as "bedStartEntranceSide", block.area_sqm as "areaSqM", ST_AsGeoJSON(block.boundary)::json as boundary
      from blocks block
      join fields field on field.id = block.field_id
      where field.farm_id = $1
      order by field.id, block.id
    `, [farmId]).then((result) => queryRowsToSheet("Blocks", result)),
    client.query<Record<string, unknown>>(`
      select zone.id, zone.block_id as "blockId", block.name as "blockName", zone.name, zone.planned_use as "plannedUse", zone.actual_state as "actualState", zone.cover_crop_name_id as "coverCropNameId", cover_crop.name as "coverCropName", zone.planned_cover_crop_seed_date as "plannedCoverCropSeedDate", zone.planned_cover_crop_terminate_date as "plannedCoverCropTerminateDate", zone.actual_cover_crop_seed_date as "actualCoverCropSeedDate", zone.actual_cover_crop_terminate_date as "actualCoverCropTerminateDate", zone.area_sqm as "areaSqM", zone.notes, ST_AsGeoJSON(zone.boundary)::json as boundary
      from block_zones zone
      join blocks block on block.id = zone.block_id
      join fields field on field.id = block.field_id
      left join cover_crop_names cover_crop on cover_crop.id = zone.cover_crop_name_id
      where field.farm_id = $1
      order by block.id, zone.id
    `, [farmId]).then((result) => queryRowsToSheet("Block Areas", result)),
    client.query<Record<string, unknown>>(`
      select bed.id, bed.block_id as "blockId", block.name as "blockName", bed.zone_id as "zoneId", bed.name, bed.source, bed.sequence_no as "sequenceNo", bed.bed_preset_id as "bedPresetId", bed.bed_length_m as "bedLengthM", bed.area_sqm as "areaSqM", bed.notes, ST_AsGeoJSON(coalesce(bed.boundary, ST_Transform(bed.geom, 4326)))::json as boundary
      from beds bed
      join blocks block on block.id = bed.block_id
      join fields field on field.id = block.field_id
      where field.farm_id = $1
      order by block.id, bed.sequence_no nulls last, bed.id
    `, [farmId]).then((result) => queryRowsToSheet("Beds", result)),
    client.query<Record<string, unknown>>(`select id, name, bed_width_m as "bedWidthM", path_spacing_m as "pathSpacingM", is_road as "isRoad", notes from bed_presets where farm_id = $1 order by name`, [farmId]).then((result) => queryRowsToSheet("Bed Presets", result)),
    client.query<Record<string, unknown>>(`select id, name, notes from cover_crop_names where farm_id = $1 order by name`, [farmId]).then((result) => queryRowsToSheet("Cover Crops", result)),
    client.query<Record<string, unknown>>(`
      select id, crop_type as "cropType", variety_name as "varietyName", breed_name as "breedName", family, supplier, catalog_number as "catalogNumber", lot_number as "lotNumber", stock_quantity as "stockQuantity", days_to_maturity as "daysToMaturity", usual_spacing as "usualSpacing", usual_field_spacing_in_row as "usualFieldSpacingInRow", usual_row_spacing as "usualRowSpacing", usual_rows_per_bed as "usualRowsPerBed", archived_at as "archivedAt", notes
      from seed_items
      where farm_id = $1
      order by archived_at nulls first, crop_type, variety_name nulls last, breed_name nulls last, supplier nulls last
    `, [farmId]).then((result) => queryRowsToSheet("Seed Bank", result)),
    client.query<Record<string, unknown>>(`
      select lot.id, lot.seed_item_id as "seedItemId", seed.crop_type as "cropType", seed.variety_name as "varietyName", seed.supplier, lot.lot_number as "lotNumber", lot.stock_quantity as "stockQuantity"
      from seed_item_lots lot
      join seed_items seed on seed.id = lot.seed_item_id
      where seed.farm_id = $1
      order by seed.crop_type, seed.variety_name nulls last, lot.lot_number
    `, [farmId]).then((result) => queryRowsToSheet("Seed Lots", result)),
    client.query<Record<string, unknown>>(`
      select id, seed_item_id as "seedItemId", task_flow_template_id as "taskFlowTemplateId", intended_field_id as "intendedFieldId", intended_block_id as "intendedBlockId", intended_bed_id as "intendedBedId", title, status, planned_sow_date as "plannedSowDate", planned_transplant_date as "plannedTransplantDate", expected_harvest_start as "expectedHarvestStart", expected_harvest_end as "expectedHarvestEnd", actual_tray_seeding_date as "actualTraySeedingDate", actual_direct_seeding_date as "actualDirectSeedingDate", actual_transplant_date as "actualTransplantDate", actual_harvest_date as "actualHarvestDate", actual_finish_date as "actualFinishDate", plant_count as "plantCount", bed_length_used_m as "bedLengthUsedM", spacing, tray_location as "trayLocation", tray_count as "trayCount", cells_per_tray as "cellsPerTray", days_to_harvest as "daysToHarvest", field_spacing_in_row as "fieldSpacingInRow", row_spacing as "rowSpacing", rows_per_bed as "rowsPerBed", bed_cover as "bedCover", notes
      from plantings
      where farm_id = $1
      order by coalesce(planned_sow_date, planned_transplant_date), id
    `, [farmId]).then((result) => queryRowsToSheet("Planting Details", result)),
    client.query<Record<string, unknown>>(`
      select placement.id, placement.planting_id as "plantingId", planting.title as "plantingTitle", placement.bed_id as "bedId", bed.name as "bedName", placement.plant_count as "plantCount", placement.bed_length_used_m as "bedLengthUsedM", placement.start_length_m as "startLengthM", placement.placement_order as "placementOrder", placement.plan_source as "planSource", placement.placed_on as "placedOn", placement.location_detail as "locationDetail", placement.notes
      from planting_placements placement
      join plantings planting on planting.id = placement.planting_id
      join beds bed on bed.id = placement.bed_id
      where planting.farm_id = $1
      order by placement.id
    `, [farmId]).then((result) => queryRowsToSheet("Placements", result)),
    client.query<Record<string, unknown>>(`select id, block_id as "blockId", bed_id as "bedId", start_length_m as "startLengthM", bed_length_used_m as "bedLengthUsedM", placement_order as "placementOrder", notes from block_placement_gaps where farm_id = $1 order by block_id, placement_order, id`, [farmId]).then((result) => queryRowsToSheet("Placement Gaps", result)),
    client.query<Record<string, unknown>>(`select id, block_id as "blockId", planting_id as "plantingId", entry_type as "entryType", bed_length_used_m as "bedLengthUsedM", plant_count as "plantCount", tray_count as "trayCount", placement_order as "placementOrder", notes from block_placement_overflows where farm_id = $1 order by block_id, placement_order, id`, [farmId]).then((result) => queryRowsToSheet("Placement Overflows", result)),
    client.query<Record<string, unknown>>(`select id, event_date as "eventDate", event_type as "eventType", title, notes, metadata, field_id as "fieldId", block_id as "blockId", zone_id as "zoneId", bed_id as "bedId", planting_id as "plantingId", placement_id as "placementId", task_id as "taskId" from farm_events where farm_id = $1 order by event_date desc, id desc`, [farmId]).then((result) => queryRowsToSheet("Events", result)),
    client.query<Record<string, unknown>>(`select id, planting_id as "plantingId", bed_id as "bedId", task_flow_node_id as "taskFlowNodeId", task_type as "taskType", title, status, anchor, offset_days as "offsetDays", depends_on_task_ids as "dependsOnTaskIds", scheduled_date as "scheduledDate", completed_date as "completedDate", is_auto_generated as "isAutoGenerated", tractor_model as "tractorModel", tractor_profile_id as "tractorProfileId", notes from tasks where farm_id = $1 order by scheduled_date nulls last, id`, [farmId]).then((result) => queryRowsToSheet("Tasks", result)),
    client.query<Record<string, unknown>>(`select id, planting_id as "plantingId", bed_id as "bedId", harvest_date as "harvestDate", quantity, unit, notes from harvest_records where farm_id = $1 order by harvest_date desc, id desc`, [farmId]).then((result) => queryRowsToSheet("Harvests", result)),
    client.query<Record<string, unknown>>(`select id, name, tractor_model as "tractorModel", icon_color as "iconColor", icon_secondary_color as "iconSecondaryColor" from tractor_profiles where farm_id = $1 order by name`, [farmId]).then((result) => queryRowsToSheet("Vehicles", result)),
    client.query<Record<string, unknown>>(`select id, crop_id as "cropId", name, notes, is_default as "isDefault", source_task_flow_template_id as "sourceTaskFlowTemplateId" from task_flow_templates where farm_id = $1 order by name`, [farmId]).then((result) => queryRowsToSheet("Task Flows", result)),
    client.query<Record<string, unknown>>(`select node.id, node.flow_template_id as "flowTemplateId", node.node_key as "nodeKey", node.task_type as "taskType", node.label, node.anchor, node.offset_days as "offsetDays", node.x_pos as "x", node.y_pos as "y", node.tractor_model as "tractorModel", node.tractor_profile_id as "tractorProfileId", node.notes from task_flow_nodes node join task_flow_templates flow on flow.id = node.flow_template_id where flow.farm_id = $1 order by node.flow_template_id, node.id`, [farmId]).then((result) => queryRowsToSheet("Task Flow Nodes", result)),
    client.query<Record<string, unknown>>(`select edge.id, edge.flow_template_id as "flowTemplateId", from_node.node_key as "fromNodeKey", to_node.node_key as "toNodeKey" from task_flow_edges edge join task_flow_templates flow on flow.id = edge.flow_template_id join task_flow_nodes from_node on from_node.id = edge.from_node_id join task_flow_nodes to_node on to_node.id = edge.to_node_id where flow.farm_id = $1 order by edge.flow_template_id, edge.id`, [farmId]).then((result) => queryRowsToSheet("Task Flow Edges", result)),
    client.query<Record<string, unknown>>(`
      select app_user.id as "userId", app_user.username, app_user.display_name as "displayName", app_user.is_active as "isActive", membership.role, membership.created_at as "membershipCreatedAt"
      from farm_memberships membership
      join app_users app_user on app_user.id = membership.user_id
      where membership.farm_id = $1
      order by case when membership.role = 'planner' then 0 else 1 end, app_user.username
    `, [farmId]).then((result) => queryRowsToSheet("Team Accounts", result))
  ];

  return buildXlsxWorkbook([
    { name: "Plantings", rows: plantingRows },
    ...(await Promise.all(sheetQueries))
  ]);
}
