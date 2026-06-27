/**
 * Main React application for the Loam Ledger prototype.
 *
 * This file currently owns screen routing, map interaction, planning forms,
 * task-flow editing, settings, and many small UI panels. It is
 * large because the prototype has been built quickly in one place. Good future
 * extraction targets are the map sidebar cards, planting forms, task-flow
 * editor, settings panels, and reusable date/unit controls.
 */
import { CSSProperties, FormEvent, Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AttributionControl, Circle, CircleMarker, MapContainer, Marker, Polygon, Polyline, Tooltip } from "react-leaflet";
import { normalizeFeedbackReports, normalizeUndoState, normalizeUserMessages } from "./admin-panel-data";
import { api } from "./api";
import { buildBedAllocationPreview, estimatePlantCountFromPlan } from "./bed-allocation";
import { AdminPanel } from "./components/AdminPanel";
import { BedGeneratorCard } from "./components/BedGeneratorCard";
import { BedPresetCard } from "./components/BedPresetCard";
import { CoverCropWorkCard } from "./components/CoverCropWorkCard";
import { defaultEntranceTractorProfile, GarageCard } from "./components/GarageCard";
import { HarvestForm } from "./components/HarvestForm";
import { InboxPanel } from "./components/InboxPanel";
import { LoginScreen } from "./components/LoginScreen";
import {
  FitToFarm,
  FocusSelection,
  FocusUserLocation,
  MapDrawingEvents,
  MapLineDragEvents,
  MapZoomTracker,
  mapViewStorageKey,
  PersistMapView,
  readStoredMapView,
  ResponsiveBasemap,
  TutorialAutoScroll
} from "./components/MapSupport";
import { MobileListLimiter } from "./components/MobileListLimiter";
import { PlantingForm, PlantingMapPreviewItem, PlantingTutorialDraft } from "./components/PlantingForms";
import { SeedBankCard } from "./components/SeedBankCard";
import { SpreadsheetImportCard } from "./components/SpreadsheetImportCard";
import { TaskFlowEditorCard } from "./components/TaskFlowEditorCard";
import { TaskIconMark } from "./components/TaskIconMark";
import { AccountPasswordCard, TeamAccountsCard } from "./components/TeamAccountsCard";
import {
  ActiveTutorialOverlay,
  getTutorialExtraHighlightTarget,
  publishTutorialHighlightState,
  subscribeTutorialHighlightRequests,
  TutorialsCard
} from "./components/TutorialsCard";
import { WorkBedPicker } from "./components/WorkBedPicker";
import { formatDate } from "./display-utils";
import { handleForm } from "./form-utils";
import {
  bedParallelSplitLineThroughPoint,
  bedParallelSplitLinesForBlock,
  bedRunDistancePx,
  bedSectionBoundary,
  bedSerpentineReversesFromEnd,
  bedSharedVehicleTiming,
  bedTravelPath,
  boundaryEdgeLines,
  buildNextBedPreview,
  clipLineToPolygon,
  CoordinateDraft,
  firstBedEntrancePose,
  firstBedSideReferencePoint,
  longestBoundaryEdgeLine,
  orientLineLeftAwayFromPoint,
  orientLineLeftTowardPoint,
  plantingPlacementCount,
  pointIsInsideOrOnPolygon,
  pointToSegmentDistance,
  polygonCenter,
  polygonEdgesCrossBoundary,
  polygonIsInsideOrOnPolygon,
  polygonPositions,
  selectedBedGuideLine,
  sideOfLine,
  sortedPlantableBlockBeds,
  splitAreaPreviewForBlock,
  splitGuideLineForBlock
} from "./map-geometry";
import { geoJsonPolygonToLatLngs, midpoint, polygonAreaSqM, taskMapIcon, vertexIcon } from "./map-utils";
import {
  addDaysToDateString,
  bedStyle,
  blockStyle,
  colorizeBlockPlacementRows,
  defaultZoneName,
  DetailTerm,
  daysBetweenDateStrings,
  fieldReviewSeverity,
  FieldLabel,
  fieldsForImportIssue,
  fieldStyle,
  formatPlannedUseLabel,
  formatTaskAnchorLabel,
  formatTaskTypeLabel,
  formatZoneActualStateLabel,
  isPlantingInGroundOnDate,
  issueListFromNotes,
  latestDateIndexOnOrBefore,
  mapObjectLabel,
  mapSaveErrorMessage,
  placementOverlayStyle,
  plantingCropVarietyLabel,
  plantingFieldStillNeedsReview,
  plantingGroundEndDate,
  plantingGroundStartDate,
  plantingLabelIcon,
  plantingMapColorForOrder,
  PlantingMapColor,
  plantingOverlayStyleForColor,
  plantingPlanYear,
  PlantingDateInput,
  PlantingPlanningInput,
  plantingReviewInfo,
  PlantingReviewBadge,
  PlantingReviewInfo,
  PlantingReviewMarker,
  PlantingReviewSeverity,
  plannedOverlayStyle,
  summarizeTitles,
  taskColor,
  taskIconColor,
  zoneStyle
} from "./planting-display";
import { getCachedSpriteSheetUrl, preloadSpriteSheets, spriteSheetRequestForTask, subscribeSpriteSheetCache } from "./sprite-sheet-cache";
import { Bed, Block, BlockZone, DashboardData, DashboardResourceName, FarmEvent, FeedbackReport, Field, Placement, PlannedUse, Planting, SeedItem, SessionInfo, Task, TaskFlowEdge, TaskFlowNode, TaskFlowTemplate, TractorProfile, UndoSnapshotSummary, UserMessage, ZoneActualState } from "./types";
import {
  addDaysToDate,
  dateDiffDays,
  dateInputValue,
  defaultSpacingExample,
  defaultTaskRecordDate,
  DistanceUnit,
  formatDateForInputHint,
  formatDecimalInputValue,
  formatDisplayArea,
  formatLength,
  formatLengthInputValue,
  formatSpacing,
  formatSpacingPair,
  formatTaskWeekTitle,
  formatWeekRange,
  isCurrentTaskCategory,
  isDateInWeek,
  isPlantingActionTask,
  parseLengthInputValue,
  parseSpacingPairForUnit,
  spacingInputToMeters,
  spacingMetersToInput,
  spacingUnitLabel,
  startOfWeekDate,
  taskNeedsRecordForm,
  todayDateInputValue,
  toNumericValue
} from "./unit-utils";
import { useUsageTracking } from "./usage-tracking";

type View = "map" | "plan" | "planting" | "tasks" | "flows" | "seed-bank" | "record" | "harvests" | "inbox" | "settings" | "admin";
type TutorialKind = "first_account" | "full_workflow";

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
type ThemeMode = "light" | "dark";
type MobileMapPanel = "gps" | "week" | "layers" | null;
type ZoneDraftMethod = "whole_block" | "split_line" | "polygon" | null;
type MapSelection =
  | { type: "field"; id: number }
  | { type: "block"; id: number }
  | { type: "zone"; id: number }
  | { type: "bed"; id: number }
  | null;

// Draft coordinates are temporary points drawn before the user saves geometry.
type MapTaskMarker = {
  key: string;
  task: Task;
  bed: Bed | null;
  center: CoordinateDraft;
  bearing: number;
  runDistancePx: number;
  runDurationSec: number;
  animationDelaySec: number;
  oneWayRun: boolean;
  animated: boolean;
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

const dashboardRefreshResources = {
  map: [
    "fields", "blocks", "blockZones", "beds", "bedPresets", "coverCropNames",
    "placements", "placementGaps", "placementOverflows", "events", "tasks"
  ],
  plantings: [
    "plantings", "placements", "placementGaps", "placementOverflows",
    "events", "tasks", "harvests", "beds"
  ],
  tasks: ["tasks", "events", "plantings", "placements", "harvests", "beds"],
  taskFlows: ["taskFlowTemplates", "taskFlowNodes", "taskFlowEdges", "tasks"],
  seeds: ["seedItems", "crops", "varieties"],
  garage: ["tractorProfiles", "taskFlowTemplates", "taskFlowNodes", "taskFlowEdges", "tasks"]
} satisfies Record<string, DashboardResourceName[]>;

// Local storage keeps lightweight UI preferences on this browser only.
const SETTINGS_STORAGE_KEY = "loam-ledger-settings";
const MAP_LAYER_STORAGE_PREFIX = "loam-ledger-map-layers";
const MOBILE_MEDIA_QUERY = "(max-width: 760px)";
const PROTOTYPE_WARNING_VERSION = "v2";
const PROTOTYPE_WARNING_STORAGE_PREFIX = "loam-ledger-prototype-warning";
const TUTORIAL_DISMISSED_STORAGE_PREFIX = "loam-ledger-tutorial-dismissed";

// Default center is only a starting point; saved farm geometry can fit/zoom the map later.
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

function mapLayerStorageKey(userId: number, farmId: number | null | undefined) {
  return farmId == null
    ? `${MAP_LAYER_STORAGE_PREFIX}:user-${userId}`
    : `${MAP_LAYER_STORAGE_PREFIX}:user-${userId}:farm-${farmId}`;
}

function defaultMapLayerSettings(): MapLayerSettings {
  return { planned: true, actual: true, tasks: true, otherFarms: true };
}

function readMapLayerSettings(userId: number | null | undefined, farmId: number | null | undefined) {
  if (typeof window === "undefined" || userId == null) {
    return defaultMapLayerSettings();
  }

  const raw = window.localStorage.getItem(mapLayerStorageKey(userId, farmId));
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
function App() {
  // Most state lives here for prototype speed. Long term, move each major panel
  // into its own component with only the state it needs.
  const [data, setData] = useState<DashboardData>(emptyDashboard);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [feedbackReports, setFeedbackReports] = useState<FeedbackReport[]>([]);
  const [messages, setMessages] = useState<UserMessage[]>([]);
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

  const [mapWorkflowMode, setMapWorkflowMode] = useState<MapWorkflowMode>("planning");
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
  const currentMapViewStorageKey = session?.authenticated
    ? mapViewStorageKey(session.user.id, session.user.farmId)
    : mapViewStorageKey(null, null);
  const [initialView] = useState(() => readStoredMapView(currentMapViewStorageKey));
  const [mapZoom, setMapZoom] = useState(initialView.zoom);
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>(() => readSettings().distanceUnit);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readSettings().themeMode);
  const [usageTrackingEnabled, setUsageTrackingEnabled] = useState(false);
  const [savingUsagePreference, setSavingUsagePreference] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(() => (
    typeof window !== "undefined" ? window.matchMedia(MOBILE_MEDIA_QUERY).matches : false
  ));
  const initialMapLayerSettings = readMapLayerSettings(
    session?.authenticated ? session.user.id : null,
    session?.authenticated ? session.user.farmId : null
  );
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
  const [mobileToolbarOpen, setMobileToolbarOpen] = useState(false);
  const [mobileMapPanel, setMobileMapPanel] = useState<MobileMapPanel>(null);

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
  const [tutorialKind, setTutorialKind] = useState<TutorialKind>("first_account");
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
    enabled: isAuthenticated && usageTrackingEnabled,
    page: view
  });

  const updateTractorProfiles = useCallback(async (tractorProfiles: TractorProfile[]) => {
    setData((current) => ({ ...current, tractorProfiles }));
    await loadDashboardResources(dashboardRefreshResources.garage);
  }, [canPlan, isAdmin]);

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
      window.localStorage.setItem(mapLayerStorageKey(session.user.id, session.user.farmId), JSON.stringify(next));
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

    const stored = readMapLayerSettings(session.user.id, session.user.farmId);
    setShowPlannedPlantingsLayer(stored.planned);
    setShowActualPlacementsLayer(stored.actual);
    setShowTaskLayer(stored.tasks);
    setShowOtherFarmMaps(stored.otherFarms);
  }, [
    session?.authenticated,
    session?.authenticated ? session.user.id : null,
    session?.authenticated ? session.user.farmId : null
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      setIsMobileViewport(event.matches);
      if (!event.matches) {
        setMobileToolbarOpen(false);
        setMobileMapPanel(null);
      }
    };

    setIsMobileViewport(mediaQuery.matches);
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!isMobileViewport || !mobileToolbarOpen || typeof document === "undefined") {
      return;
    }
    const scrollY = window.scrollY;
    const previousBodyStyles = {
      overflow: document.body.style.overflow,
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width
    };
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileToolbarOpen(false);
      }
    };
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    document.documentElement.style.overflow = "hidden";
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousBodyStyles.overflow;
      document.body.style.position = previousBodyStyles.position;
      document.body.style.top = previousBodyStyles.top;
      document.body.style.width = previousBodyStyles.width;
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.removeEventListener("keydown", closeOnEscape);
      window.scrollTo(0, scrollY);
    };
  }, [isMobileViewport, mobileToolbarOpen]);

  useEffect(() => {
    if (!session?.authenticated || typeof window === "undefined") {
      setPrototypeWarningOpen(false);
      setTutorialOpen(false);
      return;
    }

    setPrototypeWarningOpen(
      window.localStorage.getItem(prototypeWarningStorageKey(session.user.id)) !== PROTOTYPE_WARNING_VERSION
    );
    setTutorialOpen(false);
  }, [session]);

  useEffect(() => subscribeTutorialHighlightRequests((state) => {
    if (!state.active) {
      setTutorialOpen(false);
      setTutorialStatus(null);
      return;
    }
    setTutorialKind(state.workflowId);
    setTutorialStepIndex(state.legacyStepIndex);
    setTutorialStatus(null);
    setTutorialOpen(true);
  }), []);

  useEffect(() => {
    publishTutorialHighlightState({
      active: tutorialOpen,
      workflowId: tutorialKind,
      legacyStepIndex: tutorialStepIndex,
      extraHighlightTarget: tutorialOpen ? getTutorialExtraHighlightTarget(tutorialKind, tutorialStepIndex) : null
    });
  }, [tutorialKind, tutorialOpen, tutorialStepIndex]);

  async function load(
    _includeAccounts = canPlan,
    includeFeedback = isAdmin,
    options?: {
      allowAuthReset?: boolean;
      authBootstrap?: boolean;
      dashboardResources?: DashboardResourceName[];
    }
  ) {
    const allowAuthReset = options?.allowAuthReset ?? true;
    const authBootstrap = options?.authBootstrap ?? false;
    const dashboardResources = options?.dashboardResources;
    setLoading(true);
    setError(null);
    try {
      const [next, nextFeedbackReports, nextMessages, nextUndoSnapshots] = await Promise.all([
        api.getDashboard(dashboardResources),
        includeFeedback ? api.getFeedbackReports().catch(() => []) : Promise.resolve([]),
        api.getMessages().catch(() => []),
        api.getUndoSnapshots().catch(() => ({ undo: [], redo: [] }))
      ]);
      setData((current) => dashboardResources
        ? { ...current, ...next }
        : next as DashboardData
      );
      const normalizedUndoState = normalizeUndoState(nextUndoSnapshots);
      setFeedbackReports(normalizeFeedbackReports(nextFeedbackReports));
      setMessages(normalizeUserMessages(nextMessages));
      setUndoSnapshots(normalizedUndoState.undo);
      setRedoSnapshots(normalizedUndoState.redo);
      if (selectedPlantingId == null && next.plantings?.[0]) {
        setSelectedPlantingId(next.plantings[0].id);
      }
      if (selectedTaskId == null && next.tasks?.[0]) {
        setSelectedTaskId(next.tasks.find((task) => task.status !== "done")?.id ?? next.tasks[0].id);
      }
      if (selectedFlowId == null && next.taskFlowTemplates?.[0]) {
        setSelectedFlowId(next.taskFlowTemplates[0].id);
      }
      if (selection == null && next.fields?.[0]) {
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

  async function loadDashboardResources(resources: DashboardResourceName[]) {
    await load(canPlan, isAdmin, { dashboardResources: resources });
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
    if (!isAuthenticated) {
      setUsageTrackingEnabled(false);
      return;
    }
    let cancelled = false;
    void api.getUsagePreference()
      .then(({ enabled }) => {
        if (!cancelled) setUsageTrackingEnabled(enabled);
      })
      .catch(() => {
        if (!cancelled) setUsageTrackingEnabled(false);
      });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  useEffect(() => {
    if (!canPlan && (view === "flows" || view === "seed-bank")) {
      setView("tasks");
    }
  }, [canPlan, view]);

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
      if (task.taskType === "bed_making") {
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
        const taskPlanting = task.plantingId != null ? plantingsByTaskPlantingId.get(task.plantingId) ?? null : null;
        const plantingPlacements = task.plantingId == null
          ? []
          : data.placements
              .filter((placement) => placement.plantingId === task.plantingId)
              .sort((left, right) => (
                (left.placedOn == null ? 1 : 0) - (right.placedOn == null ? 1 : 0)
                || (left.placementOrder ?? left.id) - (right.placementOrder ?? right.id)
              ));
        const markerTarget = (() => {
          if (taskPlanting) {
            const firstPlacement = plantingPlacements[0] ?? null;
            if (firstPlacement) {
              return { bed: bedsById.get(firstPlacement.bedId) ?? null, block: null, placement: firstPlacement };
            }
            if (taskPlanting.intendedBedId != null) {
              return { bed: bedsById.get(taskPlanting.intendedBedId) ?? null, block: null, placement: null };
            }
            if (taskPlanting.intendedBlockId != null) {
              return { bed: null, block: blocksById.get(taskPlanting.intendedBlockId) ?? null, placement: null };
            }
          }

          return { bed: bedsById.get(task.bedId ?? -1) ?? null, block: null, placement: null };
        })();

        const { bed, block: markerBlock, placement } = markerTarget;
        if (!bed) {
          const center = polygonCenter(geoJsonPolygonToLatLngs(markerBlock?.boundary ?? null));
          if (!center) {
            return null;
          }

          return {
            key: `task-marker-${task.id}`,
            task,
            bed: null,
            center,
            bearing: 0,
            runDistancePx: 38,
            runDurationSec: 9.5,
            animationDelaySec: 0,
            oneWayRun: false,
            animated: false
          };
        }

        const block = blocksById.get(bed.blockId) ?? null;
        const reverseFromEnd = bedSerpentineReversesFromEnd(bed, block, blockBedsByBlockId.get(bed.blockId) ?? []);
        const sectionBoundary = placement?.boundary ?? (placement?.planSource === "auto_block_plan"
          ? bedSectionBoundary(bed, Number(placement.startLengthM || 0), Number(placement.bedLengthUsedM || 0), reverseFromEnd)
          : null);
        const travelPath = bedTravelPath(bed);
        const center = polygonCenter(geoJsonPolygonToLatLngs(sectionBoundary ?? bed.boundary));
        if (!center) {
          return null;
        }

        return {
          key: `task-marker-${task.id}`,
          task,
          bed,
          center,
          bearing: reverseFromEnd ? travelPath.bearing + 180 : travelPath.bearing,
          runDistancePx: 38,
          runDurationSec: 9.5,
          animationDelaySec: 0,
          oneWayRun: false,
          animated: false
        };
      })
      .filter((item): item is MapTaskMarker => item != null);

    const markersByBedId = new Map<number, MapTaskMarker[]>();
    for (const marker of markers) {
      if (!marker.bed) {
        continue;
      }
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
    setMapNotice(`Selected ${task.title}. Use Record Work Done, or open the planting detail.`);
  }

  async function quickCompleteTask(task: Task) {
    if (taskNeedsRecordForm(task.taskType)) {
      selectTask(task);
      setMapNotice("This task changes crop state. Use the Record Work Done panel so the needed details are captured.");
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
      await loadDashboardResources(dashboardRefreshResources.tasks);
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
        const leftIsBedMaking = left.taskType === "bed_making";
        const rightIsBedMaking = right.taskType === "bed_making";
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
  const bedGeneratorCardVisible = Boolean(
    mapWorkflowMode === "planning"
    && selectedBlockContext
    && canEditSelectedBlockContext
    && (mapMode === "bed_tools" || mapMode === "pick_bed_edge" || mapMode === "draw_bed_line")
  );
  const placementPlanEntranceMarkerActive = Boolean(
    bedGeneratorCardVisible
    && selectedBlockContext
    && selectedBlockPlantableBeds.length > 0
    && mapPlantingBeds.length === 0
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
  const showWeeklyTaskMarkers = showTaskLayer && placementPlanEntranceMarker == null;
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
    const targetBlockId = targetBed?.blockId ?? planting.intendedBlockId ?? null;
    setMapPlantingBedIds([]);
    setSelectedPlantingId(planting.id);

    const task = findSuggestedTaskForPlanting(planting, targetBed);
    setSelectedTaskId(task?.id ?? null);

    if (targetBlockId != null) {
      setSelection({ type: "block", id: targetBlockId });
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

  function selectBlockForBedOnMap(bed: Bed) {
    selectMapObject({ type: "block", id: bed.blockId });
    setMapNotice(`${bed.blockName} selected.`);
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
      setMapNotice(`Work bed selection updated in ${bed.blockName}.`);
      return;
    }

    setMapPlantingBedIds([]);
    if (mapWorkflowMode === "field_work") {
      const planting = primaryPlantingForBed(bed);
      if (planting) {
        selectPlantingOnMap(planting, bed);
        return;
      }

      selectBlockForBedOnMap(bed);
      return;
    }
    setSelection({ type: "bed", id: bed.id });
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
        setFeedbackReports(normalizeFeedbackReports(await api.getFeedbackReports().catch(() => feedbackReports)));
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
      await loadDashboardResources(dashboardRefreshResources.plantings);
      setView("plan");
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
      const deletedIds: number[] = [];
      const failedDeletes: string[] = [];
      for (const planting of selectedPlantings) {
        try {
          await api.deletePlanting(planting.id);
          deletedIds.push(planting.id);
        } catch (error) {
          failedDeletes.push(`${planting.title}: ${error instanceof Error ? error.message : "Delete failed"}`);
        }
      }
      const deletedIdSet = new Set(deletedIds);
      setSelectedPlanPlantingIds((current) => current.filter((id) => !deletedIdSet.has(id)));
      const remaining = data.plantings.filter((item) => !deletedIdSet.has(item.id));
      setSelectedPlantingId(remaining[0]?.id ?? null);
      await loadDashboardResources(dashboardRefreshResources.plantings);
      setView("plan");
      if (failedDeletes.length > 0) {
        setMapNotice(`${deletedIds.length} planting${deletedIds.length === 1 ? "" : "s"} deleted. ${failedDeletes.length} failed: ${failedDeletes.slice(0, 3).join("; ")}${failedDeletes.length > 3 ? "..." : ""}`);
      } else {
        setMapNotice("Selected plantings deleted.");
      }
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
      setFlowEditorKey((current) => current + 1);
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
      setFlowEditorKey((current) => current + 1);
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
      await loadDashboardResources(dashboardRefreshResources.taskFlows);
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
      await loadDashboardResources(dashboardRefreshResources.taskFlows);
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
    if (tutorialOpen && (
      (tutorialKind === "first_account" && tutorialStepIndex === 0)
      || (tutorialKind === "full_workflow" && tutorialStepIndex === 1)
    )) {
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
    if (tutorialOpen && (
      (tutorialKind === "first_account" && tutorialStepIndex === 1)
      || (tutorialKind === "full_workflow" && tutorialStepIndex === 2)
    )) {
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
    setMapNotice(`Choose how to create the area inside ${selectedBlockContext.name}. Planned use is optional.`);
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
    if (tutorialOpen && (
      (tutorialKind === "first_account" && tutorialStepIndex === 2)
      || (tutorialKind === "full_workflow" && tutorialStepIndex === 3)
    )) {
      setTutorialStatus("Use the highlighted bed tools controls. Choose the begining of first bed, then fill the block.");
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
    setMapNotice("Choose a bed preset, then choose the begining of first bed.");
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
        setMapNotice("No farm record found. Check that the dashboard finished loading, then check migrations and schema state before reseeding.");
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

      await loadDashboardResources(dashboardRefreshResources.map);
      resetMapDrafts();
      if (response?.id != null) {
        setSelection({
          type: savedMapMode === "draw_field" ? "field" : savedMapMode === "draw_block" ? "block" : "zone",
          id: response.id
        });
      }
      if (tutorialOpen && savedMapMode === "draw_field" && (
        (tutorialKind === "first_account" && tutorialStepIndex === 0)
        || (tutorialKind === "full_workflow" && tutorialStepIndex === 1)
      )) {
        setTutorialStepIndex(tutorialKind === "first_account" ? 1 : 2);
        setTutorialStatus("Field saved. Now select that field if it is not selected, then use the highlighted Draw block button.");
      } else if (tutorialOpen && savedMapMode === "draw_block" && (
        (tutorialKind === "first_account" && tutorialStepIndex === 1)
        || (tutorialKind === "full_workflow" && tutorialStepIndex === 2)
      )) {
        setTutorialStepIndex(tutorialKind === "first_account" ? 2 : 3);
        setTutorialStatus("Block saved. Now use the highlighted Make beds button.");
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

      await loadDashboardResources(dashboardRefreshResources.map);
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
      await loadDashboardResources(dashboardRefreshResources.map);
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
    setFeedbackReports([]);
    setMessages([]);
    recentActivityRef.current = [];
    setMapNotice(null);
    setError(null);
    setLoading(false);
    setPrototypeWarningOpen(false);
    setTutorialOpen(false);
    setTutorialKind("first_account");
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
    if (tutorialKind === "first_account" && session?.authenticated && typeof window !== "undefined") {
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
      setTutorialStepIndex(tutorialKind === "full_workflow" ? 3 : 2);
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
                  { nodeKey: "transplant", taskType: "transplant", label: "Transplant", anchor: "after:seed", offsetDays: 0, iconColor: taskIconColor("transplant"), iconSecondaryColor: "#f4c430", tractorModel: null, tractorProfileId: null, x: 0.28, y: 0.52, notes: "Move plants into the selected bed." },
                          { nodeKey: "cultivation_1", taskType: "cultivation", label: "First cultivation", anchor: "after:transplant", offsetDays: 0, iconColor: taskIconColor("cultivation"), iconSecondaryColor: "#f4c430", tractorModel: "canopy", tractorProfileId: null, x: 0.46, y: 0.32, notes: "First cultivation after transplanting." },
                          { nodeKey: "cultivation_2", taskType: "cultivation", label: "Second cultivation", anchor: "after:cultivation_1", offsetDays: 0, iconColor: taskIconColor("cultivation"), iconSecondaryColor: "#f4c430", tractorModel: "canopy", tractorProfileId: null, x: 0.62, y: 0.52, notes: "This tutorial dates this task into the current week." },
                          { nodeKey: "cultivation_3", taskType: "cultivation", label: "Third cultivation", anchor: "after:cultivation_2", offsetDays: 0, iconColor: taskIconColor("cultivation"), iconSecondaryColor: "#f4c430", tractorModel: "canopy", tractorProfileId: null, x: 0.78, y: 0.32, notes: "Final cultivation pass before canopy closes." },
                          { nodeKey: "cleanup", taskType: "cleanup", label: "Cleanup", anchor: "after:cultivation_3", offsetDays: 0, iconColor: taskIconColor("cleanup"), iconSecondaryColor: "#f4c430", tractorModel: "open", tractorProfileId: null, x: 0.9, y: 0.52, notes: "Cleanup after the crop window." }
                ];
        const result = await api.createTaskFlow({
          farmId: data.farm.id,
          cropId: cabbageCropId,
          name: "Cabbage tutorial flow",
                  notes: "Tutorial flow: Seed, Transplant, three cultivation steps, and Cleanup. Add another cleanup task during the tutorial.",
          isDefault: true,
          nodes,
          edges: [
            { fromNodeKey: "seed", toNodeKey: "transplant", delayDays: 28 },
            { fromNodeKey: "transplant", toNodeKey: "cultivation_1", delayDays: 7 },
            { fromNodeKey: "cultivation_1", toNodeKey: "cultivation_2", delayDays: 7 },
            { fromNodeKey: "cultivation_2", toNodeKey: "cultivation_3", delayDays: 7 },
                    { fromNodeKey: "cultivation_3", toNodeKey: "cleanup", delayDays: 49 }
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
        spacingInRow: distanceUnit === "ft" ? "12" : "30",
        spacingBetweenRows: distanceUnit === "ft" ? "12" : "30",
        rowsPerBed: "3",
        notes: `Tutorial sample. Dates put second cultivation in the week of ${formatWeekRange(tutorialWeekStart)}.`
      });
      setTaskListWeekStart(tutorialWeekStart);
      setSelectedMapWeekStart(tutorialWeekStart);
      setTutorialStepIndex(tutorialKind === "full_workflow" ? 5 : 3);
      setTutorialStatus("Cabbage sample loaded in the map-side New planting form. Enter plant count and create the planting.");
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
      return false;
    }
    openTaskRecordFromMap(task);
    setTutorialStatus("The past task is open on the map in Work mode. Record it using the scheduled date shown.");
    return true;
  }

  async function handleTaskRecordSave() {
    const completedTaskId = selectedTaskId;
    await loadDashboardResources(dashboardRefreshResources.tasks);
    if (tutorialOpen && tutorialKind === "full_workflow" && tutorialStepIndex === 8) {
      setTutorialStepIndex(9);
      setTutorialStatus("Work recorded. Check the Tasks-this-week card for Done this week, then open the planting detail to confirm history.");
      return;
    }

    if (tutorialOpen && tutorialKind === "first_account" && tutorialStepIndex === 5) {
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
        highlightSubmit={(tutorialKind === "first_account" && activeTutorialStep === 5) || (tutorialKind === "full_workflow" && activeTutorialStep === 8)}
        onSave={handleTaskRecordSave}
      />
    );
  }

  function startTutorialFromBeginning() {
    setTutorialKind("first_account");
    setTutorialStatus(null);
    setTutorialStepIndex(0);
    setTutorialFlowId(null);
    setTutorialOpen(true);
  }

  function startFullWorkflowTutorial() {
    setTutorialKind("full_workflow");
    setTutorialStatus("Full workflow bug-check tutorial started. Go to the highlighted Farm Map button.");
    setTutorialStepIndex(0);
    setTutorialPlantingDraft(null);
    setTutorialFlowId(null);
    setTutorialOpen(true);
  }

  if (sessionLoading) {
    return <div className={`auth-shell theme-${themeMode}`}><div className="card auth-card"><h2>Loading...</h2><p className="muted">Checking your Loam Ledger session.</p></div></div>;
  }

  if (!session?.authenticated) {
    return <LoginScreen error={error} onLogin={handleLogin} onRegister={handleRegister} themeMode={themeMode} />;
  }

  const unreadMessageCount = messages.filter((message) => !message.readAt).length;
  const viewLabels = new Map<View, string>([
    ["map", "Farm Map"],
    ["plan", "Annual Crop Plan"],
    ["planting", "Planting Detail"],
    ["tasks", "Task List"],
    ["flows", "Task Flows"],
    ["seed-bank", "Seed bank"],
    ["record", "Record Work"],
    ["harvests", "Harvest Log"],
    ["inbox", "Inbox"],
    ["settings", "Settings"],
    ["admin", "Admin"]
  ]);
  const mainToolbarNavItems: Array<[View, string]> = [
    ["map", "Map"],
    ["tasks", "Tasks"],
    ...(canPlan ? [
      ["plan", "Annual Crop Plan"],
      ["flows", "Task Flows"],
      ["seed-bank", "Seed bank"]
    ] as Array<[View, string]> : [])
  ];
  const utilityToolbarNavItems: Array<[View, string]> = [
    ["inbox", unreadMessageCount > 0 ? `Inbox (${unreadMessageCount})` : "Inbox"],
    ["settings", "Settings"],
    ...(isAdmin ? [["admin", "Admin"]] as Array<[View, string]> : [])
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
              ? "Seed bank"
              : view === "record"
                ? "Record Work"
                : view === "harvests"
                  ? "Harvest Log / Summary"
                  : view === "inbox"
                    ? "Inbox"
                    : view === "settings"
                      ? "Settings"
                      : "Admin Control Panel";

  const firstAccountTutorialSteps = [
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
      body: "Select the Block, choose or save a bed preset, choose the begining of first bed, then fill the block with beds.",
      clickTarget: "Click your Block on the map. Then click the highlighted Generate beds button. Inside bed tools, use the highlighted Begining of first bed and Use full block controls."
    },
    {
      title: "Plan cabbage",
      body: "Create the sample cabbage planting from the map. The dates are filled so the second cultivation is due this week. In the map-side New planting form, enter the plant count, then create the planting.",
      clickTarget: "Use the New planting form beside the map. Type the plant count, then click the highlighted Create planting button."
    },
    {
      title: "Edit the task flow",
      body: "Open the cabbage flow. It starts with Seed, Transplant, three cultivation steps, and Cleanup. Add another Cleanup task and link it after Cleanup.",
      clickTarget: "In the flow editor, click the highlighted Add node button. Set Task type to cleanup, then use Link on Cleanup to connect it to the new Cleanup task."
    },
    {
      title: "Record past work",
      body: "After the planting is created, come back to the map in Work mode and record the Seed, Transplant, and first cultivation as already done. The Date is set to each task's scheduled date. Leave the current-week second cultivation open so it appears in this week's tasks.",
      clickTarget: "Use the Record Work Done panel beside the map. Check that Date matches the scheduled date shown in the tutorial bubble, then click the highlighted Record task button. Repeat for the past tasks only."
    },
    {
      title: "Find spreadsheet import",
      body: "The spreadsheet uploader is on the Annual Crop Plan page. You do not need to import anything during this tutorial; this step just shows where it is for later.",
      clickTarget: "Click the highlighted Annual Crop Plan navigation if needed, then look for the highlighted Import crop plan spreadsheet panel."
    }
  ];
  const fullWorkflowTutorialSteps = [
    {
      title: "Open the map",
      body: "This tutorial is a bug-check path for the full farm workflow. Start by opening the Farm Map in Planning mode.",
      clickTarget: "Click the highlighted Farm Map button, then use Planning mode if needed."
    },
    {
      title: "Draw a field",
      body: "Draw a simple field around the test area. This checks the basic map drawing and save workflow.",
      clickTarget: "Click Draw field, click around the field edge, enter a name, and Save."
    },
    {
      title: "Draw a block",
      body: "Draw a block inside the field. The block is the area that will receive beds.",
      clickTarget: "Select the field, click Draw block, draw the bed area, enter a name, and Save."
    },
    {
      title: "Make beds",
      body: "Generate beds in the block. This checks bed tools, bed presets, and the first-bed entrance setting.",
      clickTarget: "Select the block, click Make beds, choose the begining of first bed, then fill the block."
    },
    {
      title: "Check entrance movement",
      body: "Before creating the crop sample, watch the first-bed entrance vehicle. It should drive into the first bed, reset, and drive in again without turning around.",
      clickTarget: "Watch the highlighted map preview. If it looks right, click Next to load the tutorial seed, task flow, and planting draft."
    },
    {
      title: "Create planting",
      body: "The tutorial sample creates or reuses a cabbage seed record and task flow, then loads a planting draft. Create the planting so planned work exists.",
      clickTarget: "In the New planting form, enter a plant count, confirm the seed and spacing look reasonable, then click Create planting."
    },
    {
      title: "Review task flow",
      body: "Open the tutorial task flow and confirm it uses current categories, seeding-date scheduling, and the expected sequence of work.",
      clickTarget: "Click the highlighted Cabbage tutorial flow if needed, review the nodes, then click Next."
    },
    {
      title: "Find planned work on the map",
      body: "Planned work should belong to the planting. The bed gives the vehicle its map path. Turn on the task layer and confirm the marker appears.",
      clickTarget: "Use Work mode on the map, turn on Tasks due, and look for the tutorial task marker. Then click Next to open a task record."
    },
    {
      title: "Record work done",
      body: "Record one scheduled tutorial task. Completed work should be tied to the actual date and map location, while also updating the task and planting.",
      clickTarget: "Use Record Work Done. Check the date and location fields, fill any highlighted required fields, then click Record task."
    },
    {
      title: "Confirm history",
      body: "After recording, the task should stay visible under Done this week. The planting or map history should also show the work record.",
      clickTarget: "Check Done this week on the map task card, then open Planting Detail if you want to inspect the history. Click Next when done."
    },
    {
      title: "Export backup",
      body: "Finish the bug-check path by finding the spreadsheet backup/export area. Export is the safety check before beta use.",
      clickTarget: "Click Annual Crop Plan and find the spreadsheet export/download area."
    }
  ];
  const tutorialSteps = tutorialKind === "full_workflow" ? fullWorkflowTutorialSteps : firstAccountTutorialSteps;
  const currentTutorialStepIndex = Math.min(tutorialStepIndex, tutorialSteps.length - 1);
  const currentTutorialStep = tutorialSteps[currentTutorialStepIndex];
  const activeTutorialStep = tutorialOpen ? currentTutorialStepIndex : -1;
  const tutorialDrawFieldStep = tutorialKind === "full_workflow" ? 1 : 0;
  const tutorialDrawBlockStep = tutorialKind === "full_workflow" ? 2 : 1;
  const tutorialMakeBedsStep = tutorialKind === "full_workflow" ? 3 : 2;
  const tutorialCreatePlantingStep = tutorialKind === "full_workflow" ? 5 : 3;
  const tutorialReviewFlowStep = tutorialKind === "full_workflow" ? 6 : 4;
  const tutorialRecordWorkStep = tutorialKind === "full_workflow" ? 8 : 5;
  const tutorialSpreadsheetStep = tutorialKind === "full_workflow" ? 10 : 6;
  const tutorialTargetView: View | null = activeTutorialStep >= 0
    ? tutorialKind === "full_workflow"
      ? activeTutorialStep === tutorialReviewFlowStep
        ? "flows"
        : activeTutorialStep === tutorialSpreadsheetStep
          ? "plan"
          : "map"
      : activeTutorialStep <= tutorialMakeBedsStep
        ? "map"
        : activeTutorialStep === tutorialCreatePlantingStep
          ? "map"
          : activeTutorialStep === tutorialReviewFlowStep
            ? "flows"
            : activeTutorialStep === tutorialRecordWorkStep
              ? "map"
              : "plan"
    : null;
  const tutorialMapPlanningReady = view === "map" && mapWorkflowMode === "planning";
  const tutorialHighlightNav = (targetView: View) => tutorialTargetView === targetView && view !== targetView;
  const tutorialHighlightPlanningMode = view === "map" && mapWorkflowMode !== "planning" && (
    tutorialKind === "first_account"
      ? activeTutorialStep >= tutorialDrawFieldStep && activeTutorialStep <= tutorialMakeBedsStep
      : activeTutorialStep >= 0 && activeTutorialStep <= tutorialCreatePlantingStep
  );
  const tutorialHighlightWorkMode = view === "map" && mapWorkflowMode !== "field_work" && (
    tutorialKind === "first_account"
      ? activeTutorialStep === tutorialRecordWorkStep
      : activeTutorialStep >= 7 && activeTutorialStep <= 9
  );
  const tutorialHighlightMapSelect = tutorialMapPlanningReady
    && (
      (activeTutorialStep === tutorialDrawBlockStep && !selectedField && mapMode !== "select")
      || (activeTutorialStep === tutorialMakeBedsStep && !selectedBlockContext && mapMode !== "select")
    );
  const tutorialHighlightDrawField = activeTutorialStep === tutorialDrawFieldStep && tutorialMapPlanningReady && mapMode !== "draw_field";
  const tutorialHighlightDrawBlock = activeTutorialStep === tutorialDrawBlockStep && tutorialMapPlanningReady && selectedField != null && mapMode !== "draw_block";
  const tutorialHighlightGenerateBeds = activeTutorialStep === tutorialMakeBedsStep
    && tutorialMapPlanningReady
    && selectedBlockContext != null
    && mapMode !== "bed_tools"
    && mapMode !== "pick_bed_edge"
    && mapMode !== "draw_bed_line";
  const tutorialHighlightDraftSave = tutorialMapPlanningReady
    && (
      (activeTutorialStep === tutorialDrawFieldStep && mapMode === "draw_field")
      || (activeTutorialStep === tutorialDrawBlockStep && mapMode === "draw_block")
    )
    && draftCoordinates.length >= 3
    && Boolean(draftName.trim());
  const tutorialHighlightDraftName = tutorialMapPlanningReady
    && (
      (activeTutorialStep === tutorialDrawFieldStep && mapMode === "draw_field")
      || (activeTutorialStep === tutorialDrawBlockStep && mapMode === "draw_block")
    )
    && draftCoordinates.length >= 3
    && !draftName.trim();
  const tutorialHighlightMapSurface = tutorialMapPlanningReady
    && (
      (activeTutorialStep === tutorialDrawFieldStep && mapMode === "draw_field" && draftCoordinates.length < 3)
      || (activeTutorialStep === tutorialDrawBlockStep && !selectedField && mapMode === "select")
      || (activeTutorialStep === tutorialDrawBlockStep && mapMode === "draw_block" && draftCoordinates.length < 3)
      || (activeTutorialStep === tutorialMakeBedsStep && !selectedBlockContext && mapMode === "select")
      || (activeTutorialStep === tutorialMakeBedsStep && mapMode === "pick_bed_edge" && bedLineCoordinates.length < 2)
      || (activeTutorialStep === tutorialMakeBedsStep && mapMode === "draw_bed_line" && bedLineCoordinates.length < 2)
    );
  const tutorialExtraHighlightTarget = tutorialOpen ? getTutorialExtraHighlightTarget(tutorialKind, tutorialStepIndex) : null;
  const tutorialHighlightEntrancePreview = tutorialExtraHighlightTarget === "entrance_preview" && view === "map";
  const tutorialHighlightTaskLayerToggle = tutorialExtraHighlightTarget === "task_layer_toggle" && view === "map";
  const tutorialHighlightDoneThisWeek = tutorialExtraHighlightTarget === "done_this_week" && view === "map" && mapWorkflowMode === "field_work";
  const tutorialTargetClass = (isTarget: boolean) => isTarget ? " tutorial-target" : "";
  const tutorialFlowNeedsSelection = activeTutorialStep === tutorialReviewFlowStep
    && view === "flows"
    && tutorialFlowId != null
    && selectedFlowId !== tutorialFlowId;
  const tutorialDrawPhase = tutorialMapPlanningReady
    && (
      (activeTutorialStep === tutorialDrawFieldStep && mapMode === "draw_field")
      || (activeTutorialStep === tutorialDrawBlockStep && mapMode === "draw_block")
    )
    ? draftCoordinates.length < 3
      ? "draw-points"
      : draftName.trim()
        ? "save"
        : "name"
    : "none";
  const currentTutorialClickTarget = () => {
    if (tutorialTargetView != null && view !== tutorialTargetView) {
      const navLabel = tutorialTargetView === "map" ? "Map" : viewLabels.get(tutorialTargetView) ?? tutorialTargetView;
      return `Click the highlighted ${navLabel} button.`;
    }

    if (tutorialHighlightPlanningMode) {
      return "Click the highlighted Plan button in the map toolbar.";
    }

    if (tutorialHighlightWorkMode) {
      return "Click the highlighted Work button in the map toolbar.";
    }

    if (activeTutorialStep === tutorialDrawFieldStep) {
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

    if (activeTutorialStep === tutorialDrawBlockStep) {
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

    if (activeTutorialStep === tutorialMakeBedsStep) {
      if (!selectedBlockContext) {
        return "Click the block you just saved on the map. The Make beds button appears after a block is selected.";
      }
      if (mapMode !== "bed_tools" && mapMode !== "pick_bed_edge" && mapMode !== "draw_bed_line") {
        return "Click the highlighted Make beds button in the map toolbar.";
      }
      if (bedLineCoordinates.length < 2) {
        return mapMode === "pick_bed_edge" || mapMode === "draw_bed_line"
          ? "Click the highlighted map on the block edge beds should build from."
          : "Click the highlighted Begining of first bed button.";
      }
      return "Click the highlighted Fill rest of block button.";
    }

    if (tutorialKind === "full_workflow" && activeTutorialStep === 4) {
      return "Watch the first-bed entrance marker. If it drives into the bed and resets correctly, click Next.";
    }

    if (activeTutorialStep === tutorialCreatePlantingStep) {
      if (mapPlantingBeds.length === 0) {
        return "Use the highlighted Generate beds step first; the tutorial selects the first generated bed for cabbage.";
      }
      return "In the map-side New planting form, type the plant count, then click the highlighted Create planting button.";
    }

    if (activeTutorialStep === tutorialReviewFlowStep) {
      if (tutorialFlowNeedsSelection) {
        return "Click the highlighted Cabbage tutorial flow in the reusable task flows list.";
      }
      return tutorialKind === "full_workflow"
        ? "Review the tutorial flow. If the categories and scheduling look right, click Next."
        : "Click the highlighted Add node button. Set the new node to cleanup, link Cleanup to it, then save the flow.";
    }

    if (tutorialKind === "full_workflow" && activeTutorialStep === 7) {
      return "Turn on Tasks due and confirm the tutorial task vehicle appears. Then click Next to open the record panel.";
    }

    if (activeTutorialStep === tutorialRecordWorkStep) {
      return "Check the Date shown in the Record Work Done panel beside the map. It should match the tutorial bubble. Then fill any highlighted bed or plant-count field and click Record task.";
    }

    if (tutorialKind === "full_workflow" && activeTutorialStep === 9) {
      return "Check that the task appears under Done this week. Open Planting Detail if you want to verify the work history, then click Next.";
    }

    if (activeTutorialStep === tutorialSpreadsheetStep) {
      return tutorialKind === "full_workflow"
        ? "Find the spreadsheet export or backup area on Annual Crop Plan."
        : "This highlighted panel is the spreadsheet uploader. You do not need to click it now; it is here for importing a prepared crop plan later.";
    }

    return currentTutorialStep.clickTarget;
  };

  function handleTutorialNext() {
    if (currentTutorialStepIndex >= tutorialSteps.length - 1) {
      setTutorialOpen(false);
      setTutorialStatus(null);
      return;
    }

    if (tutorialKind === "full_workflow") {
      if (currentTutorialStepIndex === 0) {
        setView("map");
        setMapWorkflowMode("planning");
        setTutorialStepIndex(1);
        setTutorialStatus("Draw a field for the full workflow test.");
        return;
      }

      if (currentTutorialStepIndex === 4) {
        void prepareCabbageTutorial();
        return;
      }

      if (currentTutorialStepIndex === 6) {
        setView("map");
        setMapWorkflowMode("field_work");
        setSelectedMapWeekStart(startOfWeekDate(todayDateInputValue()));
        setShowTaskLayer(true);
        setTutorialStepIndex(7);
        setTutorialStatus("Tasks due is on. Confirm the tutorial marker appears, then click Next to record one scheduled task.");
        return;
      }

      if (currentTutorialStepIndex === 7) {
        const openedTask = selectFirstPastTutorialTask();
        if (openedTask) {
          setTutorialStepIndex(8);
        }
        return;
      }

      if (currentTutorialStepIndex === 9) {
        setView("plan");
        setTutorialStepIndex(10);
        setTutorialStatus("Find the spreadsheet export or backup area on Annual Crop Plan.");
        return;
      }
    }

    setTutorialStatus(null);
    setTutorialStepIndex((current) => Math.min(tutorialSteps.length - 1, current + 1));
  }
  const mapIsPointSelectionMode = isPointSelectionMapMode(mapMode);
  const legacyTutorialPanelEnabled = false;
  const tutorialScrollTriggerKey = [
    activeTutorialStep,
    bedLineCoordinates.length,
    tutorialDrawPhase,
    mapMode,
    mapPlantingBeds.length,
    mapWorkflowMode,
    selectedBlockContext?.id ?? "no-block",
    selectedField?.id ?? "no-field",
    selectedFlowId ?? "no-flow",
    tutorialFlowNeedsSelection,
    tutorialStatus ?? "",
    tutorialTargetView ?? "no-view",
    view
  ].join("|");

  return (
    <div className={`app-shell theme-${themeMode}${isMobileViewport ? " mobile-shell" : ""}`}>
      <TutorialAutoScroll active={tutorialOpen} triggerKey={tutorialScrollTriggerKey} />
      {canPlan && <ActiveTutorialOverlay />}
      <main className="main-panel">
        <header className={`topbar${mobileToolbarOpen ? " mobile-toolbar-open" : ""}`}>
          <div className="mobile-toolbar-summary">
            <button
              type="button"
              className="mobile-menu-button"
              aria-label="Open navigation and tools"
              aria-expanded={mobileToolbarOpen}
              onClick={() => setMobileToolbarOpen(true)}
            >
              <span aria-hidden="true" />
              <span aria-hidden="true" />
              <span aria-hidden="true" />
              <span aria-hidden="true" />
            </button>
            <div className="title-block">
              <span className="eyebrow">Loam Ledger</span>
              <strong>{viewTitle}</strong>
            </div>
            <div className="mobile-history-actions">
              <button
                type="button"
                className="secondary-button compact-button"
                disabled={undoSnapshots.length === 0}
                title={undoSnapshots[0] ? `Undo: ${undoSnapshots[0].label}` : "Nothing to undo yet"}
                onClick={() => void undoLastChange()}
              >
                Undo
              </button>
              {redoSnapshots.length > 0 && (
                <button
                  type="button"
                  className="secondary-button compact-button"
                  title={`Redo: ${redoSnapshots[0].label}`}
                  onClick={() => void redoLastChange()}
                >
                  Redo
                </button>
              )}
            </div>
          </div>
          {mobileToolbarOpen && (
            <button
              type="button"
              className="mobile-menu-backdrop"
              aria-label="Close navigation and tools"
              onClick={() => setMobileToolbarOpen(false)}
            />
          )}
          <div className="mobile-toolbar-drawer">
            <div className="mobile-drawer-header">
              <div>
                <span className="eyebrow">Loam Ledger</span>
                <strong>Navigation and tools</strong>
              </div>
              <button type="button" className="secondary-button compact-button" onClick={() => setMobileToolbarOpen(false)}>
                Close
              </button>
            </div>
            <div className="header-actions">
              <div className="toolbar-left">
                {mainToolbarNavItems.length > 0 && (
                  <div className="toolbar-nav" aria-label="Main navigation">
                    {mainToolbarNavItems.map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={`${view === value ? "primary-button" : "secondary-button"} compact-button${tutorialTargetClass(tutorialHighlightNav(value))}`}
                        onClick={() => {
                          setView(value);
                          setMobileToolbarOpen(false);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="toolbar-right desktop-history-and-utility-actions">
                <button
                  className="secondary-button"
                  disabled={undoSnapshots.length === 0}
                  title={undoSnapshots[0] ? `Undo: ${undoSnapshots[0].label}` : "Nothing to undo yet"}
                  onClick={() => void undoLastChange()}
                >
                  Undo
                </button>
                {redoSnapshots.length > 0 && (
                  <button
                    className="secondary-button"
                    title={`Redo: ${redoSnapshots[0].label}`}
                    onClick={() => void redoLastChange()}
                  >
                    Redo
                  </button>
                )}
                {utilityToolbarNavItems.length > 0 && (
                  <div className="toolbar-nav" aria-label="Settings navigation">
                    {utilityToolbarNavItems.map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={`${view === value ? "primary-button" : "secondary-button"} compact-button${tutorialTargetClass(tutorialHighlightNav(value))}`}
                        onClick={() => {
                          setView(value);
                          setMobileToolbarOpen(false);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                <span className="small-chip">
                  {session.user.displayName ?? session.user.username} • {session.user.farmName}
                </span>
              </div>
            </div>
          </div>
        </header>

        {feedbackOpen && (
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
            <div className="card feedback-dialog">
              <h2 id="feedback-title">Suggestion or problem</h2>
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
                    {isSavingFeedback ? "Saving..." : "Submit"}
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
              <h2 id="prototype-warning-title">This software is still being built.</h2>
              <p>
                Some parts may not work correctly, and bugs may cause lost or incorrect records. Please check important information and keep your own backups.
              </p>
              <p>
                By continuing, you agree to use Loam Ledger with these risks in mind.
              </p>
              <button className="primary-button full-span" type="button" onClick={dismissPrototypeWarning}>
                I understand
              </button>
            </div>
          </div>
        )}

        {legacyTutorialPanelEnabled && canPlan && tutorialOpen && (
          <section className="card tutorial-card" aria-labelledby="tutorial-title">
            <div className="section-header">
              <div className="title-block">
                <p className="eyebrow">{tutorialKind === "full_workflow" ? "Full workflow tutorial" : "First account tutorial"}</p>
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
                <button
                  type="button"
                  className={currentTutorialStepIndex >= tutorialSteps.length - 1 ? "primary-button" : "secondary-button"}
                  onClick={handleTutorialNext}
                  disabled={isPreparingTutorial}
                >
                  {currentTutorialStepIndex >= tutorialSteps.length - 1 ? "Done" : "Next"}
                </button>
              </div>
            </article>
          </section>
        )}

        {view === "map" && (
          <section className="content-grid map-grid">
            <div className="map-main-stack">
              <div className={`card map-card${tutorialTargetClass(tutorialHighlightMapSurface || tutorialHighlightEntrancePreview)}`}>
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
                  <FitToFarm fields={visibleFields} blocks={visibleBlocks} storageKey={currentMapViewStorageKey} />
                  <PersistMapView storageKey={currentMapViewStorageKey} />
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
                  const bedIsSelectable = mapWorkflowMode === "field_work" || mapMode === "draw_bed_line" || mapMode === "draw_zone_split";
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
                          runMapSelectClick(() => selectBedOnMap(bed, {
                            togglePlantingSelection: mapWorkflowMode === "planning" && Boolean(originalEvent?.ctrlKey || originalEvent?.metaKey)
                          }));
                        },
                        dblclick: (event) => {
                          stopMapDoubleClick(event);
                          if (mapMode !== "select") {
                            return;
                          }
                          clearPendingMapSingleClick();
                          selectBlockForBedOnMap(bed);
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
                          runMapSelectClick(() => selectBedOnMap(bed));
                        },
                        dblclick: (event) => {
                          stopMapDoubleClick(event);
                          if (mapWorkflowMode !== "field_work" || mapMode !== "select") {
                            return;
                          }
                          clearPendingMapSingleClick();
                          selectBlockForBedOnMap(bed);
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
                          if (bed && planting) {
                            runMapSelectClick(() => selectPlantingOnMap(planting, bed));
                          } else if (bed) {
                            runMapSelectClick(() => selectBlockForBedOnMap(bed));
                          }
                        },
                        dblclick: (event) => {
                          stopMapDoubleClick(event);
                          if (mapWorkflowMode !== "field_work" || mapMode !== "select") {
                            return;
                          }
                          clearPendingMapSingleClick();
                          const bed = bedsById.get(overlay.bedId) ?? null;
                          if (bed) {
                            selectBlockForBedOnMap(bed);
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
                          if (bed && planting) {
                            runMapSelectClick(() => selectPlantingOnMap(planting, bed));
                          } else if (bed) {
                            runMapSelectClick(() => selectBlockForBedOnMap(bed));
                          }
                        },
                        dblclick: (event) => {
                          stopMapDoubleClick(event);
                          if (mapWorkflowMode !== "field_work" || mapMode !== "select") {
                            return;
                          }
                          clearPendingMapSingleClick();
                          const bed = bedsById.get(overlay.bedId) ?? null;
                          if (bed) {
                            selectBlockForBedOnMap(bed);
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
                          const planting = overlay.plantingId != null ? plantingsById.get(overlay.plantingId) ?? null : null;
                          if (bed && planting) {
                            runMapSelectClick(() => selectPlantingOnMap(planting, bed));
                          } else if (bed) {
                            runMapSelectClick(() => selectBlockForBedOnMap(bed));
                          }
                        },
                        dblclick: (event) => {
                          stopMapDoubleClick(event);
                          if (mapWorkflowMode !== "field_work" || mapMode !== "select") {
                            return;
                          }
                          clearPendingMapSingleClick();
                          const bed = bedsById.get(overlay.bedId) ?? null;
                          if (bed) {
                            selectBlockForBedOnMap(bed);
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
                      "bed_making",
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

                {showWeeklyTaskMarkers && mapTasksThisWeek.map(({ key, task, center, bearing, runDistancePx, runDurationSec, animationDelaySec, oneWayRun, animated }) => (
                  <Marker
                    key={key}
                    position={[center.lat, center.lng]}
                    icon={taskMapIcon(task.taskType, taskColor(task), task.iconSecondaryColor, bearing, runDistancePx, task.tractorModel, mapTaskSpriteSheetUrls.get(task.id), runDurationSec, animationDelaySec, oneWayRun, animated)}
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
                <div className={`map-mode-overlay${mapIsPointSelectionMode ? " point-selection-active" : ""}`} aria-label="Map mode and tools">
                  <div className="map-workflow-toggle" aria-label="Map workflow">
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
                  {mapWorkflowMode === "planning" ? (
                    <div className="map-overlay-tools" aria-label="Planning map tools">
                      <button type="button" className={`${mapMode === "select" ? "primary-button" : "secondary-button"} compact-button${tutorialTargetClass(tutorialHighlightMapSelect)}`} onClick={() => resetMapDrafts("select")}>Select</button>
                      <button type="button" className={`${mapMode === "draw_field" ? "primary-button" : "secondary-button"} compact-button${tutorialTargetClass(tutorialHighlightDrawField)}`} onClick={startDrawField} disabled={!canPlan}>Draw field</button>
                      <button type="button" className={`${mapMode === "draw_block" ? "primary-button" : "secondary-button"} compact-button${tutorialTargetClass(tutorialHighlightDrawBlock)}`} onClick={startDrawBlock} disabled={!canPlan || !selectedField || !selectedFieldIsOwnFarm}>Draw block</button>
                      <button type="button" className={`${mapMode === "edit" ? "primary-button" : "secondary-button"} compact-button`} onClick={startEditSelection} disabled={!canEditSelectedMapItem}>Edit field/block</button>
                      <button
                        type="button"
                        className={`${mapMode === "bed_tools" || mapMode === "pick_bed_edge" || mapMode === "draw_bed_line" ? "primary-button" : "secondary-button"} compact-button${tutorialTargetClass(tutorialHighlightGenerateBeds)}`}
                        onClick={openSelectedBlockBedMaker}
                        disabled={!selectedBlockContext || !canEditSelectedBlockContext}
                      >
                        Make beds
                      </button>
                    </div>
                  ) : (
                    <div className="map-work-mode-hint">Select beds or crop areas to record work.</div>
                  )}
                </div>
              </div>
              <div className="card map-controls-card">
                {isMobileViewport && (
                  <div className="mobile-map-control-buttons" aria-label="Map controls">
                    {(["gps", "week", "layers"] as const).map((panel) => (
                      <button
                        key={panel}
                        type="button"
                        className={mobileMapPanel === panel ? "primary-button" : "secondary-button"}
                        aria-expanded={mobileMapPanel === panel}
                        onClick={() => setMobileMapPanel((current) => current === panel ? null : panel)}
                      >
                        {panel === "gps" ? "GPS" : panel === "week" ? "Week" : "Layers"}
                      </button>
                    ))}
                  </div>
                )}
                {(!isMobileViewport || mobileMapPanel === "gps") && <div className="map-location-panel mobile-map-control-panel">
                  <button type="button" className="primary-button" onClick={locateUserOnMap}>
                    Use phone location
                  </button>
                  {userLocation && (
                    <p className="muted">
                      Location shown{userLocation.accuracyM != null ? `, accuracy about ${Math.round(userLocation.accuracyM)} m` : ""}.
                    </p>
                  )}
                </div>}
                {(!isMobileViewport || mobileMapPanel === "week") && <div className="timeline-panel mobile-map-control-panel">
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
                </div>}
                {(!isMobileViewport || mobileMapPanel === "layers") && <div className="layer-panel map-layer-options mobile-map-control-panel">
                  <h3>Map layers</h3>
                  <p className="muted">Basemap: online imagery. Your crop and task layer choices are saved on this device.</p>
                  <label className="layer-toggle">
                    <input
                      type="checkbox"
                      checked={showPlannedPlantingsLayer}
                      onChange={(event) => updateMapLayerSettings({ planned: event.target.checked })}
                    />
                    <span>Planned crops</span>
                  </label>
                  <label className="layer-toggle">
                    <input
                      type="checkbox"
                      checked={showActualPlacementsLayer}
                      onChange={(event) => updateMapLayerSettings({ actual: event.target.checked })}
                    />
                    <span>Actual crops</span>
                  </label>
                  <label className={`layer-toggle${tutorialTargetClass(tutorialHighlightTaskLayerToggle)}`}>
                    <input
                      type="checkbox"
                      checked={showTaskLayer}
                      onChange={(event) => updateMapLayerSettings({ tasks: event.target.checked })}
                    />
                    <span>Tasks due</span>
                  </label>
                  {canViewOtherFarmMaps && (
                    <label className="layer-toggle">
                      <input
                        type="checkbox"
                        checked={showOtherFarmMaps}
                        onChange={(event) => updateMapLayerSettings({ otherFarms: event.target.checked })}
                      />
                      <span>Other farms</span>
                    </label>
                  )}
                </div>}
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
                        await loadDashboardResources(dashboardRefreshResources.map);
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
                    highlightDoneThisWeek={tutorialHighlightDoneThisWeek}
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
                        <span>Current use</span>
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
                          <span>Current use</span>
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
                          <span>Planned use (optional)</span>
                          <select value={editPlannedUse ?? ""} onChange={(event) => setEditPlannedUse(event.target.value ? event.target.value as Exclude<PlannedUse, null> : null)}>
                            <option value="">No future use assigned</option>
                            {futureUseOptions.map((option) => <option key={option} value={option}>{formatPlannedUseLabel(option)}</option>)}
                          </select>
                        </label>
                        <label>
                          <span>Current use</span>
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

              {bedGeneratorCardVisible && selectedBlockContext && (
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
                  tutorialActive={activeTutorialStep === tutorialMakeBedsStep && tutorialMapPlanningReady}
                  onPickEdge={startBedEdgePick}
                  onStartLine={startBedLineDraw}
                  onCancelLine={cancelBedLinePick}
                  onInvertSideChange={setBedInvertSide}
                  onEntranceSideChange={(blockId, entranceSide) => {
                    setBedEntranceSideDrafts((current) => ({ ...current, [blockId]: entranceSide }));
                  }}
                  onPreviewChange={setBedPreviewCoordinates}
                  onStatusChange={setMapNotice}
                  onSave={() => loadDashboardResources(dashboardRefreshResources.map)}
                  onBlockFilled={() => {
                    resetMapDrafts("select");
                    setSelection({ type: "block", id: selectedBlockContext.id });
                  }}
                  onTutorialBedsGenerated={(bedIds) => {
                    if (tutorialOpen && tutorialStepIndex === tutorialMakeBedsStep) {
                      const firstBedId = bedIds[0] ?? null;
                      setSelection({ type: "block", id: selectedBlockContext.id });
                      if (tutorialKind === "full_workflow") {
                        setTutorialStepIndex(4);
                        setTutorialStatus("Beds created. Watch the first-bed entrance vehicle, then click Next to load the planting sample.");
                      } else {
                        void prepareCabbageTutorial(firstBedId == null ? null : { id: firstBedId, blockId: selectedBlockContext.id });
                      }
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
                  highlightSubmit={activeTutorialStep === tutorialCreatePlantingStep}
                  onPreviewChange={setBedAllocationPreview}
                  onSave={async () => {
                    const flowId = tutorialPlantingDraft?.taskFlowTemplateId ?? null;
                    await loadDashboardResources(dashboardRefreshResources.plantings);
                    const savedCount = mapPlantingBeds.length;
                    setBedAllocationPreview([]);
                    setMapPlantingBedIds([]);
                    if (tutorialOpen && tutorialStepIndex === tutorialCreatePlantingStep) {
                      if (flowId != null) {
                        setTutorialFlowId(flowId);
                        setSelectedFlowId(flowId);
                      }
                      setTutorialStepIndex(tutorialReviewFlowStep);
                      setTutorialStatus(tutorialKind === "full_workflow"
                        ? "Planting created from the map. Use the highlighted Task Flows navigation to review the tutorial flow."
                        : "Planting created from the map. Use the highlighted Task Flows navigation, then add the cleanup node.");
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
                    await loadDashboardResources(dashboardRefreshResources.plantings);
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
                    await loadDashboardResources(dashboardRefreshResources.plantings);
                    setBedAllocationPreview([]);
                  }}
                />
              )}

              {mapWorkflowMode === "field_work" && selectedZone?.plannedUse === "cover_crop" && selectedZone.farmId === data.farm?.id && (
                <CoverCropWorkCard
                  zone={selectedZone}
                  onSave={() => loadDashboardResources(dashboardRefreshResources.map)}
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
                  selectedPlantingId={selectedPlanting?.id ?? null}
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
                    await loadDashboardResources(dashboardRefreshResources.map);
                    setMapNotice("Unplanned work recorded.");
                  }}
                />
              )}

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
              <MobileListLimiter
                itemCount={planGroups.reduce((total, [, plantings]) => total + plantings.length, 0)}
                itemLabel="plantings"
              >
                <table className="data-table">
                  <thead>
                    <tr>
                      {canPlan && <th>Select</th>}
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
              </MobileListLimiter>
              {unscheduledTaskList.length > 0 && (
                <div className="instruction-box">
                  <strong>Unscheduled tasks</strong>
                  <p className="muted">These exist but do not have a due date yet. Bed-making tasks will get a date once plantings in that block have planned dates.</p>
                  <MobileListLimiter itemCount={unscheduledTaskList.length} itemLabel="unscheduled tasks">
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
                  </MobileListLimiter>
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
                  highlightSubmit={activeTutorialStep === tutorialCreatePlantingStep}
                  onSave={async () => {
                    const flowId = tutorialPlantingDraft?.taskFlowTemplateId ?? null;
                    await loadDashboardResources(dashboardRefreshResources.plantings);
                    if (tutorialOpen && tutorialStepIndex === tutorialCreatePlantingStep) {
                      if (flowId != null) {
                        setTutorialFlowId(flowId);
                        setSelectedFlowId(flowId);
                      }
                      setTutorialStepIndex(tutorialReviewFlowStep);
                      setTutorialStatus(tutorialKind === "full_workflow"
                        ? "Planting created. Use the highlighted Task Flows navigation to review the tutorial flow."
                        : "Planting created. Use the highlighted Task Flows navigation, then add the cleanup node.");
                    }
                    setTutorialPlantingDraft(null);
                  }}
                />
                <SpreadsheetImportCard tutorialActive={activeTutorialStep === tutorialSpreadsheetStep && view === "plan"} onImported={load} />
              </div>
            ) : (
              <div className="card"><h2>Planning access</h2><p className="muted">Workers can view plantings but cannot create or edit them.</p></div>
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
                    <h3>Plan details</h3>
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
                      <div><DetailTerm review={plantingReviewInfo(selectedPlanting)} fieldName="bedLengthUsed">Bed length</DetailTerm><dd>{formatLength(selectedPlanting.bedLengthUsedM, distanceUnit)}</dd></div>
                      <div><dt>Tray location</dt><dd>{selectedPlanting.trayLocation ?? "—"}</dd></div>
                      <div><dt>Tray count</dt><dd>{selectedPlanting.trayCount ?? "—"}</dd></div>
                      <div><dt>Cells per tray</dt><dd>{selectedPlanting.cellsPerTray ?? "—"}</dd></div>
                      <div><DetailTerm review={plantingReviewInfo(selectedPlanting)} fieldName="field">Intended field</DetailTerm><dd>{selectedPlanting.intendedFieldName ?? "—"}</dd></div>
                      <div><DetailTerm review={plantingReviewInfo(selectedPlanting)} fieldName="block">Intended block</DetailTerm><dd>{selectedPlanting.intendedBlockName ?? "—"}</dd></div>
                      <div><DetailTerm review={plantingReviewInfo(selectedPlanting)} fieldName="bed">Intended bed</DetailTerm><dd>{selectedPlanting.intendedBedName ?? "—"}</dd></div>
                      <div><dt>Task flow</dt><dd>{selectedPlanting.taskFlowTemplateName ?? "Default task flow"}</dd></div>
                      <div><dt>Intended location</dt><dd>{[selectedPlanting.intendedFieldName, selectedPlanting.intendedBlockName, selectedPlanting.intendedBedName].filter(Boolean).join(" / ") || "—"}</dd></div>
                      <div><DetailTerm review={plantingReviewInfo(selectedPlanting)} fieldName="notes">Notes</DetailTerm><dd>{selectedPlanting.notes ?? "—"}</dd></div>
                    </dl>
                  </div>
                </div>
              </div>

              <div className="card">
                <h2>Bed placement history</h2>
                <MobileListLimiter itemCount={selectedPlacements.length} itemLabel="placement records">
                  <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Bed</th>
                      <th>Plant count</th>
                      <th>Bed length</th>
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
                </MobileListLimiter>
              </div>

              <div className="card">
                <h2>Event history</h2>
                <MobileListLimiter itemCount={selectedEvents.length} itemLabel="events">
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
                </MobileListLimiter>
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
                        await loadDashboardResources(dashboardRefreshResources.plantings);
                        setEditingPlantingId(null);
                      }}
                    />
                  ) : (
                    <PlantingActualsCard
                      planting={selectedPlanting}
                      onSave={() => loadDashboardResources(dashboardRefreshResources.plantings)}
                    />
                  )}
                </>
              ) : (
                <div className="card"><h2>Planning access</h2><p className="muted">Only planner accounts can change planting plans.</p></div>
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
                    <span>Overdue</span>
                  </label>
                </div>
              )}
              <MobileListLimiter itemCount={visibleTaskList.length} itemLabel="tasks">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Task</th>
                      <th>Planting</th>
                      <th>Bed</th>
                      <th>Status</th>
                      <th>Depends on</th>
                      <th>Scheduling rule</th>
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
              </MobileListLimiter>
            </div>
            <div className="stack">
              {renderTaskRecordCard(selectedTask)}
              <div className="card">
                <h2>How task dates shift</h2>
                  <p>Future tasks are generated from planned planting dates and task-flow arrows. Connected task dates recalculate from recorded actual work.</p>
                <p className="muted">Task records can also update planting details.</p>
              </div>
            </div>
          </section>
        )}

        {view === "record" && (
          <section className="content-grid split-grid">
            {renderTaskRecordCard(recordTaskCandidate)}
          </section>
        )}

        {view === "flows" && (
          <section className="content-grid flow-layout">
            <div className="stack flow-sidebar">
              <div className="card">
                <div className="section-header">
                  <div className="title-block">
                    <h2>Task flows</h2>
                    <p className="muted">Build crop-specific flows, visualize dependencies, and copy an existing flow before adjusting it.</p>
                  </div>
                  <div className="button-row">
                    <button type="button" className="secondary-button" onClick={startNewTaskFlow}>New task flow</button>
                    <button type="button" className="secondary-button" onClick={() => void copySelectedTaskFlow()} disabled={selectedFlowTemplate == null}>Copy selected flow</button>
                    <button type="button" className="danger-button" onClick={() => void deleteSelectedTaskFlow()} disabled={selectedFlowTemplate == null}>Delete</button>
                  </div>
                </div>
                <MobileListLimiter itemCount={data.taskFlowTemplates.length} itemLabel="task flows">
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
                </MobileListLimiter>
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
                tutorialActive={tutorialKind === "first_account" && activeTutorialStep === tutorialReviewFlowStep && !tutorialFlowNeedsSelection}
                onSaved={async (nextId) => {
                  await loadDashboardResources(dashboardRefreshResources.taskFlows);
                  setSelectedFlowId(nextId);
                  setFlowEditorKey((current) => current + 1);
                  if (tutorialOpen && tutorialKind === "first_account" && tutorialStepIndex === tutorialReviewFlowStep) {
                    setTutorialStepIndex(tutorialRecordWorkStep);
                    selectFirstPastTutorialTask();
                  }
                }}
              />
              <GarageCard tractorProfiles={data.tractorProfiles} onProfilesChange={updateTractorProfiles} />
            </div>
          </section>
        )}

        {view === "seed-bank" && (
          <SeedBankCard
            data={ownFarmData}
            canPlan={canPlan}
            onSave={() => loadDashboardResources(dashboardRefreshResources.seeds)}
          />
        )}

        {view === "harvests" && (
          <section className="content-grid split-grid">
            <div className="card">
              <h2>Harvest log</h2>
              <div className="instruction-box warning-box">
                Feature coming soon, hopefully... Harvest is out of beta scope for now.
              </div>
              <MobileListLimiter itemCount={data.harvests.length} itemLabel="harvest records">
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
              </MobileListLimiter>
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
            currentUserId={session.user.id}
            reports={feedbackReports}
            onRefresh={() => load(true, true)}
            onOpenFeedback={() => {
              recordActivity("feedback dialog opened", { page: view });
              setFeedbackStatus(null);
              setFeedbackOpen(true);
            }}
          />
        )}

        {view === "inbox" && (
          <InboxPanel
            messages={messages}
            onMessageRead={(id) => {
              setMessages((current) => current.map((message) => (
                message.id === id
                  ? { ...message, readAt: message.readAt ?? new Date().toISOString() }
                  : message
              )));
            }}
            onRefresh={async () => {
              setMessages(normalizeUserMessages(await api.getMessages()));
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
                    <span>dark/light mode</span>
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
              <div className="card">
                <h2>Privacy</h2>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={usageTrackingEnabled}
                    disabled={savingUsagePreference}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      setSavingUsagePreference(true);
                      void api.setUsagePreference(enabled)
                        .then((result) => setUsageTrackingEnabled(result.enabled))
                        .catch((error) => setError(error instanceof Error ? error.message : "Could not save tracking preference."))
                        .finally(() => setSavingUsagePreference(false));
                    }}
                  />
                  <span>Share anonymous usage information</span>
                </label>
                <p className="muted">
                  Optional and off by default. Records only coarse page activity and broad time ranges.
                  It does not store your identity, farm, browser ID, raw web address, farm records, clicks, or error text.
                </p>
              </div>
              {canPlan && <TutorialsCard />}
              <div className="card">
                <h2>Account</h2>
                <dl className="detail-list">
                  <div><dt>User</dt><dd>{session.user.displayName ?? session.user.username}</dd></div>
                  <div><dt>Farm</dt><dd>{session.user.farmName}</dd></div>
                </dl>
                <button className="secondary-button full-span" onClick={() => void handleLogout()}>
                  Log out
                </button>
              </div>
              <AccountPasswordCard />
            </div>
            <div className="stack">
              {canPlan && (
                <TeamAccountsCard
                  farmName={session.user.farmName}
                  currentUserId={session.user.id}
                />
              )}
              <div className="card">
                <h2>Map imagery</h2>
                <p className="muted">This prototype uses the live web basemap. Offline map caching is off.</p>
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
            Suggestion or problem
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
  const [cellsPerTray, setCellsPerTray] = useState(planting.cellsPerTray == null ? "128" : String(planting.cellsPerTray));
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
    setCellsPerTray(planting.cellsPerTray == null ? "128" : String(planting.cellsPerTray));
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
    let plantCountValue = plantCount.trim() ? Number(plantCount) : null;
    let bedLengthUsedM = parseLengthInputValue(bedLengthUsed || null, distanceUnit);
    const trayCountValue = trayCount.trim() ? Number(trayCount) : null;
    const cellsPerTrayValue = cellsPerTray.trim() ? Number(cellsPerTray) : null;
    const daysToHarvestValue = daysToHarvest.trim() ? Number(daysToHarvest) : null;
    const rowsPerBedValue = rowsPerBed.trim() ? Number(rowsPerBed) : null;
    const spacing = formatSpacingPair(spacingInRow, spacingBetweenRows, distanceUnit);
    const saveInRowSpacingM = spacingInputToMeters(spacingInRow, distanceUnit);
    const saveRowsPerBed = rowsPerBedValue != null && Number.isInteger(rowsPerBedValue) && rowsPerBedValue > 0
      ? rowsPerBedValue
      : null;

    const trayInputsChanged = trayCountValue !== (planting.trayCount ?? null) || cellsPerTrayValue !== (planting.cellsPerTray ?? 128);
    if (
      ((lastPlanningInput === "trayCount" || lastPlanningInput === "cellsPerTray" || lastPlanningInput === "germinationRate") || trayInputsChanged)
      && plantsFromTrays != null
    ) {
      plantCountValue = plantsFromTrays;
    } else if (lastPlanningInput === "seedCellCount") {
      const seedCells = Number(seedCellCount);
      if (Number.isFinite(seedCells) && seedCells > 0 && germinationRateDecimal != null) {
        plantCountValue = Math.max(1, Math.round(seedCells * germinationRateDecimal));
      }
    } else if (lastPlanningInput === "expectedTrayPlants") {
      const expectedPlants = Number(expectedTrayPlants);
      if (Number.isFinite(expectedPlants) && expectedPlants > 0) {
        plantCountValue = Math.round(expectedPlants);
      }
    } else if ((lastPlanningInput === "bedLengthUsed" || lastPlanningInput === "bed") && plantsForBedLength != null) {
      plantCountValue = plantsForBedLength;
    } else if ((lastPlanningInput === "spacing" || lastPlanningInput === "rowsPerBed") && plantCountValue == null && plantsForBedLength != null) {
      plantCountValue = plantsForBedLength;
    }

    if (plantCountValue != null && Number.isFinite(plantCountValue) && plantCountValue > 0) {
      plantCountValue = Math.max(1, Math.round(plantCountValue));
    }

    if (plantCountValue != null && saveInRowSpacingM != null && saveRowsPerBed != null) {
      bedLengthUsedM = (plantCountValue * saveInRowSpacingM) / saveRowsPerBed;
    }

    if (!Number.isFinite(cropIdValue)) {
      setMessage("Choose a crop.");
      return;
    }
    if (!title.trim()) {
      setMessage("Title is required.");
      return;
    }
    if (plantCountValue != null && (!Number.isFinite(plantCountValue) || plantCountValue <= 0)) {
      setMessage("Plant count must be a number above zero.");
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
    if (trayCountValue != null && (!Number.isFinite(trayCountValue) || trayCountValue <= 0)) {
      setMessage("Tray count must be a number above zero.");
      return;
    }
    if (cellsPerTrayValue != null && (!Number.isInteger(cellsPerTrayValue) || cellsPerTrayValue <= 0)) {
      setMessage("Cells per tray must be a whole number above zero.");
      return;
    }
    if (daysToHarvestValue != null && (!Number.isInteger(daysToHarvestValue) || daysToHarvestValue <= 0)) {
      setMessage("Days to harvest must be a whole number greater than zero.");
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
            <option value="">Default task flow</option>
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
          <FieldLabel review={review} fieldName="plannedTransplantDate">Planned transplant date</FieldLabel>
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
          <FieldLabel review={review} fieldName="expectedHarvestStart">Harvest start date</FieldLabel>
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
          <FieldLabel review={review} fieldName="expectedHarvestEnd">Harvest end date</FieldLabel>
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
            step="0.1"
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
            step="0.1"
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
        <MobileListLimiter
          itemCount={activeTasks.length + plantings.length + placements.length + gaps.length + doneTasks.length}
          itemLabel="bed records"
        >
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
                {placements.map((placement) => (
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
                {gaps.map((gap) => (
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
                {doneTasks.map((task) => (
                  <button key={task.id} type="button" className="small-chip chip-button" onClick={() => onSelectTask(task)}>
                    Done: {task.title}
                  </button>
                ))}
              </div>
            </div>
          )}
          </div>
        </MobileListLimiter>
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
  highlightDoneThisWeek = false,
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
  highlightDoneThisWeek?: boolean;
  showPastUndoneOption: boolean;
  pastUndoneChecked: boolean;
  onPastUndoneChange: (checked: boolean) => void;
  onSelectTask: (task: Task) => void;
  onQuickComplete: (task: Task) => void;
  onUndoTask: (task: Task) => void;
}) {
  const activeTasks = tasks.filter((task) => task.status !== "done");
  const doneTasks = tasks.filter((task) => task.status === "done");

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
            <span>Overdue</span>
          </label>
        </div>
      )}
      {tasks.length === 0 ? (
        <p className="muted">No tasks scheduled for this selection.</p>
      ) : (
        <MobileListLimiter itemCount={tasks.length} itemLabel="tasks">
          <div className="stack compact-stack">
          {activeTasks.length > 0 && (
            <div>
              <strong>Work to do</strong>
              <div className="task-week-list">
                {activeTasks.map((task) => (
                  <article key={task.id} className="task-week-row">
                    <button type="button" className="task-week-main" onClick={() => onSelectTask(task)}>
                      <span className="task-cell">
                        <TaskIconMark taskType={task.taskType} color={taskColor(task)} secondaryColor={task.iconSecondaryColor} tractorModel={task.tractorModel} mini />
                        <strong>{task.title}</strong>
                      </span>
                      <span className="muted">{formatDate(task.scheduledDate)} / {task.bedName ?? task.plantingTitle ?? "No location"}</span>
                    </button>
                    <div className="button-row">
                      <button type="button" className="primary-button compact-button" onClick={() => onQuickComplete(task)}>
                        {taskNeedsRecordForm(task.taskType) ? "Record" : "Mark done"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}
          {doneTasks.length > 0 && (
            <div className={highlightDoneThisWeek ? "tutorial-target" : ""}>
              <strong>Done this week</strong>
              <div className="task-week-list">
                {doneTasks.map((task) => (
                  <article key={task.id} className="task-week-row">
                    <button type="button" className="task-week-main" onClick={() => onSelectTask(task)}>
                      <span className="task-cell">
                        <TaskIconMark taskType={task.taskType} color={taskColor(task)} secondaryColor={task.iconSecondaryColor} tractorModel={task.tractorModel} mini />
                        <strong>{task.title}</strong>
                      </span>
                      <span className="muted">{formatDate(task.scheduledDate)} / {task.bedName ?? task.plantingTitle ?? "No location"}</span>
                    </button>
                    <div className="button-row">
                      {task.id === undoTaskId ? (
                        <button type="button" className="danger-button compact-button" onClick={() => onUndoTask(task)}>
                          Undo
                        </button>
                      ) : (
                        <span className="status-pill">Done</span>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}
          </div>
        </MobileListLimiter>
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
  }, [placementRowsKey, block.id, selectedBed?.id, selectedBed?.bedLengthM, beds, blockBeds, gaps, overflows, placements, plantings, plantingById, distanceUnit]);

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
        entranceSide: block.bedStartEntranceSide ?? "start",
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
        <h2>Block crop plan</h2>
        <p className="muted">This block has no plantable beds yet.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="section-header">
        <div>
          <h2>Block crop plan</h2>
          <p className="muted">{selectedBed ? `${selectedBed.name}: rows touching this bed.` : `${block.name}: all planned rows.`}</p>
        </div>
        <button type="button" className="secondary-button compact-button" onClick={() => addGapAfter(visibleRows.at(-1)?.key ?? null)}>
          Add gap row
        </button>
      </div>
      <MobileListLimiter itemCount={visibleRows.length} itemLabel="crop-plan rows" forceExpanded={expandedEditor != null}>
        <table className="data-table compact-table">
        <thead>
          <tr>
            <th>Variety</th>
            <th>Bed length</th>
            <th>Trays</th>
            <th>Plants</th>
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
                <td><input value={row.trayCount} onChange={(event) => updateRow(row.key, linkedPlanningPatch(row, "trayCount", event.target.value))} type="number" min="1" step="0.1" disabled={row.kind === "gap"} /></td>
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
      </MobileListLimiter>
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
  const [trayCount, setTrayCount] = useState("");
  const [cellsPerTray, setCellsPerTray] = useState("");
  const [seedCellCount, setSeedCellCount] = useState("");
  const [bedMakingRows, setBedMakingRows] = useState<BedMakingRecordRow[]>([]);
  const [bedMakingBlockFull, setBedMakingBlockFull] = useState(false);
  const [spacingInRow, setSpacingInRow] = useState("");
  const [spacingBetweenRows, setSpacingBetweenRows] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isFieldPlantingTask = task?.taskType === "transplant" || task?.taskType === "direct_seed";
  const isTraySeedingTask = task?.taskType === "seed_in_tray";
  const isBedPrepTask = task?.taskType === "bed_making";
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
  const staleTaskWarning = task && !isCurrentTaskCategory(task.taskType)
    ? `This task uses the old category "${task.taskType}". Update its task flow to a current category before recording work.`
    : null;
  const landlessTaskWarning = task && isBedPrepTask && !taskBlock
    ? "This task is not tied to a mapped block or bed. Open the current mapped block bed-making task, or attach this task to land before recording it."
    : null;
  const canAdjustBedMaking = canAdjustPlanting && isBedMakingTask && taskBlockPlantableBeds.length > 0 && usableBedPresets.length > 0;
  const canAdjustTraySeeding = canAdjustPlanting && isTraySeedingTask && planting != null;
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
  const recordedTrayCount = Number(trayCount);
  const recordedCellsPerTray = Number(cellsPerTray);
  const recordedSeedCellCount = Number(seedCellCount);
  const calculatedSeedCellCount = Number.isFinite(recordedSeedCellCount) && recordedSeedCellCount > 0
    ? Math.round(recordedSeedCellCount)
    : Number.isFinite(recordedTrayCount) && recordedTrayCount > 0 && Number.isFinite(recordedCellsPerTray) && recordedCellsPerTray > 0
      ? Math.round(recordedTrayCount * recordedCellsPerTray)
      : null;
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
  const bedMakingMatchesPlannedBlock = isBedMakingTask && taskBlockPlantableBeds.length > 0 && recordedBedMakingCount === taskBlockPlantableBeds.length;
  const bedMakingFullBlockActive = bedMakingBlockFull || bedMakingOverTarget || bedMakingMatchesPlannedBlock;
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
    setTrayCount(isTraySeedingTask && planting?.trayCount != null ? String(planting.trayCount) : "");
    setCellsPerTray(isTraySeedingTask ? String(planting?.cellsPerTray ?? 128) : "");
    setSeedCellCount("");
    setBedMakingRows(isBedMakingTask && defaultBedMakingPresetId
      ? [{ key: "bed-making-row-0", count: String(Math.max(1, taskBlockPlantableBeds.length)), presetId: defaultBedMakingPresetId }]
      : []);
    setBedMakingBlockFull(false);
    setSpacingInRow(spacingPair.inRow);
    setSpacingBetweenRows(spacingPair.betweenRows);
    setStatus(null);
  }, [task, planting, distanceUnit, bedById, blockById, isFieldPlantingTask, isTraySeedingTask, isBedMakingTask, requiresLotNumber, existingSeedLotNumber, availableBefore, highlightSubmit, taskBlockPlantableBeds.length, defaultBedMakingPresetId]);

  if (!task) {
    return <div className="card"><h2>Record Work Done</h2><p className="muted">Select a task first.</p></div>;
  }

  return (
    <div className="card">
      <h2>Record Work Done</h2>
      <p className="muted"><strong>{task.title}</strong></p>
      <dl className="detail-list">
        <div><dt>Work type</dt><dd>{formatTaskTypeLabel(task.taskType)}</dd></div>
        <div><dt>Scheduled</dt><dd>{formatDate(task.scheduledDate)}</dd></div>
        <div><dt>Planting</dt><dd>{task.plantingTitle ?? "—"}</dd></div>
        <div><dt>Bed</dt><dd>{task.bedName ?? "—"}</dd></div>
        <div><dt>Status</dt><dd>{task.status}</dd></div>
      </dl>
      {(staleTaskWarning || landlessTaskWarning) && (
        <div className="instruction-box warning-box">
          {staleTaskWarning ?? landlessTaskWarning}
        </div>
      )}
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
              if (canAdjustTraySeeding && trayCount.trim() && (!Number.isFinite(recordedTrayCount) || recordedTrayCount <= 0)) {
                setStatus("Tray count must be a number above zero.");
                return;
              }
              if (canAdjustTraySeeding && cellsPerTray.trim() && (!Number.isInteger(recordedCellsPerTray) || recordedCellsPerTray <= 0)) {
                setStatus("Cells per tray must be a whole number above zero.");
                return;
              }
              if (canAdjustTraySeeding && seedCellCount.trim() && (!Number.isInteger(recordedSeedCellCount) || recordedSeedCellCount <= 0)) {
                setStatus("Cells seeded must be a whole number above zero.");
                return;
              }
              if (staleTaskWarning || landlessTaskWarning) {
                setStatus(staleTaskWarning ?? landlessTaskWarning);
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
                plantCount: canAdjustTraySeeding && calculatedSeedCellCount != null ? calculatedSeedCellCount : undefined,
                trayCount: canAdjustTraySeeding && trayCount.trim() ? recordedTrayCount : undefined,
                cellsPerTray: canAdjustTraySeeding && cellsPerTray.trim() ? recordedCellsPerTray : undefined,
                spacing: canAdjustPlanting && isFieldPlantingTask && spacing ? spacing : undefined,
                placementBedId: canAdjustPlanting && isFieldPlantingTask && bedId ? Number(bedId) : undefined,
                placementPlantCount: canAdjustPlanting && isFieldPlantingTask ? recordedPlantCount : undefined,
                placementBedLengthUsedM: canAdjustPlanting && isFieldPlantingTask ? calculatedBedLengthM ?? undefined : undefined,
                placementLocationDetail: canAdjustPlanting && isFieldPlantingTask ? "Placed from task record" : null,
                placementNotes: notes || null,
                bedMakingBedCount: canAdjustBedMaking ? recordedBedMakingCount : undefined,
                bedMakingBlockFull: canAdjustBedMaking ? bedMakingFullBlockActive : undefined,
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

        {canAdjustTraySeeding && (
          <>
            <label>
              <span>Trays seeded</span>
              <input
                value={trayCount}
                onChange={(event) => setTrayCount(event.target.value)}
                type="number"
                min="1"
                step="0.1"
              />
            </label>
            <label>
              <span>Cells per tray</span>
              <input
                value={cellsPerTray}
                onChange={(event) => setCellsPerTray(event.target.value)}
                type="number"
                min="1"
              />
            </label>
            <label>
              <span>Cells seeded</span>
              <input
                value={seedCellCount}
                onChange={(event) => setSeedCellCount(event.target.value)}
                type="number"
                min="1"
                placeholder={calculatedSeedCellCount == null ? undefined : String(calculatedSeedCellCount)}
              />
            </label>
          </>
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
                      max="500"
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
                Use full block
              </button>
            </div>
            <div className="instruction-box full-span">
              <strong>{taskBlock?.name ?? "Block"}:</strong> {taskBlockPlantableBeds.length} mapped beds now. Recording {recordedBedMakingCount || "—"} beds.
              {bedMakingFullBlockActive
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
        <button className="primary-button full-span">Record actual work and recalculate tasks</button>
      </form>
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
  const hasBedMaking = blockBeds.length > 0 || hasLocationWorkEvent(locationEvents, ["Bed making"], ["bed_making"], []);
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
  selectedPlantingId,
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
  selectedPlantingId?: number | null;
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
  const [workPlantingId, setWorkPlantingId] = useState("");
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
  const hasExistingBeds = existingBeds.length > 0;
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
  const showApplicationBedPicker = workType === "Fertilizing / spraying" && blockBeds.length > 0;
  const showWorkBedPicker = showApplicationBedPicker || showTransplantFields || showCultivationFields;
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
  const selectedWorkBedIdSet = new Set(selectedCultivationBedIds);
  const selectedWorkBeds = blockBeds.filter((item) => selectedWorkBedIdSet.has(item.id));
  const selectedApplicationBedAreaSqM = showApplicationBedPicker && selectedWorkBeds.length > 0
    ? selectedWorkBeds.reduce((total, item) => total + (toNumericValue(item.areaSqM) ?? 0), 0)
    : null;
  const selectedAreaSqM = pendingWorkAreaSqM
    ?? selectedApplicationBedAreaSqM
    ?? toNumericValue(bed?.areaSqM ?? zone?.areaSqM ?? block?.areaSqM ?? field?.areaSqM ?? null);
  const selectedAreaAcres = selectedAreaSqM == null ? null : selectedAreaSqM / 4046.8564224;
  const applicationUnitLabel = applicationUnit.trim() || "units";
  const applicationProductLabel = workType === "Covercrop" ? "Seed used" : "Product used";
  const blockPlantingOptions = useMemo(() => {
    if (!block) {
      return [] as Planting[];
    }
    const blockBedIds = new Set(blockBeds.map((item) => item.id));
    const plantingIds = new Set<number>();
    for (const planting of plantings) {
      if (
        planting.intendedBlockId === block.id
        || (planting.intendedBedId != null && blockBedIds.has(planting.intendedBedId))
      ) {
        plantingIds.add(planting.id);
      }
    }
    for (const placement of placements) {
      if (blockBedIds.has(placement.bedId)) {
        plantingIds.add(placement.plantingId);
      }
    }
    return plantings
      .filter((planting) => plantingIds.has(planting.id))
      .sort((left, right) => {
        const leftDate = plantingGroundStartDate(left) ?? "9999-12-31";
        const rightDate = plantingGroundStartDate(right) ?? "9999-12-31";
        if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
        return left.title.localeCompare(right.title);
      });
  }, [block, blockBeds, placements, plantings]);
  const selectedWorkPlanting = workPlantingId
    ? blockPlantingOptions.find((planting) => String(planting.id) === workPlantingId) ?? null
    : null;
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
    const selectedMapPlanting = selectedPlantingId == null
      ? null
      : blockPlantingOptions.find((planting) => planting.id === selectedPlantingId) ?? null;
    setWorkPlantingId(selectedMapPlanting ? String(selectedMapPlanting.id) : "");
  }, [blockPlantingOptions, selectedPlantingId, workLocationKey]);

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
    if (!hasExistingBeds && bedMakingReplaceExisting) {
      setBedMakingReplaceExisting(false);
      return;
    }
    if (!bedMakingReplaceExisting) {
      setBedMakingStartNumber(existingBeds.length + 1);
    }
  }, [bedMakingReplaceExisting, existingBeds.length, hasExistingBeds]);

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
    if (!showWorkBedPicker && bedPickActive) {
      onBedPickActiveChange(false);
    }
  }, [bedPickActive, onBedPickActiveChange, showWorkBedPicker]);

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
      setStatus(bedLineMode === "straight" ? "Choose the begining of first bed first." : "Pick the bed line points first.");
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
      setStatus("Harvest roads need a bed interval and a road width above zero.");
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
          : showApplicationBedPicker && selectedCultivationBedIds.length > 0
            ? `${resolvedWorkSubcategory || finalWorkType} in ${selectedCultivationBedIds.length} bed${selectedCultivationBedIds.length === 1 ? "" : "s"}`
          : showCultivationFields
            ? `Cultivated ${selectedCultivationBedIds.length} bed${selectedCultivationBedIds.length === 1 ? "" : "s"}`
            : selectedWorkPlanting
              ? `${resolvedWorkSubcategory || finalWorkType}: ${selectedWorkPlanting.title}`
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
        plantingId: selectedWorkPlanting?.id ?? selectedTransplantPlanting?.id ?? null,
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
        applicationBedIds: showApplicationBedPicker ? selectedCultivationBedIds : [],
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
      setWorkPlantingId("");
      setTransplantPlantingId("");
      setTransplantPlantCount("");
      setTransplantTrayCount("");
      setTransplantInRowSpacing("");
      setTransplantRowsPerBed("");
      setNotes("");
      if (showWorkBedPicker) {
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
        {blockPlantingOptions.length > 0 && (
          <label>
            <span>Crop target</span>
            <select value={workPlantingId} onChange={(event) => setWorkPlantingId(event.target.value)}>
              <option value="">Block (not planting based)</option>
              {blockPlantingOptions.map((planting) => (
                <option key={planting.id} value={planting.id}>
                  {planting.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>Work type</span>
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
            {showApplicationBedPicker && (
              <WorkBedPicker
                beds={blockBeds}
                selectedBedIds={selectedCultivationBedIds}
                bedPickActive={bedPickActive}
                pickLabel="Pick application beds on map"
                pickingLabel="Picking application beds"
                onBedPickActiveChange={onBedPickActiveChange}
                onSelectedBedIdsChange={onSelectedCultivationBedIdsChange}
              />
            )}
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
                    {isPickingEdge ? "Stop selecting" : "Begining of first bed"}
                  </button>
                  <p className="muted full-span">where planting starts</p>
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
                    Use full block
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
                    disabled={!hasExistingBeds}
                    onChange={(event) => {
                      const nextValue = event.target.value === "true";
                      setBedMakingReplaceExisting(nextValue);
                      setBedMakingStartNumber(nextValue ? 1 : existingBeds.length + 1);
                    }}
                  >
                    <option value="false">{hasExistingBeds ? "Keep existing beds" : "No existing beds"}</option>
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
                    <span>Leave gaps for roads while generating beds</span>
                  </label>
                  <div className="form-grid">
                    <label>
                      <span>Road after every __ beds</span>
                      <input value={bedMakingHarvestRoadEveryBeds} onChange={(event) => setBedMakingHarvestRoadEveryBeds(event.target.value)} type="number" min="1" disabled={!bedMakingHarvestRoadsEnabled} />
                    </label>
                    <label>
                      <span>Road width in bed spaces</span>
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

export default App;
