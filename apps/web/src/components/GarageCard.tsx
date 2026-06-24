import { CSSProperties, useEffect, useState } from "react";
import { api } from "../api";
import { TractorProfile } from "../types";
import { removeSavedTractorProfile, upsertSavedTractorProfile } from "../tractor-profiles";
import { MobileListLimiter } from "./MobileListLimiter";
import { TaskIconMark } from "./TaskIconMark";

type GarageDraft = Pick<TractorProfile, "name" | "tractorModel" | "iconColor" | "iconSecondaryColor">;
type GarageVehicleOption = {
  value: string;
  label: string;
  previewTaskType: string;
};
type ColorPreset = {
  name: string;
  value: string;
};

const garageVehicleOptions = [
  { value: "cab", label: "Cab tractor", previewTaskType: "bed_making" },
  { value: "canopy", label: "Canopy tractor", previewTaskType: "cultivation" },
  { value: "open", label: "Open tractor", previewTaskType: "cleanup" },
  { value: "van", label: "Van", previewTaskType: "transplant" },
  { value: "pickup", label: "Pickup", previewTaskType: "seed_in_tray" },
  { value: "box", label: "Box truck", previewTaskType: "cover_crop" }
] satisfies GarageVehicleOption[];

const primaryColorPresets = [
  { name: "Field green", value: "#3f8f45" },
  { name: "Harvester red", value: "#b7322c" },
  { name: "Utility orange", value: "#d9802e" },
  { name: "Construction yellow", value: "#e2b83f" },
  { name: "Deep blue", value: "#2f5f9f" },
  { name: "Fleet white", value: "#ffffff" },
  { name: "Truck silver", value: "#b9c0c4" },
  { name: "Service black", value: "#2b2f32" }
] satisfies ColorPreset[];

const secondaryColorPresets = [
  { name: "Warm cream", value: "#f2d6aa" },
  { name: "Wheel yellow", value: "#d6a84a" },
  { name: "Cab white", value: "#ffffff" },
  { name: "Charcoal", value: "#303334" },
  { name: "Chrome gray", value: "#aeb7bc" },
  { name: "Safety amber", value: "#e4a11b" }
] satisfies ColorPreset[];

function garageOptionForModel(model: string) {
  return garageVehicleOptions.find((option) => option.value === model) ?? garageVehicleOptions[0];
}

function emptyGarageDraft(): GarageDraft {
  return {
    name: "",
    tractorModel: "cab",
    iconColor: "#b7322c",
    iconSecondaryColor: "#f2d6aa"
  };
}

function profileToDraft(profile: TractorProfile): GarageDraft {
  return {
    name: profile.name,
    tractorModel: profile.tractorModel,
    iconColor: profile.iconColor,
    iconSecondaryColor: profile.iconSecondaryColor
  };
}

export const defaultEntranceTractorProfile: TractorProfile = {
  id: 0,
  farmId: 0,
  name: "Default tractor",
  tractorModel: "cab",
  iconColor: "#b7322c",
  iconSecondaryColor: "#f2d6aa"
};

function ColorPresetRow({
  label,
  value,
  presets,
  onChange
}: {
  label: string;
  value: string;
  presets: ColorPreset[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="color-preset-group">
      <span>{label}</span>
      <div className="color-swatch-row">
        {presets.map((preset) => (
          <button
            key={preset.value}
            type="button"
            className={`color-swatch${preset.value.toLowerCase() === value.toLowerCase() ? " selected" : ""}`}
            style={{ "--swatch-color": preset.value } as CSSProperties}
            title={preset.name}
            aria-label={preset.name}
            onClick={() => onChange(preset.value)}
          />
        ))}
        <input type="color" value={value} aria-label={`Custom ${label.toLowerCase()}`} onChange={(event) => onChange(event.target.value)} />
      </div>
    </div>
  );
}

function GaragePreview({
  profile,
  scale = 1.28,
  spinning = true
}: {
  profile: Pick<TractorProfile, "tractorModel" | "iconColor" | "iconSecondaryColor">;
  scale?: number;
  spinning?: boolean;
}) {
  const option = garageOptionForModel(profile.tractorModel);
  return (
    <TaskIconMark
      taskType={option.previewTaskType}
      color={profile.iconColor}
      secondaryColor={profile.iconSecondaryColor}
      tractorModel={profile.tractorModel}
      scale={scale}
      spinning={spinning}
      mini
    />
  );
}

export function GarageCard({
  tractorProfiles,
  onProfilesChange
}: {
  tractorProfiles: TractorProfile[];
  onProfilesChange?: (profiles: TractorProfile[]) => void;
}) {
  const [savedProfiles, setSavedProfiles] = useState<TractorProfile[]>(tractorProfiles);
  const [draft, setDraft] = useState(emptyGarageDraft);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editingProfile = editingId == null ? null : savedProfiles.find((profile) => profile.id === editingId) ?? null;
  const previewProfile = {
    tractorModel: draft.tractorModel,
    iconColor: draft.iconColor,
    iconSecondaryColor: draft.iconSecondaryColor
  };

  useEffect(() => {
    setSavedProfiles(tractorProfiles);
  }, [tractorProfiles]);

  useEffect(() => {
    let cancelled = false;
    void api.getTractorProfiles()
      .then((profiles) => {
        if (!cancelled) {
          setSavedProfiles(profiles);
          onProfilesChange?.(profiles);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setStatus(error instanceof Error ? `Could not load saved vehicles: ${error.message}` : "Could not load saved vehicles.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onProfilesChange]);

  function editProfile(profile: TractorProfile) {
    setEditingId(profile.id);
    setDraft(profileToDraft(profile));
    setStatus(null);
  }

  function resetGarageForm() {
    setEditingId(null);
    setDraft(emptyGarageDraft());
  }

  async function saveProfile() {
    if (!draft.name.trim()) {
      setStatus("Name is required.");
      return;
    }
    try {
      setSaving(true);
      setStatus("Saving vehicle...");
      const payload = {
        name: draft.name.trim(),
        tractorModel: draft.tractorModel,
        iconColor: draft.iconColor,
        iconSecondaryColor: draft.iconSecondaryColor
      };
      if (editingId == null) {
        const savedProfile = await api.createTractorProfile(payload);
        const nextProfiles = upsertSavedTractorProfile(savedProfiles, savedProfile);
        setSavedProfiles(nextProfiles);
        onProfilesChange?.(nextProfiles);
      } else {
        const savedProfile = await api.updateTractorProfile(editingId, payload);
        const nextProfiles = upsertSavedTractorProfile(savedProfiles, savedProfile);
        setSavedProfiles(nextProfiles);
        onProfilesChange?.(nextProfiles);
      }
      resetGarageForm();
      setStatus("Saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Vehicle save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteProfile(profile: TractorProfile) {
    try {
      setSaving(true);
      setStatus(`Deleting ${profile.name}...`);
      await api.deleteTractorProfile(profile.id);
      const nextProfiles = removeSavedTractorProfile(savedProfiles, profile.id);
      setSavedProfiles(nextProfiles);
      onProfilesChange?.(nextProfiles);
      if (editingId === profile.id) {
        resetGarageForm();
      }
      setStatus("Deleted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Vehicle delete failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <h2>Garage</h2>
      {status && <p className="muted"><strong>{status}</strong></p>}
      <div className="garage-editor">
        <div className="garage-preview">
          <GaragePreview profile={previewProfile} />
        </div>
        <div className="garage-form">
          <div className="form-grid">
            <label>
              <span>Name</span>
              <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Red pickup" />
            </label>
            <label>
              <span>Vehicle type</span>
              <select value={draft.tractorModel} onChange={(event) => setDraft((current) => ({ ...current, tractorModel: event.target.value }))}>
                {garageVehicleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <ColorPresetRow
              label="Primary color"
              value={draft.iconColor}
              presets={primaryColorPresets}
              onChange={(value) => setDraft((current) => ({ ...current, iconColor: value }))}
            />
            <ColorPresetRow
              label="Secondary color"
              value={draft.iconSecondaryColor}
              presets={secondaryColorPresets}
              onChange={(value) => setDraft((current) => ({ ...current, iconSecondaryColor: value }))}
            />
          </div>
          <div className="button-row">
            <button type="button" className="primary-button" disabled={saving} onClick={() => void saveProfile()}>
              {saving ? "Saving..." : "Save"}
            </button>
            {editingId != null && (
              <>
                <button type="button" className="secondary-button" disabled={saving} onClick={resetGarageForm}>Cancel</button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={saving}
                  onClick={() => {
                    if (editingProfile) void deleteProfile(editingProfile);
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="task-flow-step-header">
        <strong>Saved vehicles</strong>
        <span className="small-chip">{savedProfiles.length}</span>
      </div>
      <MobileListLimiter itemCount={savedProfiles.length} itemLabel="saved vehicles" forceExpanded={editingId != null}>
        <div className="garage-grid">
          {savedProfiles.length === 0 && (
            <p className="muted">No saved vehicles were returned for this farm.</p>
          )}
          {savedProfiles.map((profile) => (
            <div key={profile.id} className="garage-tile">
              <div className="garage-tile-preview">
                <GaragePreview profile={profile} scale={0.68} spinning={false} />
              </div>
              <strong>{profile.name}</strong>
              <span className="table-subtle">{garageOptionForModel(profile.tractorModel).label}</span>
              <button type="button" className="secondary-button compact-button" disabled={saving} onClick={() => editProfile(profile)}>Edit</button>
            </div>
          ))}
        </div>
      </MobileListLimiter>
    </div>
  );
}
