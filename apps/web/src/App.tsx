/**
 * Main React application for the Loam Ledger prototype.
 *
 * This file currently owns screen routing, map interaction, planning forms,
 * task-flow editing, settings, and many small UI panels. It is
 * large because the prototype has been built quickly in one place. Good future
 * extraction targets are the map sidebar cards, planting forms, task-flow
 * editor, settings panels, and reusable date/unit controls.
 */
import { CSSProperties, FormEvent, Fragment, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { divIcon, LatLngTuple } from "leaflet";
import { AttributionControl, Circle, CircleMarker, MapContainer, Marker, Polygon, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import { api } from "./api";
import { roleLabel } from "./account-utils";
import { buildBedAllocationPreview, estimatePlantCountFromPlan } from "./bed-allocation";
import { AdminPanel } from "./components/AdminPanel";
import { LoginScreen } from "./components/LoginScreen";
import { PlacementForm, PlantingForm, PlantingMapPreviewItem, PlantingTutorialDraft } from "./components/PlantingForms";
import { SeedBankCard } from "./components/SeedBankCard";
import { SpreadsheetImportCard } from "./components/SpreadsheetImportCard";
import { TaskFlowEditorCard } from "./components/TaskFlowEditorCard";
import { TaskIconMark } from "./components/TaskIconMark";
import { TeamAccountsCard } from "./components/TeamAccountsCard";
import { formatDate } from "./display-utils";
import { basemaps } from "./map-config";
import { geoJsonPolygonToLatLngs, midpoint, polygonAreaSqM, taskMapIcon, vertexIcon } from "./map-utils";
import { getCachedSpriteSheetUrl, preloadSpriteSheets, spriteSheetRequestForTask, subscribeSpriteSheetCache } from "./sprite-sheet-cache";
import { Bed, Block, BlockZone, DashboardData, FarmAccount, FarmEvent, FeedbackReport, Field, Placement, PlannedUse, Planting, SeedItem, SessionInfo, Task, TaskFlowEdge, TaskFlowNode, TaskFlowTemplate, TractorProfile, UndoSnapshotSummary, ZoneActualState } from "./types";
import { useUsageTracking } from "./usage-tracking";

type View = "map" | "plan" | "planting" | "tasks" | "flows" | "seed-bank" | "record" | "harvests" | "settings" | "admin";

// MapMode describes what mouse clicks on the map mean right now.
type MapMode = "select" | "draw_field" | "draw_block" | "draw_zone" | "draw_zone_split" | "bed_tools" | "draw_bed_line" | "pick_bed_edge" | "edit";
type MapWorkflowMode = "planning" | "field_work";
type BedLineSource = "manual" | "selected_bed";
type BedMakingRecordRow = { key: string; count: string; presetId: string };

function isPointSelectionMapMode(mode: MapMode) {
  return [
    "draw_field",
    "draw_block",
    "draw_zone",
    "draw_zone_split",
    "draw_bed_line",
    "pick_bed_edge"
  ].includes(mode);
}
type DistanceUnit = "m" | "ft";
type ThemeMode = "light" | "dark";
type ZoneDraftMethod = "whole_block" | "split_line" | "polygon" | null;
type MapSelection =
  | { type: "field"; id: number }
  | { type: "block"; id: number }
  | { type: "zone"; id: number }
  | { type: "bed"; id: number }
  | null;

// Draft coordinates are temporary points drawn before the user saves geometry.
type CoordinateDraft = {
  lat: number;
  lng: number;
};
type BedTravelPath = {
  bearing: number;
  lengthM: number;
};
type MapTaskMarker = {
  key: string;
  task: Task;
  bed: Bed;
  center: CoordinateDraft;
  bearing: number;
  runDistancePx: number;
  runDurationSec: number;
  animationDelaySec: number;
};
type PlantingMapLabel = {
  key: string;
  plantingId: number;
  bedId: number;
  label: string;
  center: CoordinateDraft;
  bearing: number;
  lengthM: number;
  tone: "planned" | "actual";
  color: string;
  order: number;
};
type PlantingMapColor = {
  hue: number;
  stroke: string;
  fill: string;
  label: string;
};

type SaveResponse = {
  id?: number;
  warning?: string;
};

type ActivityEntry = {
  at: string;
  view: View;
  action: string;
  details?: Record<string, unknown>;
};

type BedAllocationPreview = {
  bedId: number;
  startLengthM: number;
  bedLengthUsedM: number;
  plantCount: number;
  label: string;
};

type UserLocation = {
  lat: number;
  lng: number;
  accuracyM: number | null;
};

const emptyDashboard: DashboardData = {
  farm: null,
  fields: [],
  blocks: [],
  blockZones: [],
  beds: [],
  bedPresets: [],
  coverCropNames: [],
  seedItems: [],
  crops: [],
  varieties: [],
  taskFlowTemplates: [],
  taskFlowNodes: [],
  taskFlowEdges: [],
  tractorProfiles: [],
  plantings: [],
  placements: [],
  placementGaps: [],
  placementOverflows: [],
  events: [],
  tasks: [],
  harvests: []
};

// Local storage keeps lightweight UI preferences on this browser only.
const VIEW_STORAGE_KEY = "loam-ledger-map-view";
const SETTINGS_STORAGE_KEY = "loam-ledger-settings";
const MAP_LAYER_STORAGE_PREFIX = "loam-ledger-map-layers";
const MOBILE_MEDIA_QUERY = "(max-width: 760px)";
const PROTOTYPE_WARNING_VERSION = "v2";
const PROTOTYPE_WARNING_STORAGE_PREFIX = "loam-ledger-prototype-warning";
const TUTORIAL_DISMISSED_STORAGE_PREFIX = "loam-ledger-tutorial-dismissed";

// Default center is only a starting point; saved farm geometry can fit/zoom the map later.
const DEFAULT_CENTER: LatLngTuple = [40.0448, -76.2662];
const DEFAULT_ZOOM = 18;
const EARTH_RADIUS_M = 6378137;
const MAX_WEB_MERCATOR_LATITUDE = 85.05112878;
const WEB_MERCATOR_EQUATOR_METERS_PER_PIXEL = 156543.03392;
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

const plantingStatuses = [
  "planned",
  "seeded_in_tray",
  "direct_seeded",
  "germinating",
  "ready_to_transplant",
  "transplanted",
  "growing",
  "harvested",
  "finished"
];

const futureUseOptions: Array<Exclude<PlannedUse, null>> = ["beds", "cover_crop"];
const zoneActualStateOptions: ZoneActualState[] = [
  "needs_cleanup",
  "needs_amendment",
  "needs_tillage",
  "ready_for_bed_making",
  "beds_made",
  "partially_planted",
  "fully_planted",
  "cover_crop_established",
  "finished"
];
const garageVehicleOptions = [
  { value: "cab", label: "Cab tractor", previewTaskType: "bed_prep" },
  { value: "canopy", label: "Canopy tractor", previewTaskType: "cultivate" },
  { value: "open", label: "Open tractor", previewTaskType: "mow" },
  { value: "van", label: "Van", previewTaskType: "transplant" },
  { value: "pickup", label: "Pickup", previewTaskType: "seed_in_tray" },
  { value: "box", label: "Box truck", previewTaskType: "harvest" }
];

const primaryColorPresets = [
  { name: "Field green", value: "#3f8f45" },
  { name: "Harvester red", value: "#b7322c" },
  { name: "Utility orange", value: "#d9802e" },
  { name: "Construction yellow", value: "#e2b83f" },
  { name: "Deep blue", value: "#2f5f9f" },
  { name: "Fleet white", value: "#ffffff" },
  { name: "Truck silver", value: "#b9c0c4" },
  { name: "Service black", value: "#2b2f32" }
];

const secondaryColorPresets = [
  { name: "Warm cream", value: "#f2d6aa" },
  { name: "Wheel yellow", value: "#d6a84a" },
  { name: "Cab white", value: "#ffffff" },
  { name: "Charcoal", value: "#303334" },
  { name: "Chrome gray", value: "#aeb7bc" },
  { name: "Safety amber", value: "#e4a11b" }
];

function garageOptionForModel(model: string) {
  return garageVehicleOptions.find((option) => option.value === model) ?? garageVehicleOptions[0];
}

function emptyGarageDraft() {
  return {
    name: "",
    tractorModel: "cab",
    iconColor: "#b7322c",
    iconSecondaryColor: "#f2d6aa"
  };
}

const defaultEntranceTractorProfile: TractorProfile = {
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
  presets: Array<{ name: string; value: string }>;
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

function GarageCard({
  tractorProfiles,
  onChanged
}: {
  tractorProfiles: TractorProfile[];
  onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(emptyGarageDraft);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const previewProfile = {
    tractorModel: draft.tractorModel,
    iconColor: draft.iconColor,
    iconSecondaryColor: draft.iconSecondaryColor
  };

  function editProfile(profile: TractorProfile) {
    setEditingId(profile.id);
    setDraft({
      name: profile.name,
      tractorModel: profile.tractorModel,
      iconColor: profile.iconColor,
      iconSecondaryColor: profile.iconSecondaryColor
    });
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
        await api.createTractorProfile(payload);
      } else {
        await api.updateTractorProfile(editingId, payload);
      }
      resetGarageForm();
      setStatus("Saved.");
      await onChanged();
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
      if (editingId === profile.id) {
        resetGarageForm();
      }
      setStatus("Deleted.");
      await onChanged();
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
                    const profile = tractorProfiles.find((item) => item.id === editingId);
                    if (profile) void deleteProfile(profile);
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="garage-grid">
        {tractorProfiles.map((profile) => (
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
    </div>
  );
}

// Formatting and unit helpers keep the rest of the UI from worrying about
// whether the user prefers metric or feet/inches.
function dateInputValue(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  return value.includes("T") ? value.split("T")[0] : value;
}

function toNumericValue(value: number | string | null | undefined) {
  if (value == null) {
    return null;
  }

  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatLength(valueM: number | string | null, unit: DistanceUnit) {
  const numericValue = toNumericValue(valueM);
  if (numericValue == null) {
    return "—";
  }

  if (unit === "ft") {
    return `${(numericValue * 3.28084).toFixed(1)} ft`;
  }

  return `${numericValue.toFixed(1)} m`;
}

function formatLengthInputValue(valueM: number | string | null, unit: DistanceUnit) {
  const numericValue = toNumericValue(valueM);
  if (numericValue == null) {
    return "";
  }

  if (unit === "ft") {
    return (numericValue * 3.28084).toFixed(2);
  }

  return numericValue.toFixed(2);
}

function parseLengthInputValue(value: FormDataEntryValue | null, unit: DistanceUnit) {
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

function formatDisplayArea(valueSqM: number | string | null | undefined, unit: DistanceUnit) {
  const numericValue = toNumericValue(valueSqM);
  if (numericValue == null || numericValue <= 0) {
    return "—";
  }

  const acres = numericValue / 4046.8564224;
  if (acres >= 0.125) {
    return `${acres.toFixed(acres >= 10 ? 1 : 2)} ac`;
  }

  if (unit === "ft") {
    return `${Math.round(numericValue * 10.7639).toLocaleString()} sq ft`;
  }

  return `${Math.round(numericValue).toLocaleString()} sq m`;
}

function formatDecimalInputValue(value: number) {
  if (!Number.isFinite(value)) {
    return "";
  }
  const fixed = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return fixed.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

function formatSpacing(value: string | null, unit: DistanceUnit) {
  if (!value) {
    return "—";
  }

  if (unit === "m") {
    return value;
  }

  return value
    .replace(/(\d+(?:\.\d+)?)\s*cm\b/gi, (_match, amount) => `${(Number(amount) / 2.54).toFixed(1)} in`)
    .replace(/(\d+(?:\.\d+)?)\s*m\b/gi, (_match, amount) => `${(Number(amount) * 3.28084).toFixed(1)} ft`);
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

// Week helpers power the map/task week controls.
function addDaysToDate(value: string, days: number) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function startOfWeekDate(value: string) {
  const date = new Date(`${value}T12:00:00`);
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + mondayOffset);
  return date.toISOString().slice(0, 10);
}

function formatWeekRange(startDate: string) {
  return `${startDate} to ${addDaysToDate(startDate, 6)}`;
}

function formatTaskWeekTitle(weekStart: string) {
  const currentWeekStart = startOfWeekDate(todayDateInputValue());
  const daysFromCurrentWeek = dateDiffDays(currentWeekStart, weekStart) ?? 0;
  const weeksFromCurrentWeek = Math.round(daysFromCurrentWeek / 7);
  if (weeksFromCurrentWeek === 0) return "Tasks this week";
  if (weeksFromCurrentWeek === -1) return "Tasks last week";
  if (weeksFromCurrentWeek === 1) return "Tasks next week";
  if (weeksFromCurrentWeek < 0) return `Tasks ${Math.abs(weeksFromCurrentWeek)} weeks ago`;
  return `Tasks in ${weeksFromCurrentWeek} weeks`;
}

function formatDateForInputHint(value: string | null) {
  if (!value) {
    return "the scheduled date";
  }

  const [year, month, day] = value.split("-");
  if (!year || !month || !day) {
    return value;
  }
  return `${month}/${day}/${year}`;
}

function isDateInWeek(value: string | null, weekStart: string) {
  if (!value) {
    return false;
  }
  const weekEnd = addDaysToDate(weekStart, 6);
  return value >= weekStart && value <= weekEnd;
}

function defaultTaskRecordDate(task: Pick<Task, "scheduledDate">) {
  const today = todayDateInputValue();
  if (!task.scheduledDate) {
    return today;
  }

  const scheduled = new Date(`${task.scheduledDate}T12:00:00`).getTime();
  const current = new Date(`${today}T12:00:00`).getTime();
  const daysAway = Math.round((scheduled - current) / 86400000);
  return Math.abs(daysAway) <= 28 ? today : task.scheduledDate;
}

function isPlantingActionTask(taskType: string) {
  return taskType === "seed_in_tray" || taskType === "direct_seed" || taskType === "transplant";
}

function taskNeedsRecordForm(taskType: string) {
  return ["seed_in_tray", "direct_seed", "bed_prep", "bed_making", "transplant", "harvest", "finish_crop"].includes(taskType);
}

function dateDiffDays(startDate: string | null | undefined, endDate: string | null | undefined) {
  if (!startDate || !endDate) {
    return null;
  }

  const start = new Date(`${startDate.slice(0, 10)}T12:00:00Z`).getTime();
  const end = new Date(`${endDate.slice(0, 10)}T12:00:00Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }

  return Math.round((end - start) / 86400000);
}

function polygonCenter(points: CoordinateDraft[]) {
  if (points.length === 0) {
    return null;
  }

  const total = points.reduce((sum, point) => ({
    lat: sum.lat + point.lat,
    lng: sum.lng + point.lng
  }), { lat: 0, lng: 0 });

  return {
    lat: total.lat / points.length,
    lng: total.lng / points.length
  };
}

function readSettings(): { distanceUnit: DistanceUnit; themeMode: ThemeMode } {
  if (typeof window === "undefined") {
    return { distanceUnit: "m", themeMode: "light" };
  }

  const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!raw) {
    return { distanceUnit: "m", themeMode: "light" };
  }

  try {
    const parsed = JSON.parse(raw) as { distanceUnit?: DistanceUnit; themeMode?: ThemeMode };
    return {
      distanceUnit: parsed.distanceUnit === "ft" ? "ft" : "m",
      themeMode: parsed.themeMode === "dark" ? "dark" : "light"
    };
  } catch {
    return { distanceUnit: "m", themeMode: "light" };
  }
}

function prototypeWarningStorageKey(userId: number) {
  return `${PROTOTYPE_WARNING_STORAGE_PREFIX}:${PROTOTYPE_WARNING_VERSION}:user-${userId}`;
}

function tutorialDismissedStorageKey(userId: number) {
  return `${TUTORIAL_DISMISSED_STORAGE_PREFIX}:user-${userId}`;
}

type MapLayerSettings = {
  planned: boolean;
  actual: boolean;
  tasks: boolean;
  otherFarms: boolean;
};

function mapLayerStorageKey(userId: number) {
  return `${MAP_LAYER_STORAGE_PREFIX}:user-${userId}`;
}

function defaultMapLayerSettings(): MapLayerSettings {
  return { planned: true, actual: true, tasks: true, otherFarms: true };
}

function readMapLayerSettings(userId: number | null | undefined) {
  if (typeof window === "undefined" || userId == null) {
    return defaultMapLayerSettings();
  }

  const raw = window.localStorage.getItem(mapLayerStorageKey(userId));
  if (!raw) {
    return defaultMapLayerSettings();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<MapLayerSettings>;
    return {
      planned: parsed.planned !== false,
      actual: parsed.actual !== false,
      tasks: parsed.tasks !== false,
      otherFarms: parsed.otherFarms !== false
    };
  } catch {
    return defaultMapLayerSettings();
  }
}

// Map geometry helpers. These bridge Leaflet lat/lng data with simple projected
// meter math used for bed previews and edge picking.
function polygonPositions(points: CoordinateDraft[]) {
  return points.map((point) => [point.lat, point.lng] as LatLngTuple);
}

function plantingPlacementCount(placements: Placement[], plantingId: number) {
  return placements
    .filter((placement) => placement.plantingId === plantingId)
    .reduce((sum, placement) => sum + (placement.plantCount ?? 0), 0);
}

function bedSectionBoundary(bed: Bed, startM: number, lengthM: number, reverseFromEnd = false): Bed["boundary"] | null {
  const boundary = geoJsonPolygonToLatLngs(bed.boundary);
  if (boundary.length < 3 || lengthM <= 0) {
    return null;
  }

  const projected = boundary.map(projectForEdgePicking);
  let longestEdge = { start: projected[0], end: projected[1], length: 0 };
  for (let index = 0; index < projected.length; index += 1) {
    const start = projected[index];
    const end = projected[(index + 1) % projected.length];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length > longestEdge.length) {
      longestEdge = { start, end, length };
    }
  }

  if (longestEdge.length === 0) {
    return null;
  }

  const bedLengthM = Number(bed.bedLengthM);
  const projectedMetersPerBedMeter =
    Number.isFinite(bedLengthM) && bedLengthM > 0
      ? Math.max(0.2, Math.min(5, longestEdge.length / bedLengthM))
      : 1;
  const projectedStartM = Math.max(0, startM) * projectedMetersPerBedMeter;
  const projectedLengthM = Math.max(0, lengthM) * projectedMetersPerBedMeter;
  const along = {
    x: (longestEdge.end.x - longestEdge.start.x) / longestEdge.length,
    y: (longestEdge.end.y - longestEdge.start.y) / longestEdge.length
  };
  const across = { x: -along.y, y: along.x };
  const projectedLocal = projected.map((point) => ({
    along: point.x * along.x + point.y * along.y,
    across: point.x * across.x + point.y * across.y
  }));
  const minAlong = Math.min(...projectedLocal.map((point) => point.along));
  const maxAlong = Math.max(...projectedLocal.map((point) => point.along));
  const minAcross = Math.min(...projectedLocal.map((point) => point.across));
  const maxAcross = Math.max(...projectedLocal.map((point) => point.across));
  const boundedStartM = reverseFromEnd
    ? Math.max(0, longestEdge.length - projectedStartM - projectedLengthM)
    : projectedStartM;
  const sectionStart = Math.min(maxAlong, minAlong + boundedStartM);
  const sectionEnd = Math.min(maxAlong, sectionStart + projectedLengthM);
  if (sectionEnd <= sectionStart) {
    return null;
  }

  const toWorld = (alongPosition: number, acrossPosition: number) => unprojectFromWebMercator({
    x: along.x * alongPosition + across.x * acrossPosition,
    y: along.y * alongPosition + across.y * acrossPosition
  });
  const corners = [
    toWorld(sectionStart, minAcross),
    toWorld(sectionEnd, minAcross),
    toWorld(sectionEnd, maxAcross),
    toWorld(sectionStart, maxAcross)
  ];

  return {
    type: "Polygon",
    coordinates: [[...corners.map((point) => [point.lng, point.lat]), [corners[0].lng, corners[0].lat]]]
  };
}

function bedTravelPath(bed: Bed): BedTravelPath {
  const boundary = geoJsonPolygonToLatLngs(bed.boundary);
  if (boundary.length < 2) {
    return { bearing: 0, lengthM: Number.isFinite(bed.bedLengthM) ? Math.max(0, bed.bedLengthM) : 0 };
  }

  const projected = boundary.map(projectForEdgePicking);
  let longestEdge = { start: projected[0], end: projected[1], length: 0 };
  for (let index = 0; index < projected.length; index += 1) {
    const start = projected[index];
    const end = projected[(index + 1) % projected.length];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length > longestEdge.length) {
      longestEdge = { start, end, length };
    }
  }

  if (longestEdge.length === 0) {
    return { bearing: 0, lengthM: Number.isFinite(bed.bedLengthM) ? Math.max(0, bed.bedLengthM) : 0 };
  }

  // CSS rotation uses the horizontal screen axis. Web Mercator y points north,
  // so invert dy to make the tractor move along the bed visually on the map.
  return {
    bearing: Math.atan2(-(longestEdge.end.y - longestEdge.start.y), longestEdge.end.x - longestEdge.start.x) * 180 / Math.PI,
    lengthM: longestEdge.length
  };
}

function firstBedEntrancePose(bed: Bed, entranceSide: "start" | "end") {
  const boundary = geoJsonPolygonToLatLngs(bed.boundary);
  if (boundary.length < 3) {
    return null;
  }

  const projected = boundary.map(projectForEdgePicking);
  let longestEdge = { start: projected[0], end: projected[1], length: 0 };
  for (let index = 0; index < projected.length; index += 1) {
    const start = projected[index];
    const end = projected[(index + 1) % projected.length];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length > longestEdge.length) {
      longestEdge = { start, end, length };
    }
  }

  if (longestEdge.length === 0) {
    return null;
  }

  const along = {
    x: (longestEdge.end.x - longestEdge.start.x) / longestEdge.length,
    y: (longestEdge.end.y - longestEdge.start.y) / longestEdge.length
  };
  const across = { x: -along.y, y: along.x };
  const projectedLocal = projected.map((point) => ({
    along: point.x * along.x + point.y * along.y,
    across: point.x * across.x + point.y * across.y
  }));
  const minAlong = Math.min(...projectedLocal.map((point) => point.along));
  const maxAlong = Math.max(...projectedLocal.map((point) => point.along));
  const minAcross = Math.min(...projectedLocal.map((point) => point.across));
  const maxAcross = Math.max(...projectedLocal.map((point) => point.across));
  const entranceAlong = entranceSide === "end" ? maxAlong : minAlong;
  const entranceAcross = (minAcross + maxAcross) / 2;
  const center = unprojectFromWebMercator({
    x: along.x * entranceAlong + across.x * entranceAcross,
    y: along.y * entranceAlong + across.y * entranceAcross
  });
  const baseBearing = Math.atan2(-(longestEdge.end.y - longestEdge.start.y), longestEdge.end.x - longestEdge.start.x) * 180 / Math.PI;
  return {
    center,
    bearing: entranceSide === "end" ? baseBearing : baseBearing + 180
  };
}

function bedSerpentineReversesFromEnd(bed: Bed, block: Block | null, blockBeds: Bed[]) {
  const orderedBeds = blockBeds
    .filter((item) => item.blockId === bed.blockId && item.source !== "road")
    .sort((left, right) => (left.sequenceNo ?? left.id) - (right.sequenceNo ?? right.id));
  const index = orderedBeds.findIndex((item) => item.id === bed.id);
  const zeroBasedIndex = index >= 0 ? index : 0;
  const firstBedStartsAtEnd = block?.bedStartEntranceSide === "end";
  return firstBedStartsAtEnd ? zeroBasedIndex % 2 === 0 : zeroBasedIndex % 2 === 1;
}

function bedRunDistancePx(path: BedTravelPath, center: CoordinateDraft, zoom: number) {
  const metersPerPixel = WEB_MERCATOR_EQUATOR_METERS_PER_PIXEL * Math.cos(center.lat * Math.PI / 180) / (2 ** zoom);
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0 || !Number.isFinite(path.lengthM) || path.lengthM <= 0) {
    return 44;
  }

  return Math.max(36, Math.min(360, Math.round((path.lengthM / metersPerPixel) / 2)));
}

function bedSharedVehicleTiming(index: number, count: number) {
  if (count <= 1) {
    return { runDurationSec: 9.5, animationDelaySec: 0 };
  }

  const runDurationSec = 8.8 + (index % 5) * 0.85;
  return {
    runDurationSec,
    animationDelaySec: -((index / count) * runDurationSec)
  };
}

function projectForEdgePicking(point: CoordinateDraft) {
  const x = (point.lng * Math.PI * EARTH_RADIUS_M) / 180;
  const latRadians = (point.lat * Math.PI) / 180;
  const y = EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + latRadians / 2));
  return { x, y };
}

function unprojectFromWebMercator(point: { x: number; y: number }): CoordinateDraft {
  const lng = (point.x / EARTH_RADIUS_M) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(point.y / EARTH_RADIUS_M)) - Math.PI / 2) * (180 / Math.PI);
  return { lat, lng };
}

function webMercatorScaleFactorForLatitude(lat: number) {
  const clampedLat = Math.max(-MAX_WEB_MERCATOR_LATITUDE, Math.min(MAX_WEB_MERCATOR_LATITUDE, lat));
  const cosine = Math.cos((clampedLat * Math.PI) / 180);
  return 1 / Math.max(0.01, Math.abs(cosine));
}

function webMercatorMetersForGroundMeters(meters: number, referenceLat: number) {
  return meters * webMercatorScaleFactorForLatitude(referenceLat);
}

function buildNextBedPreview(
  linePoints: CoordinateDraft[],
  bedWidthM: number,
  pathSpacingM: number,
  nextBedIndex: number,
  edgeOffsetM: number,
  invertSide: boolean,
  harvestRoadEveryBeds: number | null,
  harvestRoadWidthBeds: number
) {
  if (linePoints.length < 2 || bedWidthM <= 0 || pathSpacingM < 0) {
    return [] as CoordinateDraft[];
  }

  const projectedLine = linePoints.map(projectForEdgePicking);
  const start = projectedLine[0];
  const end = projectedLine[projectedLine.length - 1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return [] as CoordinateDraft[];
  }

  const unit = { x: dx / length, y: dy / length };
  const sideSign = invertSide ? -1 : 1;
  const normal = { x: -unit.y * sideSign, y: unit.x * sideSign };
  const referenceLatitude = linePoints.reduce((sum, point) => sum + point.lat, 0) / linePoints.length;
  const bedWidthProjectedM = webMercatorMetersForGroundMeters(bedWidthM, referenceLatitude);
  const pathSpacingProjectedM = webMercatorMetersForGroundMeters(pathSpacingM, referenceLatitude);
  const edgeOffsetProjectedM = webMercatorMetersForGroundMeters(edgeOffsetM, referenceLatitude);
  const pitch = bedWidthProjectedM + pathSpacingProjectedM;
  const skippedBedSlots = harvestRoadEveryBeds && harvestRoadWidthBeds > 0
    ? Math.floor(nextBedIndex / harvestRoadEveryBeds) * harvestRoadWidthBeds
    : 0;
  const layoutIndex = nextBedIndex + skippedBedSlots;
  const innerOffset = edgeOffsetProjectedM + layoutIndex * pitch;
  const outerOffset = innerOffset + bedWidthProjectedM;

  const innerEdge = projectedLine.map((point) => ({
    x: point.x + normal.x * innerOffset,
    y: point.y + normal.y * innerOffset
  }));
  const outerEdge = projectedLine.map((point) => ({
    x: point.x + normal.x * outerOffset,
    y: point.y + normal.y * outerOffset
  }));

  return [...innerEdge, ...outerEdge.reverse()].map(unprojectFromWebMercator);
}

function pointToSegmentDistance(point: CoordinateDraft, start: CoordinateDraft, end: CoordinateDraft) {
  const projectedPoint = projectForEdgePicking(point);
  const projectedStart = projectForEdgePicking(start);
  const projectedEnd = projectForEdgePicking(end);
  const dx = projectedEnd.x - projectedStart.x;
  const dy = projectedEnd.y - projectedStart.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(projectedPoint.x - projectedStart.x, projectedPoint.y - projectedStart.y);
  }

  const t = Math.max(0, Math.min(1, ((projectedPoint.x - projectedStart.x) * dx + (projectedPoint.y - projectedStart.y) * dy) / lengthSq));
  const closest = { x: projectedStart.x + t * dx, y: projectedStart.y + t * dy };
  return Math.hypot(projectedPoint.x - closest.x, projectedPoint.y - closest.y);
}

function pointIsInsideOrOnPolygon(point: CoordinateDraft, polygon: CoordinateDraft[]) {
  if (polygon.length < 3) {
    return false;
  }

  const isOnBoundary = polygon.some((start, index) => {
    const end = polygon[(index + 1) % polygon.length];
    return pointToSegmentDistance(point, start, end) <= 0.25;
  });
  if (isOnBoundary) {
    return true;
  }

  let inside = false;
  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index, index += 1) {
    const current = polygon[index];
    const previous = polygon[previousIndex];
    const crossesRay = (current.lat > point.lat) !== (previous.lat > point.lat);
    if (!crossesRay) {
      continue;
    }

    const crossingLng = ((previous.lng - current.lng) * (point.lat - current.lat)) / (previous.lat - current.lat) + current.lng;
    if (point.lng < crossingLng) {
      inside = !inside;
    }
  }

  return inside;
}

function projectedCrossProduct(
  first: ReturnType<typeof projectForEdgePicking>,
  second: ReturnType<typeof projectForEdgePicking>,
  third: ReturnType<typeof projectForEdgePicking>
) {
  return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
}

function projectedSegmentsProperlyIntersect(
  firstStart: CoordinateDraft,
  firstEnd: CoordinateDraft,
  secondStart: CoordinateDraft,
  secondEnd: CoordinateDraft
) {
  const a = projectForEdgePicking(firstStart);
  const b = projectForEdgePicking(firstEnd);
  const c = projectForEdgePicking(secondStart);
  const d = projectForEdgePicking(secondEnd);
  const firstSideA = projectedCrossProduct(a, b, c);
  const firstSideB = projectedCrossProduct(a, b, d);
  const secondSideA = projectedCrossProduct(c, d, a);
  const secondSideB = projectedCrossProduct(c, d, b);
  const epsilon = 0.000001;

  return (
    firstSideA * firstSideB < -epsilon &&
    secondSideA * secondSideB < -epsilon
  );
}

function polygonEdgesCrossBoundary(points: CoordinateDraft[], boundary: CoordinateDraft[]) {
  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const pointStart = points[pointIndex];
    const pointEnd = points[(pointIndex + 1) % points.length];
    for (let boundaryIndex = 0; boundaryIndex < boundary.length; boundaryIndex += 1) {
      const boundaryStart = boundary[boundaryIndex];
      const boundaryEnd = boundary[(boundaryIndex + 1) % boundary.length];
      if (projectedSegmentsProperlyIntersect(pointStart, pointEnd, boundaryStart, boundaryEnd)) {
        return true;
      }
    }
  }

  return false;
}

function polygonIsInsideOrOnPolygon(points: CoordinateDraft[], boundary: CoordinateDraft[]) {
  return (
    points.length >= 3 &&
    boundary.length >= 3 &&
    points.every((point) => pointIsInsideOrOnPolygon(point, boundary)) &&
    !polygonEdgesCrossBoundary(points, boundary)
  );
}

function sideOfLine(linePoints: CoordinateDraft[], point: CoordinateDraft) {
  if (linePoints.length < 2) {
    return 0;
  }

  const start = projectForEdgePicking(linePoints[0]);
  const end = projectForEdgePicking(linePoints[linePoints.length - 1]);
  const target = projectForEdgePicking(point);
  return (end.x - start.x) * (target.y - start.y) - (end.y - start.y) * (target.x - start.x);
}

function orientLineLeftTowardPoint(linePoints: CoordinateDraft[], point: CoordinateDraft | null) {
  if (!point || linePoints.length < 2) {
    return linePoints;
  }

  return sideOfLine(linePoints, point) < 0 ? [...linePoints].reverse() : linePoints;
}

function orientLineLeftAwayFromPoint(linePoints: CoordinateDraft[], point: CoordinateDraft | null) {
  if (!point || linePoints.length < 2) {
    return linePoints;
  }

  return sideOfLine(linePoints, point) > 0 ? [...linePoints].reverse() : linePoints;
}

function boundaryEdgeLines(boundary: CoordinateDraft[]) {
  if (boundary.length < 3) {
    return [] as CoordinateDraft[][];
  }

  return boundary.map((point, index) => [point, boundary[(index + 1) % boundary.length]]);
}

function selectedBedGuideLine(bed: Bed | null, block: Block | null) {
  const bedBoundary = geoJsonPolygonToLatLngs(bed?.boundary ?? null);
  const blockCenter = polygonCenter(geoJsonPolygonToLatLngs(block?.boundary ?? null));
  const bedCenter = polygonCenter(bedBoundary);
  if (bedBoundary.length < 3) {
    return [] as CoordinateDraft[];
  }

  const projectedCenter = blockCenter ? projectForEdgePicking(blockCenter) : null;
  const edges = bedBoundary.map((start, index) => {
    const end = bedBoundary[(index + 1) % bedBoundary.length];
    const projectedStart = projectForEdgePicking(start);
    const projectedEnd = projectForEdgePicking(end);
    const midpointProjected = {
      x: (projectedStart.x + projectedEnd.x) / 2,
      y: (projectedStart.y + projectedEnd.y) / 2
    };
    return {
      start,
      end,
      length: Math.hypot(projectedEnd.x - projectedStart.x, projectedEnd.y - projectedStart.y),
      centerDistance: projectedCenter
        ? Math.hypot(midpointProjected.x - projectedCenter.x, midpointProjected.y - projectedCenter.y)
        : 0
    };
  });

  const longestLength = Math.max(...edges.map((edge) => edge.length));
  const longEdges = edges.filter((edge) => edge.length >= longestLength * 0.8);
  const guideEdge = longEdges.sort((left, right) => left.centerDistance - right.centerDistance)[0] ?? edges[0];
  return guideEdge ? orientLineLeftAwayFromPoint([guideEdge.start, guideEdge.end], bedCenter) : [];
}

function sortedPlantableBlockBeds(beds: Bed[]) {
  return beds
    .filter((bed) => bed.source !== "road")
    .sort((left, right) => (left.sequenceNo ?? left.id) - (right.sequenceNo ?? right.id));
}

function longestBoundaryEdgeLine(boundary: CoordinateDraft[]) {
  if (boundary.length < 2) {
    return [] as CoordinateDraft[];
  }

  return boundary
    .map((start, index) => {
      const end = boundary[(index + 1) % boundary.length];
      const projectedStart = projectForEdgePicking(start);
      const projectedEnd = projectForEdgePicking(end);
      return {
        line: [start, end] as CoordinateDraft[],
        length: Math.hypot(projectedEnd.x - projectedStart.x, projectedEnd.y - projectedStart.y)
      };
    })
    .sort((left, right) => right.length - left.length)[0]?.line ?? [];
}

function splitGuideLineForBlock(block: Block | null, beds: Bed[]) {
  const firstBed = sortedPlantableBlockBeds(beds)[0] ?? null;
  const bedGuide = selectedBedGuideLine(firstBed, block);
  if (bedGuide.length >= 2) {
    return bedGuide;
  }

  return longestBoundaryEdgeLine(geoJsonPolygonToLatLngs(block?.boundary ?? null));
}

function firstBedSideReferencePoint(block: Block | null, beds: Bed[]) {
  const firstBed = sortedPlantableBlockBeds(beds)[0] ?? null;
  const firstBedCenter = polygonCenter(geoJsonPolygonToLatLngs(firstBed?.boundary ?? null));
  if (firstBedCenter) {
    return firstBedCenter;
  }

  const boundary = geoJsonPolygonToLatLngs(block?.boundary ?? null);
  const guideLine = splitGuideLineForBlock(block, beds);
  if (boundary.length < 3 || guideLine.length < 2) {
    return polygonCenter(boundary);
  }

  const start = projectForEdgePicking(guideLine[0]);
  const end = projectForEdgePicking(guideLine[guideLine.length - 1]);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return polygonCenter(boundary);
  }

  const along = { x: dx / length, y: dy / length };
  const across = { x: -along.y, y: along.x };
  const projected = boundary.map(projectForEdgePicking);
  const alongValues = projected.map((point) => point.x * along.x + point.y * along.y);
  const acrossValues = projected.map((point) => point.x * across.x + point.y * across.y);
  return unprojectFromWebMercator({
    x: along.x * ((Math.min(...alongValues) + Math.max(...alongValues)) / 2) + across.x * Math.min(...acrossValues),
    y: along.y * ((Math.min(...alongValues) + Math.max(...alongValues)) / 2) + across.y * Math.min(...acrossValues)
  });
}

function bedParallelSplitLineThroughPoint(anchor: CoordinateDraft, block: Block | null, beds: Bed[]) {
  const boundary = geoJsonPolygonToLatLngs(block?.boundary ?? null);
  const guideLine = splitGuideLineForBlock(block, beds);
  if (boundary.length < 3 || guideLine.length < 2) {
    return [] as CoordinateDraft[];
  }

  const start = projectForEdgePicking(guideLine[0]);
  const end = projectForEdgePicking(guideLine[guideLine.length - 1]);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return [];
  }

  const unit = { x: dx / length, y: dy / length };
  const projectedBoundary = boundary.map(projectForEdgePicking);
  const anchorPoint = projectForEdgePicking(anchor);
  const boundaryAlongValues = projectedBoundary.map((point) => point.x * unit.x + point.y * unit.y);
  const anchorAlong = anchorPoint.x * unit.x + anchorPoint.y * unit.y;
  const minAlong = Math.min(...boundaryAlongValues);
  const maxAlong = Math.max(...boundaryAlongValues);
  const padding = Math.max(25, (maxAlong - minAlong) * 0.2);

  return [
    unprojectFromWebMercator({
      x: anchorPoint.x + unit.x * (minAlong - anchorAlong - padding),
      y: anchorPoint.y + unit.y * (minAlong - anchorAlong - padding)
    }),
    unprojectFromWebMercator({
      x: anchorPoint.x + unit.x * (maxAlong - anchorAlong + padding),
      y: anchorPoint.y + unit.y * (maxAlong - anchorAlong + padding)
    })
  ];
}

function bedParallelSplitLinesForBlock(block: Block | null, beds: Bed[], anchors: CoordinateDraft[]) {
  return anchors
    .map((anchor) => bedParallelSplitLineThroughPoint(anchor, block, beds))
    .filter((line) => line.length === 2);
}

type ProjectedPoint = ReturnType<typeof projectForEdgePicking>;

function projectedLineSide(line: ProjectedPoint[], point: ProjectedPoint) {
  if (line.length < 2) {
    return 0;
  }
  const start = line[0];
  const end = line[line.length - 1];
  return (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
}

function projectedLineIntersection(
  lineStart: ProjectedPoint,
  lineEnd: ProjectedPoint,
  segmentStart: ProjectedPoint,
  segmentEnd: ProjectedPoint
) {
  const lineDx = lineEnd.x - lineStart.x;
  const lineDy = lineEnd.y - lineStart.y;
  const segmentDx = segmentEnd.x - segmentStart.x;
  const segmentDy = segmentEnd.y - segmentStart.y;
  const denominator = lineDx * segmentDy - lineDy * segmentDx;
  if (Math.abs(denominator) < 0.000001) {
    return null;
  }
  const t = ((segmentStart.x - lineStart.x) * segmentDy - (segmentStart.y - lineStart.y) * segmentDx) / denominator;
  return {
    x: lineStart.x + t * lineDx,
    y: lineStart.y + t * lineDy
  };
}

function clipProjectedPolygonToLineSide(polygon: ProjectedPoint[], line: ProjectedPoint[], keepSign: number) {
  if (polygon.length < 3 || line.length < 2 || keepSign === 0) {
    return polygon;
  }

  const output: ProjectedPoint[] = [];
  const inside = (point: ProjectedPoint) => projectedLineSide(line, point) * keepSign >= -0.000001;

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    const currentInside = inside(current);
    const previousInside = inside(previous);
    const intersection = projectedLineIntersection(line[0], line[line.length - 1], previous, current);

    if (currentInside) {
      if (!previousInside && intersection) {
        output.push(intersection);
      }
      output.push(current);
    } else if (previousInside && intersection) {
      output.push(intersection);
    }
  }

  return output;
}

function clipLineToPolygon(line: CoordinateDraft[], boundary: CoordinateDraft[]) {
  if (line.length < 2 || boundary.length < 3) {
    return line;
  }

  const projectedLine = line.map(projectForEdgePicking);
  const projectedBoundary = boundary.map(projectForEdgePicking);
  const intersections: ProjectedPoint[] = [];
  for (let index = 0; index < projectedBoundary.length; index += 1) {
    const start = projectedBoundary[index];
    const end = projectedBoundary[(index + 1) % projectedBoundary.length];
    const intersection = projectedLineIntersection(projectedLine[0], projectedLine[1], start, end);
    if (!intersection) {
      continue;
    }
    const segmentDx = end.x - start.x;
    const segmentDy = end.y - start.y;
    const segmentLengthSq = segmentDx * segmentDx + segmentDy * segmentDy;
    const segmentT = segmentLengthSq === 0 ? 0 : ((intersection.x - start.x) * segmentDx + (intersection.y - start.y) * segmentDy) / segmentLengthSq;
    if (segmentT >= -0.000001 && segmentT <= 1.000001) {
      const duplicate = intersections.some((point) => Math.hypot(point.x - intersection.x, point.y - intersection.y) < 0.01);
      if (!duplicate) {
        intersections.push(intersection);
      }
    }
  }

  if (intersections.length < 2) {
    return line;
  }

  const direction = {
    x: projectedLine[1].x - projectedLine[0].x,
    y: projectedLine[1].y - projectedLine[0].y
  };
  return intersections
    .sort((left, right) => (
      ((left.x - projectedLine[0].x) * direction.x + (left.y - projectedLine[0].y) * direction.y)
      - ((right.x - projectedLine[0].x) * direction.x + (right.y - projectedLine[0].y) * direction.y)
    ))
    .slice(0, 2)
    .map(unprojectFromWebMercator);
}

function splitAreaPreviewForBlock(
  block: Block | null,
  splitLines: CoordinateDraft[][],
  firstBedSidePoint: CoordinateDraft | null
) {
  const boundary = geoJsonPolygonToLatLngs(block?.boundary ?? null);
  if (boundary.length < 3 || splitLines.length < 1 || splitLines.length > 2 || splitLines.some((line) => line.length < 2)) {
    return [] as CoordinateDraft[];
  }

  const projectedBoundary = boundary.map(projectForEdgePicking);
  const projectedLines = splitLines.map((line) => line.map(projectForEdgePicking));
  let clippedPolygon = projectedBoundary;

  if (projectedLines.length === 1) {
    const sidePoint = firstBedSidePoint ?? polygonCenter(boundary);
    const keepSign = sidePoint ? Math.sign(projectedLineSide(projectedLines[0], projectForEdgePicking(sidePoint))) : 0;
    clippedPolygon = clipProjectedPolygonToLineSide(clippedPolygon, projectedLines[0], keepSign || 1);
  } else {
    const firstLine = projectedLines[0];
    const secondLine = projectedLines[1];
    const secondLineAnchorSide = Math.sign(projectedLineSide(firstLine, secondLine[0]));
    const firstLineAnchorSide = Math.sign(projectedLineSide(secondLine, firstLine[0]));
    clippedPolygon = clipProjectedPolygonToLineSide(clippedPolygon, firstLine, secondLineAnchorSide || 1);
    clippedPolygon = clipProjectedPolygonToLineSide(clippedPolygon, secondLine, firstLineAnchorSide || 1);
  }

  return clippedPolygon.length >= 3 ? clippedPolygon.map(unprojectFromWebMercator) : [];
}

function summarizeTitles(titles: string[]) {
  const uniqueTitles = [...new Set(titles.filter(Boolean))];
  if (uniqueTitles.length === 0) {
    return "";
  }

  if (uniqueTitles.length <= 2) {
    return uniqueTitles.join(" • ");
  }

  return `${uniqueTitles[0]} +${uniqueTitles.length - 1}`;
}

function readableMapLabelAngle(bearing: number) {
  if (!Number.isFinite(bearing)) {
    return 0;
  }
  let angle = ((bearing % 180) + 180) % 180;
  if (angle > 90) {
    angle -= 180;
  }
  return angle;
}

function plantingMapColor(index: number): PlantingMapColor {
  const hue = (136 + index * 155) % 360;
  const stroke = hslToHex(hue, 60, 24);
  const fill = hslToHex(hue, 58, 42);
  return {
    hue,
    stroke,
    fill,
    label: stroke
  };
}

function plantingMapColorForOrder(order: number | string | null | undefined) {
  const numericOrder = Number(order);
  const zeroBasedOrder = Number.isFinite(numericOrder) ? Math.max(0, Math.round(numericOrder) - 1) : 0;
  return plantingMapColor(zeroBasedOrder);
}

function colorizeBlockPlacementRows<T extends { blockId: number; placementOrder: number; color: PlantingMapColor }>(rows: T[]) {
  const rowKeysByBlock = new Map<number, Array<{ key: number; order: number }>>();
  for (const row of rows) {
    const current = rowKeysByBlock.get(row.blockId) ?? [];
    if (!current.some((item) => item.key === row.placementOrder)) {
      current.push({ key: row.placementOrder, order: row.placementOrder });
      rowKeysByBlock.set(row.blockId, current);
    }
  }

  const colorIndexByBlockRow = new Map<string, number>();
  for (const [blockId, rowKeys] of rowKeysByBlock) {
    rowKeys
      .sort((left, right) => left.order - right.order)
      .forEach((rowKey, index) => {
        colorIndexByBlockRow.set(`${blockId}:${rowKey.key}`, index);
      });
  }

  return rows.map((row) => ({
    ...row,
    color: plantingMapColor(colorIndexByBlockRow.get(`${row.blockId}:${row.placementOrder}`) ?? 0)
  }));
}

function hslToHex(hue: number, saturation: number, lightness: number) {
  const s = saturation / 100;
  const l = lightness / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hue < 60
    ? [c, x, 0]
    : hue < 120
      ? [x, c, 0]
      : hue < 180
        ? [0, c, x]
        : hue < 240
          ? [0, x, c]
          : hue < 300
            ? [x, 0, c]
            : [c, 0, x];
  return `#${[r, g, b].map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function plantingOverlayStyleForColor(color: PlantingMapColor, extraClassName?: string) {
  return {
    color: color.stroke,
    fillColor: color.fill,
    fillOpacity: 0.44,
    weight: 2,
    className: ["map-plan-path", extraClassName].filter(Boolean).join(" "),
    bubblingMouseEvents: false
  };
}

function plantingLabelIcon(label: string, bearing: number, tone: "planned" | "actual", color: string) {
  const safeLabel = label.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char] ?? char));
  return divIcon({
    className: "planting-map-label-icon",
    iconSize: [1, 1],
    html: `<span class="planting-map-label planting-map-label-${tone}" style="--label-angle: ${readableMapLabelAngle(bearing)}deg; --label-color: ${color}">${safeLabel}</span>`
  });
}

// Label and style helpers centralize map colors and human-readable task/state names.
function sentenceCase(input: string) {
  return input.replaceAll("_", " ");
}

function formatTaskTypeLabel(taskType: string) {
  const labels: Record<string, string> = {
    seed_in_tray: "seed in tray",
    direct_seed: "direct seed",
    till: "till",
    fertilizing_spraying: "fertilizing / spraying",
    bed_making: "bed making",
    transplant: "transplanting",
    cultivation: "cultivation",
    cleanup: "cleanup",
    cover_crop: "covercrop",
    bed_prep: "bed making",
    cultivate: "cultivation",
    finish_crop: "finish crop",
    irrigation_check: "irrigation check"
  };
  return labels[taskType] ?? sentenceCase(taskType);
}

function formatTaskAnchorLabel(anchor: string) {
  if (anchor.startsWith("after:")) {
    return `after ${anchor.slice("after:".length).split(",").filter(Boolean).join(", ")}`;
  }

  return sentenceCase(anchor);
}

function formatPlannedUseLabel(value: PlannedUse) {
  if (value == null) {
    return "none assigned";
  }
  return value === "cover_crop" ? "cover crop" : value.replaceAll("_", " ");
}

function formatZoneActualStateLabel(value: ZoneActualState) {
  return value.replaceAll("_", " ");
}

function mapSaveErrorMessage(error: unknown, itemLabel: string) {
  const message = error instanceof Error ? error.message : "Save failed.";
  if (message.toLowerCase().includes("polygon is not valid")) {
    return `Could not save ${itemLabel}: the outline crossed itself or has a bad shape. Click Cancel, then draw the outline again without crossing lines.`;
  }
  return `Could not save ${itemLabel}: ${message}`;
}

function taskIconColor(taskType: string) {
  if (taskType === "cultivation" || taskType === "cultivate" || taskType === "weed" || taskType === "mow") return "#d98c2b";
  if (taskType === "transplant") return "#4f9b58";
  if (taskType === "direct_seed" || taskType === "seed_in_tray") return "#7c9f35";
  if (taskType === "harvest") return "#c6503f";
  if (taskType === "bed_making" || taskType === "bed_prep" || taskType === "till") return "#8b6f43";
  if (taskType === "fertilizing_spraying") return "#5f8f4f";
  if (taskType === "cleanup" || taskType === "cover_crop") return "#6d7f45";
  return "#4f84aa";
}

function taskColor(task: Pick<Task, "taskType" | "iconColor">) {
  return task.iconColor || taskIconColor(task.taskType);
}

function latestDateIndexOnOrBefore(dates: string[], targetDate: string) {
  let index = 0;
  for (let currentIndex = 0; currentIndex < dates.length; currentIndex += 1) {
    if (dates[currentIndex] <= targetDate) {
      index = currentIndex;
    }
  }
  return index;
}

function plantingGroundStartDate(planting: Planting) {
  return planting.actualTransplantDate
    ?? planting.actualDirectSeedingDate
    ?? planting.plannedTransplantDate
    ?? planting.plannedSowDate;
}

function plantingGroundEndDate(planting: Planting) {
  return planting.actualFinishDate
    ?? planting.actualHarvestDate
    ?? planting.expectedHarvestEnd
    ?? planting.expectedHarvestStart
    ?? addDaysToDateString(plantingGroundStartDate(planting), 120);
}

function plantingPlanYear(planting: Planting) {
  const date = planting.plannedSowDate
    ?? planting.plannedTransplantDate
    ?? planting.expectedHarvestStart
    ?? planting.actualTraySeedingDate
    ?? planting.actualDirectSeedingDate
    ?? todayDateInputValue();
  return Number(date.slice(0, 4));
}

function isPlantingInGroundOnDate(planting: Planting, date: string) {
  const startDate = plantingGroundStartDate(planting);
  if (!startDate || startDate > date) {
    return false;
  }

  const endDate = plantingGroundEndDate(planting);
  return !endDate || endDate >= date;
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

function plantingCropVarietyLabel(planting: Planting) {
  if (planting.seedName) {
    return planting.seedName;
  }
  return planting.varietyName ? `${planting.cropName} / ${planting.varietyName}` : planting.cropName;
}

type PlantingReviewSeverity = "major" | "minor";

type PlantingReviewInfo = {
  severity: PlantingReviewSeverity | null;
  majorFields: Set<string>;
  minorFields: Set<string>;
  majorIssues: string[];
  minorIssues: string[];
};

type PlantingPlanningInput = "initial" | "plantCount" | "bedLengthUsed" | "trayCount" | "cellsPerTray" | "seedCellCount" | "expectedTrayPlants" | "germinationRate" | "spacing" | "rowsPerBed" | "bed";
type PlantingDateInput = "initial" | "plannedSowDate" | "plannedTransplantDate" | "daysToHarvest" | "expectedHarvestStart" | "expectedHarvestEnd";

function issueListFromNotes(notes: string | null | undefined, prefix: string) {
  const line = (notes ?? "").split(/\r?\n/).find((item) => item.startsWith(prefix));
  if (!line) {
    return [];
  }
  return line
    .slice(prefix.length)
    .replace(/\.$/, "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

function fieldsForImportIssue(issue: string) {
  const lower = issue.toLowerCase();
  if (lower.includes("plant count or bed length")) return ["plantCount", "bedLengthUsed"];
  if (lower.includes("crop")) return ["crop"];
  if (lower.includes("variety")) return ["variety"];
  if (lower.includes("start date")) return ["plannedSowDate"];
  if (lower.includes("bed length")) return ["bedLengthUsed"];
  if (lower.includes("plant count")) return ["plantCount"];
  if (lower.includes("field/block")) return ["field", "block"];
  if (lower.includes("rows per bed")) return ["rowsPerBed"];
  if (lower.includes("field spacing") || lower.includes("row spacing")) return ["spacing"];
  if (lower.includes("field")) return ["field"];
  if (lower.includes("block")) return ["block"];
  if (lower.includes("bed cover")) return ["bedCover"];
  if (lower.includes("bed")) return ["bed"];
  if (lower.includes("transplant date")) return ["plannedTransplantDate"];
  if (lower.includes("days to harvest")) return ["daysToHarvest"];
  if (lower.includes("catalog")) return ["notes"];
  return ["notes"];
}

function plantingFieldStillNeedsReview(planting: Planting, fieldName: string) {
  if (fieldName === "crop") return planting.cropName === "Needs crop";
  if (fieldName === "title") return planting.title.startsWith("Needs completion - ");
  if (fieldName === "variety") return planting.varietyName == null;
  if (fieldName === "plannedSowDate") return planting.plannedSowDate == null;
  if (fieldName === "plannedTransplantDate") return planting.plannedTransplantDate == null;
  if (fieldName === "expectedHarvestStart") return planting.expectedHarvestStart == null;
  if (fieldName === "expectedHarvestEnd") return planting.expectedHarvestEnd == null;
  if (fieldName === "plantCount") return planting.plantCount == null || planting.plantCount === 1;
  if (fieldName === "bedLengthUsed") return planting.bedLengthUsedM == null;
  if (fieldName === "field") return planting.intendedFieldId == null;
  if (fieldName === "block") return planting.intendedBlockId == null;
  if (fieldName === "bed") return planting.intendedBedId == null;
  if (fieldName === "spacing") return planting.spacing == null;
  if (fieldName === "rowsPerBed") return planting.rowsPerBed == null;
  if (fieldName === "daysToHarvest") return planting.daysToHarvest == null;
  if (fieldName === "bedCover") return planting.bedCover == null;
  return true;
}

function plantingReviewInfo(planting: Planting): PlantingReviewInfo {
  const majorIssues = issueListFromNotes(planting.notes, "Needs manual completion: ");
  const minorIssues = issueListFromNotes(planting.notes, "Optional fields to review: ");
  const majorFields = new Set<string>();
  const minorFields = new Set<string>();

  for (const issue of majorIssues) {
    fieldsForImportIssue(issue).forEach((field) => {
      if (plantingFieldStillNeedsReview(planting, field)) {
        majorFields.add(field);
      }
    });
  }
  for (const issue of minorIssues) {
    fieldsForImportIssue(issue).forEach((field) => {
      if (plantingFieldStillNeedsReview(planting, field)) {
        minorFields.add(field);
      }
    });
  }

  if (planting.title.startsWith("Needs completion - ")) {
    majorFields.add("title");
  }
  if (planting.cropName === "Needs crop") {
    majorFields.add("crop");
  }

  return {
    severity: majorFields.size > 0 ? "major" : minorFields.size > 0 ? "minor" : null,
    majorFields,
    minorFields,
    majorIssues,
    minorIssues
  };
}

function PlantingReviewBadge({ severity, title }: { severity: PlantingReviewSeverity; title: string }) {
  return <span className={`review-square review-square-${severity}`} title={title} aria-label={title} />;
}

function PlantingReviewMarker({ review }: { review: PlantingReviewInfo }) {
  if (review.severity === "major") {
    return <PlantingReviewBadge severity="major" title={`Major spreadsheet issue: ${review.majorIssues.join("; ") || "review needed"}`} />;
  }
  if (review.severity === "minor") {
    return <PlantingReviewBadge severity="minor" title={`Optional spreadsheet info missing: ${review.minorIssues.join("; ") || "review suggested"}`} />;
  }
  return null;
}

function fieldReviewSeverity(review: PlantingReviewInfo, fieldName: string): PlantingReviewSeverity | null {
  if (review.majorFields.has(fieldName)) return "major";
  if (review.minorFields.has(fieldName)) return "minor";
  return null;
}

function FieldLabel({
  children,
  review,
  fieldName,
  severityOverride
}: {
  children: ReactNode;
  review: PlantingReviewInfo;
  fieldName: string;
  severityOverride?: PlantingReviewSeverity | null;
}) {
  const severity = severityOverride ?? fieldReviewSeverity(review, fieldName);
  return (
    <span className="field-label-with-review">
      {children}
      {severity && (
        <PlantingReviewBadge
          severity={severity}
          title={severity === "major" ? "Important spreadsheet value needs correction" : "Optional spreadsheet value is missing"}
        />
      )}
    </span>
  );
}

function DetailTerm({ review, fieldName, children }: { review: PlantingReviewInfo; fieldName: string; children: ReactNode }) {
  const severity = fieldReviewSeverity(review, fieldName);
  return (
    <dt className="detail-term-with-review">
      <span>{children}</span>
      {severity && (
        <PlantingReviewBadge
          severity={severity}
          title={severity === "major" ? "Important spreadsheet value needs correction" : "Optional spreadsheet value is missing"}
        />
      )}
    </dt>
  );
}

// Map labels should stay short. Some internal/default zone names include "area"
// to explain what the record is in forms, but that wording clutters the map.
function mapObjectLabel(name: string) {
  const cleaned = name
    .trim()
    .replace(/\s+imported current area$/i, "")
    .replace(/\s+area\s+\d+$/i, "")
    .replace(/\s+area$/i, "")
    .replace(/^area\s+\d+$/i, "")
    .trim();

  return cleaned || name.replace(/\barea\b/gi, "").replace(/\s+/g, " ").trim();
}

function defaultZoneName(options: {
  plannedUse: PlannedUse;
  explicitName: string;
  coverCropLabel?: string | null;
  existingCount: number;
}) {
  const explicit = options.explicitName.trim();
  if (explicit) {
    return explicit;
  }

  const nextIndex = options.existingCount + 1;
  if (options.plannedUse === "cover_crop") {
    const label = options.coverCropLabel?.trim() || "Cover crop";
    return `${label} area ${nextIndex}`;
  }
  return `Area ${nextIndex}`;
}

function fieldStyle(isSelected: boolean) {
  return {
    color: isSelected ? "#fff5d0" : "#234d35",
    weight: isSelected ? 4 : 2,
    fillColor: "#4f8b5c",
    fillOpacity: isSelected ? 0.26 : 0.18,
    bubblingMouseEvents: false
  };
}

function blockStyle(isSelected: boolean) {
  return {
    color: isSelected ? "#fff2d2" : "#9a6429",
    weight: isSelected ? 4 : 2,
    fillColor: "#d5a252",
    fillOpacity: isSelected ? 0.32 : 0.22,
    dashArray: isSelected ? undefined : "6 4",
    bubblingMouseEvents: false
  };
}

function zoneStyle(plannedUse: PlannedUse, isSelected: boolean) {
  const palette = plannedUse === "beds"
    ? { color: "#2f6b45", fill: "#76a86a" }
    : plannedUse === "cover_crop"
      ? { color: "#6f8f2c", fill: "#9fbd4c" }
      : { color: "#7b6f54", fill: "#b7a27b" };

  return {
    color: isSelected ? "#fff5d0" : palette.color,
    weight: isSelected ? 4 : 2,
    fillColor: isSelected ? "#fff0c2" : palette.fill,
    fillOpacity: isSelected ? 0.4 : 0.2
  };
}

function bedStyle(isSelected: boolean, isRoad: boolean) {
  if (isRoad) {
    return {
      color: isSelected ? "#fff4cf" : "#806a4b",
      weight: isSelected ? 3 : 2,
      fillColor: "#b7a27b",
      fillOpacity: isSelected ? 0.58 : 0.42,
      dashArray: "6 4",
      bubblingMouseEvents: false
    };
  }

  return {
    color: isSelected ? "#eff7ff" : "#7aa7c7",
    weight: isSelected ? 2 : 1,
    fillColor: "#bcd8e8",
    fillOpacity: isSelected ? 0.5 : 0.34,
    bubblingMouseEvents: false
  };
}

function plannedOverlayStyle() {
  return {
    color: "#2f84a7",
    weight: 3,
    fillColor: "#bde9f4",
    fillOpacity: 0.14,
    dashArray: "3 7",
    className: "map-plan-path",
    bubblingMouseEvents: false
  };
}

function placementOverlayStyle() {
  return {
    color: "#2e7d45",
    weight: 3,
    fillColor: "#70b45c",
    fillOpacity: 0.42,
    className: "map-actual-path",
    bubblingMouseEvents: false
  };
}

function App() {
  // Most state lives here for prototype speed. Long term, move each major panel
  // into its own component with only the state it needs.
  const [data, setData] = useState<DashboardData>(emptyDashboard);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [farmAccounts, setFarmAccounts] = useState<FarmAccount[]>([]);
  const [feedbackReports, setFeedbackReports] = useState<FeedbackReport[]>([]);
  const [undoSnapshots, setUndoSnapshots] = useState<UndoSnapshotSummary[]>([]);
  const [redoSnapshots, setRedoSnapshots] = useState<UndoSnapshotSummary[]>([]);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [view, setView] = useState<View>("map");
  const [selectedPlantingId, setSelectedPlantingId] = useState<number | null>(null);
  const [editingPlantingId, setEditingPlantingId] = useState<number | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [recentlyCompletedTaskId, setRecentlyCompletedTaskId] = useState<number | null>(null);
  const [selectedFlowId, setSelectedFlowId] = useState<number | null>(null);
  const [flowEditorKey, setFlowEditorKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mapWorkflowMode, setMapWorkflowMode] = useState<MapWorkflowMode>(() => (
    typeof window !== "undefined" && window.matchMedia(MOBILE_MEDIA_QUERY).matches ? "field_work" : "planning"
  ));
  const [mapMode, setMapMode] = useState<MapMode>("select");
  const [selection, setSelection] = useState<MapSelection>(null);
  const selectionRef = useRef<MapSelection>(null);
  const lastBlockSelectionRef = useRef<number | null>(null);
  const mapSingleClickTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const [mapPlantingBedIds, setMapPlantingBedIds] = useState<number[]>([]);
  const [workBedPickActive, setWorkBedPickActive] = useState(false);
  const [workSelectedBedIds, setWorkSelectedBedIds] = useState<number[]>([]);
  const [draftCoordinates, setDraftCoordinates] = useState<CoordinateDraft[]>([]);
  const [draftName, setDraftName] = useState("");
  const [draftNotes, setDraftNotes] = useState("");
  const [draftPlannedUse, setDraftPlannedUse] = useState<PlannedUse>(null);
  const [draftActualState, setDraftActualState] = useState<ZoneActualState>("needs_cleanup");
  const [draftCoverCropChoice, setDraftCoverCropChoice] = useState<string>("");
  const [draftCoverCropName, setDraftCoverCropName] = useState("");
  const [draftCoverCropSeedDate, setDraftCoverCropSeedDate] = useState("");
  const [draftCoverCropTerminateDate, setDraftCoverCropTerminateDate] = useState("");
  const [zoneDraftActive, setZoneDraftActive] = useState(false);
  const [zoneDraftMethod, setZoneDraftMethod] = useState<ZoneDraftMethod>(null);
  const [zoneSplitCoordinates, setZoneSplitCoordinates] = useState<CoordinateDraft[]>([]);
  const [zoneSplitDraggingLineIndex, setZoneSplitDraggingLineIndex] = useState<number | null>(null);
  const [zoneSplitUseLargerSide, setZoneSplitUseLargerSide] = useState(false);
  const [bedLineCoordinates, setBedLineCoordinates] = useState<CoordinateDraft[]>([]);
  const [bedPreviewCoordinates, setBedPreviewCoordinates] = useState<CoordinateDraft[]>([]);
  const [bedAllocationPreview, setBedAllocationPreview] = useState<BedAllocationPreview[]>([]);
  const [bedLineMode, setBedLineMode] = useState<"straight" | "curved">("straight");
  const [bedInvertSide, setBedInvertSide] = useState(false);
  const [bedEntranceSideDrafts, setBedEntranceSideDrafts] = useState<Record<number, "start" | "end">>({});
  const [bedLineSource, setBedLineSource] = useState<BedLineSource>("manual");
  const [bedEdgePickBlockId, setBedEdgePickBlockId] = useState<number | null>(null);
  const [editCoordinates, setEditCoordinates] = useState<CoordinateDraft[]>([]);
  const [editName, setEditName] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editPlannedUse, setEditPlannedUse] = useState<PlannedUse>(null);
  const [editActualState, setEditActualState] = useState<ZoneActualState>("needs_cleanup");
  const [editCoverCropChoice, setEditCoverCropChoice] = useState<string>("");
  const [editCoverCropName, setEditCoverCropName] = useState("");
  const [editCoverCropSeedDate, setEditCoverCropSeedDate] = useState("");
  const [editCoverCropTerminateDate, setEditCoverCropTerminateDate] = useState("");
  const [selectedVertexIndex, setSelectedVertexIndex] = useState<number | null>(null);
  const [mapNotice, setMapNotice] = useState<string | null>(null);
  const [initialView] = useState(() => readStoredMapView());
  const [mapZoom, setMapZoom] = useState(initialView.zoom);
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>(() => readSettings().distanceUnit);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readSettings().themeMode);
  const [isMobileViewport, setIsMobileViewport] = useState(() => (
    typeof window !== "undefined" ? window.matchMedia(MOBILE_MEDIA_QUERY).matches : false
  ));
  const initialMapLayerSettings = readMapLayerSettings(session?.authenticated ? session.user.id : null);
  const [showPlannedPlantingsLayer, setShowPlannedPlantingsLayer] = useState(initialMapLayerSettings.planned);
  const [showActualPlacementsLayer, setShowActualPlacementsLayer] = useState(initialMapLayerSettings.actual);
  const [showTaskLayer, setShowTaskLayer] = useState(initialMapLayerSettings.tasks);
  const [spriteSheetCacheRevision, setSpriteSheetCacheRevision] = useState(0);
  const [showOtherFarmMaps, setShowOtherFarmMaps] = useState(initialMapLayerSettings.otherFarms);
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [selectedMapWeekStart, setSelectedMapWeekStart] = useState(() => startOfWeekDate(todayDateInputValue()));
  const [taskListWeekStart, setTaskListWeekStart] = useState(() => startOfWeekDate(todayDateInputValue()));
  const [showPastUndoneTasks, setShowPastUndoneTasks] = useState(true);
  const [selectedPlanPlantingIds, setSelectedPlanPlantingIds] = useState<number[]>([]);
  const [isSavingMapObject, setIsSavingMapObject] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackComment, setFeedbackComment] = useState("");
  const [feedbackStatus, setFeedbackStatus] = useState<string | null>(null);
  const [isSavingFeedback, setIsSavingFeedback] = useState(false);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const counts = new Map<string, number>();
    document.querySelectorAll<HTMLElement>(".card").forEach((card) => {
      const explicit = card.dataset.cardId?.trim();
      const heading = card.querySelector("h1,h2,h3")?.textContent?.trim();
      const classHint = Array.from(card.classList).filter((name) => name !== "card").join(".");
      const base = explicit || heading || classHint || "card";
      const slug = base
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9_.-]/g, "")
        .replace(/-+/g, "-")
        .toLowerCase() || "card";
      const nextCount = (counts.get(slug) ?? 0) + 1;
      counts.set(slug, nextCount);
      card.dataset.cardMarker = explicit || (nextCount === 1 ? slug : `${slug}-${nextCount}`);
    });
  });
  const [prototypeWarningOpen, setPrototypeWarningOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [tutorialStatus, setTutorialStatus] = useState<string | null>(null);
  const [tutorialStepIndex, setTutorialStepIndex] = useState(0);
  const [isPreparingTutorial, setIsPreparingTutorial] = useState(false);
  const [tutorialPlantingDraft, setTutorialPlantingDraft] = useState<PlantingTutorialDraft | null>(null);
  const [tutorialFlowId, setTutorialFlowId] = useState<number | null>(null);
  const recentActivityRef = useRef<ActivityEntry[]>([]);
  const canPlan = session?.authenticated === true && session.user.role === "planner";
  const isAdmin = session?.authenticated === true && session.user.isAdmin;
  const isAuthenticated = session?.authenticated === true;
  const canViewOtherFarmMaps = isAdmin;
  const effectiveShowOtherFarmMaps = canViewOtherFarmMaps && showOtherFarmMaps;
  useUsageTracking({
    enabled: isAuthenticated,
    page: view,
    userId: isAuthenticated ? session.user.id : null,
    farmId: isAuthenticated ? session.user.farmId : null
  });

  function recordActivity(action: string, details?: Record<string, unknown>) {
    recentActivityRef.current = [
      ...recentActivityRef.current,
      {
        at: new Date().toISOString(),
        view,
        action,
        details
      }
    ].slice(-30);
  }

  function updateMapLayerSettings(patch: Partial<MapLayerSettings>) {
    const next = {
      planned: patch.planned ?? showPlannedPlantingsLayer,
      actual: patch.actual ?? showActualPlacementsLayer,
      tasks: patch.tasks ?? showTaskLayer,
      otherFarms: patch.otherFarms ?? showOtherFarmMaps
    };
    if (patch.planned != null) setShowPlannedPlantingsLayer(patch.planned);
    if (patch.actual != null) setShowActualPlacementsLayer(patch.actual);
    if (patch.tasks != null) setShowTaskLayer(patch.tasks);
    if (patch.otherFarms != null) setShowOtherFarmMaps(patch.otherFarms);
    if (typeof window !== "undefined" && session?.authenticated) {
      window.localStorage.setItem(mapLayerStorageKey(session.user.id), JSON.stringify(next));
    }
  }

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        distanceUnit,
        themeMode
      })
    );
  }, [distanceUnit, themeMode]);

  useEffect(() => {
    if (!session?.authenticated) {
      const defaults = defaultMapLayerSettings();
      setShowPlannedPlantingsLayer(defaults.planned);
      setShowActualPlacementsLayer(defaults.actual);
      setShowTaskLayer(defaults.tasks);
      setShowOtherFarmMaps(defaults.otherFarms);
      return;
    }

    const stored = readMapLayerSettings(session.user.id);
    setShowPlannedPlantingsLayer(stored.planned);
    setShowActualPlacementsLayer(stored.actual);
    setShowTaskLayer(stored.tasks);
    setShowOtherFarmMaps(stored.otherFarms);
  }, [session?.authenticated, session?.authenticated ? session.user.id : null]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      setIsMobileViewport(event.matches);
    };

    setIsMobileViewport(mediaQuery.matches);
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!session?.authenticated || typeof window === "undefined") {
      setPrototypeWarningOpen(false);
      setTutorialOpen(false);
      return;
    }

    setPrototypeWarningOpen(
      window.localStorage.getItem(prototypeWarningStorageKey(session.user.id)) !== PROTOTYPE_WARNING_VERSION
    );
    setTutorialOpen(!isMobileViewport && window.localStorage.getItem(tutorialDismissedStorageKey(session.user.id)) !== "true");
    if (isMobileViewport) {
      setTutorialStatus(null);
    }
  }, [session, isMobileViewport]);

  async function load(
    includeAccounts = canPlan,
    includeFeedback = isAdmin,
    options?: { allowAuthReset?: boolean; authBootstrap?: boolean }
  ) {
    const allowAuthReset = options?.allowAuthReset ?? true;
    const authBootstrap = options?.authBootstrap ?? false;
    setLoading(true);
    setError(null);
    try {
      const [next, nextAccounts, nextFeedbackReports, nextUndoSnapshots] = await Promise.all([
        api.getDashboard(),
        includeAccounts ? api.getAccounts().catch(() => []) : Promise.resolve([]),
        includeFeedback ? api.getFeedbackReports().catch(() => []) : Promise.resolve([]),
        api.getUndoSnapshots().catch(() => ({ undo: [], redo: [] }))
      ]);
      setData(next);
      setFarmAccounts(nextAccounts);
      setFeedbackReports(nextFeedbackReports);
      setUndoSnapshots(nextUndoSnapshots.undo);
      setRedoSnapshots(nextUndoSnapshots.redo);
      if (selectedPlantingId == null && next.plantings[0]) {
        setSelectedPlantingId(next.plantings[0].id);
      }
      if (selectedTaskId == null && next.tasks[0]) {
        setSelectedTaskId(next.tasks.find((task) => task.status !== "done")?.id ?? next.tasks[0].id);
      }
      if (selectedFlowId == null && next.taskFlowTemplates[0]) {
        setSelectedFlowId(next.taskFlowTemplates[0].id);
      }
      if (selection == null && next.fields[0]) {
        const ownField = next.fields.find((field) => field.farmId === next.farm?.id);
        setSelection({ type: "field", id: (ownField ?? next.fields[0]).id });
      }
    } catch (err) {
      if (err instanceof Error && err.message === "Login required" && allowAuthReset) {
        setSession({ authenticated: false });
      }
      if (authBootstrap && err instanceof Error && err.message === "Login required") {
        setError("Signed in, but the app could not load farm data yet. Refresh once. If it still fails after an update, run `npm run db:migrate` and reload.");
      } else {
        setError(err instanceof Error ? err.message : "Failed to load");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void (async () => {
      setSessionLoading(true);
      try {
        const nextSession = await api.getSession();
        setSession(nextSession);
        if (nextSession.authenticated) {
          await load(nextSession.user.role === "planner", nextSession.user.isAdmin);
        } else {
          setLoading(false);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load session");
        setLoading(false);
      } finally {
        setSessionLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    return subscribeSpriteSheetCache(() => setSpriteSheetCacheRevision((current) => current + 1));
  }, []);

  useEffect(() => {
    if (!canPlan && (view === "flows" || view === "seed-bank")) {
      setView("tasks");
    }
  }, [canPlan, view]);

  useEffect(() => {
    if (isMobileViewport && (view === "flows" || view === "seed-bank" || view === "admin" || view === "harvests")) {
      setView("map");
    }
  }, [isMobileViewport, view]);

  useEffect(() => {
    if (isMobileViewport && mapWorkflowMode !== "field_work") {
      resetMapDrafts("select");
      setMapWorkflowMode("field_work");
    }
  }, [isMobileViewport, mapWorkflowMode]);

  useEffect(() => {
    if (!canPlan) {
      setMapWorkflowMode("field_work");
      setEditingPlantingId(null);
    }
  }, [canPlan]);

  useEffect(() => {
    if (!canViewOtherFarmMaps && showOtherFarmMaps) {
      setShowOtherFarmMaps(false);
    }
  }, [canViewOtherFarmMaps, showOtherFarmMaps]);

  useEffect(() => {
    if (editingPlantingId != null && editingPlantingId !== selectedPlantingId) {
      setEditingPlantingId(null);
    }
  }, [editingPlantingId, selectedPlantingId]);

  useEffect(() => {
    setSelectedPlanPlantingIds((current) => current.filter((id) => data.plantings.some((planting) => planting.id === id)));
  }, [data.plantings]);

  useEffect(() => {
    recordActivity("view changed", { view });
  }, [view]);

  useEffect(() => {
    recordActivity("map mode changed", { mapMode });
  }, [mapMode]);

  useEffect(() => {
    recordActivity("map workflow changed", { mapWorkflowMode });
  }, [mapWorkflowMode]);

  useEffect(() => {
    recordActivity("selection changed", selection ? selection : { selection: null });
  }, [selection]);

  const visibleFields = useMemo(
    () => effectiveShowOtherFarmMaps ? data.fields : data.fields.filter((field) => field.farmId === data.farm?.id),
    [data.fields, data.farm?.id, effectiveShowOtherFarmMaps]
  );
  const visibleBlocks = useMemo(
    () => effectiveShowOtherFarmMaps ? data.blocks : data.blocks.filter((block) => block.farmId === data.farm?.id),
    [data.blocks, data.farm?.id, effectiveShowOtherFarmMaps]
  );
  const visibleBlockZones = useMemo(
    () => effectiveShowOtherFarmMaps ? data.blockZones : data.blockZones.filter((zone) => zone.farmId === data.farm?.id),
    [data.blockZones, data.farm?.id, effectiveShowOtherFarmMaps]
  );
  const visibleBeds = useMemo(
    () => effectiveShowOtherFarmMaps ? data.beds : data.beds.filter((bed) => bed.farmId === data.farm?.id),
    [data.beds, data.farm?.id, effectiveShowOtherFarmMaps]
  );
  const ownFields = useMemo(
    () => data.fields.filter((field) => field.farmId === data.farm?.id),
    [data.fields, data.farm?.id]
  );
  const ownBlocks = useMemo(
    () => data.blocks.filter((block) => block.farmId === data.farm?.id),
    [data.blocks, data.farm?.id]
  );
  const ownBlockZones = useMemo(
    () => data.blockZones.filter((zone) => zone.farmId === data.farm?.id),
    [data.blockZones, data.farm?.id]
  );
  const ownBeds = useMemo(
    () => data.beds.filter((bed) => bed.farmId === data.farm?.id),
    [data.beds, data.farm?.id]
  );
  const mapPlantingBeds = useMemo(
    () => mapPlantingBedIds
      .map((bedId) => ownBeds.find((bed) => bed.id === bedId && bed.source !== "road") ?? null)
      .filter((bed): bed is Bed => bed != null),
    [mapPlantingBedIds, ownBeds]
  );
  const ownSeedItems = useMemo(
    () => data.seedItems.filter((seedItem) => seedItem.farmId === data.farm?.id),
    [data.seedItems, data.farm?.id]
  );
  const ownTaskFlowTemplates = useMemo(
    () => data.taskFlowTemplates.filter((flow) => flow.farmId === data.farm?.id),
    [data.taskFlowTemplates, data.farm?.id]
  );
  const ownFarmData = useMemo<DashboardData>(() => ({
    ...data,
    fields: ownFields,
    blocks: ownBlocks,
    blockZones: ownBlockZones,
    beds: ownBeds,
    seedItems: ownSeedItems,
    taskFlowTemplates: ownTaskFlowTemplates
  }), [data, ownFields, ownBlocks, ownBlockZones, ownBeds, ownSeedItems, ownTaskFlowTemplates]);

  useEffect(() => {
    setMapPlantingBedIds((current) => current.filter((bedId) => ownBeds.some((bed) => bed.id === bedId && bed.source !== "road")));
  }, [ownBeds]);

  const selectedPlanting = data.plantings.find((planting) => planting.id === selectedPlantingId) ?? null;
  const selectedTask = data.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedPlacements = useMemo(
    () => data.placements.filter((placement) => placement.plantingId === selectedPlantingId),
    [data.placements, selectedPlantingId]
  );
  const selectedEvents = useMemo(
    () => data.events.filter((event) => event.plantingId === selectedPlantingId),
    [data.events, selectedPlantingId]
  );
  const selectedFlowTemplate = data.taskFlowTemplates.find((flow) => flow.id === selectedFlowId) ?? null;
  const selectedFlowNodes = useMemo(
    () => data.taskFlowNodes.filter((node) => node.flowTemplateId === selectedFlowId),
    [data.taskFlowNodes, selectedFlowId]
  );
  const selectedFlowEdges = useMemo(
    () => data.taskFlowEdges.filter((edge) => edge.flowTemplateId === selectedFlowId),
    [data.taskFlowEdges, selectedFlowId]
  );
  const plantingsById = useMemo(
    () => new Map(data.plantings.map((planting) => [planting.id, planting])),
    [data.plantings]
  );
  const bedsById = useMemo(
    () => new Map(data.beds.map((bed) => [bed.id, bed])),
    [data.beds]
  );
  const blocksById = useMemo(
    () => new Map(data.blocks.map((block) => [block.id, block])),
    [data.blocks]
  );
  const tasksById = useMemo(
    () => new Map(data.tasks.map((task) => [task.id, task])),
    [data.tasks]
  );
  const timelineDates = useMemo(() => {
    const dates = new Set<string>();
    dates.add(todayDateInputValue());
    for (const event of data.events) {
      if (event.eventDate) {
        dates.add(event.eventDate);
      }
    }
    for (const planting of data.plantings) {
      if (planting.plannedSowDate) dates.add(planting.plannedSowDate);
      if (planting.plannedTransplantDate) dates.add(planting.plannedTransplantDate);
      if (planting.expectedHarvestStart) dates.add(planting.expectedHarvestStart);
      if (planting.expectedHarvestEnd) dates.add(planting.expectedHarvestEnd);
    }
    for (const zone of data.blockZones) {
      if (zone.plannedCoverCropSeedDate) dates.add(zone.plannedCoverCropSeedDate);
      if (zone.plannedCoverCropTerminateDate) dates.add(zone.plannedCoverCropTerminateDate);
      if (zone.actualCoverCropSeedDate) dates.add(zone.actualCoverCropSeedDate);
      if (zone.actualCoverCropTerminateDate) dates.add(zone.actualCoverCropTerminateDate);
    }
    return [...dates].sort();
  }, [data.events, data.plantings, data.blockZones]);
  const currentTaskWeekStart = startOfWeekDate(todayDateInputValue());
  const selectedMapWeekEnd = addDaysToDate(selectedMapWeekStart, 6);
  const selectedTimelineDate = selectedMapWeekEnd;
  const plannedPlantingsByBed = useMemo(() => {
    const grouped = new Map<number, Planting[]>();
    const autoBlockPlanPlantingIds = new Set(
      data.placements
        .filter((placement) => placement.planSource === "auto_block_plan")
        .map((placement) => placement.plantingId)
    );
    const addPlantingForBed = (bedId: number, planting: Planting) => {
      const current = grouped.get(bedId) ?? [];
      if (!current.some((item) => item.id === planting.id)) {
        current.push(planting);
      }
      grouped.set(bedId, current);
    };

    for (const planting of data.plantings) {
      if (
        planting.intendedBedId == null ||
        autoBlockPlanPlantingIds.has(planting.id) ||
        !isPlantingInGroundOnDate(planting, selectedTimelineDate)
      ) {
        continue;
      }
      addPlantingForBed(planting.intendedBedId, planting);
    }

    for (const placement of data.placements) {
      if (placement.planSource === "auto_block_plan") {
        continue;
      }
      const planting = plantingsById.get(placement.plantingId);
      if (!planting || !isPlantingInGroundOnDate(planting, selectedTimelineDate)) {
        continue;
      }
      addPlantingForBed(placement.bedId, planting);
    }

    return grouped;
  }, [data.placements, data.plantings, plantingsById, selectedTimelineDate]);
  const plannedPlacementOverlays = useMemo(
    () => {
      const bedById = new Map(data.beds.map((bed) => [bed.id, bed]));
      const blockBedsByBlockId = new Map<number, Bed[]>();
      for (const bed of data.beds) {
        blockBedsByBlockId.set(bed.blockId, [...(blockBedsByBlockId.get(bed.blockId) ?? []), bed]);
      }
      const overlays: Array<{
        key: string;
        blockId: number;
        bedId: number;
        plantingId: number | null;
        label: string;
        overlayBoundary: DashboardData["beds"][number]["boundary"];
        bedLengthUsedM: number;
        placementOrder: number;
        color: PlantingMapColor;
        isGap: boolean;
      }> = [];

      for (const placement of data.placements) {
        if (placement.planSource !== "auto_block_plan") {
          continue;
        }
        const planting = plantingsById.get(placement.plantingId);
        const bed = bedById.get(placement.bedId);
        if (!planting || !bed || !isPlantingInGroundOnDate(planting, selectedTimelineDate)) {
          continue;
        }
        const placementOrder = placement.placementOrder ?? 100000 + placement.id;
        const block = blocksById.get(bed.blockId) ?? null;
        const overlayBoundary = placement.boundary ?? bedSectionBoundary(
          bed,
          Number(placement.startLengthM || 0),
          Number(placement.bedLengthUsedM || 0),
          bedSerpentineReversesFromEnd(bed, block, blockBedsByBlockId.get(bed.blockId) ?? [])
        );
        if (overlayBoundary) {
          overlays.push({
            key: `planned-placement-${placement.id}`,
            blockId: bed.blockId,
            bedId: placement.bedId,
            plantingId: planting.id,
            label: plantingCropVarietyLabel(planting),
            overlayBoundary,
            bedLengthUsedM: Number(placement.bedLengthUsedM || bed.bedLengthM || 0),
            placementOrder,
            color: plantingMapColorForOrder(placementOrder),
            isGap: false
          });
        }
      }

      for (const gap of data.placementGaps) {
        const bed = bedById.get(gap.bedId);
        if (!bed) {
          continue;
        }
        const placementOrder = gap.placementOrder;
        const block = blocksById.get(bed.blockId) ?? null;
        const overlayBoundary = bedSectionBoundary(
          bed,
          Number(gap.startLengthM || 0),
          Number(gap.bedLengthUsedM || 0),
          bedSerpentineReversesFromEnd(bed, block, blockBedsByBlockId.get(bed.blockId) ?? [])
        );
        if (overlayBoundary) {
          overlays.push({
            key: `planned-gap-${gap.id}`,
            blockId: bed.blockId,
            bedId: gap.bedId,
            plantingId: null,
            label: "Gap",
            overlayBoundary,
            bedLengthUsedM: Number(gap.bedLengthUsedM || bed.bedLengthM || 0),
            placementOrder,
            color: plantingMapColorForOrder(placementOrder),
            isGap: true
          });
        }
      }

      return colorizeBlockPlacementRows(overlays);
    },
    [data.beds, data.placements, data.placementGaps, plantingsById, blocksById, selectedTimelineDate]
  );

  const actualPlacementOverlays = useMemo(
    () => {
      const bedById = new Map(data.beds.map((bed) => [bed.id, bed]));
      const visiblePlacements = data.placements.filter((placement) => {
        const planting = plantingsById.get(placement.plantingId);
        return planting
          && isPlantingInGroundOnDate(planting, selectedTimelineDate)
          && placement.placedOn != null
          && placement.placedOn <= selectedTimelineDate;
      });
      const placementsByBed = new Map<number, Placement[]>();
      for (const placement of visiblePlacements) {
        const current = placementsByBed.get(placement.bedId) ?? [];
        current.push(placement);
        placementsByBed.set(placement.bedId, current);
      }
      const overlays: Array<{
        key: string;
        blockId: number;
        bedId: number;
        plantingId: number;
        label: string;
        overlayBoundary: DashboardData["beds"][number]["boundary"];
        bedLengthUsedM: number;
        placementOrder: number;
        color: PlantingMapColor;
        plantCount: number | null;
        spacingInRowM: number | null;
        spacingBetweenRowsM: number | null;
      }> = [];

      for (const [bedId, bedPlacements] of placementsByBed) {
        const bed = bedById.get(bedId);
        if (!bed) {
          continue;
        }

        const sortedPlacements = [...bedPlacements].sort((left, right) => {
          const leftDate = left.placedOn ?? "";
          const rightDate = right.placedOn ?? "";
          if (leftDate === rightDate) return left.id - right.id;
          return leftDate.localeCompare(rightDate);
        });
        const knownLength = sortedPlacements.reduce((sum, placement) => sum + (placement.bedLengthUsedM ?? 0), 0);
        const unknownCount = sortedPlacements.filter((placement) => placement.bedLengthUsedM == null).length;
        const fallbackLength = unknownCount > 0
          ? Math.max(0.1, ((bed.bedLengthM || knownLength || sortedPlacements.length) - knownLength) / unknownCount)
          : 0;
        const totalSectionLength = sortedPlacements.reduce((sum, placement) => sum + (placement.bedLengthUsedM ?? fallbackLength), 0);
        const bedLengthM = Number(bed.bedLengthM);
        const lengthScale = Number.isFinite(bedLengthM) && bedLengthM > 0 && totalSectionLength > bedLengthM
          ? bedLengthM / totalSectionLength
          : 1;
        let cursorM = 0;

        for (const placement of sortedPlacements) {
          const planting = plantingsById.get(placement.plantingId);
          if (!planting) {
            continue;
          }
          const placementOrder = placement.placementOrder ?? 100000 + placement.id;
          const sectionLength = (placement.bedLengthUsedM ?? fallbackLength) * lengthScale;
          const block = blocksById.get(bed.blockId) ?? null;
          const overlayBoundary = placement.boundary ?? bedSectionBoundary(
            bed,
            placement.planSource === "auto_block_plan" ? Number(placement.startLengthM || 0) : cursorM,
            sectionLength,
            placement.planSource === "auto_block_plan" ? bedSerpentineReversesFromEnd(bed, block, data.beds) : false
          );
          if (!overlayBoundary) {
            cursorM += sectionLength;
            continue;
          }
          const spacingPair = parseSpacingPairForUnit(planting.spacing, "m");
          overlays.push({
            key: `${placement.id}`,
            blockId: bed.blockId,
            bedId: placement.bedId,
            plantingId: planting.id,
            label: plantingCropVarietyLabel(planting),
            overlayBoundary,
            bedLengthUsedM: sectionLength,
            placementOrder,
            color: plantingMapColorForOrder(placementOrder),
            plantCount: placement.plantCount,
            spacingInRowM: spacingInputToMeters(spacingPair.inRow, "m"),
            spacingBetweenRowsM: spacingInputToMeters(spacingPair.betweenRows, "m")
          });
          cursorM += sectionLength;
        }
      }

      return colorizeBlockPlacementRows(overlays);
    },
    [data.placements, plantingsById, data.beds, blocksById, selectedTimelineDate]
  );

  const plantingMapLabels = useMemo(() => {
    const bedById = new Map(data.beds.map((bed) => [bed.id, bed]));
    const candidates: PlantingMapLabel[] = [];
    const addCandidate = (
      plantingId: number,
      bedId: number,
      label: string,
      boundary: DashboardData["beds"][number]["boundary"],
      lengthM: number,
      tone: "planned" | "actual",
      order: number,
      color: PlantingMapColor
    ) => {
      const bed = bedById.get(bedId);
      const center = polygonCenter(geoJsonPolygonToLatLngs(boundary));
      if (!bed || !center) {
        return;
      }
      candidates.push({
        key: `${tone}-${plantingId}-${bedId}`,
        plantingId,
        bedId,
        label,
        center,
        bearing: bedTravelPath(bed).bearing,
        lengthM: Number.isFinite(lengthM) && lengthM > 0 ? lengthM : Number(bed.bedLengthM || 0),
        tone,
        color: color.label,
        order
      });
    };

    if (showPlannedPlantingsLayer) {
      for (const [bedId, plantings] of plannedPlantingsByBed) {
        const bed = bedById.get(bedId);
        if (!bed) {
          continue;
        }
        for (const planting of plantings) {
          addCandidate(
            planting.id,
            bedId,
            plantingCropVarietyLabel(planting),
            bed.boundary,
            Number(bed.bedLengthM || 0),
            "planned",
            (bed.sequenceNo ?? bed.id),
            plantingMapColorForOrder(bed.sequenceNo ?? bed.id)
          );
        }
      }

      for (const overlay of plannedPlacementOverlays) {
        if (overlay.plantingId == null) {
          continue;
        }
        addCandidate(
          overlay.plantingId,
          overlay.bedId,
          overlay.label,
          overlay.overlayBoundary,
          overlay.bedLengthUsedM,
          "planned",
          overlay.placementOrder,
          overlay.color
        );
      }
    }

    if (showActualPlacementsLayer) {
      for (const overlay of actualPlacementOverlays) {
        addCandidate(
          overlay.plantingId,
          overlay.bedId,
          overlay.label,
          overlay.overlayBoundary,
          overlay.bedLengthUsedM,
          "actual",
          overlay.placementOrder,
          overlay.color
        );
      }
    }

    const candidatesByPlanting = new Map<number, PlantingMapLabel[]>();
    for (const candidate of candidates) {
      candidatesByPlanting.set(candidate.plantingId, [...(candidatesByPlanting.get(candidate.plantingId) ?? []), candidate]);
    }
    return [...candidatesByPlanting.entries()].map(([plantingId, plantingCandidates]) => {
      const actualCandidates = plantingCandidates.filter((candidate) => candidate.tone === "actual");
      const usableCandidates = (actualCandidates.length > 0 ? actualCandidates : plantingCandidates)
        .sort((left, right) => left.order - right.order || left.bedId - right.bedId);
      const totalLengthM = usableCandidates.reduce((sum, candidate) => sum + Math.max(0.1, candidate.lengthM), 0);
      const midpointM = totalLengthM / 2;
      let cursorM = 0;
      let selected = usableCandidates[0];
      for (const candidate of usableCandidates) {
        cursorM += Math.max(0.1, candidate.lengthM);
        if (cursorM >= midpointM) {
          selected = candidate;
          break;
        }
      }
      return {
        ...selected,
        key: `${selected.tone}-${plantingId}`,
        lengthM: totalLengthM
      };
    });
  }, [
    actualPlacementOverlays,
    data.beds,
    plannedPlacementOverlays,
    plannedPlantingsByBed,
    showActualPlacementsLayer,
    showPlannedPlantingsLayer
  ]);

  const mapTasksThisWeek = useMemo(() => {
    const bedsById = new Map(data.beds.map((bed) => [bed.id, bed]));
    const plantingsByTaskPlantingId = new Map(data.plantings.map((planting) => [planting.id, planting]));
    const blockBedsByBlockId = new Map<number, Bed[]>();
    for (const bed of data.beds) {
      blockBedsByBlockId.set(bed.blockId, [...(blockBedsByBlockId.get(bed.blockId) ?? []), bed]);
    }
    const visibleTasks = data.tasks.filter((task) => {
      if (task.status === "done") {
        return false;
      }
      if (task.scheduledDate == null) {
        return true;
      }
      if (isDateInWeek(task.scheduledDate, selectedMapWeekStart)) {
        return true;
      }
      return selectedMapWeekStart === currentTaskWeekStart && showPastUndoneTasks && task.scheduledDate < currentTaskWeekStart;
    });
    const markers = visibleTasks
      .map((task) => {
        const plantingBedId = task.plantingId != null ? plantingsByTaskPlantingId.get(task.plantingId)?.intendedBedId ?? null : null;
        const plantingPlacements = task.plantingId == null
          ? []
          : data.placements
              .filter((placement) => placement.plantingId === task.plantingId)
              .sort((left, right) => (
                (left.placedOn == null ? 1 : 0) - (right.placedOn == null ? 1 : 0)
                || (left.placementOrder ?? left.id) - (right.placementOrder ?? right.id)
              ));
        const markerTarget = (() => {
          if (task.bedId != null) {
            const placementOnTaskBed = plantingPlacements.find((placement) => placement.bedId === task.bedId) ?? null;
            return { bed: bedsById.get(task.bedId) ?? null, placement: placementOnTaskBed };
          }

          if (plantingPlacements.length === 0) {
            return { bed: bedsById.get(plantingBedId ?? -1) ?? null, placement: null };
          }

          const totalLengthM = plantingPlacements.reduce((sum, placement) => sum + Math.max(0.1, Number(placement.bedLengthUsedM || 0)), 0);
          const midpointM = totalLengthM / 2;
          let cursorM = 0;
          let selectedPlacement = plantingPlacements[0];
          for (const placement of plantingPlacements) {
            cursorM += Math.max(0.1, Number(placement.bedLengthUsedM || 0));
            if (cursorM >= midpointM) {
              selectedPlacement = placement;
              break;
            }
          }

          return { bed: bedsById.get(selectedPlacement.bedId) ?? null, placement: selectedPlacement };
        })();

        const { bed, placement } = markerTarget;
          const block = bed ? blocksById.get(bed.blockId) ?? null : null;
          const reverseFromEnd = bed ? bedSerpentineReversesFromEnd(bed, block, blockBedsByBlockId.get(bed.blockId) ?? []) : false;
          const sectionBoundary = placement?.boundary ?? (bed && placement?.planSource === "auto_block_plan"
            ? bedSectionBoundary(bed, Number(placement.startLengthM || 0), Number(placement.bedLengthUsedM || 0), reverseFromEnd)
            : null);
          const center = polygonCenter(geoJsonPolygonToLatLngs(sectionBoundary ?? bed?.boundary ?? null));
          if (!bed || !center) {
            return null;
          }
          const travelPath = bedTravelPath(bed);
          const bearing = reverseFromEnd ? travelPath.bearing + 180 : travelPath.bearing;
          return {
            key: `task-marker-${task.id}`,
            task,
            bed,
            center,
            bearing,
            runDistancePx: bedRunDistancePx(travelPath, center, mapZoom),
            runDurationSec: 9.5,
            animationDelaySec: 0
          };
      })
      .filter((item): item is MapTaskMarker => item != null);

    const markersByBedId = new Map<number, MapTaskMarker[]>();
    for (const marker of markers) {
      markersByBedId.set(marker.bed.id, [...(markersByBedId.get(marker.bed.id) ?? []), marker]);
    }

    for (const sharedBedMarkers of markersByBedId.values()) {
      if (sharedBedMarkers.length < 2) {
        continue;
      }
      sharedBedMarkers
        .sort((left, right) => left.task.id - right.task.id)
        .forEach((marker, index) => {
          const timing = bedSharedVehicleTiming(index, sharedBedMarkers.length);
          marker.runDurationSec = timing.runDurationSec;
          marker.animationDelaySec = timing.animationDelaySec;
        });
    }

    return markers;
  }, [currentTaskWeekStart, data.tasks, data.beds, data.plantings, data.placements, blocksById, selectedMapWeekStart, showPastUndoneTasks, mapZoom]);
  const mapTaskSpriteSheetRequests = useMemo(() => {
    return mapTasksThisWeek.map(({ task }) => (
      spriteSheetRequestForTask(task.taskType, taskColor(task), task.iconSecondaryColor, task.tractorModel)
    ));
  }, [mapTasksThisWeek]);
  const mapTaskSpriteSheetUrls = useMemo(() => {
    const urlsByTaskId = new Map<number, string | null>();
    for (const { task } of mapTasksThisWeek) {
      const request = spriteSheetRequestForTask(task.taskType, taskColor(task), task.iconSecondaryColor, task.tractorModel);
      urlsByTaskId.set(task.id, getCachedSpriteSheetUrl(request));
    }
    return urlsByTaskId;
  }, [mapTasksThisWeek, spriteSheetCacheRevision]);
  useEffect(() => {
    if (showTaskLayer) {
      preloadSpriteSheets(mapTaskSpriteSheetRequests);
    }
  }, [mapTaskSpriteSheetRequests, showTaskLayer]);
  const showCropSectionsAtZoom = mapZoom >= 16;
  const showPlantingLabelsAtZoom = mapZoom >= 18;
  const showBedGeometryAtZoom = mapZoom >= 19;
  const bedAllocationPreviewOverlays = useMemo(() => {
    const bedById = new Map(data.beds.map((item) => [item.id, item]));
    const blockBedsByBlockId = new Map<number, Bed[]>();
    for (const bed of data.beds) {
      blockBedsByBlockId.set(bed.blockId, [...(blockBedsByBlockId.get(bed.blockId) ?? []), bed]);
    }
    return bedAllocationPreview.flatMap((preview) => {
      const previewBed = bedById.get(preview.bedId);
      if (!previewBed) {
        return [];
      }
      const block = blocksById.get(previewBed.blockId) ?? null;
      const boundary = bedSectionBoundary(
        previewBed,
        preview.startLengthM,
        preview.bedLengthUsedM,
        bedSerpentineReversesFromEnd(previewBed, block, blockBedsByBlockId.get(previewBed.blockId) ?? [])
      );
      return boundary ? [{ ...preview, boundary }] : [];
    });
  }, [bedAllocationPreview, blocksById, data.beds]);
  const taskListWeekEnd = addDaysToDate(taskListWeekStart, 6);
  const isCurrentTaskListWeek = taskListWeekStart === currentTaskWeekStart;
  const currentPlanYear = Number(todayDateInputValue().slice(0, 4));
  const visibleTaskList = useMemo(() => {
    const weekTasks = data.tasks.filter((task) => {
      if (!task.scheduledDate) {
        return false;
      }
      return task.scheduledDate >= taskListWeekStart && task.scheduledDate <= taskListWeekEnd;
    });
    if (!isCurrentTaskListWeek || !showPastUndoneTasks) {
      return weekTasks;
    }
    const pastUndoneTasks = data.tasks
      .filter((task) => (
        task.status !== "done" &&
        task.scheduledDate != null &&
        task.scheduledDate < currentTaskWeekStart
      ))
      .sort((left, right) => (left.scheduledDate ?? "").localeCompare(right.scheduledDate ?? ""));
    return [...pastUndoneTasks, ...weekTasks];
  }, [currentTaskWeekStart, data.tasks, isCurrentTaskListWeek, showPastUndoneTasks, taskListWeekStart, taskListWeekEnd]);
  const planGroups = useMemo(() => {
    const grouped = new Map<number, Planting[]>();
    for (const planting of data.plantings) {
      const year = plantingPlanYear(planting);
      const current = grouped.get(year) ?? [];
      current.push(planting);
      grouped.set(year, current);
    }
    return [...grouped.entries()].sort(([leftYear], [rightYear]) => rightYear - leftYear);
  }, [data.plantings]);
  const unscheduledTaskList = useMemo(() => (
    data.tasks
      .filter((task) => task.status !== "done" && task.scheduledDate == null)
      .sort((left, right) => left.title.localeCompare(right.title))
  ), [data.tasks]);
  const recordTaskCandidate = selectedTask ?? data.tasks.find((task) => task.status !== "done") ?? data.tasks[0] ?? null;

  function selectTask(task: Task, nextView?: View) {
    setSelectedTaskId(task.id);
    if (task.plantingId != null) {
      setSelectedPlantingId(task.plantingId);
    }
    if (nextView) {
      setView(nextView);
    }
  }

  function focusPlantingOnMap(planting: Planting) {
    setSelectedPlantingId(planting.id);
    if (planting.intendedBedId != null && mapWorkflowMode === "field_work") {
      setSelection({ type: "bed", id: planting.intendedBedId });
    } else if (planting.intendedBedId != null) {
      const intendedBed = data.beds.find((bed) => bed.id === planting.intendedBedId) ?? null;
      if (intendedBed) {
        setSelection({ type: "block", id: intendedBed.blockId });
      } else if (planting.intendedBlockId != null) {
        setSelection({ type: "block", id: planting.intendedBlockId });
      } else if (planting.intendedFieldId != null) {
        setSelection({ type: "field", id: planting.intendedFieldId });
      }
    } else if (planting.intendedBlockId != null) {
      setSelection({ type: "block", id: planting.intendedBlockId });
    } else if (planting.intendedFieldId != null) {
      setSelection({ type: "field", id: planting.intendedFieldId });
    }
    setView("map");
  }

  function openTaskRecordFromMap(task: Task) {
    const planting = task.plantingId != null ? plantingsById.get(task.plantingId) ?? null : null;
    const bedId = task.bedId ?? planting?.intendedBedId ?? null;
    resetMapDrafts("select");
    setMapWorkflowMode("field_work");
    selectTask(task);
    if (bedId != null) {
      setSelection({ type: "bed", id: bedId });
    } else if (planting?.intendedBlockId != null) {
      setSelection({ type: "block", id: planting.intendedBlockId });
    } else if (planting?.intendedFieldId != null) {
      setSelection({ type: "field", id: planting.intendedFieldId });
    }
    setView("map");
    setMapNotice(`Selected ${task.title}. Use Record from task, or open the planting detail.`);
  }

  async function quickCompleteTask(task: Task) {
    if (taskNeedsRecordForm(task.taskType)) {
      selectTask(task);
      setMapNotice("This task changes crop state. Use the Record from task panel so the needed details are captured.");
      return;
    }

    const actualDate = defaultTaskRecordDate(task);
    if (isPlantingActionTask(task.taskType) && actualDate > todayDateInputValue()) {
      setMapNotice("Planted dates cannot be in the future.");
      return;
    }

    try {
      setSelectedTaskId(task.id);
      setMapNotice("Recording task...");
      await api.recordTask(task.id, {
        actualDate,
        notes: `Quick completed from task list on ${todayDateInputValue()}`
      });
      await load();
      setRecentlyCompletedTaskId(task.id);
      setMapNotice(`Recorded ${task.title}.`);
    } catch (error) {
      setMapNotice(error instanceof Error ? error.message : "Could not record task.");
    }
  }

  async function undoRecentTaskCompletion(task: Task) {
    if (recentlyCompletedTaskId !== task.id) {
      setMapNotice("Only the task most recently marked done from this list can be undone here.");
      return;
    }
    if (!undoSnapshots[0]) {
      setMapNotice("Nothing to undo in this session.");
      return;
    }

    try {
      setMapNotice(`Undoing ${task.title}...`);
      await api.undoLastChange();
      recordActivity("task completion undo used", { taskId: task.id, label: undoSnapshots[0].label });
      setRecentlyCompletedTaskId(null);
      setSelectedTaskId(null);
      await load(canPlan);
      setMapNotice(`Undid ${task.title}.`);
    } catch (error) {
      setMapNotice(error instanceof Error ? error.message : "Undo failed.");
    }
  }

  const selectedField = selection?.type === "field" ? data.fields.find((field) => field.id === selection.id) ?? null : null;
  const selectedBlock = selection?.type === "block" ? data.blocks.find((block) => block.id === selection.id) ?? null : null;
  const selectedZone = selection?.type === "zone" ? data.blockZones.find((zone) => zone.id === selection.id) ?? null : null;
  const selectedBed = selection?.type === "bed" ? data.beds.find((bed) => bed.id === selection.id) ?? null : null;
  const selectedBlockContext = selectedBlock
    ?? (selectedZone ? data.blocks.find((block) => block.id === selectedZone.blockId) ?? null : null)
    ?? (selectedBed ? data.blocks.find((block) => block.id === selectedBed.blockId) ?? null : null);
  const bedEdgePickBlockContext = bedEdgePickBlockId == null
    ? selectedBlockContext
    : data.blocks.find((block) => block.id === bedEdgePickBlockId) ?? selectedBlockContext;
  const selectedBlockEntranceSide = selectedBlockContext
    ? bedEntranceSideDrafts[selectedBlockContext.id] ?? selectedBlockContext.bedStartEntranceSide ?? "start"
    : "start";
  const selectedFieldContext = selectedField
    ?? (selectedBlockContext ? data.fields.find((field) => field.id === selectedBlockContext.fieldId) ?? null : null)
    ?? (selectedZone ? data.fields.find((field) => field.id === selectedZone.fieldId) ?? null : null);
  const selectedMapItem = selectedField ?? selectedBlock ?? selectedZone ?? selectedBed;
  const selectedMapItemIsOwnFarm = selectedMapItem == null || selectedMapItem.farmId === data.farm?.id;
  const selectedFieldIsOwnFarm = selectedField == null || selectedField.farmId === data.farm?.id;
  const selectedBlockContextIsOwnFarm = selectedBlockContext == null || selectedBlockContext.farmId === data.farm?.id;
  const canEditSelectedMapItem = canPlan && selectedMapItemIsOwnFarm && selection?.type !== "bed";
  const canDeleteSelectedMapItem = canPlan && selectedMapItemIsOwnFarm;
  const canEditSelectedBlockContext = canPlan && selectedBlockContextIsOwnFarm;
  const selectedMapCoordinates = selectedField
    ? geoJsonPolygonToLatLngs(selectedField.boundary)
    : selectedBlock
        ? geoJsonPolygonToLatLngs(selectedBlock.boundary)
      : selectedZone
        ? geoJsonPolygonToLatLngs(selectedZone.boundary)
      : selectedBed
        ? geoJsonPolygonToLatLngs(selectedBed.boundary)
      : [];

  useEffect(() => {
    selectionRef.current = selection;
    if (selection?.type === "block") {
      lastBlockSelectionRef.current = selection.id;
    }
    if (selection?.type === "zone") {
      const selectedZoneForRef = data.blockZones.find((zone) => zone.id === selection.id) ?? null;
      if (selectedZoneForRef) {
        lastBlockSelectionRef.current = selectedZoneForRef.blockId;
      }
    }
    if (selection?.type === "bed") {
      const selectedBedForRef = data.beds.find((bed) => bed.id === selection.id) ?? null;
      if (selectedBedForRef) {
        lastBlockSelectionRef.current = selectedBedForRef.blockId;
      }
    }
  }, [data.beds, data.blockZones, selection]);

  useEffect(() => () => {
    if (mapSingleClickTimerRef.current != null) {
      window.clearTimeout(mapSingleClickTimerRef.current);
    }
  }, []);

  function clearPendingMapSingleClick() {
    if (mapSingleClickTimerRef.current != null) {
      window.clearTimeout(mapSingleClickTimerRef.current);
      mapSingleClickTimerRef.current = null;
    }
  }

  function scheduleMapSingleClick(action: () => void) {
    clearPendingMapSingleClick();
    mapSingleClickTimerRef.current = window.setTimeout(() => {
      mapSingleClickTimerRef.current = null;
      action();
    }, 220);
  }

  function selectMapObject(nextSelection: Exclude<MapSelection, null>, blockHintId?: number | null) {
    selectionRef.current = nextSelection;
    if (nextSelection.type === "block") {
      lastBlockSelectionRef.current = nextSelection.id;
    } else if (blockHintId != null) {
      lastBlockSelectionRef.current = blockHintId;
    }
    setMapPlantingBedIds([]);
    setSelection(nextSelection);
    if (mapWorkflowMode === "field_work") {
      setSelectedTaskId(null);
      setSelectedPlantingId(null);
    }
    setMapNotice(null);
  }

  function blockAtPointInField(fieldId: number, point: CoordinateDraft) {
    return data.blocks
      .filter((block) => block.fieldId === fieldId)
      .sort((left, right) => left.areaSqM - right.areaSqM)
      .find((block) => pointIsInsideOrOnPolygon(point, geoJsonPolygonToLatLngs(block.boundary))) ?? null;
  }

  function runMapSelectClick(action: () => void) {
    if (mapMode === "select") {
      scheduleMapSingleClick(action);
      return;
    }
    action();
  }

  function stopMapDoubleClick(event: { originalEvent?: MouseEvent }) {
    event.originalEvent?.preventDefault();
    event.originalEvent?.stopPropagation();
  }

  function selectBlockFieldCycle(block: Block) {
    const currentSelection = selectionRef.current;
    const parentField = data.fields.find((field) => field.id === block.fieldId) ?? null;
    if (currentSelection?.type === "block" && currentSelection.id === block.id && parentField) {
      selectMapObject({ type: "field", id: parentField.id });
      return;
    }
    if (currentSelection?.type === "field" && currentSelection.id === block.fieldId) {
      selectMapObject({ type: "block", id: block.id });
      return;
    }
    selectMapObject({ type: "block", id: block.id });
  }

  function selectFieldBlockCycle(field: Field, point: CoordinateDraft) {
    const currentSelection = selectionRef.current;
    if (currentSelection?.type === "field" && currentSelection.id === field.id) {
      const lastBlock = lastBlockSelectionRef.current == null
        ? null
        : data.blocks.find((block) => block.id === lastBlockSelectionRef.current && block.fieldId === field.id) ?? null;
      const nextBlock = blockAtPointInField(field.id, point) ?? lastBlock;
      if (nextBlock) {
        selectMapObject({ type: "block", id: nextBlock.id });
      }
      return;
    }
    selectMapObject({ type: "field", id: field.id });
  }

  function pointIsInSelectedBlock(point: CoordinateDraft) {
    return Boolean(
      selectedBlockContext
      && pointIsInsideOrOnPolygon(point, geoJsonPolygonToLatLngs(selectedBlockContext.boundary))
    );
  }

  function addBedLinePoint(point: CoordinateDraft) {
    setBedLineCoordinates((current) => {
      const maxPoints = bedLineMode === "straight" ? 2 : 12;
      if (current.length >= maxPoints) {
        setMapNotice("Bed line already has the maximum number of points. Generate or Cancel.");
        return current;
      }
      return [...current, point];
    });
    setMapNotice(null);
  }

  function addZoneSplitPoint(point: CoordinateDraft) {
    setZoneSplitCoordinates((current) => {
      if (current.length >= 2) {
        setMapNotice("Two section lines are already placed. Drag a line to move it, Save, or Cancel.");
        return current;
      }
      return [...current, point];
    });
    setMapNotice(null);
  }
  function findSuggestedTaskForBed(bed: Bed) {
    const bedPlantingIds = new Set(
      data.plantings
        .filter((planting) => planting.intendedBedId === bed.id)
        .map((planting) => planting.id)
    );
    for (const placement of data.placements) {
      if (placement.bedId === bed.id) {
        bedPlantingIds.add(placement.plantingId);
      }
    }

    return data.tasks
      .filter((task) => {
        if (task.status === "done") {
          return false;
        }
        const matchesBed = task.bedId === bed.id || (task.plantingId != null && bedPlantingIds.has(task.plantingId));
        if (!matchesBed) {
          return false;
        }
        return task.scheduledDate == null || isDateInWeek(task.scheduledDate, selectedMapWeekStart);
      })
      .sort((left, right) => {
        const leftIsBedMaking = left.taskType === "bed_prep" || left.taskType === "bed_making";
        const rightIsBedMaking = right.taskType === "bed_prep" || right.taskType === "bed_making";
        if (leftIsBedMaking && !rightIsBedMaking) return -1;
        if (rightIsBedMaking && !leftIsBedMaking) return 1;
        return (left.scheduledDate ?? "9999-12-31").localeCompare(right.scheduledDate ?? "9999-12-31");
      })[0] ?? null;
  }

  function findSuggestedTaskForPlanting(planting: Planting, bed: Bed | null = null) {
    return data.tasks
      .filter((task) => {
        if (task.status === "done" || task.plantingId !== planting.id) {
          return false;
        }
        if (bed && task.bedId != null && task.bedId !== bed.id) {
          return false;
        }
        return task.scheduledDate == null || isDateInWeek(task.scheduledDate, selectedMapWeekStart);
      })
      .sort((left, right) => {
        if (left.bedId === bed?.id && right.bedId !== bed?.id) return -1;
        if (right.bedId === bed?.id && left.bedId !== bed?.id) return 1;
        return (left.scheduledDate ?? "9999-12-31").localeCompare(right.scheduledDate ?? "9999-12-31");
      })[0] ?? null;
  }

  function primaryPlantingForBed(bed: Bed) {
    const plantingIds = new Set(
      data.placements
        .filter((placement) => placement.bedId === bed.id)
        .map((placement) => placement.plantingId)
    );

    return data.plantings
      .filter((planting) => planting.intendedBedId === bed.id || plantingIds.has(planting.id))
      .sort((left, right) => {
        const leftInGround = isPlantingInGroundOnDate(left, selectedTimelineDate);
        const rightInGround = isPlantingInGroundOnDate(right, selectedTimelineDate);
        if (leftInGround !== rightInGround) return leftInGround ? -1 : 1;
        const leftDate = plantingGroundStartDate(left) ?? "9999-12-31";
        const rightDate = plantingGroundStartDate(right) ?? "9999-12-31";
        if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
        return left.title.localeCompare(right.title);
      })[0] ?? null;
  }

  const selectedBedSuggestedTask = selectedBed ? findSuggestedTaskForBed(selectedBed) : null;
  const selectedPlantingSuggestedTask = selectedPlanting && mapWorkflowMode === "field_work"
    ? findSuggestedTaskForPlanting(selectedPlanting, selectedBed)
    : null;
  const selectedBedPlantings = useMemo(() => {
    if (!selectedBed) {
      return [] as Planting[];
    }

    const plantingIds = new Set(
      data.placements
        .filter((placement) => placement.bedId === selectedBed.id)
        .map((placement) => placement.plantingId)
    );
    return data.plantings
      .filter((planting) => planting.intendedBedId === selectedBed.id || plantingIds.has(planting.id))
      .sort((left, right) => {
        const leftDate = plantingGroundStartDate(left) ?? "9999-12-31";
        const rightDate = plantingGroundStartDate(right) ?? "9999-12-31";
        if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
        return left.title.localeCompare(right.title);
      });
  }, [data.placements, data.plantings, selectedBed]);
  const selectedBedPlacements = useMemo(() => (
    selectedBed
      ? data.placements
          .filter((placement) => placement.bedId === selectedBed.id)
          .sort((left, right) => (right.placedOn ?? "").localeCompare(left.placedOn ?? ""))
      : []
  ), [data.placements, selectedBed]);
  const selectedBedGaps = useMemo(() => (
    selectedBed
      ? data.placementGaps
          .filter((gap) => gap.bedId === selectedBed.id)
          .sort((left, right) => Number(left.placementOrder) - Number(right.placementOrder))
      : []
  ), [data.placementGaps, selectedBed]);
  const selectedBlockOverflows = useMemo(() => (
    selectedBlockContext
      ? data.placementOverflows
          .filter((overflow) => overflow.blockId === selectedBlockContext.id)
          .sort((left, right) => Number(left.placementOrder) - Number(right.placementOrder))
      : []
  ), [data.placementOverflows, selectedBlockContext]);
  const selectedBlockPlantableBeds = useMemo(() => (
    selectedBlockContext
      ? ownBeds.filter((bed) => bed.blockId === selectedBlockContext.id && bed.source !== "road")
      : []
  ), [ownBeds, selectedBlockContext]);
  const zoneSplitLines = useMemo(
    () => bedParallelSplitLinesForBlock(selectedBlockContext, selectedBlockPlantableBeds, zoneSplitCoordinates),
    [selectedBlockContext, selectedBlockPlantableBeds, zoneSplitCoordinates]
  );
  const zoneSplitFirstBedSidePoint = useMemo(
    () => firstBedSideReferencePoint(selectedBlockContext, selectedBlockPlantableBeds),
    [selectedBlockContext, selectedBlockPlantableBeds]
  );
  const zoneSplitPreviewCoordinates = useMemo(
    () => splitAreaPreviewForBlock(selectedBlockContext, zoneSplitLines, zoneSplitFirstBedSidePoint),
    [selectedBlockContext, zoneSplitFirstBedSidePoint, zoneSplitLines]
  );
  const zoneSplitPreviewAreaSqM = useMemo(
    () => zoneSplitPreviewCoordinates.length >= 3 ? polygonAreaSqM(zoneSplitPreviewCoordinates) : null,
    [zoneSplitPreviewCoordinates]
  );
  const zoneSplitDisplayLines = useMemo(() => {
    const boundary = geoJsonPolygonToLatLngs(selectedBlockContext?.boundary ?? null);
    return zoneSplitLines.map((line) => clipLineToPolygon(line, boundary));
  }, [selectedBlockContext, zoneSplitLines]);
  useEffect(() => {
    const selectedBlockBedIds = new Set(selectedBlockPlantableBeds.map((bed) => bed.id));
    setWorkSelectedBedIds((current) => current.filter((bedId) => selectedBlockBedIds.has(bedId)));
  }, [selectedBlockPlantableBeds]);
  const selectedBlockPlacementColorsActive = Boolean(
    selectedBlockContext
    && selectedBlockPlantableBeds.length > 0
    && mapPlantingBeds.length === 0
    && canPlan
    && selectedBlockContext.farmId === data.farm?.id
  );
  const selectedBlockPlacementColorOverlays = useMemo(
    () => {
      if (!selectedBlockContext || !selectedBlockPlacementColorsActive) {
        return [] as Array<{
          key: string;
          blockId: number;
          bedId: number;
          plantingId: number | null;
          label: string;
          overlayBoundary: DashboardData["beds"][number]["boundary"];
          bedLengthUsedM: number;
          placementOrder: number;
          color: PlantingMapColor;
          isGap: boolean;
        }>;
      }

      const blockBedsByBlockId = new Map<number, Bed[]>([[selectedBlockContext.id, selectedBlockPlantableBeds]]);
      const overlays: Array<{
        key: string;
        blockId: number;
        bedId: number;
        plantingId: number | null;
        label: string;
        overlayBoundary: DashboardData["beds"][number]["boundary"];
        bedLengthUsedM: number;
        placementOrder: number;
        color: PlantingMapColor;
        isGap: boolean;
      }> = [];

      for (const placement of data.placements) {
        if (placement.planSource !== "auto_block_plan") {
          continue;
        }
        const bed = bedsById.get(placement.bedId);
        const planting = plantingsById.get(placement.plantingId);
        if (!bed || bed.blockId !== selectedBlockContext.id || !planting) {
          continue;
        }
        const placementOrder = placement.placementOrder ?? 100000 + placement.id;
        const block = blocksById.get(bed.blockId) ?? null;
        const overlayBoundary = placement.boundary ?? bedSectionBoundary(
          bed,
          Number(placement.startLengthM || 0),
          Number(placement.bedLengthUsedM || 0),
          bedSerpentineReversesFromEnd(bed, block, blockBedsByBlockId.get(bed.blockId) ?? [])
        );
        if (!overlayBoundary) {
          continue;
        }
        overlays.push({
          key: `selected-block-placement-${placement.id}`,
          blockId: bed.blockId,
          bedId: placement.bedId,
          plantingId: planting.id,
          label: plantingCropVarietyLabel(planting),
          overlayBoundary,
          bedLengthUsedM: Number(placement.bedLengthUsedM || bed.bedLengthM || 0),
          placementOrder,
          color: plantingMapColorForOrder(placementOrder),
          isGap: false
        });
      }

      for (const gap of data.placementGaps) {
        if (gap.blockId !== selectedBlockContext.id) {
          continue;
        }
        const bed = bedsById.get(gap.bedId);
        if (!bed) {
          continue;
        }
        const placementOrder = gap.placementOrder;
        const block = blocksById.get(bed.blockId) ?? null;
        const overlayBoundary = bedSectionBoundary(
          bed,
          Number(gap.startLengthM || 0),
          Number(gap.bedLengthUsedM || 0),
          bedSerpentineReversesFromEnd(bed, block, blockBedsByBlockId.get(bed.blockId) ?? [])
        );
        if (!overlayBoundary) {
          continue;
        }
        overlays.push({
          key: `selected-block-gap-${gap.id}`,
          blockId: bed.blockId,
          bedId: gap.bedId,
          plantingId: null,
          label: "Gap",
          overlayBoundary,
          bedLengthUsedM: Number(gap.bedLengthUsedM || bed.bedLengthM || 0),
          placementOrder,
          color: plantingMapColorForOrder(placementOrder),
          isGap: true
        });
      }

      return colorizeBlockPlacementRows(overlays);
    },
    [
      blocksById,
      bedsById,
      canPlan,
      data.farm?.id,
      data.placementGaps,
      data.placements,
      mapPlantingBeds.length,
      plantingsById,
      selectedBlockContext,
      selectedBlockPlacementColorsActive,
      selectedBlockPlantableBeds
    ]
  );
  const selectedBlockIsEmpty = useMemo(() => {
    if (!selectedBlockContext || selectedBlockPlantableBeds.length === 0) {
      return false;
    }

    const selectedBlockBedIds = new Set(selectedBlockPlantableBeds.map((bed) => bed.id));
    return (
      !data.plantings.some((planting) => (
        planting.intendedBlockId === selectedBlockContext.id
        || (planting.intendedBedId != null && selectedBlockBedIds.has(planting.intendedBedId))
      ))
      && !data.placements.some((placement) => selectedBlockBedIds.has(placement.bedId))
      && !data.placementGaps.some((gap) => gap.blockId === selectedBlockContext.id)
      && !data.placementOverflows.some((overflow) => overflow.blockId === selectedBlockContext.id)
    );
  }, [data.placementGaps, data.placementOverflows, data.placements, data.plantings, selectedBlockContext, selectedBlockPlantableBeds]);
  const selectedBedTasks = useMemo(() => {
    if (!selectedBed) {
      return [] as Task[];
    }

    const plantingIds = new Set(selectedBedPlantings.map((planting) => planting.id));
    return data.tasks
      .filter((task) => task.bedId === selectedBed.id || (task.plantingId != null && plantingIds.has(task.plantingId)))
      .sort((left, right) => {
        if (left.status !== "done" && right.status === "done") return -1;
        if (right.status !== "done" && left.status === "done") return 1;
        return (left.scheduledDate ?? "9999-12-31").localeCompare(right.scheduledDate ?? "9999-12-31");
      });
  }, [data.tasks, selectedBed, selectedBedPlantings]);
  const selectedBedIsUnassigned = Boolean(
    selectedBed
    && selectedBed.source !== "road"
    && selectedBedPlantings.length === 0
    && selectedBedPlacements.length === 0
    && selectedBedGaps.length === 0
  );
  const placementPlanEntranceMarkerActive = Boolean(
    selectedBlockContext
    && selectedBlockPlantableBeds.length > 0
    && mapPlantingBeds.length === 0
    && canPlan
    && mapWorkflowMode === "planning"
    && selectedBlockContext.farmId === data.farm?.id
  );
  const placementPlanEntranceMarker = useMemo(() => {
    if (!placementPlanEntranceMarkerActive || !selectedBlockContext) {
      return null;
    }
    const firstBed = [...selectedBlockPlantableBeds]
      .sort((left, right) => (left.sequenceNo ?? left.id) - (right.sequenceNo ?? right.id))[0] ?? null;
    if (!firstBed) {
      return null;
    }
    const entranceSide = selectedBlockEntranceSide;
    const pose = firstBedEntrancePose(firstBed, entranceSide);
    if (!pose) {
      return null;
    }
    const profile = data.tractorProfiles.length > 0
      ? data.tractorProfiles[Math.abs((selectedBlockContext.id * 9301 + firstBed.id * 49297) % data.tractorProfiles.length)]
      : defaultEntranceTractorProfile;
    return {
      key: `placement-plan-entrance-${selectedBlockContext.id}-${firstBed.id}-${entranceSide}-${profile.id}`,
      blockName: selectedBlockContext.name,
      bedName: firstBed.name,
      entranceSide,
      center: pose.center,
      bearing: pose.bearing,
      profile
    };
  }, [data.tractorProfiles, placementPlanEntranceMarkerActive, selectedBlockContext, selectedBlockEntranceSide, selectedBlockPlantableBeds]);
  const mapSelectedTaskList = useMemo(() => {
    if (mapWorkflowMode !== "field_work") {
      return [] as Task[];
    }

    const matchesSelectedPlanting = (task: Task) => (
      selectedPlanting != null && task.plantingId === selectedPlanting.id
    );

    const selectedTaskBlock = selectedPlanting == null ? selectedBlockContext : null;
    const blockBedIds = selectedTaskBlock
      ? new Set(data.beds.filter((bed) => bed.blockId === selectedTaskBlock.id).map((bed) => bed.id))
      : null;
    const blockPlantingIds = selectedTaskBlock
      ? new Set(
          data.plantings
            .filter((planting) => (
              planting.intendedBlockId === selectedTaskBlock.id
              || (planting.intendedBedId != null && blockBedIds?.has(planting.intendedBedId))
            ))
            .map((planting) => planting.id)
        )
      : null;

    if (blockBedIds && blockPlantingIds) {
      for (const placement of data.placements) {
        if (blockBedIds.has(placement.bedId)) {
          blockPlantingIds.add(placement.plantingId);
        }
      }
    }

    const matchesMapTaskContext = (task: Task) => {
      if (matchesSelectedPlanting(task)) {
        return true;
      }
      return Boolean(
        selectedPlanting == null
        && blockBedIds
        && blockPlantingIds
        && (
          (task.bedId != null && blockBedIds.has(task.bedId))
          || (task.plantingId != null && blockPlantingIds.has(task.plantingId))
        )
      );
    };

    const weekTasks = data.tasks.filter((task) => (
      isDateInWeek(task.scheduledDate, selectedMapWeekStart) && matchesMapTaskContext(task)
    ));

    const tasks = selectedMapWeekStart === currentTaskWeekStart && showPastUndoneTasks
      ? [
          ...data.tasks
            .filter((task) => (
              task.status !== "done" &&
              task.scheduledDate != null &&
              task.scheduledDate < currentTaskWeekStart &&
              matchesMapTaskContext(task)
            ))
            .sort((left, right) => (left.scheduledDate ?? "").localeCompare(right.scheduledDate ?? "")),
          ...weekTasks
        ]
      : weekTasks;

    return tasks
      .sort((left, right) => {
        if (left.status !== "done" && right.status === "done") return -1;
        if (right.status !== "done" && left.status === "done") return 1;
        return (left.scheduledDate ?? "9999-12-31").localeCompare(right.scheduledDate ?? "9999-12-31");
      });
  }, [currentTaskWeekStart, data.beds, data.placements, data.plantings, data.tasks, mapWorkflowMode, selectedBlockContext, selectedMapWeekStart, selectedPlanting, showPastUndoneTasks]);
  const mapWorkTasksOnly = Boolean(
    mapWorkflowMode === "field_work"
    && mapPlantingBeds.length === 0
    && (selectedPlanting || selectedBlockContext)
  );
  const mapWorkTaskContextLabel = selectedPlanting?.title ?? selectedBlockContext?.name ?? "Selected area";
  const mapRecordTask = selectedTask ?? selectedPlantingSuggestedTask ?? (mapPlantingBeds.length > 0 ? null : selectedBedSuggestedTask);

  function nextMapPlantingBedIds(currentIds: number[], bed: Bed) {
    const existingBed = ownBeds.find((item) => item.id === bed.id);
    if (!existingBed || existingBed.source === "road" || existingBed.farmId !== data.farm?.id) {
      return currentIds;
    }

    const selectedBeds = currentIds
      .map((bedId) => ownBeds.find((item) => item.id === bedId && item.source !== "road") ?? null)
      .filter((item): item is Bed => item != null);
    const sameBlockIds = selectedBeds.every((item) => item.blockId === bed.blockId) ? currentIds : [];
    if (sameBlockIds.includes(bed.id)) {
      return sameBlockIds.filter((bedId) => bedId !== bed.id);
    }
    return [...sameBlockIds, bed.id];
  }

  function selectPlantingOnMap(planting: Planting, bed: Bed | null = null) {
    const intendedBed = planting.intendedBedId != null ? bedsById.get(planting.intendedBedId) ?? null : null;
    const targetBed = bed ?? intendedBed;
    setMapPlantingBedIds([]);
    setSelectedPlantingId(planting.id);

    const task = findSuggestedTaskForPlanting(planting, targetBed);
    setSelectedTaskId(task?.id ?? null);

    if (targetBed) {
      setSelection({ type: "bed", id: targetBed.id });
    } else if (planting.intendedBlockId != null) {
      setSelection({ type: "block", id: planting.intendedBlockId });
    } else if (planting.intendedFieldId != null) {
      setSelection({ type: "field", id: planting.intendedFieldId });
    }

    const locationLabel = targetBed ? `${targetBed.blockName} / ${targetBed.name}` : planting.intendedBlockName ?? planting.intendedFieldName ?? "map";
    setMapNotice(
      task
        ? `Selected ${planting.title} at ${locationLabel}. First suggested work: ${task.title}.`
        : `Selected ${planting.title} at ${locationLabel}.`
    );
  }

  function selectBedOnMap(bed: Bed, options: { togglePlantingSelection?: boolean } = {}) {
    if (options.togglePlantingSelection) {
      if (bed.source === "road" || bed.farmId !== data.farm?.id) {
        setMapNotice("Only plantable beds on your farm can be added to a crop plan.");
        return;
      }

      const nextIds = nextMapPlantingBedIds(mapPlantingBedIds, bed);
      setMapPlantingBedIds(nextIds);
      setSelection({ type: "block", id: bed.blockId });
      setSelectedTaskId(null);
      setSelectedPlantingId(null);
      if (nextIds.length === 0) {
        setMapNotice("Bed removed from the crop-plan selection.");
      } else if (nextIds.length === 1) {
        setMapNotice("1 bed selected for a new planting.");
      } else {
        setMapNotice(`${nextIds.length} beds selected for a new planting.`);
      }
      return;
    }

    if (mapWorkflowMode === "field_work" && workBedPickActive) {
      if (bed.source === "road" || bed.farmId !== data.farm?.id) {
        setMapNotice("Only plantable beds on your farm can be added to a work record.");
        return;
      }
      setWorkSelectedBedIds((current) => {
        const sameBlockIds = current
          .map((bedId) => ownBeds.find((item) => item.id === bedId && item.source !== "road") ?? null)
          .filter((item): item is Bed => item != null)
          .every((item) => item.blockId === bed.blockId) ? current : [];
        if (sameBlockIds.includes(bed.id)) {
          return sameBlockIds.filter((bedId) => bedId !== bed.id);
        }
        return [...sameBlockIds, bed.id];
      });
      setSelection({ type: "block", id: bed.blockId });
      setSelectedTaskId(null);
      setSelectedPlantingId(null);
      setMapNotice(`Cultivation bed selection updated in ${bed.blockName}.`);
      return;
    }

    setMapPlantingBedIds([]);
    if (mapWorkflowMode === "field_work") {
      setSelection({ type: "bed", id: bed.id });
      const planting = primaryPlantingForBed(bed);
      if (planting) {
        selectPlantingOnMap(planting, bed);
        return;
      }

      const task = findSuggestedTaskForBed(bed);
      if (task) {
        selectTask(task);
        setMapNotice(`Selected ${bed.name}. First suggested work: ${task.title}.`);
        return;
      }
      setSelectedTaskId(null);
      setSelectedPlantingId(null);
      setMapNotice(`Selected ${bed.name}. This bed is unassigned.`);
      return;
    }
    setSelection({ type: "block", id: bed.blockId });
    setMapNotice(null);
  }

  useEffect(() => {
    recordActivity("timeline date changed", { selectedTimelineDate });
  }, [selectedTimelineDate]);

  useEffect(() => {
    if (mapMode !== "bed_tools" || bedLineSource !== "selected_bed" || !selectedBed || !selectedBlockContext) {
      return;
    }

    const guideLine = selectedBedGuideLine(selectedBed, selectedBlockContext);
    if (guideLine.length >= 2) {
      setBedLineCoordinates(guideLine);
      setBedLineMode("straight");
      setBedPreviewCoordinates([]);
    }
  }, [mapMode, bedLineSource, selectedBed, selectedBlockContext]);

  useEffect(() => {
    if (effectiveShowOtherFarmMaps || !selection) {
      return;
    }

    if (selectedMapItem && selectedMapItem.farmId !== data.farm?.id) {
      setSelection(null);
    }
  }, [effectiveShowOtherFarmMaps, selection, selectedMapItem, data.farm?.id]);

  async function submitFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedbackStatus(null);
    setIsSavingFeedback(true);

    const context = {
      view,
      mapMode,
      selectedTimelineDate,
      selection,
      selectedField: selectedField ? { id: selectedField.id, name: selectedField.name } : null,
      selectedBlock: selectedBlockContext ? { id: selectedBlockContext.id, name: selectedBlockContext.name } : null,
      selectedZone: selectedZone ? { id: selectedZone.id, name: selectedZone.name } : null,
      selectedPlanting: selectedPlanting ? { id: selectedPlanting.id, title: selectedPlanting.title } : null,
      selectedTask: selectedTask ? { id: selectedTask.id, title: selectedTask.title, status: selectedTask.status } : null,
      selectedFlow: selectedFlowTemplate ? { id: selectedFlowTemplate.id, name: selectedFlowTemplate.name } : null,
      counts: {
        fields: data.fields.length,
        blocks: data.blocks.length,
        beds: data.beds.length,
        plantings: data.plantings.length,
        tasks: data.tasks.length
      },
      settings: {
        distanceUnit,
        themeMode,
        mapWorkflowMode,
        showPlannedPlantingsLayer,
        showActualPlacementsLayer,
        showTaskLayer,
        showOtherFarmMaps: effectiveShowOtherFarmMaps
      },
      browser: typeof window === "undefined" ? null : {
        url: window.location.href,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        }
      }
    };

    try {
      await api.createFeedback({
        page: view,
        comment: feedbackComment.trim() || null,
        context,
        recentActivity: recentActivityRef.current
      });
      recordActivity("feedback submitted", { page: view });
      setFeedbackComment("");
      setFeedbackStatus("Feedback saved.");
      if (isAdmin) {
        setFeedbackReports(await api.getFeedbackReports().catch(() => feedbackReports));
      }
      window.setTimeout(() => {
        setFeedbackOpen(false);
        setFeedbackStatus(null);
      }, 800);
    } catch (error) {
      setFeedbackStatus(error instanceof Error ? error.message : "Could not save feedback.");
    } finally {
      setIsSavingFeedback(false);
    }
  }

  async function deletePlanting(plantingId: number) {
    if (!canPlan) {
      setMapNotice("Planner access required.");
      return;
    }
    const planting = data.plantings.find((item) => item.id === plantingId);
    if (!planting) {
      return;
    }

    const confirmed = window.confirm(`Delete planting "${planting.title}"?`);
    if (!confirmed) {
      return;
    }

    try {
      setMapNotice("Deleting planting...");
      await api.deletePlanting(plantingId);
      const remaining = data.plantings.filter((item) => item.id !== plantingId);
      setSelectedPlantingId(remaining[0]?.id ?? null);
      await load(canPlan);
      setView(remaining.length > 0 ? "plan" : "plan");
      setMapNotice("Planting deleted.");
    } catch (err) {
      setMapNotice(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  async function deleteSelectedPlantings() {
    if (!canPlan) {
      setMapNotice("Planner access required.");
      return;
    }
    if (selectedPlanPlantingIds.length === 0) {
      setMapNotice("Select plantings to delete.");
      return;
    }

    const selectedIds = [...new Set(selectedPlanPlantingIds)];
    const selectedPlantings = data.plantings.filter((planting) => selectedIds.includes(planting.id));
    if (selectedPlantings.length === 0) {
      setSelectedPlanPlantingIds([]);
      setMapNotice("Those selected plantings are no longer in the plan.");
      return;
    }
    const confirmed = window.confirm(`Delete ${selectedPlantings.length} selected planting${selectedPlantings.length === 1 ? "" : "s"}?`);
    if (!confirmed) {
      return;
    }

    try {
      setMapNotice("Deleting selected plantings...");
      for (const plantingId of selectedPlantings.map((planting) => planting.id)) {
        await api.deletePlanting(plantingId);
      }
      setSelectedPlanPlantingIds([]);
      const remaining = data.plantings.filter((item) => !selectedIds.includes(item.id));
      setSelectedPlantingId(remaining[0]?.id ?? null);
      await load(canPlan);
      setView("plan");
      setMapNotice("Selected plantings deleted.");
    } catch (err) {
      setMapNotice(err instanceof Error ? err.message : "Bulk delete failed.");
    }
  }

  async function undoLastChange() {
    const latest = undoSnapshots[0];
    if (!latest) {
      setMapNotice("Nothing to undo in this session.");
      return;
    }

    const confirmed = window.confirm(`Undo last change: ${latest.label}?`);
    if (!confirmed) {
      return;
    }

    try {
      setMapNotice(`Undoing ${latest.label.toLowerCase()}...`);
      await api.undoLastChange();
      recordActivity("undo used", { label: latest.label });
      setSelection(null);
      await load(canPlan);
      setMapNotice(`Undid: ${latest.label}`);
    } catch (err) {
      setMapNotice(err instanceof Error ? err.message : "Undo failed.");
    }
  }

  async function redoLastChange() {
    const latest = redoSnapshots[0];
    if (!latest) {
      setMapNotice("Nothing to redo in this session.");
      return;
    }

    const confirmed = window.confirm(`Redo change: ${latest.label}?`);
    if (!confirmed) {
      return;
    }

    try {
      setMapNotice(`Redoing ${latest.label.toLowerCase()}...`);
      await api.redoLastChange();
      recordActivity("redo used", { label: latest.label });
      setSelection(null);
      await load(canPlan);
      setMapNotice(`Redid: ${latest.label}`);
    } catch (err) {
      setMapNotice(err instanceof Error ? err.message : "Redo failed.");
    }
  }

  function startNewTaskFlow() {
    if (!canPlan) {
      setMapNotice("Planner access required.");
      return;
    }
    setSelectedFlowId(null);
    setFlowEditorKey((current) => current + 1);
    setView("flows");
  }

  async function copySelectedTaskFlow() {
    if (!canPlan) {
      setMapNotice("Planner access required.");
      return;
    }
    if (selectedFlowId == null) {
      return;
    }

    try {
      setMapNotice("Copying task flow...");
      const result = await api.copyTaskFlow(selectedFlowId) as { id?: number };
      await load();
      if (result.id != null) {
        setSelectedFlowId(result.id);
      }
      setFlowEditorKey((current) => current + 1);
      setMapNotice("Task flow copied.");
    } catch (error) {
      setMapNotice(error instanceof Error ? error.message : "Task flow copy failed.");
    }
  }

  async function deleteSelectedTaskFlow() {
    if (!canPlan) {
      setMapNotice("Planner access required.");
      return;
    }
    if (selectedFlowTemplate == null) {
      return;
    }

    const confirmed = window.confirm(`Delete task flow "${selectedFlowTemplate.name}"?`);
    if (!confirmed) {
      return;
    }

    try {
      setMapNotice("Deleting task flow...");
      await api.deleteTaskFlow(selectedFlowTemplate.id);
      const remaining = data.taskFlowTemplates.filter((flow) => flow.id !== selectedFlowTemplate.id);
      setSelectedFlowId(remaining[0]?.id ?? null);
      setFlowEditorKey((current) => current + 1);
      await load();
      setMapNotice("Task flow deleted.");
    } catch (error) {
      setMapNotice(error instanceof Error ? error.message : "Task flow delete failed.");
    }
  }

  function resetMapDrafts(nextMode: MapMode = "select", options?: { preserveBedLine?: boolean }) {
    setMapMode(nextMode);
    setDraftCoordinates([]);
    setDraftName("");
    setDraftNotes("");
    setDraftPlannedUse(null);
    setDraftActualState("needs_cleanup");
    setDraftCoverCropChoice("");
    setDraftCoverCropName("");
    setDraftCoverCropSeedDate("");
    setDraftCoverCropTerminateDate("");
    setZoneDraftActive(false);
    setZoneDraftMethod(null);
    setZoneSplitCoordinates([]);
    setZoneSplitDraggingLineIndex(null);
    setZoneSplitUseLargerSide(false);
    if (!options?.preserveBedLine) {
      setBedLineCoordinates([]);
      setBedPreviewCoordinates([]);
      setBedAllocationPreview([]);
      setBedLineMode("straight");
      setBedLineSource("manual");
    }
    if (nextMode !== "pick_bed_edge") {
      setBedEdgePickBlockId(null);
    }
    setEditCoordinates([]);
    setEditName("");
    setEditNotes("");
    setEditPlannedUse(null);
    setEditActualState("needs_cleanup");
    setEditCoverCropChoice("");
    setEditCoverCropName("");
    setEditCoverCropSeedDate("");
    setEditCoverCropTerminateDate("");
    setSelectedVertexIndex(null);
    setMapNotice(null);
  }

  function changeMapWorkflowMode(nextMode: MapWorkflowMode) {
    if (nextMode === "planning" && !canPlan) {
      setMapNotice("Planner access required.");
      return;
    }

    if (nextMode === "planning" && selectedBed) {
      setSelection({ type: "block", id: selectedBed.blockId });
    }
    setMapWorkflowMode(nextMode);
    if (nextMode === "field_work" && mapMode !== "select") {
      resetMapDrafts("select");
      setMapNotice("Field Work mode is for selecting beds and recording work. Drawing tools are in Planning.");
    }
  }

  function locateUserOnMap() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setMapNotice("This browser does not provide GPS location.");
      return;
    }

    setMapNotice("Finding your phone location...");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null
        });
        setMapNotice("Phone location shown on the map.");
      },
      (geolocationError) => {
        const message = geolocationError.code === geolocationError.PERMISSION_DENIED
          ? "Location permission was blocked. Allow location access in the browser to use phone GPS."
          : geolocationError.code === geolocationError.TIMEOUT
            ? "Phone GPS took too long to respond. Try again near a window or outdoors."
            : "Phone location is unavailable right now.";
        setMapNotice(message);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 10000,
        timeout: 12000
      }
    );
  }

  function startDrawField() {
    if (!canPlan) {
      setMapNotice("Planner access required.");
      return;
    }
    setSelection(null);
    resetMapDrafts("draw_field");
    if (tutorialOpen && tutorialStepIndex === 0) {
      setTutorialStatus("Now click around the outside of the field on the map. Add a name, then click the highlighted Save button.");
    }
  }

  function startDrawBlock() {
    if (!canPlan) {
      setMapNotice("Planner access required.");
      return;
    }
    if (!selectedField) {
      setMapNotice("Select a field first. Blocks belong to exactly one field.");
      return;
    }
    if (!selectedFieldIsOwnFarm) {
      setMapNotice("That field belongs to another farm. You can view it, but not add blocks to it.");
      return;
    }
    resetMapDrafts("draw_block");
    if (tutorialOpen && tutorialStepIndex === 1) {
      setTutorialStatus("Now click around the block or bed area on the map. Add a name, then click the highlighted Save button.");
    }
  }

  function startDrawZone(plannedUse: PlannedUse) {
    if (!canPlan) {
      setMapNotice("Planner access required.");
      return;
    }
    if (!selectedBlockContext) {
      setMapNotice("Select a block first. Zones belong inside a block.");
      return;
    }
    if (!selectedBlockContextIsOwnFarm) {
      setMapNotice("That block belongs to another farm. You can view it, but not edit it.");
      return;
    }
    resetMapDrafts("select");
    setZoneDraftActive(true);
    setDraftPlannedUse(plannedUse);
    setDraftActualState(selectedZone?.actualState ?? "needs_cleanup");
    setMapNotice(`Choose how to create the area inside ${selectedBlockContext.name}. Future use is optional.`);
  }

  function startBlockSectionDraft(method: Exclude<ZoneDraftMethod, null>) {
    if (!canPlan) {
      setMapNotice("Planner access required.");
      return;
    }
    if (!selectedBlockContext) {
      setMapNotice("Select a block first. Sections belong inside a block.");
      return;
    }
    if (!selectedBlockContextIsOwnFarm) {
      setMapNotice("That block belongs to another farm. You can view it, but not edit it.");
      return;
    }

    const block = selectedBlockContext;
    resetMapDrafts(method === "split_line" ? "draw_zone_split" : method === "polygon" ? "draw_zone" : "select");
    if (selection?.type === "bed") {
      setSelection({ type: "block", id: block.id });
    }
    setZoneDraftActive(true);
    setZoneDraftMethod(method);
    setDraftPlannedUse(null);
    setDraftActualState("needs_cleanup");

    if (method === "whole_block") {
      setDraftCoordinates(geoJsonPolygonToLatLngs(block.boundary));
      setMapNotice("Whole block selected. Review the section details, then save.");
      return;
    }

    if (method === "split_line") {
      setMapNotice("Click once to place a bed-parallel section line. Click a second time to use the area between the two lines.");
      return;
    }

    setMapNotice("Click to draw the section polygon inside the selected block, then save.");
  }

  function startBedTools() {
    if (!canPlan) {
      setMapNotice("Planner access required.");
      return;
    }
    if (!selectedBlockContext) {
      setMapNotice("Select a block first.");
      return;
    }
    if (!selectedBlockContextIsOwnFarm) {
      setMapNotice("That block belongs to another farm. You can view it, but not edit it.");
      return;
    }
    resetMapDrafts("bed_tools", { preserveBedLine: true });
    if (tutorialOpen && tutorialStepIndex === 2) {
      setTutorialStatus("Use the highlighted bed tools controls. Pick a block edge, then fill the block.");
    }
    if (selectedBed) {
      const guideLine = selectedBedGuideLine(selectedBed, selectedBlockContext);
      if (guideLine.length >= 2) {
        setBedLineCoordinates(guideLine);
        setBedLineMode("straight");
        setBedLineSource("selected_bed");
        setBedPreviewCoordinates([]);
        setMapNotice("Using the selected bed as the guide. Choose a preset, then Make one bed to add the next bed beside it.");
        return;
      }
    }
    setBedLineSource("manual");
    setMapNotice("Choose a bed preset, then pick the block edge beds should build from.");
  }

  function startBedLineDraw(_mode: "straight" | "curved") {
    if (!canPlan) {
      setMapNotice("Planner access required.");
      return;
    }
    if (!selectedBlockContext) {
      setMapNotice("Select a block first.");
      return;
    }
    if (!selectedBlockContextIsOwnFarm) {
      setMapNotice("That block belongs to another farm. You can view it, but not edit it.");
      return;
    }
    resetMapDrafts("draw_bed_line", { preserveBedLine: true });
    setBedLineCoordinates([]);
    setBedPreviewCoordinates([]);
    setBedLineMode("straight");
    setBedLineSource("manual");
    setMapNotice("Click 2 points to define a straight bed line inside the selected block.");
  }

  function setZoneCreationMethod(method: ZoneDraftMethod) {
    if (!zoneDraftActive) {
      return;
    }

    setZoneDraftMethod(method);
    setDraftCoordinates([]);
    setZoneSplitCoordinates([]);
    setZoneSplitUseLargerSide(false);

    if (method === "whole_block") {
      const blockBoundary = geoJsonPolygonToLatLngs(selectedBlockContext?.boundary ?? null);
      setDraftCoordinates(blockBoundary);
      setMapMode("select");
      setMapNotice("Whole block selected. Review the area details, then save.");
      return;
    }

    if (method === "split_line") {
      setMapMode("draw_zone_split");
      setMapNotice("Click once to place a bed-parallel section line. Click a second time to use the area between the two lines.");
      return;
    }

    if (method === "polygon") {
      setMapMode("draw_zone");
      setMapNotice("Click to draw the area polygon inside the selected block, then save.");
    }
  }

  function startBedEdgePick() {
    if (mapMode === "pick_bed_edge") {
      cancelBedLinePick();
      return;
    }
    if (!canPlan) {
      setMapNotice("Planner access required.");
      return;
    }
    if (!selectedBlockContext) {
      setMapNotice("Select a block first.");
      return;
    }
    if (!selectedBlockContextIsOwnFarm) {
      setMapNotice("That block belongs to another farm. You can view it, but not edit it.");
      return;
    }
    resetMapDrafts("pick_bed_edge", { preserveBedLine: true });
    setBedEdgePickBlockId(selectedBlockContext.id);
    setBedLineSource("manual");
    setMapNotice("Click the block edge you want beds to build from.");
  }

  function openSelectedBlockBedMaker() {
    if (!canPlan) {
      setMapNotice("Planner access required.");
      return;
    }
    if (!selectedBlockContext) {
      setMapNotice("Select a block first.");
      return;
    }
    if (!selectedBlockContextIsOwnFarm) {
      setMapNotice("That block belongs to another farm. You can view it, but not edit it.");
      return;
    }

    const blockId = selectedBlockContext.id;
    changeMapWorkflowMode("planning");
    setSelection({ type: "block", id: blockId });
    resetMapDrafts("bed_tools");
    setBedLineSource("manual");
    setMapNotice("Pick the first bed edge, then choose the entrance side before generating beds.");
  }

  function selectBedEdgeLine(edgeLine: CoordinateDraft[]) {
    if (edgeLine.length < 2) {
      setMapNotice("Click directly on a highlighted block edge.");
      return;
    }

    const edgePickBlock = bedEdgePickBlockId == null ? selectedBlockContext : data.blocks.find((block) => block.id === bedEdgePickBlockId) ?? selectedBlockContext;
    const boundary = geoJsonPolygonToLatLngs(edgePickBlock?.boundary ?? null);
    setBedLineCoordinates(orientLineLeftTowardPoint(edgeLine, polygonCenter(boundary)));
    setBedLineMode("straight");
    setBedLineSource("manual");
    setMapMode("bed_tools");
    setBedEdgePickBlockId(null);
    setMapNotice("Edge selected. Choose a preset and generate beds.");
  }

  function cancelBedLinePick() {
    setMapMode("bed_tools");
    setBedEdgePickBlockId(null);
    setBedLineCoordinates([]);
    setBedPreviewCoordinates([]);
    setBedLineMode("straight");
    setBedInvertSide(false);
    setMapNotice(null);
  }

  function startEditSelection() {
    if (!canPlan) {
      setMapNotice("Planner access required.");
      return;
    }
    if (!selectedMapItem) {
      setMapNotice("Select a field, block, or area first.");
      return;
    }
    if (!selectedMapItemIsOwnFarm) {
      setMapNotice("That map item belongs to another farm. You can view it, but not edit it.");
      return;
    }

    const coordinates = selectedField
      ? geoJsonPolygonToLatLngs(selectedField.boundary)
      : selectedBlock
        ? geoJsonPolygonToLatLngs(selectedBlock.boundary)
        : selectedZone
          ? geoJsonPolygonToLatLngs(selectedZone.boundary)
        : [];

    setMapMode("edit");
    setEditCoordinates(coordinates);
    setEditName(selectedMapItem.name);
    setEditNotes(selectedMapItem.notes ?? "");
    setEditPlannedUse(selectedZone?.plannedUse ?? null);
    setEditActualState(selectedZone?.actualState ?? "needs_cleanup");
    setEditCoverCropChoice(selectedZone?.coverCropNameId != null ? String(selectedZone.coverCropNameId) : selectedZone?.coverCropName ? "__new__" : "");
    setEditCoverCropName(selectedZone?.coverCropNameId == null ? (selectedZone?.coverCropName ?? "") : "");
    setEditCoverCropSeedDate(dateInputValue(selectedZone?.plannedCoverCropSeedDate));
    setEditCoverCropTerminateDate(dateInputValue(selectedZone?.plannedCoverCropTerminateDate));
    setSelectedVertexIndex(null);
    setMapNotice(null);
  }

  async function saveDraft() {
    if (!canPlan) {
      setMapNotice("Planner access required.");
      return;
    }
    if ((mapMode === "draw_block" && !selectedFieldIsOwnFarm) || (zoneDraftActive && !selectedBlockContextIsOwnFarm)) {
      setMapNotice("You can only save map changes to your own farm.");
      return;
    }
    const blockZoneCount = selectedBlockContext ? data.blockZones.filter((zone) => zone.blockId === selectedBlockContext.id).length : 0;
    const selectedCoverCropLabel = draftCoverCropChoice === "__new__"
      ? draftCoverCropName.trim()
      : data.coverCropNames.find((item) => String(item.id) === draftCoverCropChoice)?.name ?? null;

    if (mapMode !== "draw_zone_split" && draftCoordinates.length < 3 && !(zoneDraftActive && zoneDraftMethod === "whole_block")) {
      setMapNotice("A polygon needs at least 3 points before it can be saved.");
      return;
    }

    if (!draftName.trim() && mapMode !== "draw_zone" && !zoneDraftActive) {
      setMapNotice("Add a name before saving.");
      return;
    }

    try {
      if (mapMode === "draw_field" && !data.farm?.id) {
        setMapNotice("No farm record found. Run the database seed and reload the app.");
        return;
      }
      if (mapMode === "draw_zone" && !selectedBlockContext) {
        setMapNotice("Select a block first.");
        return;
      }
      if (zoneDraftActive && !zoneDraftMethod) {
        setMapNotice("Choose Whole block, Split with line, or Draw polygon first.");
        return;
      }
      if (zoneDraftActive && draftPlannedUse === "cover_crop" && !draftCoverCropChoice && !draftCoverCropName.trim()) {
        setMapNotice("Select or add a cover crop name.");
        return;
      }
      if (mapMode === "draw_zone_split" && zoneSplitLines.length !== zoneSplitCoordinates.length) {
        setMapNotice("Could not calculate a bed-parallel split line for this block.");
        return;
      }
      if (mapMode === "draw_zone_split" && zoneSplitCoordinates.length < 1) {
        setMapNotice("Place at least one section line first.");
        return;
      }

      setIsSavingMapObject(true);
      setMapNotice("Saving...");
      const savedMapMode = mapMode;

      let response: SaveResponse | undefined;
      if (mapMode === "draw_field") {
        response = await api.createField({
          farmId: data.farm!.id,
          name: draftName.trim(),
          notes: draftNotes.trim(),
          coordinates: draftCoordinates
        }) as SaveResponse;
      }

      if (mapMode === "draw_block" && selectedField) {
        response = await api.createBlock({
          fieldId: selectedField.id,
          name: draftName.trim(),
          notes: draftNotes.trim(),
          currentState: draftActualState,
          coordinates: draftCoordinates
        }) as SaveResponse;
      }

      if (mapMode === "draw_zone" && selectedBlockContext) {
        response = await api.createBlockZone({
          blockId: selectedBlockContext.id,
          name: defaultZoneName({
            plannedUse: draftPlannedUse,
            explicitName: draftName,
            coverCropLabel: selectedCoverCropLabel,
            existingCount: blockZoneCount
          }),
          plannedUse: draftPlannedUse,
          actualState: draftActualState,
          coverCropNameId: draftPlannedUse === "cover_crop" && draftCoverCropChoice && draftCoverCropChoice !== "__new__"
            ? Number(draftCoverCropChoice)
            : null,
          coverCropName: draftPlannedUse === "cover_crop" && draftCoverCropChoice === "__new__"
            ? draftCoverCropName.trim()
            : null,
          plannedCoverCropSeedDate: draftPlannedUse === "cover_crop" ? draftCoverCropSeedDate || null : null,
          plannedCoverCropTerminateDate: draftPlannedUse === "cover_crop" ? draftCoverCropTerminateDate || null : null,
          notes: draftNotes.trim(),
          coordinates: draftCoordinates
        }) as SaveResponse;
      }

      if (zoneDraftActive && zoneDraftMethod === "whole_block" && selectedBlockContext) {
        response = await api.createBlockZone({
          blockId: selectedBlockContext.id,
          name: defaultZoneName({
            plannedUse: draftPlannedUse,
            explicitName: draftName,
            coverCropLabel: selectedCoverCropLabel,
            existingCount: blockZoneCount
          }),
          plannedUse: draftPlannedUse,
          actualState: draftActualState,
          coverCropNameId: draftPlannedUse === "cover_crop" && draftCoverCropChoice && draftCoverCropChoice !== "__new__"
            ? Number(draftCoverCropChoice)
            : null,
          coverCropName: draftPlannedUse === "cover_crop" && draftCoverCropChoice === "__new__"
            ? draftCoverCropName.trim()
            : null,
          plannedCoverCropSeedDate: draftPlannedUse === "cover_crop" ? draftCoverCropSeedDate || null : null,
          plannedCoverCropTerminateDate: draftPlannedUse === "cover_crop" ? draftCoverCropTerminateDate || null : null,
          notes: draftNotes.trim(),
          coordinates: geoJsonPolygonToLatLngs(selectedBlockContext.boundary)
        }) as SaveResponse;
      }

      if (mapMode === "draw_zone_split" && selectedBlockContext) {
        response = await api.splitBlockZone(selectedBlockContext.id, {
          name: defaultZoneName({
            plannedUse: draftPlannedUse,
            explicitName: draftName,
            coverCropLabel: selectedCoverCropLabel,
            existingCount: blockZoneCount
          }),
          plannedUse: draftPlannedUse,
          actualState: draftActualState,
          coverCropNameId: draftPlannedUse === "cover_crop" && draftCoverCropChoice && draftCoverCropChoice !== "__new__"
            ? Number(draftCoverCropChoice)
            : null,
          coverCropName: draftPlannedUse === "cover_crop" && draftCoverCropChoice === "__new__"
            ? draftCoverCropName.trim()
            : null,
          plannedCoverCropSeedDate: draftPlannedUse === "cover_crop" ? draftCoverCropSeedDate || null : null,
          plannedCoverCropTerminateDate: draftPlannedUse === "cover_crop" ? draftCoverCropTerminateDate || null : null,
          notes: draftNotes.trim(),
          splitLines: zoneSplitLines,
          firstBedSidePoint: zoneSplitFirstBedSidePoint,
          useLargerSide: zoneSplitUseLargerSide
        }) as SaveResponse;
      }

      await load();
      resetMapDrafts();
      if (response?.id != null) {
        setSelection({
          type: savedMapMode === "draw_field" ? "field" : savedMapMode === "draw_block" ? "block" : "zone",
          id: response.id
        });
      }
      if (tutorialOpen && tutorialStepIndex === 0 && savedMapMode === "draw_field") {
        setTutorialStepIndex(1);
        setTutorialStatus("Field saved. Now select that field if it is not selected, then use the highlighted Draw block button.");
      } else if (tutorialOpen && tutorialStepIndex === 1 && savedMapMode === "draw_block") {
        setTutorialStepIndex(2);
        setTutorialStatus("Block saved. Now use the highlighted Generate beds button.");
      }
      setMapNotice(response?.warning ?? "Saved.");
    } catch (err) {
      console.error("Map object save failed", err);
      const itemLabel = mapMode === "draw_field"
        ? "field"
        : mapMode === "draw_block"
          ? "block"
          : "map area";
      setMapNotice(mapSaveErrorMessage(err, itemLabel));
    } finally {
      setIsSavingMapObject(false);
    }
  }

  async function savePendingWorkSection(notes: string) {
    if (!zoneDraftActive) {
      return null;
    }
    if (!canPlan) {
      throw new Error("Planner access required.");
    }
    if (!selectedBlockContext || !selectedBlockContextIsOwnFarm) {
      throw new Error("Select a block on your farm first.");
    }
    if (!zoneDraftMethod) {
      throw new Error("Choose how to mark the work area.");
    }
    if (zoneDraftMethod === "polygon" && draftCoordinates.length < 3) {
      throw new Error("Draw the work area on the map first.");
    }
    if (zoneDraftMethod === "split_line" && zoneSplitCoordinates.length < 1) {
      throw new Error("Place at least one split line on the map first.");
    }
    if (zoneDraftMethod === "split_line" && zoneSplitLines.length !== zoneSplitCoordinates.length) {
      throw new Error("Could not calculate a bed-parallel split line for this block.");
    }

    const blockZoneCount = data.blockZones.filter((zone) => zone.blockId === selectedBlockContext.id).length;
    const payload = {
      name: defaultZoneName({
        plannedUse: null,
        explicitName: "",
        existingCount: blockZoneCount
      }),
      plannedUse: null,
      actualState: draftActualState,
      coverCropNameId: null,
      coverCropName: null,
      plannedCoverCropSeedDate: null,
      plannedCoverCropTerminateDate: null,
      notes: notes.trim() || null
    };

    setIsSavingMapObject(true);
    try {
      const response = zoneDraftMethod === "split_line"
        ? await api.splitBlockZone(selectedBlockContext.id, {
            ...payload,
            splitLines: zoneSplitLines,
            firstBedSidePoint: zoneSplitFirstBedSidePoint,
            useLargerSide: zoneSplitUseLargerSide
          }) as SaveResponse
        : await api.createBlockZone({
            blockId: selectedBlockContext.id,
            ...payload,
            coordinates: zoneDraftMethod === "whole_block"
              ? geoJsonPolygonToLatLngs(selectedBlockContext.boundary)
              : draftCoordinates
          }) as SaveResponse;
      resetMapDrafts("select");
      return response.id ?? null;
    } finally {
      setIsSavingMapObject(false);
    }
  }

  async function saveEdit() {
    if (!canEditSelectedMapItem) {
      setMapNotice("You can only edit your own farm's map.");
      return;
    }
    if (!selection || editCoordinates.length < 3) {
      setMapNotice("A polygon needs at least 3 points.");
      return;
    }

    if (selection.type !== "zone" && !editName.trim()) {
      setMapNotice("Name is required.");
      return;
    }

    if (selection.type === "zone" && editPlannedUse === "cover_crop" && !editCoverCropChoice && !editCoverCropName.trim()) {
      setMapNotice("Select or add a cover crop name.");
      return;
    }

    try {
      setIsSavingMapObject(true);
      setMapNotice("Saving...");

      let response: SaveResponse | undefined;
      if (selection.type === "field") {
        response = await api.updateField(selection.id, {
          name: editName.trim(),
          notes: editNotes.trim(),
          coordinates: editCoordinates
        }) as SaveResponse;
      } else if (selection.type === "block") {
        response = await api.updateBlock(selection.id, {
          name: editName.trim(),
          notes: editNotes.trim(),
          coordinates: editCoordinates
        }) as SaveResponse;
      } else {
        const zoneBlockId = selectedZone?.blockId;
        const zoneCount = zoneBlockId ? data.blockZones.filter((zone) => zone.blockId === zoneBlockId).length : 0;
        const selectedCoverCropLabel = editCoverCropChoice === "__new__"
          ? editCoverCropName.trim()
          : data.coverCropNames.find((item) => String(item.id) === editCoverCropChoice)?.name ?? null;
        response = await api.updateBlockZone(selection.id, {
          name: editName.trim() || selectedZone?.name || defaultZoneName({
            plannedUse: editPlannedUse,
            explicitName: "",
            coverCropLabel: selectedCoverCropLabel,
            existingCount: zoneCount
          }),
          plannedUse: editPlannedUse,
          actualState: editActualState,
          coverCropNameId: editPlannedUse === "cover_crop" && editCoverCropChoice && editCoverCropChoice !== "__new__"
            ? Number(editCoverCropChoice)
            : null,
          coverCropName: editPlannedUse === "cover_crop" && editCoverCropChoice === "__new__"
            ? editCoverCropName.trim()
            : null,
          plannedCoverCropSeedDate: editPlannedUse === "cover_crop" ? editCoverCropSeedDate || null : null,
          plannedCoverCropTerminateDate: editPlannedUse === "cover_crop" ? editCoverCropTerminateDate || null : null,
          actualCoverCropSeedDate: editPlannedUse === "cover_crop" ? selectedZone?.actualCoverCropSeedDate ?? null : null,
          actualCoverCropTerminateDate: editPlannedUse === "cover_crop" ? selectedZone?.actualCoverCropTerminateDate ?? null : null,
          notes: editNotes.trim(),
          coordinates: editCoordinates
        }) as SaveResponse;
      }

      await load();
      resetMapDrafts();
      setMapNotice(response?.warning ?? "Saved.");
    } catch (err) {
      console.error("Map object update failed", err);
      setMapNotice(mapSaveErrorMessage(err, selection?.type ?? "map item"));
    } finally {
      setIsSavingMapObject(false);
    }
  }

  async function deleteSelected() {
    if (!canPlan) {
      setMapNotice("Planner access required.");
      return;
    }
    if (!selection || !selectedMapItem) {
      return;
    }
    if (!selectedMapItemIsOwnFarm) {
      setMapNotice("You can only delete map items from your own farm.");
      return;
    }

    const confirmed = window.confirm(`Delete ${selection.type} "${selectedMapItem.name}"?`);
    if (!confirmed) {
      return;
    }

    try {
      setMapNotice("Deleting...");
      if (selection.type === "field") {
        await api.deleteField(selection.id);
      } else if (selection.type === "block") {
        await api.deleteBlock(selection.id);
      } else if (selection.type === "bed") {
        await api.deleteBed(selection.id);
      } else {
        await api.deleteBlockZone(selection.id);
      }

      setSelection(null);
      resetMapDrafts();
      await load();
      setMapNotice("Deleted.");
    } catch (err) {
      console.error("Delete failed", err);
      setMapNotice(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  async function handleLogin(username: string, password: string) {
    setError(null);
    const nextSession = await api.login({ username, password });
    setSession(nextSession);
    if (nextSession.authenticated) {
      await load(nextSession.user.role === "planner", nextSession.user.isAdmin, { allowAuthReset: false, authBootstrap: true });
    }
  }

  async function handleRegister(farmName: string, displayName: string, email: string, username: string, password: string) {
    setError(null);
    const nextSession = await api.register({
      farmName,
      displayName: displayName.trim() || null,
      email,
      username,
      password
    });
    setSession(nextSession);
    if (nextSession.authenticated) {
      await load(nextSession.user.role === "planner", nextSession.user.isAdmin, { allowAuthReset: false, authBootstrap: true });
    }
    return nextSession;
  }

  async function handleLogout() {
    await api.logout();
    setSession({ authenticated: false });
    setData(emptyDashboard);
    setSelection(null);
    setSelectedPlantingId(null);
    setSelectedTaskId(null);
    setSelectedFlowId(null);
    setFarmAccounts([]);
    setFeedbackReports([]);
    recentActivityRef.current = [];
    setMapNotice(null);
    setError(null);
    setLoading(false);
    setPrototypeWarningOpen(false);
    setTutorialOpen(false);
    setTutorialStatus(null);
    setTutorialStepIndex(0);
    setTutorialPlantingDraft(null);
    setTutorialFlowId(null);
  }

  function dismissPrototypeWarning() {
    if (session?.authenticated && typeof window !== "undefined") {
      window.localStorage.setItem(prototypeWarningStorageKey(session.user.id), PROTOTYPE_WARNING_VERSION);
    }
    setPrototypeWarningOpen(false);
  }

  function dismissTutorial() {
    if (session?.authenticated && typeof window !== "undefined") {
      window.localStorage.setItem(tutorialDismissedStorageKey(session.user.id), "true");
    }
    setTutorialOpen(false);
  }

  async function prepareCabbageTutorial(preferredBed?: { id: number; blockId: number } | null) {
    if (!canPlan || !data.farm?.id) {
      setTutorialStatus("Planner access is required.");
      return;
    }

    const plantableBed = preferredBed ?? ownBeds.find((bed) => bed.source !== "road") ?? null;
    if (!plantableBed) {
      setTutorialStepIndex(2);
      setTutorialStatus("Make a field, block, and beds first. Then come back and set up the cabbage sample.");
      setMapNotice("Make a field, block, and beds first. Then come back and set up the cabbage sample.");
      return;
    }

    try {
      setIsPreparingTutorial(true);
      setTutorialStatus("Preparing cabbage sample...");
      const existingSeed = ownSeedItems.find((seedItem) =>
        seedItem.cropType.toLowerCase() === "cabbage" &&
        (seedItem.varietyName ?? "").toLowerCase() === "tutorial cabbage"
      );
      if (existingSeed && existingSeed.daysToMaturity == null) {
        await api.updateSeedItem(existingSeed.id, {
          farmId: data.farm.id,
          family: existingSeed.family,
          cropType: existingSeed.cropType,
          varietyName: existingSeed.varietyName,
          breedName: existingSeed.breedName,
          supplier: existingSeed.supplier,
          catalogNumber: existingSeed.catalogNumber,
          lotNumber: existingSeed.lotNumber,
          stockQuantity: existingSeed.stockQuantity,
          daysToMaturity: 70,
          notes: existingSeed.notes
        });
      }
      const seedItem = existingSeed ?? await api.createSeedItem({
        farmId: data.farm.id,
        family: "Brassica",
        cropType: "Cabbage",
        varietyName: "Tutorial cabbage",
        breedName: null,
        supplier: "Loam Ledger tutorial",
        catalogNumber: null,
        lotNumber: "tutorial",
        stockQuantity: null,
        daysToMaturity: 70,
        notes: "Sample seed item for the first-account tutorial."
      });
      const cabbageCropId = seedItem.cropId;
      if (cabbageCropId == null) {
        throw new Error("Cabbage crop could not be prepared.");
      }

      const existingFlow = ownTaskFlowTemplates.find((flow) => flow.name === "Cabbage tutorial flow");
      let flowId = existingFlow?.id ?? null;
      if (flowId == null) {
        const nodes = [
          { nodeKey: "seed", taskType: "seed_in_tray", label: "Seed", anchor: "planned_sow", offsetDays: 0, iconColor: taskIconColor("seed_in_tray"), iconSecondaryColor: "#f4c430", tractorModel: null, tractorProfileId: null, x: 0.1, y: 0.52, notes: "Start cabbage in trays." },
          { nodeKey: "transplant", taskType: "transplant", label: "Transplant", anchor: "planned_transplant", offsetDays: 0, iconColor: taskIconColor("transplant"), iconSecondaryColor: "#f4c430", tractorModel: null, tractorProfileId: null, x: 0.28, y: 0.52, notes: "Move plants into the selected bed." },
          { nodeKey: "cultivation_1", taskType: "cultivate", label: "First cultivation", anchor: "actual_transplant", offsetDays: 7, iconColor: taskIconColor("cultivate"), iconSecondaryColor: "#f4c430", tractorModel: "canopy", tractorProfileId: null, x: 0.46, y: 0.32, notes: "First cultivation after transplanting." },
          { nodeKey: "cultivation_2", taskType: "cultivate", label: "Second cultivation", anchor: "actual_transplant", offsetDays: 14, iconColor: taskIconColor("cultivate"), iconSecondaryColor: "#f4c430", tractorModel: "canopy", tractorProfileId: null, x: 0.62, y: 0.52, notes: "This tutorial dates this task into the current week." },
          { nodeKey: "cultivation_3", taskType: "cultivate", label: "Third cultivation", anchor: "actual_transplant", offsetDays: 21, iconColor: taskIconColor("cultivate"), iconSecondaryColor: "#f4c430", tractorModel: "canopy", tractorProfileId: null, x: 0.78, y: 0.32, notes: "Final cultivation pass before canopy closes." },
          { nodeKey: "harvest", taskType: "harvest", label: "Harvest", anchor: "actual_transplant", offsetDays: 70, iconColor: taskIconColor("harvest"), iconSecondaryColor: "#f4c430", tractorModel: null, tractorProfileId: null, x: 0.9, y: 0.52, notes: "Harvest window begins." }
        ];
        const result = await api.createTaskFlow({
          farmId: data.farm.id,
          cropId: cabbageCropId,
          name: "Cabbage tutorial flow",
          notes: "Tutorial flow: Seed, Transplant, three cultivation steps, and Harvest. Add a Mow task after harvest during the tutorial.",
          isDefault: true,
          nodes,
          edges: [
            { fromNodeKey: "seed", toNodeKey: "transplant" },
            { fromNodeKey: "transplant", toNodeKey: "cultivation_1" },
            { fromNodeKey: "cultivation_1", toNodeKey: "cultivation_2" },
            { fromNodeKey: "cultivation_2", toNodeKey: "cultivation_3" },
            { fromNodeKey: "cultivation_3", toNodeKey: "harvest" }
          ]
        }) as { id?: number };
        flowId = result.id ?? null;
      }
      if (flowId == null) {
        throw new Error("Cabbage task flow could not be prepared.");
      }

      const tutorialWeekStart = startOfWeekDate(todayDateInputValue());
      const transplantDate = addDaysToDate(tutorialWeekStart, -14);
      const sowDate = addDaysToDate(transplantDate, -28);
      const harvestStart = addDaysToDate(transplantDate, 70);
      const harvestEnd = addDaysToDate(harvestStart, 14);
      await load(canPlan);
      setView("map");
      setMapWorkflowMode("planning");
      setMapPlantingBedIds([plantableBed.id]);
      setSelection({ type: "block", id: plantableBed.blockId });
      setSelectedFlowId(flowId);
      setTutorialFlowId(flowId);
      setTutorialPlantingDraft({
        id: `${flowId}-${Date.now()}`,
        cropId: cabbageCropId,
        varietyId: seedItem.varietyId ?? null,
        seedItemId: seedItem.id,
        taskFlowTemplateId: flowId,
        intendedBedId: plantableBed.id,
        locationScope: `block:${plantableBed.blockId}`,
        title: "Tutorial cabbage planting",
        plannedSowDate: sowDate,
        plannedTransplantDate: transplantDate,
        expectedHarvestStart: harvestStart,
        expectedHarvestEnd: harvestEnd,
        daysToHarvest: "70",
        spacingInRow: distanceUnit === "ft" ? "18" : "46",
        spacingBetweenRows: distanceUnit === "ft" ? "18" : "46",
        notes: `Tutorial sample. Dates put second cultivation in the week of ${formatWeekRange(tutorialWeekStart)}.`
      });
      setTaskListWeekStart(tutorialWeekStart);
      setSelectedMapWeekStart(tutorialWeekStart);
      setTutorialStepIndex(3);
      setTutorialStatus("Cabbage sample loaded in the map-side New Planting form. Enter plant count and create the planting.");
    } catch (error) {
      setTutorialStatus(error instanceof Error ? error.message : "Could not prepare tutorial sample.");
    } finally {
      setIsPreparingTutorial(false);
    }
  }

  function selectFirstPastTutorialTask() {
    const currentWeekStart = startOfWeekDate(todayDateInputValue());
    const task = data.tasks
      .filter((item) =>
        item.status !== "done" &&
        item.scheduledDate != null &&
        item.scheduledDate < currentWeekStart &&
        (item.plantingTitle?.toLowerCase().includes("tutorial cabbage") ?? false)
      )
      .sort((left, right) => (left.scheduledDate ?? "").localeCompare(right.scheduledDate ?? ""))[0]
      ?? null;
    if (!task) {
      setTutorialStatus("No past tutorial tasks are waiting. Create the cabbage planting first, or the past work may already be recorded.");
      return;
    }
    openTaskRecordFromMap(task);
    setTutorialStatus("The past task is open on the map in Work mode. Record it using the scheduled date shown.");
  }

  async function handleTaskRecordSave() {
    const completedTaskId = selectedTaskId;
    await load();
    if (tutorialOpen && tutorialStepIndex === 5) {
      const currentWeekStart = startOfWeekDate(todayDateInputValue());
      const nextPastTask = data.tasks
        .filter((item) =>
          item.id !== completedTaskId &&
          item.status !== "done" &&
          item.scheduledDate != null &&
          item.scheduledDate < currentWeekStart &&
          (item.plantingTitle?.toLowerCase().includes("tutorial cabbage") ?? false)
        )
        .sort((left, right) => (left.scheduledDate ?? "").localeCompare(right.scheduledDate ?? ""))[0]
        ?? null;
      if (nextPastTask) {
        selectTask(nextPastTask);
        setTutorialStatus("Past task recorded. The next past tutorial task is selected on the map; record it from the highlighted Record task button.");
      } else {
        setTutorialStepIndex(6);
        setMapWorkflowMode("planning");
        setTutorialStatus("Past tutorial tasks are recorded. Leave this week's second cultivation open. Last, use the highlighted Annual Crop Plan navigation to see the spreadsheet uploader.");
      }
    }
  }

  function renderTaskRecordCard(task: Task | null) {
    return (
      <TaskRecordCard
        task={task}
        plantings={data.plantings}
        seedItems={data.seedItems}
        placements={data.placements}
        fields={ownFields}
        blocks={ownBlocks}
        beds={ownBeds}
        bedPresets={data.bedPresets}
        distanceUnit={distanceUnit}
        canAdjustPlanting={canPlan}
        highlightSubmit={activeTutorialStep === 5}
        onSave={handleTaskRecordSave}
      />
    );
  }

  function startTutorialFromBeginning() {
    if (isMobileViewport) {
      setTutorialOpen(false);
      setTutorialStatus(null);
      return;
    }

    setTutorialStatus(null);
    setTutorialStepIndex(0);
    setTutorialFlowId(null);
    setTutorialOpen(true);
  }

  if (sessionLoading) {
    return <div className={`auth-shell theme-${themeMode}`}><div className="card auth-card"><h2>Loading</h2><p className="muted">Checking your Loam Ledger session.</p></div></div>;
  }

  if (!session?.authenticated) {
    return <LoginScreen error={error} onLogin={handleLogin} onRegister={handleRegister} themeMode={themeMode} />;
  }

  const viewLabels = new Map<View, string>([
    ["map", "Farm Map"],
    ["plan", "Annual Crop Plan"],
    ["planting", "Planting Detail"],
    ["tasks", "Task List"],
    ["flows", "Task Flows"],
    ["seed-bank", "Seed Bank"],
    ["record", "Record Work"],
    ["harvests", "Harvest Log"],
    ["settings", "Settings"],
    ["admin", "Admin"]
  ]);
  const mainToolbarNavItems: Array<[View, string]> = [
    ["map", "Map"],
    ["tasks", "Tasks"],
    ...(canPlan ? [
      ["plan", "Annual Crop Plan"],
      ["flows", "Task Flows"],
      ["seed-bank", "Seed Bank"]
    ] as Array<[View, string]> : [])
  ];
  const utilityToolbarNavItems: Array<[View, string]> = [
    ["settings", "Settings"],
    ...(!isMobileViewport && isAdmin ? [["admin", "Admin"]] as Array<[View, string]> : [])
  ];

  const viewTitle = view === "map"
    ? "Farm Map"
    : view === "plan"
      ? "Annual Crop Plan"
      : view === "planting"
        ? "Planting Detail"
        : view === "tasks"
          ? "Task List"
          : view === "flows"
            ? "Task Flows"
            : view === "seed-bank"
              ? "Seed Bank"
              : view === "record"
                ? "Record Work"
                : view === "settings"
                  ? "Settings"
                  : view === "admin"
                    ? "Admin Control Panel"
                    : "Harvest Log / Summary";

  const tutorialSteps = [
    {
      title: "Find the land",
      body: "Use the aerial map to find the land you want to use. Draw a Field around the outside; roughly follow the field edge. A little too big is fine, but too small can cause problems later.",
      clickTarget: "Click the highlighted Draw field button in the map toolbar. Then click around the field edge on the map and click Save."
    },
    {
      title: "Make a block",
      body: "Select the Field you just made, then draw a Block. The Block should be very close to the outside edge of the beds.",
      clickTarget: "Click your Field on the map first. Then click the highlighted Draw block button, draw around the bed area, and click Save."
    },
    {
      title: "Fill the block with beds",
      body: "Select the Block, choose or save a bed preset, pick the block edge, then fill the block with beds.",
      clickTarget: "Click your Block on the map. Then click the highlighted Generate beds button. Inside bed tools, use the highlighted Pick block edge and Fill block controls."
    },
    {
      title: "Plan cabbage",
      body: "Create the sample cabbage planting from the map. The dates are filled so the second cultivation is due this week. In the map-side New Planting form, enter the plant count, then create the planting.",
      clickTarget: "Use the New Planting form beside the map. Type the plant count, then click the highlighted Create planting button."
    },
    {
      title: "Edit the task flow",
      body: "Open the cabbage flow. It starts with Seed, Transplant, three cultivation steps, and Harvest. Add a Mow task after the harvest window and link it after Harvest.",
      clickTarget: "In the flow editor, click the highlighted Add node button. Set Task type to mow, set Anchor to actual harvest, then use Link on Harvest to connect it to Mow."
    },
    {
      title: "Record past work",
      body: "After the planting is created, come back to the map in Work mode and record the Seed, Transplant, and first cultivation as already done. The Date is set to each task's scheduled date. Leave the current-week second cultivation open so it appears in this week's tasks.",
      clickTarget: "Use the Record from task panel beside the map. Check that Date matches the scheduled date shown in the tutorial bubble, then click the highlighted Record task button. Repeat for the past tasks only."
    },
    {
      title: "Find spreadsheet import",
      body: "The spreadsheet uploader is on the Annual Crop Plan page. You do not need to import anything during this tutorial; this step just shows where it is for later.",
      clickTarget: "Click the highlighted Annual Crop Plan navigation if needed, then look for the highlighted Import crop plan spreadsheet panel."
    }
  ];
  const currentTutorialStepIndex = Math.min(tutorialStepIndex, tutorialSteps.length - 1);
  const currentTutorialStep = tutorialSteps[currentTutorialStepIndex];
  const activeTutorialStep = tutorialOpen && !isMobileViewport ? currentTutorialStepIndex : -1;
  const tutorialTargetView: View | null = activeTutorialStep >= 0
    ? activeTutorialStep <= 2
      ? "map"
      : activeTutorialStep === 3
        ? "map"
        : activeTutorialStep === 4
          ? "flows"
        : activeTutorialStep === 5
            ? "map"
            : "plan"
    : null;
  const tutorialMapPlanningReady = view === "map" && mapWorkflowMode === "planning";
  const tutorialHighlightNav = (targetView: View) => tutorialTargetView === targetView && view !== targetView;
  const tutorialHighlightPlanningMode = activeTutorialStep >= 0 && activeTutorialStep <= 2 && view === "map" && mapWorkflowMode !== "planning";
  const tutorialHighlightWorkMode = activeTutorialStep === 5 && view === "map" && mapWorkflowMode !== "field_work";
  const tutorialHighlightMapSelect = tutorialMapPlanningReady
    && (
      (activeTutorialStep === 1 && !selectedField && mapMode !== "select")
      || (activeTutorialStep === 2 && !selectedBlockContext && mapMode !== "select")
    );
  const tutorialHighlightDrawField = activeTutorialStep === 0 && tutorialMapPlanningReady && mapMode !== "draw_field";
  const tutorialHighlightDrawBlock = activeTutorialStep === 1 && tutorialMapPlanningReady && selectedField != null && mapMode !== "draw_block";
  const tutorialHighlightGenerateBeds = activeTutorialStep === 2
    && tutorialMapPlanningReady
    && selectedBlockContext != null
    && mapMode !== "bed_tools"
    && mapMode !== "pick_bed_edge"
    && mapMode !== "draw_bed_line";
  const tutorialHighlightDraftSave = tutorialMapPlanningReady
    && (
      (activeTutorialStep === 0 && mapMode === "draw_field")
      || (activeTutorialStep === 1 && mapMode === "draw_block")
    )
    && draftCoordinates.length >= 3
    && Boolean(draftName.trim());
  const tutorialHighlightDraftName = tutorialMapPlanningReady
    && (
      (activeTutorialStep === 0 && mapMode === "draw_field")
      || (activeTutorialStep === 1 && mapMode === "draw_block")
    )
    && draftCoordinates.length >= 3
    && !draftName.trim();
  const tutorialHighlightMapSurface = tutorialMapPlanningReady
    && (
      (activeTutorialStep === 0 && mapMode === "draw_field" && draftCoordinates.length < 3)
      || (activeTutorialStep === 1 && !selectedField && mapMode === "select")
      || (activeTutorialStep === 1 && mapMode === "draw_block" && draftCoordinates.length < 3)
      || (activeTutorialStep === 2 && !selectedBlockContext && mapMode === "select")
      || (activeTutorialStep === 2 && mapMode === "pick_bed_edge" && bedLineCoordinates.length < 2)
      || (activeTutorialStep === 2 && mapMode === "draw_bed_line" && bedLineCoordinates.length < 2)
    );
  const tutorialTargetClass = (isTarget: boolean) => isTarget ? " tutorial-target" : "";
  const tutorialFlowNeedsSelection = activeTutorialStep === 4
    && view === "flows"
    && tutorialFlowId != null
    && selectedFlowId !== tutorialFlowId;
  const currentTutorialClickTarget = () => {
    if (tutorialTargetView != null && view !== tutorialTargetView) {
      const navLabel = tutorialTargetView === "map" ? "Map" : viewLabels.get(tutorialTargetView) ?? tutorialTargetView;
      return `Click the highlighted ${navLabel} button.`;
    }

    if (activeTutorialStep >= 0 && activeTutorialStep <= 2 && view === "map" && mapWorkflowMode !== "planning") {
      return "Click the highlighted Plan button in the map toolbar.";
    }

    if (activeTutorialStep === 5 && view === "map" && mapWorkflowMode !== "field_work") {
      return "Click the highlighted Work button in the map toolbar.";
    }

    if (activeTutorialStep === 0) {
      if (mapMode !== "draw_field") {
        return "Click the highlighted Draw field button in the map toolbar.";
      }
      if (draftCoordinates.length < 3) {
        return "Click around the field edge on the highlighted map. Use at least three points.";
      }
      if (!draftName.trim()) {
        return "Enter a field name in the highlighted Name field.";
      }
      return "Click the highlighted Save button.";
    }

    if (activeTutorialStep === 1) {
      if (!selectedField) {
        return "Click the field you just saved on the map. The Draw block button appears after a field is selected.";
      }
      if (mapMode !== "draw_block") {
        return "Click the highlighted Draw block button in the map toolbar.";
      }
      if (draftCoordinates.length < 3) {
        return "Click around the bed area on the highlighted map. Use at least three points.";
      }
      if (!draftName.trim()) {
        return "Enter a block name in the highlighted Name field.";
      }
      return "Click the highlighted Save button.";
    }

    if (activeTutorialStep === 2) {
      if (!selectedBlockContext) {
        return "Click the block you just saved on the map. The Generate beds button appears after a block is selected.";
      }
      if (mapMode !== "bed_tools" && mapMode !== "pick_bed_edge" && mapMode !== "draw_bed_line") {
        return "Click the highlighted Generate beds button in the map toolbar.";
      }
      if (bedLineCoordinates.length < 2) {
        return mapMode === "pick_bed_edge" || mapMode === "draw_bed_line"
          ? "Click the highlighted map on the block edge beds should build from."
          : "Click the highlighted Pick block edge button.";
      }
      return "Click the highlighted Fill remaining block button.";
    }

    if (activeTutorialStep === 3) {
      if (mapPlantingBeds.length === 0) {
        return "Use the highlighted Generate beds step first; the tutorial selects the first generated bed for cabbage.";
      }
      return "In the map-side New Planting form, type the plant count, then click the highlighted Create planting button.";
    }

    if (activeTutorialStep === 4) {
      if (tutorialFlowNeedsSelection) {
        return "Click the highlighted Cabbage tutorial flow in the reusable task flows list.";
      }
        return "Click the highlighted Add node button. Set the new node to mow, link Harvest to Mow, then save the flow.";
    }

    if (activeTutorialStep === 5) {
      return "Check the Date shown in the Record from task panel beside the map. It should match the tutorial bubble. Then fill any highlighted bed or plant-count field and click Record task.";
    }

    if (activeTutorialStep === 6) {
      return "This highlighted panel is the spreadsheet uploader. You do not need to click it now; it is here for importing a prepared crop plan later.";
    }

    return currentTutorialStep.clickTarget;
  };
  const mapIsPointSelectionMode = isPointSelectionMapMode(mapMode);

  return (
    <div className={`app-shell theme-${themeMode}${isMobileViewport ? " mobile-shell" : ""}`}>
      <main className="main-panel">
        <header className="topbar">
          <div className="header-actions">
            <div className="toolbar-left">
              {mainToolbarNavItems.length > 0 && (
                <div className="toolbar-nav" aria-label="Main navigation">
                  {mainToolbarNavItems.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`${view === value ? "primary-button" : "secondary-button"} compact-button${tutorialTargetClass(tutorialHighlightNav(value))}`}
                      onClick={() => setView(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="toolbar-right">
              {!isMobileViewport && (
                <>
                  <button
                    className="secondary-button"
                    disabled={undoSnapshots.length === 0}
                    title={undoSnapshots[0] ? `Undo: ${undoSnapshots[0].label}` : "Nothing to undo yet"}
                    onClick={() => void undoLastChange()}
                  >
                    Undo
                  </button>
                  <button
                    className="secondary-button"
                    disabled={redoSnapshots.length === 0}
                    title={redoSnapshots[0] ? `Redo: ${redoSnapshots[0].label}` : "Nothing to redo yet"}
                    onClick={() => void redoLastChange()}
                  >
                    Redo
                  </button>
                </>
              )}
              {utilityToolbarNavItems.length > 0 && (
                <div className="toolbar-nav" aria-label="Settings navigation">
                  {utilityToolbarNavItems.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`${view === value ? "primary-button" : "secondary-button"} compact-button${tutorialTargetClass(tutorialHighlightNav(value))}`}
                      onClick={() => setView(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <span className="small-chip">
                {session.user.displayName ?? session.user.username} • {session.user.isAdmin ? "admin" : roleLabel(session.user.role)} • {session.user.farmName}
              </span>
            </div>
          </div>
          {view === "map" && (
            <div className="map-tools-actions toolbar-map-tools" aria-label="Map tools">
              <div className="map-workflow-toggle toolbar-workflow-toggle" aria-label="Map workflow">
                <button
                  type="button"
                  className={`${mapWorkflowMode === "planning" ? "primary-button" : "secondary-button"} compact-button${tutorialTargetClass(tutorialHighlightPlanningMode)}`}
                  onClick={() => changeMapWorkflowMode("planning")}
                  disabled={!canPlan}
                >
                  Plan
                </button>
                <button
                  type="button"
                  className={`${mapWorkflowMode === "field_work" ? "primary-button" : "secondary-button"} compact-button${tutorialTargetClass(tutorialHighlightWorkMode)}`}
                  onClick={() => changeMapWorkflowMode("field_work")}
                >
                  Work
                </button>
              </div>
              {mapWorkflowMode === "planning" && (
                <>
                  <button className={`${mapMode === "select" ? "primary-button" : "secondary-button"} compact-button${tutorialTargetClass(tutorialHighlightMapSelect)}`} onClick={() => resetMapDrafts("select")}>Select</button>
                  <button className={`${mapMode === "draw_field" ? "primary-button" : "secondary-button"} compact-button${tutorialTargetClass(tutorialHighlightDrawField)}`} onClick={startDrawField} disabled={!canPlan}>Draw field</button>
                  <button className={`${mapMode === "draw_block" ? "primary-button" : "secondary-button"} compact-button${tutorialTargetClass(tutorialHighlightDrawBlock)}`} onClick={startDrawBlock} disabled={!canPlan || !selectedField || !selectedFieldIsOwnFarm}>Draw block</button>
                  <button className={`${mapMode === "edit" ? "primary-button" : "secondary-button"} compact-button`} onClick={startEditSelection} disabled={!canEditSelectedMapItem}>Edit field/block</button>
                  <button
                    className={`${mapMode === "bed_tools" || mapMode === "pick_bed_edge" || mapMode === "draw_bed_line" ? "primary-button" : "secondary-button"} compact-button`}
                    onClick={openSelectedBlockBedMaker}
                    disabled={!selectedBlockContext || !canEditSelectedBlockContext}
                  >
                    Make beds
                  </button>
                </>
              )}
            </div>
          )}
        </header>

        {feedbackOpen && (
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
            <div className="card feedback-dialog">
              <h2 id="feedback-title">Suggestion/problem</h2>
              <p className="muted">Comment is optional. Submitting also saves this page, selected item, map date, and a short recent activity trail.</p>
              <form className="mini-form" onSubmit={submitFeedback}>
                <label>
                  <span>Comment</span>
                  <textarea
                    rows={5}
                    value={feedbackComment}
                    onChange={(event) => setFeedbackComment(event.target.value)}
                    placeholder="What happened, or what would make this page better?"
                  />
                </label>
                {feedbackStatus && <p className="muted"><strong>{feedbackStatus}</strong></p>}
                <div className="button-row">
                  <button className="primary-button" type="submit" disabled={isSavingFeedback}>
                    {isSavingFeedback ? "Saving..." : "Submit suggestion/problem"}
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => {
                      setFeedbackOpen(false);
                      setFeedbackStatus(null);
                    }}
                    disabled={isSavingFeedback}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {prototypeWarningOpen && (
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="prototype-warning-title">
            <div className="card prototype-warning-dialog">
              <p className="eyebrow">Beta testing</p>
              <h2 id="prototype-warning-title">Loam Ledger is in beta</h2>
              <p>
                Bugs or incorrect results are still possible while testing continues.
              </p>
              <p>
                If something looks wrong, please share feedback so it can be fixed.
              </p>
              <button className="primary-button full-span" type="button" onClick={dismissPrototypeWarning}>
                I understand
              </button>
            </div>
          </div>
        )}

        {canPlan && tutorialOpen && !isMobileViewport && (
          <section className="card tutorial-card" aria-labelledby="tutorial-title">
            <div className="section-header">
              <div className="title-block">
                <p className="eyebrow">First account tutorial</p>
                <h2 id="tutorial-title">{currentTutorialStep.title}</h2>
                <p className="muted">
                  Step {currentTutorialStepIndex + 1} of {tutorialSteps.length}
                </p>
              </div>
              <button type="button" className="secondary-button compact-button" onClick={dismissTutorial}>Hide</button>
            </div>
            {tutorialStatus && <p className="muted"><strong>{tutorialStatus}</strong></p>}
            <article className="tutorial-current-step">
              <p>{currentTutorialStep.body}</p>
              <div className="instruction-box tutorial-click-target">
                <strong>What to click:</strong> {currentTutorialClickTarget()}
              </div>
              <div className="button-row">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={currentTutorialStepIndex === 0}
                  onClick={() => {
                    setTutorialStatus(null);
                    setTutorialStepIndex((current) => Math.max(0, current - 1));
                  }}
                >
                  Back
                </button>
              </div>
            </article>
          </section>
        )}

        {view === "map" && (
          <section className="content-grid map-grid">
            <div className="map-main-stack">
              <div className={`card map-card${tutorialTargetClass(tutorialHighlightMapSurface)}`}>
                <MapContainer
                  className={mapIsPointSelectionMode ? "point-select-map" : undefined}
                  center={initialView.center}
                  zoom={initialView.zoom}
                  minZoom={3}
                  maxZoom={24}
                  attributionControl={false}
                  style={{ height: "100%", width: "100%" }}
                  zoomSnap={0.25}
                  doubleClickZoom={false}
                >
                  <AttributionControl position="bottomright" prefix={false} />
                  <ResponsiveBasemap />
                  <MapZoomTracker onZoomChange={setMapZoom} />
                  <FitToFarm fields={visibleFields} blocks={visibleBlocks} />
                  <PersistMapView />
                  <FocusSelection
                    selection={selection}
                    fields={visibleFields}
                    blocks={visibleBlocks}
                    zones={visibleBlockZones}
                    beds={visibleBeds}
                    disabled={mapWorkflowMode === "field_work"}
                  />
                  <FocusUserLocation location={userLocation} />
                  <MapDrawingEvents
                    mode={mapMode}
                    onAddPoint={(point) => {
                      if (mapMode === "draw_bed_line") {
                        if (pointIsInSelectedBlock(point)) {
                          addBedLinePoint(point);
                        }
                        return;
                      }
                      if (mapMode === "draw_zone_split") {
                        if (pointIsInSelectedBlock(point)) {
                          addZoneSplitPoint(point);
                        }
                        return;
                      }
                      setDraftCoordinates((current) => {
                        if (current.length >= 50) {
                          setMapNotice("Polygon limit reached. Save or Cancel this draft.");
                          return current;
                        }
                        return [...current, point];
                      });
                      setMapNotice(null);
                    }}
                    onClearSelection={() => {
                      if (mapMode === "select") {
                        setMapPlantingBedIds([]);
                        setSelection(null);
                      }
                    }}
                  />
                  <MapLineDragEvents
                    activeLineIndex={zoneSplitDraggingLineIndex}
                    onMoveLine={(lineIndex, point) => {
                      setZoneSplitCoordinates((current) => current.map((item, index) => index === lineIndex ? point : item));
                    }}
                    onStopDrag={() => setZoneSplitDraggingLineIndex(null)}
                  />

                {visibleFields.map((field) => {
                  const positions = polygonPositions(geoJsonPolygonToLatLngs(field.boundary));
                  if (positions.length < 3) return null;
                  return (
                    <Polygon
                      key={`field-${field.id}`}
                      positions={positions}
                      bubblingMouseEvents={false}
                      pathOptions={fieldStyle(selection?.type === "field" && selection.id === field.id)}
                      eventHandlers={{
                        click: (event) => {
                          if (mapMode === "pick_bed_edge") {
                            return;
                          }
                          if (mapMode === "draw_block" && selectedField?.id === field.id) {
                            setDraftCoordinates((current) => {
                              if (current.length >= 50) {
                                setMapNotice("Polygon limit reached. Save or Cancel this draft.");
                                return current;
                              }
                              return [...current, { lat: event.latlng.lat, lng: event.latlng.lng }];
                            });
                            setMapNotice(null);
                            return;
                          }
                          const point = { lat: event.latlng.lat, lng: event.latlng.lng };
                          if (mapMode === "draw_bed_line") {
                            if (pointIsInSelectedBlock(point)) {
                              addBedLinePoint(point);
                            }
                            return;
                          }
                          if (mapMode === "draw_zone_split") {
                            if (pointIsInSelectedBlock(point)) {
                              addZoneSplitPoint(point);
                            }
                            return;
                          }
                          if (isPointSelectionMapMode(mapMode)) {
                            return;
                          }

                          runMapSelectClick(() => selectMapObject({ type: "field", id: field.id }));
                        },
                        dblclick: (event) => {
                          stopMapDoubleClick(event);
                          if (mapMode !== "select") {
                            return;
                          }
                          clearPendingMapSingleClick();
                          selectFieldBlockCycle(field, { lat: event.latlng.lat, lng: event.latlng.lng });
                        }
                      }}
                    >
                      <Tooltip permanent direction="top" offset={[0, -18]} className="polygon-label field-map-label">
                        {mapObjectLabel(field.name)}
                      </Tooltip>
                    </Polygon>
                  );
                })}

                {visibleBlocks.map((block) => {
                  const positions = polygonPositions(geoJsonPolygonToLatLngs(block.boundary));
                  if (positions.length < 3) return null;
                  return (
                    <Polygon
                      key={`block-${block.id}`}
                      positions={positions}
                      bubblingMouseEvents={false}
                      pathOptions={blockStyle(selection?.type === "block" && selection.id === block.id)}
                      eventHandlers={{
                        click: (event) => {
                          if (mapMode === "pick_bed_edge") {
                            return;
                          }
                          if (mapMode === "draw_bed_line" && selectedBlockContext?.id === block.id) {
                            addBedLinePoint({ lat: event.latlng.lat, lng: event.latlng.lng });
                            return;
                          }
                          if (mapMode === "draw_zone" && selectedBlockContext?.id === block.id) {
                            setDraftCoordinates((current) => {
                              if (current.length >= 50) {
                                setMapNotice("Polygon limit reached. Save or Cancel this draft.");
                                return current;
                              }
                              return [...current, { lat: event.latlng.lat, lng: event.latlng.lng }];
                            });
                            setMapNotice(null);
                            return;
                          }
                          if (mapMode === "draw_zone_split" && selectedBlockContext?.id === block.id) {
                            addZoneSplitPoint({ lat: event.latlng.lat, lng: event.latlng.lng });
                            return;
                          }
                          if (isPointSelectionMapMode(mapMode)) {
                            return;
                          }
                          if (mapMode === "bed_tools" && ownBeds.some((bed) => bed.blockId === block.id && bed.source !== "road")) {
                            resetMapDrafts("select");
                          }

                          runMapSelectClick(() => selectMapObject({ type: "block", id: block.id }));
                        },
                        dblclick: (event) => {
                          stopMapDoubleClick(event);
                          if (mapMode !== "select") {
                            return;
                          }
                          clearPendingMapSingleClick();
                          selectBlockFieldCycle(block);
                        }
                      }}
                    >
                      <Tooltip permanent direction="bottom" offset={[0, 14]} className="polygon-label block-map-label">
                        {mapObjectLabel(block.name)}
                      </Tooltip>
                    </Polygon>
                  );
                })}

                {visibleBlockZones.map((zone) => {
                  const positions = polygonPositions(geoJsonPolygonToLatLngs(zone.boundary));
                  if (positions.length < 3) return null;
                  const parentBlock = data.blocks.find((block) => block.id === zone.blockId) ?? null;
                  const zoneLabel = mapObjectLabel(zone.name);
                  const parentBlockLabel = parentBlock ? mapObjectLabel(parentBlock.name) : null;
                  const showZoneLabel = zoneLabel && zoneLabel !== parentBlockLabel;
                  return (
                    <Polygon
                      key={`zone-${zone.id}`}
                      positions={positions}
                      bubblingMouseEvents={false}
                      pathOptions={zoneStyle(zone.plannedUse, selection?.type === "zone" && selection.id === zone.id)}
                      eventHandlers={{
                        click: (event) => {
                          if (mapMode === "pick_bed_edge") {
                            return;
                          }
                          if (mapMode === "draw_bed_line" && selectedBlockContext?.id === zone.blockId) {
                            addBedLinePoint({ lat: event.latlng.lat, lng: event.latlng.lng });
                            return;
                          }
                          if (mapMode === "draw_zone_split" && selectedBlockContext?.id === zone.blockId) {
                            addZoneSplitPoint({ lat: event.latlng.lat, lng: event.latlng.lng });
                            return;
                          }
                          if (isPointSelectionMapMode(mapMode)) {
                            return;
                          }
                          runMapSelectClick(() => selectMapObject({ type: "zone", id: zone.id }, zone.blockId));
                        },
                        dblclick: (event) => {
                          stopMapDoubleClick(event);
                          if (mapMode !== "select" || !parentBlock) {
                            return;
                          }
                          clearPendingMapSingleClick();
                          selectBlockFieldCycle(parentBlock);
                        }
                      }}
                    >
                      {showZoneLabel && (
                        <Tooltip permanent direction="center" className="polygon-label">
                          {zoneLabel}
                        </Tooltip>
                      )}
                    </Polygon>
                  );
                })}

                {showBedGeometryAtZoom && visibleBeds.map((bed) => {
                  const positions = polygonPositions(geoJsonPolygonToLatLngs(bed.boundary));
                  if (positions.length < 3) return null;
                  const bedIsSelectable = mapWorkflowMode === "field_work";
                  return (
                    <Polygon
                      key={`bed-${bed.id}`}
                      positions={positions}
                      interactive={bedIsSelectable}
                      bubblingMouseEvents={false}
                      pathOptions={bedStyle((selection?.type === "bed" && selection.id === bed.id) || mapPlantingBedIds.includes(bed.id) || workSelectedBedIds.includes(bed.id), bed.source === "road")}
                      eventHandlers={{
                        click: (event) => {
                          if (mapMode === "pick_bed_edge") {
                            return;
                          }
                          if (mapMode === "draw_bed_line" && selectedBlockContext?.id === bed.blockId) {
                            addBedLinePoint({ lat: event.latlng.lat, lng: event.latlng.lng });
                            return;
                          }
                          if (mapMode === "draw_zone_split" && selectedBlockContext?.id === bed.blockId) {
                            addZoneSplitPoint({ lat: event.latlng.lat, lng: event.latlng.lng });
                            return;
                          }
                          if (isPointSelectionMapMode(mapMode)) {
                            return;
                          }
                          const originalEvent = event.originalEvent as MouseEvent | undefined;
                          selectBedOnMap(bed, { togglePlantingSelection: Boolean(originalEvent?.ctrlKey || originalEvent?.metaKey) });
                        }
                      }}
                    >
                      <Tooltip direction="center" className="polygon-label bed-label">
                        {mapObjectLabel(bed.name)}
                      </Tooltip>
                    </Polygon>
                  );
                })}

                {showPlannedPlantingsLayer && showCropSectionsAtZoom && data.beds.map((bed) => {
                  const planned = plannedPlantingsByBed.get(bed.id);
                  if (!planned || planned.length === 0) {
                    return null;
                  }

                  const positions = polygonPositions(geoJsonPolygonToLatLngs(bed.boundary));
                  if (positions.length < 3) {
                    return null;
                  }

                  const plantingColor = plantingMapColorForOrder(bed.sequenceNo ?? bed.id);
                  return (
                    <Polygon
                      key={`planned-overlay-${bed.id}`}
                      positions={positions}
                      interactive={mapWorkflowMode === "field_work" && !isPointSelectionMapMode(mapMode)}
                      bubblingMouseEvents={false}
                      pathOptions={plantingOverlayStyleForColor(plantingColor, mapWorkflowMode === "field_work" && !isPointSelectionMapMode(mapMode) ? "map-work-select-path" : undefined)}
                      eventHandlers={{
                        click: () => {
                          if (mapWorkflowMode !== "field_work" || isPointSelectionMapMode(mapMode)) {
                            return;
                          }
                          const planting = planned[0] ?? null;
                          if (planting) {
                            selectPlantingOnMap(planting, bed);
                          } else {
                            selectBedOnMap(bed);
                          }
                        }
                      }}
                    />
                  );
                })}

                {showPlannedPlantingsLayer && showCropSectionsAtZoom && plannedPlacementOverlays.map((overlay) => {
                  if (selectedBlockPlacementColorsActive && overlay.blockId === selectedBlockContext?.id) {
                    return null;
                  }
                  const positions = polygonPositions(geoJsonPolygonToLatLngs(overlay.overlayBoundary));
                  if (positions.length < 3) {
                    return null;
                  }

                  return (
                    <Polygon
                      key={overlay.key}
                      positions={positions}
                      interactive={mapWorkflowMode === "field_work" && !isPointSelectionMapMode(mapMode)}
                      bubblingMouseEvents={false}
                      pathOptions={overlay.isGap ? {
                        color: "#84776b",
                        fillColor: "#d6d0c6",
                        fillOpacity: 0.42,
                        weight: 1.5,
                        dashArray: "5 4",
                        className: mapWorkflowMode === "field_work" && !isPointSelectionMapMode(mapMode) ? "map-work-select-path" : undefined
                      } : plantingOverlayStyleForColor(overlay.color, mapWorkflowMode === "field_work" && !isPointSelectionMapMode(mapMode) ? "map-work-select-path" : undefined)}
                      eventHandlers={{
                        click: () => {
                          if (mapWorkflowMode !== "field_work" || isPointSelectionMapMode(mapMode)) {
                            return;
                          }
                          const bed = bedsById.get(overlay.bedId) ?? null;
                          const planting = overlay.plantingId != null ? plantingsById.get(overlay.plantingId) ?? null : null;
                          if (planting) {
                            selectPlantingOnMap(planting, bed);
                          } else if (bed) {
                            selectBedOnMap(bed);
                          }
                        }
                      }}
                    />
                  );
                })}

                {selectedBlockPlacementColorsActive && showCropSectionsAtZoom && selectedBlockPlacementColorOverlays.map((overlay) => {
                  const positions = polygonPositions(geoJsonPolygonToLatLngs(overlay.overlayBoundary));
                  if (positions.length < 3) {
                    return null;
                  }

                  return (
                    <Polygon
                      key={overlay.key}
                      positions={positions}
                      interactive={mapWorkflowMode === "field_work" && !isPointSelectionMapMode(mapMode)}
                      bubblingMouseEvents={false}
                      pathOptions={overlay.isGap ? {
                        color: "#84776b",
                        fillColor: "#d6d0c6",
                        fillOpacity: 0.42,
                        weight: 1.5,
                        dashArray: "5 4",
                        className: mapWorkflowMode === "field_work" && !isPointSelectionMapMode(mapMode) ? "map-work-select-path" : undefined
                      } : plantingOverlayStyleForColor(overlay.color, mapWorkflowMode === "field_work" && !isPointSelectionMapMode(mapMode) ? "map-work-select-path" : undefined)}
                      eventHandlers={{
                        click: () => {
                          if (mapWorkflowMode !== "field_work" || isPointSelectionMapMode(mapMode)) {
                            return;
                          }
                          const bed = bedsById.get(overlay.bedId) ?? null;
                          const planting = overlay.plantingId != null ? plantingsById.get(overlay.plantingId) ?? null : null;
                          if (planting) {
                            selectPlantingOnMap(planting, bed);
                          } else if (bed) {
                            selectBedOnMap(bed);
                          }
                        }
                      }}
                    />
                  );
                })}

                {showActualPlacementsLayer && showCropSectionsAtZoom && actualPlacementOverlays.map((overlay) => {
                  const positions = polygonPositions(geoJsonPolygonToLatLngs(overlay.overlayBoundary));
                  if (positions.length < 3) {
                    return null;
                  }

                  return (
                    <Polygon
                      key={`placement-overlay-${overlay.key}`}
                      positions={positions}
                      interactive={mapWorkflowMode === "field_work" && !isPointSelectionMapMode(mapMode)}
                      bubblingMouseEvents={false}
                      pathOptions={plantingOverlayStyleForColor(overlay.color, mapWorkflowMode === "field_work" && !isPointSelectionMapMode(mapMode) ? "map-work-select-path" : undefined)}
                      eventHandlers={{
                        click: () => {
                          if (mapWorkflowMode !== "field_work" || isPointSelectionMapMode(mapMode)) {
                            return;
                          }
                          const bed = bedsById.get(overlay.bedId) ?? null;
                          const planting = plantingsById.get(overlay.plantingId) ?? null;
                          if (planting) {
                            selectPlantingOnMap(planting, bed);
                          } else if (bed) {
                            selectBedOnMap(bed);
                          }
                        }
                      }}
                    />
                  );
                })}

                {showCropSectionsAtZoom && showPlantingLabelsAtZoom && plantingMapLabels.map((label) => (
                  <Marker
                    key={`planting-label-${label.key}`}
                    position={[label.center.lat, label.center.lng]}
                    interactive={false}
                    icon={plantingLabelIcon(label.label, label.bearing, label.tone, label.color)}
                    zIndexOffset={650}
                  />
                ))}

                {bedAllocationPreviewOverlays.map((preview) => {
                  const positions = polygonPositions(geoJsonPolygonToLatLngs(preview.boundary));
                  if (positions.length < 3) {
                    return null;
                  }
                  return (
                    <Polygon
                      key={`allocation-preview-${preview.bedId}-${preview.startLengthM}`}
                      positions={positions}
                      interactive={false}
                      pathOptions={{
                        color: "#fff4bd",
                        fillColor: "#f6cf73",
                        fillOpacity: 0.42,
                        weight: 3,
                        dashArray: "4 3"
                      }}
                    />
                  );
                })}

                {placementPlanEntranceMarker && (
                  <Marker
                    key={placementPlanEntranceMarker.key}
                    position={[placementPlanEntranceMarker.center.lat, placementPlanEntranceMarker.center.lng]}
                    icon={taskMapIcon(
                      "bed_prep",
                      placementPlanEntranceMarker.profile.iconColor,
                      placementPlanEntranceMarker.profile.iconSecondaryColor,
                      placementPlanEntranceMarker.bearing,
                      38,
                      placementPlanEntranceMarker.profile.tractorModel,
                      null,
                      8.5,
                      0,
                      true
                    )}
                    interactive={false}
                    zIndexOffset={520}
                  >
                    <Tooltip direction="top" className="polygon-label">
                      First bed entrance: {placementPlanEntranceMarker.blockName} / {placementPlanEntranceMarker.bedName}
                    </Tooltip>
                  </Marker>
                )}

                {showTaskLayer && mapTasksThisWeek.map(({ key, task, center, bearing, runDistancePx, runDurationSec, animationDelaySec }) => (
                  <Marker
                    key={key}
                    position={[center.lat, center.lng]}
                    icon={taskMapIcon(task.taskType, taskColor(task), task.iconSecondaryColor, bearing, runDistancePx, task.tractorModel, mapTaskSpriteSheetUrls.get(task.id), runDurationSec, animationDelaySec)}
                    interactive={!isPointSelectionMapMode(mapMode)}
                    eventHandlers={{
                      click: () => {
                        if (isPointSelectionMapMode(mapMode)) {
                          return;
                        }
                        openTaskRecordFromMap(task);
                      }
                    }}
                  >
                    <Tooltip direction="top" className="polygon-label">
                      {formatTaskTypeLabel(task.taskType)}: {task.title}
                    </Tooltip>
                  </Marker>
                ))}

                {userLocation && (
                  <>
                    {userLocation.accuracyM != null && (
                      <Circle
                        center={[userLocation.lat, userLocation.lng]}
                        radius={userLocation.accuracyM}
                        interactive={false}
                        pathOptions={{
                          color: "#276fbf",
                          fillColor: "#7bb8ff",
                          fillOpacity: 0.12,
                          opacity: 0.45,
                          weight: 1.5
                        }}
                      />
                    )}
                    <CircleMarker
                      center={[userLocation.lat, userLocation.lng]}
                      radius={8}
                      pathOptions={{
                        color: "#ffffff",
                        fillColor: "#1e78d6",
                        fillOpacity: 1,
                        opacity: 1,
                        weight: 3
                      }}
                    >
                      <Tooltip direction="top" className="polygon-label">
                        You are here{userLocation.accuracyM != null ? `, within about ${Math.round(userLocation.accuracyM)} m` : ""}
                      </Tooltip>
                    </CircleMarker>
                  </>
                )}

                {(mapMode === "draw_field" || mapMode === "draw_block" || mapMode === "draw_zone") && draftCoordinates.length > 0 && (
                  <>
                    <Polyline positions={polygonPositions(draftCoordinates)} pathOptions={{ color: "#f5f0d8", weight: 3 }} />
                    {draftCoordinates.length >= 3 && (
                      <Polygon positions={polygonPositions(draftCoordinates)} pathOptions={{ color: "#f5f0d8", fillColor: "#8aaa5a", fillOpacity: 0.2, weight: 3 }} />
                    )}
                    {draftCoordinates.map((point, index) => (
                      <Marker
                        key={`draft-point-${index}`}
                        position={[point.lat, point.lng]}
                        icon={vertexIcon(index === 0 ? "start" : "vertex")}
                      />
                    ))}
                  </>
                )}

                {mapMode === "draw_zone_split" && zoneSplitLines.length > 0 && (
                  <>
                    {zoneSplitPreviewCoordinates.length >= 3 && (
                      <Polygon
                        positions={polygonPositions(zoneSplitPreviewCoordinates)}
                        interactive={false}
                        pathOptions={{
                          color: "#f6cf73",
                          fillColor: "#f6cf73",
                          fillOpacity: 0.28,
                          weight: 2,
                          dashArray: "6 4"
                        }}
                      />
                    )}
                    {zoneSplitDisplayLines.map((line, index) => (
                      <Fragment key={`zone-split-line-${index}`}>
                        <Polyline
                          positions={polygonPositions(line)}
                          interactive={false}
                          pathOptions={{ color: "#f5f0d8", weight: 3 }}
                        />
                        <Polyline
                          positions={polygonPositions(line)}
                          bubblingMouseEvents={false}
                          pathOptions={{ color: "#f5f0d8", weight: 24, opacity: 0.01 }}
                          eventHandlers={{
                            mousedown: (event) => {
                              setZoneSplitDraggingLineIndex(index);
                              setZoneSplitCoordinates((current) => current.map((item, itemIndex) => itemIndex === index ? { lat: event.latlng.lat, lng: event.latlng.lng } : item));
                            }
                          }}
                        />
                      </Fragment>
                    ))}
                    {zoneSplitCoordinates.map((point, index) => (
                      <Marker
                        key={`zone-split-point-${index}`}
                        position={[point.lat, point.lng]}
                        draggable
                        icon={vertexIcon(index === 0 ? "start" : "vertex")}
                        eventHandlers={{
                          dragend: (event) => {
                            const latLng = (event.target as { getLatLng: () => { lat: number; lng: number } }).getLatLng();
                            setZoneSplitCoordinates((current) => current.map((item, itemIndex) => itemIndex === index ? { lat: latLng.lat, lng: latLng.lng } : item));
                          }
                        }}
                      />
                    ))}
                  </>
                )}

                {bedPreviewCoordinates.length >= 3 && (
                  <Polygon
                    positions={polygonPositions(bedPreviewCoordinates)}
                    interactive={false}
                    pathOptions={{
                      color: "#f6cf73",
                      fillColor: "#f6cf73",
                      fillOpacity: 0.34,
                      weight: 2,
                      dashArray: "6 4"
                    }}
                  >
                    <Tooltip direction="center" className="polygon-label">Next bed</Tooltip>
                  </Polygon>
                )}

                {mapMode === "pick_bed_edge" && bedEdgePickBlockContext && boundaryEdgeLines(geoJsonPolygonToLatLngs(bedEdgePickBlockContext.boundary)).map((edge, index) => (
                  <Fragment key={`bed-edge-picker-${bedEdgePickBlockContext.id}-${index}`}>
                    <Polyline
                      positions={polygonPositions(edge)}
                      interactive={false}
                      pathOptions={{ color: "#cfe7ff", weight: 4, opacity: 0.95 }}
                    />
                    <Polyline
                      positions={polygonPositions(edge)}
                      interactive
                      bubblingMouseEvents={false}
                      pathOptions={{ color: "#cfe7ff", weight: 28, opacity: 0.18 }}
                      eventHandlers={{
                        click: () => {
                          selectBedEdgeLine(edge);
                        }
                      }}
                    />
                  </Fragment>
                ))}

                {bedLineCoordinates.length > 0 && (
                  <>
                    <Polyline positions={polygonPositions(bedLineCoordinates)} pathOptions={{ color: "#cfe7ff", weight: 3 }} />
                {bedLineCoordinates.map((point, index) => (
                  <Marker
                    key={`bed-line-point-${index}`}
                    position={[point.lat, point.lng]}
                    icon={vertexIcon(index === 0 ? "start" : "vertex")}
                  />
                ))}
              </>
            )}

                {mapMode === "edit" && editCoordinates.length >= 3 && (
                  <>
                    <Polygon
                      positions={polygonPositions(editCoordinates)}
                      pathOptions={selection?.type === "field" ? fieldStyle(true) : blockStyle(true)}
                    />
                    {editCoordinates.map((point, index) => (
                      <Marker
                        key={`edit-vertex-${index}`}
                        position={[point.lat, point.lng]}
                        draggable
                        icon={vertexIcon(selectedVertexIndex === index ? "selected" : "vertex")}
                        eventHandlers={{
                          click: () => setSelectedVertexIndex(index),
                          dragend: (event) => {
                            const next = event.target.getLatLng();
                            setEditCoordinates((current) => current.map((item, itemIndex) => (
                              itemIndex === index ? { lat: next.lat, lng: next.lng } : item
                            )));
                          }
                        }}
                      />
                    ))}
                    {editCoordinates.map((point, index) => {
                      const nextPoint = editCoordinates[(index + 1) % editCoordinates.length];
                      const middle = midpoint(point, nextPoint);
                      return (
                        <Marker
                          key={`midpoint-${index}`}
                          position={[middle.lat, middle.lng]}
                          icon={vertexIcon("midpoint")}
                          eventHandlers={{
                            click: () => {
                              setEditCoordinates((current) => {
                                const updated = [...current];
                                updated.splice(index + 1, 0, middle);
                                return updated;
                              });
                              setSelectedVertexIndex(index + 1);
                            }
                          }}
                        />
                      );
                    })}
                  </>
                )}
              </MapContainer>
              </div>
              <div className="card map-controls-card">
                <div className="map-location-panel">
                  <button type="button" className="primary-button" onClick={locateUserOnMap}>
                    Use phone GPS
                  </button>
                  {userLocation && (
                    <p className="muted">
                      Location shown{userLocation.accuracyM != null ? `, accuracy about ${Math.round(userLocation.accuracyM)} m` : ""}.
                    </p>
                  )}
                </div>
                <div className="timeline-panel">
                  <div className="timeline-header">
                    <strong>Map week</strong>
                    <span>{formatWeekRange(selectedMapWeekStart)}</span>
                  </div>
                  <div className="button-row week-button-row">
                    <button type="button" className="secondary-button compact-button" onClick={() => setSelectedMapWeekStart((current) => addDaysToDate(current, -7))}>Previous week</button>
                    <button type="button" className="secondary-button compact-button" onClick={() => setSelectedMapWeekStart(startOfWeekDate(todayDateInputValue()))}>This week</button>
                    <button type="button" className="secondary-button compact-button" onClick={() => setSelectedMapWeekStart((current) => addDaysToDate(current, 7))}>Next week</button>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(timelineDates.length - 1, 0)}
                    step={1}
                    value={latestDateIndexOnOrBefore(timelineDates, selectedMapWeekStart)}
                    onChange={(event) => setSelectedMapWeekStart(startOfWeekDate(timelineDates[Number(event.target.value)] ?? todayDateInputValue()))}
                    disabled={timelineDates.length <= 1}
                  />
                  <p className="muted">
                    The map uses this week for planned crop overlays, actual crop overlays, and tasks due through {selectedMapWeekEnd}.
                  </p>
                </div>
                <div className="layer-panel map-layer-options">
                  <h3>Map layers</h3>
                  <p className="muted">Basemap: Online imagery. Crop and task overlays are off by default to keep Firefox responsive.</p>
                  <label className="layer-toggle">
                    <input
                      type="checkbox"
                      checked={showPlannedPlantingsLayer}
                      onChange={(event) => updateMapLayerSettings({ planned: event.target.checked })}
                    />
                    <span>Planned crops in ground</span>
                  </label>
                  <label className="layer-toggle">
                    <input
                      type="checkbox"
                      checked={showActualPlacementsLayer}
                      onChange={(event) => updateMapLayerSettings({ actual: event.target.checked })}
                    />
                    <span>Actual crops in ground</span>
                  </label>
                  <label className="layer-toggle">
                    <input
                      type="checkbox"
                      checked={showTaskLayer}
                      onChange={(event) => updateMapLayerSettings({ tasks: event.target.checked })}
                    />
                    <span>Tasks due this week</span>
                  </label>
                  {canViewOtherFarmMaps && (
                    <label className="layer-toggle">
                      <input
                        type="checkbox"
                        checked={showOtherFarmMaps}
                        onChange={(event) => updateMapLayerSettings({ otherFarms: event.target.checked })}
                      />
                      <span>Show other farms</span>
                    </label>
                  )}
                </div>
              </div>
            </div>

            <div className="stack">
              {mapWorkTasksOnly ? (
                <>
                  {mapNotice && (
                    <div className="instruction-box map-notice" role="status" aria-live="polite">
                      <strong>Map status:</strong> {mapNotice}
                    </div>
                  )}
                  {selectedTask && renderTaskRecordCard(selectedTask)}
                  {selectedMapItem && selectedMapItem.farmId === data.farm?.id && (
                    <UnplannedWorkCard
                      field={selectedFieldContext}
                      block={selectedBlockContext}
                      zone={selectedZone}
                      bed={selectedBed}
                      farmId={data.farm?.id ?? null}
                      bedPresets={data.bedPresets}
                      existingBeds={selectedBlockContext ? ownBeds.filter((bed) => bed.blockId === selectedBlockContext.id) : []}
                      blockBeds={selectedBlockPlantableBeds}
                      blockZones={ownBlockZones.filter((zone) => selectedBlockContext != null && zone.blockId === selectedBlockContext.id)}
                      plantings={ownFarmData.plantings}
                      placements={ownFarmData.placements}
                      events={ownFarmData.events}
                      distanceUnit={distanceUnit}
                      pendingWorkAreaSqM={zoneDraftActive && zoneDraftMethod === "split_line" ? zoneSplitPreviewAreaSqM : null}
                      bedLineCoordinates={bedLineCoordinates}
                      bedLineSource={bedLineSource}
                      bedLineMode={bedLineMode}
                      invertSide={bedInvertSide}
                      isPickingLine={mapMode === "draw_bed_line"}
                      isPickingEdge={mapMode === "pick_bed_edge"}
                      selectedCultivationBedIds={workSelectedBedIds}
                      bedPickActive={workBedPickActive}
                      onBedPickActiveChange={setWorkBedPickActive}
                      onSelectedCultivationBedIdsChange={setWorkSelectedBedIds}
                      canCreateSection={canPlan && selectedBlockContext != null}
                      onSplitSection={() => startBlockSectionDraft("split_line")}
                      onPickBedEdge={startBedEdgePick}
                      onStartBedLine={startBedLineDraw}
                      onCancelBedLine={cancelBedLinePick}
                      onInvertSideChange={setBedInvertSide}
                      onEntranceSideChange={(blockId, entranceSide) => {
                        setBedEntranceSideDrafts((current) => ({ ...current, [blockId]: entranceSide }));
                      }}
                      onPreviewChange={setBedPreviewCoordinates}
                      onStatusChange={setMapNotice}
                      onSelectSection={(zoneId) => {
                        setSelection({ type: "zone", id: zoneId });
                        setMapNotice(null);
                      }}
                      onCreatePendingSection={(notes) => savePendingWorkSection(notes)}
                      onSave={async () => {
                        await load();
                        setMapNotice("Unplanned work recorded.");
                      }}
                    />
                  )}
                  {selectedBlockContext && ownBeds.filter((bed) => bed.blockId === selectedBlockContext.id && bed.source !== "road").length === 0 && canPlan && selectedBlockContext.farmId === data.farm?.id && (
                    <div className="card">
                      <h2>Bed Maker</h2>
                      <p className="muted">{selectedBlockContext.name} has no plantable beds yet.</p>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={openSelectedBlockBedMaker}
                      >
                        Make beds
                      </button>
                    </div>
                  )}
                  <TaskWeekCard
                    title={formatTaskWeekTitle(selectedMapWeekStart)}
                    weekStart={selectedMapWeekStart}
                    contextLabel={mapWorkTaskContextLabel}
                    tasks={mapSelectedTaskList}
                    undoTaskId={recentlyCompletedTaskId}
                    showPastUndoneOption={selectedMapWeekStart === currentTaskWeekStart}
                    pastUndoneChecked={showPastUndoneTasks}
                    onPastUndoneChange={setShowPastUndoneTasks}
                    onSelectTask={(task) => {
                      if (taskNeedsRecordForm(task.taskType)) {
                        openTaskRecordFromMap(task);
                        return;
                      }
                      selectTask(task);
                      setMapNotice(`Selected ${task.title}.`);
                    }}
                    onQuickComplete={(task) => {
                      if (taskNeedsRecordForm(task.taskType)) {
                        openTaskRecordFromMap(task);
                        return;
                      }
                      void quickCompleteTask(task);
                    }}
                    onUndoTask={(task) => void undoRecentTaskCompletion(task)}
                  />
                </>
              ) : (
                <>
              {mapNotice && (
                <div className="instruction-box map-notice" role="status" aria-live="polite">
                  <strong>Map status:</strong> {mapNotice}
                </div>
              )}
              {mapWorkflowMode === "planning" && (mapMode === "draw_field" || mapMode === "draw_block" || zoneDraftActive || mapMode === "draw_zone" || mapMode === "draw_zone_split") && (
                <div className="card">
                  <h2>{mapMode === "draw_field" ? "New field" : mapMode === "draw_block" ? "New block" : draftPlannedUse === "cover_crop" ? "New cover crop area" : "New mapped area"}</h2>
                  {(tutorialHighlightDraftName || tutorialHighlightDraftSave) && (
                    <div className="tutorial-helper-bubble">
                      <strong>Tutorial next:</strong> {currentTutorialClickTarget()}
                    </div>
                  )}
                  {mapMode === "draw_block" && selectedField && <p className="muted">Parent field: {selectedField.name}</p>}
                  {zoneDraftActive && selectedBlockContext && <p className="muted">Parent block: {selectedBlockContext.name}</p>}
                  <div className="form-grid">
                    <label className={tutorialTargetClass(tutorialHighlightDraftName)}>
                      <span>{zoneDraftActive && draftPlannedUse === "beds" ? "Crop/group name" : zoneDraftActive ? "Name (optional)" : "Name"}</span>
                      <input
                        value={draftName}
                        onChange={(event) => setDraftName(event.target.value)}
                        placeholder={zoneDraftActive && draftPlannedUse === "beds" ? "Peppers, tomatoes, spring brassicas" : zoneDraftActive ? "Auto-name if left blank" : ""}
                      />
                    </label>
                    <label>
                      <span>Area</span>
                      <input
                        value={
                          zoneDraftMethod === "whole_block" && selectedBlockContext
                            ? formatDisplayArea(selectedBlockContext.areaSqM, distanceUnit)
                            : mapMode === "draw_zone"
                              ? formatDisplayArea(polygonAreaSqM(draftCoordinates), distanceUnit)
                              : mapMode === "draw_zone_split"
                                ? "Calculated from split"
                                : formatDisplayArea(polygonAreaSqM(draftCoordinates), distanceUnit)
                        }
                        readOnly
                      />
                    </label>
                    {mapMode === "draw_block" && (
                      <label>
                        <span>Current state</span>
                        <select value={draftActualState} onChange={(event) => setDraftActualState(event.target.value as ZoneActualState)}>
                          {zoneActualStateOptions.map((option) => <option key={option} value={option}>{formatZoneActualStateLabel(option)}</option>)}
                        </select>
                      </label>
                    )}
                    {zoneDraftActive && (
                      <>
                        <div className="full-span">
                          <span className="field-label">Area creation</span>
                          <div className="button-row">
                            <button type="button" className={zoneDraftMethod === "whole_block" ? "primary-button" : "secondary-button"} onClick={() => setZoneCreationMethod("whole_block")}>Whole block</button>
                            <button type="button" className={zoneDraftMethod === "split_line" ? "primary-button" : "secondary-button"} onClick={() => setZoneCreationMethod("split_line")}>Split with line</button>
                            <button type="button" className={zoneDraftMethod === "polygon" ? "primary-button" : "secondary-button"} onClick={() => setZoneCreationMethod("polygon")}>Draw polygon</button>
                          </div>
                          {zoneDraftMethod === "split_line" && (
                            <p className="muted">
                              Lines placed: {zoneSplitCoordinates.length} / 2. One line saves the area from the first-bed side to that line; two lines save the area between them. Drag a line or its handle to move it.
                            </p>
                          )}
                        </div>
                        <label>
                          <span>Area type</span>
                          <input value={formatPlannedUseLabel(draftPlannedUse)} readOnly />
                        </label>
                        <label>
                          <span>Current state</span>
                          <select value={draftActualState} onChange={(event) => setDraftActualState(event.target.value as ZoneActualState)}>
                            {zoneActualStateOptions.map((option) => <option key={option} value={option}>{formatZoneActualStateLabel(option)}</option>)}
                          </select>
                        </label>
                        {draftPlannedUse === "cover_crop" && (
                          <>
                            <label>
                              <span>Cover crop</span>
                              <select value={draftCoverCropChoice} onChange={(event) => setDraftCoverCropChoice(event.target.value)}>
                                <option value="">Select cover crop</option>
                                {data.coverCropNames.map((item) => <option key={item.id} value={String(item.id)}>{item.name}</option>)}
                                <option value="__new__">Add new cover crop</option>
                              </select>
                            </label>
                            {draftCoverCropChoice === "__new__" && (
                              <label>
                                <span>New cover crop name</span>
                                <input value={draftCoverCropName} onChange={(event) => setDraftCoverCropName(event.target.value)} placeholder="Rye / vetch mix" />
                              </label>
                            )}
                            <label>
                              <span>Planned seeding date</span>
                              <input type="date" value={draftCoverCropSeedDate} onChange={(event) => setDraftCoverCropSeedDate(event.target.value)} />
                            </label>
                            <label>
                              <span>Planned termination date</span>
                              <input type="date" value={draftCoverCropTerminateDate} onChange={(event) => setDraftCoverCropTerminateDate(event.target.value)} />
                            </label>
                          </>
                        )}
                      </>
                    )}
                    <label className="full-span"><span>Notes</span><textarea rows={3} value={draftNotes} onChange={(event) => setDraftNotes(event.target.value)} /></label>
                    <div className="button-row full-span">
                      <button type="button" className="secondary-button" onClick={() => resetMapDrafts("select")}>Cancel</button>
                      <button
                        type="button"
                        className={`primary-button save-button${tutorialTargetClass(tutorialHighlightDraftSave)}`}
                        onClick={() => void saveDraft()}
                        disabled={
                          isSavingMapObject
                          || (
                            zoneDraftActive
                              ? (
                                  !zoneDraftMethod
                                  || (zoneDraftMethod === "polygon" && draftCoordinates.length < 3)
                                  || (zoneDraftMethod === "split_line" && zoneSplitCoordinates.length < 1)
                                  || (zoneDraftMethod === "split_line" && zoneSplitLines.length !== zoneSplitCoordinates.length)
                                  || (draftPlannedUse === "cover_crop" && !draftCoverCropChoice && !draftCoverCropName.trim())
                                )
                              : (
                                  draftCoordinates.length < 3
                                  || ((mapMode === "draw_field" || mapMode === "draw_block") && !draftName.trim())
                                )
                          )
                        }
                      >
                        {isSavingMapObject ? "Saving..." : "Save"}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {mapWorkflowMode === "planning" && mapMode === "edit" && selectedMapItem && (
                <div className="card">
                  <h2>Edit {selection?.type}</h2>
                  <div className="form-grid">
                    <label>
                      <span>{selection?.type === "zone" && editPlannedUse === "beds" ? "Crop/group name" : selection?.type === "zone" ? "Name (optional)" : "Name"}</span>
                      <input
                        value={editName}
                        onChange={(event) => setEditName(event.target.value)}
                        placeholder={selection?.type === "zone" && editPlannedUse === "beds" ? "Peppers, tomatoes, spring brassicas" : selection?.type === "zone" ? "Keep existing or auto-name" : ""}
                      />
                    </label>
                    <label><span>Area</span><input value={formatDisplayArea(polygonAreaSqM(editCoordinates), distanceUnit)} readOnly /></label>
                    {selection?.type === "zone" && (
                      <>
                        <label>
                          <span>Future use (optional)</span>
                          <select value={editPlannedUse ?? ""} onChange={(event) => setEditPlannedUse(event.target.value ? event.target.value as Exclude<PlannedUse, null> : null)}>
                            <option value="">No future use assigned</option>
                            {futureUseOptions.map((option) => <option key={option} value={option}>{formatPlannedUseLabel(option)}</option>)}
                          </select>
                        </label>
                        <label>
                          <span>Current state</span>
                          <select value={editActualState} onChange={(event) => setEditActualState(event.target.value as ZoneActualState)}>
                            {zoneActualStateOptions.map((option) => <option key={option} value={option}>{formatZoneActualStateLabel(option)}</option>)}
                          </select>
                        </label>
                        {editPlannedUse === "cover_crop" && (
                          <>
                            <label>
                              <span>Cover crop</span>
                              <select value={editCoverCropChoice} onChange={(event) => setEditCoverCropChoice(event.target.value)}>
                                <option value="">Select cover crop</option>
                                {data.coverCropNames.map((item) => <option key={item.id} value={String(item.id)}>{item.name}</option>)}
                                <option value="__new__">Add new cover crop</option>
                              </select>
                            </label>
                            {editCoverCropChoice === "__new__" && (
                              <label>
                                <span>New cover crop name</span>
                                <input value={editCoverCropName} onChange={(event) => setEditCoverCropName(event.target.value)} placeholder="Rye / vetch mix" />
                              </label>
                            )}
                            <label>
                              <span>Planned seeding date</span>
                              <input type="date" value={editCoverCropSeedDate} onChange={(event) => setEditCoverCropSeedDate(event.target.value)} />
                            </label>
                            <label>
                              <span>Planned termination date</span>
                              <input type="date" value={editCoverCropTerminateDate} onChange={(event) => setEditCoverCropTerminateDate(event.target.value)} />
                            </label>
                          </>
                        )}
                      </>
                    )}
                    <label className="full-span"><span>Notes</span><textarea rows={3} value={editNotes} onChange={(event) => setEditNotes(event.target.value)} /></label>
                    <div className="button-row full-span">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={selectedVertexIndex == null || editCoordinates.length <= 3}
                        onClick={() => {
                          if (selectedVertexIndex == null) return;
                          setEditCoordinates((current) => current.filter((_, index) => index !== selectedVertexIndex));
                          setSelectedVertexIndex(null);
                        }}
                      >
                        Delete selected vertex
                      </button>
                      <button type="button" className="secondary-button" onClick={() => resetMapDrafts("select")}>Cancel</button>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => void saveEdit()}
                        disabled={isSavingMapObject}
                      >
                        {isSavingMapObject ? "Saving..." : "Save changes"}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {mapWorkflowMode === "planning" && mapMode === "select" && selectedBlockContext && canEditSelectedBlockContext && !zoneDraftActive && (
                <BlockSectionsCard
                  block={selectedBlockContext}
                  zones={ownBlockZones.filter((zone) => zone.blockId === selectedBlockContext.id)}
                  distanceUnit={distanceUnit}
                  onCreateSection={() => startDrawZone(null)}
                  onSelectSection={(zoneId) => {
                    setSelection({ type: "zone", id: zoneId });
                    setMapNotice(null);
                  }}
                />
              )}

              {mapWorkflowMode === "planning" && selectedBlockContext && canEditSelectedBlockContext && (mapMode === "bed_tools" || mapMode === "pick_bed_edge" || mapMode === "draw_bed_line") && (
                <BedGeneratorCard
                  block={selectedBlockContext}
                  zone={null}
                  farmId={data.farm?.id ?? null}
                  bedPresets={data.bedPresets}
                  existingBeds={ownBeds.filter((bed) => bed.blockId === selectedBlockContext.id)}
                  distanceUnit={distanceUnit}
                  bedLineCoordinates={bedLineCoordinates}
                  bedLineSource={bedLineSource}
                  bedLineMode={bedLineMode}
                  invertSide={bedInvertSide}
                  isPickingLine={mapMode === "draw_bed_line"}
                  isPickingEdge={mapMode === "pick_bed_edge"}
                  tutorialActive={activeTutorialStep === 2 && tutorialMapPlanningReady}
                  onPickEdge={startBedEdgePick}
                  onStartLine={startBedLineDraw}
                  onCancelLine={cancelBedLinePick}
                  onInvertSideChange={setBedInvertSide}
                  onEntranceSideChange={(blockId, entranceSide) => {
                    setBedEntranceSideDrafts((current) => ({ ...current, [blockId]: entranceSide }));
                  }}
                  onPreviewChange={setBedPreviewCoordinates}
                  onStatusChange={setMapNotice}
                  onSave={load}
                  onBlockFilled={() => {
                    resetMapDrafts("select");
                    setSelection({ type: "block", id: selectedBlockContext.id });
                  }}
                  onTutorialBedsGenerated={(bedIds) => {
                    if (tutorialOpen && tutorialStepIndex === 2) {
                      const firstBedId = bedIds[0] ?? null;
                      setSelection({ type: "block", id: selectedBlockContext.id });
                      void prepareCabbageTutorial(firstBedId == null ? null : { id: firstBedId, blockId: selectedBlockContext.id });
                    }
                  }}
                  onSelectBed={(bedId) => {
                    setSelection({ type: "block", id: selectedBlockContext.id });
                    setBedLineSource("manual");
                  }}
                />
              )}

              {canPlan && mapPlantingBeds.length > 0 && (
                <PlantingForm
                  key={`map-selected-planting-${mapPlantingBedIds.join("-")}`}
                  data={ownFarmData}
                  taskFlowTemplates={ownFarmData.taskFlowTemplates}
                  distanceUnit={distanceUnit}
                  initialIntendedBedIds={mapPlantingBedIds}
                  tutorialDraft={tutorialPlantingDraft}
                  highlightSubmit={activeTutorialStep === 3}
                  onPreviewChange={setBedAllocationPreview}
                  onSave={async () => {
                    const flowId = tutorialPlantingDraft?.taskFlowTemplateId ?? null;
                    await load();
                    const savedCount = mapPlantingBeds.length;
                    setBedAllocationPreview([]);
                    setMapPlantingBedIds([]);
                    if (tutorialOpen && tutorialStepIndex === 3) {
                      if (flowId != null) {
                        setTutorialFlowId(flowId);
                        setSelectedFlowId(flowId);
                      }
                      setTutorialStepIndex(4);
                      setTutorialStatus("Planting created from the map. Use the highlighted Task Flows navigation, then add the mow node.");
                    }
                    setTutorialPlantingDraft(null);
                    setMapNotice(`Planting saved for ${savedCount} selected bed${savedCount === 1 ? "" : "s"}.`);
                  }}
                />
              )}

              {mapWorkflowMode === "field_work" && mapRecordTask && (
                renderTaskRecordCard(mapRecordTask)
              )}

              {mapWorkflowMode === "field_work" && selectedBed && mapPlantingBeds.length === 0 && (
                <BedRecordsCard
                  bed={selectedBed}
                  plantings={selectedBedPlantings}
                  placements={selectedBedPlacements}
                  gaps={selectedBedGaps}
                  tasks={selectedBedTasks}
                  distanceUnit={distanceUnit}
                  canCreatePlanting={canPlan && selectedBed.farmId === data.farm?.id && selectedBed.source !== "road"}
                  onSelectTask={(task) => {
                    selectTask(task);
                    setMapNotice(`Selected ${task.title}.`);
                  }}
                  onOpenPlanting={(planting) => {
                    setSelectedPlantingId(planting.id);
                    setView("planting");
                  }}
                />
              )}

              {mapWorkflowMode === "field_work" && selectedBlockContext && ownBeds.filter((bed) => bed.blockId === selectedBlockContext.id && bed.source !== "road").length === 0 && canPlan && selectedBlockContext.farmId === data.farm?.id && (
                <div className="card">
                  <h2>Bed Maker</h2>
                  <p className="muted">{selectedBlockContext.name} has no plantable beds yet.</p>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={openSelectedBlockBedMaker}
                  >
                    Make beds
                  </button>
                </div>
              )}

              {selectedBlockContext && selectedBed == null && selectedBlockPlantableBeds.length > 0 && mapPlantingBeds.length === 0 && canPlan && selectedBlockContext.farmId === data.farm?.id && (
                <BlockPlacementPlanCard
                  block={selectedBlockContext}
                  data={ownFarmData}
                  taskFlowTemplates={ownFarmData.taskFlowTemplates}
                  beds={ownBeds}
                  plantings={data.plantings}
                  placements={data.placements}
                  gaps={data.placementGaps}
                  overflows={selectedBlockOverflows}
                  distanceUnit={distanceUnit}
                  startOpenNewPlanting={selectedBlockIsEmpty}
                  onPreviewChange={setBedAllocationPreview}
                  onSave={async () => {
                    await load();
                    setBedAllocationPreview([]);
                  }}
                />
              )}

              {mapWorkflowMode === "field_work" && selectedBed && selectedBlockContext && mapPlantingBeds.length === 0 && canPlan && selectedBed.farmId === data.farm?.id && (
                <BlockPlacementPlanCard
                  block={selectedBlockContext}
                  selectedBed={selectedBed}
                  data={ownFarmData}
                  taskFlowTemplates={ownFarmData.taskFlowTemplates}
                  plantings={data.plantings}
                  placements={data.placements}
                  gaps={data.placementGaps}
                  overflows={selectedBlockOverflows}
                  beds={ownBeds}
                  distanceUnit={distanceUnit}
                  startOpenNewPlanting={selectedBedIsUnassigned}
                  onPreviewChange={setBedAllocationPreview}
                  onSave={async () => {
                    await load();
                    setBedAllocationPreview([]);
                  }}
                />
              )}

              {mapWorkflowMode === "field_work" && selectedZone?.plannedUse === "cover_crop" && selectedZone.farmId === data.farm?.id && (
                <CoverCropWorkCard
                  zone={selectedZone}
                  onSave={load}
                />
              )}

              {mapWorkflowMode === "field_work" && selectedMapItem && selectedMapItem.farmId === data.farm?.id && (
                <UnplannedWorkCard
                  field={selectedFieldContext}
                  block={selectedBlockContext}
                  zone={selectedZone}
                  bed={selectedBed}
                  farmId={data.farm?.id ?? null}
                  bedPresets={data.bedPresets}
                  existingBeds={selectedBlockContext ? ownBeds.filter((bed) => bed.blockId === selectedBlockContext.id) : []}
                  blockBeds={selectedBlockPlantableBeds}
                  blockZones={ownBlockZones.filter((zone) => selectedBlockContext != null && zone.blockId === selectedBlockContext.id)}
                  plantings={ownFarmData.plantings}
                  placements={ownFarmData.placements}
                  events={ownFarmData.events}
                  distanceUnit={distanceUnit}
                  pendingWorkAreaSqM={zoneDraftActive && zoneDraftMethod === "split_line" ? zoneSplitPreviewAreaSqM : null}
                  bedLineCoordinates={bedLineCoordinates}
                  bedLineSource={bedLineSource}
                  bedLineMode={bedLineMode}
                  invertSide={bedInvertSide}
                  isPickingLine={mapMode === "draw_bed_line"}
                  isPickingEdge={mapMode === "pick_bed_edge"}
                  selectedCultivationBedIds={workSelectedBedIds}
                  bedPickActive={workBedPickActive}
                  onBedPickActiveChange={setWorkBedPickActive}
                  onSelectedCultivationBedIdsChange={setWorkSelectedBedIds}
                  canCreateSection={canPlan && selectedBlockContext != null}
                  onSplitSection={() => startBlockSectionDraft("split_line")}
                  onPickBedEdge={startBedEdgePick}
                  onStartBedLine={startBedLineDraw}
                  onCancelBedLine={cancelBedLinePick}
                  onInvertSideChange={setBedInvertSide}
                  onEntranceSideChange={(blockId, entranceSide) => {
                    setBedEntranceSideDrafts((current) => ({ ...current, [blockId]: entranceSide }));
                  }}
                  onPreviewChange={setBedPreviewCoordinates}
                  onStatusChange={setMapNotice}
                  onSelectSection={(zoneId) => {
                    setSelection({ type: "zone", id: zoneId });
                    setMapNotice(null);
                  }}
                  onCreatePendingSection={(notes) => savePendingWorkSection(notes)}
                  onSave={async () => {
                    await load();
                    setMapNotice("Unplanned work recorded.");
                  }}
                />
              )}

              <div className="card">
                <h2>Selection</h2>
                {mapPlantingBeds.length > 0 && (
                  <div className="instruction-box">
                    Crop-plan beds: {mapPlantingBeds.map((bed) => bed.name).join(", ")}
                    <div className="button-row">
                      <button type="button" className="secondary-button" onClick={() => setMapPlantingBedIds([])}>
                        Clear selected beds
                      </button>
                    </div>
                  </div>
                )}
                {selectedMapItem ? (
                  <>
                    <dl className="detail-list">
                      <div><dt>Type</dt><dd>{selection?.type === "field" ? "Field" : selection?.type === "block" ? "Block" : selection?.type === "bed" ? "Bed" : "Area"}</dd></div>
                      <div><dt>Farm</dt><dd>{selectedMapItem.farmName}</dd></div>
                      <div><dt>Name</dt><dd>{selectedMapItem.name}</dd></div>
                      {selectedBlock && <div><dt>Parent field</dt><dd>{selectedBlock.fieldName}</dd></div>}
                      {selectedZone && <div><dt>Parent block</dt><dd>{selectedZone.blockName}</dd></div>}
                      {selectedZone && <div><dt>Parent field</dt><dd>{selectedZone.fieldName}</dd></div>}
                      {selectedBed && <div><dt>Parent block</dt><dd>{selectedBed.blockName}</dd></div>}
                      {selectedZone && <div><dt>Future use</dt><dd>{formatPlannedUseLabel(selectedZone.plannedUse)}</dd></div>}
                      {selectedZone && <div><dt>Current state</dt><dd>{formatZoneActualStateLabel(selectedZone.actualState)}</dd></div>}
                      {selectedZone && selectedZone.coverCropName && <div><dt>Cover crop</dt><dd>{selectedZone.coverCropName}</dd></div>}
                      {selectedZone?.plannedUse === "cover_crop" && <div><dt>Planned seed</dt><dd>{formatDate(selectedZone.plannedCoverCropSeedDate)}</dd></div>}
                      {selectedZone?.plannedUse === "cover_crop" && <div><dt>Planned terminate</dt><dd>{formatDate(selectedZone.plannedCoverCropTerminateDate)}</dd></div>}
                      {selectedZone?.plannedUse === "cover_crop" && <div><dt>Actual seeded</dt><dd>{formatDate(selectedZone.actualCoverCropSeedDate)}</dd></div>}
                      {selectedZone?.plannedUse === "cover_crop" && <div><dt>Actual terminated</dt><dd>{formatDate(selectedZone.actualCoverCropTerminateDate)}</dd></div>}
                      <div><dt>Area</dt><dd>{formatDisplayArea(selectedMapItem.areaSqM, distanceUnit)}</dd></div>
                      {selectedBed && <div><dt>Length</dt><dd>{formatLength(selectedBed.bedLengthM, distanceUnit)}</dd></div>}
                      <div><dt>Vertices</dt><dd>{selectedMapCoordinates.length}</dd></div>
                      {selectedBlockContext && <div><dt>Beds</dt><dd>{data.beds.filter((bed) => bed.blockId === selectedBlockContext.id).length}</dd></div>}
                      {selectedZone && selectedZone.plannedUse === "beds" && <div><dt>Beds in area</dt><dd>{data.beds.filter((bed) => bed.zoneId === selectedZone.id).length}</dd></div>}
                      <div><dt>Notes</dt><dd>{selectedMapItem.notes ?? "—"}</dd></div>
                    </dl>
                    {!isMobileViewport && (
                    <div className="button-row">
                      {mapWorkflowMode === "planning" ? (
                        <>
                          <button className="secondary-button" onClick={startEditSelection} disabled={!canEditSelectedMapItem}>Edit</button>
                          <button className="danger-button" onClick={() => void deleteSelected()} disabled={!canDeleteSelectedMapItem}>Delete</button>
                        </>
                      ) : (
                        <button className="secondary-button" onClick={() => changeMapWorkflowMode("planning")} disabled={!canPlan}>Switch to Planning to edit</button>
                      )}
                    </div>
                    )}
                  </>
                ) : (
                  <p className="muted">Nothing selected.</p>
                )}
              </div>

              {mapWorkflowMode === "planning" && selectedBlockContext && !canPlan && (
                <div className="card">
                  <h2>Block tools</h2>
                  <p className="muted">Generating beds and saving presets is limited to planner accounts.</p>
                </div>
              )}
                </>
              )}
            </div>
          </section>
        )}

        {view === "plan" && (
          <section className="content-grid split-grid">
            <div className="card">
              <div className="section-header">
                <div>
                  <h2>Annual crop plan</h2>
                  {canPlan && selectedPlanPlantingIds.length > 0 && (
                    <p className="muted">{selectedPlanPlantingIds.length} selected</p>
                  )}
                </div>
                {canPlan && selectedPlanPlantingIds.length > 0 && (
                  <button type="button" className="danger-button compact-button" onClick={() => void deleteSelectedPlantings()}>
                    Delete selected
                  </button>
                )}
              </div>
              {isMobileViewport ? (
                <div className="mobile-card-list">
                  {planGroups.map(([year, plantings]) => (
                    <div key={year} className="mobile-year-group">
                      <div className="mobile-list-header">
                        <h3>{year} crop plan</h3>
                        <span className="small-chip">{plantings.length} plantings</span>
                      </div>
                      <div className="mobile-card-list">
                        {plantings.map((planting) => {
                          const review = plantingReviewInfo(planting);
                          return (
                            <article key={planting.id} className="card mobile-summary-card">
                              <div className="mobile-list-header">
                                <div>
                                  <strong>{planting.title.replace(/^Needs completion - /, "")}</strong>
                                  <div className="table-subtle crop-name-with-review">
                                    <PlantingReviewMarker review={review} />
                                    <span>{planting.seedName ?? `${planting.cropName}${planting.varietyName ? ` / ${planting.varietyName}` : ""}`}</span>
                                  </div>
                                </div>
                                <span className={`status-pill status-${planting.status}`}>{planting.status.replaceAll("_", " ")}</span>
                              </div>
                              <div className="mobile-summary-grid">
                                <div className="mobile-summary-row">
                                  <span className="muted">Planned sow</span>
                                  <strong>{formatDate(planting.plannedSowDate)}</strong>
                                </div>
                                <div className="mobile-summary-row">
                                  <span className="muted">Transplant</span>
                                  <strong>{formatDate(planting.plannedTransplantDate)}</strong>
                                </div>
                                <div className="mobile-summary-row">
                                  <span className="muted">Harvest</span>
                                  <strong>{formatDate(planting.expectedHarvestStart)} to {formatDate(planting.expectedHarvestEnd)}</strong>
                                </div>
                                <div className="mobile-summary-row">
                                  <span className="muted">Location</span>
                                  <strong>{[planting.intendedFieldName, planting.intendedBlockName, planting.intendedBedName].filter(Boolean).join(" / ") || "—"}</strong>
                                </div>
                              </div>
                              <div className="button-row">
                                <button
                                  type="button"
                                  className="secondary-button compact-button"
                                  onClick={() => {
                                    setSelectedPlantingId(planting.id);
                                    setView("planting");
                                  }}
                                >
                                  Open detail
                                </button>
                                <button
                                  type="button"
                                  className="secondary-button compact-button"
                                  onClick={() => focusPlantingOnMap(planting)}
                                >
                                  Show on map
                                </button>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      {canPlan && <th>Pick</th>}
                      <th>Planting</th>
                      <th>Status</th>
                      <th>Planned sow</th>
                      <th>Planned transplant</th>
                      <th>Harvest window</th>
                      <th>Intended bed</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {planGroups.map(([year, plantings]) => (
                      <tr key={year}>
                        <td colSpan={canPlan ? 8 : 7} className="table-year-cell">
                          <details open={year >= Number(todayDateInputValue().slice(0, 4))}>
                            <summary>{year} crop plan ({plantings.length})</summary>
                            <table className="data-table nested-table">
                              <tbody>
                                {plantings.map((planting) => {
                                  const review = plantingReviewInfo(planting);
                                  const isSelected = selectedPlanPlantingIds.includes(planting.id);
                                  return (
                                    <tr key={planting.id} onClick={() => { setSelectedPlantingId(planting.id); setView("planting"); }}>
                                      {canPlan && (
                                        <td onClick={(event) => event.stopPropagation()} className="plan-select-cell">
                                          <input
                                            type="checkbox"
                                            checked={isSelected}
                                            aria-label={`Select ${planting.title}`}
                                            onChange={(event) => {
                                              const checked = event.target.checked;
                                              setSelectedPlanPlantingIds((current) => checked ? [...new Set([...current, planting.id])] : current.filter((id) => id !== planting.id));
                                            }}
                                          />
                                        </td>
                                      )}
                                      <td>
                                        <strong>{planting.title.replace(/^Needs completion - /, "")}</strong>
                                        <div className="table-subtle crop-name-with-review">
                                          <PlantingReviewMarker review={review} />
                                          <span>{planting.seedName ?? `${planting.cropName}${planting.varietyName ? ` / ${planting.varietyName}` : ""}`}</span>
                                        </div>
                                      </td>
                                      <td><span className={`status-pill status-${planting.status}`}>{planting.status.replaceAll("_", " ")}</span></td>
                                      <td>{formatDate(planting.plannedSowDate)}</td>
                                      <td>{formatDate(planting.plannedTransplantDate)}</td>
                                      <td>{formatDate(planting.expectedHarvestStart)} to {formatDate(planting.expectedHarvestEnd)}</td>
                                      <td>{[planting.intendedFieldName, planting.intendedBlockName, planting.intendedBedName].filter(Boolean).join(" / ") || "—"}</td>
                                      <td>
                                        {canPlan ? (
                                          <button
                                            type="button"
                                            className="danger-button compact-button"
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              void deletePlanting(planting.id);
                                            }}
                                          >
                                            Delete
                                          </button>
                                        ) : "—"}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {unscheduledTaskList.length > 0 && (
                <div className="instruction-box">
                  <strong>Unscheduled tasks</strong>
                  <p className="muted">These exist but do not have a due date yet. Bed-making tasks will get a date once plantings in that block have planned dates.</p>
                  <div className="generated-bed-list">
                    {unscheduledTaskList.map((task) => (
                      <button
                        key={task.id}
                        type="button"
                        className="small-chip chip-button"
                        onClick={() => {
                          setSelectedTaskId(task.id);
                          if (task.plantingId != null) {
                            setSelectedPlantingId(task.plantingId);
                          }
                        }}
                      >
                        {task.title}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {canPlan ? (
              <div className="stack">
                <PlantingForm
                  data={ownFarmData}
                  taskFlowTemplates={ownFarmData.taskFlowTemplates}
                  distanceUnit={distanceUnit}
                  tutorialDraft={tutorialPlantingDraft}
                  highlightSubmit={activeTutorialStep === 3}
                  onSave={async () => {
                    const flowId = tutorialPlantingDraft?.taskFlowTemplateId ?? null;
                    await load();
                    if (tutorialOpen && tutorialStepIndex === 3) {
                      if (flowId != null) {
                        setTutorialFlowId(flowId);
                        setSelectedFlowId(flowId);
                      }
                      setTutorialStepIndex(4);
                      setTutorialStatus("Planting created. Use the highlighted Task Flows navigation, then add the mow node.");
                    }
                    setTutorialPlantingDraft(null);
                  }}
                />
                <SpreadsheetImportCard tutorialActive={activeTutorialStep === 6 && view === "plan"} onImported={load} />
              </div>
            ) : (
              <div className="card"><h2>Planning access</h2><p className="muted">Worker accounts can review the crop plan but cannot create or change plantings.</p></div>
            )}
          </section>
        )}

        {view === "planting" && selectedPlanting && (
          <section className="content-grid split-grid">
            <div className="stack">
              <div className="card">
                <div className="section-header">
                  <div className="title-block">
                    <h2>{selectedPlanting.title.replace(/^Needs completion - /, "")}</h2>
                    <p className="muted crop-name-with-review">
                      <PlantingReviewMarker review={plantingReviewInfo(selectedPlanting)} />
                      <span>{selectedPlanting.seedName ?? `${selectedPlanting.cropName}${selectedPlanting.varietyName ? ` / ${selectedPlanting.varietyName}` : ""}`}</span>
                    </p>
                  </div>
                  <div className="header-actions">
                    <span className={`status-pill status-${selectedPlanting.status}`}>{selectedPlanting.status.replaceAll("_", " ")}</span>
                    {canPlan && (
                      <>
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          onClick={() => setEditingPlantingId(selectedPlanting.id)}
                        >
                          Edit planting
                        </button>
                        <button type="button" className="danger-button compact-button" onClick={() => void deletePlanting(selectedPlanting.id)}>
                          Delete planting
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="two-col">
                  <div>
                    <h3>Milestones</h3>
                    <dl className="detail-list">
                      <div><DetailTerm review={plantingReviewInfo(selectedPlanting)} fieldName="plannedSowDate">Planned sow</DetailTerm><dd>{formatDate(selectedPlanting.plannedSowDate)}</dd></div>
                      <div><dt>Actual tray seeding</dt><dd>{formatDate(selectedPlanting.actualTraySeedingDate)}</dd></div>
                      <div><dt>Actual direct seeding</dt><dd>{formatDate(selectedPlanting.actualDirectSeedingDate)}</dd></div>
                      <div><DetailTerm review={plantingReviewInfo(selectedPlanting)} fieldName="plannedTransplantDate">Planned transplant</DetailTerm><dd>{formatDate(selectedPlanting.plannedTransplantDate)}</dd></div>
                      <div><dt>Actual transplant</dt><dd>{formatDate(selectedPlanting.actualTransplantDate)}</dd></div>
                      <div><DetailTerm review={plantingReviewInfo(selectedPlanting)} fieldName="expectedHarvestStart">Expected harvest</DetailTerm><dd>{formatDate(selectedPlanting.expectedHarvestStart)} to {formatDate(selectedPlanting.expectedHarvestEnd)}</dd></div>
                      <div><dt>Actual harvest</dt><dd>{formatDate(selectedPlanting.actualHarvestDate)}</dd></div>
                      <div><dt>Actual finish</dt><dd>{formatDate(selectedPlanting.actualFinishDate)}</dd></div>
                    </dl>
                  </div>
                  <div>
                    <h3>Planning detail</h3>
                    <dl className="detail-list">
                      <div><dt>Status</dt><dd>{selectedPlanting.status.replaceAll("_", " ")}</dd></div>
                      <div><dt>Seed genetics</dt><dd>{selectedPlanting.seedName ?? "—"}</dd></div>
                      <div><DetailTerm review={plantingReviewInfo(selectedPlanting)} fieldName="spacing">Spacing</DetailTerm><dd>{formatSpacing(selectedPlanting.spacing, distanceUnit)}</dd></div>
                      <div><dt>In-row spacing</dt><dd>{selectedPlanting.fieldSpacingInRow == null ? "—" : `${selectedPlanting.fieldSpacingInRow} in`}</dd></div>
                      <div><dt>Row spacing</dt><dd>{selectedPlanting.rowSpacing == null ? "—" : `${selectedPlanting.rowSpacing} in`}</dd></div>
                      <div><DetailTerm review={plantingReviewInfo(selectedPlanting)} fieldName="rowsPerBed">Rows per bed</DetailTerm><dd>{selectedPlanting.rowsPerBed ?? "—"}</dd></div>
                      <div><DetailTerm review={plantingReviewInfo(selectedPlanting)} fieldName="daysToHarvest">Days to harvest</DetailTerm><dd>{selectedPlanting.daysToHarvest ?? "—"}</dd></div>
                      <div><DetailTerm review={plantingReviewInfo(selectedPlanting)} fieldName="bedCover">Bed cover</DetailTerm><dd>{selectedPlanting.bedCover === "plastic" ? "Plastic mulch" : selectedPlanting.bedCover ?? "—"}</dd></div>
                      <div><DetailTerm review={plantingReviewInfo(selectedPlanting)} fieldName="plantCount">Plant count</DetailTerm><dd>{selectedPlanting.plantCount ?? "—"}</dd></div>
                      <div><DetailTerm review={plantingReviewInfo(selectedPlanting)} fieldName="bedLengthUsed">Bed length used</DetailTerm><dd>{formatLength(selectedPlanting.bedLengthUsedM, distanceUnit)}</dd></div>
                      <div><dt>Tray location</dt><dd>{selectedPlanting.trayLocation ?? "—"}</dd></div>
                      <div><dt>Tray count</dt><dd>{selectedPlanting.trayCount ?? "—"}</dd></div>
                      <div><dt>Cells per tray</dt><dd>{selectedPlanting.cellsPerTray ?? "—"}</dd></div>
                      <div><DetailTerm review={plantingReviewInfo(selectedPlanting)} fieldName="field">Intended field</DetailTerm><dd>{selectedPlanting.intendedFieldName ?? "—"}</dd></div>
                      <div><DetailTerm review={plantingReviewInfo(selectedPlanting)} fieldName="block">Intended block</DetailTerm><dd>{selectedPlanting.intendedBlockName ?? "—"}</dd></div>
                      <div><DetailTerm review={plantingReviewInfo(selectedPlanting)} fieldName="bed">Intended bed</DetailTerm><dd>{selectedPlanting.intendedBedName ?? "—"}</dd></div>
                      <div><dt>Task flow</dt><dd>{selectedPlanting.taskFlowTemplateName ?? "Automatic default"}</dd></div>
                      <div><dt>Intended location</dt><dd>{[selectedPlanting.intendedFieldName, selectedPlanting.intendedBlockName, selectedPlanting.intendedBedName].filter(Boolean).join(" / ") || "—"}</dd></div>
                      <div><DetailTerm review={plantingReviewInfo(selectedPlanting)} fieldName="notes">Notes</DetailTerm><dd>{selectedPlanting.notes ?? "—"}</dd></div>
                    </dl>
                  </div>
                </div>
              </div>

              <div className="card">
                <h2>Child placements</h2>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Bed</th>
                      <th>Plant count</th>
                      <th>Bed length used</th>
                      <th>Exact location</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedPlacements.map((placement) => (
                      <tr key={placement.id}>
                        <td>{formatDate(placement.placedOn)}</td>
                        <td>{placement.bedName}</td>
                        <td>{placement.plantCount ?? "—"}</td>
                        <td>{formatLength(placement.bedLengthUsedM, distanceUnit)}</td>
                        <td>{placement.locationDetail ?? (placement.boundary ? "Mapped area" : "—")}</td>
                        <td>{placement.notes ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="card">
                <h2>Event history</h2>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Event</th>
                      <th>Bed</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedEvents.map((event) => (
                      <tr key={event.id}>
                        <td>{formatDate(event.eventDate)}</td>
                        <td>{event.eventType.replaceAll("_", " ")}</td>
                        <td>{event.title}</td>
                        <td>{event.bedName ?? "—"}</td>
                        <td>{event.notes ?? "—"}</td>
                      </tr>
                    ))}
                    {selectedEvents.length === 0 && (
                      <tr>
                        <td colSpan={5}>No events recorded yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="stack">
              {canPlan ? (
                <>
                  {editingPlantingId === selectedPlanting.id ? (
                    <PlantingEditCard
                      planting={selectedPlanting}
                      data={ownFarmData}
                      distanceUnit={distanceUnit}
                      onCancel={() => setEditingPlantingId(null)}
                      onSave={async () => {
                        await load(canPlan);
                        setEditingPlantingId(null);
                      }}
                    />
                  ) : (
                    <>
                      <PlacementForm plantingId={selectedPlanting.id} beds={ownBeds} distanceUnit={distanceUnit} onSave={load} />
                      <PlantingActualsCard planting={selectedPlanting} onSave={load} />
                    </>
                  )}
                </>
              ) : (
                <div className="card"><h2>Planning access</h2><p className="muted">Workers can view planting details here, but planting adjustments stay with planner accounts.</p></div>
              )}
            </div>
          </section>
        )}

        {view === "tasks" && (
          <section className="content-grid split-grid">
            <div className="card">
              <div className="section-header">
                <div>
                  <h2>{formatTaskWeekTitle(taskListWeekStart)}</h2>
                  <p className="muted">{formatWeekRange(taskListWeekStart)}</p>
                </div>
                <div className="button-row week-button-row">
                  <button type="button" className="secondary-button compact-button" onClick={() => setTaskListWeekStart((current) => addDaysToDate(current, -7))}>Previous week</button>
                  <button type="button" className="secondary-button compact-button" onClick={() => setTaskListWeekStart(startOfWeekDate(todayDateInputValue()))}>This week</button>
                  <button type="button" className="secondary-button compact-button" onClick={() => setTaskListWeekStart((current) => addDaysToDate(current, 7))}>Next week</button>
                </div>
              </div>
              {isCurrentTaskListWeek && (
                <div className="task-list-options">
                  <label className="layer-toggle">
                    <input
                      type="checkbox"
                      checked={showPastUndoneTasks}
                      onChange={(event) => setShowPastUndoneTasks(event.target.checked)}
                    />
                    <span>Past undone</span>
                  </label>
                </div>
              )}
              {isMobileViewport ? (
                <div className="mobile-card-list">
                  {visibleTaskList.map((task) => (
                    <article
                      key={task.id}
                      className="card mobile-summary-card"
                      onClick={() => selectTask(task)}
                    >
                      <div className="mobile-list-header">
                        <div className="task-cell">
                          <TaskIconMark taskType={task.taskType} color={taskColor(task)} secondaryColor={task.iconSecondaryColor} tractorModel={task.tractorModel} mini />
                          <strong>{task.title}</strong>
                        </div>
                        <span className={`status-pill status-${task.status}`}>{task.status}</span>
                      </div>
                      <div className="mobile-summary-grid">
                        <div className="mobile-summary-row">
                          <span className="muted">Date</span>
                          <strong>{formatDate(task.scheduledDate)}</strong>
                        </div>
                        <div className="mobile-summary-row">
                          <span className="muted">Planting</span>
                          <strong>{task.plantingTitle ?? "—"}</strong>
                        </div>
                        <div className="mobile-summary-row">
                          <span className="muted">Bed</span>
                          <strong>{task.bedName ?? "—"}</strong>
                        </div>
                        <div className="mobile-summary-row">
                          <span className="muted">Rule</span>
                            <strong>{task.anchor ? `${formatTaskAnchorLabel(task.anchor)} ${task.offsetDays && task.offsetDays >= 0 ? "+" : ""}${task.offsetDays ?? 0}d` : "manual"}</strong>
                        </div>
                      </div>
                      <div className="button-row">
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            selectTask(task);
                          }}
                        >
                          {taskNeedsRecordForm(task.taskType) ? "Open record" : "Open task"}
                        </button>
                        {task.status !== "done" && (
                          <button
                            type="button"
                            className="primary-button compact-button"
                            onClick={(event) => {
                              event.stopPropagation();
                              if (taskNeedsRecordForm(task.taskType)) {
                                selectTask(task);
                                return;
                              }
                              void quickCompleteTask(task);
                            }}
                          >
                            {taskNeedsRecordForm(task.taskType) ? "Record" : "Mark done"}
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                  {visibleTaskList.length === 0 && (
                    <p className="muted mobile-empty-state">No tasks scheduled for this week.</p>
                  )}
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Task</th>
                      <th>Planting</th>
                      <th>Bed</th>
                      <th>Status</th>
                      <th>Depends on</th>
                      <th>Rule</th>
                      <th>Done</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTaskList.map((task) => (
                      <tr key={task.id} onClick={() => selectTask(task)}>
                        <td>{formatDate(task.scheduledDate)}</td>
                        <td>
                          <div className="task-cell">
                            <TaskIconMark taskType={task.taskType} color={taskColor(task)} secondaryColor={task.iconSecondaryColor} tractorModel={task.tractorModel} mini />
                            <span>{task.title}</span>
                          </div>
                        </td>
                        <td>{task.plantingTitle ?? "—"}</td>
                        <td>{task.bedName ?? "—"}</td>
                        <td>{task.status}</td>
                        <td>{task.dependsOnTaskIds.length > 0 ? task.dependsOnTaskIds.map((dependencyId) => tasksById.get(dependencyId)?.title ?? `Task ${dependencyId}`).join(", ") : "—"}</td>
                          <td>{task.anchor ? `${formatTaskAnchorLabel(task.anchor)} ${task.offsetDays && task.offsetDays >= 0 ? "+" : ""}${task.offsetDays ?? 0}d` : "manual"}</td>
                        <td>
                          {task.status === "done" ? "Done" : (
                            <button
                              type="button"
                              className="primary-button compact-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                void quickCompleteTask(task);
                              }}
                            >
                              {taskNeedsRecordForm(task.taskType) ? "Record" : "Mark done"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {visibleTaskList.length === 0 && (
                      <tr><td colSpan={8}>No tasks scheduled for this week.</td></tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
            <div className="stack">
              {renderTaskRecordCard(selectedTask)}
              <div className="card">
                <h2>How shifting works</h2>
                  <p>Future tasks are generated from planned planting dates and task-flow arrows. When connected work is recorded, later connected task dates recalculate from that actual date instead of staying fixed to the original plan.</p>
                <p className="muted">Task recording now starts from the task list itself, with today filled in automatically and optional planting adjustments available before saving.</p>
              </div>
            </div>
          </section>
        )}

        {view === "record" && (
          <section className="content-grid split-grid">
            {renderTaskRecordCard(recordTaskCandidate)}
            <HarvestForm data={ownFarmData} onSave={load} />
          </section>
        )}

        {view === "flows" && (
          <section className="content-grid flow-layout">
            <div className="stack flow-sidebar">
              <div className="card">
                <div className="section-header">
                  <div className="title-block">
                    <h2>Reusable task flows</h2>
                    <p className="muted">Build crop-specific flows, visualize dependencies, and copy an existing flow before adjusting it.</p>
                  </div>
                  <div className="button-row">
                    <button type="button" className="secondary-button" onClick={startNewTaskFlow}>New flow</button>
                    <button type="button" className="secondary-button" onClick={() => void copySelectedTaskFlow()} disabled={selectedFlowTemplate == null}>Copy selected</button>
                    <button type="button" className="danger-button" onClick={() => void deleteSelectedTaskFlow()} disabled={selectedFlowTemplate == null}>Delete</button>
                  </div>
                </div>
                <div className="search-results">
                  {data.taskFlowTemplates.map((flow) => {
                    const tutorialFlowTarget = tutorialFlowNeedsSelection && flow.id === tutorialFlowId;
                    return (
                      <button
                        key={flow.id}
                        className={`list-link${selectedFlowId === flow.id ? " active-list-link" : ""}${tutorialTargetClass(tutorialFlowTarget)}`}
                        data-tutorial-label={tutorialFlowTarget ? "Select this flow" : undefined}
                        onClick={() => {
                          setSelectedFlowId(flow.id);
                          setFlowEditorKey((current) => current + 1);
                        }}
                      >
                        <strong>{flow.name}</strong>
                        <div className="table-subtle">{flow.cropName ?? "General"}{flow.isDefault ? " • default" : ""}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="flow-main">
              <TaskFlowEditorCard
                key={`${selectedFlowId ?? "new"}-${flowEditorKey}`}
                farmId={data.farm?.id ?? null}
                crops={data.crops}
                template={selectedFlowTemplate}
                nodes={selectedFlowNodes}
                edges={selectedFlowEdges}
                tractorProfiles={data.tractorProfiles}
                tutorialActive={activeTutorialStep === 4 && !tutorialFlowNeedsSelection}
                onSaved={async (nextId) => {
                  await load();
                  setSelectedFlowId(nextId);
                  setFlowEditorKey((current) => current + 1);
                  if (tutorialOpen && tutorialStepIndex === 4) {
                    setTutorialStepIndex(5);
                    selectFirstPastTutorialTask();
                  }
                }}
              />
              <GarageCard tractorProfiles={data.tractorProfiles} onChanged={load} />
            </div>
          </section>
        )}

        {view === "seed-bank" && (
          <SeedBankCard data={ownFarmData} canPlan={canPlan} onSave={load} />
        )}

        {view === "harvests" && (
          <section className="content-grid split-grid">
            <div className="card">
              <h2>Harvest log</h2>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Bed</th>
                    <th>Planting</th>
                    <th>Quantity</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {data.harvests.map((harvest) => (
                    <tr key={harvest.id}>
                      <td>{formatDate(harvest.harvestDate)}</td>
                      <td>{harvest.bedName}</td>
                      <td>{harvest.plantingTitle}</td>
                      <td>{harvest.quantity} {harvest.unit}</td>
                      <td>{harvest.notes ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card">
              <h2>Summary</h2>
              {Object.entries(
                data.harvests.reduce<Record<string, number>>((acc, harvest) => {
                  acc[harvest.unit] = (acc[harvest.unit] ?? 0) + Number(harvest.quantity);
                  return acc;
                }, {})
              ).map(([unit, total]) => (
                <p key={unit}><strong>{total}</strong> {unit}</p>
              ))}
            </div>
          </section>
        )}

        {view === "admin" && isAdmin && (
          <AdminPanel
            reports={feedbackReports}
            onRefresh={() => load(true, true)}
            onOpenFeedback={() => {
              recordActivity("feedback dialog opened", { page: view });
              setFeedbackStatus(null);
              setFeedbackOpen(true);
            }}
          />
        )}

        {view === "settings" && (
          <section className="content-grid split-grid">
            <div className="stack">
              <div className="card">
                <h2>Display settings</h2>
                <form className="form-grid">
                  <label>
                    <span>Distance units</span>
                    <select value={distanceUnit} onChange={(event) => setDistanceUnit(event.target.value as DistanceUnit)}>
                      <option value="m">Meters</option>
                      <option value="ft">Feet</option>
                    </select>
                  </label>
                  <label>
                    <span>Color theme</span>
                    <select value={themeMode} onChange={(event) => setThemeMode(event.target.value as ThemeMode)}>
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                    </select>
                  </label>
                </form>
                <p className="muted">This changes how lengths and areas are shown in the prototype. Data entry still uses meters for now.</p>
              </div>
              <div className="card">
                <h2>Preview</h2>
                <dl className="detail-list">
                  <div><dt>Bed length</dt><dd>{formatLength(30, distanceUnit)}</dd></div>
                  <div><dt>Area</dt><dd>{formatDisplayArea(120, distanceUnit)}</dd></div>
                  <div><dt>Theme</dt><dd>{themeMode === "dark" ? "Dark" : "Light"}</dd></div>
                </dl>
              </div>
              {canPlan && (
                <div className="card">
                  <h2>First account tutorial</h2>
                  <p className="muted">
                    {isMobileViewport
                      ? "The first-account tutorial uses desktop planning tools that are not available in the phone layout. Open Loam Ledger in a computer browser to run it."
                      : "Open the guided sequence for drawing a field, making a block, filling beds, planning cabbage, editing its task flow, recording past work, and finding spreadsheet import."}
                  </p>
                  <button
                    type="button"
                    className="primary-button full-span"
                    onClick={startTutorialFromBeginning}
                    disabled={isMobileViewport}
                  >
                    {isMobileViewport ? "Open on a computer browser" : "Start tutorial sequence"}
                  </button>
                </div>
              )}
              <div className="card">
                <h2>Account</h2>
                <dl className="detail-list">
                  <div><dt>User</dt><dd>{session.user.displayName ?? session.user.username}</dd></div>
                  <div><dt>Farm</dt><dd>{session.user.farmName}</dd></div>
                  <div><dt>Role</dt><dd>{session.user.isAdmin ? "admin" : roleLabel(session.user.role)}</dd></div>
                </dl>
                <button className="secondary-button full-span" onClick={() => void handleLogout()}>
                  Log out
                </button>
              </div>
              {canPlan ? (
                <TeamAccountsCard
                  farmName={session.user.farmName}
                  accounts={farmAccounts}
                  onCreated={() => void load(true)}
                />
              ) : (
                <div className="card">
                  <h2>Team accounts</h2>
                  <p className="muted">Only planner accounts can create or manage farm logins.</p>
                </div>
              )}
            </div>
            <div className="stack">
              <div className="card">
                <h2>Map imagery</h2>
                <p className="muted">The prototype is currently using the live web basemap only. Offline caching is disabled for now so the map stays predictable while you work on planning.</p>
              </div>
              <div className="card">
                <h2>Map privacy</h2>
                <p className="muted">
                  Farm maps are currently private by default while hosted sharing rules are being tightened up.
                </p>
              </div>
            </div>
          </section>
        )}
        <footer className="page-feedback-bar">
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              recordActivity("feedback dialog opened", { page: view });
              setFeedbackStatus(null);
              setFeedbackOpen(true);
            }}
          >
            Suggestion/problem
          </button>
        </footer>
      </main>
    </div>
  );
}

function PlantingEditCard({
  planting,
  data,
  distanceUnit,
  onCancel,
  onSave
}: {
  planting: Planting;
  data: DashboardData;
  distanceUnit: DistanceUnit;
  onCancel: () => void;
  onSave: () => Promise<void>;
}) {
  const bedById = useMemo(() => new Map(data.beds.map((bed) => [bed.id, bed])), [data.beds]);
  const blockById = useMemo(() => new Map(data.blocks.map((block) => [block.id, block])), [data.blocks]);
  const initialBed = planting.intendedBedId != null ? bedById.get(planting.intendedBedId) ?? null : null;
  const initialBlock = initialBed ? blockById.get(initialBed.blockId) ?? null : planting.intendedBlockId != null ? blockById.get(planting.intendedBlockId) ?? null : null;
  const initialSpacing = parseSpacingPairForUnit(planting.spacing, distanceUnit);
  const [cropId, setCropId] = useState(String(planting.cropId));
  const [varietyId, setVarietyId] = useState(planting.varietyId == null ? "" : String(planting.varietyId));
  const [title, setTitle] = useState(planting.title);
  const [statusValue, setStatusValue] = useState(planting.status);
  const [fieldId, setFieldId] = useState(initialBlock ? String(initialBlock.fieldId) : planting.intendedFieldId != null ? String(planting.intendedFieldId) : "");
  const [blockId, setBlockId] = useState(initialBlock ? String(initialBlock.id) : "");
  const [bedId, setBedId] = useState(initialBed ? String(initialBed.id) : "");
  const [taskFlowTemplateId, setTaskFlowTemplateId] = useState(planting.taskFlowTemplateId == null ? "" : String(planting.taskFlowTemplateId));
  const [spacingInRow, setSpacingInRow] = useState(initialSpacing.inRow);
  const [spacingBetweenRows, setSpacingBetweenRows] = useState(initialSpacing.betweenRows);
  const [plantCount, setPlantCount] = useState(planting.plantCount == null ? "" : String(planting.plantCount));
  const [bedLengthUsed, setBedLengthUsed] = useState(formatLengthInputValue(planting.bedLengthUsedM, distanceUnit));
  const [trayLocation, setTrayLocation] = useState(planting.trayLocation ?? "");
  const [trayCount, setTrayCount] = useState(planting.trayCount == null ? "" : String(planting.trayCount));
  const [cellsPerTray, setCellsPerTray] = useState(planting.cellsPerTray == null ? "" : String(planting.cellsPerTray));
  const [germinationRate, setGerminationRate] = useState("90");
  const [seedCellCount, setSeedCellCount] = useState("");
  const [expectedTrayPlants, setExpectedTrayPlants] = useState("");
  const [lastPlanningInput, setLastPlanningInput] = useState<PlantingPlanningInput>("initial");
  const [daysToHarvest, setDaysToHarvest] = useState(planting.daysToHarvest == null ? "" : String(planting.daysToHarvest));
  const [rowsPerBed, setRowsPerBed] = useState(planting.rowsPerBed == null ? "" : String(planting.rowsPerBed));
  const [bedCover, setBedCover] = useState(planting.bedCover ?? "");
  const [plannedSowDate, setPlannedSowDate] = useState(dateInputValue(planting.plannedSowDate));
  const [plannedTransplantDate, setPlannedTransplantDate] = useState(dateInputValue(planting.plannedTransplantDate));
  const [expectedHarvestStart, setExpectedHarvestStart] = useState(dateInputValue(planting.expectedHarvestStart));
  const [expectedHarvestEnd, setExpectedHarvestEnd] = useState(dateInputValue(planting.expectedHarvestEnd));
  const [lastDateInput, setLastDateInput] = useState<PlantingDateInput>("initial");
  const [notes, setNotes] = useState(planting.notes ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const varietiesForCrop = data.varieties.filter((variety) => String(variety.cropId) === cropId);
  const blocksForField = fieldId ? data.blocks.filter((block) => String(block.fieldId) === fieldId) : data.blocks;
  const plantableBeds = data.beds.filter((bed) => bed.source !== "road");
  const blockIdsForField = new Set(blocksForField.map((block) => block.id));
  const bedsForLocation = blockId
    ? plantableBeds.filter((bed) => String(bed.blockId) === blockId)
    : fieldId
      ? plantableBeds.filter((bed) => blockIdsForField.has(bed.blockId))
      : plantableBeds;
  const review = useMemo<PlantingReviewInfo>(() => {
    const currentReview = plantingReviewInfo(planting);
    const majorFields = new Set(currentReview.majorFields);
    const minorFields = new Set(currentReview.minorFields);

    if (!title.trim()) majorFields.add("title");
    if (!plannedSowDate.trim()) majorFields.add("plannedSowDate");
    if (!plantCount.trim() && !bedLengthUsed.trim()) {
      majorFields.add("plantCount");
      majorFields.add("bedLengthUsed");
    }
    if (!fieldId) majorFields.add("field");
    if (!blockId) majorFields.add("block");
    if (!rowsPerBed.trim()) minorFields.add("rowsPerBed");
    if (!daysToHarvest.trim() && !expectedHarvestStart.trim()) minorFields.add("daysToHarvest");
    if (!bedCover) minorFields.add("bedCover");

    const severity: PlantingReviewSeverity | null = majorFields.size > 0 ? "major" : minorFields.size > 0 ? "minor" : null;
    return {
      ...currentReview,
      severity,
      majorFields,
      minorFields
    };
  }, [planting, title, plannedSowDate, plantCount, bedLengthUsed, fieldId, blockId, rowsPerBed, daysToHarvest, expectedHarvestStart, bedCover]);
  const selectedBedForCalc = bedId ? bedById.get(Number(bedId)) ?? null : null;
  const calcTrayCount = Number(trayCount);
  const calcCellsPerTray = Number(cellsPerTray);
  const calcGerminationRate = Number(germinationRate);
  const calcPlantCount = Number(plantCount);
  const calcRowsPerBed = Number(rowsPerBed);
  const calcInRowSpacingM = spacingInputToMeters(spacingInRow, distanceUnit);
  const enteredBedLengthM = parseLengthInputValue(bedLengthUsed || null, distanceUnit);
  const availableBedLengthM = enteredBedLengthM ?? selectedBedForCalc?.bedLengthM ?? null;
  const germinationRateDecimal = Number.isFinite(calcGerminationRate) && calcGerminationRate > 0 && calcGerminationRate <= 100
    ? calcGerminationRate / 100
    : null;
  const cellsSeededFromTrays = Number.isFinite(calcTrayCount) && calcTrayCount > 0 && Number.isFinite(calcCellsPerTray) && calcCellsPerTray > 0
    ? Math.round(calcTrayCount * calcCellsPerTray)
    : null;
  const plantsFromTrays = cellsSeededFromTrays != null && germinationRateDecimal != null
    ? Math.max(1, Math.round(cellsSeededFromTrays * germinationRateDecimal))
    : null;
  const plantsForBedLength = availableBedLengthM != null && availableBedLengthM > 0 && calcInRowSpacingM != null && Number.isFinite(calcRowsPerBed) && calcRowsPerBed > 0
    ? Math.max(1, Math.floor((availableBedLengthM * calcRowsPerBed) / calcInRowSpacingM))
    : null;
  const traysForBedLength = plantsForBedLength != null && Number.isFinite(calcCellsPerTray) && calcCellsPerTray > 0
    && germinationRateDecimal != null
    ? Math.ceil(plantsForBedLength / (calcCellsPerTray * germinationRateDecimal))
    : null;
  const cellsToSeedForBedLength = plantsForBedLength != null && germinationRateDecimal != null
    ? Math.ceil(plantsForBedLength / germinationRateDecimal)
    : null;
  const setNumberStringIfChanged = (setter: (value: string) => void, currentValue: string, nextValue: number | null, precision = 0) => {
    if (nextValue == null || !Number.isFinite(nextValue) || nextValue <= 0) {
      return;
    }
    const formatted = precision === 0 ? String(Math.round(nextValue)) : String(Number(nextValue.toFixed(precision)));
    if (currentValue !== formatted) {
      setter(formatted);
    }
  };

  useEffect(() => {
    if (lastPlanningInput === "initial") {
      return;
    }

    const validPlantCount = Number.isFinite(calcPlantCount) && calcPlantCount > 0 ? calcPlantCount : null;
    const validBedLengthM = enteredBedLengthM != null && enteredBedLengthM > 0 ? enteredBedLengthM : selectedBedForCalc?.bedLengthM ?? null;
    const validSeedCells = Number(seedCellCount);
    const usableSeedCells = Number.isFinite(validSeedCells) && validSeedCells > 0 ? validSeedCells : cellsSeededFromTrays;
    let nextPlantCount: number | null = null;
    let nextBedLengthM: number | null = null;
    let nextSeedCells: number | null = null;
    let nextTrayCount: number | null = null;
    let nextExpectedTrayPlants: number | null = null;

    if (lastPlanningInput === "trayCount" || lastPlanningInput === "cellsPerTray" || lastPlanningInput === "germinationRate") {
      nextSeedCells = cellsSeededFromTrays;
      nextPlantCount = plantsFromTrays;
      nextExpectedTrayPlants = plantsFromTrays;
    } else if (lastPlanningInput === "seedCellCount") {
      nextPlantCount = usableSeedCells != null && germinationRateDecimal != null ? Math.max(1, Math.round(usableSeedCells * germinationRateDecimal)) : null;
      nextExpectedTrayPlants = nextPlantCount;
      nextTrayCount = usableSeedCells != null && Number.isFinite(calcCellsPerTray) && calcCellsPerTray > 0 ? Math.ceil(usableSeedCells / calcCellsPerTray) : null;
    } else if (lastPlanningInput === "expectedTrayPlants") {
      const expectedPlants = Number(expectedTrayPlants);
      nextPlantCount = Number.isFinite(expectedPlants) && expectedPlants > 0 ? Math.round(expectedPlants) : null;
      nextSeedCells = nextPlantCount != null && germinationRateDecimal != null ? Math.ceil(nextPlantCount / germinationRateDecimal) : null;
      nextTrayCount = nextSeedCells != null && Number.isFinite(calcCellsPerTray) && calcCellsPerTray > 0 ? Math.ceil(nextSeedCells / calcCellsPerTray) : null;
    } else if (lastPlanningInput === "bedLengthUsed" || lastPlanningInput === "bed") {
      nextPlantCount = plantsForBedLength;
      nextExpectedTrayPlants = plantsForBedLength;
      nextSeedCells = cellsToSeedForBedLength;
      nextTrayCount = traysForBedLength;
    } else if (lastPlanningInput === "plantCount") {
      nextPlantCount = validPlantCount;
      nextExpectedTrayPlants = validPlantCount;
      nextSeedCells = validPlantCount != null && germinationRateDecimal != null ? Math.ceil(validPlantCount / germinationRateDecimal) : null;
      nextTrayCount = nextSeedCells != null && Number.isFinite(calcCellsPerTray) && calcCellsPerTray > 0 ? Math.ceil(nextSeedCells / calcCellsPerTray) : null;
    } else if (lastPlanningInput === "spacing" || lastPlanningInput === "rowsPerBed") {
      if (validPlantCount != null) {
        nextPlantCount = validPlantCount;
      } else if (validBedLengthM != null) {
        nextPlantCount = plantsForBedLength;
      }
    }

    const plantCountForLength = nextPlantCount ?? validPlantCount;
    if (lastPlanningInput === "bed" && validBedLengthM != null) {
      nextBedLengthM = validBedLengthM;
    } else if (plantCountForLength != null && calcInRowSpacingM != null && Number.isFinite(calcRowsPerBed) && calcRowsPerBed > 0) {
      nextBedLengthM = (plantCountForLength * calcInRowSpacingM) / calcRowsPerBed;
    }

    if (lastPlanningInput !== "seedCellCount") {
      setNumberStringIfChanged(setSeedCellCount, seedCellCount, nextSeedCells);
    }
    if (lastPlanningInput !== "expectedTrayPlants") {
      setNumberStringIfChanged(setExpectedTrayPlants, expectedTrayPlants, nextExpectedTrayPlants);
    }
    if (lastPlanningInput !== "plantCount") {
      setNumberStringIfChanged(setPlantCount, plantCount, nextPlantCount);
    }
    if (lastPlanningInput !== "bedLengthUsed") {
      setNumberStringIfChanged(setBedLengthUsed, bedLengthUsed, nextBedLengthM == null ? null : Number(formatLengthInputValue(nextBedLengthM, distanceUnit)), 1);
    }
    if (lastPlanningInput !== "trayCount") {
      setNumberStringIfChanged(setTrayCount, trayCount, nextTrayCount);
    }
  }, [
    lastPlanningInput,
    calcPlantCount,
    enteredBedLengthM,
    selectedBedForCalc,
    seedCellCount,
    cellsSeededFromTrays,
    plantsFromTrays,
    plantsForBedLength,
    germinationRateDecimal,
    calcCellsPerTray,
    expectedTrayPlants,
    cellsToSeedForBedLength,
    traysForBedLength,
    calcInRowSpacingM,
    calcRowsPerBed,
    plantCount,
    bedLengthUsed,
    trayCount,
    distanceUnit
  ]);

  useEffect(() => {
    if (lastDateInput === "initial") {
      return;
    }

    const harvestBaseDate = plannedTransplantDate || plannedSowDate;
    const numericDaysToHarvest = Number(daysToHarvest);
    const validDaysToHarvest = Number.isFinite(numericDaysToHarvest) && numericDaysToHarvest > 0
      ? Math.round(numericDaysToHarvest)
      : null;

    if (lastDateInput === "expectedHarvestStart") {
      const calculatedDays = daysBetweenDateStrings(harvestBaseDate || null, expectedHarvestStart || null);
      if (calculatedDays != null && daysToHarvest !== String(calculatedDays)) {
        setDaysToHarvest(String(calculatedDays));
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
  }, [lastDateInput, plannedSowDate, plannedTransplantDate, daysToHarvest, expectedHarvestStart, expectedHarvestEnd]);

  useEffect(() => {
    const nextBed = planting.intendedBedId != null ? bedById.get(planting.intendedBedId) ?? null : null;
    const nextBlock = nextBed ? blockById.get(nextBed.blockId) ?? null : planting.intendedBlockId != null ? blockById.get(planting.intendedBlockId) ?? null : null;
    const nextSpacing = parseSpacingPairForUnit(planting.spacing, distanceUnit);
    setCropId(String(planting.cropId));
    setVarietyId(planting.varietyId == null ? "" : String(planting.varietyId));
    setTitle(planting.title);
    setStatusValue(planting.status);
    setFieldId(nextBlock ? String(nextBlock.fieldId) : planting.intendedFieldId != null ? String(planting.intendedFieldId) : "");
    setBlockId(nextBlock ? String(nextBlock.id) : "");
    setBedId(nextBed ? String(nextBed.id) : "");
    setTaskFlowTemplateId(planting.taskFlowTemplateId == null ? "" : String(planting.taskFlowTemplateId));
    setSpacingInRow(nextSpacing.inRow);
    setSpacingBetweenRows(nextSpacing.betweenRows);
    setPlantCount(planting.plantCount == null ? "" : String(planting.plantCount));
    setBedLengthUsed(formatLengthInputValue(planting.bedLengthUsedM, distanceUnit));
    setTrayLocation(planting.trayLocation ?? "");
    setTrayCount(planting.trayCount == null ? "" : String(planting.trayCount));
    setCellsPerTray(planting.cellsPerTray == null ? "" : String(planting.cellsPerTray));
    setGerminationRate("90");
    setSeedCellCount("");
    setExpectedTrayPlants("");
    setLastPlanningInput("initial");
    setDaysToHarvest(planting.daysToHarvest == null ? "" : String(planting.daysToHarvest));
    setRowsPerBed(planting.rowsPerBed == null ? "" : String(planting.rowsPerBed));
    setBedCover(planting.bedCover ?? "");
    setPlannedSowDate(dateInputValue(planting.plannedSowDate));
    setPlannedTransplantDate(dateInputValue(planting.plannedTransplantDate));
    setExpectedHarvestStart(dateInputValue(planting.expectedHarvestStart));
    setExpectedHarvestEnd(dateInputValue(planting.expectedHarvestEnd));
    setLastDateInput("initial");
    setNotes(planting.notes ?? "");
    setMessage(null);
  }, [planting, distanceUnit, bedById, blockById]);

  async function savePlantingEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cropIdValue = Number(cropId);
    const plantCountValue = plantCount.trim() ? Number(plantCount) : null;
    const bedLengthUsedM = parseLengthInputValue(bedLengthUsed || null, distanceUnit);
    const trayCountValue = trayCount.trim() ? Number(trayCount) : null;
    const cellsPerTrayValue = cellsPerTray.trim() ? Number(cellsPerTray) : null;
    const daysToHarvestValue = daysToHarvest.trim() ? Number(daysToHarvest) : null;
    const rowsPerBedValue = rowsPerBed.trim() ? Number(rowsPerBed) : null;
    const spacing = formatSpacingPair(spacingInRow, spacingBetweenRows, distanceUnit);

    if (!Number.isFinite(cropIdValue)) {
      setMessage("Choose a crop.");
      return;
    }
    if (!title.trim()) {
      setMessage("Title is required.");
      return;
    }
    if (plantCountValue != null && (!Number.isInteger(plantCountValue) || plantCountValue <= 0)) {
      setMessage("Plant count must be a whole number above zero.");
      return;
    }
    if (bedLengthUsed.trim() && bedLengthUsedM == null) {
      setMessage("Bed length used must be above zero.");
      return;
    }
    if (plantCountValue == null && bedLengthUsedM == null) {
      setMessage("Plant count or bed length used is required.");
      return;
    }
    if (trayCountValue != null && (!Number.isInteger(trayCountValue) || trayCountValue <= 0)) {
      setMessage("Tray count must be a whole number above zero.");
      return;
    }
    if (cellsPerTrayValue != null && (!Number.isInteger(cellsPerTrayValue) || cellsPerTrayValue <= 0)) {
      setMessage("Cells per tray must be a whole number above zero.");
      return;
    }
    if (daysToHarvestValue != null && (!Number.isInteger(daysToHarvestValue) || daysToHarvestValue <= 0)) {
      setMessage("Days to harvest must be a whole number above zero.");
      return;
    }
    if (rowsPerBedValue != null && (!Number.isInteger(rowsPerBedValue) || rowsPerBedValue <= 0)) {
      setMessage("Rows per bed must be a whole number above zero.");
      return;
    }
    if (spacingInRow.trim() && spacingInputToMeters(spacingInRow, distanceUnit) == null) {
      setMessage("In-row spacing must be above zero.");
      return;
    }
    if (spacingBetweenRows.trim() && spacingInputToMeters(spacingBetweenRows, distanceUnit) == null) {
      setMessage("Between-row spacing must be above zero.");
      return;
    }
    if ((statusValue === "seeded_in_tray" || statusValue === "direct_seeded") && plannedSowDate && plannedSowDate > todayDateInputValue()) {
      setMessage("Planted dates cannot be in the future. Keep the status planned for future work.");
      return;
    }
    if (statusValue === "transplanted" && plannedTransplantDate && plannedTransplantDate > todayDateInputValue()) {
      setMessage("Planted dates cannot be in the future. Keep the status planned for future work.");
      return;
    }

    try {
      setSaving(true);
      setMessage("Saving planting...");
      await api.updatePlanting(planting.id, {
        cropId: cropIdValue,
        varietyId: varietyId ? Number(varietyId) : null,
        seedItemId: planting.seedItemId,
        title: title.trim(),
        status: statusValue,
        intendedFieldId: fieldId ? Number(fieldId) : null,
        intendedBlockId: blockId ? Number(blockId) : null,
        intendedBedId: bedId ? Number(bedId) : null,
        taskFlowTemplateId: taskFlowTemplateId ? Number(taskFlowTemplateId) : null,
        spacing,
        plantCount: plantCountValue,
        bedLengthUsedM,
        trayLocation: trayLocation.trim() || null,
        trayCount: trayCountValue,
        cellsPerTray: cellsPerTrayValue,
        daysToHarvest: daysToHarvestValue,
        fieldSpacingInRow: spacingInRow.trim() ? Number(spacingInRow) : null,
        rowSpacing: spacingBetweenRows.trim() ? Number(spacingBetweenRows) : null,
        rowsPerBed: rowsPerBedValue,
        bedCover: bedCover || null,
        notes: notes.trim() || null,
        plannedSowDate: plannedSowDate || null,
        plannedTransplantDate: plannedTransplantDate || null,
        expectedHarvestStart: expectedHarvestStart || null,
        expectedHarvestEnd: expectedHarvestEnd || null
      });
      await onSave();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update planting.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div className="section-header">
        <div>
          <h2>Edit planting</h2>
          <p className="muted">Change the plan, location, dates, spacing, and counts for this planting.</p>
        </div>
        <button type="button" className="secondary-button compact-button" onClick={onCancel}>Cancel</button>
      </div>
      <form className="form-grid" onSubmit={(event) => void savePlantingEdit(event)}>
        <label>
          <FieldLabel review={review} fieldName="crop">Crop</FieldLabel>
          <select
            value={cropId}
            onChange={(event) => {
              setCropId(event.target.value);
              setVarietyId("");
            }}
          >
            {data.crops.map((crop) => <option key={crop.id} value={crop.id}>{crop.name}</option>)}
          </select>
        </label>
        <label>
          <FieldLabel review={review} fieldName="variety">Variety</FieldLabel>
          <select value={varietyId} onChange={(event) => setVarietyId(event.target.value)}>
            <option value="">None / decide later</option>
            {varietiesForCrop.map((variety) => <option key={variety.id} value={variety.id}>{variety.name}</option>)}
          </select>
        </label>
        <label className="full-span">
          <FieldLabel review={review} fieldName="title">Title</FieldLabel>
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} required />
        </label>
        <label>
          <span>Status</span>
          <select value={statusValue} onChange={(event) => setStatusValue(event.target.value)}>
            {plantingStatuses.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}
          </select>
        </label>
        <label>
          <span>Task flow</span>
          <select value={taskFlowTemplateId} onChange={(event) => setTaskFlowTemplateId(event.target.value)}>
            <option value="">Automatic default</option>
            {data.taskFlowTemplates.map((flow) => <option key={flow.id} value={flow.id}>{flow.name}{flow.cropName ? ` (${flow.cropName})` : ""}</option>)}
          </select>
        </label>

        <label>
          <FieldLabel review={review} fieldName="field">Field</FieldLabel>
          <select
            value={fieldId}
            onChange={(event) => {
              setFieldId(event.target.value);
              setBlockId("");
              setBedId("");
            }}
          >
            <option value="">Any field</option>
            {data.fields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
          </select>
        </label>
        <label>
          <FieldLabel review={review} fieldName="block">Block</FieldLabel>
          <select
            value={blockId}
            onChange={(event) => {
              setBlockId(event.target.value);
              setBedId("");
            }}
          >
            <option value="">Any block</option>
            {blocksForField.map((block) => <option key={block.id} value={block.id}>{block.fieldName} / {block.name}</option>)}
          </select>
        </label>
        <label className="full-span">
          <FieldLabel review={review} fieldName="bed">Intended bed</FieldLabel>
          <select
            value={bedId}
            onChange={(event) => {
              const nextBedId = event.target.value;
              setBedId(nextBedId);
              setLastPlanningInput("bed");
              const nextBed = nextBedId ? bedById.get(Number(nextBedId)) ?? null : null;
              const nextBlock = nextBed ? blockById.get(nextBed.blockId) ?? null : null;
              if (nextBed) {
                setBlockId(String(nextBed.blockId));
              }
              if (nextBlock) {
                setFieldId(String(nextBlock.fieldId));
              }
            }}
          >
            <option value="">Unassigned</option>
            {bedsForLocation.map((bed) => <option key={bed.id} value={bed.id}>{bed.blockName} / {bed.name}</option>)}
          </select>
        </label>

        <label>
          <FieldLabel review={review} fieldName="plannedSowDate">Planned sow</FieldLabel>
          <input
            type="date"
            value={plannedSowDate}
            onChange={(event) => {
              setPlannedSowDate(event.target.value);
              setLastDateInput("plannedSowDate");
            }}
          />
        </label>
        <label>
          <FieldLabel review={review} fieldName="plannedTransplantDate">Planned transplant</FieldLabel>
          <input
            type="date"
            value={plannedTransplantDate}
            onChange={(event) => {
              setPlannedTransplantDate(event.target.value);
              setLastDateInput("plannedTransplantDate");
            }}
          />
        </label>
        <label>
          <FieldLabel review={review} fieldName="expectedHarvestStart">Harvest start</FieldLabel>
          <input
            type="date"
            value={expectedHarvestStart}
            onChange={(event) => {
              setExpectedHarvestStart(event.target.value);
              setLastDateInput("expectedHarvestStart");
            }}
          />
        </label>
        <label>
          <FieldLabel review={review} fieldName="expectedHarvestEnd">Harvest end</FieldLabel>
          <input
            type="date"
            value={expectedHarvestEnd}
            onChange={(event) => {
              setExpectedHarvestEnd(event.target.value);
              setLastDateInput("expectedHarvestEnd");
            }}
          />
        </label>

        <div className="full-span spacing-pair">
          <label>
            <FieldLabel review={review} fieldName="spacing">In-row spacing ({spacingUnitLabel(distanceUnit)})</FieldLabel>
            <input
              type="number"
              min="0"
              step={distanceUnit === "ft" ? "0.5" : "1"}
              value={spacingInRow}
              onChange={(event) => {
                setSpacingInRow(event.target.value);
                setLastPlanningInput("spacing");
              }}
              placeholder={defaultSpacingExample(distanceUnit).split(" x ")[0]}
            />
          </label>
          <label>
            <FieldLabel review={review} fieldName="spacing">Between-row spacing ({spacingUnitLabel(distanceUnit)})</FieldLabel>
            <input
              type="number"
              min="0"
              step={distanceUnit === "ft" ? "0.5" : "1"}
              value={spacingBetweenRows}
              onChange={(event) => {
                setSpacingBetweenRows(event.target.value);
                setLastPlanningInput("spacing");
              }}
              placeholder={defaultSpacingExample(distanceUnit).split(" x ")[1]}
            />
          </label>
        </div>
        <label>
          <FieldLabel review={review} fieldName="plantCount">Plant count</FieldLabel>
          <input
            type="number"
            min="1"
            step="1"
            value={plantCount}
            onChange={(event) => {
              setPlantCount(event.target.value);
              setLastPlanningInput("plantCount");
            }}
          />
        </label>
        <label>
          <FieldLabel review={review} fieldName="bedLengthUsed">Bed length used ({distanceUnit})</FieldLabel>
          <input
            type="number"
            min="0"
            step="0.1"
            value={bedLengthUsed}
            onChange={(event) => {
              setBedLengthUsed(event.target.value);
              setLastPlanningInput("bedLengthUsed");
            }}
          />
        </label>
        <label>
          <FieldLabel review={review} fieldName="rowsPerBed">Rows per bed</FieldLabel>
          <input
            type="number"
            min="1"
            step="1"
            value={rowsPerBed}
            onChange={(event) => {
              setRowsPerBed(event.target.value);
              setLastPlanningInput("rowsPerBed");
            }}
          />
        </label>
        <label>
          <FieldLabel review={review} fieldName="daysToHarvest">Days to harvest</FieldLabel>
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
          <FieldLabel review={review} fieldName="bedCover">Bed cover</FieldLabel>
          <select value={bedCover} onChange={(event) => setBedCover(event.target.value)}>
            <option value="">Not set</option>
            <option value="bare">Bare</option>
            <option value="plastic">Plastic mulch</option>
          </select>
        </label>
        <label>
          <span>Tray count</span>
          <input
            type="number"
            min="1"
            step="1"
            value={trayCount}
            onChange={(event) => {
              setTrayCount(event.target.value);
              setLastPlanningInput("trayCount");
            }}
          />
        </label>
        <label>
          <span>Cells per tray</span>
          <input
            type="number"
            min="1"
            step="1"
            value={cellsPerTray}
            onChange={(event) => {
              setCellsPerTray(event.target.value);
              setLastPlanningInput("cellsPerTray");
            }}
          />
        </label>
        <label>
          <span>Germination rate (%)</span>
          <input
            type="number"
            min="1"
            max="100"
            step="1"
            value={germinationRate}
            onChange={(event) => {
              setGerminationRate(event.target.value);
              setLastPlanningInput("germinationRate");
            }}
          />
        </label>
        <label>
          <span>Seed cells needed</span>
          <input
            type="number"
            min="1"
            step="1"
            value={seedCellCount}
            onChange={(event) => {
              setSeedCellCount(event.target.value);
              setLastPlanningInput("seedCellCount");
            }}
          />
        </label>
        <label>
          <span>Expected usable plants</span>
          <input
            type="number"
            min="1"
            step="1"
            value={expectedTrayPlants}
            onChange={(event) => {
              setExpectedTrayPlants(event.target.value);
              setLastPlanningInput("expectedTrayPlants");
            }}
          />
        </label>
        <div className="instruction-box full-span">
          Fill in the numbers you know. The form will use spacing, rows per bed, germination rate, trays, cells, plant count, and bed length to fill related fields.
          {selectedBedForCalc && !bedLengthUsed.trim() && (
            <span> Selected bed length available: {selectedBedForCalc.name}, {formatLength(selectedBedForCalc.bedLengthM, distanceUnit)}.</span>
          )}
        </div>
        <label><span>Tray location</span><input value={trayLocation} onChange={(event) => setTrayLocation(event.target.value)} /></label>
        <label className="full-span"><FieldLabel review={review} fieldName="notes">Notes</FieldLabel><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        {message && <p className="muted full-span"><strong>{message}</strong></p>}
        <button className="primary-button full-span" disabled={saving}>{saving ? "Saving..." : "Save planting changes"}</button>
      </form>
    </div>
  );
}

function MapDrawingEvents({
  mode,
  onAddPoint,
  onClearSelection
}: {
  mode: MapMode;
  onAddPoint: (point: CoordinateDraft) => void;
  onClearSelection: () => void;
}) {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    container.classList.toggle("point-select-map", isPointSelectionMapMode(mode));
  }, [map, mode]);

  // This invisible component translates Leaflet map clicks into the current
  // drawing/selecting behavior. React-Leaflet hooks must run inside MapContainer.
  useMapEvents({
    click(event) {
      if (mode === "pick_bed_edge") {
        return;
      }
      if (isPointSelectionMapMode(mode)) {
        onAddPoint({ lat: event.latlng.lat, lng: event.latlng.lng });
        return;
      }
      if (mode === "select") {
        onClearSelection();
      }
    }
  });

  return null;
}

function MapLineDragEvents({
  activeLineIndex,
  onMoveLine,
  onStopDrag
}: {
  activeLineIndex: number | null;
  onMoveLine: (index: number, point: CoordinateDraft) => void;
  onStopDrag: () => void;
}) {
  const map = useMap();

  useEffect(() => {
    if (activeLineIndex == null) {
      return;
    }

    map.dragging.disable();
    return () => {
      map.dragging.enable();
    };
  }, [activeLineIndex, map]);

  useMapEvents({
    mousemove(event) {
      if (activeLineIndex == null) {
        return;
      }
      onMoveLine(activeLineIndex, { lat: event.latlng.lat, lng: event.latlng.lng });
    },
    mouseup() {
      if (activeLineIndex != null) {
        onStopDrag();
      }
    }
  });

  return null;
}

// On first load, zoom to saved farm geometry unless the user already has a
// manually stored map position.
function FitToFarm({ fields, blocks }: { fields: Field[]; blocks: Block[] }) {
  const map = useMap();
  const [hasFit, setHasFit] = useState(false);

  useEffect(() => {
    if (hasFit || hasStoredMapView()) {
      return;
    }

    const allPoints = [...fields, ...blocks].flatMap((item) => {
      const points = geoJsonPolygonToLatLngs(item.boundary);
      return points.map((point) => [point.lat, point.lng] as LatLngTuple);
    });

    if (allPoints.length > 0) {
      map.fitBounds(allPoints, { padding: [30, 30] });
      setHasFit(true);
    }
  }, [fields, blocks, hasFit, map]);

  return null;
}

// When the user selects a field/block/zone/bed, center that object on screen.
function FocusSelection({
  selection,
  fields,
  blocks,
  zones,
  beds,
  disabled = false
}: {
  selection: MapSelection;
  fields: Field[];
  blocks: Block[];
  zones: BlockZone[];
  beds: Bed[];
  disabled?: boolean;
}) {
  const map = useMap();
  const lastHandledSelectionKey = useRef<string | null>(null);
  const selectionKey = selection ? `${selection.type}:${selection.id}` : null;

  useEffect(() => {
    if (disabled || !selection || !selectionKey) {
      lastHandledSelectionKey.current = selectionKey;
      return;
    }

    if (lastHandledSelectionKey.current === selectionKey) {
      return;
    }

    const points = selection.type === "field"
      ? geoJsonPolygonToLatLngs(fields.find((field) => field.id === selection.id)?.boundary ?? null)
      : selection.type === "block"
        ? geoJsonPolygonToLatLngs(blocks.find((block) => block.id === selection.id)?.boundary ?? null)
        : selection.type === "zone"
          ? geoJsonPolygonToLatLngs(zones.find((zone) => zone.id === selection.id)?.boundary ?? null)
          : geoJsonPolygonToLatLngs(beds.find((bed) => bed.id === selection.id)?.boundary ?? null);

    if (points.length >= 3) {
      lastHandledSelectionKey.current = selectionKey;
      map.fitBounds(points.map((point) => [point.lat, point.lng] as LatLngTuple), {
        padding: [24, 24]
      });
    }
  }, [selection, selectionKey, fields, blocks, zones, beds, disabled, map]);

  return null;
}

// Centers the Leaflet map after the browser returns a phone GPS location.
function FocusUserLocation({ location }: { location: UserLocation | null }) {
  const map = useMap();

  useEffect(() => {
    if (!location) {
      return;
    }

    map.setView([location.lat, location.lng], Math.max(map.getZoom(), 18), {
      animate: true
    });
  }, [location, map]);

  return null;
}

// Keeps React state aware of Leaflet zoom so labels/layers can simplify at
// different map scales.
function MapZoomTracker({ onZoomChange }: { onZoomChange: (zoom: number) => void }) {
  const map = useMap();

  useEffect(() => {
    const updateZoom = () => onZoomChange(map.getZoom());
    updateZoom();
    map.on("zoomend", updateZoom);
    return () => {
      map.off("zoomend", updateZoom);
    };
  }, [map, onZoomChange]);

  return null;
}

// Uses a simple world map when far out and aerial imagery when close in.
function ResponsiveBasemap() {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());

  useEffect(() => {
    const updateZoom = () => setZoom(map.getZoom());
    map.on("zoomend", updateZoom);
    return () => {
      map.off("zoomend", updateZoom);
    };
  }, [map]);

  const basemap = zoom < 15 ? basemaps.worldLight : basemaps.usAerial;

  return (
    <TileLayer
      key={basemap.key}
      url={basemap.url}
      attribution={basemap.attribution}
      maxNativeZoom={19}
      maxZoom={24}
      keepBuffer={8}
    />
  );
}

// Saves the user's last map position in this browser so refreshes do not jump
// back to the default starting location.
function PersistMapView() {
  const map = useMap();

  useEffect(() => {
    const persist = () => {
      const center = map.getCenter();
      window.localStorage.setItem(
        VIEW_STORAGE_KEY,
        JSON.stringify({
          center: [center.lat, center.lng],
          zoom: map.getZoom()
        })
      );
    };

    map.on("moveend", persist);
    map.on("zoomend", persist);
    return () => {
      map.off("moveend", persist);
      map.off("zoomend", persist);
    };
  }, [map]);

  return null;
}

function hasStoredMapView() {
  if (typeof window === "undefined") {
    return false;
  }

  return Boolean(window.localStorage.getItem(VIEW_STORAGE_KEY));
}

function readStoredMapView(): { center: LatLngTuple; zoom: number } {
  if (typeof window === "undefined") {
    return { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM };
  }

  const raw = window.localStorage.getItem(VIEW_STORAGE_KEY);
  if (!raw) {
    return { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM };
  }

  try {
    const parsed = JSON.parse(raw) as { center?: [number, number]; zoom?: number };
    if (
      Array.isArray(parsed.center) &&
      parsed.center.length === 2 &&
      typeof parsed.center[0] === "number" &&
      typeof parsed.center[1] === "number" &&
      typeof parsed.zoom === "number"
    ) {
      return {
        center: [parsed.center[0], parsed.center[1]],
        zoom: parsed.zoom
      };
    }
  } catch {
    return { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM };
  }

  return { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM };
}

function BedRecordsCard({
  bed,
  plantings,
  placements,
  gaps,
  tasks,
  distanceUnit,
  canCreatePlanting,
  onSelectTask,
  onOpenPlanting
}: {
  bed: Bed;
  plantings: Planting[];
  placements: Placement[];
  gaps: DashboardData["placementGaps"];
  tasks: Task[];
  distanceUnit: DistanceUnit;
  canCreatePlanting: boolean;
  onSelectTask: (task: Task) => void;
  onOpenPlanting: (planting: Planting) => void;
}) {
  const activeTasks = tasks.filter((task) => task.status !== "done");
  const doneTasks = tasks.filter((task) => task.status === "done");

  return (
    <div className="card">
      <h2>Bed records</h2>
      <p className="muted">{bed.blockName} / {bed.name}</p>
      {plantings.length === 0 && placements.length === 0 && gaps.length === 0 && tasks.length === 0 ? (
        <p className="muted">
          {canCreatePlanting ? "No planting is assigned to this bed yet. Use the placement plan below to start one here." : "No planting records are assigned to this bed yet."}
        </p>
      ) : (
        <div className="stack compact-stack">
          {activeTasks.length > 0 && (
            <div>
              <strong>Work to record</strong>
              <div className="generated-bed-list">
                {activeTasks.map((task) => (
                  <button key={task.id} type="button" className="small-chip chip-button" onClick={() => onSelectTask(task)}>
                    {formatTaskTypeLabel(task.taskType)}: {task.title} ({formatDate(task.scheduledDate)})
                  </button>
                ))}
              </div>
            </div>
          )}
          {plantings.length > 0 && (
            <div>
              <strong>Plantings</strong>
              <div className="generated-bed-list">
                {plantings.map((planting) => (
                  <button key={planting.id} type="button" className="small-chip chip-button" onClick={() => onOpenPlanting(planting)}>
                    {plantingCropVarietyLabel(planting)} ({planting.status.replaceAll("_", " ")})
                  </button>
                ))}
              </div>
            </div>
          )}
          {placements.length > 0 && (
            <div>
              <strong>Placement history</strong>
              <div className="generated-bed-list">
                {placements.slice(0, 8).map((placement) => (
                  <span key={placement.id} className="small-chip">
                    {formatDate(placement.placedOn)}: {placement.plantCount?.toLocaleString() ?? "unknown"} plants
                  </span>
                ))}
              </div>
            </div>
          )}
          {gaps.length > 0 && (
            <div>
              <strong>Gaps</strong>
              <div className="generated-bed-list">
                {gaps.slice(0, 8).map((gap) => (
                  <span key={gap.id} className="small-chip">
                    Gap: {formatLength(gap.bedLengthUsedM, distanceUnit)}
                  </span>
                ))}
              </div>
            </div>
          )}
          {activeTasks.length === 0 && doneTasks.length > 0 && (
            <div>
              <strong>Completed tasks</strong>
              <div className="generated-bed-list">
                {doneTasks.slice(0, 8).map((task) => (
                  <button key={task.id} type="button" className="small-chip chip-button" onClick={() => onSelectTask(task)}>
                    Done: {task.title}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskWeekCard({
  title,
  weekStart,
  contextLabel,
  tasks,
  undoTaskId,
  showPastUndoneOption,
  pastUndoneChecked,
  onPastUndoneChange,
  onSelectTask,
  onQuickComplete,
  onUndoTask
}: {
  title: string;
  weekStart: string;
  contextLabel: string;
  tasks: Task[];
  undoTaskId: number | null;
  showPastUndoneOption: boolean;
  pastUndoneChecked: boolean;
  onPastUndoneChange: (checked: boolean) => void;
  onSelectTask: (task: Task) => void;
  onQuickComplete: (task: Task) => void;
  onUndoTask: (task: Task) => void;
}) {
  return (
    <div className="card">
      <div className="section-header">
        <div>
          <h2>{title}</h2>
          <p className="muted">{contextLabel} / {formatWeekRange(weekStart)}</p>
        </div>
      </div>
      {showPastUndoneOption && (
        <div className="task-list-options">
          <label className="layer-toggle">
            <input
              type="checkbox"
              checked={pastUndoneChecked}
              onChange={(event) => onPastUndoneChange(event.target.checked)}
            />
            <span>Past undone</span>
          </label>
        </div>
      )}
      {tasks.length === 0 ? (
        <p className="muted">No tasks scheduled for this selection.</p>
      ) : (
        <div className="task-week-list">
          {tasks.map((task) => (
            <article key={task.id} className="task-week-row">
              <button type="button" className="task-week-main" onClick={() => onSelectTask(task)}>
                <span className="task-cell">
                  <TaskIconMark taskType={task.taskType} color={taskColor(task)} secondaryColor={task.iconSecondaryColor} tractorModel={task.tractorModel} mini />
                  <strong>{task.title}</strong>
                </span>
                <span className="muted">{formatDate(task.scheduledDate)} / {task.bedName ?? task.plantingTitle ?? "No location"}</span>
              </button>
              <div className="button-row">
                {task.status !== "done" && (
                  <button type="button" className="primary-button compact-button" onClick={() => onQuickComplete(task)}>
                    {taskNeedsRecordForm(task.taskType) ? "Record" : "Mark done"}
                  </button>
                )}
                {task.status === "done" && task.id === undoTaskId && (
                  <button type="button" className="danger-button compact-button" onClick={() => onUndoTask(task)}>
                    Undo
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

type BlockPlacementPlanEditRow = {
  key: string;
  kind: "planting" | "gap";
  plantingId: number | null;
  label: string;
  bedLength: string;
  trayCount: string;
  plantCount: string;
  placementOrder: number;
  touchesSelectedBed: boolean;
};

function BlockPlacementPlanCard({
  block,
  selectedBed,
  data,
  taskFlowTemplates,
  beds,
  plantings,
  placements,
  gaps,
  overflows,
  distanceUnit,
  startOpenNewPlanting = false,
  onPreviewChange,
  onSave
}: {
  block: Block;
  selectedBed?: Bed | null;
  data: DashboardData;
  taskFlowTemplates: TaskFlowTemplate[];
  beds: Bed[];
  plantings: Planting[];
  placements: Placement[];
  gaps: DashboardData["placementGaps"];
  overflows: DashboardData["placementOverflows"];
  distanceUnit: DistanceUnit;
  startOpenNewPlanting?: boolean;
  onPreviewChange?: (preview: PlantingMapPreviewItem[]) => void;
  onSave: () => Promise<void>;
}) {
  const [rows, setRows] = useState<BlockPlacementPlanEditRow[]>([]);
  const [expandedEditor, setExpandedEditor] = useState<"new" | `planting:${number}` | null>(startOpenNewPlanting ? "new" : null);
  const [entranceSide, setEntranceSide] = useState<"start" | "end">(block.bedStartEntranceSide ?? "start");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const blockBeds = useMemo(
    () => beds.filter((bed) => bed.blockId === block.id && bed.source !== "road"),
    [beds, block.id]
  );
  const plantingById = useMemo(() => new Map(plantings.map((planting) => [planting.id, planting])), [plantings]);
  const placementRowsKey = useMemo(() => JSON.stringify({
    blockId: block.id,
    placements: placements.map((placement) => [placement.id, placement.plantingId, placement.bedId, placement.bedLengthUsedM, placement.plantCount, placement.placementOrder, placement.planSource]),
    gaps: gaps.map((gap) => [gap.id, gap.bedId, gap.bedLengthUsedM, gap.placementOrder]),
    overflows: overflows.map((overflow) => [overflow.id, overflow.plantingId, overflow.entryType, overflow.bedLengthUsedM, overflow.placementOrder]),
    plantings: plantings.map((planting) => [planting.id, planting.intendedBlockId, planting.bedLengthUsedM, planting.plantCount, planting.trayCount])
  }), [block.id, placements, gaps, overflows, plantings]);

  useEffect(() => {
    const grouped = new Map<string, BlockPlacementPlanEditRow & { lengthM: number }>();
    const rowForPlanting = (plantingId: number, order: number) => {
      const planting = plantingById.get(plantingId);
      const key = `planting:${plantingId}`;
      const current = grouped.get(key);
      if (current) {
        return current;
      }
      const next = {
        key,
        kind: "planting" as const,
        plantingId,
        label: planting ? plantingCropVarietyLabel(planting) : `Planting ${plantingId}`,
        bedLength: "",
        trayCount: planting?.trayCount == null ? "" : String(planting.trayCount),
        plantCount: planting?.plantCount == null ? "" : String(planting.plantCount),
        placementOrder: order,
        touchesSelectedBed: false,
        lengthM: 0
      };
      grouped.set(key, next);
      return next;
    };
    const rowForGap = (order: number) => {
      const key = `gap:${order}`;
      const current = grouped.get(key);
      if (current) {
        return current;
      }
      const next = {
        key,
        kind: "gap" as const,
        plantingId: null,
        label: "Gap",
        bedLength: "",
        trayCount: "",
        plantCount: "",
        placementOrder: order,
        touchesSelectedBed: false,
        lengthM: 0
      };
      grouped.set(key, next);
      return next;
    };

    for (const placement of placements) {
      if (placement.planSource !== "auto_block_plan") {
        continue;
      }
      const bed = beds.find((item) => item.id === placement.bedId);
      if (!bed || bed.blockId !== block.id) {
        continue;
      }
      const row = rowForPlanting(placement.plantingId, Number(placement.placementOrder ?? grouped.size + 1));
      row.lengthM += Number(placement.bedLengthUsedM || 0);
      row.touchesSelectedBed = row.touchesSelectedBed || selectedBed == null || placement.bedId === selectedBed.id;
    }

    for (const gap of gaps) {
      if (gap.blockId !== block.id) {
        continue;
      }
      const row = rowForGap(Number(gap.placementOrder));
      row.lengthM += Number(gap.bedLengthUsedM || 0);
      row.touchesSelectedBed = row.touchesSelectedBed || selectedBed == null || gap.bedId === selectedBed.id;
    }

    for (const overflow of overflows) {
      if (overflow.blockId !== block.id) {
        continue;
      }
      const row = overflow.entryType === "gap"
        ? rowForGap(Number(overflow.placementOrder))
        : overflow.plantingId == null
          ? null
          : rowForPlanting(overflow.plantingId, Number(overflow.placementOrder));
      if (!row) {
        continue;
      }
      row.lengthM += Number(overflow.bedLengthUsedM || 0);
    }

    const blockBedIds = new Set(blockBeds.map((bed) => bed.id));
    const selectedBedId = selectedBed?.id ?? null;
    for (const planting of plantings.filter((item) => (
      item.intendedBlockId === block.id
      || (item.intendedBedId != null && blockBedIds.has(item.intendedBedId) && (selectedBedId == null || item.intendedBedId === selectedBedId))
    ))) {
      const key = `planting:${planting.id}`;
      if (grouped.has(key)) {
        const row = grouped.get(key);
        if (row) {
          row.touchesSelectedBed = row.touchesSelectedBed || selectedBed == null || planting.intendedBedId === selectedBed.id || planting.intendedBlockId === block.id;
        }
        continue;
      }
      const row = rowForPlanting(planting.id, grouped.size + 1);
      row.lengthM = Number(planting.bedLengthUsedM || selectedBed?.bedLengthM || 0);
      row.touchesSelectedBed = selectedBed == null || planting.intendedBedId === selectedBed.id || planting.intendedBlockId === block.id;
    }

    const nextRows = [...grouped.values()]
      .sort((left, right) => left.placementOrder - right.placementOrder)
      .map((row, index) => ({
        ...row,
        placementOrder: index + 1,
        bedLength: formatLengthInputValue(row.lengthM, distanceUnit)
      }));
    setRows(nextRows);
    setEntranceSide(block.bedStartEntranceSide ?? "start");
  }, [placementRowsKey, block.id, block.bedStartEntranceSide, selectedBed?.id, selectedBed?.bedLengthM, beds, blockBeds, gaps, overflows, placements, plantings, plantingById, distanceUnit]);

  const visibleRows = selectedBed == null ? rows : rows.filter((row) => row.touchesSelectedBed);
  const overflowLengthM = overflows
    .filter((overflow) => overflow.blockId === block.id)
    .reduce((sum, overflow) => sum + Number(overflow.bedLengthUsedM || 0), 0);
  const expandedPlantingId = expandedEditor?.startsWith("planting:")
    ? Number(expandedEditor.replace("planting:", ""))
    : null;
  const expandedPlanting = expandedPlantingId == null ? null : plantingById.get(expandedPlantingId) ?? null;

  useEffect(() => {
    setExpandedEditor(startOpenNewPlanting ? "new" : null);
  }, [block.id, selectedBed?.id, startOpenNewPlanting]);

  function updateRow(key: string, patch: Partial<BlockPlacementPlanEditRow>) {
    setRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row));
  }

  function linkedPlanningPatch(row: BlockPlacementPlanEditRow, field: "bedLength" | "trayCount" | "plantCount", value: string) {
    const planting = row.plantingId == null ? null : plantingById.get(row.plantingId) ?? null;
    const cellsPerTray = planting?.cellsPerTray && planting.cellsPerTray > 0 ? planting.cellsPerTray : 128;
    const spacingPair = parseSpacingPairForUnit(planting?.spacing ?? null, "m");
    const inRowSpacingM = spacingInputToMeters(spacingPair.inRow || "0.3", "m");
    const rowsPerBed = planting?.rowsPerBed && planting.rowsPerBed > 0 ? planting.rowsPerBed : 1;
    const patch: Partial<BlockPlacementPlanEditRow> = { [field]: value };

    if (row.kind === "gap" || inRowSpacingM == null || inRowSpacingM <= 0 || rowsPerBed <= 0) {
      return patch;
    }
    if (field === "trayCount") {
      const trays = Number(value);
      if (Number.isFinite(trays) && trays > 0) {
        const plants = Math.round(trays * cellsPerTray);
        patch.plantCount = String(plants);
        patch.bedLength = formatLengthInputValue((plants * inRowSpacingM) / rowsPerBed, distanceUnit);
      }
    }
    if (field === "plantCount") {
      const plants = Number(value);
      if (Number.isFinite(plants) && plants > 0) {
        patch.bedLength = formatLengthInputValue((plants * inRowSpacingM) / rowsPerBed, distanceUnit);
      }
    }
    if (field === "bedLength") {
      const lengthM = parseLengthInputValue(value || null, distanceUnit);
      if (lengthM != null && lengthM > 0) {
        patch.plantCount = String(Math.max(1, Math.floor((lengthM * rowsPerBed) / inRowSpacingM)));
      }
    }
    return patch;
  }

  function moveRow(key: string, direction: -1 | 1) {
    setRows((current) => {
      const index = current.findIndex((row) => row.key === key);
      const swapIndex = index + direction;
      if (index < 0 || swapIndex < 0 || swapIndex >= current.length) {
        return current;
      }
      const next = [...current];
      [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
      return next.map((row, rowIndex) => ({ ...row, placementOrder: rowIndex + 1 }));
    });
  }

  function addGapAfter(key: string | null) {
    setRows((current) => {
      const insertIndex = key == null ? current.length : current.findIndex((row) => row.key === key) + 1;
      const safeInsertIndex = insertIndex <= 0 ? current.length : insertIndex;
      const next = [...current];
      next.splice(safeInsertIndex, 0, {
        key: `gap:new:${Date.now()}`,
        kind: "gap",
        plantingId: null,
        label: "Gap",
        bedLength: formatLengthInputValue(3.05, distanceUnit),
        trayCount: "",
        plantCount: "",
        placementOrder: safeInsertIndex + 1,
        touchesSelectedBed: true
      });
      return next.map((row, rowIndex) => ({ ...row, placementOrder: rowIndex + 1 }));
    });
  }

  async function savePlan() {
    const payloadRows = rows.map((row) => ({
      kind: row.kind,
      plantingId: row.plantingId,
      bedLengthUsedM: parseLengthInputValue(row.bedLength || null, distanceUnit),
      trayCount: row.kind === "planting" && row.trayCount.trim() ? Number(row.trayCount) : null,
      plantCount: row.kind === "planting" && row.plantCount.trim() ? Number(row.plantCount) : null
    }));
    if (payloadRows.some((row) => row.bedLengthUsedM == null || row.bedLengthUsedM <= 0)) {
      setStatus("Every row needs a bed length above zero.");
      return;
    }
    if (payloadRows.some((row) => row.kind === "planting" && row.plantingId == null)) {
      setStatus("Planting rows need a planting.");
      return;
    }
    try {
      setSaving(true);
      setStatus("Saving placement plan...");
      await api.updateBlockPlacementPlan(block.id, {
        entranceSide,
        rows: payloadRows
      });
      await onSave();
      setStatus("Placement plan saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save placement plan.");
    } finally {
      setSaving(false);
    }
  }

  if (blockBeds.length === 0) {
    return (
      <div className="card">
        <h2>{block.name}</h2>
        <p className="muted">This block has no plantable beds yet.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="section-header">
        <div>
          <h2>{block.name}</h2>
          <p className="muted">{selectedBed ? `${selectedBed.name}: rows touching this bed.` : `${block.name}: all planned rows.`}</p>
        </div>
        <button type="button" className="secondary-button compact-button" onClick={() => addGapAfter(visibleRows.at(-1)?.key ?? null)}>
          Add gap row
        </button>
      </div>
      <table className="data-table compact-table">
        <thead>
          <tr>
            <th>Variety</th>
            <th>Bed length</th>
            <th>Tray count</th>
            <th>Plant count</th>
            <th>Order</th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row) => (
            <Fragment key={row.key}>
              <tr>
                <td>
                  <div className="placement-row-label">
                    <span>{row.label}</span>
                    {row.kind === "planting" && row.plantingId != null && (
                      <button
                        type="button"
                        className="icon-button tiny-icon-button"
                        aria-label={`Edit ${row.label}`}
                        title={`Edit ${row.label}`}
                        onClick={() => {
                          if (row.plantingId == null) {
                            return;
                          }
                          const nextEditor = `planting:${row.plantingId}` as `planting:${number}`;
                          setExpandedEditor(expandedEditor === nextEditor ? null : nextEditor);
                        }}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                          <path d="M5 17.5 16.5 6 18 7.5 6.5 19H5v-1.5Z" />
                          <path d="M15.5 5 17 3.5 20.5 7 19 8.5" />
                        </svg>
                      </button>
                    )}
                  </div>
                </td>
                <td><input value={row.bedLength} onChange={(event) => updateRow(row.key, linkedPlanningPatch(row, "bedLength", event.target.value))} type="number" min="0" step="0.1" /></td>
                <td><input value={row.trayCount} onChange={(event) => updateRow(row.key, linkedPlanningPatch(row, "trayCount", event.target.value))} type="number" min="1" disabled={row.kind === "gap"} /></td>
                <td><input value={row.plantCount} onChange={(event) => updateRow(row.key, linkedPlanningPatch(row, "plantCount", event.target.value))} type="number" min="1" disabled={row.kind === "gap"} /></td>
                <td>
                  <div className="move-row-control" aria-label={`Move ${row.label}`}>
                    <button type="button" className="move-row-button" onClick={() => moveRow(row.key, -1)} aria-label={`Move ${row.label} up`} title="Move up">
                      <svg viewBox="0 0 24 12" aria-hidden="true" focusable="false">
                        <path d="M3 9 L12 3 L21 9" />
                      </svg>
                    </button>
                    <span>move</span>
                    <button type="button" className="move-row-button" onClick={() => moveRow(row.key, 1)} aria-label={`Move ${row.label} down`} title="Move down">
                      <svg viewBox="0 0 24 12" aria-hidden="true" focusable="false">
                        <path d="M3 3 L12 9 L21 3" />
                      </svg>
                    </button>
                  </div>
                </td>
              </tr>
              {expandedEditor === `planting:${row.plantingId}` && expandedPlanting && (
                <tr className="placement-editor-row">
                  <td colSpan={5}>
                    <PlantingForm
                      key={`placement-plan-edit-${expandedPlanting.id}`}
                      data={data}
                      taskFlowTemplates={taskFlowTemplates}
                      distanceUnit={distanceUnit}
                      editingPlanting={expandedPlanting}
                      embedded
                      heading={`Edit ${row.label}`}
                      onCancel={() => setExpandedEditor(null)}
                      onSave={async () => {
                        await onSave();
                        setExpandedEditor(null);
                      }}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {visibleRows.length === 0 && (
            <tr>
              <td colSpan={5}>No planned placement row touches this bed yet.</td>
            </tr>
          )}
          <tr className="placement-new-row">
            <td colSpan={5}>
              <button type="button" className="secondary-button full-span" onClick={() => setExpandedEditor(expandedEditor === "new" ? null : "new")}>
                New planting
              </button>
            </td>
          </tr>
          {expandedEditor === "new" && (
            <tr className="placement-editor-row">
              <td colSpan={5}>
                <PlantingForm
                  key={`placement-plan-new-${block.id}-${selectedBed?.id ?? "block"}`}
                  data={data}
                  taskFlowTemplates={taskFlowTemplates}
                  distanceUnit={distanceUnit}
                  initialIntendedBedId={selectedBed?.id ?? null}
                  initialIntendedBlockId={block.id}
                  embedded
                  heading="New planting"
                  onPreviewChange={onPreviewChange}
                  onCancel={() => {
                    onPreviewChange?.([]);
                    setExpandedEditor(null);
                  }}
                  onSave={async () => {
                    await onSave();
                    onPreviewChange?.([]);
                    setExpandedEditor(null);
                  }}
                />
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {overflowLengthM > 0 && <p className="muted">Overflow for this block: {formatLength(overflowLengthM, distanceUnit)} beyond mapped beds.</p>}
      {status && <p className="muted"><strong>{status}</strong></p>}
      <button type="button" className="primary-button" disabled={saving || rows.length === 0} onClick={() => void savePlan()}>
        {saving ? "Saving..." : "Save placement plan"}
      </button>
    </div>
  );
}

// Map-driven allocation tool shown after selecting a bed. It suggests likely
// plantings and previews how the chosen plant count wraps through beds.
function BedAllocationCard({
  bed,
  plantings,
  placements,
  beds,
  blocks,
  distanceUnit,
  onOpenPlan,
  onOpenPlanting,
  onPreviewChange,
  onSave
}: {
  bed: Bed;
  plantings: Planting[];
  placements: Placement[];
  beds: Bed[];
  blocks: Block[];
  distanceUnit: DistanceUnit;
  onOpenPlan: () => void;
  onOpenPlanting: (plantingId: number) => void;
  onPreviewChange: (preview: BedAllocationPreview[]) => void;
  onSave: () => Promise<void>;
}) {
  const bedById = useMemo(() => new Map(beds.map((item) => [item.id, item])), [beds]);
  const blockById = useMemo(() => new Map(blocks.map((block) => [block.id, block])), [blocks]);
  const plantingById = useMemo(() => new Map(plantings.map((planting) => [planting.id, planting])), [plantings]);
  const selectedBlock = blockById.get(bed.blockId) ?? null;
  const activePlacements = useMemo(
    () => placements.filter((placement) => plantingById.get(placement.plantingId)?.status !== "finished"),
    [placements, plantingById]
  );
  const placedPlantingIds = useMemo(
    () => new Set(placements.filter((placement) => placement.bedId === bed.id).map((placement) => placement.plantingId)),
    [placements, bed.id]
  );
  const currentYear = Number(todayDateInputValue().slice(0, 4));
  const selectedWeekStart = startOfWeekDate(todayDateInputValue());
  const selectedWeekEnd = addDaysToDate(selectedWeekStart, 6);
  const availablePlantings = useMemo(() => {
    const scorePlanting = (planting: Planting) => {
      const intendedBed = planting.intendedBedId != null ? bedById.get(planting.intendedBedId) ?? null : null;
      const intendedBlock = intendedBed ? blockById.get(intendedBed.blockId) ?? null : null;
      const targetDate = planting.plannedTransplantDate ?? planting.plannedSowDate ?? planting.actualTraySeedingDate ?? "";
      const rightDate = targetDate >= selectedWeekStart && targetDate <= selectedWeekEnd;
      const daysFromToday = targetDate
        ? Math.abs(new Date(`${targetDate}T12:00:00`).getTime() - new Date(`${todayDateInputValue()}T12:00:00`).getTime()) / 86400000
        : 999;
      let locationScore = 70;
      if (intendedBed?.id === bed.id) {
        locationScore = 0;
      } else if (intendedBed?.blockId === bed.blockId) {
        locationScore = 5;
      } else if (intendedBlock && selectedBlock && intendedBlock.fieldId === selectedBlock.fieldId) {
        locationScore = 12;
      }
      return locationScore + (rightDate ? 0 : 25) + Math.min(daysFromToday, 90);
    };

    return plantings
      .filter((planting) => (
        planting.status !== "finished"
        && plantingPlanYear(planting) >= currentYear
        && !placedPlantingIds.has(planting.id)
      ))
      .sort((left, right) => scorePlanting(left) - scorePlanting(right));
  }, [plantings, currentYear, placedPlantingIds, bedById, blockById, bed.id, bed.blockId, selectedBlock, selectedWeekStart, selectedWeekEnd]);
  const [plantingId, setPlantingId] = useState(String(availablePlantings[0]?.id ?? ""));
  const [action, setAction] = useState<"transplant" | "direct_seed" | "reserve">("transplant");
  const [actualDate, setActualDate] = useState(todayDateInputValue());
  const [plantCount, setPlantCount] = useState("");
  const [usesAllRemainingPlants, setUsesAllRemainingPlants] = useState(false);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const selectedPlanting = plantings.find((planting) => planting.id === Number(plantingId)) ?? null;
  const selectedSpacing = parseSpacingPairForUnit(selectedPlanting?.spacing ?? null, "m");
  const inRowSpacingM = spacingInputToMeters(selectedSpacing.inRow || "30", "m") ?? 0.3;
  const estimatedPlannedPlantCount = estimatePlantCountFromPlan(selectedPlanting, inRowSpacingM);
  const placedCountForPlanting = selectedPlanting
    ? placements
        .filter((placement) => placement.plantingId === selectedPlanting.id)
        .reduce((sum, placement) => sum + (placement.plantCount ?? 0), 0)
    : 0;
  const availablePlantCount = Math.max(0, estimatedPlannedPlantCount - placedCountForPlanting);
  // Transplant counts are estimates. Farms often see better germination than planned,
  // so allow up to 20% over the original estimate while making that slack visible.
  const overPlanAllowance = Math.max(0, Math.ceil(estimatedPlannedPlantCount * 0.2));
  const allocationMaxPlantCount = Math.max(0, estimatedPlannedPlantCount + overPlanAllowance - placedCountForPlanting);
  const sliderMax = Math.max(allocationMaxPlantCount, Number(plantCount) || 0, 1);
  const bedsInWrapOrder = useMemo(() => {
    if (bed.source === "road") {
      return [] as Bed[];
    }
    const blockBeds = beds
      .filter((item) => item.blockId === bed.blockId && item.source !== "road")
      .sort((left, right) => (left.sequenceNo ?? left.id) - (right.sequenceNo ?? right.id));
    const selectedIndex = blockBeds.findIndex((item) => item.id === bed.id);
    return selectedIndex >= 0 ? blockBeds.slice(selectedIndex) : [bed];
  }, [beds, bed.blockId, bed.id]);
  const activeUsedLengthByBed = useMemo(() => {
    const used = new Map<number, number>();
    for (const placement of activePlacements) {
      used.set(placement.bedId, (used.get(placement.bedId) ?? 0) + (placement.bedLengthUsedM ?? 0));
    }
    return used;
  }, [activePlacements]);
  const allocationPreview = useMemo(() => {
    const requestedCount = Number(plantCount);
    if (!Number.isFinite(requestedCount) || requestedCount <= 0) {
      return [];
    }

    return buildBedAllocationPreview({
      plantCount: requestedCount,
      bedsInWrapOrder,
      usedLengthByBed: activeUsedLengthByBed,
      inRowSpacingM
    });
  }, [plantCount, bedsInWrapOrder, activeUsedLengthByBed, inRowSpacingM]);
  const previewPlantTotal = allocationPreview.reduce((sum, item) => sum + item.plantCount, 0);
  const unplacedPreviewCount = Math.max(0, (Number(plantCount) || 0) - previewPlantTotal);

  useEffect(() => {
    onPreviewChange(allocationPreview.map((preview) => ({
      bedId: preview.bed.id,
      startLengthM: preview.startLengthM,
      bedLengthUsedM: preview.bedLengthUsedM,
      plantCount: preview.plantCount,
      label: `${preview.plantCount.toLocaleString()} plants`
    })));

    return () => onPreviewChange([]);
  }, [allocationPreview, onPreviewChange]);

  useEffect(() => {
    if (availablePlantings[0] && (!plantingId || !availablePlantings.some((planting) => String(planting.id) === plantingId))) {
      setPlantingId(String(availablePlantings[0].id));
    }
  }, [availablePlantings, plantingId]);

  useEffect(() => {
    const nextPlanting = plantings.find((planting) => planting.id === Number(plantingId));
    const nextSpacing = parseSpacingPairForUnit(nextPlanting?.spacing ?? null, "m");
    const nextInRowSpacingM = spacingInputToMeters(nextSpacing.inRow || "30", "m") ?? 0.3;
    const nextPlannedCount = estimatePlantCountFromPlan(nextPlanting ?? null, nextInRowSpacingM);
    const nextPlacedCount = nextPlanting
      ? placements
          .filter((placement) => placement.plantingId === nextPlanting.id)
          .reduce((sum, placement) => sum + (placement.plantCount ?? 0), 0)
      : 0;
    const nextRemainingCount = Math.max(0, nextPlannedCount - nextPlacedCount);
    setPlantCount(String(Math.max(1, Math.round(nextRemainingCount * 0.9))));
    setUsesAllRemainingPlants(false);
  }, [plantingId, plantings, placements]);

  async function allocate() {
    if (!selectedPlanting) {
      setStatus("Choose a planting first, or create one in the crop plan.");
      return;
    }

    if (allocationPreview.length === 0) {
      setStatus("No available bed length from this bed onward. Choose another bed or lower the plant count.");
      return;
    }
    if ((action === "direct_seed" || action === "transplant") && actualDate > todayDateInputValue()) {
      setStatus("Planted dates cannot be in the future.");
      return;
    }

    try {
      setSaving(true);
      setStatus("Saving bed allocation...");
      const baseNote = notes || `${action === "direct_seed" ? "Direct seeded" : action === "transplant" ? "Transplanted" : "Reserved"} from map bed selection`;
      const allocationStatusNote = usesAllRemainingPlants
        ? "Marked as all remaining plants from this planting."
        : "Marked as partial allocation; more plants may remain.";
      for (const preview of allocationPreview) {
        await api.addPlacement(selectedPlanting.id, {
          bedId: preview.bed.id,
          plantCount: preview.plantCount,
          bedLengthUsedM: preview.bedLengthUsedM,
          actualDate,
          locationDetail: action === "reserve" ? "Planned bed allocation" : "Length-based bed allocation",
          notes: `${baseNote}\n${allocationStatusNote}`
        });
      }
      if (action === "direct_seed") {
        await api.recordActual(selectedPlanting.id, { eventType: "direct_seeding", actualDate, notes: `${notes || "Recorded from map bed allocation"}\n${allocationStatusNote}` });
      }
      if (action === "transplant") {
        await api.recordActual(selectedPlanting.id, { eventType: "transplant", actualDate, notes: `${notes || "Recorded from map bed allocation"}\n${allocationStatusNote}` });
      }
      await onSave();
      setStatus("Bed allocation saved.");
      onOpenPlanting(selectedPlanting.id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not allocate bed.");
    } finally {
      setSaving(false);
    }
  }

  if (bed.source === "road") {
    return (
      <div className="card">
        <h2>Selected road/path</h2>
        <p className="muted">{bed.name} is a non-plantable road/path. Use it for access spacing, not crop allocation.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Allocate selected bed</h2>
      <p className="muted">{bed.name}: assign a planned planting, transplant, or direct-seeded crop to this bed.</p>
      {availablePlantings.length === 0 ? (
        <>
          <p className="muted">No available planting plans are ready to allocate.</p>
          <button type="button" className="primary-button" onClick={onOpenPlan}>Go to planting seeds planner</button>
        </>
      ) : (
        <div className="form-grid">
          <label className="full-span">
            <span>Planting</span>
            <select value={plantingId} onChange={(event) => setPlantingId(event.target.value)}>
              {availablePlantings.map((planting) => (
                <option key={planting.id} value={planting.id}>
                  {planting.title} / {planting.seedName ?? plantingCropVarietyLabel(planting)}
                </option>
              ))}
            </select>
            <span className="muted">Sorted by likely fit: same bed/block/field and current week first, then nearby date/location.</span>
          </label>
          <label>
            <span>Action</span>
            <select value={action} onChange={(event) => setAction(event.target.value as "transplant" | "direct_seed" | "reserve")}>
              <option value="transplant">Transplant into bed</option>
              <option value="direct_seed">Direct seed into bed</option>
              <option value="reserve">Reserve bed for plan</option>
            </select>
          </label>
          <label><span>Date</span><input type="date" value={actualDate} onChange={(event) => setActualDate(event.target.value)} /></label>
          <label className="full-span">
            <span>Plant count to place: {Number(plantCount || 0).toLocaleString()}</span>
            <input
              type="range"
              min="1"
              max={sliderMax}
              value={Math.min(Number(plantCount || 1), sliderMax)}
              onChange={(event) => setPlantCount(event.target.value)}
            />
          </label>
          <label>
            <span>Exact count</span>
            <input type="number" min="1" max={sliderMax} value={plantCount} onChange={(event) => setPlantCount(event.target.value)} />
          </label>
          <label className="inline-checkbox full-span">
            <input
              type="checkbox"
              checked={usesAllRemainingPlants}
              onChange={(event) => {
                setUsesAllRemainingPlants(event.target.checked);
                if (event.target.checked && availablePlantCount > 0) {
                  setPlantCount(String(availablePlantCount));
                }
              }}
            />
            <span>This uses all remaining plants from this planting</span>
          </label>
          <div className="instruction-box">
            <strong>Expected remaining:</strong> {availablePlantCount.toLocaleString()} plants.
            <br />
            <strong>Already placed in app:</strong> {placedCountForPlanting.toLocaleString()} plants.
            <br />
            <strong>Allowed field-count slack:</strong> up to {allocationMaxPlantCount.toLocaleString()} plants now ({overPlanAllowance.toLocaleString()} over-plan allowance before placed plants).
            <br />
            <strong>Spacing used:</strong> {formatSpacing(selectedPlanting?.spacing ?? null, distanceUnit)}.
          </div>
          <div className="instruction-box full-span">
            <strong>Preview:</strong> {previewPlantTotal.toLocaleString()} plants across {allocationPreview.length} bed{allocationPreview.length === 1 ? "" : "s"}.
            {unplacedPreviewCount > 0 && <span> {unplacedPreviewCount.toLocaleString()} plants do not fit from this bed onward.</span>}
            <div className="generated-bed-list">
              {allocationPreview.map((preview) => (
                <span key={preview.bed.id} className="small-chip">
                  {preview.bed.name}: {preview.plantCount.toLocaleString()} plants / {formatLength(preview.bedLengthUsedM, distanceUnit)}
                </span>
              ))}
            </div>
          </div>
          <label className="full-span"><span>Notes</span><textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
          {status && <p className="muted full-span"><strong>{status}</strong></p>}
          <button type="button" className="primary-button full-span" disabled={saving} onClick={() => void allocate()}>
            {saving ? "Saving..." : "Save bed allocation"}
          </button>
        </div>
      )}
    </div>
  );
}

// Record-work form opened from the task list. It marks a task done and can also
// adjust the related planting/placement when the real work differs from the plan.
function TaskRecordCard({
  task,
  plantings,
  seedItems,
  placements,
  fields,
  blocks,
  beds,
  bedPresets,
  distanceUnit,
  canAdjustPlanting,
  highlightSubmit = false,
  onSave
}: {
  task: Task | null;
  plantings: Planting[];
  seedItems: SeedItem[];
  placements: Placement[];
  fields: Field[];
  blocks: Block[];
  beds: Bed[];
  bedPresets: DashboardData["bedPresets"];
  distanceUnit: DistanceUnit;
  canAdjustPlanting: boolean;
  highlightSubmit?: boolean;
  onSave: () => Promise<void>;
}) {
  const planting = plantings.find((item) => item.id === task?.plantingId) ?? null;
  const bedById = useMemo(() => new Map(beds.map((bed) => [bed.id, bed])), [beds]);
  const blockById = useMemo(() => new Map(blocks.map((block) => [block.id, block])), [blocks]);
  const [actualDate, setActualDate] = useState(todayDateInputValue());
  const [notes, setNotes] = useState("");
  const [lotNumber, setLotNumber] = useState("");
  const [fieldId, setFieldId] = useState("");
  const [blockId, setBlockId] = useState("");
  const [bedId, setBedId] = useState("");
  const [plantCount, setPlantCount] = useState("");
  const [bedMakingRows, setBedMakingRows] = useState<BedMakingRecordRow[]>([]);
  const [bedMakingBlockFull, setBedMakingBlockFull] = useState(false);
  const [spacingInRow, setSpacingInRow] = useState("");
  const [spacingBetweenRows, setSpacingBetweenRows] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isFieldPlantingTask = task?.taskType === "transplant" || task?.taskType === "direct_seed";
  const isBedPrepTask = task?.taskType === "bed_prep" || task?.taskType === "bed_making";
  const requiresLotNumber = Boolean(planting && ["seed_in_tray", "direct_seed", "transplant"].includes(task?.taskType ?? ""));
  const existingSeedLotNumber = planting?.seedItemId == null
    ? ""
    : seedItems.find((seedItem) => seedItem.id === planting.seedItemId)?.lotNumber ?? "";
  const availableBefore = planting?.plantCount != null
    ? Math.max(0, planting.plantCount - plantingPlacementCount(placements, planting.id))
    : null;
  const selectedBed = bedId ? bedById.get(Number(bedId)) ?? null : null;
  const selectedBlock = blockId ? blockById.get(Number(blockId)) ?? null : null;
  const taskBed = task?.bedId != null
    ? bedById.get(task.bedId) ?? null
    : planting?.intendedBedId != null
      ? bedById.get(planting.intendedBedId) ?? null
      : null;
  const taskBlock = taskBed
    ? blockById.get(taskBed.blockId) ?? null
    : planting?.intendedBlockId != null
      ? blockById.get(planting.intendedBlockId) ?? null
      : null;
  const isBedMakingTask = isBedPrepTask && taskBlock != null;
  const usableBedPresets = bedPresets.filter((preset) => !preset.isRoad);
  const defaultBedMakingPresetId = taskBed?.bedPresetId != null && usableBedPresets.some((preset) => preset.id === taskBed.bedPresetId)
    ? String(taskBed.bedPresetId)
    : String(usableBedPresets[0]?.id ?? "");
  const blocksForField = fieldId ? blocks.filter((block) => String(block.fieldId) === fieldId) : blocks;
  const plantableBeds = beds.filter((bed) => bed.source !== "road");
  const bedsForBlock = blockId ? plantableBeds.filter((bed) => String(bed.blockId) === blockId) : plantableBeds;
  const taskBlockPlantableBeds = taskBlock
    ? plantableBeds
        .filter((bed) => bed.blockId === taskBlock.id)
        .sort((left, right) => (left.sequenceNo ?? left.id) - (right.sequenceNo ?? right.id))
    : [];
  const canAdjustBedMaking = canAdjustPlanting && isBedMakingTask && taskBlockPlantableBeds.length > 0 && usableBedPresets.length > 0;
  const bedMakingRecordHelp = isBedPrepTask && !canAdjustBedMaking
    ? !canAdjustPlanting
      ? "Worker accounts record completion here. Bed count changes are limited to planner accounts."
      : !taskBlock
          ? "This bed-making task is not tied to a mapped block anymore. Open the current block bed-making task to change bed counts."
          : taskBlockPlantableBeds.length === 0
            ? "Make planned beds first, then record how many were actually made."
            : usableBedPresets.length === 0
              ? "Save a bed preset first, then record which kind of beds were made."
              : null
    : null;
  const spacingInRowM = spacingInputToMeters(spacingInRow, distanceUnit);
  const spacingBetweenRowsM = spacingInputToMeters(spacingBetweenRows, distanceUnit);
  const recordedPlantCount = Number(plantCount);
  const calculatedBedLengthM = Number.isFinite(recordedPlantCount) && recordedPlantCount > 0 && spacingInRowM != null
    ? recordedPlantCount * spacingInRowM
    : null;
  const remainingAfter = availableBefore == null || !Number.isFinite(recordedPlantCount)
    ? null
    : Math.max(0, availableBefore - Math.max(0, recordedPlantCount));
  const parsedBedMakingRows = bedMakingRows
    .map((row) => ({ presetId: Number(row.presetId), count: Number(row.count) }))
    .filter((row) => Number.isInteger(row.presetId) && row.presetId > 0 && Number.isInteger(row.count) && row.count > 0);
  const recordedBedMakingCount = parsedBedMakingRows.reduce((sum, row) => sum + row.count, 0);
  const bedMakingOverTarget = recordedBedMakingCount > taskBlockPlantableBeds.length;
  const tutorialExpectedRecordDate = highlightSubmit && task?.scheduledDate ? task.scheduledDate : null;
  const tutorialNeedsDate = Boolean(tutorialExpectedRecordDate && actualDate !== tutorialExpectedRecordDate);
  const tutorialNeedsBedPlacement = highlightSubmit && !tutorialNeedsDate && canAdjustPlanting && isFieldPlantingTask && !bedId;
  const tutorialNeedsPlantCountPlaced = highlightSubmit
    && !tutorialNeedsDate
    && !tutorialNeedsBedPlacement
    && canAdjustPlanting
    && isFieldPlantingTask
    && (!Number.isFinite(recordedPlantCount) || recordedPlantCount <= 0);
  const tutorialReadyToRecord = highlightSubmit
    && !tutorialNeedsDate
    && !tutorialNeedsBedPlacement
    && !tutorialNeedsPlantCountPlaced;
  const tutorialRecordDateText = tutorialExpectedRecordDate
    ? formatDateForInputHint(tutorialExpectedRecordDate)
    : null;
  const tutorialRecordHint = tutorialNeedsDate
    ? `Fill out the Date as ${tutorialRecordDateText}. Use the scheduled date so the past work is recorded in the right week.`
    : tutorialNeedsBedPlacement
      ? `Date is set to ${tutorialRecordDateText}. Now choose the bed where this planting actually went.`
      : tutorialNeedsPlantCountPlaced
        ? `Date is set to ${tutorialRecordDateText}. Now enter how many plants were placed in the bed.`
        : highlightSubmit && tutorialRecordDateText
          ? `Date is set to ${tutorialRecordDateText}. Click Record task to mark this past work done.`
          : highlightSubmit
            ? "Click Record task to mark this past work done."
            : null;

  useEffect(() => {
    const defaultBedId = task?.bedId ?? planting?.intendedBedId ?? null;
    const defaultBed = defaultBedId != null ? bedById.get(defaultBedId) ?? null : null;
    const defaultBlock = defaultBed ? blockById.get(defaultBed.blockId) ?? null : null;
    const spacingPair = parseSpacingPairForUnit(planting?.spacing ?? null, distanceUnit);
    setActualDate(todayDateInputValue());
    setNotes("");
    setLotNumber(requiresLotNumber ? existingSeedLotNumber : "");
    setFieldId(defaultBlock ? String(defaultBlock.fieldId) : "");
    setBlockId(defaultBed ? String(defaultBed.blockId) : "");
    setBedId(defaultBed ? String(defaultBed.id) : "");
    setPlantCount(isFieldPlantingTask && availableBefore != null && availableBefore > 0 ? String(availableBefore) : "");
    setBedMakingRows(isBedMakingTask && defaultBedMakingPresetId
      ? [{ key: "bed-making-row-0", count: String(Math.max(1, taskBlockPlantableBeds.length)), presetId: defaultBedMakingPresetId }]
      : []);
    setBedMakingBlockFull(false);
    setSpacingInRow(spacingPair.inRow);
    setSpacingBetweenRows(spacingPair.betweenRows);
    setStatus(null);
  }, [task, planting, distanceUnit, bedById, blockById, isFieldPlantingTask, isBedMakingTask, requiresLotNumber, existingSeedLotNumber, availableBefore, highlightSubmit, taskBlockPlantableBeds.length, defaultBedMakingPresetId]);

  if (!task) {
    return <div className="card"><h2>Record from task</h2><p className="muted">Select a task first.</p></div>;
  }

  return (
    <div className="card">
      <h2>Record from task</h2>
      <p className="muted">{task.title}</p>
      <dl className="detail-list">
        <div><dt>Scheduled</dt><dd>{formatDate(task.scheduledDate)}</dd></div>
        <div><dt>Planting</dt><dd>{task.plantingTitle ?? "—"}</dd></div>
        <div><dt>Bed</dt><dd>{task.bedName ?? "—"}</dd></div>
        <div><dt>Status</dt><dd>{task.status}</dd></div>
      </dl>
      {status && <p className="muted"><strong>{status}</strong></p>}
      {tutorialRecordHint && (
        <div className="tutorial-helper-bubble">
          <strong>Tutorial next:</strong> {tutorialRecordHint}
        </div>
      )}
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            try {
              if (isPlantingActionTask(task.taskType) && actualDate > todayDateInputValue()) {
                setStatus("Planted dates cannot be in the future.");
                return;
              }
              if (requiresLotNumber && !lotNumber.trim()) {
                setStatus("Enter the seed lot number for this planting.");
                return;
              }
              if (canAdjustPlanting && isFieldPlantingTask && !bedId) {
                setStatus("Choose the bed where this planting actually went.");
                return;
              }
              if (canAdjustPlanting && isFieldPlantingTask && (!Number.isFinite(recordedPlantCount) || recordedPlantCount <= 0)) {
                setStatus("Enter the number of plants placed in the bed.");
                return;
              }
              if (canAdjustBedMaking && (parsedBedMakingRows.length === 0 || recordedBedMakingCount <= 0)) {
                setStatus("Enter each bed type made and choose a bed preset.");
                return;
              }
              setSaving(true);
              setStatus("Recording...");
              const spacing = formatSpacingPair(spacingInRow, spacingBetweenRows, distanceUnit);
              await api.recordTask(task.id, {
                actualDate,
                notes: notes || null,
                lotNumber: requiresLotNumber ? lotNumber.trim() : undefined,
                intendedBedId: canAdjustPlanting && isFieldPlantingTask && bedId ? Number(bedId) : undefined,
                spacing: canAdjustPlanting && isFieldPlantingTask && spacing ? spacing : undefined,
                placementBedId: canAdjustPlanting && isFieldPlantingTask && bedId ? Number(bedId) : undefined,
                placementPlantCount: canAdjustPlanting && isFieldPlantingTask ? recordedPlantCount : undefined,
                placementBedLengthUsedM: canAdjustPlanting && isFieldPlantingTask ? calculatedBedLengthM ?? undefined : undefined,
                placementLocationDetail: canAdjustPlanting && isFieldPlantingTask ? "Placed from task record" : null,
                placementNotes: notes || null,
                bedMakingBedCount: canAdjustBedMaking ? recordedBedMakingCount : undefined,
                bedMakingBlockFull: canAdjustBedMaking ? bedMakingBlockFull || bedMakingOverTarget : undefined,
                bedMakingRows: canAdjustBedMaking ? parsedBedMakingRows : undefined
              });
              await onSave();
              setStatus("Recorded.");
            } catch (error) {
              setStatus(error instanceof Error ? error.message : "Record failed.");
            } finally {
              setSaving(false);
            }
          })();
        }}
      >
        <label className={tutorialNeedsDate ? "tutorial-target" : ""} data-tutorial-label={tutorialNeedsDate ? "Set date" : undefined}>
          <span>Date</span>
          <input type="date" value={actualDate} onChange={(event) => setActualDate(event.target.value)} required />
        </label>
        {requiresLotNumber && (
          <label>
            <span>Lot number</span>
            <input
              value={lotNumber}
              onChange={(event) => setLotNumber(event.target.value.slice(0, 160))}
              maxLength={160}
              required
            />
          </label>
        )}

        {isBedMakingTask && canAdjustBedMaking && (
          <>
            <div className="full-span stack">
              {bedMakingRows.map((row, index) => (
                <div className="form-grid" key={row.key}>
                  <label>
                    <span>Beds made</span>
                    <input
                      value={row.count}
                      onChange={(event) => setBedMakingRows((current) => current.map((item) => item.key === row.key ? { ...item, count: event.target.value } : item))}
                      type="number"
                      min="1"
                      max="100"
                    />
                  </label>
                  <label>
                    <span>Bed preset</span>
                    <select
                      value={row.presetId}
                      onChange={(event) => setBedMakingRows((current) => current.map((item) => item.key === row.key ? { ...item, presetId: event.target.value } : item))}
                    >
                      {usableBedPresets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name} ({formatLength(preset.bedWidthM, distanceUnit)} bed / {formatLength(preset.pathSpacingM, distanceUnit)} path)
                        </option>
                      ))}
                    </select>
                  </label>
                  {bedMakingRows.length > 1 && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setBedMakingRows((current) => current.filter((item) => item.key !== row.key))}
                    >
                      Remove
                    </button>
                  )}
                  {index === bedMakingRows.length - 1 && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setBedMakingRows((current) => [
                        ...current,
                        { key: `bed-making-row-${Date.now()}`, count: "1", presetId: current[current.length - 1]?.presetId ?? defaultBedMakingPresetId }
                      ])}
                    >
                      Add bed type
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="bed-making-mode-toggle full-span" role="group" aria-label="Bed-making coverage">
              <button
                type="button"
                className={bedMakingBlockFull ? "secondary-button" : "primary-button"}
                aria-pressed={!bedMakingBlockFull}
                onClick={() => setBedMakingBlockFull(false)}
              >
                Partial
              </button>
              <button
                type="button"
                className={bedMakingBlockFull ? "primary-button" : "secondary-button"}
                aria-pressed={bedMakingBlockFull}
                onClick={() => setBedMakingBlockFull(true)}
              >
                Fill block
              </button>
            </div>
            <div className="instruction-box full-span">
              <strong>{taskBlock?.name ?? "Block"}:</strong> {taskBlockPlantableBeds.length} mapped beds now. Recording {recordedBedMakingCount || "—"} beds.
              {bedMakingBlockFull
                ? " The map will spread the actual count across the whole planned block."
                : bedMakingOverTarget
                  ? " The map will squeeze the extra beds across the whole planned block."
                : task?.title.toLowerCase().includes("more beds")
                  ? " The map will add these beds after the current beds."
                  : " The map will follow the plan spacing and leave the rest for later."}
            </div>
          </>
        )}
        {bedMakingRecordHelp && (
          <div className="instruction-box full-span">
            {bedMakingRecordHelp}
          </div>
        )}

        {planting && canAdjustPlanting && isFieldPlantingTask && (
          <>
            <label>
              <span>Field</span>
              <select
                value={fieldId}
                onChange={(event) => {
                  setFieldId(event.target.value);
                  setBlockId("");
                  setBedId("");
                }}
              >
                <option value="">Choose field</option>
                {fields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
              </select>
            </label>
            <label>
              <span>Block</span>
              <select
                value={blockId}
                onChange={(event) => {
                  setBlockId(event.target.value);
                  setBedId("");
                }}
              >
                <option value="">Choose block</option>
                {blocksForField.map((block) => <option key={block.id} value={block.id}>{block.name}</option>)}
              </select>
            </label>
            <label className={tutorialNeedsBedPlacement ? "tutorial-target" : ""} data-tutorial-label={tutorialNeedsBedPlacement ? "Choose bed" : undefined}>
              <span>Bed placement</span>
              <select
                value={bedId}
                onChange={(event) => {
                  const nextBedId = event.target.value;
                  const nextBed = nextBedId ? bedById.get(Number(nextBedId)) ?? null : null;
                  const nextBlock = nextBed ? blockById.get(nextBed.blockId) ?? null : null;
                  setBedId(nextBedId);
                  setBlockId(nextBed ? String(nextBed.blockId) : "");
                  setFieldId(nextBlock ? String(nextBlock.fieldId) : "");
                }}
              >
                <option value="">Choose bed</option>
                {bedsForBlock.map((bed) => <option key={bed.id} value={bed.id}>{bed.name}</option>)}
              </select>
            </label>
            <label className={tutorialNeedsPlantCountPlaced ? "tutorial-target" : ""} data-tutorial-label={tutorialNeedsPlantCountPlaced ? "Type count" : undefined}>
              <span>Plant count placed</span>
              <input value={plantCount} onChange={(event) => setPlantCount(event.target.value)} type="number" min="1" />
            </label>
            <div className="full-span spacing-pair">
              <label>
                <span>In-row spacing ({spacingUnitLabel(distanceUnit)})</span>
                <input value={spacingInRow} onChange={(event) => setSpacingInRow(event.target.value)} type="number" min="0" step={distanceUnit === "ft" ? "0.5" : "1"} placeholder={defaultSpacingExample(distanceUnit).split(" x ")[0]} />
              </label>
              <label>
                <span>Between-row spacing ({spacingUnitLabel(distanceUnit)})</span>
                <input value={spacingBetweenRows} onChange={(event) => setSpacingBetweenRows(event.target.value)} type="number" min="0" step={distanceUnit === "ft" ? "0.5" : "1"} placeholder={defaultSpacingExample(distanceUnit).split(" x ")[1]} />
              </label>
            </div>
            <div className="instruction-box full-span">
              <strong>Calculated bed length:</strong> {calculatedBedLengthM == null ? "Enter plant count and in-row spacing" : formatLength(calculatedBedLengthM, distanceUnit)}
              {availableBefore != null && (
                <span> Available transplants before this record: {availableBefore.toLocaleString()}. Estimated remaining after: {remainingAfter?.toLocaleString() ?? "—"}.</span>
              )}
              {selectedBed && selectedBlock && (
                <span> Selected: {selectedBlock.name} / {selectedBed.name}.</span>
              )}
            </div>
          </>
        )}
        {planting && (!canAdjustPlanting || !isFieldPlantingTask) && (
          <div className="instruction-box full-span">
            {canAdjustPlanting ? "This task records completion only; it does not need a bed placement." : "Worker accounts record completion here. Bed placement changes are limited to planner accounts."}
          </div>
        )}

        <label className="full-span">
          <span>Notes</span>
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="What actually happened" rows={3} />
        </label>

        <button className={`primary-button full-span${tutorialReadyToRecord ? " tutorial-target" : ""}`} disabled={saving}>
          {saving ? "Recording..." : "Record task"}
        </button>
      </form>
    </div>
  );
}

// Quick actual-date recorder for one planting. Saving here triggers backend task recalculation.
function PlantingActualsCard({ planting, onSave }: { planting: Planting | null; onSave: () => Promise<void> }) {
  const [status, setStatus] = useState<string | null>(null);
  if (!planting) {
    return <div className="card"><h2>Record work</h2><p>No planting selected.</p></div>;
  }

  return (
    <div className="card">
      <h2>Record actual work</h2>
      <p className="muted">{planting.title}</p>
      <form
        className="form-grid"
        onSubmit={(event) =>
          void handleForm(event, async (form) => {
            const eventType = String(form.get("eventType"));
            const actualDate = String(form.get("actualDate"));
            if ((eventType === "tray_seeding" || eventType === "direct_seeding" || eventType === "transplant") && actualDate > todayDateInputValue()) {
              setStatus("Planted dates cannot be in the future.");
              return;
            }
            await api.recordActual(planting.id, {
              eventType,
              actualDate,
              notes: String(form.get("notes") || "")
            });
            setStatus("Recorded.");
            await onSave();
          })
        }
      >
        {status && <p className="muted full-span"><strong>{status}</strong></p>}
        <label>
          <span>Event</span>
          <select name="eventType" defaultValue="transplant">
            <option value="tray_seeding">Seeded in tray</option>
            <option value="direct_seeding">Direct seeded</option>
            <option value="transplant">Transplanted</option>
            <option value="cultivation">Cultivated</option>
            <option value="harvest">Harvested</option>
            <option value="finish">Finished</option>
          </select>
        </label>
        <label><span>Date</span><input name="actualDate" type="date" defaultValue={todayDateInputValue()} required /></label>
        <label className="full-span"><span>Notes</span><textarea name="notes" rows={3} defaultValue="Recorded from field work" /></label>
        <button className="primary-button full-span">Record actual and recalculate tasks</button>
      </form>
    </div>
  );
}

function BlockSectionsCard({
  block,
  zones,
  distanceUnit,
  onCreateSection,
  onSelectSection
}: {
  block: Block;
  zones: BlockZone[];
  distanceUnit: DistanceUnit;
  onCreateSection: () => void;
  onSelectSection: (zoneId: number) => void;
}) {
  return (
    <div className="card">
      <h2>Block sections</h2>
      <p className="muted">{block.name}</p>
      {zones.length > 0 && (
        <div className="stack">
          {zones.map((zone) => (
            <div className="task-row" key={zone.id}>
              <div>
                <strong>{zone.name}</strong>
                <p className="muted">{formatDisplayArea(zone.areaSqM, distanceUnit)} • {formatZoneActualStateLabel(zone.actualState)}</p>
              </div>
              <button type="button" className="secondary-button" onClick={() => onSelectSection(zone.id)}>
                Select
              </button>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="primary-button full-span" onClick={onCreateSection}>
        Make section
      </button>
    </div>
  );
}

const unplannedWorkOptions = [
  "Seed in tray",
  "Direct seed",
  "Till",
  "Fertilizing / spraying",
  "Bed making",
  "Transplanting",
  "Cultivation",
  "Cleanup",
  "Covercrop"
];

const ADD_NEW_WORK_OPTION = "__add_new__";
const WORK_OPTION_STORAGE_KEY = "loam-ledger-work-options-v1";
type WorkOptionStore = {
  subcategories?: Record<string, string[]>;
  products?: Record<string, string[]>;
};

const workTypeTaskTypes: Record<string, string> = {
  "Seed in tray": "seed_in_tray",
  "Direct seed": "direct_seed",
  Till: "till",
  "Fertilizing / spraying": "fertilizing_spraying",
  "Bed making": "bed_making",
  Transplanting: "transplant",
  Cultivation: "cultivation",
  Cleanup: "cleanup",
  Covercrop: "cover_crop"
};

const defaultWorkSubcategories: Record<string, string[]> = {
  "Seed in tray": ["Hand seed"],
  "Direct seed": ["Hand seed", "Jang seeder", "Earthway"],
  Till: ["Disk", "Perfecta"],
  "Fertilizing / spraying": ["Fertilizer", "Pesticide"],
  "Bed making": ["Shape beds"],
  Cultivation: ["Cultivate"],
  Cleanup: ["Mow", "Remove crop"],
  Covercrop: ["Cover crop seed"]
};

const defaultApplicationProducts: Record<string, string[]> = {
  Fertilizer: ["Compost", "Lime"],
  Pesticide: [],
  "Cover crop seed": []
};

function workDetailLabel(workType: string) {
  if (workType === "Covercrop") return "Seed";
  if (workType === "Seed in tray" || workType === "Direct seed") return "Method";
  if (workType === "Till") return "Tool";
  if (workType === "Fertilizing / spraying") return "Application type";
  if (workType === "Bed making") return "Bed work";
  if (workType === "Cultivation") return "Cultivation type";
  if (workType === "Cleanup") return "Cleanup type";
  return "Work type";
}

function lowerFirst(value: string) {
  return value ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : value;
}

function readWorkOptionStore(): WorkOptionStore {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(WORK_OPTION_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as WorkOptionStore;
    return {
      subcategories: parsed.subcategories && typeof parsed.subcategories === "object" ? parsed.subcategories : {},
      products: parsed.products && typeof parsed.products === "object" ? parsed.products : {}
    };
  } catch {
    return {};
  }
}

function writeWorkOptionStore(store: WorkOptionStore) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(WORK_OPTION_STORAGE_KEY, JSON.stringify(store));
}

function uniqueWorkOptions(options: string[]) {
  const seen = new Set<string>();
  return options
    .map((option) => option.trim())
    .filter((option) => {
      if (!option || seen.has(option.toLowerCase())) {
        return false;
      }
      seen.add(option.toLowerCase());
      return true;
    });
}

function eventMetadataText(event: FarmEvent, key: string) {
  const value = event.metadata?.[key];
  return typeof value === "string" ? value : "";
}

function locationEventAppliesToSelection(event: FarmEvent, block: Block | null, zone: BlockZone | null, bed: Bed | null) {
  if (bed) {
    return event.bedId === bed.id || event.blockId === bed.blockId;
  }
  if (zone) {
    return event.zoneId === zone.id || event.blockId === zone.blockId;
  }
  if (block) {
    return event.blockId === block.id;
  }
  return false;
}

function hasLocationWorkEvent(events: FarmEvent[], workTypes: string[], taskTypes: string[], eventTypes: string[]) {
  const workTypeSet = new Set(workTypes.map((item) => item.toLowerCase()));
  const taskTypeSet = new Set(taskTypes.map((item) => item.toLowerCase()));
  const eventTypeSet = new Set(eventTypes.map((item) => item.toLowerCase()));
  return events.some((event) => {
    const workType = eventMetadataText(event, "workType").toLowerCase();
    const taskType = eventMetadataText(event, "taskType").toLowerCase();
    return workTypeSet.has(workType) || taskTypeSet.has(taskType) || eventTypeSet.has(event.eventType.toLowerCase());
  });
}

function orderedUnplannedWorkOptions({
  block,
  zone,
  bed,
  blockBeds,
  placements,
  events
}: {
  block: Block | null;
  zone: BlockZone | null;
  bed: Bed | null;
  blockBeds: Bed[];
  placements: Placement[];
  events: FarmEvent[];
}) {
  if (!block && !zone && !bed) {
    return unplannedWorkOptions;
  }

  const locationEvents = events.filter((event) => locationEventAppliesToSelection(event, block, zone, bed));
  const hasTill = hasLocationWorkEvent(locationEvents, ["Till", "Tilling"], ["till"], []);
  const hasFertility = hasLocationWorkEvent(locationEvents, ["Fertilizing / spraying"], ["fertilizing_spraying"], []);
  const hasBedMaking = blockBeds.length > 0 || hasLocationWorkEvent(locationEvents, ["Bed making"], ["bed_making", "bed_prep"], []);
  const blockBedIds = new Set(blockBeds.map((item) => item.id));
  const hasPlantingInBlock = placements.some((placement) => blockBedIds.has(placement.bedId))
    || hasLocationWorkEvent(locationEvents, ["Transplanting", "Direct seed"], ["transplant", "direct_seed"], ["transplant", "direct_seeding"]);

  let preferredOrder: string[];
  if (!hasTill && !hasBedMaking) {
    preferredOrder = ["Till", "Fertilizing / spraying", "Bed making", "Direct seed", "Transplanting", "Cultivation", "Cleanup", "Covercrop", "Seed in tray"];
  } else if (hasTill && !hasFertility && !hasBedMaking) {
    preferredOrder = ["Fertilizing / spraying", "Bed making", "Direct seed", "Transplanting", "Cultivation", "Cleanup", "Covercrop", "Till", "Seed in tray"];
  } else if (!hasBedMaking) {
    preferredOrder = ["Bed making", "Direct seed", "Transplanting", "Cultivation", "Fertilizing / spraying", "Cleanup", "Covercrop", "Till", "Seed in tray"];
  } else if (!hasPlantingInBlock) {
    preferredOrder = ["Transplanting", "Direct seed", "Cultivation", "Fertilizing / spraying", "Cleanup", "Covercrop", "Bed making", "Till", "Seed in tray"];
  } else {
    preferredOrder = ["Cultivation", "Fertilizing / spraying", "Cleanup", "Covercrop", "Transplanting", "Direct seed", "Bed making", "Till", "Seed in tray"];
  }

  return uniqueWorkOptions([...preferredOrder, ...unplannedWorkOptions]);
}

function UnplannedWorkCard({
  field,
  block,
  zone,
  bed,
  farmId,
  bedPresets,
  existingBeds,
  blockBeds,
  blockZones,
  plantings,
  placements,
  events,
  distanceUnit,
  pendingWorkAreaSqM,
  bedLineCoordinates,
  bedLineSource,
  bedLineMode,
  invertSide,
  isPickingLine,
  isPickingEdge,
  selectedCultivationBedIds,
  bedPickActive,
  onBedPickActiveChange,
  onSelectedCultivationBedIdsChange,
  canCreateSection,
  onSplitSection,
  onPickBedEdge,
  onStartBedLine,
  onCancelBedLine,
  onInvertSideChange,
  onEntranceSideChange,
  onPreviewChange,
  onStatusChange,
  onSelectSection,
  onCreatePendingSection,
  onSave
}: {
  field: Field | null;
  block: Block | null;
  zone: BlockZone | null;
  bed: Bed | null;
  farmId: number | null;
  bedPresets: DashboardData["bedPresets"];
  existingBeds: Bed[];
  blockBeds: Bed[];
  blockZones: BlockZone[];
  plantings: Planting[];
  placements: Placement[];
  events: FarmEvent[];
  distanceUnit: DistanceUnit;
  pendingWorkAreaSqM: number | null;
  bedLineCoordinates: CoordinateDraft[];
  bedLineSource: BedLineSource;
  bedLineMode: "straight" | "curved";
  invertSide: boolean;
  isPickingLine: boolean;
  isPickingEdge: boolean;
  selectedCultivationBedIds: number[];
  bedPickActive: boolean;
  onBedPickActiveChange: (active: boolean) => void;
  onSelectedCultivationBedIdsChange: (bedIds: number[]) => void;
  canCreateSection: boolean;
  onSplitSection: () => void;
  onPickBedEdge: () => void;
  onStartBedLine: (mode: "straight" | "curved") => void;
  onCancelBedLine: () => void;
  onInvertSideChange: (value: boolean) => void;
  onEntranceSideChange: (blockId: number, entranceSide: "start" | "end") => void;
  onPreviewChange: (points: CoordinateDraft[]) => void;
  onStatusChange: (message: string | null) => void;
  onSelectSection: (zoneId: number) => void;
  onCreatePendingSection: (notes: string) => Promise<number | null>;
  onSave: () => Promise<void>;
}) {
  const [eventDate, setEventDate] = useState(todayDateInputValue());
  const [workType, setWorkType] = useState(unplannedWorkOptions[0]);
  const [workOptionStore, setWorkOptionStore] = useState<WorkOptionStore>(() => readWorkOptionStore());
  const [workSubcategory, setWorkSubcategory] = useState(defaultWorkSubcategories[unplannedWorkOptions[0]]?.[0] ?? "");
  const [customWorkSubcategory, setCustomWorkSubcategory] = useState("");
  const [applicationProduct, setApplicationProduct] = useState("");
  const [customApplicationProduct, setCustomApplicationProduct] = useState("");
  const [bedMakingCount, setBedMakingCount] = useState("");
  const [bedMakingBlockFull, setBedMakingBlockFull] = useState(false);
  const [bedMakingBedCover, setBedMakingBedCover] = useState<"bare" | "plastic">("bare");
  const bedMakingPresets = bedPresets.filter((preset) => !preset.isRoad);
  const [bedMakingPresetId, setBedMakingPresetId] = useState(String(bedMakingPresets[0]?.id ?? ""));
  const [bedMakingNamePrefix, setBedMakingNamePrefix] = useState(`${block?.name ?? "Bed"}-`);
  const [bedMakingStartNumber, setBedMakingStartNumber] = useState(existingBeds.length + 1);
  const [bedMakingReplaceExisting, setBedMakingReplaceExisting] = useState(false);
  const [bedMakingEntranceSide, setBedMakingEntranceSide] = useState<"start" | "end">(block?.bedStartEntranceSide ?? "start");
  const [bedMakingHarvestRoadsEnabled, setBedMakingHarvestRoadsEnabled] = useState(false);
  const [bedMakingHarvestRoadEveryBeds, setBedMakingHarvestRoadEveryBeds] = useState("12");
  const [bedMakingHarvestRoadWidthBeds, setBedMakingHarvestRoadWidthBeds] = useState("2");
  const [transplantPlantingId, setTransplantPlantingId] = useState("");
  const [transplantPlantCount, setTransplantPlantCount] = useState("");
  const [transplantTrayCount, setTransplantTrayCount] = useState("");
  const [transplantInRowSpacing, setTransplantInRowSpacing] = useState("");
  const [transplantRowsPerBed, setTransplantRowsPerBed] = useState("");
  const [applicationRateUsed, setApplicationRateUsed] = useState("");
  const [applicationAmountUsed, setApplicationAmountUsed] = useState("");
  const [applicationUnit, setApplicationUnit] = useState("lb");
  const [applicationLastEdited, setApplicationLastEdited] = useState<"rate" | "amount">("rate");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const locationName = bed
    ? `${bed.name} in ${bed.blockName}`
    : zone
      ? `${zone.name} in ${zone.blockName}`
      : block
        ? block.name
        : field?.name ?? "selected area";
  const workLocationKey = `${field?.id ?? "field-none"}:${block?.id ?? "block-none"}:${zone?.id ?? "zone-none"}:${bed?.id ?? "bed-none"}`;
  const orderedWorkOptions = useMemo(() => orderedUnplannedWorkOptions({
    block,
    zone,
    bed,
    blockBeds,
    placements,
    events
  }), [bed, block, blockBeds, events, placements, zone]);
  const cardTitle = "Record Work (unplanned)";
  const showSubcategoryFields = workType !== "Transplanting";
  const subcategoryOptions = uniqueWorkOptions([
    ...(defaultWorkSubcategories[workType] ?? []),
    ...(workOptionStore.subcategories?.[workType] ?? [])
  ]);
  const resolvedWorkSubcategory = showSubcategoryFields
    ? workSubcategory === ADD_NEW_WORK_OPTION
      ? customWorkSubcategory.trim()
      : workSubcategory.trim()
    : "";
  const applicationProductOptions = uniqueWorkOptions([
    ...(defaultApplicationProducts[resolvedWorkSubcategory] ?? []),
    ...(workOptionStore.products?.[resolvedWorkSubcategory] ?? [])
  ]);
  const resolvedApplicationProduct = applicationProduct === ADD_NEW_WORK_OPTION
    ? customApplicationProduct.trim()
    : applicationProduct.trim();
  const finalWorkType = workType;
  const finalTaskType = workTypeTaskTypes[workType] ?? null;
  const showSectionTools = ["Till", "Fertilizing / spraying", "Cleanup", "Covercrop"].includes(workType) && block != null;
  const showApplicationFields = workType === "Fertilizing / spraying" || workType === "Covercrop";
  const showBedMakingFields = workType === "Bed making";
  const showTransplantFields = workType === "Transplanting";
  const showCultivationFields = workType === "Cultivation";
  const selectedBedMakingPreset = bedMakingPresets.find((preset) => String(preset.id) === bedMakingPresetId) ?? bedMakingPresets[0] ?? null;
  const detailLabel = workDetailLabel(workType);
  const bedMakingMinLinePoints = bedLineMode === "straight" ? 2 : 3;
  const bedMakingMaxLinePoints = bedLineMode === "straight" ? 2 : 12;
  const bedMakingCountNumber = Number(bedMakingCount);
  const bedMakingStartNumberValue = Number(bedMakingStartNumber);
  const bedMakingHarvestRoadEveryValue = Number(bedMakingHarvestRoadEveryBeds);
  const bedMakingHarvestRoadWidthValue = Number(bedMakingHarvestRoadWidthBeds);
  const transplantPlantCountNumber = Number(transplantPlantCount);
  const transplantTrayCountNumber = Number(transplantTrayCount);
  const transplantInRowSpacingNumber = Number(transplantInRowSpacing);
  const transplantRowsPerBedNumber = Number(transplantRowsPerBed);
  const applicationRateUsedNumber = Number(applicationRateUsed);
  const applicationAmountUsedNumber = Number(applicationAmountUsed);
  const selectedAreaSqM = pendingWorkAreaSqM ?? toNumericValue(bed?.areaSqM ?? zone?.areaSqM ?? block?.areaSqM ?? field?.areaSqM ?? null);
  const selectedAreaAcres = selectedAreaSqM == null ? null : selectedAreaSqM / 4046.8564224;
  const applicationUnitLabel = applicationUnit.trim() || "units";
  const applicationProductLabel = workType === "Covercrop" ? "Seed used" : "Product used";
  const selectedTransplantPlanting = transplantPlantingId
    ? plantings.find((planting) => String(planting.id) === transplantPlantingId) ?? null
    : null;
  const transplantOptions = plantings
    .map((planting) => {
      const placedCount = plantingPlacementCount(placements, planting.id);
      const availableCount = planting.plantCount == null ? null : Math.max(0, planting.plantCount - placedCount);
      return { planting, availableCount };
    })
    .filter(({ planting, availableCount }) => (
      planting.status !== "finished"
      && planting.status !== "harvested"
      && (availableCount == null || availableCount > 0)
    ))
    .sort((left, right) => {
      const leftBlockMatch = block != null && left.planting.intendedBlockId === block.id ? 0 : 1;
      const rightBlockMatch = block != null && right.planting.intendedBlockId === block.id ? 0 : 1;
      if (leftBlockMatch !== rightBlockMatch) return leftBlockMatch - rightBlockMatch;
      return left.planting.title.localeCompare(right.planting.title);
    });
  const selectedTransplantAvailableCount = selectedTransplantPlanting?.plantCount == null
    ? null
    : Math.max(0, selectedTransplantPlanting.plantCount - plantingPlacementCount(placements, selectedTransplantPlanting.id));

  useEffect(() => {
    setWorkType(orderedWorkOptions[0] ?? unplannedWorkOptions[0]);
  }, [workLocationKey]);

  useEffect(() => {
    if (!bedMakingPresetId && bedMakingPresets[0]) {
      setBedMakingPresetId(String(bedMakingPresets[0].id));
    }
  }, [bedMakingPresetId, bedMakingPresets]);

  useEffect(() => {
    setBedMakingNamePrefix(`${block?.name ?? "Bed"}-`);
    setBedMakingEntranceSide(block?.bedStartEntranceSide ?? "start");
  }, [block?.bedStartEntranceSide, block?.id, block?.name]);

  useEffect(() => {
    if (!bedMakingReplaceExisting) {
      setBedMakingStartNumber(existingBeds.length + 1);
    }
  }, [bedMakingReplaceExisting, existingBeds.length]);

  useEffect(() => {
    if (!showBedMakingFields || !block || !selectedBedMakingPreset || bedLineCoordinates.length < bedMakingMinLinePoints || bedLineCoordinates.length > bedMakingMaxLinePoints) {
      onPreviewChange([]);
      return;
    }

    const blockBoundary = geoJsonPolygonToLatLngs(block.boundary);
    const roadEvery = bedMakingHarvestRoadsEnabled ? bedMakingHarvestRoadEveryValue : null;
    const roadWidth = bedMakingHarvestRoadsEnabled ? bedMakingHarvestRoadWidthValue : 0;
    const presetPathSpacing = Number(selectedBedMakingPreset.pathSpacingM);
    const selectedBedEdgeOffsetM = bedLineSource === "selected_bed" ? presetPathSpacing : 0;
    const preview = buildNextBedPreview(
      bedLineCoordinates,
      Number(selectedBedMakingPreset.bedWidthM),
      presetPathSpacing,
      bedLineSource === "selected_bed" ? 0 : bedMakingReplaceExisting ? 0 : existingBeds.length,
      selectedBedEdgeOffsetM,
      invertSide,
      roadEvery && Number.isFinite(roadEvery) ? roadEvery : null,
      Number.isFinite(roadWidth) ? roadWidth : 0
    );
    onPreviewChange(polygonIsInsideOrOnPolygon(preview, blockBoundary) ? preview : []);

    return () => onPreviewChange([]);
  }, [
    bedLineCoordinates,
    bedLineCoordinates.length,
    bedLineSource,
    bedMakingHarvestRoadEveryValue,
    bedMakingHarvestRoadWidthValue,
    bedMakingHarvestRoadsEnabled,
    bedMakingMaxLinePoints,
    bedMakingMinLinePoints,
    bedMakingReplaceExisting,
    block,
    existingBeds.length,
    invertSide,
    onPreviewChange,
    selectedBedMakingPreset,
    showBedMakingFields
  ]);

  useEffect(() => {
    const nextOptions = uniqueWorkOptions([
      ...(defaultWorkSubcategories[workType] ?? []),
      ...(workOptionStore.subcategories?.[workType] ?? [])
    ]);
    setWorkSubcategory(nextOptions[0] ?? "");
    setCustomWorkSubcategory("");
    setApplicationProduct("");
    setCustomApplicationProduct("");
  }, [workOptionStore.subcategories, workType]);

  useEffect(() => {
    if (!showApplicationFields) {
      return;
    }
    const nextOptions = uniqueWorkOptions([
      ...(defaultApplicationProducts[resolvedWorkSubcategory] ?? []),
      ...(workOptionStore.products?.[resolvedWorkSubcategory] ?? [])
    ]);
    setApplicationProduct(nextOptions[0] ?? "");
    setCustomApplicationProduct("");
  }, [resolvedWorkSubcategory, showApplicationFields, workOptionStore.products]);

  useEffect(() => {
    if (workType !== "Cultivation" && workType !== "Transplanting" && bedPickActive) {
      onBedPickActiveChange(false);
    }
  }, [bedPickActive, onBedPickActiveChange, workType]);

  useEffect(() => {
    if (!showApplicationFields || selectedAreaAcres == null || selectedAreaAcres <= 0) {
      return;
    }

    if (applicationLastEdited === "rate") {
      if (!applicationRateUsed.trim() || !Number.isFinite(applicationRateUsedNumber) || applicationRateUsedNumber < 0) {
        if (applicationAmountUsed) {
          setApplicationAmountUsed("");
        }
        return;
      }
      const nextAmount = formatDecimalInputValue(applicationRateUsedNumber * selectedAreaAcres);
      if (nextAmount !== applicationAmountUsed) {
        setApplicationAmountUsed(nextAmount);
      }
      return;
    }

    if (!applicationAmountUsed.trim() || !Number.isFinite(applicationAmountUsedNumber) || applicationAmountUsedNumber < 0) {
      if (applicationRateUsed) {
        setApplicationRateUsed("");
      }
      return;
    }
    const nextRate = formatDecimalInputValue(applicationAmountUsedNumber / selectedAreaAcres);
    if (nextRate !== applicationRateUsed) {
      setApplicationRateUsed(nextRate);
    }
  }, [
    applicationAmountUsed,
    applicationAmountUsedNumber,
    applicationLastEdited,
    applicationRateUsed,
    applicationRateUsedNumber,
    selectedAreaAcres,
    showApplicationFields
  ]);

  useEffect(() => {
    if (workType !== "Transplanting") {
      return;
    }
    if (transplantPlantingId || transplantOptions.length === 0) {
      return;
    }
    const firstPlanting = transplantOptions[0].planting;
    setTransplantPlantingId(String(firstPlanting.id));
    if (firstPlanting.plantCount != null) {
      const availableCount = Math.max(0, firstPlanting.plantCount - plantingPlacementCount(placements, firstPlanting.id));
      setTransplantPlantCount(String(availableCount || firstPlanting.plantCount));
    }
    setTransplantTrayCount(firstPlanting.trayCount == null ? "" : String(firstPlanting.trayCount));
    setTransplantInRowSpacing(firstPlanting.fieldSpacingInRow == null ? "" : String(firstPlanting.fieldSpacingInRow));
    setTransplantRowsPerBed(firstPlanting.rowsPerBed == null ? "" : String(firstPlanting.rowsPerBed));
  }, [placements, transplantOptions, transplantPlantingId, workType]);

  async function saveUnplannedWork(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (eventDate > todayDateInputValue()) {
      setStatus("Work date cannot be in the future.");
      return;
    }
    if (!finalWorkType) {
      setStatus("Enter what work was done.");
      return;
    }
    if (showSubcategoryFields && !resolvedWorkSubcategory) {
      setStatus(`Choose or add the ${lowerFirst(detailLabel)}.`);
      return;
    }
    if (showApplicationFields && !resolvedApplicationProduct) {
      setStatus(workType === "Covercrop" ? "Choose or add the seed used." : "Choose or add the product used.");
      return;
    }
    if (showBedMakingFields && !block) {
      setStatus("Select a block before making real beds.");
      return;
    }
    if (showBedMakingFields && !selectedBedMakingPreset) {
      setStatus("Choose a bed spacing preset first.");
      return;
    }
    if (showBedMakingFields && bedLineCoordinates.length < bedMakingMinLinePoints) {
      setStatus(bedLineMode === "straight" ? "Pick a block edge or two line points first." : "Pick the bed line points first.");
      return;
    }
    if (showBedMakingFields && bedLineCoordinates.length > bedMakingMaxLinePoints) {
      setStatus("Too many bed line points selected.");
      return;
    }
    if (showBedMakingFields && (!Number.isInteger(bedMakingStartNumberValue) || bedMakingStartNumberValue < 1)) {
      setStatus("Start number must be a whole number above zero.");
      return;
    }
    if (showBedMakingFields && !bedMakingBlockFull && (!Number.isInteger(bedMakingCountNumber) || bedMakingCountNumber <= 0)) {
      setStatus("Enter how many beds were made.");
      return;
    }
    if (showBedMakingFields && bedMakingHarvestRoadsEnabled && (
      !Number.isInteger(bedMakingHarvestRoadEveryValue)
      || bedMakingHarvestRoadEveryValue < 1
      || !Number.isInteger(bedMakingHarvestRoadWidthValue)
      || bedMakingHarvestRoadWidthValue < 1
    )) {
      setStatus("Harvest roads need a positive bed interval and road width.");
      return;
    }
    if (showApplicationFields && selectedAreaAcres != null && selectedAreaAcres > 0) {
      if (applicationRateUsed.trim() && (!Number.isFinite(applicationRateUsedNumber) || applicationRateUsedNumber < 0)) {
        setStatus("Rate used must be zero or above.");
        return;
      }
      if (applicationAmountUsed.trim() && (!Number.isFinite(applicationAmountUsedNumber) || applicationAmountUsedNumber < 0)) {
        setStatus("Amount used must be zero or above.");
        return;
      }
    }
    if (showTransplantFields && !selectedTransplantPlanting) {
      setStatus("Choose the planting transplanted.");
      return;
    }
    if (showTransplantFields && (!Number.isInteger(transplantPlantCountNumber) || transplantPlantCountNumber <= 0)) {
      setStatus("Enter how many plants were transplanted.");
      return;
    }
    if (showTransplantFields && transplantInRowSpacing.trim() && (!Number.isFinite(transplantInRowSpacingNumber) || transplantInRowSpacingNumber <= 0)) {
      setStatus("In-row spacing must be above zero.");
      return;
    }
    if (showTransplantFields && transplantRowsPerBed.trim() && (!Number.isInteger(transplantRowsPerBedNumber) || transplantRowsPerBedNumber <= 0)) {
      setStatus("Rows per bed must be a whole number above zero.");
      return;
    }
    if (showTransplantFields && blockBeds.length > 0 && selectedCultivationBedIds.length === 0) {
      setStatus("Choose the beds transplanted.");
      return;
    }
    if (showCultivationFields && blockBeds.length > 0 && selectedCultivationBedIds.length === 0) {
      setStatus("Choose the beds cultivated.");
      return;
    }

    try {
      setSaving(true);
      setStatus("Recording work...");
      const pendingSectionId = await onCreatePendingSection(notes);
      let recordedBedMakingCount = bedMakingBlockFull ? null : bedMakingCountNumber;
      if (showBedMakingFields && block && selectedBedMakingPreset) {
        setStatus("Making beds...");
        const bedGenerationZoneId = zone?.plannedUse === "beds" ? zone.id : null;
        const result = await api.generateBeds(block.id, {
          presetId: selectedBedMakingPreset.id,
          zoneId: bedGenerationZoneId,
          lineMode: bedLineMode,
          lineCoordinates: bedLineCoordinates,
          count: bedMakingBlockFull ? 1 : bedMakingCountNumber,
          layoutStartIndex: bedLineSource === "selected_bed" ? 0 : bedMakingReplaceExisting ? 0 : existingBeds.length,
          edgeOffsetM: bedLineSource === "selected_bed" ? Number(selectedBedMakingPreset.pathSpacingM) : 0,
          namePrefix: bedMakingNamePrefix,
          startNumber: bedMakingStartNumberValue,
          isPermanent: true,
          replaceExisting: bedMakingReplaceExisting,
          invertSide,
          entranceSide: bedMakingEntranceSide,
          fillWholeBlock: bedMakingBlockFull,
          harvestRoadEveryBeds: bedMakingHarvestRoadsEnabled ? bedMakingHarvestRoadEveryValue : null,
          harvestRoadWidthBeds: bedMakingHarvestRoadsEnabled ? bedMakingHarvestRoadWidthValue : 0
        }) as { inserted?: number; insertedIds?: number[]; isRoad?: boolean };
        recordedBedMakingCount = result.inserted ?? recordedBedMakingCount;
        onStatusChange(result.inserted != null ? `Generated ${result.inserted} beds.` : "Beds generated.");
      }
      const nextWorkOptionStore: WorkOptionStore = {
        subcategories: { ...(workOptionStore.subcategories ?? {}) },
        products: { ...(workOptionStore.products ?? {}) }
      };
      if (showSubcategoryFields && workSubcategory === ADD_NEW_WORK_OPTION && resolvedWorkSubcategory) {
        nextWorkOptionStore.subcategories = {
          ...nextWorkOptionStore.subcategories,
          [workType]: uniqueWorkOptions([...(nextWorkOptionStore.subcategories?.[workType] ?? []), resolvedWorkSubcategory])
        };
      }
      if (showApplicationFields && applicationProduct === ADD_NEW_WORK_OPTION && resolvedApplicationProduct) {
        nextWorkOptionStore.products = {
          ...nextWorkOptionStore.products,
          [resolvedWorkSubcategory]: uniqueWorkOptions([...(nextWorkOptionStore.products?.[resolvedWorkSubcategory] ?? []), resolvedApplicationProduct])
        };
      }
      setWorkOptionStore(nextWorkOptionStore);
      writeWorkOptionStore(nextWorkOptionStore);
      const eventTitle = showBedMakingFields
        ? recordedBedMakingCount != null
          ? `${recordedBedMakingCount} ${bedMakingBedCover} bed${recordedBedMakingCount === 1 ? "" : "s"} made`
          : `Filled block with ${bedMakingBedCover} beds`
        : showTransplantFields && selectedTransplantPlanting
          ? `Transplanted ${selectedTransplantPlanting.title} in ${selectedCultivationBedIds.length} bed${selectedCultivationBedIds.length === 1 ? "" : "s"}`
          : showCultivationFields
            ? `Cultivated ${selectedCultivationBedIds.length} bed${selectedCultivationBedIds.length === 1 ? "" : "s"}`
            : resolvedWorkSubcategory || finalWorkType;
      await api.recordUnplannedWork({
        eventDate,
        workType: finalWorkType,
        taskType: finalTaskType,
        workSubcategory: resolvedWorkSubcategory || null,
        applicationProduct: showApplicationFields ? resolvedApplicationProduct : null,
        title: eventTitle,
        notes: notes.trim() || null,
        fieldId: field?.id ?? null,
        blockId: block?.id ?? null,
        zoneId: pendingSectionId ?? zone?.id ?? null,
        bedId: bed?.id ?? null,
        bedMakingBedCount: showBedMakingFields ? recordedBedMakingCount : null,
        bedMakingBlockFull: showBedMakingFields ? bedMakingBlockFull : null,
        bedMakingBedCover: showBedMakingFields ? bedMakingBedCover : null,
        applicationRateUsed: showApplicationFields && applicationRateUsed.trim() ? applicationRateUsedNumber : null,
        applicationAmountUsed: showApplicationFields && applicationAmountUsed.trim() ? applicationAmountUsedNumber : null,
        applicationUnit: showApplicationFields ? applicationUnitLabel : null,
        applicationAreaSqM: showApplicationFields ? selectedAreaSqM : null,
        transplantPlantingId: showTransplantFields && selectedTransplantPlanting ? selectedTransplantPlanting.id : null,
        transplantCrop: showTransplantFields && selectedTransplantPlanting ? selectedTransplantPlanting.cropName : null,
        transplantVariety: showTransplantFields && selectedTransplantPlanting ? selectedTransplantPlanting.varietyName : null,
        transplantPlantCount: showTransplantFields ? transplantPlantCountNumber : null,
        transplantTrayCount: showTransplantFields && Number.isInteger(transplantTrayCountNumber) && transplantTrayCountNumber > 0 ? transplantTrayCountNumber : null,
        transplantInRowSpacing: showTransplantFields && transplantInRowSpacing.trim() ? transplantInRowSpacingNumber : null,
        transplantRowsPerBed: showTransplantFields && transplantRowsPerBed.trim() ? transplantRowsPerBedNumber : null,
        transplantBedIds: showTransplantFields ? selectedCultivationBedIds : [],
        cultivationBedIds: showCultivationFields ? selectedCultivationBedIds : []
      });
      setBedMakingCount("");
      setBedMakingBlockFull(false);
      setBedMakingBedCover("bare");
      setApplicationRateUsed("");
      setApplicationAmountUsed("");
      setApplicationUnit("lb");
      setApplicationLastEdited("rate");
      setCustomWorkSubcategory("");
      setApplicationProduct("");
      setCustomApplicationProduct("");
      setTransplantPlantingId("");
      setTransplantPlantCount("");
      setTransplantTrayCount("");
      setTransplantInRowSpacing("");
      setTransplantRowsPerBed("");
      setNotes("");
      if (showCultivationFields || showTransplantFields) {
        onSelectedCultivationBedIdsChange([]);
        onBedPickActiveChange(false);
      }
      await onSave();
      setStatus("Work recorded.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Work record failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" data-card-id="UnplannedWorkCard">
      <h2>{cardTitle}</h2>
      <p className="muted">{locationName}</p>
      {status && <p className="muted"><strong>{status}</strong></p>}
      <form className="form-grid" onSubmit={(event) => void saveUnplannedWork(event)}>
        <label>
          <span>Date</span>
          <input type="date" value={eventDate} onChange={(event) => setEventDate(event.target.value)} required />
        </label>
        <label>
          <span>Work category</span>
          <select value={workType} onChange={(event) => setWorkType(event.target.value)}>
            {orderedWorkOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        {showSubcategoryFields && (
          <label>
            <span>{detailLabel}</span>
            <select value={workSubcategory} onChange={(event) => setWorkSubcategory(event.target.value)}>
              {subcategoryOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              <option value={ADD_NEW_WORK_OPTION}>Add new...</option>
            </select>
          </label>
        )}
        {showSubcategoryFields && workSubcategory === ADD_NEW_WORK_OPTION && (
          <label className="full-span">
            <span>New {lowerFirst(detailLabel)}</span>
            <input value={customWorkSubcategory} onChange={(event) => setCustomWorkSubcategory(event.target.value)} maxLength={80} required />
          </label>
        )}
        {showApplicationFields && (
          <label className="full-span">
            <span>{applicationProductLabel}</span>
            <select value={applicationProduct} onChange={(event) => setApplicationProduct(event.target.value)}>
              {applicationProductOptions.length === 0 && <option value="">Choose {workType === "Covercrop" ? "seed" : "product"}</option>}
              {applicationProductOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              <option value={ADD_NEW_WORK_OPTION}>Add new...</option>
            </select>
          </label>
        )}
        {showApplicationFields && applicationProduct === ADD_NEW_WORK_OPTION && (
          <label className="full-span">
            <span>New {workType === "Covercrop" ? "seed" : "product"}</span>
            <input value={customApplicationProduct} onChange={(event) => setCustomApplicationProduct(event.target.value)} maxLength={120} required />
          </label>
        )}
        {showSectionTools && (
          <div className="full-span stack">
            <span className="field-label">Block section</span>
            <div className="instruction-box">
              Area selected: {formatDisplayArea(selectedAreaSqM, distanceUnit)}.
            </div>
            {zone ? (
              <div className="instruction-box">
                This record will attach to {zone.name}. You can still make a new section from the parent block.
              </div>
            ) : (
              <div className="instruction-box">
                If the work only happened in part of the block, select an existing section or make one first.
              </div>
            )}
            {blockZones.length > 0 && (
              <div className="button-row">
                {blockZones.map((item) => (
                  <button type="button" className="secondary-button" key={item.id} onClick={() => onSelectSection(item.id)}>
                    Use {item.name}
                  </button>
                ))}
              </div>
            )}
            {canCreateSection ? (
              <div className="button-row">
                <button type="button" className="primary-button" onClick={onSplitSection}>
                  Split with line
                </button>
              </div>
            ) : (
              <div className="instruction-box">
                Planner access is required to make block sections.
              </div>
            )}
          </div>
        )}
        {showApplicationFields && (
          <>
            <label>
              <span>Rate used ({applicationUnitLabel}/ac)</span>
              <input
                type="number"
                min="0"
                step="any"
                value={applicationRateUsed}
                onChange={(event) => {
                  setApplicationLastEdited("rate");
                  setApplicationRateUsed(event.target.value);
                }}
              />
            </label>
            <label>
              <span>Amount used ({applicationUnitLabel})</span>
              <input
                type="number"
                min="0"
                step="any"
                value={applicationAmountUsed}
                onChange={(event) => {
                  setApplicationLastEdited("amount");
                  setApplicationAmountUsed(event.target.value);
                }}
              />
            </label>
            <label className="full-span">
              <span>Unit</span>
              <input value={applicationUnit} onChange={(event) => setApplicationUnit(event.target.value)} maxLength={24} />
            </label>
          </>
        )}
        {showBedMakingFields && (
          <>
            {!block && (
              <div className="instruction-box full-span">Select a block to make real mapped beds.</div>
            )}
            {block && bedMakingPresets.length === 0 && (
              <div className="instruction-box full-span">
                No bed spacing presets are saved yet. Create one in the bed generator first, then this card will use the same spacing here.
              </div>
            )}
            {block && bedMakingPresets.length > 0 && (
              <>
                <label className="full-span">
                  <span>Bed spacing preset</span>
                  <select value={bedMakingPresetId} onChange={(event) => setBedMakingPresetId(event.target.value)}>
                    {bedMakingPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name} ({formatLength(preset.bedWidthM, distanceUnit)} bed / {formatLength(preset.pathSpacingM, distanceUnit)} path)
                      </option>
                    ))}
                  </select>
                </label>
                <div className="full-span button-row">
                  <button type="button" className="primary-button" onClick={onPickBedEdge}>
                    {isPickingEdge ? "Stop picking edge" : "Pick block edge"}
                  </button>
                  <button type="button" className="secondary-button" onClick={() => onStartBedLine("straight")}>
                    {isPickingLine ? "Picking line..." : "Draw straight line"}
                  </button>
                  {isPickingLine && (
                    <button type="button" className="secondary-button" onClick={onCancelBedLine}>
                      Cancel line
                    </button>
                  )}
                </div>
                <div className="full-span generated-bed-list">
                  {bedLineCoordinates.map((_, index) => (
                    <span key={index} className="small-chip">Line point {index + 1}</span>
                  ))}
                </div>
                <p className="muted full-span">Current line points: {bedLineCoordinates.length} / {bedMakingMaxLinePoints}</p>
                <label>
                  <span>Beds made</span>
                  <input
                    type="number"
                    min="1"
                    max="500"
                    value={bedMakingCount}
                    onChange={(event) => setBedMakingCount(event.target.value)}
                    required={!bedMakingBlockFull}
                    disabled={bedMakingBlockFull}
                  />
                </label>
                <label>
                  <span>Bed type</span>
                  <select value={bedMakingBedCover} onChange={(event) => setBedMakingBedCover(event.target.value as "bare" | "plastic")}>
                    <option value="bare">Bare</option>
                    <option value="plastic">Plastic mulch</option>
                  </select>
                </label>
                <div className="bed-making-mode-toggle full-span" role="group" aria-label="Bed-making coverage">
                  <button
                    type="button"
                    className={bedMakingBlockFull ? "secondary-button" : "primary-button"}
                    aria-pressed={!bedMakingBlockFull}
                    onClick={() => setBedMakingBlockFull(false)}
                  >
                    Partial
                  </button>
                  <button
                    type="button"
                    className={bedMakingBlockFull ? "primary-button" : "secondary-button"}
                    aria-pressed={bedMakingBlockFull}
                    onClick={() => setBedMakingBlockFull(true)}
                  >
                    Fill block
                  </button>
                </div>
                <label>
                  <span>Name prefix</span>
                  <input value={bedMakingNamePrefix} onChange={(event) => setBedMakingNamePrefix(event.target.value)} />
                </label>
                <label>
                  <span>Start number</span>
                  <input value={bedMakingStartNumber} onChange={(event) => setBedMakingStartNumber(Number(event.target.value))} type="number" min="1" />
                </label>
                <label>
                  <span>Existing beds</span>
                  <select
                    value={String(bedMakingReplaceExisting)}
                    onChange={(event) => {
                      const nextValue = event.target.value === "true";
                      setBedMakingReplaceExisting(nextValue);
                      setBedMakingStartNumber(nextValue ? 1 : existingBeds.length + 1);
                    }}
                  >
                    <option value="false">Keep existing beds</option>
                    <option value="true">Replace beds in block</option>
                  </select>
                </label>
                <label>
                  <span>First-bed entrance side</span>
                  <select
                    value={bedMakingEntranceSide}
                    onChange={(event) => {
                      const nextEntranceSide = event.target.value as "start" | "end";
                      setBedMakingEntranceSide(nextEntranceSide);
                      if (block) {
                        onEntranceSideChange(block.id, nextEntranceSide);
                      }
                    }}
                  >
                    <option value="start">Start side of first bed</option>
                    <option value="end">Far side of first bed</option>
                  </select>
                </label>
                <label className="inline-checkbox full-span">
                  <input type="checkbox" checked={invertSide} onChange={(event) => onInvertSideChange(event.target.checked)} />
                  <span>Build off the other side of the line</span>
                </label>
                <details className="full-span foldout-panel">
                  <summary>Harvest roads</summary>
                  <label className="inline-checkbox">
                    <input type="checkbox" checked={bedMakingHarvestRoadsEnabled} onChange={(event) => setBedMakingHarvestRoadsEnabled(event.target.checked)} />
                    <span>Leave gaps while generating beds</span>
                  </label>
                  <div className="form-grid">
                    <label>
                      <span>Road after every</span>
                      <input value={bedMakingHarvestRoadEveryBeds} onChange={(event) => setBedMakingHarvestRoadEveryBeds(event.target.value)} type="number" min="1" disabled={!bedMakingHarvestRoadsEnabled} />
                    </label>
                    <label>
                      <span>Road width in bed slots</span>
                      <input value={bedMakingHarvestRoadWidthBeds} onChange={(event) => setBedMakingHarvestRoadWidthBeds(event.target.value)} type="number" min="1" max="20" disabled={!bedMakingHarvestRoadsEnabled} />
                    </label>
                  </div>
                </details>
              </>
            )}
          </>
        )}
        {showTransplantFields && (
          <>
            <label className="full-span">
              <span>Planting</span>
              <select
                value={transplantPlantingId}
                onChange={(event) => {
                  const nextPlanting = plantings.find((planting) => String(planting.id) === event.target.value) ?? null;
                  setTransplantPlantingId(event.target.value);
                  if (nextPlanting) {
                    const availableCount = nextPlanting.plantCount == null
                      ? null
                      : Math.max(0, nextPlanting.plantCount - plantingPlacementCount(placements, nextPlanting.id));
                    setTransplantPlantCount(availableCount == null ? "" : String(availableCount));
                    setTransplantTrayCount(nextPlanting.trayCount == null ? "" : String(nextPlanting.trayCount));
                    setTransplantInRowSpacing(nextPlanting.fieldSpacingInRow == null ? "" : String(nextPlanting.fieldSpacingInRow));
                    setTransplantRowsPerBed(nextPlanting.rowsPerBed == null ? "" : String(nextPlanting.rowsPerBed));
                  }
                }}
                required
              >
                <option value="">Choose planting</option>
                {transplantOptions.map(({ planting, availableCount }) => (
                  <option key={planting.id} value={planting.id}>
                    {planting.title}{availableCount == null ? "" : ` (${availableCount} available)`}{block && planting.intendedBlockId !== block.id ? " - other block" : ""}
                  </option>
                ))}
              </select>
            </label>
            {selectedTransplantPlanting && (
              <div className="instruction-box full-span">
                <strong>{selectedTransplantPlanting.cropName}{selectedTransplantPlanting.varietyName ? ` / ${selectedTransplantPlanting.varietyName}` : ""}</strong>
                <span> Planned for {selectedTransplantPlanting.intendedBlockName ?? selectedTransplantPlanting.intendedFieldName ?? "no mapped location"}.</span>
                {selectedTransplantAvailableCount != null && <span> Available plants: {selectedTransplantAvailableCount.toLocaleString()}.</span>}
              </div>
            )}
            <label>
              <span>Plants transplanted</span>
              <input
                type="number"
                min="1"
                value={transplantPlantCount}
                onChange={(event) => setTransplantPlantCount(event.target.value)}
                required
              />
            </label>
            <label>
              <span>Trays</span>
              <input type="number" min="1" value={transplantTrayCount} onChange={(event) => setTransplantTrayCount(event.target.value)} />
            </label>
            <label>
              <span>In-row spacing ({spacingUnitLabel(distanceUnit)})</span>
              <input
                type="number"
                min="0"
                step={distanceUnit === "ft" ? "0.5" : "1"}
                value={transplantInRowSpacing}
                onChange={(event) => setTransplantInRowSpacing(event.target.value)}
              />
            </label>
            <label>
              <span>Rows per bed</span>
              <input
                type="number"
                min="1"
                step="1"
                value={transplantRowsPerBed}
                onChange={(event) => setTransplantRowsPerBed(event.target.value)}
              />
            </label>
            <WorkBedPicker
              beds={blockBeds}
              selectedBedIds={selectedCultivationBedIds}
              bedPickActive={bedPickActive}
              pickLabel="Pick transplant beds on map"
              pickingLabel="Picking transplant beds"
              onBedPickActiveChange={onBedPickActiveChange}
              onSelectedBedIdsChange={onSelectedCultivationBedIdsChange}
            />
          </>
        )}
        {showCultivationFields && (
          <WorkBedPicker
            beds={blockBeds}
            selectedBedIds={selectedCultivationBedIds}
            bedPickActive={bedPickActive}
            pickLabel="Pick beds on map"
            pickingLabel="Picking beds"
            onBedPickActiveChange={onBedPickActiveChange}
            onSelectedBedIdsChange={onSelectedCultivationBedIdsChange}
          />
        )}
        <label className="full-span">
          <span>Extra notes</span>
          <textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        <button type="submit" className="primary-button full-span" disabled={saving}>
          {saving ? "Recording..." : "Record work"}
        </button>
      </form>
    </div>
  );
}

function WorkBedPicker({
  beds,
  selectedBedIds,
  bedPickActive,
  pickLabel,
  pickingLabel,
  onBedPickActiveChange,
  onSelectedBedIdsChange
}: {
  beds: Bed[];
  selectedBedIds: number[];
  bedPickActive: boolean;
  pickLabel: string;
  pickingLabel: string;
  onBedPickActiveChange: (active: boolean) => void;
  onSelectedBedIdsChange: (bedIds: number[]) => void;
}) {
  const plasticBedIds = beds
    .filter((item) => (item.bedPresetName ?? item.name).toLowerCase().includes("plastic"))
    .map((item) => item.id);
  const bareBedIds = beds
    .filter((item) => !plasticBedIds.includes(item.id))
    .map((item) => item.id);
  const selectedBedIdSet = new Set(selectedBedIds);

  return (
    <div className="full-span stack">
      <div className="button-row">
        <button
          type="button"
          className={bedPickActive ? "primary-button" : "secondary-button"}
          onClick={() => onBedPickActiveChange(!bedPickActive)}
        >
          {bedPickActive ? pickingLabel : pickLabel}
        </button>
        <button type="button" className="secondary-button" onClick={() => onSelectedBedIdsChange(bareBedIds)}>
          All bare beds
        </button>
        <button type="button" className="secondary-button" onClick={() => onSelectedBedIdsChange(plasticBedIds)}>
          All plastic beds
        </button>
        <button type="button" className="secondary-button" onClick={() => onSelectedBedIdsChange([])}>
          Clear beds
        </button>
      </div>
      <p className="muted">{selectedBedIds.length} bed{selectedBedIds.length === 1 ? "" : "s"} selected.</p>
      {beds.length > 0 && (
        <div className="checkbox-grid">
          {beds.map((item) => (
            <label className="inline-checkbox" key={item.id}>
              <input
                type="checkbox"
                checked={selectedBedIdSet.has(item.id)}
                onChange={(event) => {
                  if (event.target.checked) {
                    onSelectedBedIdsChange([...selectedBedIds, item.id]);
                  } else {
                    onSelectedBedIdsChange(selectedBedIds.filter((bedId) => bedId !== item.id));
                  }
                }}
              />
              <span>{item.name}{item.bedPresetName ? ` (${item.bedPresetName})` : ""}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// Work-mode card for recording what actually happened to a cover-crop area.
function CoverCropWorkCard({
  zone,
  onSave
}: {
  zone: BlockZone;
  onSave: () => Promise<void>;
}) {
  const [actualSeedDate, setActualSeedDate] = useState(dateInputValue(zone.actualCoverCropSeedDate));
  const [actualTerminateDate, setActualTerminateDate] = useState(dateInputValue(zone.actualCoverCropTerminateDate));
  const [actualState, setActualState] = useState<ZoneActualState>(zone.actualState);
  const [notes, setNotes] = useState(zone.notes ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setActualSeedDate(dateInputValue(zone.actualCoverCropSeedDate));
    setActualTerminateDate(dateInputValue(zone.actualCoverCropTerminateDate));
    setActualState(zone.actualState);
    setNotes(zone.notes ?? "");
    setStatus(null);
  }, [zone]);

  async function saveCoverCropWork(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actualSeedDate && actualSeedDate > todayDateInputValue()) {
      setStatus("Actual seeded date cannot be in the future.");
      return;
    }
    if (actualTerminateDate && actualTerminateDate > todayDateInputValue()) {
      setStatus("Actual termination date cannot be in the future.");
      return;
    }

    try {
      setSaving(true);
      setStatus("Saving cover crop work...");
      await api.updateCoverCropWork(zone.id, {
        actualState,
        actualCoverCropSeedDate: actualSeedDate || null,
        actualCoverCropTerminateDate: actualTerminateDate || null,
        notes: notes.trim() || null
      });
      await onSave();
      setStatus("Cover crop work saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Cover crop work save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <h2>Cover crop work</h2>
      <p className="muted">{zone.coverCropName ?? zone.name} in {zone.blockName}</p>
      <dl className="detail-list">
        <div><dt>Planned seed</dt><dd>{formatDate(zone.plannedCoverCropSeedDate)}</dd></div>
        <div><dt>Planned terminate</dt><dd>{formatDate(zone.plannedCoverCropTerminateDate)}</dd></div>
      </dl>
      {status && <p className="muted"><strong>{status}</strong></p>}
      <form className="form-grid" onSubmit={(event) => void saveCoverCropWork(event)}>
        <label>
          <span>Actual seeded date</span>
          <input type="date" value={actualSeedDate} onChange={(event) => setActualSeedDate(event.target.value)} />
        </label>
        <label>
          <span>Actual termination date</span>
          <input type="date" value={actualTerminateDate} onChange={(event) => setActualTerminateDate(event.target.value)} />
        </label>
        <label>
          <span>Current state</span>
          <select value={actualState} onChange={(event) => setActualState(event.target.value as ZoneActualState)}>
            {zoneActualStateOptions.map((option) => <option key={option} value={option}>{formatZoneActualStateLabel(option)}</option>)}
          </select>
        </label>
        <div className="button-row">
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setActualSeedDate(todayDateInputValue());
              setActualState("cover_crop_established");
            }}
          >
            Seeded today
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setActualTerminateDate(todayDateInputValue());
              setActualState("finished");
            }}
          >
            Terminated today
          </button>
        </div>
        <label className="full-span">
          <span>Notes</span>
          <textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        <button type="submit" className="primary-button full-span" disabled={saving}>
          {saving ? "Saving..." : "Save cover crop work"}
        </button>
      </form>
    </div>
  );
}

// Simple harvest entry: harvests are logged by bed while still linking back to the parent planting.
function HarvestForm({ data, onSave }: { data: DashboardData; onSave: () => Promise<void> }) {
  const plantableBeds = data.beds.filter((bed) => bed.source !== "road");

  return (
    <div className="card">
      <h2>Log harvest by bed</h2>
      <form
        className="form-grid"
        onSubmit={(event) =>
          void handleForm(event, async (form) => {
            await api.createHarvest({
              plantingId: Number(form.get("plantingId")),
              bedId: Number(form.get("bedId")),
              harvestDate: String(form.get("harvestDate")),
              quantity: Number(form.get("quantity")),
              unit: String(form.get("unit")),
              notes: String(form.get("notes") || "")
            });
            await onSave();
          })
        }
      >
        <label>
          <span>Planting</span>
          <select name="plantingId">
            {data.plantings.map((planting) => <option key={planting.id} value={planting.id}>{planting.title}</option>)}
          </select>
        </label>
        <label>
          <span>Bed</span>
          <select name="bedId">
            {plantableBeds.map((bed) => <option key={bed.id} value={bed.id}>{bed.name}</option>)}
          </select>
        </label>
        <label><span>Date</span><input name="harvestDate" type="date" required /></label>
        <label><span>Quantity</span><input name="quantity" type="number" step="0.1" required /></label>
        <label>
          <span>Unit</span>
          <select name="unit" defaultValue="lb">
            <option value="lb">lb</option>
            <option value="kg">kg</option>
            <option value="heads">heads</option>
            <option value="bunches">bunches</option>
          </select>
        </label>
        <label className="full-span"><span>Notes</span><textarea name="notes" rows={3} defaultValue="Harvest note" /></label>
        <button className="primary-button full-span">Log harvest</button>
      </form>
    </div>
  );
}

// Global admin page. This is intentionally bare-bones: inspect users, disable
// user logins, and read submitted feedback.
// Foldout editor for reusable bed dimensions and path spacing.
function BedPresetCard({
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

// Tool for turning a block edge/line into one or many generated bed polygons.
function BedGeneratorCard({
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
  isPickingLine,
  isPickingEdge,
  tutorialActive,
  onPickEdge,
  onStartLine,
  onCancelLine,
  onInvertSideChange,
  onEntranceSideChange,
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
  bedLineSource: BedLineSource;
  bedLineMode: "straight" | "curved";
  invertSide: boolean;
  isPickingLine: boolean;
  isPickingEdge: boolean;
  tutorialActive: boolean;
  onPickEdge: () => void;
  onStartLine: (mode: "straight" | "curved") => void;
  onCancelLine: () => void;
  onInvertSideChange: (value: boolean) => void;
  onEntranceSideChange?: (blockId: number, entranceSide: "start" | "end") => void;
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
  const [fillWholeBlock, setFillWholeBlock] = useState(false);
  const [entranceSide, setEntranceSide] = useState<"start" | "end">(block.bedStartEntranceSide ?? "start");
  const [harvestRoadsEnabled, setHarvestRoadsEnabled] = useState(false);
  const [harvestRoadEveryBeds, setHarvestRoadEveryBeds] = useState("12");
  const [harvestRoadWidthBeds, setHarvestRoadWidthBeds] = useState("2");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCreatingStarterPreset, setIsCreatingStarterPreset] = useState(false);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const selectedPreset = bedPresets.find((preset) => String(preset.id) === selectedPresetId) ?? bedPresets[0];
  const tutorialBedHint = tutorialActive
    ? bedLineCoordinates.length < minPoints
      ? isPickingEdge || isPickingLine
        ? "Click two points on the map along the block edge that beds should follow."
        : "Click Pick block edge, then choose the edge on the map that beds should build from."
      : "The bed edge is ready. Click Fill remaining block to fill the block with beds."
    : null;

  useEffect(() => {
    if (!selectedPresetId && bedPresets[0]) {
      setSelectedPresetId(String(bedPresets[0].id));
    }
  }, [bedPresets, selectedPresetId]);

  useEffect(() => {
    setNamePrefix(`${block.name}-`);
    setEntranceSide(block.bedStartEntranceSide ?? "start");
  }, [block.id, block.name, block.bedStartEntranceSide]);

  function updateEntranceSide(checked: boolean) {
    const nextEntranceSide = checked ? "end" : "start";
    setEntranceSide(nextEntranceSide);
    onEntranceSideChange?.(block.id, nextEntranceSide);
  }

  useEffect(() => {
    if (!replaceExisting) {
      setStartNumber(existingBeds.length + 1);
    }
  }, [existingBeds.length, replaceExisting]);

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
    onPreviewChange(polygonIsInsideOrOnPolygon(preview, blockBoundary) ? preview : []);

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
      const message = bedLineMode === "straight" ? "Pick exactly 2 line points first." : "Pick between 3 and 12 line points first.";
      setLocalNotice(message);
      onStatusChange(message);
      return;
    }

    const roadEvery = selectedPreset?.isRoad ? null : harvestRoadsEnabled ? Number(harvestRoadEveryBeds) : null;
    const roadWidth = harvestRoadsEnabled ? Number(harvestRoadWidthBeds) : 0;
    if (!selectedPreset?.isRoad && harvestRoadsEnabled && (!roadEvery || !Number.isInteger(roadEvery) || roadEvery < 1 || !Number.isInteger(roadWidth) || roadWidth < 1)) {
      const message = "Harvest roads need a positive bed interval and road width.";
      setLocalNotice(message);
      onStatusChange(message);
      return;
    }

    const parsedCount = Number(options.count);
    const parsedStartNumber = Number(startNumber);
    if (!selectedPreset || !Number.isInteger(parsedCount) || parsedCount < 1 || !Number.isInteger(parsedStartNumber) || parsedStartNumber < 1) {
      const message = "Choose a preset, count, and start number first.";
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

      const message = result.inserted != null ? `Generated ${result.inserted} beds.` : "Beds generated.";
      setLocalNotice(message);
      onStatusChange(message);
      if (!result.isRoad && result.insertedIds?.length) {
        onTutorialBedsGenerated?.(result.insertedIds);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bed generation failed.";
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
      count: fillWholeBlock ? 1 : Number(bedCount || 1),
      fillWholeBlock
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
      setLocalNotice("Creating starter bed presets...");
      onStatusChange("Creating starter bed presets...");
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
      setLocalNotice("Starter bed presets created. Pick the block edge next.");
      onStatusChange("Starter bed presets created. Pick the block edge next.");
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
      <h2>Generate beds in block</h2>
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
            <strong>No bed preset yet:</strong> Before beds can be generated, save the bed width and path spacing to use. You can create starter presets now, then adjust them later if your farm uses different measurements.
          </div>
          {localNotice && <p className="muted"><strong>{localNotice}</strong></p>}
          <div className="button-row">
            <button
              type="button"
              className="primary-button"
              disabled={isCreatingStarterPreset}
              onClick={() => void createStarterPresets()}
            >
              {isCreatingStarterPreset ? "Creating..." : "Create default bed presets"}
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
                    {isPickingEdge ? "Stop picking edge" : "Pick block edge"}
                  </button>
                  {isPickingLine && (
                    <button type="button" className="secondary-button" onClick={onCancelLine}>
                      Cancel line
                    </button>
                  )}
                </div>
                <div className="full-span generated-bed-list">
                  {bedLineCoordinates.map((_, index) => (
                    <span key={index} className="small-chip">Line point {index + 1}</span>
                  ))}
                </div>
                <p className="muted">
                  {bedLineMode === "straight"
                    ? `Pick exactly 2 points.`
                    : `Pick between 3 and 12 points.`}
                  {" "}Current: {bedLineCoordinates.length} / {maxPoints}
                </p>
              </>
            )}
            <p className="muted">
              {bedLineSource === "selected_bed"
                ? "Selected bed guide: Make one bed will place the next bed beside the selected bed, then select the new bed so you can keep going."
                : "The shaded shape on the map previews the next bed."}
            </p>
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
            {bedLineSource !== "selected_bed" && (
              <div className="instruction-box full-span">
                <strong>Full bed generator:</strong> Count, fill, line, entrance-side, and harvest-road controls are available below.
              </div>
            )}
            {bedLineSource !== "selected_bed" && (
              <div className="full-span button-row">
                <button type="button" className="secondary-button" onClick={onPickEdge}>
                  Pick a different block edge
                </button>
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
            {!selectedPreset?.isRoad && (
              <label>
                <span>First-bed entrance side</span>
                <select
                  value={entranceSide}
                  onChange={(event) => updateEntranceSide(event.target.value === "end")}
                >
                  <option value="start">Start side of first bed</option>
                  <option value="end">Far side of first bed</option>
                </select>
              </label>
            )}
            <div className="button-row">
              <button
                type="button"
                className="secondary-button"
                disabled={bedLineCoordinates.length < minPoints || bedLineCoordinates.length > maxPoints || isGenerating}
                onClick={() => void generateBeds({ count: 1, fillWholeBlock: false })}
              >
                {isGenerating ? "Generating..." : selectedPreset?.isRoad ? "Make one road/path" : "Make one bed"}
              </button>
            </div>
            {bedLineSource !== "selected_bed" && !selectedPreset?.isRoad && (
              <label>
                <span>How many beds</span>
                <input value={bedCount} onChange={(event) => setBedCount(event.target.value)} type="number" min="1" max="100" disabled={fillWholeBlock} />
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
                    onChange={(event) => {
                      const nextValue = event.target.value === "true";
                      setReplaceExisting(nextValue);
                      setStartNumber(nextValue ? 1 : existingBeds.length + 1);
                    }}
                  >
                    <option value="false">Keep existing beds</option>
                    <option value="true">Replace beds in block</option>
                  </select>
                </label>
                <label className="inline-checkbox">
                  <input type="checkbox" checked={fillWholeBlock} onChange={(event) => setFillWholeBlock(event.target.checked)} />
                  <span>Fill whole block</span>
                </label>
              </>
            )}
            {bedLineSource !== "selected_bed" && (
              <details className="full-span foldout-panel" open>
                <summary>Advanced line controls</summary>
                <div className="button-row">
                  <button type="button" className="secondary-button" onClick={() => onStartLine("straight")}>
                    {isPickingLine && bedLineMode === "straight" ? "Picking straight line..." : "Draw straight line"}
                  </button>
                </div>
                <div className="form-grid">
                  <label className="inline-checkbox">
                    <input type="checkbox" checked={invertSide} onChange={(event) => onInvertSideChange(event.target.checked)} />
                    <span>Build off the other side of the line</span>
                  </label>
                </div>
                <p className="muted">Picking a block edge is the normal path. Draw a straight line only when you need to aim the bed direction manually.</p>
              </details>
            )}
            {bedLineSource !== "selected_bed" && (
              <details className="full-span foldout-panel">
                <summary>Harvest roads</summary>
                <label className="inline-checkbox">
                  <input type="checkbox" checked={harvestRoadsEnabled} onChange={(event) => setHarvestRoadsEnabled(event.target.checked)} />
                  <span>Leave gaps while generating beds</span>
                </label>
                <div className="form-grid">
                  <label>
                    <span>Road after every</span>
                    <input value={harvestRoadEveryBeds} onChange={(event) => setHarvestRoadEveryBeds(event.target.value)} type="number" min="1" disabled={!harvestRoadsEnabled} />
                  </label>
                  <label>
                    <span>Road width in bed slots</span>
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
                  Demo road preset: skip 2 beds every 12
                </button>
                <p className="muted">Example: road width 2 leaves the space of two beds before continuing.</p>
              </details>
            )}
            {bedLineSource !== "selected_bed" && (
              <div className="full-span generated-bed-list">
                {existingBeds.map((bed) => (
                  <span key={bed.id} className="small-chip">{bed.name}</span>
                ))}
              </div>
            )}
            {bedLineSource !== "selected_bed" && (
              <div className="button-row full-span">
                <button
                  type="submit"
                  className="primary-button"
                  disabled={bedLineCoordinates.length < minPoints || bedLineCoordinates.length > maxPoints || isGenerating}
                >
                  {isGenerating ? "Generating..." : fillWholeBlock ? "Fill block" : "Generate count"}
                </button>
                <button
                  type="button"
                  className={`secondary-button${tutorialActive && bedLineCoordinates.length >= minPoints ? " tutorial-target" : ""}`}
                  disabled={bedLineCoordinates.length < minPoints || bedLineCoordinates.length > maxPoints || isGenerating}
                  onClick={() => void generateBeds({ count: 1, fillWholeBlock: true })}
                >
                  Fill remaining block
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

export default App;
