import { CSSProperties } from "react";
import { defaultTractorAccentColor, isTractorModel, isTractorTask, tractorModelForTask, tractorSpriteStyle } from "../tractor-icons";
import { defaultVehicleAccentColor, isVehicleModel, vehicleModelForTask, vehicleSpriteStyle } from "../vehicle-icons";

// Shared small task icon for lists and flow cards. Tractor tasks use saved
// tractor sprites; the other task types use vehicle sprites from Trucks.png.
export function TaskIconMark({
  taskType,
  color,
  secondaryColor,
  tractorModel,
  mini = false,
  scale,
  spinning = false
}: {
  taskType: string;
  color: string;
  secondaryColor?: string | null;
  tractorModel?: string | null;
  mini?: boolean;
  scale?: number;
  spinning?: boolean;
}) {
  const model = tractorModel || (isTractorTask(taskType) ? tractorModelForTask(taskType) : vehicleModelForTask(taskType));
  const effectiveScale = scale ?? (mini ? 0.32 : 0.42);
  const iconBoxSize = `${Math.ceil(128 * effectiveScale)}px`;
  const iconBoxStyle = { "--icon-box-size": iconBoxSize } as CSSProperties;
  if (isTractorModel(model)) {
    const sprite = tractorSpriteStyle(color, secondaryColor || defaultTractorAccentColor(), {
      scale: effectiveScale,
      model
    });
    const tractorStyle = {
      ...sprite.styleVars,
      "--tractor-runway-length": iconBoxSize
    } as CSSProperties;
    return (
      <span className={`task-tractor-icon-mini${spinning ? " garage-spin" : ""}`} style={iconBoxStyle}>
        <span className="tractor-runway" style={tractorStyle}>
          <span className={sprite.classes} style={tractorStyle}>
            <span className="tractor-layer tractor-backing"></span>
            <span className="tractor-layer tractor-inner-fill"></span>
            <span className="tractor-layer tractor-base"></span>
            <span className="tractor-layer tractor-body"></span>
            <span className="tractor-layer tractor-accent"></span>
          </span>
        </span>
      </span>
    );
  }

  const sprite = vehicleSpriteStyle(color, secondaryColor || defaultVehicleAccentColor(), {
    scale: effectiveScale,
    model: isVehicleModel(model) ? model : vehicleModelForTask(taskType)
  });
  return (
    <span className={`task-vehicle-icon-mini${spinning ? " garage-spin" : ""}`} style={iconBoxStyle}>
      <span className="task-vehicle-icon" style={iconBoxStyle}>
        <span className={sprite.classes} style={sprite.styleVars as CSSProperties}>
          <span className="vehicle-layer vehicle-base"></span>
          <span className="vehicle-layer vehicle-body"></span>
          <span className="vehicle-layer vehicle-accent"></span>
        </span>
      </span>
    </span>
  );
}
