import { defaultTractorAccentColor, isTractorModel, isTractorTask, tractorModelForTask } from "./tractor-icons";
import { defaultVehicleAccentColor, vehicleModelForTask } from "./vehicle-icons";

export type CachedSpriteKind = "tractor" | "vehicle";

export type SpriteSheetRequest = {
  kind: CachedSpriteKind;
  bodyColor: string;
  accentColor: string;
};

type CacheEntry = {
  url: string | null;
  promise: Promise<void> | null;
};

const TRACTOR_ASSETS = {
  base: "/assets/tractors-base.png?v=9",
  bodyMask: "/assets/tractors-body-mask.png?v=9",
  accentMask: "/assets/tractors-accent-mask.png?v=9",
  backingMask: "/assets/tractors-backing-mask.png?v=9",
  innerMask: "/assets/tractors-inner-mask.png?v=9"
};

const VEHICLE_ASSETS = {
  base: "/assets/vehicles-base.png?v=2",
  bodyMask: "/assets/vehicles-body-mask.png?v=2",
  accentMask: "/assets/vehicles-accent-mask.png?v=2"
};

const SPRITE_CACHE_VERSION = "solid-paint-v2";
const cache = new Map<string, CacheEntry>();
const listeners = new Set<() => void>();

export function spriteSheetRequestForTask(
  taskType: string,
  bodyColor: string,
  accentColor: string | null | undefined,
  selectedModel: string | null | undefined
): SpriteSheetRequest {
  const model = selectedModel || (isTractorTask(taskType) ? tractorModelForTask(taskType) : vehicleModelForTask(taskType));
  if (isTractorModel(model)) {
    return {
      kind: "tractor",
      bodyColor,
      accentColor: accentColor || defaultTractorAccentColor()
    };
  }

  return {
    kind: "vehicle",
    bodyColor,
    accentColor: accentColor || defaultVehicleAccentColor()
  };
}

export function subscribeSpriteSheetCache(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCachedSpriteSheetUrl(request: SpriteSheetRequest) {
  return cache.get(spriteSheetCacheKey(request))?.url ?? null;
}

export function preloadSpriteSheets(requests: SpriteSheetRequest[]) {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  for (const request of requests) {
    preloadSpriteSheet(request);
  }
}

function preloadSpriteSheet(request: SpriteSheetRequest) {
  const key = spriteSheetCacheKey(request);
  const existing = cache.get(key);
  if (existing?.url || existing?.promise) {
    return;
  }

  const entry: CacheEntry = { url: null, promise: null };
  cache.set(key, entry);
  entry.promise = buildSpriteSheet(request)
    .then((url) => {
      entry.url = url;
      entry.promise = null;
      notifyListeners();
    })
    .catch(() => {
      cache.delete(key);
    });
}

function notifyListeners() {
  for (const listener of listeners) {
    listener();
  }
}

function spriteSheetCacheKey(request: SpriteSheetRequest) {
  return `${SPRITE_CACHE_VERSION}|${request.kind}|${normalizeColor(request.bodyColor)}|${normalizeColor(request.accentColor)}`;
}

function normalizeColor(color: string) {
  return normalizePaintColor(color).trim().toLowerCase();
}

function normalizePaintColor(color: string) {
  const normalized = color.trim().toLowerCase();
  if (normalized === "#e8e8df" || normalized === "#f5f1df") {
    return "#ffffff";
  }
  return color;
}

async function buildSpriteSheet(request: SpriteSheetRequest) {
  const assets = request.kind === "tractor" ? TRACTOR_ASSETS : VEHICLE_ASSETS;
  const [base, bodyMask, accentMask] = await Promise.all([
    loadImage(assets.base),
    loadImage(assets.bodyMask),
    loadImage(assets.accentMask)
  ]);

  const width = base.naturalWidth || base.width;
  const height = base.naturalHeight || base.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas is unavailable");
  }

  if (request.kind === "tractor") {
    const tractorAssets = assets as typeof TRACTOR_ASSETS;
    const [backingMask, innerMask] = await Promise.all([
      loadImage(tractorAssets.backingMask),
      loadImage(tractorAssets.innerMask)
    ]);
    drawSolidMask(context, backingMask, "rgba(255, 246, 218, 0.9)", width, height);
    drawSolidMask(context, innerMask, "rgba(18, 20, 18, 0.9)", width, height);
  }

  context.drawImage(base, 0, 0, width, height);
  drawSolidMask(context, bodyMask, normalizePaintColor(request.bodyColor), width, height);
  drawSolidMask(context, accentMask, normalizePaintColor(request.accentColor), width, height);

  return canvasToObjectUrl(canvas);
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load ${src}`));
    image.src = src;
  });
}

function drawSolidMask(
  context: CanvasRenderingContext2D,
  mask: HTMLImageElement,
  color: string,
  width: number,
  height: number
) {
  const maskCanvas = tintedMaskCanvas(mask, color, width, height);
  context.drawImage(maskCanvas, 0, 0, width, height);
}

function drawColorMask(
  context: CanvasRenderingContext2D,
  mask: HTMLImageElement,
  color: string,
  width: number,
  height: number
) {
  const maskCanvas = tintedMaskCanvas(mask, color, width, height);
  context.save();
  context.globalCompositeOperation = "color";
  context.drawImage(maskCanvas, 0, 0, width, height);
  context.restore();
}

function tintedMaskCanvas(mask: HTMLImageElement, color: string, width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas is unavailable");
  }

  context.drawImage(mask, 0, 0, width, height);
  context.globalCompositeOperation = "source-in";
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return canvas;
}

function canvasToObjectUrl(canvas: HTMLCanvasElement) {
  return new Promise<string>((resolve) => {
    if (!canvas.toBlob || !URL.createObjectURL) {
      resolve(canvas.toDataURL("image/png"));
      return;
    }

    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(canvas.toDataURL("image/png"));
        return;
      }
      resolve(URL.createObjectURL(blob));
    }, "image/png");
  });
}
