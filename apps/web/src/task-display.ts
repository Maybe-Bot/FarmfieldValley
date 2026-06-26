import { Task } from "./types";

// Task labels and 8-bit map-icon choices are shared by the map, task list, and flow editor.
// Keeping them here prevents each screen from inventing slightly different wording or colors.
export const taskTypeOptions = [
  "seed_in_tray",
  "direct_seed",
  "till",
  "fertilizing_spraying",
  "bed_making",
  "transplant",
  "cultivation",
  "cleanup",
  "cover_crop"
] as const;

export const legacyTaskTypeOptions = [
  "bed_prep",
  "cultivate",
  "weed",
  "mow",
  "thin",
  "harvest",
  "finish_crop",
  "irrigation_check"
] as const;

export function isCurrentTaskType(taskType: string) {
  return (taskTypeOptions as readonly string[]).includes(taskType);
}

export function isLegacyTaskType(taskType: string) {
  return (legacyTaskTypeOptions as readonly string[]).includes(taskType);
}

export function staleTaskTypeMessage(taskType: string) {
  return isLegacyTaskType(taskType)
    ? `Old category "${taskType}". Change this to a current category before using it.`
    : `Unknown category "${taskType}". Change this to a current category before using it.`;
}

function sentenceCase(input: string) {
  return input.replaceAll("_", " ");
}

const taskTypeLabels: Record<string, string> = {
  seed_in_tray: "seed in tray",
  direct_seed: "direct seed",
  till: "till",
  fertilizing_spraying: "fertilizing / spraying",
  bed_making: "bed making",
  transplant: "transplanting",
  cultivation: "cultivation",
  cleanup: "cleanup",
  cover_crop: "cover crop"
};

const taskAnchorLabels: Record<string, string> = {
  planned_sow: "seeding date"
};

export function formatTaskTypeLabel(taskType: string) {
  if (!isCurrentTaskType(taskType)) {
    return `stale: ${sentenceCase(taskType)}`;
  }
  return taskTypeLabels[taskType] ?? sentenceCase(taskType);
}

export function formatTaskAnchorLabel(anchor: string) {
  if (anchor.startsWith("after:")) {
    return `after ${anchor.slice("after:".length).split(",").filter(Boolean).join(", ")}`;
  }

  return taskAnchorLabels[anchor] ?? `stale: ${sentenceCase(anchor)}`;
}

export function taskIconColor(taskType: string) {
  if (!isCurrentTaskType(taskType)) return "#b42318";
  if (taskType === "cultivation") return "#d98c2b";
  if (taskType === "transplant") return "#4f9b58";
  if (taskType === "direct_seed" || taskType === "seed_in_tray") return "#7c9f35";
  if (taskType === "bed_making" || taskType === "till") return "#8b6f43";
  if (taskType === "fertilizing_spraying") return "#5f8f4f";
  if (taskType === "cleanup" || taskType === "cover_crop") return "#6d7f45";
  return "#4f84aa";
}

export function taskColor(task: Pick<Task, "taskType" | "iconColor">) {
  return task.iconColor || taskIconColor(task.taskType);
}
