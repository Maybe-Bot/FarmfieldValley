import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { Bed, DashboardData, Planting, SeedItem, TaskFlowTemplate } from "../types";

type DistanceUnit = "m" | "ft";
type PlantCountSource = "plant_count" | "tray_count" | "bed_length" | "full_block";
type PlantingDateInput = "initial" | "plantingDate" | "plannedTransplantDate" | "daysToHarvest" | "expectedHarvestStart" | "expectedHarvestEnd";
export type PlantingMapPreviewItem = {
  bedId: number;
  startLengthM: number;
  bedLengthUsedM: number;
  plantCount: number;
  label: string;
};

export type PlantingTutorialDraft = {
  id: string;
  cropId: number;
  varietyId: number | null;
  seedItemId: number | null;
  taskFlowTemplateId: number;
  intendedBedId: number | null;
  locationScope: string;
  title: string;
  plannedSowDate: string;
  plannedTransplantDate: string;
  expectedHarvestStart: string;
  expectedHarvestEnd: string;
  daysToHarvest?: string;
  spacingInRow: string;
  spacingBetweenRows: string;
  notes: string;
};

function toNumericValue(value: number | string | null | undefined) {
  if (value == null) {
    return null;
  }

  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseLengthInputValue(value: FormDataEntryValue | string | null, unit: DistanceUnit) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return null;
  }

  const numericValue = Number(raw);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return unit === "ft" ? numericValue / 3.28084 : numericValue;
}

function formatLengthInputValue(valueM: number | null, unit: DistanceUnit) {
  if (valueM == null || !Number.isFinite(valueM) || valueM <= 0) {
    return "";
  }

  const value = unit === "ft" ? valueM * 3.28084 : valueM;
  return Number(value.toFixed(1)).toString();
}

function defaultSpacingExample(unit: DistanceUnit) {
  return unit === "ft" ? "11.8 in x 11.8 in" : "30 cm x 30 cm";
}

function spacingUnitLabel(unit: DistanceUnit) {
  return unit === "ft" ? "in" : "cm";
}

function spacingInputToMeters(value: string, unit: DistanceUnit) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return unit === "ft" ? numericValue * 0.0254 : numericValue / 100;
}

function spacingMetersToInput(valueM: number, unit: DistanceUnit) {
  return unit === "ft" ? valueM / 0.0254 : valueM * 100;
}

function parseSpacingPairForUnit(value: string | null, unit: DistanceUnit) {
  if (!value) {
    return { inRow: "", betweenRows: "" };
  }

  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)\s*(cm|m|in|ft)?/gi)];
  if (matches.length === 0) {
    return { inRow: "", betweenRows: "" };
  }

  const toMeters = (amount: string, rawUnit: string | undefined) => {
    const numericValue = Number(amount);
    if (!Number.isFinite(numericValue)) {
      return null;
    }

    const sourceUnit = rawUnit?.toLowerCase() ?? (unit === "ft" ? "in" : "cm");
    if (sourceUnit === "in") return numericValue * 0.0254;
    if (sourceUnit === "ft") return numericValue / 3.28084;
    if (sourceUnit === "m") return numericValue;
    return numericValue / 100;
  };

  const first = toMeters(matches[0][1], matches[0][2]);
  const second = toMeters(matches[1]?.[1] ?? matches[0][1], matches[1]?.[2] ?? matches[0][2]);

  return {
    inRow: first == null ? "" : spacingMetersToInput(first, unit).toFixed(unit === "ft" ? 1 : 0),
    betweenRows: second == null ? "" : spacingMetersToInput(second, unit).toFixed(unit === "ft" ? 1 : 0)
  };
}

type SpacingSuggestion = {
  inRow: string;
  betweenRows: string;
  rowsPerBed: string | null;
};

function spacingSuggestionFromValues(
  spacing: string | null,
  fieldSpacingInRow: number | null,
  rowSpacing: number | null,
  rowsPerBed: number | null,
  unit: DistanceUnit
): SpacingSuggestion | null {
  const parsed = parseSpacingPairForUnit(spacing, unit);
  const inRow = parsed.inRow || (fieldSpacingInRow == null ? "" : String(fieldSpacingInRow));
  const betweenRows = parsed.betweenRows || (rowSpacing == null ? "" : String(rowSpacing)) || inRow;
  if (!inRow) {
    return null;
  }
  return {
    inRow,
    betweenRows,
    rowsPerBed: rowsPerBed == null ? null : String(rowsPerBed)
  };
}

function normalizedCropGroup(value: string | null | undefined) {
  const lower = (value ?? "").toLowerCase();
  if (!lower.trim()) return null;
  if (lower.includes("tomato")) return "tomato";
  if (lower.includes("pepper") || lower.includes("chile") || lower.includes("chili") || lower.includes("capsicum")) return "pepper";
  if (lower.includes("eggplant") || lower.includes("aubergine")) return "eggplant";
  return lower.replace(/[^a-z0-9]+/g, " ").trim().replace(/s\b/g, "");
}

function isTomatoGroup(value: string | null) {
  return value === "tomato";
}

function seedSpacingSuggestion(seed: SeedItem, data: DashboardData, unit: DistanceUnit): SpacingSuggestion | null {
  const learned = spacingSuggestionFromValues(
    seed.usualSpacing,
    seed.usualFieldSpacingInRow,
    seed.usualRowSpacing,
    seed.usualRowsPerBed,
    unit
  );
  if (learned) {
    return learned;
  }

  const seedById = new Map(data.seedItems.map((item) => [item.id, item]));
  const targetCropGroup = normalizedCropGroup(seed.cropType);
  const targetFamily = normalizedCropGroup(seed.family);
  const candidates = new Map<string, { suggestion: SpacingSuggestion; count: number; score: number; latestId: number }>();

  for (const planting of data.plantings) {
    const plantingSeed = planting.seedItemId == null ? null : seedById.get(planting.seedItemId) ?? null;
    const plantingCropGroup = normalizedCropGroup(plantingSeed?.cropType ?? planting.cropName);
    const plantingFamily = normalizedCropGroup(plantingSeed?.family);
    let score = 0;
    if (planting.seedItemId === seed.id) {
      score = 100;
    } else if (seed.cropId != null && planting.cropId === seed.cropId) {
      score = 80;
    } else if (targetCropGroup && plantingCropGroup === targetCropGroup) {
      score = 70;
    } else if (
      targetFamily &&
      plantingFamily === targetFamily &&
      !isTomatoGroup(targetCropGroup) &&
      !isTomatoGroup(plantingCropGroup)
    ) {
      score = 45;
    }
    if (score === 0) {
      continue;
    }

    const suggestion = spacingSuggestionFromValues(
      planting.spacing,
      planting.fieldSpacingInRow,
      planting.rowSpacing,
      planting.rowsPerBed,
      unit
    );
    if (!suggestion) {
      continue;
    }
    const key = `${suggestion.inRow}|${suggestion.betweenRows}|${suggestion.rowsPerBed ?? ""}`;
    const current = candidates.get(key);
    candidates.set(key, {
      suggestion,
      count: (current?.count ?? 0) + 1,
      score: Math.max(current?.score ?? 0, score),
      latestId: Math.max(current?.latestId ?? 0, planting.id)
    });
  }

  return [...candidates.values()]
    .sort((left, right) => (
      right.score - left.score ||
      right.count - left.count ||
      right.latestId - left.latestId
    ))[0]?.suggestion ?? null;
}

function formatSpacingPair(inRow: string, betweenRows: string, unit: DistanceUnit) {
  const label = spacingUnitLabel(unit);
  const first = inRow.trim();
  const second = betweenRows.trim() || first;
  if (!first) {
    return null;
  }

  return `${first} ${label} x ${second} ${label}`;
}

function plantCountFromBedLength(bedLengthM: number | null, inRowSpacingM: number | null, rowsPerBed: number | null) {
  if (bedLengthM == null || inRowSpacingM == null || rowsPerBed == null || bedLengthM <= 0 || inRowSpacingM <= 0 || rowsPerBed <= 0) {
    return null;
  }

  return Math.max(1, Math.floor((bedLengthM * rowsPerBed) / inRowSpacingM));
}

function bedLengthFromPlantCount(plantCount: number | null, inRowSpacingM: number | null, rowsPerBed: number | null) {
  if (plantCount == null || inRowSpacingM == null || rowsPerBed == null || plantCount <= 0 || inRowSpacingM <= 0 || rowsPerBed <= 0) {
    return null;
  }

  return (plantCount * inRowSpacingM) / rowsPerBed;
}

function distributePlantCountAcrossBeds(totalPlantCount: number | null, beds: Bed[]) {
  if (totalPlantCount == null || totalPlantCount <= 0 || beds.length === 0) {
    return beds.map(() => null as number | null);
  }

  const weights = beds.map((bed) => {
    const length = Number(bed.bedLengthM);
    return Number.isFinite(length) && length > 0 ? length : 1;
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) {
    return beds.map(() => null as number | null);
  }

  const rawCounts = weights.map((weight) => (totalPlantCount * weight) / totalWeight);
  const counts = rawCounts.map((count) => Math.floor(count));
  let remaining = totalPlantCount - counts.reduce((sum, count) => sum + count, 0);
  const fractionalOrder = rawCounts
    .map((count, index) => ({ index, fraction: count - Math.floor(count) }))
    .sort((left, right) => right.fraction - left.fraction);

  for (const item of fractionalOrder) {
    if (remaining <= 0) {
      break;
    }
    counts[item.index] += 1;
    remaining -= 1;
  }

  return counts.map((count) => count > 0 ? count : null);
}

function sortBedsForPlacementPreview(beds: Bed[]) {
  return [...beds].sort((left, right) => {
    const leftSequence = left.sequenceNo ?? left.id;
    const rightSequence = right.sequenceNo ?? right.id;
    if (leftSequence !== rightSequence) return leftSequence - rightSequence;
    return left.id - right.id;
  });
}

function wrapBedsFromSelectedBed(beds: Bed[], selectedBedId: number | null) {
  const orderedBeds = sortBedsForPlacementPreview(beds);
  if (selectedBedId == null) {
    return orderedBeds;
  }

  const selectedIndex = orderedBeds.findIndex((bed) => bed.id === selectedBedId);
  if (selectedIndex < 0) {
    return orderedBeds;
  }

  return [...orderedBeds.slice(selectedIndex), ...orderedBeds.slice(0, selectedIndex)];
}

function buildPlantingLengthPreview(
  beds: Bed[],
  bedLengthM: number | null,
  plantCount: number | null,
  distanceUnit: DistanceUnit
) {
  if (bedLengthM == null || !Number.isFinite(bedLengthM) || bedLengthM <= 0 || beds.length === 0) {
    return [] as PlantingMapPreviewItem[];
  }

  let remainingLengthM = bedLengthM;
  let remainingPlants = plantCount == null || !Number.isFinite(plantCount) || plantCount <= 0 ? null : Math.round(plantCount);
  return beds.flatMap((bed, index) => {
    if (remainingLengthM <= 0) {
      return [];
    }

    const bedCapacityM = Math.max(0, Number(bed.bedLengthM || 0));
    if (!Number.isFinite(bedCapacityM) || bedCapacityM <= 0) {
      return [];
    }

    const sectionLengthM = Math.min(remainingLengthM, bedCapacityM);
    const sectionPlantCount = remainingPlants == null
      ? 0
      : sectionLengthM >= remainingLengthM
        ? Math.max(0, remainingPlants)
        : Math.max(1, Math.min(remainingPlants, Math.round(plantCount! * (sectionLengthM / bedLengthM))));
    remainingLengthM -= sectionLengthM;
    if (remainingPlants != null) {
      remainingPlants = Math.max(0, remainingPlants - sectionPlantCount);
    }

    return [{
      bedId: bed.id,
      startLengthM: 0,
      bedLengthUsedM: sectionLengthM,
      plantCount: sectionPlantCount,
      label: sectionPlantCount > 0
        ? `Preview: ${sectionPlantCount.toLocaleString()} plants`
        : `Preview: ${formatLengthInputValue(sectionLengthM, distanceUnit)} ${distanceUnit}`
    }];
  });
}

function todayDateInputValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function addDaysToDateString(value: string | null, days: number) {
  if (!value) {
    return null;
  }

  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetweenDateStrings(startDate: string | null, endDate: string | null) {
  if (!startDate || !endDate) {
    return null;
  }

  const start = new Date(`${startDate.slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${endDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  const days = Math.round((end.getTime() - start.getTime()) / 86400000);
  return days > 0 ? days : null;
}

// Small helper for old/simple uncontrolled forms. Newer forms often use local state instead.
async function handleForm(
  event: FormEvent<HTMLFormElement>,
  action: (form: FormData) => Promise<void> | Promise<unknown>
) {
  event.preventDefault();
  const formElement = event.currentTarget;
  await action(new FormData(formElement));
  formElement.reset();
}

// Form for creating a parent planting plan. It handles both tray-started
// transplants and direct-seeded crops.
export function PlantingForm({
  data,
  taskFlowTemplates,
  distanceUnit,
  tutorialDraft,
  editingPlanting = null,
  embedded = false,
  heading,
  initialIntendedBedId = null,
  initialIntendedBlockId = null,
  initialIntendedBedIds = [],
  highlightSubmit = false,
  onPreviewChange,
  onCancel,
  onSave
}: {
  data: DashboardData;
  taskFlowTemplates: TaskFlowTemplate[];
  distanceUnit: DistanceUnit;
  tutorialDraft?: PlantingTutorialDraft | null;
  editingPlanting?: Planting | null;
  embedded?: boolean;
  heading?: string;
  initialIntendedBedId?: number | null;
  initialIntendedBlockId?: number | null;
  initialIntendedBedIds?: number[];
  highlightSubmit?: boolean;
  onPreviewChange?: (preview: PlantingMapPreviewItem[]) => void;
  onCancel?: () => void;
  onSave: () => Promise<void>;
}) {
  const isEditing = editingPlanting != null;
  const defaultCrop = editingPlanting?.cropId ?? data.crops[0]?.id ?? 1;
  const [cropId, setCropId] = useState(String(defaultCrop));
  const [varietyId, setVarietyId] = useState("");
  const [seedItemId, setSeedItemId] = useState("");
  const [plantingDate, setPlantingDate] = useState("");
  const [locationScope, setLocationScope] = useState("");
  const [intendedBedId, setIntendedBedId] = useState("");
  const [spacingInRow, setSpacingInRow] = useState(distanceUnit === "ft" ? "12" : "30");
  const [spacingBetweenRows, setSpacingBetweenRows] = useState(distanceUnit === "ft" ? "12" : "30");
  const [rowsPerBed, setRowsPerBed] = useState("1");
  const [plantCountSource, setPlantCountSource] = useState<PlantCountSource>("plant_count");
  const [traySize, setTraySize] = useState("128");
  const [trayCount, setTrayCount] = useState("");
  const [transplantPlantCountInput, setTransplantPlantCountInput] = useState("");
  const [trayLocation, setTrayLocation] = useState("");
  const [directBedLength, setDirectBedLength] = useState("");
  const [title, setTitle] = useState("");
  const [daysToHarvest, setDaysToHarvest] = useState("");
  const [bedCover, setBedCover] = useState("");
  const [plannedTransplantDate, setPlannedTransplantDate] = useState("");
  const [expectedHarvestStart, setExpectedHarvestStart] = useState("");
  const [expectedHarvestEnd, setExpectedHarvestEnd] = useState("");
  const [lastDateInput, setLastDateInput] = useState<PlantingDateInput>("initial");
  const [taskFlowTemplateId, setTaskFlowTemplateId] = useState("");
  const [notes, setNotes] = useState("");
  const [tutorialSeedItemId, setTutorialSeedItemId] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const plantingMethod: "transplant" | "direct_seed" = plannedTransplantDate ? "transplant" : "direct_seed";
  const inferredPlantingStatus = plantingDate && plantingDate < todayDateInputValue()
    ? plantingMethod === "direct_seed" ? "direct_seeded" : "seeded_in_tray"
    : "planned";
  const selectedCrop = data.crops.find((crop) => String(crop.id) === cropId) ?? data.crops[0] ?? null;
  const varietiesForCrop = data.varieties.filter((variety) => String(variety.cropId) === cropId);
  const selectedVariety = data.varieties.find((variety) => String(variety.id) === varietyId) ?? null;
  const selectedSeedItem = seedItemId ? data.seedItems.find((seed) => String(seed.id) === seedItemId) ?? null : null;
  const seedItemsForCrop = data.seedItems.filter((seed) =>
    (seed.archivedAt == null || String(seed.id) === seedItemId)
    && String(seed.cropId ?? "") === cropId
    && (!varietyId || seed.varietyId == null || String(seed.varietyId) === varietyId)
  );
  const seedItemOptions = selectedSeedItem && !seedItemsForCrop.some((seed) => seed.id === selectedSeedItem.id)
    ? [selectedSeedItem, ...seedItemsForCrop]
    : seedItemsForCrop;
  const ownFarmId = data.farm?.id ?? null;
  const ownFields = data.fields.filter((field) => field.farmId === ownFarmId);
  const ownBlocks = data.blocks.filter((block) => block.farmId === ownFarmId);
  const ownBeds = data.beds.filter((bed) => bed.farmId === ownFarmId);
  const selectedLocationBlock = locationScope.startsWith("block:")
    ? ownBlocks.find((block) => String(block.id) === locationScope.replace("block:", "")) ?? null
    : null;
  const selectedLocationFieldId = locationScope.startsWith("field:")
    ? Number(locationScope.replace("field:", ""))
    : selectedLocationBlock?.fieldId ?? null;
  const selectedLocationBlockId = selectedLocationBlock?.id ?? null;
  const selectedIntendedBed = intendedBedId ? ownBeds.find((bed) => String(bed.id) === intendedBedId) ?? null : null;
  const fullBlockSourceBlockId = selectedLocationBlockId ?? selectedIntendedBed?.blockId ?? null;
  const blocksForLocation = ownBlocks.filter((block) => String(block.fieldId) === locationScope.replace("field:", ""));
  const plantableBeds = ownBeds.filter((bed) => bed.source !== "road");
  const fullBlockBeds = fullBlockSourceBlockId == null
    ? []
    : plantableBeds.filter((bed) => bed.blockId === fullBlockSourceBlockId);
  const fullBlockBedLengthM = fullBlockBeds.length > 0
    ? fullBlockBeds.reduce((sum, bed) => sum + Number(bed.bedLengthM || 0), 0)
    : null;
  const fullBlockBedsKey = fullBlockBeds.map((bed) => `${bed.id}:${bed.sequenceNo ?? ""}:${bed.bedLengthM}`).join("|");
  const initialMapBedIds = initialIntendedBedIds.length > 0
    ? initialIntendedBedIds
    : initialIntendedBedId == null
      ? []
      : [initialIntendedBedId];
  const initialMapBedIdsKey = initialMapBedIds.join(",");
  const initialMapBeds = initialMapBedIds
    .map((bedId) => data.beds.find((bed) => bed.id === bedId && bed.farmId === ownFarmId && bed.source !== "road") ?? null)
    .filter((bed): bed is Bed => bed != null);
  const hasMultipleInitialBeds = initialMapBeds.length > 1;
  const initialMapBedLengthM = initialMapBeds.length > 0
    ? initialMapBeds.reduce((sum, bed) => sum + Number(bed.bedLengthM || 0), 0)
    : null;
  const spacing = formatSpacingPair(spacingInRow, spacingBetweenRows, distanceUnit) ?? defaultSpacingExample(distanceUnit);
  const inRowSpacingM = spacingInputToMeters(spacingInRow, distanceUnit);
  const trayCountValue = toNumericValue(trayCount);
  const traySizeValue = toNumericValue(traySize) ?? 128;
  const explicitPlantCount = toNumericValue(transplantPlantCountInput);
  const trayPlantCount = trayCountValue != null && trayCountValue > 0 ? Math.max(1, Math.round(trayCountValue * traySizeValue)) : null;
  const directBedLengthM = parseLengthInputValue(directBedLength || null, distanceUnit);
  const rowsPerBedValue = toNumericValue(rowsPerBed);
  const rowsPerBedForCalc = rowsPerBedValue != null && Number.isInteger(rowsPerBedValue) && rowsPerBedValue > 0 ? rowsPerBedValue : null;
  const bedLengthPlantCount = plantCountFromBedLength(directBedLengthM, inRowSpacingM, rowsPerBedForCalc);
  const fullBlockPlantCount = plantCountFromBedLength(fullBlockBedLengthM, inRowSpacingM, rowsPerBedForCalc);
  const selectedPlantCount = plantCountSource === "tray_count" && plantingMethod === "transplant"
    ? trayPlantCount
    : plantCountSource === "bed_length"
      ? bedLengthPlantCount
      : plantCountSource === "full_block"
        ? fullBlockPlantCount
        : explicitPlantCount != null && explicitPlantCount > 0
          ? Math.round(explicitPlantCount)
          : null;
  const selectedBedLengthM = plantCountSource === "full_block"
    ? fullBlockBedLengthM
    : plantCountSource === "bed_length"
      ? directBedLengthM
      : bedLengthFromPlantCount(selectedPlantCount, inRowSpacingM, rowsPerBedForCalc);
  const countSourceNeedsBlock = plantCountSource === "full_block" && fullBlockBedLengthM == null;
  const directSeedTaskFlows = taskFlowTemplates.filter((flow) =>
    (flow.cropId === selectedCrop?.id || flow.cropId == null)
    && data.taskFlowNodes.some((node) => node.flowTemplateId === flow.id && node.taskType === "direct_seed")
  );
  const directSeedTaskFlow = directSeedTaskFlows.find((flow) => flow.cropId === selectedCrop?.id)
    ?? directSeedTaskFlows.find((flow) => flow.cropId == null)
    ?? null;
  const tutorialNeedsPlantCount = highlightSubmit
    && (selectedPlantCount == null || selectedPlantCount <= 0);
  const tutorialReadyToCreate = highlightSubmit
    && !tutorialNeedsPlantCount;
  const tutorialPlantingHint = tutorialNeedsPlantCount
    ? "Type the plant count for the sample cabbage planting."
    : highlightSubmit
      ? "The sample cabbage plan is ready. Click Create planting."
      : null;

  useEffect(() => {
    if (!editingPlanting) {
      return;
    }

    const spacingPair = parseSpacingPairForUnit(editingPlanting.spacing, distanceUnit);
    const editingBed = editingPlanting.intendedBedId == null
      ? null
      : data.beds.find((bed) => bed.id === editingPlanting.intendedBedId) ?? null;
    const editingBlockId = editingPlanting.intendedBlockId ?? editingBed?.blockId ?? null;
    const editingBlock = editingBlockId == null ? null : data.blocks.find((block) => block.id === editingBlockId) ?? null;
    const editingFieldId = editingPlanting.intendedFieldId ?? editingBlock?.fieldId ?? null;
    const nextLocationScope = editingBlockId != null
      ? `block:${editingBlockId}`
      : editingFieldId != null
        ? `field:${editingFieldId}`
        : "";
    setCropId(String(editingPlanting.cropId));
    setVarietyId(editingPlanting.varietyId == null ? "" : String(editingPlanting.varietyId));
    setSeedItemId(editingPlanting.seedItemId == null ? "" : String(editingPlanting.seedItemId));
    setTutorialSeedItemId(null);
    setPlantingDate(editingPlanting.plannedSowDate?.slice(0, 10) ?? "");
    setLocationScope(nextLocationScope);
    setIntendedBedId(editingPlanting.intendedBedId == null ? "" : String(editingPlanting.intendedBedId));
    setSpacingInRow(spacingPair.inRow || (distanceUnit === "ft" ? "12" : "30"));
    setSpacingBetweenRows(spacingPair.betweenRows || spacingPair.inRow || (distanceUnit === "ft" ? "12" : "30"));
    setRowsPerBed(editingPlanting.rowsPerBed == null ? "1" : String(editingPlanting.rowsPerBed));
    setPlantCountSource(editingPlanting.plantCount != null ? "plant_count" : editingPlanting.bedLengthUsedM != null ? "bed_length" : "plant_count");
    setTraySize(editingPlanting.cellsPerTray == null ? "128" : String(editingPlanting.cellsPerTray));
    setTrayCount(editingPlanting.trayCount == null ? "" : String(editingPlanting.trayCount));
    setTransplantPlantCountInput(editingPlanting.plantCount == null ? "" : String(editingPlanting.plantCount));
    setTrayLocation(editingPlanting.trayLocation ?? "");
    setDirectBedLength(formatLengthInputValue(editingPlanting.bedLengthUsedM, distanceUnit));
    setTitle(editingPlanting.title ?? "");
    setDaysToHarvest(editingPlanting.daysToHarvest == null ? "" : String(editingPlanting.daysToHarvest));
    setBedCover(editingPlanting.bedCover ?? "");
    setPlannedTransplantDate(editingPlanting.plannedTransplantDate?.slice(0, 10) ?? "");
    setExpectedHarvestStart(editingPlanting.expectedHarvestStart?.slice(0, 10) ?? "");
    setExpectedHarvestEnd(editingPlanting.expectedHarvestEnd?.slice(0, 10) ?? "");
    setLastDateInput("initial");
    setTaskFlowTemplateId(editingPlanting.taskFlowTemplateId == null ? "" : String(editingPlanting.taskFlowTemplateId));
    setNotes(editingPlanting.notes ?? "");
    setStatus(null);
  }, [editingPlanting, distanceUnit, data.beds, data.blocks]);

  useEffect(() => {
    if (!tutorialDraft || editingPlanting) {
      return;
    }

    setCropId(String(tutorialDraft.cropId));
    setVarietyId(tutorialDraft.varietyId == null ? "" : String(tutorialDraft.varietyId));
    setSeedItemId(tutorialDraft.seedItemId == null ? "" : String(tutorialDraft.seedItemId));
    setTutorialSeedItemId(tutorialDraft.seedItemId);
    setPlantingDate(tutorialDraft.plannedSowDate);
    setLocationScope(tutorialDraft.locationScope);
    setIntendedBedId(tutorialDraft.intendedBedId == null ? "" : String(tutorialDraft.intendedBedId));
    setSpacingInRow(tutorialDraft.spacingInRow);
    setSpacingBetweenRows(tutorialDraft.spacingBetweenRows);
    setRowsPerBed("1");
    setPlantCountSource("plant_count");
    setTraySize("128");
    setTrayCount("");
    setTransplantPlantCountInput("");
    setTrayLocation("");
    setDirectBedLength("");
    setDaysToHarvest(tutorialDraft.daysToHarvest ?? "");
    setBedCover("");
    setTitle(tutorialDraft.title);
    setPlannedTransplantDate(tutorialDraft.plannedTransplantDate);
    setExpectedHarvestStart(tutorialDraft.expectedHarvestStart);
    setExpectedHarvestEnd(tutorialDraft.expectedHarvestEnd);
    setLastDateInput("initial");
    setTaskFlowTemplateId(String(tutorialDraft.taskFlowTemplateId));
    setNotes(tutorialDraft.notes);
    setStatus("Cabbage tutorial sample loaded. Enter a plant count, then create the planting.");
  }, [tutorialDraft, editingPlanting]);

  useEffect(() => {
    if (editingPlanting || tutorialDraft || !initialMapBedIdsKey) {
      return;
    }

    const initialBeds = initialMapBedIds
      .map((bedId) => data.beds.find((bed) => bed.id === bedId && bed.farmId === ownFarmId && bed.source !== "road") ?? null)
      .filter((bed): bed is Bed => bed != null);
    const initialBed = initialBeds[0] ?? null;
    if (!initialBed) {
      return;
    }

    setLocationScope(`block:${initialBed.blockId}`);
    if (initialBeds.length > 1) {
      const totalLength = initialBeds.reduce((sum, bed) => sum + Number(bed.bedLengthM || 0), 0);
      setIntendedBedId("");
      setPlantCountSource("bed_length");
      setDirectBedLength(formatLengthInputValue(totalLength, distanceUnit));
      setTitle((current) => current.trim() ? current : `New planting for ${initialBed.blockName} selected beds`);
      setStatus(`${initialBeds.length} beds are selected on the map.`);
      return;
    }

    setIntendedBedId(String(initialBed.id));
    setTitle((current) => current.trim() ? current : `New planting for ${initialBed.blockName} / ${initialBed.name}`);
    setStatus(`${initialBed.blockName} / ${initialBed.name} is selected.`);
  }, [data.beds, distanceUnit, initialMapBedIdsKey, ownFarmId, tutorialDraft, editingPlanting]);

  useEffect(() => {
    if (editingPlanting || tutorialDraft || initialMapBedIdsKey || initialIntendedBlockId == null) {
      return;
    }

    const initialBlock = ownBlocks.find((block) => block.id === initialIntendedBlockId) ?? null;
    if (!initialBlock) {
      return;
    }

    setLocationScope(`block:${initialBlock.id}`);
    setIntendedBedId("");
    setTitle((current) => current.trim() ? current : `New planting for ${initialBlock.name}`);
    setStatus(`${initialBlock.name} is selected.`);
  }, [initialIntendedBlockId, initialMapBedIdsKey, ownBlocks, tutorialDraft, editingPlanting]);

  useEffect(() => {
    if (plantingMethod === "direct_seed" && plantCountSource === "tray_count") {
      setPlantCountSource("plant_count");
    }
  }, [plantingMethod, plantCountSource]);

  useEffect(() => {
    if (lastDateInput === "initial") {
      return;
    }

    const harvestBaseDate = plannedTransplantDate || plantingDate;
    const numericDaysToHarvest = Number(daysToHarvest);
    const validDaysToHarvest = Number.isFinite(numericDaysToHarvest) && numericDaysToHarvest > 0
      ? Math.round(numericDaysToHarvest)
      : null;

    if (lastDateInput === "expectedHarvestStart") {
      const calculatedDays = daysBetweenDateStrings(harvestBaseDate || null, expectedHarvestStart || null);
      if (calculatedDays != null && daysToHarvest !== String(calculatedDays)) {
        setDaysToHarvest(String(calculatedDays));
      } else if (!harvestBaseDate && validDaysToHarvest != null && expectedHarvestStart) {
        const calculatedPlantingDate = addDaysToDateString(expectedHarvestStart, -validDaysToHarvest);
        if (calculatedPlantingDate && plantingDate !== calculatedPlantingDate) {
          setPlantingDate(calculatedPlantingDate);
        }
      }
      if (expectedHarvestStart && !expectedHarvestEnd) {
        setExpectedHarvestEnd(expectedHarvestStart);
      }
      return;
    }

    if (lastDateInput === "expectedHarvestEnd") {
      if (expectedHarvestEnd && !expectedHarvestStart) {
        setExpectedHarvestStart(expectedHarvestEnd);
      }
      return;
    }

    if (lastDateInput === "daysToHarvest" && !harvestBaseDate && validDaysToHarvest != null && expectedHarvestStart) {
      const calculatedPlantingDate = addDaysToDateString(expectedHarvestStart, -validDaysToHarvest);
      if (calculatedPlantingDate && plantingDate !== calculatedPlantingDate) {
        setPlantingDate(calculatedPlantingDate);
      }
      return;
    }

    if (harvestBaseDate && expectedHarvestStart && validDaysToHarvest == null) {
      const calculatedDays = daysBetweenDateStrings(harvestBaseDate, expectedHarvestStart);
      if (calculatedDays != null && daysToHarvest !== String(calculatedDays)) {
        setDaysToHarvest(String(calculatedDays));
      }
      return;
    }

    if (!harvestBaseDate || validDaysToHarvest == null) {
      return;
    }

    const calculatedHarvestDate = addDaysToDateString(harvestBaseDate, validDaysToHarvest);
    if (!calculatedHarvestDate) {
      return;
    }

    if (expectedHarvestStart !== calculatedHarvestDate) {
      setExpectedHarvestStart(calculatedHarvestDate);
    }
    if (!expectedHarvestEnd || expectedHarvestEnd < calculatedHarvestDate) {
      setExpectedHarvestEnd(calculatedHarvestDate);
    }
  }, [lastDateInput, plantingDate, plannedTransplantDate, daysToHarvest, expectedHarvestStart, expectedHarvestEnd]);

  useEffect(() => {
    const setIfChanged = (setter: (value: string) => void, current: string, next: string) => {
      if (current !== next) {
        setter(next);
      }
    };
    const roundedPlantCount = selectedPlantCount != null && selectedPlantCount > 0 ? Math.round(selectedPlantCount) : null;
    const nextPlantCount = roundedPlantCount == null ? "" : String(roundedPlantCount);
    const nextBedLength = formatLengthInputValue(selectedBedLengthM, distanceUnit);
    const nextTrayCount = roundedPlantCount != null && traySizeValue > 0
      ? String(Math.ceil(roundedPlantCount / traySizeValue))
      : "";

    if (plantCountSource !== "plant_count") {
      setIfChanged(setTransplantPlantCountInput, transplantPlantCountInput, nextPlantCount);
    }
    if (plantCountSource !== "bed_length") {
      setIfChanged(setDirectBedLength, directBedLength, plantCountSource === "full_block" || nextBedLength ? nextBedLength : "");
    }
    if (plantingMethod === "transplant" && plantCountSource !== "tray_count") {
      setIfChanged(setTrayCount, trayCount, nextTrayCount);
    }
  }, [
    plantCountSource,
    plantingMethod,
    selectedPlantCount,
    selectedBedLengthM,
    distanceUnit,
    traySizeValue,
    transplantPlantCountInput,
    directBedLength,
    trayCount
  ]);

  useEffect(() => {
    if (!onPreviewChange) {
      return;
    }

    const previewBeds = initialMapBeds.length > 0
      ? initialMapBeds
      : selectedIntendedBed
        ? wrapBedsFromSelectedBed(fullBlockBeds, selectedIntendedBed.id)
        : sortBedsForPlacementPreview(fullBlockBeds);
    const preview = buildPlantingLengthPreview(previewBeds, selectedBedLengthM, selectedPlantCount, distanceUnit);
    onPreviewChange(preview);
    return () => onPreviewChange([]);
  }, [
    distanceUnit,
    fullBlockBedsKey,
    initialMapBedIdsKey,
    intendedBedId,
    onPreviewChange,
    selectedBedLengthM,
    selectedPlantCount,
    selectedIntendedBed?.id
  ]);

  return (
    <div className={embedded ? "inline-planting-editor" : "card"}>
      <div className="section-header">
        <h2>{heading ?? (isEditing ? "Edit planting" : "New Planting")}</h2>
        {onCancel && <button type="button" className="secondary-button compact-button" onClick={onCancel}>Close</button>}
      </div>
      {tutorialPlantingHint && (
        <div className="tutorial-helper-bubble">
          <strong>Tutorial next:</strong> {tutorialPlantingHint}
        </div>
      )}
      <form
        className="form-grid"
        onSubmit={(event) =>
          void handleForm(event, async () => {
            setStatus(isEditing ? "Saving planting..." : "Creating planting...");
            const selectedCropId = Number(cropId || defaultCrop);
            const selectedVarietyId = varietyId ? Number(varietyId) : null;
            const selectedSeedItemId = seedItemId ? Number(seedItemId) : tutorialSeedItemId;
            const cropName = selectedCrop?.name ?? "Crop";
            const varietyName = selectedVariety?.name ?? "";

            const plannedSowDate = plantingDate || null;
            const trayInputsChanged = Boolean(editingPlanting)
              && (trayCountValue !== (editingPlanting?.trayCount ?? null) || traySizeValue !== (editingPlanting?.cellsPerTray ?? 128));
            const savePlantCount = trayInputsChanged && plantingMethod === "transplant" && trayPlantCount != null
              ? trayPlantCount
              : selectedPlantCount;
            const saveBedLengthM = trayInputsChanged && plantingMethod === "transplant"
              ? bedLengthFromPlantCount(savePlantCount, inRowSpacingM, rowsPerBedForCalc)
              : selectedBedLengthM;
            const plantCount = savePlantCount != null && savePlantCount > 0 ? Math.round(savePlantCount) : null;
            const bedLengthUsedM = saveBedLengthM != null && saveBedLengthM > 0 ? saveBedLengthM : null;
            if (countSourceNeedsBlock) {
              setStatus("Choose a block before using Full block.");
              return;
            }
            if (!plantCount) {
              setStatus("Enter plant count, tray count, bed length, or use Full block.");
              return;
            }
            const rowsPerBedForSave = rowsPerBedValue != null ? Math.round(rowsPerBedValue) : null;
            if (rowsPerBedForSave == null || rowsPerBedForSave <= 0 || rowsPerBedForSave !== rowsPerBedValue) {
              setStatus("Enter rows per bed.");
              return;
            }
            const daysToHarvestValue = daysToHarvest.trim() ? Number(daysToHarvest) : null;
            if (daysToHarvestValue != null && (!Number.isInteger(daysToHarvestValue) || daysToHarvestValue <= 0)) {
              setStatus("Days to harvest must be a whole number above zero.");
              return;
            }

            const titleSeed = [cropName, varietyName].filter(Boolean).join(" / ");
            const selectedTaskFlowTemplateId = taskFlowTemplateId
              ? Number(taskFlowTemplateId)
              : plantingMethod === "direct_seed"
                ? directSeedTaskFlow?.id ?? null
                : null;
            const payload = {
              cropId: selectedCropId,
              varietyId: selectedVarietyId,
              seedItemId: selectedSeedItemId,
              title: title.trim() || titleSeed || editingPlanting?.title || "New planting batch",
              status: inferredPlantingStatus,
              intendedFieldId: selectedLocationFieldId,
              intendedBlockId: selectedLocationBlockId,
              intendedBedId: hasMultipleInitialBeds ? null : intendedBedId ? Number(intendedBedId) : null,
              taskFlowTemplateId: selectedTaskFlowTemplateId,
              spacing,
              plantCount,
              bedLengthUsedM,
              trayLocation: plantingMethod === "transplant" ? trayLocation.trim() || null : null,
              trayCount: plantingMethod === "transplant" && trayCount ? Number(trayCount) : null,
              cellsPerTray: plantingMethod === "transplant" ? traySizeValue : null,
              daysToHarvest: daysToHarvestValue,
              fieldSpacingInRow: spacingInRow.trim() ? Number(spacingInRow) : null,
              rowSpacing: spacingBetweenRows.trim() ? Number(spacingBetweenRows) : null,
              rowsPerBed: rowsPerBedForSave,
              bedCover: bedCover || null,
              notes,
              plannedSowDate,
              plannedTransplantDate: plantingMethod === "direct_seed" ? null : plannedTransplantDate || null,
              expectedHarvestStart: expectedHarvestStart || null,
              expectedHarvestEnd: expectedHarvestEnd || null
            };

            if (editingPlanting) {
              await api.updatePlanting(editingPlanting.id, payload);
              setStatus(null);
              await onSave();
              return;
            }

            let createResult: { id?: number };
            if (hasMultipleInitialBeds) {
              const distributedPlantCounts = distributePlantCountAcrossBeds(plantCount, initialMapBeds);
              const placements = initialMapBeds.map((bed, index) => {
                const bedLengthM = Number(bed.bedLengthM);
                return {
                  bedId: bed.id,
                  plantCount: distributedPlantCounts[index],
                  bedLengthUsedM: Number.isFinite(bedLengthM) && bedLengthM > 0 ? bedLengthM : null,
                  actualDate: null,
                  locationDetail: "Selected from map",
                  notes: "Planned from map bed selection"
                };
              });
              createResult = await api.createPlantingWorkflow({
                ...payload,
                seedItemId: selectedSeedItemId,
                placements
              });
            } else {
              createResult = await api.createPlanting({
                ...payload,
                seedItemId: selectedSeedItemId
              }) as { id?: number };
            }
            if (inferredPlantingStatus !== "planned" && createResult.id && plannedSowDate) {
              await api.recordActual(createResult.id, {
                eventType: plantingMethod === "direct_seed" ? "direct_seeding" : "tray_seeding",
                actualDate: plannedSowDate,
                notes: "Recorded from New Planting form"
              });
            }
            setStatus(null);
            await onSave();
          })
        }
      >
        <label>
          <span>Crop</span>
          <select
            value={cropId}
            onChange={(event) => {
              setCropId(event.target.value);
              setVarietyId("");
              setSeedItemId("");
              setTutorialSeedItemId(null);
            }}
          >
            {data.crops.map((crop) => <option key={crop.id} value={crop.id}>{crop.name}</option>)}
          </select>
        </label>
        <label>
          <span>Variety</span>
          <select
            value={varietyId}
            onChange={(event) => {
              setVarietyId(event.target.value);
              setSeedItemId("");
              setTutorialSeedItemId(null);
            }}
          >
            <option value="">None / decide later</option>
            {varietiesForCrop.map((variety) => <option key={variety.id} value={variety.id}>{variety.name}</option>)}
          </select>
        </label>
        <label>
          <span>Seed record</span>
          <select
            value={seedItemId}
            onChange={(event) => {
              const nextSeedItemId = event.target.value;
              const nextSeedItem = data.seedItems.find((seed) => String(seed.id) === nextSeedItemId) ?? null;
              setSeedItemId(nextSeedItemId);
              setTutorialSeedItemId(null);
              if (nextSeedItem?.cropId != null) {
                setCropId(String(nextSeedItem.cropId));
              }
              if (nextSeedItem?.varietyId != null) {
                setVarietyId(String(nextSeedItem.varietyId));
              }
              if (nextSeedItem?.daysToMaturity != null) {
                setDaysToHarvest(String(nextSeedItem.daysToMaturity));
                setLastDateInput("daysToHarvest");
              }
              const spacingSuggestion = nextSeedItem ? seedSpacingSuggestion(nextSeedItem, data, distanceUnit) : null;
              if (spacingSuggestion) {
                setSpacingInRow(spacingSuggestion.inRow);
                setSpacingBetweenRows(spacingSuggestion.betweenRows);
                if (spacingSuggestion.rowsPerBed) {
                  setRowsPerBed(spacingSuggestion.rowsPerBed);
                }
              }
            }}
          >
            <option value="">None / choose later</option>
            {seedItemOptions.map((seed) => (
              <option key={seed.id} value={seed.id}>
                {seed.displayName || `${seed.cropType}${seed.varietyName ? ` / ${seed.varietyName}` : ""}`}
                {seed.daysToMaturity == null ? "" : ` - ${seed.daysToMaturity} days`}
                {seed.archivedAt == null ? "" : " (archived)"}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Planting date</span>
          <input
            name="plannedSowDate"
            type="date"
            value={plantingDate}
            onChange={(event) => {
              setPlantingDate(event.target.value);
              setLastDateInput("plantingDate");
            }}
          />
        </label>
        <label>
          <span>Planned transplant</span>
          <input
            name="plannedTransplantDate"
            type="date"
            value={plannedTransplantDate}
            onChange={(event) => {
              setPlannedTransplantDate(event.target.value);
              setLastDateInput("plannedTransplantDate");
            }}
          />
        </label>
        <label>
          <span>Harvest start</span>
          <input
            name="expectedHarvestStart"
            type="date"
            value={expectedHarvestStart}
            onChange={(event) => {
              setExpectedHarvestStart(event.target.value);
              setLastDateInput("expectedHarvestStart");
            }}
          />
        </label>
        <label>
          <span>Days to harvest</span>
          <input
            type="number"
            min="1"
            step="1"
            value={daysToHarvest}
            onChange={(event) => {
              setDaysToHarvest(event.target.value);
              setLastDateInput("daysToHarvest");
            }}
          />
        </label>
        <label>
          <span>Harvest end</span>
          <input
            name="expectedHarvestEnd"
            type="date"
            value={expectedHarvestEnd}
            onChange={(event) => {
              setExpectedHarvestEnd(event.target.value);
              setLastDateInput("expectedHarvestEnd");
            }}
          />
        </label>

        <label>
          <span>Field or block</span>
          <select
            value={locationScope}
            disabled={hasMultipleInitialBeds}
            onChange={(event) => {
              setLocationScope(event.target.value);
              setIntendedBedId("");
            }}
          >
            <option value="">Any location / decide later</option>
            {ownFields.map((field) => <option key={`field-${field.id}`} value={`field:${field.id}`}>Field: {field.name}</option>)}
            {ownBlocks.map((block) => <option key={`block-${block.id}`} value={`block:${block.id}`}>Block: {block.fieldName} / {block.name}</option>)}
          </select>
        </label>
        {hasMultipleInitialBeds && (
          <div className="instruction-box full-span">
            Selected beds: {initialMapBeds.map((bed) => bed.name).join(", ")}.
            {initialMapBedLengthM != null && <span> Total length: {formatLengthInputValue(initialMapBedLengthM, distanceUnit)} {distanceUnit}.</span>}
          </div>
        )}

        <label>
          <span>Bed cover</span>
          <select value={bedCover} onChange={(event) => setBedCover(event.target.value)}>
            <option value="">Not set</option>
            <option value="bare">Bare</option>
            <option value="plastic">Plastic mulch</option>
          </select>
        </label>
        <div className="full-span spacing-pair">
          <label>
            <span>In-row spacing ({spacingUnitLabel(distanceUnit)})</span>
            <input type="number" min="0" step={distanceUnit === "ft" ? "0.5" : "1"} value={spacingInRow} onChange={(event) => setSpacingInRow(event.target.value)} />
          </label>
          <label>
            <span>Between-row spacing ({spacingUnitLabel(distanceUnit)})</span>
              <input type="number" min="0" step={distanceUnit === "ft" ? "0.5" : "1"} value={spacingBetweenRows} onChange={(event) => setSpacingBetweenRows(event.target.value)} />
          </label>
        </div>
        <label>
          <span>Rows per bed</span>
          <input type="number" min="1" step="1" value={rowsPerBed} onChange={(event) => setRowsPerBed(event.target.value)} />
        </label>

        <label className={tutorialNeedsPlantCount ? " tutorial-target" : ""} data-tutorial-label={tutorialNeedsPlantCount ? "Type count" : undefined}>
          <span>Plant count</span>
          <input
            type="number"
            min="1"
            step="1"
            value={transplantPlantCountInput}
            onChange={(event) => {
              setPlantCountSource("plant_count");
              setTransplantPlantCountInput(event.target.value);
            }}
          />
        </label>
        <label>
          <span>Bed length ({distanceUnit})</span>
          <input
            type="number"
            min="0"
            step="0.1"
            value={directBedLength}
            onChange={(event) => {
              setPlantCountSource("bed_length");
              setDirectBedLength(event.target.value);
            }}
          />
        </label>
        <div className="button-row">
          <button type="button" className="secondary-button compact-button fill-block-button" onClick={() => setPlantCountSource("full_block")}>
            Fill block
          </button>
        </div>
        {plantingMethod === "transplant" && (
          <>
            <label>
              <span>Tray size</span>
              <select
                value={traySize}
                onChange={(event) => {
                  setPlantCountSource("tray_count");
                  setTraySize(event.target.value);
                }}
              >
                <option value="128">128-cell</option>
                <option value="288">288-cell</option>
                <option value="72">72-cell</option>
                <option value="50">50-cell</option>
              </select>
            </label>
            <label>
              <span>Tray count</span>
              <input
                type="number"
                min="0"
                step="0.1"
                value={trayCount}
                onChange={(event) => {
                  setPlantCountSource("tray_count");
                  setTrayCount(event.target.value);
                }}
              />
            </label>
            <label className="full-span"><span>Tray location (optional)</span><input value={trayLocation} onChange={(event) => setTrayLocation(event.target.value)} placeholder="Greenhouse bench, tray rack, or leave blank" /></label>
          </>
        )}
        <label>
          <span>Task flow</span>
          <select name="taskFlowTemplateId" value={taskFlowTemplateId} onChange={(event) => setTaskFlowTemplateId(event.target.value)}>
            <option value="">Automatic default</option>
            {taskFlowTemplates.map((flow) => <option key={flow.id} value={flow.id}>{flow.name}{flow.cropName ? ` (${flow.cropName})` : ""}</option>)}
          </select>
        </label>
        {tutorialSeedItemId != null && (
          <div className="instruction-box full-span">
            Cabbage tutorial seed data is attached. The dates are set so the second cultivation lands in the current week.
          </div>
        )}
        <label className="full-span"><span>Notes</span><textarea name="notes" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        {status && <p className="muted full-span"><strong>{status}</strong></p>}
        <button className={`primary-button full-span${tutorialReadyToCreate ? " tutorial-target" : ""}`}>{isEditing ? "Save planting" : "Create planting"}</button>
      </form>
    </div>
  );
}
