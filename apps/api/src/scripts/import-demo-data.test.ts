import test from "node:test";
import assert from "node:assert/strict";
import { inferSeedFamily, parseDate, parseLocationReference, parseNumber } from "./import-demo-data";

test("parseLocationReference expands common block shorthand", () => {
  assert.deepEqual(parseLocationReference("B1/2"), ["B1", "B2"]);
  assert.deepEqual(parseLocationReference("H2-6"), ["H2", "H3", "H4", "H5", "H6"]);
  assert.deepEqual(parseLocationReference("B13"), ["B1", "B3"]);
  assert.deepEqual(parseLocationReference("parking lot"), []);
});

test("parseNumber handles spreadsheet-friendly numeric text", () => {
  assert.equal(parseNumber("1,280"), 1280);
  assert.equal(parseNumber(" 42.7 "), 42.7);
  assert.equal(parseNumber("#VALUE!"), null);
});

test("parseDate handles supported spreadsheet date formats", () => {
  assert.equal(parseDate("2026-04-09", 2026), "2026-04-09");
  assert.equal(parseDate("4/5-5/30", 2026), "2026-04-05");
  assert.equal(parseDate("7-Apr-26", 2026), "2026-04-07");
  assert.equal(parseDate("", 2026), null);
});

test("inferSeedFamily maps common seed catalog crops", () => {
  assert.equal(inferSeedFamily("Peppers, Sweet"), "Nightshade");
  assert.equal(inferSeedFamily("Cabbage, Storage Red"), "Brassica");
  assert.equal(inferSeedFamily("Radicchio, Treviso early"), "Aster");
  assert.equal(inferSeedFamily("Onions, Storage Yellow"), "Allium");
  assert.equal(inferSeedFamily("Summer Squash, Zucchini"), "Cucurbit");
  assert.equal(inferSeedFamily("Unknown crop"), null);
});
