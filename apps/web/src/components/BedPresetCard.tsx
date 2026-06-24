import { useState } from "react";
import { api } from "../api";
import { DashboardData } from "../types";
import { DistanceUnit, formatLength, formatLengthInputValue, parseLengthInputValue } from "../unit-utils";
import { handleForm } from "../form-utils";
import { MobileListLimiter } from "./MobileListLimiter";

const FEET_TO_METERS = 0.3048;

export function BedPresetCard({
  farmId,
  bedPresets,
  distanceUnit,
  onSave
}: {
  farmId: number | null;
  bedPresets: DashboardData["bedPresets"];
  distanceUnit: DistanceUnit;
  onSave: () => Promise<void>;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [isRoadPreset, setIsRoadPreset] = useState(false);

  async function deletePreset(id: number, name: string) {
    const confirmed = window.confirm(`Delete bed preset "${name}"? Existing beds will stay on the map.`);
    if (!confirmed) {
      return;
    }

    try {
      setNotice("Deleting preset...");
      await api.deleteBedPreset(id);
      await onSave();
      setNotice("Preset deleted.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not delete preset.");
    }
  }

  return (
    <details className="full-span foldout-panel" open={bedPresets.length === 0 ? true : undefined}>
      <summary>Manage bed presets</summary>
      <p className="muted">Store each farm bed system once, then reuse it when filling blocks. Bed width is the plantable bed only; path spacing is left as open space. Use a road/path preset for non-plantable access lanes.</p>
      {notice && <p className="muted"><strong>{notice}</strong></p>}
      {bedPresets.length > 0 && (
        <MobileListLimiter itemCount={bedPresets.length} itemLabel="bed presets">
          <div className="generated-bed-list">
            {bedPresets.map((preset) => (
              <span key={preset.id} className="small-chip preset-chip">
                {preset.isRoad
                  ? `${preset.name}: ${formatLength(preset.bedWidthM, distanceUnit)} road/path`
                  : `${preset.name}: ${formatLength(preset.bedWidthM, distanceUnit)} bed / ${formatLength(preset.pathSpacingM, distanceUnit)} path`}
                <button type="button" className="link-button" onClick={() => void deletePreset(preset.id, preset.name)}>Delete</button>
              </span>
            ))}
          </div>
        </MobileListLimiter>
      )}
      <form
        className="form-grid"
        onSubmit={(event) =>
          void handleForm(event, async (form) => {
            if (!farmId) {
              throw new Error("Farm not loaded");
            }
            const bedWidthM = parseLengthInputValue(form.get("bedWidthM"), distanceUnit);
            const pathSpacingM = isRoadPreset ? 0 : parseLengthInputValue(form.get("pathSpacingM"), distanceUnit);
            if (bedWidthM == null || pathSpacingM == null) {
              throw new Error(isRoadPreset ? "Road/path width is required" : "Bed width and path spacing are required");
            }
            await api.createBedPreset({
              farmId,
              name: String(form.get("name")),
              bedWidthM,
              pathSpacingM,
              isRoad: isRoadPreset,
              notes: String(form.get("notes") || "")
            });
            setIsRoadPreset(false);
            await onSave();
          })
        }
      >
        <label><span>Name</span><input key={isRoadPreset ? "road-name" : "bed-name"} name="name" defaultValue={isRoadPreset ? "Farm road 12 ft" : "Bare bed 3 ft"} /></label>
        <label className="inline-checkbox">
          <input type="checkbox" checked={isRoadPreset} onChange={(event) => setIsRoadPreset(event.target.checked)} />
          <span>Road/path preset, not plantable</span>
        </label>
        <label>
          <span>{isRoadPreset ? "Road/path width" : "Bed width"} ({distanceUnit})</span>
          <input
            key={isRoadPreset ? "road-width" : "bed-width"}
            name="bedWidthM"
            type="number"
            step="0.01"
            defaultValue={formatLengthInputValue(isRoadPreset ? 12 * FEET_TO_METERS : 3 * FEET_TO_METERS, distanceUnit)}
          />
        </label>
        <label>
          <span>Path spacing ({distanceUnit})</span>
          <input
            name="pathSpacingM"
            type="number"
            step="0.01"
            defaultValue={formatLengthInputValue(2 * FEET_TO_METERS, distanceUnit)}
            disabled={isRoadPreset}
          />
        </label>
        <label className="full-span"><span>Notes</span><textarea key={isRoadPreset ? "road-notes" : "bed-notes"} name="notes" rows={2} defaultValue={isRoadPreset ? "Default non-plantable farm road: 12 ft wide." : "Default bare bed: 3 ft plantable bed with 2 ft path."} /></label>
        <button className="primary-button full-span">Save preset</button>
      </form>
    </details>
  );
}
