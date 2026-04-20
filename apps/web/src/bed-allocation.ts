import { Bed, Planting } from "./types";

export type BedAllocationPreviewItem = {
  bed: Bed;
  startLengthM: number;
  plantCount: number;
  bedLengthUsedM: number;
  isPartial: boolean;
};

// Estimate planned plants from the strongest available planning field. Tray
// counts are deliberately rough because germination rates vary in real use.
export function estimatePlantCountFromPlan(planting: Planting | null, inRowSpacingM: number) {
  if (!planting) {
    return 0;
  }
  if (planting.plantCount != null && Number(planting.plantCount) > 0) {
    return Number(planting.plantCount);
  }
  if (planting.bedLengthUsedM != null && Number(planting.bedLengthUsedM) > 0 && inRowSpacingM > 0) {
    return Math.round(Number(planting.bedLengthUsedM) / inRowSpacingM);
  }
  if (planting.trayCount != null && Number(planting.trayCount) > 0) {
    return Math.round(Number(planting.trayCount) * 128 * 0.9);
  }
  return 0;
}

// Builds the same preview the map allocation tool shows: start at the selected
// bed, fill remaining length, then wrap to following beds in sequence order.
export function buildBedAllocationPreview(options: {
  plantCount: number;
  bedsInWrapOrder: Bed[];
  usedLengthByBed: Map<number, number>;
  inRowSpacingM: number;
}) {
  if (!Number.isFinite(options.plantCount) || options.plantCount <= 0 || options.inRowSpacingM <= 0) {
    return [] as BedAllocationPreviewItem[];
  }

  let remainingPlants = Math.round(options.plantCount);
  return options.bedsInWrapOrder.flatMap((wrapBed) => {
    if (remainingPlants <= 0) {
      return [];
    }

    const bedLengthM = Number(wrapBed.bedLengthM);
    const usedLengthM = options.usedLengthByBed.get(wrapBed.id) ?? 0;
    const availableLengthM = Math.max(0, (Number.isFinite(bedLengthM) && bedLengthM > 0 ? bedLengthM : 0) - usedLengthM);
    const bedPlantCapacity = Math.max(0, Math.floor(availableLengthM / options.inRowSpacingM));
    if (bedPlantCapacity <= 0) {
      return [];
    }

    const plantsInBed = Math.min(remainingPlants, bedPlantCapacity);
    remainingPlants -= plantsInBed;
    return [{
      bed: wrapBed,
      startLengthM: usedLengthM,
      plantCount: plantsInBed,
      bedLengthUsedM: plantsInBed * options.inRowSpacingM,
      isPartial: plantsInBed < bedPlantCapacity
    }];
  });
}
