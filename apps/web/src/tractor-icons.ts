// Tractor sprite helpers. The source art uses three model rows and four angle
// columns, with generated masks layered over the base art for recoloring.
export type TractorModel = "cab" | "canopy" | "open";
export const tractorPrimaryFrame = "side";

export function isTractorModel(model: string | null | undefined): model is TractorModel {
  return model === "cab" || model === "canopy" || model === "open";
}

export function isTractorTask(taskType: string) {
  return [
    "till",
    "fertilizing_spraying",
    "bed_making",
    "cultivation",
    "cleanup",
    "cover_crop"
  ].includes(taskType);
}

export function defaultTractorAccentColor() {
  return "#f4c430";
}

export function tractorModelForTask(taskType: string): TractorModel {
  if (taskType === "bed_making" || taskType === "till" || taskType === "fertilizing_spraying") {
    return "cab";
  }
  if (taskType === "cultivation") {
    return "canopy";
  }
  return "open";
}

export function tractorFrameForBearing(bearingDegrees: number | null | undefined) {
  if (bearingDegrees == null || !Number.isFinite(bearingDegrees)) {
    return { frame: tractorPrimaryFrame, flipped: false };
  }

  const normalized = ((bearingDegrees % 360) + 360) % 360;
  const eastWestDistance = Math.min(Math.abs(normalized), Math.abs(normalized - 180));
  const northDistance = Math.abs(normalized - 90);
  const southDistance = Math.abs(normalized - 270);
  if (eastWestDistance < 24) {
    return { frame: "side", flipped: normalized > 90 && normalized < 270 };
  }
  if (northDistance < 24) {
    return { frame: "front", flipped: false };
  }
  if (southDistance < 24) {
    return { frame: "rear", flipped: false };
  }
  return { frame: "three-quarter", flipped: normalized > 90 && normalized < 270 };
}

function tractorDisplayBearing(bearingDegrees: number | null | undefined) {
  if (bearingDegrees == null || !Number.isFinite(bearingDegrees)) {
    return 0;
  }

  const normalized = ((bearingDegrees % 360) + 360) % 360;
  return normalized > 90 && normalized <= 270 ? normalized - 180 : normalized;
}

function normalizePaintColor(color: string) {
  const normalized = color.trim().toLowerCase();
  if (normalized === "#e8e8df" || normalized === "#f5f1df") {
    return "#ffffff";
  }
  return color;
}

export function tractorSpriteStyle(
  bodyColor: string,
  accentColor: string,
  options: { bearing?: number | null; animated?: boolean; oneWay?: boolean; scale?: number; model?: TractorModel | string; runDistancePx?: number; runDurationSec?: number; animationDelaySec?: number; spriteSheetUrl?: string | null } = {}
) {
  const frame = tractorFrameForBearing(options.bearing);
  const model: TractorModel =
    options.model === "canopy" || options.model === "open" || options.model === "cab"
      ? options.model
      : "cab";
  const runDistancePx = Math.max(28, Math.round(options.runDistancePx ?? 44));
  const classes = [
    "tractor-sprite",
    `tractor-frame-${frame.frame}`,
    `tractor-model-${model}`,
    frame.flipped ? "flipped" : "",
    options.animated ? "animated" : "",
    options.oneWay ? "one-way" : ""
  ].filter(Boolean).join(" ");
  const scale = options.scale ?? 1;
  const runDurationSec = Number.isFinite(options.runDurationSec) ? Math.max(4, Math.min(18, options.runDurationSec ?? 9.5)) : 9.5;
  const animationDelaySec = Number.isFinite(options.animationDelaySec) ? options.animationDelaySec ?? 0 : 0;
  const styleVars = {
    "--tractor-body": normalizePaintColor(bodyColor),
    "--tractor-accent": normalizePaintColor(accentColor),
    "--tractor-bearing": `${tractorDisplayBearing(options.bearing)}deg`,
    "--tractor-scale": scale,
    "--tractor-run-distance": `${runDistancePx}px`,
    "--tractor-runway-length": `${Math.max(84, runDistancePx * 2 + 96)}px`,
    "--tractor-run-duration": `${runDurationSec.toFixed(2)}s`,
    "--tractor-run-delay": `${animationDelaySec.toFixed(2)}s`
  };
  return {
    classes,
    styleVars,
    style: [
      `--tractor-body: ${styleVars["--tractor-body"]}`,
      `--tractor-accent: ${styleVars["--tractor-accent"]}`,
      `--tractor-bearing: ${styleVars["--tractor-bearing"]}`,
      `--tractor-scale: ${styleVars["--tractor-scale"]}`,
      `--tractor-run-distance: ${styleVars["--tractor-run-distance"]}`,
      `--tractor-runway-length: ${styleVars["--tractor-runway-length"]}`,
      `--tractor-run-duration: ${styleVars["--tractor-run-duration"]}`,
      `--tractor-run-delay: ${styleVars["--tractor-run-delay"]}`
    ].join("; ")
  };
}

function escapeHtmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function tractorSpriteHtml(
  bodyColor: string,
  accentColor: string,
  options: { bearing?: number | null; animated?: boolean; oneWay?: boolean; scale?: number; model?: TractorModel | string; runDistancePx?: number; runDurationSec?: number; animationDelaySec?: number; spriteSheetUrl?: string | null } = {}
) {
  const sprite = tractorSpriteStyle(bodyColor, accentColor, options);
  if (options.spriteSheetUrl) {
    return `
      <span class="tractor-runway" style="${sprite.style}">
        <span class="${sprite.classes} cached-sprite" style="${sprite.style}">
          <span class="tractor-layer tractor-flat" style="background-image: url('${escapeHtmlAttribute(options.spriteSheetUrl)}')"></span>
        </span>
      </span>
    `;
  }

  return `
    <span class="tractor-runway" style="${sprite.style}">
      <span class="${sprite.classes}" style="${sprite.style}">
        <span class="tractor-layer tractor-backing"></span>
        <span class="tractor-layer tractor-inner-fill"></span>
        <span class="tractor-layer tractor-base"></span>
        <span class="tractor-layer tractor-body"></span>
        <span class="tractor-layer tractor-accent"></span>
      </span>
    </span>
  `;
}
