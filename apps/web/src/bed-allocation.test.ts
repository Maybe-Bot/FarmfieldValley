import test from "node:test";
import assert from "node:assert/strict";
import { buildBedAllocationPreview, estimatePlantCountFromPlan } from "./bed-allocation";
import { Bed, Planting } from "./types";

function bed(id: number, sequenceNo: number, bedLengthM: number) {
  return {
    id,
    farmId: 1,
    farmName: "Test Farm",
    blockId: 5,
    blockName: "B1",
    zoneId: null,
    zoneName: null,
    name: `Bed ${sequenceNo}`,
    isPermanent: true,
    notes: null,
    x: 0,
    y: 0,
    width: 1,
    height: bedLengthM,
    bedLengthM,
    occupiedLengthM: 0,
    source: "test",
    direction: null,
    sequenceNo,
    bedPresetId: null,
    bedPresetName: null,
    areaSqM: null,
    geometrySource: "test",
    geometryUpdatedAt: "2026-01-01",
    geometryNotes: null,
    boundary: null
  } satisfies Bed;
}

function planting(patch: Partial<Planting>) {
  return {
    id: 10,
    farmId: 1,
    cropId: 2,
    varietyId: null,
    seedItemId: null,
    cropName: "Pepper",
    varietyName: null,
    seedName: null,
    title: "Pepper",
    status: "planned",
    intendedBedId: null,
    intendedBedName: null,
    taskFlowTemplateId: null,
    taskFlowTemplateName: null,
    spacing: null,
    plantCount: null,
    bedLengthUsedM: null,
    trayLocation: null,
    trayCount: null,
    notes: null,
    plannedSowDate: null,
    plannedTransplantDate: null,
    expectedHarvestStart: null,
    expectedHarvestEnd: null,
    actualTraySeedingDate: null,
    actualDirectSeedingDate: null,
    actualTransplantDate: null,
    actualCultivationDate: null,
    actualHarvestDate: null,
    actualFinishDate: null,
    ...patch
  } satisfies Planting;
}

test("estimatePlantCountFromPlan uses explicit count, bed length, then tray fallback", () => {
  assert.equal(estimatePlantCountFromPlan(planting({ plantCount: 128 }), 0.3), 128);
  assert.equal(estimatePlantCountFromPlan(planting({ bedLengthUsedM: 12 }), 0.3), 40);
  assert.equal(estimatePlantCountFromPlan(planting({ trayCount: 2 }), 0.3), 230);
});

test("buildBedAllocationPreview wraps plants through beds and respects used length", () => {
  const preview = buildBedAllocationPreview({
    plantCount: 25,
    bedsInWrapOrder: [bed(1, 1, 10), bed(2, 2, 10), bed(3, 3, 10)],
    usedLengthByBed: new Map([[1, 4]]),
    inRowSpacingM: 1
  });

  assert.deepEqual(preview.map((item) => ({
    bedId: item.bed.id,
    startLengthM: item.startLengthM,
    plantCount: item.plantCount,
    bedLengthUsedM: item.bedLengthUsedM
  })), [
    { bedId: 1, startLengthM: 4, plantCount: 6, bedLengthUsedM: 6 },
    { bedId: 2, startLengthM: 0, plantCount: 10, bedLengthUsedM: 10 },
    { bedId: 3, startLengthM: 0, plantCount: 9, bedLengthUsedM: 9 }
  ]);
});
