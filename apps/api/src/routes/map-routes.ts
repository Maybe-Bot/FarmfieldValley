import express from "express";
import { z } from "zod";
import { AuthContext } from "../auth";
import { pool } from "../db";
import { polygonWkt } from "../geometry";
import { asyncHandler, currentAuth, requireRole } from "../route-helpers";
import { bedGenerationSchema, blockPlacementPlanSchema, blockPolygonSchema, blockPolygonUpdateSchema, fieldPolygonSchema, fieldPolygonUpdateSchema, geometrySchema } from "../schemas";
import { createUndoSnapshot, pruneUndoSnapshots, runWithUndoSnapshot } from "../undo";
import { syncSingleBlockZoneToBlockBoundary } from "./farm-route-helpers";
import type { FarmRouteDeps } from "./farm-routes";

type MapRouteDeps = Pick<FarmRouteDeps,
  | "ensureFieldInFarm"
  | "ensureBlockInFarm"
  | "ensureBlockZoneInFarm"
  | "ensureBedInFarm"
  | "ensurePlantableBedInFarm"
  | "ensureBedPresetInFarm"
  | "insertGeneratedBeds"
  | "reflowBlockPlacementPlan"
  | "reflowExistingBlockPlacementPlan"
  | "moveBlockBedAssignmentsToOverflowForReplacement"
  | "clearIntendedBedsForField"
  | "clearIntendedBedsForBlock"
  | "upsertFieldGeometry"
  | "upsertBlockGeometry"
  | "upsertBlockZoneGeometry"
  | "ensureDefaultBlockArea"
  | "upsertBlockBedMakingTask"
  | "recordFarmEvent"
  | "rectangleWkt"
>;

export function registerMapRoutes(app: express.Express, deps: MapRouteDeps) {
  const { ensureFieldInFarm, ensureBlockInFarm, ensureBlockZoneInFarm, ensureBedInFarm, ensurePlantableBedInFarm, ensureBedPresetInFarm, insertGeneratedBeds, reflowBlockPlacementPlan, reflowExistingBlockPlacementPlan, moveBlockBedAssignmentsToOverflowForReplacement, clearIntendedBedsForField, clearIntendedBedsForBlock, upsertFieldGeometry, upsertBlockGeometry, upsertBlockZoneGeometry, ensureDefaultBlockArea, upsertBlockBedMakingTask, recordFarmEvent, rectangleWkt } = deps;
  // Map hierarchy routes: fields, blocks, generated beds, and editable bed geometry.
  app.post("/api/fields", requireRole("planner"), asyncHandler(async (req, res) => {
    const body = fieldPolygonSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const farmResult = await client.query<{ id: number }>(`select id from farms where id = $1`, [auth.farmId]);
      if (!farmResult.rows[0]) {
        await client.query("rollback");
        res.status(400).json({ error: "Farm not found. Seed the database or create a farm first." });
        return;
      }
      await createUndoSnapshot(client, auth, "Create field");
      const id = await upsertFieldGeometry(client, { ...body, farmId: auth.farmId });
      await pruneUndoSnapshots(client, auth);
      await client.query("commit");
      res.status(201).json({ id });
    } catch (error) {
      console.error("Field save failed", { body, error });
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));
  
  app.put("/api/fields/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = fieldPolygonUpdateSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const farmResult = await client.query<{ farm_id: number }>(`select farm_id from fields where id = $1 and farm_id = $2`, [id, auth.farmId]);
      if (!farmResult.rows[0]) {
        res.status(404).json({ error: "Field not found" });
        await client.query("rollback");
        return;
      }
      await createUndoSnapshot(client, auth, "Update field");
      await upsertFieldGeometry(client, {
        id,
        farmId: farmResult.rows[0].farm_id,
        name: body.name,
        notes: body.notes ?? null,
        coordinates: body.coordinates
      });
      await pruneUndoSnapshots(client, auth);
      await client.query("commit");
      res.json({ ok: true });
    } catch (error) {
      console.error("Field update failed", { fieldId: id, body, error });
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));
  
  app.delete("/api/fields/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const existing = await client.query<{ id: number }>(`select id from fields where id = $1 and farm_id = $2`, [id, auth.farmId]);
      if (!existing.rows[0]) {
        await client.query("rollback");
        res.status(404).json({ error: "Field not found" });
        return;
      }
      await createUndoSnapshot(client, auth, "Delete field");
      await clearIntendedBedsForField(client, id, auth.farmId);
      await client.query(`delete from fields where id = $1 and farm_id = $2`, [id, auth.farmId]);
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
  
  app.post("/api/blocks", requireRole("planner"), asyncHandler(async (req, res) => {
    const body = blockPolygonSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await ensureFieldInFarm(client, body.fieldId, auth.farmId);
      await createUndoSnapshot(client, auth, "Create block");
      const result = await upsertBlockGeometry(client, { ...body, farmId: auth.farmId });
      await ensureDefaultBlockArea(client, {
        blockId: result.id,
        farmId: auth.farmId,
        blockName: body.name,
        currentState: body.currentState,
        coordinates: body.coordinates
      });
      await pruneUndoSnapshots(client, auth);
      await client.query("commit");
      res.status(201).json(result);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));
  
  app.post("/api/blocks/:id/generate-beds", requireRole("planner"), asyncHandler(async (req, res) => {
    const blockId = Number(req.params.id);
    const body = bedGenerationSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await ensureBlockInFarm(client, blockId, auth.farmId);
      await ensureBedPresetInFarm(client, body.presetId, auth.farmId);
      if (body.zoneId != null) {
        await ensureBlockZoneInFarm(client, body.zoneId, auth.farmId);
        const zoneResult = await client.query<{ block_id: number; planned_use: string }>(
          `
            select zone.block_id, zone.planned_use
            from block_zones zone
            join blocks block on block.id = zone.block_id
            join fields field on field.id = block.field_id
            where zone.id = $1 and field.farm_id = $2
          `,
          [body.zoneId, auth.farmId]
        );
        const zone = zoneResult.rows[0];
        if (!zone || zone.block_id !== blockId) {
          throw new Error("Selected bed area does not belong to this block");
        }
        if (zone.planned_use !== "beds") {
          throw new Error("Beds can only be generated inside bed areas");
        }
      }
      await createUndoSnapshot(client, auth, "Generate beds");
      if (body.replaceExisting) {
        await moveBlockBedAssignmentsToOverflowForReplacement(client, auth.farmId, blockId, body.zoneId ?? null);
      }
      const result = await insertGeneratedBeds(client, {
        blockId,
        farmId: auth.farmId,
        presetId: body.presetId,
        zoneId: body.zoneId ?? null,
        lineMode: body.lineMode,
        lineCoordinates: body.lineCoordinates,
        count: body.count,
        layoutStartIndex: body.layoutStartIndex,
        edgeOffsetM: body.edgeOffsetM,
        namePrefix: body.namePrefix,
        startNumber: body.startNumber,
        isPermanent: body.isPermanent,
        replaceExisting: body.replaceExisting,
        invertSide: body.invertSide,
        fillWholeBlock: body.fillWholeBlock,
        harvestRoadEveryBeds: body.harvestRoadEveryBeds ?? null,
        harvestRoadWidthBeds: body.harvestRoadWidthBeds
      });
      if (result.inserted > 0 && !result.isRoad) {
        await client.query(
          `update blocks set bed_start_entrance_side = $3, updated_at = now() where id = $1 and field_id in (select id from fields where farm_id = $2)`,
          [blockId, auth.farmId, body.entranceSide]
        );
        await upsertBlockBedMakingTask(client, auth.farmId, blockId);
        await reflowExistingBlockPlacementPlan(client, auth.farmId, blockId);
      }
      await pruneUndoSnapshots(client, auth);
      await client.query("commit");
      res.status(201).json(result);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));
  
  app.put("/api/blocks/:id/placement-plan", requireRole("planner"), asyncHandler(async (req, res) => {
    const blockId = Number(req.params.id);
    const body = blockPlacementPlanSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await ensureBlockInFarm(client, blockId, auth.farmId);
      await createUndoSnapshot(client, auth, "Update block placement plan");
      await reflowBlockPlacementPlan(client, auth.farmId, blockId, body.entranceSide, body.rows);
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
  
  app.put("/api/blocks/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = blockPolygonUpdateSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const parent = await client.query<{ field_id: number }>(
        `
          select block.field_id
          from blocks block
          join fields field on field.id = block.field_id
          where block.id = $1 and field.farm_id = $2
        `,
        [id, auth.farmId]
      );
      if (!parent.rows[0]) {
        res.status(404).json({ error: "Block not found" });
        await client.query("rollback");
        return;
      }
      await createUndoSnapshot(client, auth, "Update block");
      const result = await upsertBlockGeometry(client, {
        id,
        fieldId: parent.rows[0].field_id,
        farmId: auth.farmId,
        name: body.name,
        notes: body.notes ?? null,
        coordinates: body.coordinates
      });
      await syncSingleBlockZoneToBlockBoundary(client, deps, {
        blockId: id,
        farmId: auth.farmId,
        coordinates: body.coordinates
      });
      await pruneUndoSnapshots(client, auth);
      await client.query("commit");
      res.json({ ok: true, warning: result.warning });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));
  
  app.delete("/api/blocks/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const existing = await client.query<{ id: number }>(
        `
          select block.id
          from blocks block
          join fields field on field.id = block.field_id
          where block.id = $1 and field.farm_id = $2
        `,
        [id, auth.farmId]
      );
      if (!existing.rows[0]) {
        await client.query("rollback");
        res.status(404).json({ error: "Block not found" });
        return;
      }
      await createUndoSnapshot(client, auth, "Delete block");
      await clearIntendedBedsForBlock(client, id, auth.farmId);
      await client.query(`delete from blocks where id = $1 and field_id in (select id from fields where farm_id = $2)`, [id, auth.farmId]);
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
  
  app.post("/api/beds", requireRole("planner"), asyncHandler(async (req, res) => {
    const body = geometrySchema.extend({
      blockId: z.number(),
      name: z.string().min(1),
      isPermanent: z.boolean(),
      bedLengthM: z.number().positive(),
      notes: z.string().nullable().optional()
    }).parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const result = await runWithUndoSnapshot(auth, "Create bed", async (client) => {
      await ensureBlockInFarm(client, body.blockId, auth.farmId);
      return client.query(
        `
          insert into beds (
            block_id, name, is_permanent, notes, x, y, width, height, bed_length_m,
            geom, geometry_source, geometry_updated_at, geometry_notes
          )
          select $1, $2, $3, $4, $5, $6, $7, $8, $9, ST_GeomFromText($10, 3857), 'manual', now(), 'Manual bed geometry'
          from blocks block
          join fields field on field.id = block.field_id
          where block.id = $1 and field.farm_id = $11
          returning id
        `,
        [body.blockId, body.name, body.isPermanent, body.notes ?? null, body.x, body.y, body.width, body.height, body.bedLengthM, rectangleWkt(body.x, body.y, body.width, body.height), auth.farmId]
      );
    });
    res.status(201).json({ id: result.rows[0].id });
  }));
  
  app.put("/api/beds/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = geometrySchema.extend({
      name: z.string().min(1),
      isPermanent: z.boolean(),
      bedLengthM: z.number().positive(),
      notes: z.string().nullable().optional()
    }).parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    await runWithUndoSnapshot(auth, "Update bed", async (client) => {
      await ensureBedInFarm(client, id, auth.farmId);
      await client.query(
        `
          update beds
          set
            name = $2,
            is_permanent = $3,
            notes = $4,
            x = $5,
            y = $6,
            width = $7,
            height = $8,
            bed_length_m = $9,
            geom = ST_GeomFromText($10, 3857),
            geometry_source = 'manual_update',
            geometry_updated_at = now(),
            geometry_notes = 'Manually updated bed geometry',
            updated_at = now()
          where id = $1
            and block_id in (
              select block.id
              from blocks block
              join fields field on field.id = block.field_id
              where field.farm_id = $11
            )
        `,
        [id, body.name, body.isPermanent, body.notes ?? null, body.x, body.y, body.width, body.height, body.bedLengthM, rectangleWkt(body.x, body.y, body.width, body.height), auth.farmId]
      );
    });
    res.json({ ok: true });
  }));
  
  app.delete("/api/beds/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const auth = currentAuth(req) as AuthContext;
    await runWithUndoSnapshot(auth, "Delete bed", async (client) => {
      await ensureBedInFarm(client, id, auth.farmId);
      const usage = await client.query<{
        intended_plantings: string;
        placements: string;
        harvests: string;
      }>(
        `
          select
            (select count(*) from plantings where farm_id = $2 and intended_bed_id = $1) as intended_plantings,
            (
              select count(*)
              from planting_placements placement
              join plantings planting on planting.id = placement.planting_id
              where planting.farm_id = $2 and placement.bed_id = $1
            ) as placements,
            (select count(*) from harvest_records where farm_id = $2 and bed_id = $1) as harvests
        `,
        [id, auth.farmId]
      );
      const row = usage.rows[0];
      const intendedPlantings = Number(row?.intended_plantings ?? 0);
      const placements = Number(row?.placements ?? 0);
      const harvests = Number(row?.harvests ?? 0);
      if (intendedPlantings > 0 || placements > 0 || harvests > 0) {
        throw new Error("This bed has planned plantings, placements, or harvest records. Move or remove those records before deleting the bed.");
      }
  
      const bed = await client.query<{ block_id: number }>(
        `
          select bed.block_id
          from beds bed
          join blocks block on block.id = bed.block_id
          join fields field on field.id = block.field_id
          where bed.id = $1 and field.farm_id = $2
        `,
        [id, auth.farmId]
      );
      await client.query(
        `
          delete from beds bed
          using blocks block, fields field
          where bed.block_id = block.id
            and block.field_id = field.id
            and bed.id = $1
            and field.farm_id = $2
        `,
        [id, auth.farmId]
      );
      const blockId = bed.rows[0]?.block_id;
      if (blockId != null) {
        await upsertBlockBedMakingTask(client, auth.farmId, blockId);
      }
    });
    res.json({ ok: true });
  }));
  
}
