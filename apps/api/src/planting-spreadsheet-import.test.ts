import test from "node:test";
import assert from "node:assert/strict";
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
  readonly insertedPlantings: Array<{ id: number; params: unknown[] }> = [];
  readonly insertedSeedLots: unknown[][] = [];
  readonly insertedVehicles: unknown[][] = [];
  readonly insertedTaskFlows: unknown[][] = [];
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
      return { rows: [] };
    }
    if (normalized.includes("insert into fields")) {
      this.next.field += 1;
      return { rows: [{ id: this.next.field }] };
    }
    if (normalized.includes("insert into blocks")) {
      this.next.block += 1;
      return { rows: [{ id: this.next.block }] };
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
    if (normalized.includes("insert into task_flow_nodes")) {
      this.next.node += 1;
      this.nodesByFlowAndKey.set(`${params[0]}:${params[1]}`, this.next.node);
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
        plantCount: "1000",
        bedLengthUsedM: "20",
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

  assert.equal(client.insertedPlacements[0].params[0], kalePlanting.id);
  assert.equal(client.insertedTasks[0].params[1], kalePlanting.id);
  assert.equal(client.insertedHarvests[0][1], kalePlanting.id);
  assert.equal(client.insertedEvents[0][10], kalePlanting.id);
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
