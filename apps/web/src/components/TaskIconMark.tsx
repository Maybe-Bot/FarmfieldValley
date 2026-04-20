import { CSSProperties } from "react";
import { taskIconLetter } from "../task-display";
import { defaultTractorAccentColor, isTractorTask, tractorModelForTask, tractorSpriteStyle } from "../tractor-icons";

// Shared small task icon for lists and flow cards. Tractor tasks use the
// recolorable sprite; non-tractor tasks keep the compact letter badge.
export function TaskIconMark({
  taskType,
  color,
  secondaryColor,
  mini = false
}: {
  taskType: string;
  color: string;
  secondaryColor?: string | null;
  mini?: boolean;
}) {
  if (isTractorTask(taskType)) {
    const sprite = tractorSpriteStyle(color, secondaryColor || defaultTractorAccentColor(), {
      scale: mini ? 0.32 : 0.42,
      model: tractorModelForTask(taskType)
    });
    return (
      <span className={mini ? "task-tractor-icon-mini" : "task-tractor-icon-mini"}>
        <span className="tractor-runway">
          <span className={sprite.classes} style={sprite.styleVars as CSSProperties}>
            <span className="tractor-layer tractor-body"></span>
            <span className="tractor-layer tractor-accent"></span>
            <span className="tractor-layer tractor-base"></span>
          </span>
        </span>
      </span>
    );
  }

  return (
    <span className={`task-map-icon${mini ? " mini" : ""}`} style={{ "--task-icon-color": color } as CSSProperties}>
      <span>{taskIconLetter(taskType)}</span>
    </span>
  );
}
