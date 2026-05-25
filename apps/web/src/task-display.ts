import { Task } from "./types";

// Task labels and 8-bit map-icon choices are shared by the map, task list, and flow editor.
// Keeping them here prevents each screen from inventing slightly different wording or colors.
export const taskTypeOptions = [
  "seed_in_tray",
  "direct_seed",
  "bed_prep",
  "transplant",
  "cultivate",
  "weed",
  "mow",
  "thin",
  "harvest",
  "finish_crop",
  "irrigation_check"
] as const;

export const taskAnchorOptions = [
  "planned_sow",
  "actual_tray_seeding",
  "actual_direct_seeding",
  "planned_transplant",
  "actual_transplant",
  "actual_cultivation",
  "actual_harvest"
] as const;

function sentenceCase(input: string) {
  return input.replaceAll("_", " ");
}

export function formatTaskTypeLabel(taskType: string) {
  return sentenceCase(taskType);
}

export function formatTaskAnchorLabel(anchor: string) {
  return sentenceCase(anchor);
}

export function taskIconColor(taskType: string) {
  if (taskType === "cultivate" || taskType === "weed" || taskType === "mow") return "#d98c2b";
  if (taskType === "transplant") return "#4f9b58";
  if (taskType === "direct_seed" || taskType === "seed_in_tray") return "#7c9f35";
  if (taskType === "harvest") return "#c6503f";
  if (taskType === "bed_prep") return "#8b6f43";
  return "#4f84aa";
}

export function taskColor(task: Pick<Task, "taskType" | "iconColor">) {
  return task.iconColor || taskIconColor(task.taskType);
}
