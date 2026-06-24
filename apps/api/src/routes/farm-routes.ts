import express from "express";
import { PoolClient } from "pg";
import { SeedItemLotInput } from "../schemas";
import { registerDashboardRoutes } from "./dashboard";
import { registerFarmReferenceRoutes } from "./farm-reference-routes";
import { registerFarmZoneRoutes } from "./farm-zone-routes";
import { registerMapRoutes } from "./map-routes";
import { registerPlantingRoutes } from "./planting-routes";
import { registerTaskFlowRoutes } from "./task-flow-routes";
import { registerTaskRoutes } from "./task-routes";

type NormalizedSeedLot = { lotNumber: string; stockQuantity: number | null };
type ServerModule = typeof import("../server");
type PermissionsModule = typeof import("../farm-permissions");

export type FarmRouteDeps = {
  normalizedSeedLots: (
    lots: SeedItemLotInput[] | undefined,
    fallbackLotNumber?: string | null,
    fallbackStockQuantity?: number | null
  ) => NormalizedSeedLot[];
  replaceSeedItemLots: (
    client: PoolClient,
    seedItemId: number,
    farmId: number,
    lots: NormalizedSeedLot[]
  ) => Promise<void>;
  ensureFieldInFarm: PermissionsModule["ensureFieldInFarm"];
  ensureBlockInFarm: PermissionsModule["ensureBlockInFarm"];
  ensureBlockZoneInFarm: PermissionsModule["ensureBlockZoneInFarm"];
  ensureBedInFarm: PermissionsModule["ensureBedInFarm"];
  ensurePlantableBedInFarm: PermissionsModule["ensurePlantableBedInFarm"];
  ensurePlantingInFarm: PermissionsModule["ensurePlantingInFarm"];
  ensureTaskInFarm: PermissionsModule["ensureTaskInFarm"];
  ensureTaskFlowInFarm: PermissionsModule["ensureTaskFlowInFarm"];
  ensureBedPresetInFarm: PermissionsModule["ensureBedPresetInFarm"];
  ensureTractorProfileInFarm: PermissionsModule["ensureTractorProfileInFarm"];
  ensureSeedItemInFarm: PermissionsModule["ensureSeedItemInFarm"];
  ensureSeedItemLot: PermissionsModule["ensureSeedItemLot"];
  learnSeedItemSpacingFromPlanting: ServerModule["learnSeedItemSpacingFromPlanting"];
  upsertCoverCropName: ServerModule["upsertCoverCropName"];
  insertGeneratedBeds: ServerModule["insertGeneratedBeds"];
  blockIdForBed: ServerModule["blockIdForBed"];
  fieldIdForBlock: ServerModule["fieldIdForBlock"];
  upsertBlockBedMakingTask: ServerModule["upsertBlockBedMakingTask"];
  reflowBlockPlacementPlan: ServerModule["reflowBlockPlacementPlan"];
  reflowExistingBlockPlacementPlan: ServerModule["reflowExistingBlockPlacementPlan"];
  moveBlockBedAssignmentsToOverflowForReplacement: ServerModule["moveBlockBedAssignmentsToOverflowForReplacement"];
  appendPlantingToBlockPlacementPlan: ServerModule["appendPlantingToBlockPlacementPlan"];
  clearIntendedBedsForField: ServerModule["clearIntendedBedsForField"];
  clearIntendedBedsForBlock: ServerModule["clearIntendedBedsForBlock"];
  upsertFieldGeometry: ServerModule["upsertFieldGeometry"];
  upsertBlockGeometry: ServerModule["upsertBlockGeometry"];
  ensureDefaultBlockArea: ServerModule["ensureDefaultBlockArea"];
  getBedContext: ServerModule["getBedContext"];
  recordFarmEvent: ServerModule["recordFarmEvent"];
  rectangleWkt: ServerModule["rectangleWkt"];
  upsertBlockZoneGeometry: ServerModule["upsertBlockZoneGeometry"];
  splitBlockBoundaryIntoZoneCoordinates: ServerModule["splitBlockBoundaryIntoZoneCoordinates"];
  saveTaskFlowTemplate: ServerModule["saveTaskFlowTemplate"];
  plantingLocationIds: ServerModule["plantingLocationIds"];
  createPlantingFromInput: ServerModule["createPlantingFromInput"];
  actualUpdateForTaskType: ServerModule["actualUpdateForTaskType"];
  todayIsoDate: ServerModule["todayIsoDate"];
  assertNoFuturePlantingDate: ServerModule["assertNoFuturePlantingDate"];
  assertNoFuturePlantingStatusDate: ServerModule["assertNoFuturePlantingStatusDate"];
};

export function registerFarmRoutes(app: express.Express, deps: FarmRouteDeps) {
  registerDashboardRoutes(app);
  registerFarmReferenceRoutes(app, deps);
  registerFarmZoneRoutes(app, deps);
  registerTaskFlowRoutes(app, deps.saveTaskFlowTemplate);
  registerMapRoutes(app, deps);
  registerPlantingRoutes(app, deps);
  registerTaskRoutes(app, deps);
}
