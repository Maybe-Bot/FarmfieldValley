import { LatLngTuple, latLngBounds, point as leafletPoint } from "leaflet";
import { type MutableRefObject, useEffect, useRef, useState } from "react";
import { TileLayer, useMap, useMapEvents } from "react-leaflet";
import { basemaps } from "../map-config";
import { CoordinateDraft } from "../map-geometry";
import { geoJsonPolygonToLatLngs } from "../map-utils";
import { Bed, Block, BlockZone, Field } from "../types";

type MapMode = "select" | "draw_field" | "draw_block" | "draw_zone" | "draw_zone_split" | "bed_tools" | "draw_bed_line" | "pick_bed_edge" | "edit";
type MapSelection = { type: "field" | "block" | "zone" | "bed"; id: number } | null;
type UserLocation = { lat: number; lng: number; accuracyM: number | null };
export type MapViewSnapshot = { center: LatLngTuple; zoom: number };

const VIEW_STORAGE_KEY = "loam-ledger-map-view";
const DEFAULT_CENTER: LatLngTuple = [40.0448, -76.2662];
const DEFAULT_ZOOM = 18;
const SELECTION_FOCUS_PADDING_PX = 96;
const SELECTION_FOCUS_ZOOM_OUT_STEPS = 1;
const SELECTION_FOCUS_ZOOM_TOLERANCE = 3;
const SELECTION_VISIBLE_PADDING = 0.35;

function isPointSelectionMapMode(mode: MapMode) {
  return ["draw_field", "draw_block", "draw_zone", "draw_zone_split", "draw_bed_line", "pick_bed_edge"].includes(mode);
}

export function MapDrawingEvents({
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

export function TutorialAutoScroll({ active, triggerKey }: { active: boolean; triggerKey: string }) {
  useEffect(() => {
    if (!active || typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    let animationFrame = 0;
    const timeout = window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>(".tutorial-target");
      if (!target) {
        return;
      }
      const rect = target.getBoundingClientRect();
      const startY = window.scrollY;
      const targetY = Math.max(0, startY + rect.top - ((window.innerHeight - rect.height) / 2));
      const distance = targetY - startY;
      if (Math.abs(distance) < 2) {
        return;
      }
      const durationMs = 1100;
      const startTime = window.performance.now();
      const easeInOutCubic = (value: number) => value < 0.5
        ? 4 * value * value * value
        : 1 - Math.pow(-2 * value + 2, 3) / 2;
      const step = (time: number) => {
        const progress = Math.min(1, (time - startTime) / durationMs);
        window.scrollTo(0, startY + distance * easeInOutCubic(progress));
        if (progress < 1) {
          animationFrame = window.requestAnimationFrame(step);
        }
      };
      animationFrame = window.requestAnimationFrame(step);
    }, 180);

    return () => {
      window.clearTimeout(timeout);
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [active, triggerKey]);

  return null;
}

export function MapLineDragEvents({
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

export function mapViewStorageKey(userId: number | null | undefined, farmId: number | null | undefined) {
  if (userId == null || farmId == null) {
    return VIEW_STORAGE_KEY;
  }

  return `${VIEW_STORAGE_KEY}:${userId}:${farmId}`;
}

// On first load, zoom to saved farm geometry unless the user already has a
// manually stored map position.
export function FitToFarm({
  fields,
  blocks,
  storageKey = VIEW_STORAGE_KEY
}: {
  fields: Field[];
  blocks: Block[];
  storageKey?: string;
}) {
  const map = useMap();
  const [hasFit, setHasFit] = useState(false);

  useEffect(() => {
    if (hasFit || hasStoredMapView(storageKey)) {
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
  }, [fields, blocks, hasFit, map, storageKey]);

  return null;
}

// When the user selects a field/block/zone/bed, center that object on screen.
export function FocusSelection({
  selection,
  fields,
  blocks,
  zones,
  beds,
  disabled = false,
  lastHandledSelectionKeyRef
}: {
  selection: MapSelection;
  fields: Field[];
  blocks: Block[];
  zones: BlockZone[];
  beds: Bed[];
  disabled?: boolean;
  lastHandledSelectionKeyRef?: MutableRefObject<string | null>;
}) {
  const map = useMap();
  const internalLastHandledSelectionKey = useRef<string | null>(null);
  const lastHandledSelectionKey = lastHandledSelectionKeyRef ?? internalLastHandledSelectionKey;
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
      const bounds = latLngBounds(points.map((point) => [point.lat, point.lng] as LatLngTuple));
      const padding = leafletPoint(SELECTION_FOCUS_PADDING_PX, SELECTION_FOCUS_PADDING_PX);
      const fitZoom = map.getBoundsZoom(bounds, false, padding);
      const targetZoom = Math.max(map.getMinZoom(), fitZoom - SELECTION_FOCUS_ZOOM_OUT_STEPS);
      const currentZoom = map.getZoom();
      const currentBounds = map.getBounds().pad(SELECTION_VISIBLE_PADDING);

      if (currentBounds.contains(bounds) && currentZoom >= targetZoom - SELECTION_FOCUS_ZOOM_TOLERANCE) {
        return;
      }

      map.fitBounds(bounds, {
        padding: [SELECTION_FOCUS_PADDING_PX, SELECTION_FOCUS_PADDING_PX],
        maxZoom: targetZoom
      });
    }
  }, [selection, selectionKey, fields, blocks, zones, beds, disabled, map, lastHandledSelectionKey]);

  return null;
}

// Centers the Leaflet map after the browser returns a phone GPS location.
export function FocusUserLocation({ location }: { location: UserLocation | null }) {
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
export function MapZoomTracker({ onZoomChange }: { onZoomChange: (zoom: number) => void }) {
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
export function ResponsiveBasemap() {
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
export function PersistMapView({
  storageKey = VIEW_STORAGE_KEY,
  onViewChange
}: {
  storageKey?: string;
  onViewChange?: (view: MapViewSnapshot) => void;
}) {
  const map = useMap();

  useEffect(() => {
    const persist = () => {
      const center = map.getCenter();
      const view: MapViewSnapshot = {
        center: [center.lat, center.lng],
        zoom: map.getZoom()
      };
      window.localStorage.setItem(storageKey, JSON.stringify(view));
      onViewChange?.(view);
    };

    map.on("moveend", persist);
    map.on("zoomend", persist);
    return () => {
      map.off("moveend", persist);
      map.off("zoomend", persist);
    };
  }, [map, onViewChange, storageKey]);

  return null;
}

export function hasStoredMapView(storageKey = VIEW_STORAGE_KEY) {
  if (typeof window === "undefined") {
    return false;
  }

  return Boolean(window.localStorage.getItem(storageKey));
}

export function readStoredMapView(storageKey = VIEW_STORAGE_KEY): MapViewSnapshot {
  if (typeof window === "undefined") {
    return { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM };
  }

  const raw = window.localStorage.getItem(storageKey);
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
