export type VehicleModel = "pickup" | "box" | "van";

export function isVehicleModel(model: string | null | undefined): model is VehicleModel {
  return model === "pickup" || model === "box" || model === "van";
}

export function vehicleModelForTask(taskType: string): VehicleModel {
  if (taskType === "harvest") {
    return "box";
  }
  if (taskType === "transplant" || taskType === "finish_crop" || taskType === "irrigation_check") {
    return "van";
  }
  return "pickup";
}

export function defaultVehicleAccentColor() {
  return "#f2d6aa";
}

function normalizePaintColor(color: string) {
  const normalized = color.trim().toLowerCase();
  if (normalized === "#e8e8df" || normalized === "#f5f1df") {
    return "#ffffff";
  }
  return color;
}

function vehicleFrameForBearing(bearingDegrees: number | null | undefined) {
  if (bearingDegrees == null || !Number.isFinite(bearingDegrees)) {
    return { frame: "side" as const, flipped: false };
  }

  const normalized = ((bearingDegrees % 360) + 360) % 360;
  const eastWestDistance = Math.min(Math.abs(normalized), Math.abs(normalized - 180));
  const northDistance = Math.abs(normalized - 90);
  const southDistance = Math.abs(normalized - 270);
  if (eastWestDistance < 24) {
    return { frame: "side" as const, flipped: normalized > 90 && normalized < 270 };
  }
  if (northDistance < 24) {
    return { frame: "front" as const, flipped: false };
  }
  if (southDistance < 24) {
    return { frame: "rear" as const, flipped: false };
  }
  return { frame: "three-quarter" as const, flipped: normalized > 90 && normalized < 270 };
}

function vehicleDisplayBearing(bearingDegrees: number | null | undefined) {
  if (bearingDegrees == null || !Number.isFinite(bearingDegrees)) {
    return 0;
  }

  const normalized = ((bearingDegrees % 360) + 360) % 360;
  return normalized > 90 && normalized <= 270 ? normalized - 180 : normalized;
}

export function vehicleSpriteStyle(
  bodyColor: string,
  accentColor: string,
  options: { bearing?: number | null; animated?: boolean; scale?: number; model?: VehicleModel | string; frame?: "front" | "three-quarter" | "side" | "rear"; runDistancePx?: number; runDurationSec?: number; animationDelaySec?: number; spriteSheetUrl?: string | null } = {}
) {
  const model: VehicleModel =
    options.model === "box" || options.model === "van" || options.model === "pickup"
      ? options.model
      : "pickup";
  const bearingFrame = vehicleFrameForBearing(options.bearing);
  const frame = options.frame ?? bearingFrame.frame;
  const scale = options.scale ?? 1;
  const runDistancePx = Math.max(28, Math.round(options.runDistancePx ?? 44));
  const classes = [
    "vehicle-sprite",
    `vehicle-frame-${frame}`,
    `vehicle-model-${model}`,
    bearingFrame.flipped ? "flipped" : "",
    options.animated ? "animated" : ""
  ].filter(Boolean).join(" ");
  const runDurationSec = Number.isFinite(options.runDurationSec) ? Math.max(4, Math.min(18, options.runDurationSec ?? 9.5)) : 9.5;
  const animationDelaySec = Number.isFinite(options.animationDelaySec) ? options.animationDelaySec ?? 0 : 0;
  const styleVars = {
    "--vehicle-body": normalizePaintColor(bodyColor),
    "--vehicle-accent": normalizePaintColor(accentColor),
    "--vehicle-bearing": `${vehicleDisplayBearing(options.bearing)}deg`,
    "--vehicle-scale": scale,
    "--vehicle-run-distance": `${runDistancePx}px`,
    "--vehicle-runway-length": `${Math.max(84, runDistancePx * 2 + 96)}px`,
    "--vehicle-run-duration": `${runDurationSec.toFixed(2)}s`,
    "--vehicle-run-delay": `${animationDelaySec.toFixed(2)}s`
  };
  return {
    classes,
    styleVars,
    style: [
      `--vehicle-body: ${styleVars["--vehicle-body"]}`,
      `--vehicle-accent: ${styleVars["--vehicle-accent"]}`,
      `--vehicle-bearing: ${styleVars["--vehicle-bearing"]}`,
      `--vehicle-scale: ${styleVars["--vehicle-scale"]}`,
      `--vehicle-run-distance: ${styleVars["--vehicle-run-distance"]}`,
      `--vehicle-runway-length: ${styleVars["--vehicle-runway-length"]}`,
      `--vehicle-run-duration: ${styleVars["--vehicle-run-duration"]}`,
      `--vehicle-run-delay: ${styleVars["--vehicle-run-delay"]}`
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

export function vehicleSpriteHtml(
  bodyColor: string,
  accentColor: string,
  options: { bearing?: number | null; animated?: boolean; scale?: number; model?: VehicleModel | string; frame?: "front" | "three-quarter" | "side" | "rear"; runDistancePx?: number; runDurationSec?: number; animationDelaySec?: number; spriteSheetUrl?: string | null } = {}
) {
  const sprite = vehicleSpriteStyle(bodyColor, accentColor, options);
  if (options.spriteSheetUrl) {
    return `
      <span class="vehicle-runway" style="${sprite.style}">
        <span class="${sprite.classes} cached-sprite" style="${sprite.style}">
          <span class="vehicle-layer vehicle-flat" style="background-image: url('${escapeHtmlAttribute(options.spriteSheetUrl)}')"></span>
        </span>
      </span>
    `;
  }

  return `
    <span class="vehicle-runway" style="${sprite.style}">
      <span class="${sprite.classes}" style="${sprite.style}">
        <span class="vehicle-layer vehicle-base"></span>
        <span class="vehicle-layer vehicle-body"></span>
        <span class="vehicle-layer vehicle-accent"></span>
      </span>
    </span>
  `;
}
