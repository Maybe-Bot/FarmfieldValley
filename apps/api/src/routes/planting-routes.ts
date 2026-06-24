import express from "express";
import { AuthContext } from "../auth";
import { pool } from "../db";
import { polygonWkt } from "../geometry";
import { asyncHandler, currentAuth, requireRole } from "../route-helpers";
import { actualEventSchema, harvestSchema, placementSchema, plantingSchema, plantingWorkflowSchema } from "../schemas";
import { recalculatePlantingTasks } from "../scheduler";
import { createUndoSnapshot, pruneUndoSnapshots } from "../undo";
import { ActualEventType, PlantingStatus } from "../types";
import type { FarmRouteDeps } from "./farm-routes";

type PlantingRouteDeps = Pick<FarmRouteDeps, "ensurePlantableBedInFarm" | "ensurePlantingInFarm" | "ensureTaskFlowInFarm" | "ensureSeedItemInFarm" | "learnSeedItemSpacingFromPlanting" | "blockIdForBed" | "upsertBlockBedMakingTask" | "reflowExistingBlockPlacementPlan" | "getBedContext" | "recordFarmEvent" | "plantingLocationIds" | "createPlantingFromInput" | "todayIsoDate" | "assertNoFuturePlantingDate" | "assertNoFuturePlantingStatusDate">;

export function registerPlantingRoutes(app: express.Express, deps: PlantingRouteDeps) {
  const { ensurePlantableBedInFarm, ensurePlantingInFarm, ensureTaskFlowInFarm, ensureSeedItemInFarm, learnSeedItemSpacingFromPlanting, blockIdForBed, upsertBlockBedMakingTask, reflowExistingBlockPlacementPlan, getBedContext, recordFarmEvent, plantingLocationIds, createPlantingFromInput, todayIsoDate, assertNoFuturePlantingDate, assertNoFuturePlantingStatusDate } = deps;
  // Crop planning, task recording, placements, actual dates, and harvest logging.
  app.post("/api/plantings", requireRole("planner"), asyncHandler(async (req, res) => {
    const body = plantingSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await createUndoSnapshot(client, auth, "Create planting");
      const result = await createPlantingFromInput(client, auth, body);
      await pruneUndoSnapshots(client, auth);
      await client.query("commit");
      res.status(201).json({ id: result.plantingId });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));
  
  app.post("/api/workflows/plantings", requireRole("planner"), asyncHandler(async (req, res) => {
    const body = plantingWorkflowSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await createUndoSnapshot(client, auth, "Create planting with placements");
      const result = await createPlantingFromInput(client, auth, body);
      const placementBlockIds = new Set<number>();
      const plantingResult = await client.query<{ title: string }>(
        `select title from plantings where id = $1 and farm_id = $2`,
        [result.plantingId, auth.farmId]
      );
      const plantingTitle = plantingResult.rows[0]?.title ?? "Planting";
  
      for (const placement of body.placements) {
        await ensurePlantableBedInFarm(client, placement.bedId, auth.farmId);
        if (placement.actualDate && placement.actualDate > todayIsoDate()) {
          throw new Error("Planted dates cannot be in the future");
        }
        const placementInsert = await client.query<{ id: number }>(
          `
            insert into planting_placements (
              planting_id, bed_id, plant_count, bed_length_used_m, placed_on, location_detail, notes,
              boundary, centroid, area_sqm
            )
            values (
              $1, $2, $3, $4, $5, $6, $7,
              case when $8::text is null then null else ST_GeomFromText($8, 4326) end,
              case when $8::text is null then null else ST_Centroid(ST_GeomFromText($8, 4326)) end,
              case when $8::text is null then null else ST_Area(ST_GeomFromText($8, 4326)::geography) end
            )
            returning id
          `,
          [
            result.plantingId,
            placement.bedId,
            placement.plantCount ?? null,
            placement.bedLengthUsedM ?? null,
            placement.actualDate ?? null,
            placement.locationDetail ?? null,
            placement.notes ?? null,
            placement.coordinates && placement.coordinates.length >= 3 ? polygonWkt(placement.coordinates) : null
          ]
        );
        const bedContext = await getBedContext(client, placement.bedId, auth.farmId);
        placementBlockIds.add(bedContext.block_id);
        await recordFarmEvent(client, {
          farmId: auth.farmId,
          eventDate: placement.actualDate ?? new Date().toISOString().slice(0, 10),
          eventType: "placement_recorded",
          title: `Placement recorded for ${plantingTitle}`,
          notes: placement.notes ?? null,
          metadata: {
            plantCount: placement.plantCount ?? null,
            bedLengthUsedM: placement.bedLengthUsedM ?? null,
            locationDetail: placement.locationDetail ?? null,
            source: "planting_workflow"
          },
          fieldId: bedContext.field_id,
          blockId: bedContext.block_id,
          zoneId: bedContext.zone_id,
          bedId: placement.bedId,
          plantingId: result.plantingId,
          placementId: placementInsert.rows[0].id,
          coordinates: placement.coordinates ?? null
        });
      }
  
      for (const blockId of placementBlockIds) {
        await upsertBlockBedMakingTask(client, auth.farmId, blockId);
      }
      await pruneUndoSnapshots(client, auth);
      await client.query("commit");
      res.status(201).json({ id: result.plantingId, placementsCreated: body.placements.length });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));
  
  app.put("/api/plantings/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = plantingSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      assertNoFuturePlantingStatusDate(body.status, body.plannedSowDate, body.plannedTransplantDate);
      await ensurePlantingInFarm(client, id, auth.farmId);
      const existingPlanting = await client.query<{ intended_block_id: number | null }>(
        `select intended_block_id from plantings where id = $1 and farm_id = $2`,
        [id, auth.farmId]
      );
      const previousBlockId = existingPlanting.rows[0]?.intended_block_id ?? null;
      if (body.intendedBedId != null) {
        await ensurePlantableBedInFarm(client, body.intendedBedId, auth.farmId);
      }
      if (body.seedItemId != null) {
        await ensureSeedItemInFarm(client, body.seedItemId, auth.farmId);
      }
      if (body.taskFlowTemplateId != null) {
        await ensureTaskFlowInFarm(client, body.taskFlowTemplateId, auth.farmId);
      }
      const { intendedFieldId, intendedBlockId } = await plantingLocationIds(client, auth, body);
      await createUndoSnapshot(client, auth, "Update planting");
      await client.query(
        `
          update plantings
          set
            crop_id = $2,
            variety_id = $3,
            seed_item_id = $4,
            title = $5,
            status = $6,
            intended_field_id = $7,
            intended_block_id = $8,
            intended_bed_id = $9,
            task_flow_template_id = $10,
            spacing = $11,
            plant_count = $12,
            bed_length_used_m = $13,
            notes = $14,
            tray_location = $15,
            tray_count = $16,
            cells_per_tray = $17,
            days_to_harvest = $18,
            field_spacing_in_row = $19,
            row_spacing = $20,
            rows_per_bed = $21,
            dead_at_frost = $22,
            bed_cover = $23,
            planned_sow_date = $24,
            planned_transplant_date = $25,
            expected_harvest_start = $26,
            expected_harvest_end = $27,
            updated_at = now()
          where id = $1 and farm_id = $28
        `,
        [
          id,
          body.cropId,
          body.varietyId ?? null,
          body.seedItemId ?? null,
          body.title,
          body.status,
          intendedFieldId,
          intendedBlockId,
          body.intendedBedId ?? null,
          body.taskFlowTemplateId ?? null,
          body.spacing ?? null,
          body.plantCount ?? null,
          body.bedLengthUsedM ?? null,
          body.notes ?? null,
          body.trayLocation ?? null,
          body.trayCount ?? null,
          body.cellsPerTray ?? null,
          body.daysToHarvest ?? null,
          body.fieldSpacingInRow ?? null,
          body.rowSpacing ?? null,
          body.rowsPerBed ?? null,
          body.deadAtFrost ?? null,
          body.bedCover ?? null,
          body.plannedSowDate ?? null,
          body.plannedTransplantDate ?? null,
          body.expectedHarvestStart ?? null,
          body.expectedHarvestEnd ?? null,
          auth.farmId
        ]
      );
      await learnSeedItemSpacingFromPlanting(client, auth.farmId, id);
      await recalculatePlantingTasks(client, id);
      const blockIdsToReflow = new Set<number>();
      if (previousBlockId != null) blockIdsToReflow.add(previousBlockId);
      if (intendedBlockId != null) blockIdsToReflow.add(intendedBlockId);
      for (const blockIdToReflow of blockIdsToReflow) {
        await reflowExistingBlockPlacementPlan(client, auth.farmId, blockIdToReflow);
      }
      if (intendedBlockId != null) {
        await upsertBlockBedMakingTask(client, auth.farmId, intendedBlockId);
      }
      await pruneUndoSnapshots(client, auth);
      await client.query("commit");
      res.json({ ok: true });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));
  
  app.delete("/api/plantings/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const existing = await client.query<{ id: number; intended_block_id: number | null }>(
        `select id, intended_block_id from plantings where id = $1 and farm_id = $2`,
        [id, auth.farmId]
      );
      if (!existing.rows[0]) {
        await client.query("rollback");
        res.status(404).json({ error: "Planting not found" });
        return;
      }
      await createUndoSnapshot(client, auth, "Delete planting");
      await client.query(`delete from plantings where id = $1 and farm_id = $2`, [id, auth.farmId]);
      if (existing.rows[0].intended_block_id != null) {
        await reflowExistingBlockPlacementPlan(client, auth.farmId, existing.rows[0].intended_block_id);
      }
      await pruneUndoSnapshots(client, auth);
      await client.query("commit");
      res.json({ ok: true });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));
  
  app.post("/api/plantings/:id/placements", requireRole("planner"), asyncHandler(async (req, res) => {
    const plantingId = Number(req.params.id);
    const body = placementSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
        await ensurePlantingInFarm(client, plantingId, auth.farmId);
        await ensurePlantableBedInFarm(client, body.bedId, auth.farmId);
        if (body.actualDate && body.actualDate > todayIsoDate()) {
          throw new Error("Planted dates cannot be in the future");
        }
        await createUndoSnapshot(client, auth, "Add planting placement");
      const plantingResult = await client.query<{ title: string }>(
        `select title from plantings where id = $1 and farm_id = $2`,
        [plantingId, auth.farmId]
      );
      const plantingTitle = plantingResult.rows[0]?.title ?? "Planting";
      const placementInsert = await client.query<{ id: number }>(
        `
          insert into planting_placements (
            planting_id, bed_id, plant_count, bed_length_used_m, placed_on, location_detail, notes,
            boundary, centroid, area_sqm
          )
          values (
            $1, $2, $3, $4, $5, $6, $7,
            case when $8::text is null then null else ST_GeomFromText($8, 4326) end,
            case when $8::text is null then null else ST_Centroid(ST_GeomFromText($8, 4326)) end,
            case when $8::text is null then null else ST_Area(ST_GeomFromText($8, 4326)::geography) end
          )
          returning id
        `,
        [
          plantingId,
          body.bedId,
          body.plantCount ?? null,
          body.bedLengthUsedM ?? null,
          body.actualDate ?? null,
          body.locationDetail ?? null,
          body.notes ?? null,
          body.coordinates && body.coordinates.length >= 3 ? polygonWkt(body.coordinates) : null
        ]
      );
      const bedContext = await getBedContext(client, body.bedId, auth.farmId);
      await recordFarmEvent(client, {
        farmId: auth.farmId,
        eventDate: body.actualDate ?? new Date().toISOString().slice(0, 10),
        eventType: "placement_recorded",
        title: `Placement recorded for ${plantingTitle}`,
        notes: body.notes ?? null,
        metadata: {
          plantCount: body.plantCount ?? null,
          bedLengthUsedM: body.bedLengthUsedM ?? null,
          locationDetail: body.locationDetail ?? null,
          source: "placement_form"
        },
        fieldId: bedContext.field_id,
        blockId: bedContext.block_id,
        zoneId: bedContext.zone_id,
        bedId: body.bedId,
        plantingId,
        placementId: placementInsert.rows[0].id,
        coordinates: body.coordinates ?? null
      });
      const blockId = await blockIdForBed(client, body.bedId, auth.farmId);
      if (blockId != null) {
        await upsertBlockBedMakingTask(client, auth.farmId, blockId);
      }
      await pruneUndoSnapshots(client, auth);
      await client.query("commit");
      res.status(201).json({ ok: true });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));
  
  app.post("/api/plantings/:id/actuals", requireRole("planner"), asyncHandler(async (req, res) => {
    const plantingId = Number(req.params.id);
    const body = actualEventSchema.parse(req.body);
    assertNoFuturePlantingDate(body.eventType, body.actualDate);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await ensurePlantingInFarm(client, plantingId, auth.farmId);
      await createUndoSnapshot(client, auth, "Record planting actual");
  
      const updates: Record<ActualEventType, { field: string; status: PlantingStatus }> = {
        tray_seeding: { field: "actual_tray_seeding_date", status: "seeded_in_tray" },
        direct_seeding: { field: "actual_direct_seeding_date", status: "direct_seeded" },
        transplant: { field: "actual_transplant_date", status: "transplanted" },
        cultivation: { field: "actual_cultivation_date", status: "growing" },
        harvest: { field: "actual_harvest_date", status: "harvested" },
        finish: { field: "actual_finish_date", status: "finished" }
      };
  
      const update = updates[body.eventType];
      await client.query(
        `
          update plantings
          set ${update.field} = $2, status = $3, notes = concat_ws(E'\n', notes, $4::text), updated_at = now()
          where id = $1 and farm_id = $5
        `,
        [plantingId, body.actualDate, update.status, body.notes ?? null, auth.farmId]
      );
  
      const plantingResult = await client.query<{ title: string }>(
        `select title from plantings where id = $1 and farm_id = $2`,
        [plantingId, auth.farmId]
      );
      await recordFarmEvent(client, {
        farmId: auth.farmId,
        eventDate: body.actualDate,
        eventType: "planting_actual_recorded",
        title: `${body.eventType.replaceAll("_", " ")} recorded for ${plantingResult.rows[0]?.title ?? "planting"}`,
        notes: body.notes ?? null,
        metadata: {
          actualEventType: body.eventType,
          resultingStatus: update.status
        },
        plantingId
      });
  
      await recalculatePlantingTasks(client, plantingId);
      await pruneUndoSnapshots(client, auth);
      await client.query("commit");
      res.json({ ok: true });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));
  
  app.post("/api/harvests", requireRole("worker"), asyncHandler(async (req, res) => {
    const body = harvestSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await ensurePlantingInFarm(client, body.plantingId, auth.farmId);
      await ensurePlantableBedInFarm(client, body.bedId, auth.farmId);
      await createUndoSnapshot(client, auth, "Log harvest");
      await client.query(
        `
          insert into harvest_records (farm_id, planting_id, bed_id, harvest_date, quantity, unit, notes)
          values ($1, $2, $3, $4, $5, $6, $7)
        `,
        [auth.farmId, body.plantingId, body.bedId, body.harvestDate, body.quantity, body.unit, body.notes ?? null]
      );
      await client.query(
        `update plantings set actual_harvest_date = coalesce(actual_harvest_date, $2), status = 'harvested', updated_at = now() where id = $1 and farm_id = $3`,
        [body.plantingId, body.harvestDate, auth.farmId]
      );
      const plantingResult = await client.query<{ title: string }>(
        `select title from plantings where id = $1 and farm_id = $2`,
        [body.plantingId, auth.farmId]
      );
      const bedContext = await getBedContext(client, body.bedId, auth.farmId);
      await recordFarmEvent(client, {
        farmId: auth.farmId,
        eventDate: body.harvestDate,
        eventType: "harvest_logged",
        title: `Harvest logged for ${plantingResult.rows[0]?.title ?? "planting"}`,
        notes: body.notes ?? null,
        metadata: {
          quantity: body.quantity,
          unit: body.unit
        },
        fieldId: bedContext.field_id,
        blockId: bedContext.block_id,
        zoneId: bedContext.zone_id,
        bedId: body.bedId,
        plantingId: body.plantingId
      });
      await recalculatePlantingTasks(client, body.plantingId);
      await pruneUndoSnapshots(client, auth);
      await client.query("commit");
      res.status(201).json({ ok: true });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));
}
