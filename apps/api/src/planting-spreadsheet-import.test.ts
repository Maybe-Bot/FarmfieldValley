import test from "node:test";
import assert from "node:assert/strict";
import { parsePlantingTemplateRows, plantingImportHeaders } from "./planting-spreadsheet-import";

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
