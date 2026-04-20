/**
 * Shared backend enum-like TypeScript types.
 *
 * These string unions mirror database/check-constraint values and frontend
 * dropdown options. Keep them in sync with migrations and apps/web/src/types.ts.
 */
export type TaskAnchor =
  | "planned_sow"
  | "actual_tray_seeding"
  | "actual_direct_seeding"
  | "planned_transplant"
  | "actual_transplant"
  | "actual_cultivation"
  | "actual_harvest";

export const taskAnchors: TaskAnchor[] = [
  "planned_sow",
  "actual_tray_seeding",
  "actual_direct_seeding",
  "planned_transplant",
  "actual_transplant",
  "actual_cultivation",
  "actual_harvest"
];

export type TaskType =
  | "seed_in_tray"
  | "direct_seed"
  | "bed_prep"
  | "transplant"
  | "cultivate"
  | "weed"
  | "thin"
  | "harvest"
  | "finish_crop"
  | "irrigation_check";

export const taskTypes: TaskType[] = [
  "seed_in_tray",
  "direct_seed",
  "bed_prep",
  "transplant",
  "cultivate",
  "weed",
  "thin",
  "harvest",
  "finish_crop",
  "irrigation_check"
];

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
