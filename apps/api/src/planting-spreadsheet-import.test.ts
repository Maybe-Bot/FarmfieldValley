import test from "node:test";
import assert from "node:assert/strict";
import { buildFarmExportWorkbook } from "./spreadsheet-export";
import { importPlantingSpreadsheetRowsForFarm, parsePlantingTemplateRows, plantingImportHeaders } from "./planting-spreadsheet-import";

function sheetRows(sheet: string, headers: string[], records: Array<Record<string, string>>) {
  return [
    { sheet, rowIndex: 1, cells: headers },
    ...records.map((record, index) => ({
      sheet,
      rowIndex: index + 2,
      cells: headers.map((header) => record[header] ?? "")
    }))
  ];
}

const squareBoundary = JSON.stringify({
  type: "Polygon",
  coordinates: [[
    [-72.1, 42.1],
    [-72.099, 42.1],
    [-72.099, 42.101],
    [-72.1, 42.101],
    [-72.1, 42.1]
  ]]
});

class FakeBackupImportClient {
  private next = {
    field: 1000,
    block: 2000,
    bed: 3000,
    zone: 3500,
    bedPreset: 3600,
    coverCrop: 3700,
    crop: 4000,
    variety: 5000,
    seedItem: 6000,
    vehicle: 7000,
    flow: 8000,
    node: 9000,
    planting: 10000,
    placement: 11000,
    task: 12000
  };

  readonly seedItems = new Map<number, Record<string, unknown>>();
  readonly nodesByFlowAndKey = new Map<string, number>();
  readonly farmUpdates: unknown[][] = [];
  readonly insertedBedPresets: unknown[][] = [];
  readonly insertedCoverCrops: unknown[][] = [];
  readonly insertedBlockAreas: Array<{ id: number; params: unknown[] }> = [];
  readonly insertedPlantings: Array<{ id: number; params: unknown[] }> = [];
  readonly insertedSeedLots: unknown[][] = [];
  readonly insertedVehicles: unknown[][] = [];
  readonly insertedTaskFlows: unknown[][] = [];
  readonly updatedTaskFlowSources: unknown[][] = [];
  readonly insertedTaskFlowNodes: Array<{ id: number; params: unknown[] }> = [];
  readonly insertedTaskFlowEdges: unknown[][] = [];
  readonly insertedPlacements: Array<{ id: number; params: unknown[] }> = [];
  readonly insertedGaps: unknown[][] = [];
  readonly insertedOverflows: unknown[][] = [];
  readonly insertedTasks: Array<{ id: number; params: unknown[] }> = [];
  readonly insertedHarvests: unknown[][] = [];
  readonly insertedEvents: unknown[][] = [];
  readonly duplicateNameMatches = new Map<string, number>();

  async query(sql: string, params: unknown[] = []) {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();

    if (normalized.includes("st_hausdorffdistance")) {
      return { rows: [] };
    }
    if (normalized.startsWith("select target.id") && normalized.includes("lower(target.name) = lower($2)")) {
      const table = normalized.includes("from fields target")
        ? "fields"
        : normalized.includes("from blocks target")
          ? "blocks"
          : normalized.includes("from beds target")
            ? "beds"
            : null;
      const key = [table, ...params].map((part) => String(part).toLowerCase()).join(":");
      const id = this.duplicateNameMatches.get(key);
      return { rows: id == null ? [] : [{ id }] };
    }
    if (normalized.startsWith("update farms")) {
      this.farmUpdates.push(params);
      return { rows: [] };
    }
    if (normalized.includes("insert into bed_presets")) {
      this.next.bedPreset += 1;
      this.insertedBedPresets.push(params);
      return { rows: [{ id: this.next.bedPreset }] };
    }
    if (normalized.includes("insert into cover_crop_names")) {
      this.next.coverCrop += 1;
      this.insertedCoverCrops.push(params);
      return { rows: [{ id: this.next.coverCrop }] };
    }
    if (normalized.includes("insert into fields")) {
      this.next.field += 1;
      return { rows: [{ id: this.next.field }] };
    }
    if (normalized.includes("insert into blocks")) {
      this.next.block += 1;
      return { rows: [{ id: this.next.block }] };
    }
    if (normalized.includes("insert into block_zones")) {
      this.next.zone += 1;
      this.insertedBlockAreas.push({ id: this.next.zone, params });
      return { rows: [{ id: this.next.zone }] };
    }
    if (normalized.includes("insert into beds")) {
      this.next.bed += 1;
      return { rows: [{ id: this.next.bed }] };
    }
    if (normalized.includes("insert into crops")) {
      this.next.crop += 1;
      return { rows: [{ id: this.next.crop }] };
    }
    if (normalized.includes("insert into varieties")) {
      this.next.variety += 1;
      return { rows: [{ id: this.next.variety }] };
    }
    if (normalized.startsWith("select crop_id, variety_id, crop_type")) {
      return { rows: [this.seedItems.get(Number(params[0])) ?? null].filter(Boolean) };
    }
    if (normalized.includes("select id from seed_items")) {
      return { rows: [] };
    }
    if (normalized.includes("insert into seed_items")) {
      this.next.seedItem += 1;
      this.seedItems.set(this.next.seedItem, {
        crop_id: params[1],
        variety_id: params[2],
        crop_type: params[3],
        variety_name: params[4],
        breed_name: params[5]
      });
      return { rows: [{ id: this.next.seedItem }] };
    }
    if (normalized.startsWith("update seed_items")) {
      return { rows: [] };
    }
    if (normalized.includes("insert into seed_item_lots")) {
      this.insertedSeedLots.push(params);
      return { rows: [] };
    }
    if (normalized.includes("insert into tractor_profiles")) {
      this.next.vehicle += 1;
      this.insertedVehicles.push(params);
      return { rows: [{ id: this.next.vehicle }] };
    }
    if (normalized.includes("insert into task_flow_templates")) {
      this.next.flow += 1;
      this.insertedTaskFlows.push(params);
      return { rows: [{ id: this.next.flow }] };
    }
    if (normalized.startsWith("update task_flow_templates set source_task_flow_template_id")) {
      this.updatedTaskFlowSources.push(params);
      return { rows: [] };
    }
    if (normalized.includes("insert into task_flow_nodes")) {
      this.next.node += 1;
      this.nodesByFlowAndKey.set(`${params[0]}:${params[1]}`, this.next.node);
      this.insertedTaskFlowNodes.push({ id: this.next.node, params });
      return { rows: [{ id: this.next.node }] };
    }
    if (normalized.startsWith("select id") && normalized.includes("from task_flow_nodes")) {
      const id = this.nodesByFlowAndKey.get(`${params[0]}:${params[1]}`);
      return { rows: id == null ? [] : [{ id, offset_days: 0 }] };
    }
    if (normalized.includes("insert into task_flow_edges")) {
      this.insertedTaskFlowEdges.push(params);
      return { rows: [] };
    }
    if (normalized.includes("insert into plantings")) {
      this.next.planting += 1;
      this.insertedPlantings.push({ id: this.next.planting, params });
      return { rows: [{ id: this.next.planting }] };
    }
    if (normalized.includes("insert into planting_placements")) {
      this.next.placement += 1;
      this.insertedPlacements.push({ id: this.next.placement, params });
      return { rows: [{ id: this.next.placement }] };
    }
    if (normalized.includes("insert into block_placement_gaps")) {
      this.insertedGaps.push(params);
      return { rows: [] };
    }
    if (normalized.includes("insert into block_placement_overflows")) {
      this.insertedOverflows.push(params);
      return { rows: [] };
    }
    if (normalized.includes("insert into tasks")) {
      this.next.task += 1;
      this.insertedTasks.push({ id: this.next.task, params });
      return { rows: [{ id: this.next.task }] };
    }
    if (normalized.startsWith("update tasks set depends_on_task_ids")) {
      return { rows: [] };
    }
    if (normalized.includes("insert into harvest_records")) {
      this.insertedHarvests.push(params);
      return { rows: [] };
    }
    if (normalized.includes("insert into farm_events")) {
      this.insertedEvents.push(params);
      return { rows: [] };
    }

    throw new Error(`Unexpected query in fake backup import client: ${normalized}`);
  }
}

type FakeQueryResult = {
  fields: Array<{ name: string }>;
  rows: Array<Record<string, unknown>>;
};

function fakeQueryResult(columns: string[], rows: Array<Record<string, unknown>>): FakeQueryResult {
  return {
    fields: columns.map((name) => ({ name })),
    rows
  };
}

class FakeFarmExportClient {
  readonly queryResults = new Map<string, FakeQueryResult>();

  constructor() {
    const date = (value: string) => new Date(`${value}T00:00:00.000Z`);
    this.queryResults.set("Plantings", fakeQueryResult(
      [
        "Seed supplier",
        "Crop",
        "Variety",
        "Catalog number",
        "Start date",
        "Plant count",
        "Bed length m",
        "Transplant date",
        "Tray count",
        "Cells per tray",
        "Days to harvest",
        "Field spacing in row",
        "Row spacing",
        "Rows per bed",
        "Bed cover",
        "Field",
        "Block",
        "Bed",
        "Notes"
      ],
      [{
        "Seed supplier": "Fedco",
        Crop: "Kale",
        Variety: "Lacinato",
        "Catalog number": "K-1",
        "Start date": date("2026-03-01"),
        "Plant count": 200,
        "Bed length m": 12,
        "Transplant date": date("2026-04-10"),
        "Tray count": 2.5,
        "Cells per tray": 128,
        "Days to harvest": 60,
        "Field spacing in row": 18,
        "Row spacing": 24,
        "Rows per bed": 2,
        "Bed cover": "plastic",
        Field: "North Field",
        Block: "B1",
        Bed: "Bed 1",
        Notes: "Template export row"
      }]
    ));
    this.queryResults.set("Farm", fakeQueryResult(["id", "name", "notes", "mapsPrivate"], [
      { id: 42, name: "Round Trip Farm", notes: "Farm note", mapsPrivate: false }
    ]));
    this.queryResults.set("Fields", fakeQueryResult(["id", "name", "notes", "areaSqM", "boundary"], [
      { id: 101, name: "North Field", notes: "Field notes", areaSqM: 100, boundary: JSON.parse(squareBoundary) }
    ]));
    this.queryResults.set("Blocks", fakeQueryResult(["id", "fieldId", "fieldName", "name", "notes", "bedStartEntranceSide", "areaSqM", "boundary"], [
      { id: 201, fieldId: 101, fieldName: "North Field", name: "B1", notes: "Block notes", bedStartEntranceSide: "end", areaSqM: 90, boundary: JSON.parse(squareBoundary) }
    ]));
    this.queryResults.set("Block Areas", fakeQueryResult(["id", "blockId", "blockName", "name", "plannedUse", "actualState", "coverCropNameId", "coverCropName", "plannedCoverCropSeedDate", "plannedCoverCropTerminateDate", "actualCoverCropSeedDate", "actualCoverCropTerminateDate", "areaSqM", "notes", "boundary"], [
      { id: 251, blockId: 201, blockName: "B1", name: "Area A", plannedUse: "cover_crop", actualState: "cover_crop", coverCropNameId: 451, coverCropName: "Rye", plannedCoverCropSeedDate: date("2026-09-01"), plannedCoverCropTerminateDate: date("2027-04-01"), actualCoverCropSeedDate: date("2026-09-03"), actualCoverCropTerminateDate: null, areaSqM: 45, notes: "Area notes", boundary: JSON.parse(squareBoundary) }
    ]));
    this.queryResults.set("Beds", fakeQueryResult(["id", "blockId", "blockName", "zoneId", "name", "source", "sequenceNo", "bedPresetId", "bedLengthM", "areaSqM", "notes", "boundary"], [
      { id: 301, blockId: 201, blockName: "B1", zoneId: 251, name: "Bed 1", source: "generated", sequenceNo: 1, bedPresetId: 401, bedLengthM: 30, areaSqM: 20, notes: "Bed notes", boundary: JSON.parse(squareBoundary) }
    ]));
    this.queryResults.set("Bed Presets", fakeQueryResult(["id", "name", "bedWidthM", "pathSpacingM", "isRoad", "notes"], [
      { id: 401, name: "Thirty inch", bedWidthM: 0.76, pathSpacingM: 0.46, isRoad: false, notes: "Preset notes" }
    ]));
    this.queryResults.set("Cover Crops", fakeQueryResult(["id", "name", "notes"], [
      { id: 451, name: "Rye", notes: "Cover crop notes" }
    ]));
    this.queryResults.set("Seed Bank", fakeQueryResult(["id", "cropId", "varietyId", "cropType", "varietyName", "breedName", "family", "supplier", "catalogNumber", "lotNumber", "stockQuantity", "daysToMaturity", "usualSpacing", "usualFieldSpacingInRow", "usualRowSpacing", "usualRowsPerBed", "archivedAt", "notes"], [
      { id: 501, cropId: 601, varietyId: 701, cropType: "Kale", varietyName: "Lacinato", breedName: null, family: "Brassica", supplier: "Fedco", catalogNumber: "K-1", lotNumber: "KLOT", stockQuantity: 1200, daysToMaturity: 60, usualSpacing: "18 in", usualFieldSpacingInRow: 18, usualRowSpacing: 24, usualRowsPerBed: 2, archivedAt: null, notes: "Seed notes" }
    ]));
    this.queryResults.set("Seed Lots", fakeQueryResult(["id", "seedItemId", "cropType", "varietyName", "supplier", "lotNumber", "stockQuantity"], [
      { id: 551, seedItemId: 501, cropType: "Kale", varietyName: "Lacinato", supplier: "Fedco", lotNumber: "KLOT-2", stockQuantity: 400 }
    ]));
    this.queryResults.set("Planting Details", fakeQueryResult(["id", "seedItemId", "taskFlowTemplateId", "intendedFieldId", "intendedBlockId", "intendedBedId", "title", "status", "plannedSowDate", "plannedTransplantDate", "expectedHarvestStart", "expectedHarvestEnd", "actualTraySeedingDate", "actualDirectSeedingDate", "actualTransplantDate", "actualHarvestDate", "actualFinishDate", "plantCount", "bedLengthUsedM", "spacing", "trayLocation", "trayCount", "cellsPerTray", "daysToHarvest", "fieldSpacingInRow", "rowSpacing", "rowsPerBed", "bedCover", "notes"], [
      { id: 901, seedItemId: 501, taskFlowTemplateId: 801, intendedFieldId: 101, intendedBlockId: 201, intendedBedId: 301, title: "Kale Backup", status: "active", plannedSowDate: date("2026-03-01"), plannedTransplantDate: date("2026-04-10"), expectedHarvestStart: date("2026-06-01"), expectedHarvestEnd: date("2026-06-30"), actualTraySeedingDate: date("2026-03-02"), actualDirectSeedingDate: null, actualTransplantDate: date("2026-04-11"), actualHarvestDate: null, actualFinishDate: null, plantCount: 200, bedLengthUsedM: 12, spacing: "18 in", trayLocation: "GH 1", trayCount: 2.5, cellsPerTray: 128, daysToHarvest: 60, fieldSpacingInRow: 18, rowSpacing: 24, rowsPerBed: 2, bedCover: "plastic", notes: "Planting notes" }
    ]));
    this.queryResults.set("Placements", fakeQueryResult(["id", "plantingId", "plantingTitle", "bedId", "bedName", "plantCount", "bedLengthUsedM", "startLengthM", "placementOrder", "planSource", "placedOn", "locationDetail", "notes"], [
      { id: 1001, plantingId: 901, plantingTitle: "Kale Backup", bedId: 301, bedName: "Bed 1", plantCount: 200, bedLengthUsedM: 12, startLengthM: 0, placementOrder: 1, planSource: "manual", placedOn: date("2026-04-11"), locationDetail: "Bed middle", notes: "Placement notes" }
    ]));
    this.queryResults.set("Placement Gaps", fakeQueryResult(["id", "blockId", "bedId", "startLengthM", "bedLengthUsedM", "placementOrder", "notes"], [
      { id: 1002, blockId: 201, bedId: 301, startLengthM: 12, bedLengthUsedM: 2, placementOrder: 2, notes: "Gap notes" }
    ]));
    this.queryResults.set("Placement Overflows", fakeQueryResult(["id", "blockId", "plantingId", "entryType", "bedLengthUsedM", "plantCount", "trayCount", "placementOrder", "notes"], [
      { id: 1003, blockId: 201, plantingId: 901, entryType: "overflow", bedLengthUsedM: 4, plantCount: 50, trayCount: 1.5, placementOrder: 3, notes: "Overflow notes" }
    ]));
    this.queryResults.set("Events", fakeQueryResult(["id", "eventDate", "eventType", "title", "notes", "metadata", "fieldId", "blockId", "zoneId", "bedId", "plantingId", "placementId", "taskId"], [
      { id: 1301, eventDate: date("2026-03-02"), eventType: "note", title: "Checked planting", notes: "Event notes", metadata: { source: "roundtrip" }, fieldId: 101, blockId: 201, zoneId: 251, bedId: 301, plantingId: 901, placementId: 1001, taskId: 1101 }
    ]));
    this.queryResults.set("Tasks", fakeQueryResult(["id", "plantingId", "bedId", "taskFlowNodeId", "taskType", "title", "status", "anchor", "offsetDays", "dependsOnTaskIds", "scheduledDate", "completedDate", "isAutoGenerated", "tractorModel", "tractorProfileId", "iconColor", "iconSecondaryColor", "notes"], [
      { id: 1101, plantingId: 901, bedId: 301, taskFlowNodeId: 811, taskType: "seed_in_tray", title: "Seed Kale", status: "done", anchor: "planned_sow", offsetDays: 0.5, dependsOnTaskIds: [], scheduledDate: date("2026-03-01"), completedDate: date("2026-03-02"), isAutoGenerated: true, tractorModel: "open", tractorProfileId: 701, iconColor: "#123456", iconSecondaryColor: "#abcdef", notes: "Task notes" },
      { id: 1102, plantingId: 901, bedId: 301, taskFlowNodeId: 812, taskType: "transplant", title: "Transplant Kale", status: "pending", anchor: "after:seed", offsetDays: 1.25, dependsOnTaskIds: [1101], scheduledDate: date("2026-04-10"), completedDate: null, isAutoGenerated: true, tractorModel: "cab", tractorProfileId: 701, iconColor: "#654321", iconSecondaryColor: "#fedcba", notes: "Task 2 notes" }
    ]));
    this.queryResults.set("Harvests", fakeQueryResult(["id", "plantingId", "bedId", "harvestDate", "quantity", "unit", "notes"], [
      { id: 1201, plantingId: 901, bedId: 301, harvestDate: date("2026-06-01"), quantity: 25, unit: "lb", notes: "Harvest notes" }
    ]));
    this.queryResults.set("Vehicles", fakeQueryResult(["id", "name", "tractorModel", "iconColor", "iconSecondaryColor"], [
      { id: 701, name: "Blue tractor", tractorModel: "cab", iconColor: "#3366aa", iconSecondaryColor: "#f4c430" }
    ]));
    this.queryResults.set("Task Flows", fakeQueryResult(["id", "cropId", "cropName", "name", "notes", "isDefault", "sourceTaskFlowTemplateId"], [
      { id: 800, cropId: null, cropName: null, name: "Base brassica flow", notes: "Base flow notes", isDefault: false, sourceTaskFlowTemplateId: null },
      { id: 801, cropId: 601, cropName: "Kale", name: "Kale flow", notes: "Flow notes", isDefault: true, sourceTaskFlowTemplateId: 800 }
    ]));
    this.queryResults.set("Task Flow Nodes", fakeQueryResult(["id", "flowTemplateId", "nodeKey", "taskType", "label", "anchor", "offsetDays", "x", "y", "tractorModel", "tractorProfileId", "iconColor", "iconSecondaryColor", "notes"], [
      { id: 811, flowTemplateId: 801, nodeKey: "seed", taskType: "seed_in_tray", label: "Seed trays", anchor: "planned_sow", offsetDays: 0, x: 0.2, y: 0.3, tractorModel: "open", tractorProfileId: 701, iconColor: "#112233", iconSecondaryColor: "#aabbcc", notes: "Seed node notes" },
      { id: 812, flowTemplateId: 801, nodeKey: "transplant", taskType: "transplant", label: "Transplant", anchor: "after:seed", offsetDays: 0, x: 0.6, y: 0.5, tractorModel: "cab", tractorProfileId: 701, iconColor: "#223344", iconSecondaryColor: "#bbccdd", notes: "Transplant node notes" }
    ]));
    this.queryResults.set("Task Flow Edges", fakeQueryResult(["id", "flowTemplateId", "fromNodeKey", "toNodeKey", "delayDays"], [
      { id: 821, flowTemplateId: 801, fromNodeKey: "seed", toNodeKey: "transplant", delayDays: 28.5 }
    ]));
    this.queryResults.set("Team Accounts", fakeQueryResult(["userId", "username", "displayName", "isActive", "role", "membershipCreatedAt"], [
      { userId: 1501, username: "planner@example.com", displayName: "Planner", isActive: true, role: "planner", membershipCreatedAt: date("2026-01-01") }
    ]));
  }

  async query(sql: string) {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    const sheet = normalized.includes("coalesce(seed.supplier")
      ? "Plantings"
      : normalized.includes("from farms where id")
        ? "Farm"
        : normalized.includes("from fields where farm_id")
          ? "Fields"
          : normalized.includes("from blocks block")
            ? "Blocks"
            : normalized.includes("from block_zones zone")
              ? "Block Areas"
              : normalized.includes("from beds bed")
                ? "Beds"
                : normalized.includes("from bed_presets")
                  ? "Bed Presets"
                  : normalized.includes("from cover_crop_names")
                    ? "Cover Crops"
                    : normalized.includes("from seed_item_lots")
                      ? "Seed Lots"
                      : normalized.includes("from seed_items where farm_id")
                        ? "Seed Bank"
                        : normalized.includes("from plantings where farm_id")
                          ? "Planting Details"
                          : normalized.includes("from planting_placements")
                            ? "Placements"
                            : normalized.includes("from block_placement_gaps")
                              ? "Placement Gaps"
                              : normalized.includes("from block_placement_overflows")
                                ? "Placement Overflows"
                                : normalized.includes("from farm_events")
                                  ? "Events"
                                  : normalized.includes("from tasks where farm_id")
                                    ? "Tasks"
                                    : normalized.includes("from harvest_records")
                                      ? "Harvests"
                                      : normalized.includes("from tractor_profiles")
                                        ? "Vehicles"
                                        : normalized.includes("from task_flow_templates flow")
                                          ? "Task Flows"
                                          : normalized.includes("from task_flow_nodes node")
                                            ? "Task Flow Nodes"
                                            : normalized.includes("from task_flow_edges edge")
                                              ? "Task Flow Edges"
                                              : normalized.includes("from farm_memberships")
                                                ? "Team Accounts"
                                                : null;
    if (sheet == null) {
      throw new Error(`Unexpected query in fake farm export client: ${normalized}`);
    }
    return this.queryResults.get(sheet);
  }
}

function parseExportWorkbook(buffer: Buffer) {
  const files = new Map<string, string>();
  let offset = 0;
  while (offset < buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    files.set(name, buffer.subarray(dataStart, dataStart + compressedSize).toString("utf8"));
    offset = dataStart + compressedSize;
  }
  const workbook = files.get("xl/workbook.xml") ?? "";
  const sheetNames = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((match) => decodeXmlText(match[1]));
  return sheetNames.flatMap((sheetName, index) => {
    const sheetXml = files.get(`xl/worksheets/sheet${index + 1}.xml`) ?? "";
    return [...sheetXml.matchAll(/<row r="(\d+)">([\s\S]*?)<\/row>/g)].map((rowMatch) => ({
      sheet: sheetName,
      rowIndex: Number(rowMatch[1]),
      cells: [...rowMatch[2].matchAll(/<t>([\s\S]*?)<\/t>/g)].map((cellMatch) => decodeXmlText(cellMatch[1]))
    }));
  });
}

function decodeXmlText(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

test("parsePlantingTemplateRows reads strict planting import rows", () => {
  const rows = parsePlantingTemplateRows([
    { sheet: "Plantings", rowIndex: 1, cells: [...plantingImportHeaders] },
    {
      sheet: "Plantings",
      rowIndex: 2,
      cells: [
        "High Mowing",
        "Pepper",
        "Jalfago",
        "HM-123",
        "2026-03-15",
        "288",
        "",
        "2026-05-20",
        "3",
        "128",
        "75",
        "18",
        "24",
        "2",
        "plastic mulch",
        "East Field",
        "B1",
        "Bed 4",
        "Greenhouse round one"
      ]
    }
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].crop, "Pepper");
  assert.equal(rows[0].plantCount, 288);
  assert.equal(rows[0].bedCover, "plastic");
  assert.equal(rows[0].fieldSpacingInRow, 18);
});

test("parsePlantingTemplateRows accepts common date formats", () => {
  const rows = parsePlantingTemplateRows([
    { sheet: "Plantings", rowIndex: 1, cells: [...plantingImportHeaders] },
    {
      sheet: "Plantings",
      rowIndex: 2,
      cells: [
        "High Mowing",
        "Pepper",
        "Jalfago",
        "HM-123",
        "3/15/26",
        "288",
        "",
        "5/20/2026",
        "3",
        "128",
        "75",
        "18",
        "24",
        "2",
        "plastic mulch",
        "East Field",
        "B1",
        "Bed 4",
        "Greenhouse round one"
      ]
    }
  ]);

  assert.equal(rows[0].startDate, "2026-03-15");
  assert.equal(rows[0].transplantDate, "2026-05-20");
});

test("parsePlantingTemplateRows skips the unchanged template example row", () => {
  assert.throws(
    () => parsePlantingTemplateRows([
      { sheet: "Plantings", rowIndex: 1, cells: [...plantingImportHeaders] },
      {
        sheet: "Plantings",
        rowIndex: 2,
        cells: [
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
        ]
      }
    ]),
    /Spreadsheet only contained the unchanged example row/
  );
});

test("parsePlantingTemplateRows imports the template example row after it is edited", () => {
  const rows = parsePlantingTemplateRows([
    { sheet: "Plantings", rowIndex: 1, cells: [...plantingImportHeaders] },
    {
      sheet: "Plantings",
      rowIndex: 2,
      cells: [
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
        "Home Field",
        "B1",
        "Bed 1",
        "Example row: replace field, block, and bed names with names already on your map."
      ]
    }
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].field, "Home Field");
});

test("parsePlantingTemplateRows rejects wrong headers", () => {
  assert.throws(
    () => parsePlantingTemplateRows([{ sheet: "Plantings", rowIndex: 1, cells: ["Crop", "Variety"] }]),
    /Spreadsheet headers must exactly match/
  );
});

test("parsePlantingTemplateRows allows blank transplant fields for direct seed", () => {
  const rows = parsePlantingTemplateRows([
    { sheet: "Plantings", rowIndex: 1, cells: [...plantingImportHeaders] },
    {
      sheet: "Plantings",
      rowIndex: 2,
      cells: [
        "Johnny's",
        "Carrot",
        "Napoli",
        "1234",
        "2026-04-01",
        "1200",
        "",
        "",
        "",
        "",
        "65",
        "2",
        "12",
        "3",
        "bare",
        "East Field",
        "B2",
        "",
        ""
      ]
    }
  ]);

  assert.equal(rows[0].transplantDate, null);
  assert.equal(rows[0].trayCount, null);
  assert.equal(rows[0].bedCover, "bare");
  assert.equal(rows[0].bed, "");
});

test("parsePlantingTemplateRows treats zero plant count as missing completion data", () => {
  const rows = parsePlantingTemplateRows([
    { sheet: "Plantings", rowIndex: 1, cells: [...plantingImportHeaders] },
    {
      sheet: "Plantings",
      rowIndex: 28,
      cells: [
        "Johnny's",
        "Lettuce",
        "Rex",
        "555",
        "2026-04-01",
        "0",
        "",
        "2026-05-01",
        "2",
        "128",
        "45",
        "10",
        "12",
        "4",
        "bare",
        "East Field",
        "B2",
        "",
        ""
      ]
    }
  ]);

  assert.equal(rows[0].plantCount, null);
  assert.ok(rows[0].completionIssues.includes("Plant count or bed length is missing"));
});

test("parsePlantingTemplateRows rounds decimal plant count", () => {
  const rows = parsePlantingTemplateRows([
    { sheet: "Plantings", rowIndex: 1, cells: [...plantingImportHeaders] },
    {
      sheet: "Plantings",
      rowIndex: 2,
      cells: [
        "Johnny's",
        "Lettuce",
        "Rex",
        "555",
        "2026-04-01",
        "127.6",
        "",
        "2026-05-01",
        "2",
        "128",
        "45",
        "10",
        "12",
        "4",
        "bare",
        "East Field",
        "B2",
        "",
        ""
      ]
    }
  ]);

  assert.equal(rows[0].plantCount, 128);
});

test("parsePlantingTemplateRows rejects unsupported bed cover values", () => {
  assert.throws(
    () => parsePlantingTemplateRows([
      { sheet: "Plantings", rowIndex: 1, cells: [...plantingImportHeaders] },
      {
        sheet: "Plantings",
        rowIndex: 2,
        cells: [
          "Johnny's",
          "Lettuce",
          "Rex",
          "555",
          "2026-04-01",
          "200",
          "",
          "2026-05-01",
          "2",
          "128",
          "45",
          "10",
          "12",
          "4",
          "mulch",
          "East Field",
          "B2",
          "",
          ""
        ]
      }
    ]),
    /Bed cover \(plastic mulch\/bare\) must be plastic mulch or bare/
  );
});

test("parsePlantingTemplateRows flags rows that need manual completion", () => {
  const rows = parsePlantingTemplateRows([
    { sheet: "Plantings", rowIndex: 1, cells: [...plantingImportHeaders] },
    {
      sheet: "Plantings",
      rowIndex: 2,
      cells: [
        "Johnny's",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "Needs crop and location details"
      ]
    }
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].crop, null);
  assert.equal(rows[0].startDate, null);
  assert.equal(rows[0].plantCount, null);
  assert.deepEqual(rows[0].completionIssues, [
    "Crop is missing",
    "Start date is missing",
    "Plant count or bed length is missing",
    "Field is missing",
    "Block is missing"
  ]);
  assert.ok(rows[0].reviewIssues.includes("Variety is blank"));
  assert.ok(rows[0].reviewIssues.includes("Bed is blank"));
});

test("parsePlantingTemplateRows allows bed length for direct-seeded crops", () => {
  const rows = parsePlantingTemplateRows([
    { sheet: "Plantings", rowIndex: 1, cells: [...plantingImportHeaders] },
    {
      sheet: "Plantings",
      rowIndex: 2,
      cells: [
        "Johnny's",
        "Carrot",
        "Napoli",
        "1234",
        "2026-04-01",
        "",
        "100",
        "",
        "",
        "",
        "65",
        "2",
        "12",
        "3",
        "bare",
        "East Field",
        "B2",
        "",
        ""
      ]
    }
  ]);

  assert.equal(rows[0].bedLengthFeet, 100);
  assert.equal(rows[0].plantCount, 1800);
  assert.deepEqual(rows[0].completionIssues, []);
});

test("full backup export workbook imports into a clean farm with custom links and colors preserved", async () => {
  const exportClient = new FakeFarmExportClient();
  const workbook = await buildFarmExportWorkbook(exportClient as never, 42);
  const rows = parseExportWorkbook(workbook);
  const client = new FakeBackupImportClient();

  const result = await importPlantingSpreadsheetRowsForFarm(client as never, rows, 777);

  assert.equal(result.importedFields, 1);
  assert.equal(result.importedBlocks, 1);
  assert.equal(result.importedBeds, 1);
  assert.equal(result.importedPlantings, 1);
  assert.equal(result.importedVehicles, 1);
  assert.equal(client.farmUpdates[0][1], "Round Trip Farm");
  assert.equal(client.farmUpdates[0][2], "Farm note");
  assert.equal(client.farmUpdates[0][3], false);
  assert.equal(client.insertedBedPresets.length, 1);
  assert.equal(client.insertedCoverCrops.length, 1);
  assert.equal(client.insertedBlockAreas.length, 1);
  assert.equal(client.insertedSeedLots.length, 1);
  assert.equal(client.insertedTaskFlows.length, 2);
  assert.equal(client.insertedTaskFlows[0][2], "Base brassica flow");
  assert.equal(client.insertedTaskFlows[1][1], 4001);
  assert.equal(client.insertedTaskFlows[1][2], "Kale flow");
  assert.equal(client.insertedTaskFlows[1][4], true);
  assert.equal(client.updatedTaskFlowSources.length, 2);
  assert.equal(client.updatedTaskFlowSources[1][1], 8001);
  assert.equal(client.insertedTaskFlowNodes.length, 2);
  assert.equal(client.insertedTaskFlowNodes[0].params[10], "#112233");
  assert.equal(client.insertedTaskFlowNodes[0].params[11], "#aabbcc");
  assert.equal(client.insertedTaskFlowNodes[1].params[10], "#223344");
  assert.equal(client.insertedTaskFlowNodes[1].params[11], "#bbccdd");
  assert.equal(client.insertedTaskFlowEdges.length, 1);
  assert.equal(client.insertedTaskFlowEdges[0][3], 28.5);
  assert.equal(client.insertedVehicles[0][2], "cab");
  assert.equal(client.insertedVehicles[0][3], "#3366aa");
  assert.equal(client.insertedVehicles[0][4], "#f4c430");
  assert.equal(client.insertedPlantings.length, 1);
  assert.equal(client.insertedPlantings[0].params[4], 8002);
  assert.equal(client.insertedPlantings[0].params[5], "Kale Backup");
  assert.equal(client.insertedPlantings[0].params[15], 2.5);
  assert.equal(client.insertedPlacements.length, 1);
  assert.equal(client.insertedGaps.length, 1);
  assert.equal(client.insertedOverflows.length, 1);
  assert.equal(client.insertedTasks.length, 2);
  assert.equal(client.insertedTasks[0].params[8], 0.5);
  assert.equal(client.insertedTasks[0].params[14], "#123456");
  assert.equal(client.insertedTasks[0].params[15], "#abcdef");
  assert.equal(client.insertedTasks[1].params[8], 1.25);
  assert.equal(client.insertedTasks[1].params[14], "#654321");
  assert.equal(client.insertedTasks[1].params[15], "#fedcba");
  assert.equal(client.insertedHarvests.length, 1);
  assert.equal(client.insertedEvents.length, 1);
});

test("importPlantingSpreadsheetRowsForFarm imports full backup sheets by exported ids", async () => {
  const client = new FakeBackupImportClient();
  const rows = [
    ...sheetRows("Plantings", [...plantingImportHeaders], [
      {
        "Seed supplier": "Wrong supplier",
        Crop: "Wrong first crop",
        Variety: "Wrong first variety",
        "Start date": "2026-03-01",
        "Plant count": "999",
        Field: "Wrong field",
        Block: "Wrong block"
      },
      {
        "Seed supplier": "Wrong supplier",
        Crop: "Wrong second crop",
        Variety: "Wrong second variety",
        "Start date": "2026-03-02",
        "Plant count": "998",
        Field: "Wrong field",
        Block: "Wrong block"
      }
    ]),
    ...sheetRows("Fields", ["id", "name", "notes", "areaSqM", "boundary"], [
      { id: "101", name: "North Field", notes: "Field notes", areaSqM: "100", boundary: squareBoundary }
    ]),
    ...sheetRows("Blocks", ["id", "fieldId", "fieldName", "name", "notes", "bedStartEntranceSide", "areaSqM", "boundary"], [
      { id: "201", fieldId: "101", fieldName: "North Field", name: "B1", notes: "Block notes", bedStartEntranceSide: "start", areaSqM: "90", boundary: squareBoundary }
    ]),
    ...sheetRows("Beds", ["id", "blockId", "blockName", "zoneId", "name", "source", "sequenceNo", "bedPresetId", "bedLengthM", "areaSqM", "notes", "boundary"], [
      { id: "301", blockId: "201", blockName: "B1", name: "Bed 1", source: "generated", sequenceNo: "1", bedLengthM: "30", areaSqM: "20", boundary: squareBoundary }
    ]),
    ...sheetRows("Seed Bank", ["id", "cropType", "varietyName", "breedName", "family", "supplier", "catalogNumber", "lotNumber", "stockQuantity", "daysToMaturity", "archivedAt", "notes"], [
      { id: "501", cropType: "Kale", varietyName: "Lacinato", supplier: "Fedco", catalogNumber: "K-1", lotNumber: "KLOT", stockQuantity: "1200", daysToMaturity: "60" },
      { id: "502", cropType: "Carrot", varietyName: "Napoli", supplier: "Johnny's", catalogNumber: "C-1", lotNumber: "CLOT", stockQuantity: "2400", daysToMaturity: "70" }
    ]),
    ...sheetRows("Seed Lots", ["id", "seedItemId", "cropType", "varietyName", "supplier", "lotNumber", "stockQuantity"], [
      { id: "601", seedItemId: "501", cropType: "Kale", varietyName: "Lacinato", supplier: "Fedco", lotNumber: "KLOT-2", stockQuantity: "400" }
    ]),
    ...sheetRows("Vehicles", ["id", "name", "tractorModel", "iconColor", "iconSecondaryColor"], [
      { id: "701", name: "Blue tractor", tractorModel: "cab", iconColor: "#3366aa", iconSecondaryColor: "#f4c430" }
    ]),
    ...sheetRows("Task Flows", ["id", "cropId", "name", "notes", "isDefault", "sourceTaskFlowTemplateId"], [
      { id: "801", name: "Kale flow", notes: "Flow notes", isDefault: "TRUE" }
    ]),
    ...sheetRows("Task Flow Nodes", ["id", "flowTemplateId", "nodeKey", "taskType", "label", "anchor", "offsetDays", "x", "y", "tractorModel", "tractorProfileId", "notes"], [
      { id: "811", flowTemplateId: "801", nodeKey: "seed", taskType: "seed_in_tray", label: "Seed trays", anchor: "planned_sow", offsetDays: "0", x: "0.2", y: "0.3", tractorProfileId: "701" },
      { id: "812", flowTemplateId: "801", nodeKey: "transplant", taskType: "transplant", label: "Transplant", anchor: "after:seed", offsetDays: "0", x: "0.6", y: "0.5", tractorProfileId: "701" }
    ]),
    ...sheetRows("Task Flow Edges", ["id", "flowTemplateId", "fromNodeKey", "toNodeKey", "delayDays"], [
      { id: "821", flowTemplateId: "801", fromNodeKey: "seed", toNodeKey: "transplant", delayDays: "28" }
    ]),
    ...sheetRows("Planting Details", [
      "id",
      "seedItemId",
      "taskFlowTemplateId",
      "intendedFieldId",
      "intendedBlockId",
      "intendedBedId",
      "title",
      "status",
      "plannedSowDate",
      "plannedTransplantDate",
      "expectedHarvestStart",
      "expectedHarvestEnd",
      "actualTraySeedingDate",
      "actualDirectSeedingDate",
      "actualTransplantDate",
      "actualHarvestDate",
      "actualFinishDate",
      "plantCount",
      "bedLengthUsedM",
      "spacing",
      "trayLocation",
      "trayCount",
      "cellsPerTray",
      "daysToHarvest",
      "fieldSpacingInRow",
      "rowSpacing",
      "rowsPerBed",
      "bedCover",
      "notes"
    ], [
      {
        id: "902",
        seedItemId: "502",
        intendedFieldId: "101",
        intendedBlockId: "201",
        intendedBedId: "301",
        title: "Carrot Backup",
        status: "planned",
        plannedSowDate: "2026-04-01",
        plantCount: "",
        bedLengthUsedM: "",
        notes: "Carrot detail row"
      },
      {
        id: "901",
        seedItemId: "501",
        taskFlowTemplateId: "801",
        intendedFieldId: "101",
        intendedBlockId: "201",
        intendedBedId: "301",
        title: "Kale Backup",
        status: "planned",
        plannedSowDate: "2026-03-01",
        plantCount: "200",
        bedLengthUsedM: "12",
        notes: "Kale detail row"
      }
    ]),
    ...sheetRows("Placements", ["id", "plantingId", "plantingTitle", "bedId", "bedName", "plantCount", "bedLengthUsedM", "startLengthM", "placementOrder", "planSource", "placedOn", "locationDetail", "notes"], [
      { id: "1001", plantingId: "901", bedId: "301", plantCount: "200", bedLengthUsedM: "12", startLengthM: "0", placementOrder: "1", planSource: "manual" }
    ]),
    ...sheetRows("Placement Gaps", ["id", "blockId", "bedId", "startLengthM", "bedLengthUsedM", "placementOrder", "notes"], [
      { id: "1002", blockId: "201", bedId: "301", startLengthM: "12", bedLengthUsedM: "2", placementOrder: "2", notes: "Gap" }
    ]),
    ...sheetRows("Placement Overflows", ["id", "blockId", "plantingId", "entryType", "bedLengthUsedM", "plantCount", "trayCount", "placementOrder", "notes"], [
      { id: "1003", blockId: "201", plantingId: "901", entryType: "overflow", bedLengthUsedM: "4", plantCount: "50", placementOrder: "3", notes: "Overflow" }
    ]),
    ...sheetRows("Tasks", ["id", "plantingId", "bedId", "taskFlowNodeId", "taskType", "title", "status", "anchor", "offsetDays", "dependsOnTaskIds", "scheduledDate", "completedDate", "isAutoGenerated", "tractorModel", "tractorProfileId", "notes"], [
      { id: "1101", plantingId: "901", bedId: "301", taskFlowNodeId: "811", taskType: "seed_in_tray", title: "Seed Kale", status: "pending", anchor: "planned_sow", offsetDays: "0", scheduledDate: "2026-03-01", isAutoGenerated: "TRUE", tractorProfileId: "701" },
      { id: "1102", plantingId: "901", bedId: "301", taskFlowNodeId: "812", taskType: "transplant", title: "Transplant Kale", status: "pending", anchor: "after:seed", offsetDays: "0", dependsOnTaskIds: "1101", scheduledDate: "2026-04-10", isAutoGenerated: "TRUE", tractorProfileId: "701" }
    ]),
    ...sheetRows("Harvests", ["id", "plantingId", "bedId", "harvestDate", "quantity", "unit", "notes"], [
      { id: "1201", plantingId: "901", bedId: "301", harvestDate: "2026-06-01", quantity: "25", unit: "lb", notes: "First harvest" }
    ]),
    ...sheetRows("Events", ["id", "eventDate", "eventType", "title", "notes", "metadata", "fieldId", "blockId", "zoneId", "bedId", "plantingId", "placementId", "taskId"], [
      { id: "1301", eventDate: "2026-03-02", eventType: "note", title: "Checked planting", notes: "Event notes", metadata: "{}", fieldId: "101", blockId: "201", bedId: "301", plantingId: "901", placementId: "1001", taskId: "1101" }
    ])
  ];

  const result = await importPlantingSpreadsheetRowsForFarm(client as never, rows, 42);

  assert.equal(result.importedFields, 1);
  assert.equal(result.importedBlocks, 1);
  assert.equal(result.importedBeds, 1);
  assert.equal(result.importedPlantings, 2);
  assert.equal(result.incompleteRows, 1);
  assert.equal(result.importedVehicles, 1);
  assert.equal(client.insertedSeedLots.length, 1);
  assert.equal(client.insertedTaskFlows.length, 1);
  assert.equal(client.insertedTaskFlowEdges.length, 1);
  assert.equal(client.insertedTaskFlowEdges[0][3], 28);
  assert.equal(client.insertedPlacements.length, 1);
  assert.equal(client.insertedGaps.length, 1);
  assert.equal(client.insertedOverflows.length, 1);
  assert.equal(client.insertedTasks.length, 2);
  assert.equal(client.insertedHarvests.length, 1);
  assert.equal(client.insertedEvents.length, 1);

  const carrotPlanting = client.insertedPlantings.find((planting) => planting.params[5] === "Carrot Backup");
  const kalePlanting = client.insertedPlantings.find((planting) => planting.params[5] === "Kale Backup");
  assert.ok(carrotPlanting);
  assert.ok(kalePlanting);
  assert.equal(carrotPlanting.params[11], null);
  assert.equal(carrotPlanting.params[12], null);

  assert.equal(client.insertedPlacements[0].params[0], kalePlanting.id);
  assert.equal(client.insertedTasks[0].params[1], kalePlanting.id);
  assert.equal(client.insertedHarvests[0][1], kalePlanting.id);
  assert.equal(client.insertedEvents[0][10], kalePlanting.id);
});

test("full backup import rejects invalid task-flow graphs before restoring rows", async () => {
  const client = new FakeBackupImportClient();
  const rows = [
    ...sheetRows("Fields", ["id", "name", "notes", "areaSqM", "boundary"], [
      { id: "101", name: "North Field", notes: "Field notes", areaSqM: "100", boundary: squareBoundary }
    ]),
    ...sheetRows("Blocks", ["id", "fieldId", "fieldName", "name", "notes", "bedStartEntranceSide", "areaSqM", "boundary"], [
      { id: "201", fieldId: "101", fieldName: "North Field", name: "B1", notes: "Block notes", bedStartEntranceSide: "start", areaSqM: "90", boundary: squareBoundary }
    ]),
    ...sheetRows("Beds", ["id", "blockId", "blockName", "zoneId", "name", "source", "sequenceNo", "bedPresetId", "bedLengthM", "areaSqM", "notes", "boundary"], [
      { id: "301", blockId: "201", blockName: "Bed 1", source: "generated", sequenceNo: "1", bedLengthM: "30", areaSqM: "20", boundary: squareBoundary }
    ]),
    ...sheetRows("Task Flow Nodes", ["id", "flowTemplateId", "nodeKey", "taskType", "label", "anchor", "offsetDays", "x", "y"], [
      { id: "811", flowTemplateId: "801", nodeKey: "seed", taskType: "seed_in_tray", label: "Seed trays", anchor: "planned_sow", offsetDays: "0", x: "0.2", y: "0.3" },
      { id: "812", flowTemplateId: "801", nodeKey: "transplant", taskType: "transplant", label: "Transplant", anchor: "after:seed", offsetDays: "0", x: "0.6", y: "0.5" }
    ]),
    ...sheetRows("Task Flow Edges", ["id", "flowTemplateId", "fromNodeKey", "toNodeKey", "delayDays"], [
      { id: "821", flowTemplateId: "801", fromNodeKey: "seed", toNodeKey: "transplant", delayDays: "28" },
      { id: "822", flowTemplateId: "801", fromNodeKey: "transplant", toNodeKey: "seed", delayDays: "1" }
    ]),
    ...sheetRows("Planting Details", ["id", "title"], [
      { id: "901", title: "Kale Backup" }
    ])
  ];

  await assert.rejects(
    () => importPlantingSpreadsheetRowsForFarm(client as never, rows, 42),
    /Task Flows row 801: Task flow dependencies cannot contain a loop/
  );
  assert.equal(client.insertedPlantings.length, 0);
});

test("full backup import maps same-name map items instead of duplicating them", async () => {
  const client = new FakeBackupImportClient();
  client.duplicateNameMatches.set("fields:42:north field", 1010);
  client.duplicateNameMatches.set("blocks:42:b1:1010", 2010);
  client.duplicateNameMatches.set("beds:42:bed 1:2010", 3010);

  const rows = [
    ...sheetRows("Fields", ["id", "name", "notes", "areaSqM", "boundary"], [
      { id: "101", name: "North Field", notes: "Field notes", areaSqM: "100", boundary: squareBoundary }
    ]),
    ...sheetRows("Blocks", ["id", "fieldId", "fieldName", "name", "notes", "bedStartEntranceSide", "areaSqM", "boundary"], [
      { id: "201", fieldId: "101", fieldName: "North Field", name: "B1", notes: "Block notes", bedStartEntranceSide: "start", areaSqM: "90", boundary: squareBoundary }
    ]),
    ...sheetRows("Beds", ["id", "blockId", "blockName", "zoneId", "name", "source", "sequenceNo", "bedPresetId", "bedLengthM", "areaSqM", "notes", "boundary"], [
      { id: "301", blockId: "201", blockName: "B1", name: "Bed 1", source: "generated", sequenceNo: "1", bedLengthM: "30", areaSqM: "20", boundary: squareBoundary }
    ]),
    ...sheetRows("Planting Details", ["id", "title"], [])
  ];

  const result = await importPlantingSpreadsheetRowsForFarm(client as never, rows, 42);

  assert.equal(result.importedFields, 0);
  assert.equal(result.importedBlocks, 0);
  assert.equal(result.importedBeds, 0);
  assert.equal(result.skippedDuplicateFields, 1);
  assert.equal(result.skippedDuplicateBlocks, 1);
  assert.equal(result.skippedDuplicateBeds, 1);
});
