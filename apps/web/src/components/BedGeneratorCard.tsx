import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { Bed, Block, BlockZone, DashboardData } from "../types";
import { DistanceUnit, formatLength } from "../unit-utils";
import { CoordinateDraft, buildNextBedPreview, polygonIsInsideOrOnPolygon } from "../map-geometry";
import { geoJsonPolygonToLatLngs } from "../map-utils";
import { MobileListLimiter } from "./MobileListLimiter";
import { BedPresetCard } from "./BedPresetCard";

const FEET_TO_METERS = 0.3048;

const DEFAULT_BED_PRESETS = [
  {
    name: "Bare bed 3 ft",
    bedWidthM: 3 * FEET_TO_METERS,
    pathSpacingM: 2 * FEET_TO_METERS,
    isRoad: false,
    notes: "Default bare bed: 3 ft plantable bed with 2 ft path."
  },
  {
    name: "Plastic bed 3 ft",
    bedWidthM: 3 * FEET_TO_METERS,
    pathSpacingM: 3 * FEET_TO_METERS,
    isRoad: false,
    notes: "Default plastic bed: 3 ft bed with 3 ft path."
  },
  {
    name: "Farm road 12 ft",
    bedWidthM: 12 * FEET_TO_METERS,
    pathSpacingM: 0,
    isRoad: true,
    notes: "Default non-plantable farm road: 12 ft wide."
  }
] as const;

export function BedGeneratorCard({
  block,
  zone,
  farmId,
  bedPresets,
  existingBeds,
  distanceUnit,
  bedLineCoordinates,
  bedLineSource,
  bedLineMode,
  invertSide,
  entranceSide,
  isPickingLine,
  isPickingEdge,
  tutorialActive,
  onPickEdge,
  onStartLine,
  onCancelLine,
  onInvertSideChange,
  onPreviewChange,
  onStatusChange,
  onSave,
  onBlockFilled,
  onTutorialBedsGenerated,
  onSelectBed
}: {
  block: Block;
  zone: BlockZone | null;
  farmId: number | null;
  bedPresets: DashboardData["bedPresets"];
  existingBeds: Bed[];
  distanceUnit: DistanceUnit;
  bedLineCoordinates: CoordinateDraft[];
  bedLineSource: "manual" | "selected_bed";
  bedLineMode: "straight" | "curved";
  invertSide: boolean;
  entranceSide: "start" | "end";
  isPickingLine: boolean;
  isPickingEdge: boolean;
  tutorialActive: boolean;
  onPickEdge: () => void;
  onStartLine: (mode: "straight" | "curved") => void;
  onCancelLine: () => void;
  onInvertSideChange: (value: boolean) => void;
  onPreviewChange: (points: CoordinateDraft[]) => void;
  onStatusChange: (message: string | null) => void;
  onSave: () => Promise<void>;
  onBlockFilled?: () => void;
  onTutorialBedsGenerated?: (bedIds: number[]) => void;
  onSelectBed: (bedId: number) => void;
}) {
  const minPoints = bedLineMode === "straight" ? 2 : 3;
  const maxPoints = bedLineMode === "straight" ? 2 : 12;
  const [selectedPresetId, setSelectedPresetId] = useState(String(bedPresets[0]?.id ?? ""));
  const [bedCount, setBedCount] = useState("6");
  const [namePrefix, setNamePrefix] = useState(`${block.name}-`);
  const [startNumber, setStartNumber] = useState(existingBeds.length + 1);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [harvestRoadsEnabled, setHarvestRoadsEnabled] = useState(false);
  const [harvestRoadEveryBeds, setHarvestRoadEveryBeds] = useState("12");
  const [harvestRoadWidthBeds, setHarvestRoadWidthBeds] = useState("2");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCreatingStarterPreset, setIsCreatingStarterPreset] = useState(false);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const selectedPreset = bedPresets.find((preset) => String(preset.id) === selectedPresetId) ?? bedPresets[0];
  const hasExistingBeds = existingBeds.length > 0;
  const tutorialBedHint = tutorialActive
    ? bedLineCoordinates.length < minPoints
      ? isPickingEdge || isPickingLine
        ? "Click two points on the map along the block edge that beds should follow."
        : "Click Select reference edge, then choose the block side where the first bed should be made."
      : "The bed edge is ready. Click Fill rest of block to fill the block with beds."
    : null;

  useEffect(() => {
    if (!selectedPresetId && bedPresets[0]) {
      setSelectedPresetId(String(bedPresets[0].id));
    }
  }, [bedPresets, selectedPresetId]);

  useEffect(() => {
    setNamePrefix(`${block.name}-`);
  }, [block.id, block.name]);

  useEffect(() => {
    if (!hasExistingBeds && replaceExisting) {
      setReplaceExisting(false);
      return;
    }
    if (!replaceExisting) {
      setStartNumber(existingBeds.length + 1);
    }
  }, [existingBeds.length, hasExistingBeds, replaceExisting]);

  useEffect(() => {
    if (!selectedPreset || bedLineCoordinates.length < minPoints || bedLineCoordinates.length > maxPoints) {
      onPreviewChange([]);
      return;
    }

    const roadEvery = harvestRoadsEnabled ? Number(harvestRoadEveryBeds) : null;
    const roadWidth = harvestRoadsEnabled ? Number(harvestRoadWidthBeds) : 0;
    const presetPathSpacing = selectedPreset.isRoad ? 0 : Number(selectedPreset.pathSpacingM);
    const selectedBedEdgeOffsetM = bedLineSource === "selected_bed" && !selectedPreset.isRoad ? presetPathSpacing : 0;
    const blockBoundary = geoJsonPolygonToLatLngs(block.boundary);
    const preview = buildNextBedPreview(
      bedLineCoordinates,
      Number(selectedPreset.bedWidthM),
      presetPathSpacing,
      bedLineSource === "selected_bed" ? 0 : replaceExisting ? 0 : existingBeds.length,
      selectedBedEdgeOffsetM,
      invertSide,
      roadEvery && Number.isFinite(roadEvery) ? roadEvery : null,
      Number.isFinite(roadWidth) ? roadWidth : 0
    );
    if (polygonIsInsideOrOnPolygon(preview, blockBoundary)) {
      onPreviewChange(preview);
    } else {
      const alternatePreview = buildNextBedPreview(
        bedLineCoordinates,
        Number(selectedPreset.bedWidthM),
        presetPathSpacing,
        bedLineSource === "selected_bed" ? 0 : replaceExisting ? 0 : existingBeds.length,
        selectedBedEdgeOffsetM,
        !invertSide,
        roadEvery && Number.isFinite(roadEvery) ? roadEvery : null,
        Number.isFinite(roadWidth) ? roadWidth : 0
      );
      if (polygonIsInsideOrOnPolygon(alternatePreview, blockBoundary)) {
        onInvertSideChange(!invertSide);
        onPreviewChange(alternatePreview);
      } else {
        onPreviewChange([]);
      }
    }

    return () => onPreviewChange([]);
  }, [
    bedLineCoordinates,
    block.boundary,
    bedLineCoordinates.length,
    existingBeds.length,
    bedLineSource,
    harvestRoadEveryBeds,
    harvestRoadsEnabled,
    harvestRoadWidthBeds,
    invertSide,
    maxPoints,
    minPoints,
    onPreviewChange,
    onInvertSideChange,
    replaceExisting,
    selectedPreset
  ]);

  async function generateBeds(options: { count: number; fillWholeBlock: boolean }) {
    if (!farmId) {
      const message = "Farm not loaded";
      setLocalNotice(message);
      onStatusChange(message);
      return;
    }

    if (bedLineCoordinates.length < minPoints || bedLineCoordinates.length > maxPoints) {
      const message = bedLineMode === "straight" ? "Select the reference edge first." : "Pick 3 to 12 line points first.";
      setLocalNotice(message);
      onStatusChange(message);
      return;
    }

    const roadEvery = selectedPreset?.isRoad ? null : harvestRoadsEnabled ? Number(harvestRoadEveryBeds) : null;
    const roadWidth = harvestRoadsEnabled ? Number(harvestRoadWidthBeds) : 0;
    if (!selectedPreset?.isRoad && harvestRoadsEnabled && (!roadEvery || !Number.isInteger(roadEvery) || roadEvery < 1 || !Number.isInteger(roadWidth) || roadWidth < 1)) {
      const message = "Harvest roads need a bed interval and a road width above zero.";
      setLocalNotice(message);
      onStatusChange(message);
      return;
    }

    const parsedCount = Number(options.count);
    const parsedStartNumber = Number(startNumber);
    if (!selectedPreset || !Number.isInteger(parsedCount) || parsedCount < 1 || !Number.isInteger(parsedStartNumber) || parsedStartNumber < 1) {
      const message = "Choose a preset, number of beds, and start number first.";
      setLocalNotice(message);
      onStatusChange(message);
      return;
    }

    try {
      setIsGenerating(true);
      setLocalNotice("Generating beds...");
      onStatusChange("Generating beds...");

      const result = await api.generateBeds(block.id, {
        presetId: selectedPreset.id,
        zoneId: null,
        lineMode: bedLineMode,
        lineCoordinates: bedLineCoordinates,
        count: parsedCount,
        layoutStartIndex: bedLineSource === "selected_bed" ? 0 : replaceExisting ? 0 : existingBeds.length,
        edgeOffsetM: bedLineSource === "selected_bed" && !selectedPreset.isRoad ? Number(selectedPreset.pathSpacingM) : 0,
        namePrefix,
        startNumber: parsedStartNumber,
        isPermanent: true,
        replaceExisting,
        invertSide,
        entranceSide,
        fillWholeBlock: options.fillWholeBlock,
        harvestRoadEveryBeds: roadEvery,
        harvestRoadWidthBeds: roadWidth
      }) as { inserted?: number; insertedIds?: number[]; isRoad?: boolean };

      await onSave();
      if (!options.fillWholeBlock && result.insertedIds?.length) {
        onSelectBed(result.insertedIds[result.insertedIds.length - 1]);
      }
      if (options.fillWholeBlock && !result.isRoad) {
        onBlockFilled?.();
      }

      const message = result.inserted != null ? `Generated ${result.inserted} bed(s).` : "Beds generated.";
      setLocalNotice(message);
      onStatusChange(message);
      if (!result.isRoad && result.insertedIds?.length) {
        onTutorialBedsGenerated?.(result.insertedIds);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not generate beds.";
      console.error("Bed generation failed", error);
      setLocalNotice(message);
      onStatusChange(message);
    } finally {
      setIsGenerating(false);
    }
  }

  async function submitGenerateBeds(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await generateBeds({
      count: Number(bedCount || 1),
      fillWholeBlock: false
    });
  }

  async function createStarterPresets() {
    if (!farmId) {
      const message = "Farm not loaded";
      setLocalNotice(message);
      onStatusChange(message);
      return;
    }

    try {
      setIsCreatingStarterPreset(true);
      setLocalNotice("Creating bed preset…");
      onStatusChange("Creating bed preset…");
      for (const preset of DEFAULT_BED_PRESETS) {
        await api.createBedPreset({
          farmId,
          name: preset.name,
          bedWidthM: preset.bedWidthM,
          pathSpacingM: preset.pathSpacingM,
          isRoad: preset.isRoad,
          notes: preset.notes
        });
      }
      await onSave();
      setLocalNotice("Bed presets created. Next, select a reference edge.");
      onStatusChange("Bed presets created. Next, select a reference edge.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create starter bed presets.";
      setLocalNotice(message);
      onStatusChange(message);
    } finally {
      setIsCreatingStarterPreset(false);
    }
  }

  return (
    <div className="card">
      <h2>Generate beds</h2>
      <p className="muted">
        {zone ? `${zone.name} in ` : ""}{block.name} / {block.fieldName}
        {!zone ? " (whole block)" : ""}
      </p>
      {tutorialBedHint && (
        <div className="tutorial-helper-bubble">
          <strong>Tutorial next:</strong> {tutorialBedHint}
        </div>
      )}
      {bedPresets.length === 0 ? (
        <>
          <div className="instruction-box">
            <strong>No bed preset yet</strong> Save a bed width and path spacing before generating beds. You can create starter presets now and adjust them later.
          </div>
          {localNotice && <p className="muted"><strong>{localNotice}</strong></p>}
          <div className="button-row">
            <button
              type="button"
              className="primary-button"
              disabled={isCreatingStarterPreset}
              onClick={() => void createStarterPresets()}
            >
              {isCreatingStarterPreset ? "Creating..." : "Create new bed presets"}
            </button>
          </div>
          <BedPresetCard farmId={farmId} bedPresets={bedPresets} distanceUnit={distanceUnit} onSave={onSave} />
        </>
      ) : (
        <>
          <form
            className="form-grid"
            onSubmit={(event) => {
              void submitGenerateBeds(event);
            }}
          >
            {bedLineSource !== "selected_bed" && (
              <>
                <div className="full-span button-row">
                  <button
                    type="button"
                    className={`primary-button${tutorialActive && bedLineCoordinates.length < minPoints ? " tutorial-target" : ""}`}
                    onClick={onPickEdge}
                  >
                    {isPickingEdge ? "Stop selecting" : "Select reference edge"}
                  </button>
                  <p className="muted full-span">First bed in block is made on this side</p>
                  {isPickingLine && (
                    <button type="button" className="secondary-button" onClick={onCancelLine}>
                      Cancel line
                    </button>
                  )}
                </div>
              </>
            )}
            {bedLineSource === "selected_bed" && (
              <div className="instruction-box full-span">
                <strong>Next-bed mode:</strong> A bed is selected, so this card is only showing the quick tool for adding one bed beside it. Use the button below to show the full Generate Beds card with count, fill, line, and road controls.
                <div className="button-row">
                <button type="button" className="primary-button" onClick={onPickEdge}>
                  Show full bed generator
                </button>
                </div>
              </div>
            )}
            {localNotice && <p className="muted"><strong>{localNotice}</strong></p>}
            <label>
              <span>Preset</span>
              <select value={selectedPresetId} onChange={(event) => setSelectedPresetId(event.target.value)}>
                {bedPresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.isRoad
                      ? `${preset.name} (${formatLength(preset.bedWidthM, distanceUnit)} road/path)`
                      : `${preset.name} (${formatLength(preset.bedWidthM, distanceUnit)} bed / ${formatLength(preset.pathSpacingM, distanceUnit)} path)`}
                  </option>
                ))}
              </select>
            </label>
            <div className="button-row">
              <button
                type="button"
                className="secondary-button"
                disabled={bedLineCoordinates.length < minPoints || bedLineCoordinates.length > maxPoints || isGenerating}
                onClick={() => void generateBeds({ count: 1, fillWholeBlock: false })}
              >
                {isGenerating ? "Generating..." : selectedPreset?.isRoad ? "Make one road" : "Make one bed"}
              </button>
            </div>
            {bedLineSource !== "selected_bed" && !selectedPreset?.isRoad && (
              <label>
                <span>Number of beds</span>
                <input value={bedCount} onChange={(event) => setBedCount(event.target.value)} type="number" min="1" max="100" />
              </label>
            )}
            <label><span>Name prefix</span><input value={namePrefix} onChange={(event) => setNamePrefix(event.target.value)} /></label>
            <label><span>{bedLineSource === "selected_bed" ? "Next bed number" : "Start number"}</span><input value={startNumber} onChange={(event) => setStartNumber(Number(event.target.value))} type="number" min="1" /></label>
            {bedLineSource !== "selected_bed" && (
              <>
                <label>
                  <span>Existing beds</span>
                  <select
                    value={String(replaceExisting)}
                    disabled={!hasExistingBeds}
                    onChange={(event) => {
                      const nextValue = event.target.value === "true";
                      setReplaceExisting(nextValue);
                      setStartNumber(nextValue ? 1 : existingBeds.length + 1);
                    }}
                  >
                    <option value="false">{hasExistingBeds ? "Keep existing beds" : "No existing beds"}</option>
                    <option value="true">Replace beds in block</option>
                  </select>
                </label>
              </>
            )}
            {bedLineSource !== "selected_bed" && (
              <details className="full-span foldout-panel">
                <summary>Harvest roads</summary>
                <label className="inline-checkbox">
                  <input type="checkbox" checked={harvestRoadsEnabled} onChange={(event) => setHarvestRoadsEnabled(event.target.checked)} />
                  <span>Leave gaps for roads while generating beds</span>
                </label>
                <div className="form-grid">
                  <label>
                    <span>Road after every __ beds</span>
                    <input value={harvestRoadEveryBeds} onChange={(event) => setHarvestRoadEveryBeds(event.target.value)} type="number" min="1" disabled={!harvestRoadsEnabled} />
                  </label>
                  <label>
                    <span>Road width in bed spaces</span>
                    <input value={harvestRoadWidthBeds} onChange={(event) => setHarvestRoadWidthBeds(event.target.value)} type="number" min="1" max="20" disabled={!harvestRoadsEnabled} />
                  </label>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setHarvestRoadsEnabled(true);
                    setHarvestRoadEveryBeds("12");
                    setHarvestRoadWidthBeds("2");
                  }}
                >
                  Example: skip 2 bed spaces every 12 beds
                </button>
                <p className="muted">Example: road width 2 leaves the space of two beds before continuing.</p>
              </details>
            )}
            {bedLineSource !== "selected_bed" && (
              <div className="full-span">
                <MobileListLimiter itemCount={existingBeds.length} itemLabel="existing beds">
                  <div className="generated-bed-list">
                    {existingBeds.map((bed) => (
                      <span key={bed.id} className="small-chip">{bed.name}</span>
                    ))}
                  </div>
                </MobileListLimiter>
              </div>
            )}
            {bedLineSource !== "selected_bed" && (
              <div className="button-row full-span">
                <button
                  type="submit"
                  className="primary-button"
                  disabled={bedLineCoordinates.length < minPoints || bedLineCoordinates.length > maxPoints || isGenerating}
                >
                  {isGenerating ? "Generating..." : "Generate beds"}
                </button>
                <button
                  type="button"
                  className={`secondary-button${tutorialActive && bedLineCoordinates.length >= minPoints ? " tutorial-target" : ""}`}
                  disabled={bedLineCoordinates.length < minPoints || bedLineCoordinates.length > maxPoints || isGenerating}
                  onClick={() => void generateBeds({ count: 1, fillWholeBlock: true })}
                >
                  Fill rest of block
                </button>
              </div>
            )}
          </form>
          <BedPresetCard farmId={farmId} bedPresets={bedPresets} distanceUnit={distanceUnit} onSave={onSave} />
        </>
      )}
    </div>
  );
}
