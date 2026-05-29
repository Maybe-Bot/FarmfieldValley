import { z } from "zod";
import { TaskAnchor, TaskType, taskAnchors, taskTypes } from "./types";

// Zod schemas define what each API route accepts. They are the first line of
// defense against malformed form/map data reaching the database.
export const plantingStatusSchema = z.enum([
  "planned",
  "seeded_in_tray",
  "direct_seeded",
  "germinating",
  "ready_to_transplant",
  "transplanted",
  "growing",
  "harvested",
  "finished"
]);

export const actualEventTypeSchema = z.enum([
  "tray_seeding",
  "direct_seeding",
  "transplant",
  "cultivation",
  "harvest",
  "finish"
]);

export const taskTypeSchema = z.enum(taskTypes as [TaskType, ...TaskType[]]);
export const taskAnchorSchema = z.enum(taskAnchors as [TaskAnchor, ...TaskAnchor[]]);
export const futureUseSchema = z.enum(["beds", "cover_crop"]);
export const zoneActualStateSchema = z.enum([
  "needs_cleanup",
  "needs_amendment",
  "needs_tillage",
  "ready_for_bed_making",
  "beds_made",
  "partially_planted",
  "fully_planted",
  "cover_crop_established",
  "finished"
]);

export const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180)
});

export const polygonSchema = z.object({
  coordinates: z.array(latLngSchema).min(3).max(50)
});

export const geometrySchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive()
});

export const plantingSchema = z
  .object({
    cropId: z.number(),
    varietyId: z.number().nullable().optional(),
    title: z.string().min(1),
    status: plantingStatusSchema,
    intendedFieldId: z.number().nullable().optional(),
    intendedBlockId: z.number().nullable().optional(),
    intendedBedId: z.number().nullable().optional(),
    seedItemId: z.number().nullable().optional(),
    taskFlowTemplateId: z.number().nullable().optional(),
    spacing: z.string().nullable().optional(),
    plantCount: z.number().int().positive().nullable().optional(),
    bedLengthUsedM: z.number().positive().nullable().optional(),
    trayLocation: z.string().nullable().optional(),
    trayCount: z.number().int().positive().nullable().optional(),
    cellsPerTray: z.number().int().positive().nullable().optional(),
    daysToHarvest: z.number().int().positive().nullable().optional(),
    fieldSpacingInRow: z.number().positive().nullable().optional(),
    rowSpacing: z.number().positive().nullable().optional(),
    rowsPerBed: z.number().int().positive().nullable().optional(),
    deadAtFrost: z.boolean().nullable().optional(),
    bedCover: z.enum(["plastic", "bare"]).nullable().optional(),
    notes: z.string().nullable().optional(),
    plannedSowDate: z.string().nullable().optional(),
    plannedTransplantDate: z.string().nullable().optional(),
    expectedHarvestStart: z.string().nullable().optional(),
    expectedHarvestEnd: z.string().nullable().optional()
  })
  .refine((value) => value.plantCount != null || value.bedLengthUsedM != null, {
    message: "Plant count or bed length used is required"
  });

export const placementSchema = z
  .object({
    bedId: z.number(),
    plantCount: z.number().int().positive().nullable().optional(),
    bedLengthUsedM: z.number().positive().nullable().optional(),
    actualDate: z.string().nullable().optional(),
    locationDetail: z.string().nullable().optional(),
    coordinates: z.array(latLngSchema).min(3).max(50).nullable().optional(),
    notes: z.string().nullable().optional()
  })
  .refine((value) => value.plantCount != null || value.bedLengthUsedM != null, {
    message: "Plant count or bed length used is required"
  });

export const actualEventSchema = z.object({
  eventType: actualEventTypeSchema,
  actualDate: z.string(),
  notes: z.string().nullable().optional()
});

export const taskRecordSchema = z.object({
  actualDate: z.string(),
  notes: z.string().nullable().optional(),
  lotNumber: z.string().trim().max(160).nullable().optional(),
  intendedBedId: z.number().nullable().optional(),
  plantCount: z.number().int().positive().nullable().optional(),
  bedLengthUsedM: z.number().positive().nullable().optional(),
  spacing: z.string().nullable().optional(),
  placementBedId: z.number().nullable().optional(),
  placementPlantCount: z.number().int().positive().nullable().optional(),
  placementBedLengthUsedM: z.number().positive().nullable().optional(),
  placementLocationDetail: z.string().nullable().optional(),
  placementCoordinates: z.array(latLngSchema).min(3).max(50).nullable().optional(),
  placementNotes: z.string().nullable().optional(),
  bedMakingBedCount: z.number().int().positive().max(100).nullable().optional(),
  bedMakingMode: z.enum(["replace_existing", "add_after_existing"]).nullable().optional(),
  bedMakingBlockFull: z.boolean().nullable().optional(),
  bedMakingRows: z.array(z.object({
    presetId: z.number().int().positive(),
    count: z.number().int().positive().max(100)
  })).max(20).optional()
}).refine((value) => {
  if (value.placementBedId == null) {
    return true;
  }

  return value.placementPlantCount != null || value.placementBedLengthUsedM != null;
}, {
  message: "Placement needs plant count or bed length used"
}).refine((value) => {
  if (value.bedMakingMode == null && value.bedMakingBlockFull == null && value.bedMakingRows == null) {
    return true;
  }

  return value.bedMakingBedCount != null || (value.bedMakingRows != null && value.bedMakingRows.length > 0);
}, {
  message: "Bed making needs the number of beds made"
});

export const blockPlacementPlanRowSchema = z.object({
  kind: z.enum(["planting", "gap"]),
  plantingId: z.number().int().positive().nullable().optional(),
  bedLengthUsedM: z.number().positive(),
  plantCount: z.number().int().positive().nullable().optional(),
  trayCount: z.number().int().positive().nullable().optional()
});

export const blockPlacementPlanSchema = z.object({
  entranceSide: z.enum(["start", "end"]),
  rows: z.array(blockPlacementPlanRowSchema).max(300)
}).refine((value) => value.rows.every((row) => row.kind === "gap" || row.plantingId != null), {
  message: "Planting rows need a planting"
});

export const harvestSchema = z.object({
  plantingId: z.number(),
  bedId: z.number(),
  harvestDate: z.string(),
  quantity: z.number().positive(),
  unit: z.string().min(1),
  notes: z.string().nullable().optional()
});

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  farmId: z.number().nullable().optional()
});

export const usernameSchema = z.string().trim().min(3, "Username must be at least 3 characters").max(50);
export const emailSchema = z.string().trim().email("Enter a valid email address").max(200);
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(200)
  .regex(/[A-Za-z]/, "Password must include at least one letter")
  .regex(/\d/, "Password must include at least one number");

export const registerSchema = z.object({
  farmName: z.string().trim().min(1).max(120),
  displayName: z.string().trim().min(1).max(100).nullable().optional(),
  email: emailSchema,
  username: usernameSchema,
  password: passwordSchema
});

export const accountCreateSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(100).nullable().optional(),
  role: z.enum(["planner", "worker"])
});

export const farmSettingsSchema = z.object({
  mapsPrivate: z.boolean()
});

export const feedbackSchema = z.object({
  page: z.string().trim().min(1).max(80),
  comment: z.string().max(4000).nullable().optional(),
  context: z.record(z.unknown()).optional(),
  recentActivity: z.array(z.record(z.unknown())).max(50).optional()
});

export const fieldPolygonSchema = polygonSchema.extend({
  farmId: z.number(),
  name: z.string().min(1),
  notes: z.string().nullable().optional()
});

export const fieldPolygonUpdateSchema = polygonSchema.extend({
  name: z.string().min(1),
  notes: z.string().nullable().optional()
});

export const blockPolygonSchema = polygonSchema.extend({
  fieldId: z.number(),
  name: z.string().min(1),
  notes: z.string().nullable().optional(),
  currentState: zoneActualStateSchema
});

export const blockPolygonUpdateSchema = polygonSchema.extend({
  name: z.string().min(1),
  notes: z.string().nullable().optional()
});

export const coverCropNameSchema = z.object({
  farmId: z.number(),
  name: z.string().trim().min(1).max(120),
  notes: z.string().nullable().optional()
});

export const seedItemLotSchema = z.object({
  lotNumber: z.string().trim().max(160),
  stockQuantity: z.number().int().nonnegative().nullable().optional()
}).refine((lot) => lot.lotNumber || lot.stockQuantity == null, {
  message: "Lot number is required when stock is entered"
});

export const seedItemSchema = z.object({
  farmId: z.number(),
  family: z.string().trim().max(120).nullable().optional(),
  cropType: z.string().trim().min(1).max(120),
  varietyName: z.string().trim().max(160).nullable().optional(),
  breedName: z.string().trim().max(160).nullable().optional(),
  supplier: z.string().trim().max(160).nullable().optional(),
  catalogNumber: z.string().trim().max(160).nullable().optional(),
  lotNumber: z.string().trim().max(160).nullable().optional(),
  stockQuantity: z.number().int().nonnegative().nullable().optional(),
  lots: z.array(seedItemLotSchema).max(60).optional(),
  daysToMaturity: z.number().int().positive().nullable().optional(),
  notes: z.string().nullable().optional()
});

export const blockZoneSchema = polygonSchema.extend({
  blockId: z.number(),
  name: z.string().min(1),
  plannedUse: futureUseSchema.nullable().optional(),
  actualState: zoneActualStateSchema,
  coverCropNameId: z.number().nullable().optional(),
  coverCropName: z.string().trim().min(1).max(120).nullable().optional(),
  plannedCoverCropSeedDate: z.string().nullable().optional(),
  plannedCoverCropTerminateDate: z.string().nullable().optional(),
  notes: z.string().nullable().optional()
});

export const blockZoneUpdateSchema = polygonSchema.extend({
  name: z.string().min(1),
  plannedUse: futureUseSchema.nullable().optional(),
  actualState: zoneActualStateSchema,
  coverCropNameId: z.number().nullable().optional(),
  coverCropName: z.string().trim().min(1).max(120).nullable().optional(),
  plannedCoverCropSeedDate: z.string().nullable().optional(),
  plannedCoverCropTerminateDate: z.string().nullable().optional(),
  actualCoverCropSeedDate: z.string().nullable().optional(),
  actualCoverCropTerminateDate: z.string().nullable().optional(),
  notes: z.string().nullable().optional()
});

export const blockZoneSplitSchema = z.object({
  name: z.string().trim().min(1).max(160),
  plannedUse: futureUseSchema.nullable().optional(),
  actualState: zoneActualStateSchema,
  coverCropNameId: z.number().nullable().optional(),
  coverCropName: z.string().trim().min(1).max(120).nullable().optional(),
  plannedCoverCropSeedDate: z.string().nullable().optional(),
  plannedCoverCropTerminateDate: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  lineCoordinates: z.array(latLngSchema).length(2),
  useLargerSide: z.boolean().default(false)
});

export const coverCropWorkSchema = z.object({
  actualState: zoneActualStateSchema.optional(),
  actualCoverCropSeedDate: z.string().nullable().optional(),
  actualCoverCropTerminateDate: z.string().nullable().optional(),
  notes: z.string().nullable().optional()
});

export const bedLineModeSchema = z.enum(["straight", "curved"]);

export const bedPresetSchema = z.object({
  farmId: z.number(),
  name: z.string().min(1),
  bedWidthM: z.number().positive(),
  pathSpacingM: z.number().min(0),
  isRoad: z.boolean().default(false),
  notes: z.string().nullable().optional()
});

export const taskFlowNodeSchema = z.object({
  nodeKey: z.string().min(1),
  taskType: taskTypeSchema,
  label: z.string().min(1),
  anchor: taskAnchorSchema,
  offsetDays: z.number().int(),
  iconColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#4f84aa"),
  iconSecondaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#f4c430"),
  tractorModel: z.enum(["cab", "canopy", "open", "van", "pickup", "box"]).nullable().optional(),
  tractorProfileId: z.number().nullable().optional(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  notes: z.string().nullable().optional()
});

export const tractorProfileSchema = z.object({
  name: z.string().min(1),
  tractorModel: z.enum(["cab", "canopy", "open", "van", "pickup", "box"]),
  iconColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  iconSecondaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/)
});

export const taskFlowEdgeSchema = z.object({
  fromNodeKey: z.string().min(1),
  toNodeKey: z.string().min(1)
});

export const taskFlowSchema = z.object({
  farmId: z.number(),
  cropId: z.number().nullable().optional(),
  name: z.string().min(1),
  notes: z.string().nullable().optional(),
  isDefault: z.boolean().default(false),
  nodes: z.array(taskFlowNodeSchema).min(1),
  edges: z.array(taskFlowEdgeSchema).default([])
});

export const taskFlowUpdateSchema = z.object({
  cropId: z.number().nullable().optional(),
  name: z.string().min(1),
  notes: z.string().nullable().optional(),
  isDefault: z.boolean().default(false),
  nodes: z.array(taskFlowNodeSchema).min(1),
  edges: z.array(taskFlowEdgeSchema).default([])
});

export const bedGenerationSchema = z.object({
  presetId: z.number(),
  zoneId: z.number().nullable().optional(),
  lineMode: bedLineModeSchema,
  lineCoordinates: z.array(latLngSchema).min(2).max(12),
  count: z.number().int().positive().max(100),
  layoutStartIndex: z.number().int().min(0).max(1000).default(0),
  edgeOffsetM: z.number().min(0).max(100).default(0),
  namePrefix: z.string().min(1),
  startNumber: z.number().int().positive().default(1),
  isPermanent: z.boolean().default(true),
  replaceExisting: z.boolean().default(false),
  invertSide: z.boolean().default(false),
  entranceSide: z.enum(["start", "end"]).default("start"),
  fillWholeBlock: z.boolean().default(false),
  harvestRoadEveryBeds: z.number().int().positive().nullable().optional(),
  harvestRoadWidthBeds: z.number().int().min(0).max(20).default(0)
});

export const plantingWorkflowSchema = z.intersection(
  plantingSchema,
  z.object({
    placements: z.array(placementSchema).max(200).default([])
  })
);

export type BlockPlacementPlanRow = z.infer<typeof blockPlacementPlanRowSchema>;
export type PlantingInput = z.infer<typeof plantingSchema>;
export type PlantingWorkflowInput = z.infer<typeof plantingWorkflowSchema>;
export type SeedItemLotInput = z.infer<typeof seedItemLotSchema>;
export type ZoneActualStateInput = z.infer<typeof zoneActualStateSchema>;
