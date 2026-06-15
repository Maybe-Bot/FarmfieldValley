/**
 * Shared backend enum-like TypeScript types.
 *
 * These string unions mirror database/check-constraint values and frontend
 * dropdown options. Keep them in sync with migrations and apps/web/src/types.ts.
 */
export type TaskAnchor =
  | "planned_sow";

export const taskAnchors: TaskAnchor[] = [
  "planned_sow"
];

export type TaskType =
  | "seed_in_tray"
  | "direct_seed"
  | "till"
  | "fertilizing_spraying"
  | "bed_making"
  | "transplant"
  | "cultivation"
  | "cleanup"
  | "cover_crop";

export const taskTypes: TaskType[] = [
  "seed_in_tray",
  "direct_seed",
  "till",
  "fertilizing_spraying",
  "bed_making",
  "transplant",
  "cultivation",
  "cleanup",
  "cover_crop"
];

export const legacyTaskTypes = [
  "bed_prep",
  "cultivate",
  "weed",
  "mow",
  "thin",
  "harvest",
  "finish_crop",
  "irrigation_check"
] as const;

export function isCurrentTaskType(value: string): value is TaskType {
  return (taskTypes as readonly string[]).includes(value);
}

export function isLegacyTaskType(value: string) {
  return (legacyTaskTypes as readonly string[]).includes(value);
}

export type PlantingStatus =
  | "planned"
  | "seeded_in_tray"
  | "direct_seeded"
  | "germinating"
  | "ready_to_transplant"
  | "transplanted"
  | "growing"
  | "harvested"
  | "finished";

export type ActualEventType =
  | "tray_seeding"
  | "direct_seeding"
  | "transplant"
  | "cultivation"
  | "harvest"
  | "finish";

export type FarmRole = "planner" | "worker";

export const farmRoles: FarmRole[] = ["planner", "worker"];
