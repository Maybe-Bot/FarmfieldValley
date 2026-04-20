// Tractor sprite helpers. The source art is split into three stacked layers:
// base details, a body-paint mask, and an accent-paint mask.
export const tractorPrimaryFrame = "three-quarter";

export function isTractorTask(taskType: string) {
  return taskType === "cultivate" || taskType === "weed" || taskType === "bed_prep";
}

export function defaultTractorAccentColor() {
  return "#f4c430";
}

export function tractorModelForTask(taskType: string) {
  return taskType === "weed" ? "open" : "cab";
}

export function tractorFrameForBearing(bearingDegrees: number | null | undefined) {
  if (bearingDegrees == null || !Number.isFinite(bearingDegrees)) {
    return { frame: tractorPrimaryFrame, flipped: false };
  }

  const normalized = ((bearingDegrees % 360) + 360) % 360;
  const eastWestDistance = Math.min(Math.abs(normalized), Math.abs(normalized - 180));
  const northSouthDistance = Math.min(Math.abs(normalized - 90), Math.abs(normalized - 270));
  if (eastWestDistance < 24) {
    return { frame: "side", flipped: normalized < 90 || normalized > 270 };
  }
  if (northSouthDistance < 24) {
    return { frame: "front", flipped: false };
  }
  return { frame: "three-quarter", flipped: normalized < 90 || normalized > 270 };
}

export function tractorSpriteStyle(
  bodyColor: string,
  accentColor: string,
  options: { bearing?: number | null; animated?: boolean; scale?: number; model?: string } = {}
) {
  const frame = tractorFrameForBearing(options.bearing);
  const classes = [
    "tractor-sprite",
    `tractor-frame-${frame.frame}`,
    `tractor-model-${options.model === "open" ? "open" : "cab"}`,
    frame.flipped ? "flipped" : "",
    options.animated ? "animated" : ""
  ].filter(Boolean).join(" ");
  const scale = options.scale ?? 1;
  const styleVars = {
    "--tractor-body": bodyColor,
    "--tractor-accent": accentColor,
    "--tractor-bearing": `${options.bearing ?? 0}deg`,
    "--tractor-scale": scale
  };
  return {
    classes,
    styleVars,
    style: [
      `--tractor-body: ${styleVars["--tractor-body"]}`,
      `--tractor-accent: ${styleVars["--tractor-accent"]}`,
      `--tractor-bearing: ${styleVars["--tractor-bearing"]}`,
      `--tractor-scale: ${styleVars["--tractor-scale"]}`
    ].join("; ")
  };
}

export function tractorSpriteHtml(
  bodyColor: string,
  accentColor: string,
  options: { bearing?: number | null; animated?: boolean; scale?: number; model?: string } = {}
) {
  const sprite = tractorSpriteStyle(bodyColor, accentColor, options);
  return `
    <span class="tractor-runway">
      <span class="${sprite.classes}" style="${sprite.style}">
        <span class="tractor-layer tractor-body"></span>
        <span class="tractor-layer tractor-accent"></span>
        <span class="tractor-layer tractor-base"></span>
      </span>
    </span>
  `;
}
