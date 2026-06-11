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

const taskTypeLabels: Record<string, string> = {
  seed_in_tray: "seed in tray",
  direct_seed: "direct seed",
  till: "till",
  fertilizing_spraying: "fertilizing / spraying",
  bed_making: "bed making",
  transplant: "transplanting",
  cultivation: "cultivation",
  cleanup: "cleanup",
  cover_crop: "covercrop",
  bed_prep: "bed making",
  cultivate: "cultivation",
  weed: "weed",
  mow: "mow",
  thin: "thin",
  harvest: "harvest",
  finish_crop: "finish crop",
  irrigation_check: "irrigation check"
};

export function formatTaskTypeLabel(taskType: string) {
  return taskTypeLabels[taskType] ?? sentenceCase(taskType);
}

export function formatTaskAnchorLabel(anchor: string) {
  if (anchor.startsWith("after:")) {
    return `after ${anchor.slice("after:".length).split(",").filter(Boolean).join(", ")}`;
  }

  return sentenceCase(anchor);
}

export function taskIconColor(taskType: string) {
  if (taskType === "cultivation" || taskType === "cultivate" || taskType === "weed" || taskType === "mow") return "#d98c2b";
  if (taskType === "transplant") return "#4f9b58";
  if (taskType === "direct_seed" || taskType === "seed_in_tray") return "#7c9f35";
  if (taskType === "harvest") return "#c6503f";
  if (taskType === "bed_making" || taskType === "bed_prep" || taskType === "till") return "#8b6f43";
  if (taskType === "fertilizing_spraying") return "#5f8f4f";
  if (taskType === "cleanup" || taskType === "cover_crop") return "#6d7f45";
  return "#4f84aa";
}

export function taskColor(task: Pick<Task, "taskType" | "iconColor">) {
  return task.iconColor || taskIconColor(task.taskType);
}
