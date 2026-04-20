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
        "2026-05-20",
        "3",
        "128",
        "75",
        "18",
        "24",
        "2",
        "y",
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
  assert.equal(rows[0].deadAtFrost, true);
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
        "65",
        "2",
        "12",
        "3",
        "n",
        "East Field",
        "B2",
        "",
        ""
      ]
    }
  ]);

  assert.equal(rows[0].transplantDate, null);
  assert.equal(rows[0].trayCount, null);
  assert.equal(rows[0].bed, "");
});
