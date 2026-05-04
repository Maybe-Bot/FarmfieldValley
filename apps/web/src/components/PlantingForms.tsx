import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { Bed, DashboardData, TaskFlowTemplate } from "../types";

type DistanceUnit = "m" | "ft";

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

function formatSpacingPair(inRow: string, betweenRows: string, unit: DistanceUnit) {
  const label = spacingUnitLabel(unit);
  const first = inRow.trim();
  const second = betweenRows.trim() || first;
  if (!first) {
    return null;
  }

  return `${first} ${label} x ${second} ${label}`;
}

function todayDateInputValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
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
  highlightSubmit = false,
  onSave
}: {
  data: DashboardData;
  taskFlowTemplates: TaskFlowTemplate[];
  distanceUnit: DistanceUnit;
  tutorialDraft?: PlantingTutorialDraft | null;
  highlightSubmit?: boolean;
  onSave: () => Promise<void>;
}) {
  const defaultCrop = data.crops[0]?.id ?? 1;
  const [cropId, setCropId] = useState(String(defaultCrop));
  const [varietyId, setVarietyId] = useState("");
  const [lotNumber, setLotNumber] = useState("");
  const [plantingDate, setPlantingDate] = useState("");
  const [isPlanted, setIsPlanted] = useState(false);
  const [plantingMethod, setPlantingMethod] = useState<"transplant" | "direct_seed">("transplant");
  const [locationScope, setLocationScope] = useState("");
  const [intendedBedId, setIntendedBedId] = useState("");
  const [spacingInRow, setSpacingInRow] = useState(distanceUnit === "ft" ? "12" : "30");
  const [spacingBetweenRows, setSpacingBetweenRows] = useState(distanceUnit === "ft" ? "12" : "30");
  const [traySize, setTraySize] = useState("128");
  const [trayCount, setTrayCount] = useState("");
  const [transplantPlantCountInput, setTransplantPlantCountInput] = useState("");
  const [trayLocation, setTrayLocation] = useState("");
  const [directBedLength, setDirectBedLength] = useState("");
  const [title, setTitle] = useState("");
  const [plannedTransplantDate, setPlannedTransplantDate] = useState("");
  const [expectedHarvestStart, setExpectedHarvestStart] = useState("");
  const [expectedHarvestEnd, setExpectedHarvestEnd] = useState("");
  const [taskFlowTemplateId, setTaskFlowTemplateId] = useState("");
  const [notes, setNotes] = useState("");
  const [tutorialSeedItemId, setTutorialSeedItemId] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const selectedCrop = data.crops.find((crop) => String(crop.id) === cropId) ?? data.crops[0] ?? null;
  const varietiesForCrop = data.varieties.filter((variety) => String(variety.cropId) === cropId);
  const selectedVariety = data.varieties.find((variety) => String(variety.id) === varietyId) ?? null;
  const ownFarmId = data.farm?.id ?? null;
  const ownFields = data.fields.filter((field) => field.farmId === ownFarmId);
  const ownBlocks = data.blocks.filter((block) => block.farmId === ownFarmId);
  const ownBeds = data.beds.filter((bed) => bed.farmId === ownFarmId);
  const blocksForLocation = ownBlocks.filter((block) => String(block.fieldId) === locationScope.replace("field:", ""));
  const plantableBeds = ownBeds.filter((bed) => bed.source !== "road");
  const filteredBeds = locationScope.startsWith("block:")
    ? plantableBeds.filter((bed) => String(bed.blockId) === locationScope.replace("block:", ""))
    : locationScope.startsWith("field:")
      ? plantableBeds.filter((bed) => blocksForLocation.some((block) => block.id === bed.blockId))
      : plantableBeds;
  const spacing = formatSpacingPair(spacingInRow, spacingBetweenRows, distanceUnit) ?? defaultSpacingExample(distanceUnit);
  const inRowSpacingM = spacingInputToMeters(spacingInRow, distanceUnit) ?? 0.3;
  const trayCountValue = toNumericValue(trayCount);
  const traySizeValue = toNumericValue(traySize) ?? 128;
  const explicitTransplantPlantCount = toNumericValue(transplantPlantCountInput);
  const trayPlantCount = trayCountValue != null && trayCountValue > 0 ? Math.max(1, Math.round(trayCountValue * traySizeValue)) : null;
  const transplantPlantCount = explicitTransplantPlantCount != null && explicitTransplantPlantCount > 0
    ? Math.max(1, Math.round(explicitTransplantPlantCount))
    : trayPlantCount;
  const directBedLengthM = parseLengthInputValue(directBedLength || null, distanceUnit);
  const directPlantCountEstimate = directBedLengthM != null && inRowSpacingM > 0
    ? Math.max(1, Math.round(directBedLengthM / inRowSpacingM))
    : null;
  const tutorialNeedsPlantCount = highlightSubmit
    && plantingMethod === "transplant"
    && (explicitTransplantPlantCount == null || explicitTransplantPlantCount <= 0);
  const tutorialNeedsBedLength = highlightSubmit
    && plantingMethod === "direct_seed"
    && directBedLengthM == null;
  const tutorialNeedsIntendedBed = highlightSubmit
    && !tutorialNeedsPlantCount
    && !tutorialNeedsBedLength
    && !intendedBedId;
  const tutorialReadyToCreate = highlightSubmit
    && !tutorialNeedsPlantCount
    && !tutorialNeedsBedLength
    && !tutorialNeedsIntendedBed;
  const tutorialPlantingHint = tutorialNeedsPlantCount
    ? "Enter a plant count for the sample cabbage planting. Tray count can stay blank."
    : tutorialNeedsBedLength
      ? "Enter the bed length to seed."
      : tutorialNeedsIntendedBed
        ? "Confirm the intended bed that was made during the map step."
        : highlightSubmit
          ? "The sample cabbage plan is ready. Click Create planting."
          : null;

  function autoFamilyForCrop(input: string) {
    const normalized = input.trim().toLowerCase();
    if (["tomato", "pepper", "eggplant", "potato", "jalapeno", "jalapino"].some((name) => normalized.includes(name))) {
      return "Nightshade";
    }
    if (["onion", "leek", "shallot", "garlic"].some((name) => normalized.includes(name))) {
      return "Allium";
    }
    if (["cabbage", "kale", "broccoli", "cauliflower", "radish"].some((name) => normalized.includes(name))) {
      return "Brassica";
    }
    return "";
  }

  useEffect(() => {
    if (!tutorialDraft) {
      return;
    }

    setCropId(String(tutorialDraft.cropId));
    setVarietyId(tutorialDraft.varietyId == null ? "" : String(tutorialDraft.varietyId));
    setTutorialSeedItemId(tutorialDraft.seedItemId);
    setPlantingDate(tutorialDraft.plannedSowDate);
    setIsPlanted(false);
    setPlantingMethod("transplant");
    setLocationScope(tutorialDraft.locationScope);
    setIntendedBedId(tutorialDraft.intendedBedId == null ? "" : String(tutorialDraft.intendedBedId));
    setSpacingInRow(tutorialDraft.spacingInRow);
    setSpacingBetweenRows(tutorialDraft.spacingBetweenRows);
    setTraySize("128");
    setTrayCount("");
    setTransplantPlantCountInput("");
    setTrayLocation("");
    setDirectBedLength("");
    setTitle(tutorialDraft.title);
    setPlannedTransplantDate(tutorialDraft.plannedTransplantDate);
    setExpectedHarvestStart(tutorialDraft.expectedHarvestStart);
    setExpectedHarvestEnd(tutorialDraft.expectedHarvestEnd);
    setTaskFlowTemplateId(String(tutorialDraft.taskFlowTemplateId));
    setNotes(tutorialDraft.notes);
    setStatus("Cabbage tutorial sample loaded. Enter a plant count, then create the planting.");
  }, [tutorialDraft]);

  return (
    <div className="card">
      <h2>Plan Planting</h2>
      {tutorialPlantingHint && (
        <div className="tutorial-helper-bubble">
          <strong>Tutorial next:</strong> {tutorialPlantingHint}
        </div>
      )}
      <form
        className="form-grid"
        onSubmit={(event) =>
          void handleForm(event, async (form) => {
            setStatus("Creating planting...");
            const selectedCropId = Number(cropId || defaultCrop);
            const selectedVarietyId = varietyId ? Number(varietyId) : null;
            let seedItemId: number | null = null;
            const cropName = selectedCrop?.name ?? "Crop";
            const varietyName = selectedVariety?.name ?? "";

            if (lotNumber.trim() && data.farm?.id) {
              const seedResult = await api.createSeedItem({
                farmId: data.farm?.id,
                family: autoFamilyForCrop(cropName) || null,
                cropType: cropName,
                varietyName: varietyName || null,
                breedName: null,
                supplier: null,
                lotNumber: lotNumber.trim() || null,
                notes: ""
              });
              seedItemId = seedResult.id;
            } else if (tutorialSeedItemId != null) {
              seedItemId = tutorialSeedItemId;
            }

            const plannedSowDate = plantingDate || null;
            if (isPlanted && plannedSowDate && plannedSowDate > todayDateInputValue()) {
              setStatus("Planting dates cannot be in the future. Use Planning for future work.");
              return;
            }
            const plantCount = plantingMethod === "transplant" ? transplantPlantCount : directPlantCountEstimate;
            const bedLengthUsedM = plantingMethod === "direct_seed" ? directBedLengthM : null;
            if (plantingMethod === "transplant" && !plantCount) {
              setStatus("Enter tray count for transplants.");
              return;
            }
            if (plantingMethod === "direct_seed" && !bedLengthUsedM) {
              setStatus("Enter bed length for direct seeding.");
              return;
            }

            const titleSeed = [cropName, varietyName, lotNumber.trim() ? `lot ${lotNumber.trim()}` : ""].filter(Boolean).join(" / ");
            const createResult = await api.createPlanting({
              cropId: selectedCropId,
              varietyId: selectedVarietyId,
              seedItemId,
              title: String(form.get("title") || titleSeed || "New planting batch"),
              status: isPlanted ? (plantingMethod === "direct_seed" ? "direct_seeded" : "seeded_in_tray") : "planned",
              intendedBedId: intendedBedId ? Number(intendedBedId) : null,
              taskFlowTemplateId: taskFlowTemplateId ? Number(taskFlowTemplateId) : null,
              spacing,
              plantCount,
              bedLengthUsedM,
              trayLocation: plantingMethod === "transplant" ? trayLocation.trim() || null : null,
              trayCount: plantingMethod === "transplant" && trayCount ? Number(trayCount) : null,
              notes,
              plannedSowDate,
              plannedTransplantDate: plannedTransplantDate || null,
              expectedHarvestStart: expectedHarvestStart || null,
              expectedHarvestEnd: expectedHarvestEnd || null
            }) as { id?: number };
            if (isPlanted && createResult.id && plannedSowDate) {
              await api.recordActual(createResult.id, {
                eventType: plantingMethod === "direct_seed" ? "direct_seeding" : "tray_seeding",
                actualDate: plannedSowDate,
                notes: "Recorded from Plan Planting form"
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
              setTutorialSeedItemId(null);
            }}
          >
            {data.crops.map((crop) => <option key={crop.id} value={crop.id}>{crop.name}</option>)}
          </select>
        </label>
        <label>
          <span>Variety</span>
          <select value={varietyId} onChange={(event) => setVarietyId(event.target.value)}>
            <option value="">None / decide later</option>
            {varietiesForCrop.map((variety) => <option key={variety.id} value={variety.id}>{variety.name}</option>)}
          </select>
        </label>
        <label className="full-span">
          <span>Lot number</span>
          <input
            value={lotNumber}
            onChange={(event) => {
              setLotNumber(event.target.value.slice(0, 128));
              setTutorialSeedItemId(null);
            }}
            maxLength={128}
            placeholder="Optional seed lot number"
          />
        </label>

        <label>
          <span>Planting date</span>
          <input name="plannedSowDate" type="date" value={plantingDate} onChange={(event) => setPlantingDate(event.target.value)} />
        </label>
        <label className="inline-checkbox">
          <input type="checkbox" checked={isPlanted} onChange={(event) => setIsPlanted(event.target.checked)} />
          <span>{isPlanted ? "Planted" : "Planning"}</span>
        </label>
        <label><span>Planned transplant</span><input name="plannedTransplantDate" type="date" value={plannedTransplantDate} onChange={(event) => setPlannedTransplantDate(event.target.value)} /></label>
        <label><span>Harvest start</span><input name="expectedHarvestStart" type="date" value={expectedHarvestStart} onChange={(event) => setExpectedHarvestStart(event.target.value)} /></label>
        <label><span>Harvest end</span><input name="expectedHarvestEnd" type="date" value={expectedHarvestEnd} onChange={(event) => setExpectedHarvestEnd(event.target.value)} /></label>

        <label>
          <span>Field or block</span>
          <select
            value={locationScope}
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
        <label className={tutorialNeedsIntendedBed ? " tutorial-target" : ""}>
          <span>Intended bed</span>
          <select value={intendedBedId} onChange={(event) => setIntendedBedId(event.target.value)}>
            <option value="">Unassigned</option>
            {filteredBeds.map((bed) => <option key={bed.id} value={bed.id}>{bed.blockName} / {bed.name}</option>)}
          </select>
        </label>

        <label className="full-span">
          <span>Method</span>
          <select value={plantingMethod} onChange={(event) => setPlantingMethod(event.target.value as "transplant" | "direct_seed")}>
            <option value="transplant">Start in trays, transplant later</option>
            <option value="direct_seed">Direct seed into bed</option>
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

        {plantingMethod === "transplant" ? (
          <>
            <label>
              <span>Tray size</span>
              <select value={traySize} onChange={(event) => setTraySize(event.target.value)}>
                <option value="128">128-cell</option>
                <option value="288">288-cell</option>
                <option value="72">72-cell</option>
                <option value="50">50-cell</option>
              </select>
            </label>
            <label><span>Tray count</span><input type="number" min="0" step="1" value={trayCount} onChange={(event) => setTrayCount(event.target.value)} /></label>
            <label className={tutorialNeedsPlantCount ? " tutorial-target" : ""}><span>Plant count</span><input type="number" min="1" step="1" value={transplantPlantCountInput} onChange={(event) => setTransplantPlantCountInput(event.target.value)} placeholder="Use instead of tray count" /></label>
            <div className="instruction-box full-span">
              Estimated transplants: {transplantPlantCount?.toLocaleString() ?? "enter plant count or tray count"}. Tray location is optional for now.
            </div>
            <label className="full-span"><span>Tray location (optional)</span><input value={trayLocation} onChange={(event) => setTrayLocation(event.target.value)} placeholder="Greenhouse bench, tray rack, or leave blank" /></label>
          </>
        ) : (
          <>
            <label className={tutorialNeedsBedLength ? " tutorial-target" : ""}>
              <span>Bed length to seed ({distanceUnit})</span>
              <input type="number" min="0" step="0.1" value={directBedLength} onChange={(event) => setDirectBedLength(event.target.value)} />
            </label>
            <div className="instruction-box">
              Estimated seed positions: {directPlantCountEstimate?.toLocaleString() ?? "enter spacing and bed length"}.
            </div>
          </>
        )}

        <label><span>Title</span><input name="title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Auto-filled from crop, variety, and lot if blank" /></label>
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
        <button className={`primary-button full-span${tutorialReadyToCreate ? " tutorial-target" : ""}`}>Create planting</button>
      </form>
    </div>
  );
}

// Manual placement form for splitting one planting across one or more beds.
export function PlacementForm({
  plantingId,
  beds,
  distanceUnit,
  onSave
}: {
  plantingId: number;
  beds: Bed[];
  distanceUnit: DistanceUnit;
  onSave: () => Promise<void>;
}) {
  const plantableBeds = beds.filter((bed) => bed.source !== "road");

  return (
    <div className="card">
      <h2>Add child placement</h2>
      <form
        className="form-grid"
        onSubmit={(event) =>
          void handleForm(event, async (form) => {
            await api.addPlacement(plantingId, {
              bedId: Number(form.get("bedId")),
              plantCount: form.get("plantCount") ? Number(form.get("plantCount")) : null,
              bedLengthUsedM: parseLengthInputValue(form.get("bedLengthUsedM"), distanceUnit),
              actualDate: String(form.get("actualDate") || "") || null,
              locationDetail: String(form.get("locationDetail") || "") || null,
              notes: String(form.get("notes") || "")
            });
            await onSave();
          })
        }
      >
        <label>
          <span>Bed</span>
          <select name="bedId">
            {plantableBeds.map((bed) => <option key={bed.id} value={bed.id}>{bed.name}</option>)}
          </select>
        </label>
        <label><span>Date</span><input name="actualDate" type="date" defaultValue={todayDateInputValue()} /></label>
        <label><span>Plant count</span><input name="plantCount" type="number" /></label>
        <label><span>Bed length used ({distanceUnit})</span><input name="bedLengthUsedM" type="number" step="0.1" /></label>
        <label><span>Exact location detail</span><input name="locationDetail" placeholder="North half of bed, east side" /></label>
        <label className="full-span"><span>Notes</span><textarea name="notes" rows={3} defaultValue="Split placement" /></label>
        <button className="primary-button full-span">Add placement</button>
      </form>
    </div>
  );
}
