import express from "express";
import { z } from "zod";
import { AuthContext } from "../auth";
import { pool } from "../db";
import { asyncHandler, currentAuth, requireRole } from "../route-helpers";
import { blockZoneSchema, blockZoneSplitSchema, blockZoneUpdateSchema, coverCropWorkSchema, unplannedWorkSchema, zoneActualStateSchema } from "../schemas";
import { createUndoSnapshot, pruneUndoSnapshots, runWithUndoSnapshot } from "../undo";
import {
  GeoJsonPolygonInput,
  geoJsonPolygonToLatLngs,
  LatLngInput
} from "./farm-route-helpers";
import type { FarmRouteDeps } from "./farm-routes";

type FarmZoneRouteDeps = Pick<FarmRouteDeps, "ensureFieldInFarm" | "ensureBlockInFarm" | "ensureBlockZoneInFarm" | "ensureBedInFarm" | "ensurePlantingInFarm" | "recordFarmEvent" | "upsertBlockZoneGeometry" | "splitBlockBoundaryIntoZoneCoordinates" | "todayIsoDate">;

export function registerFarmZoneRoutes(app: express.Express, deps: FarmZoneRouteDeps) {
  const { ensureFieldInFarm, ensureBlockInFarm, ensureBlockZoneInFarm, ensureBedInFarm, ensurePlantingInFarm, recordFarmEvent, upsertBlockZoneGeometry, splitBlockBoundaryIntoZoneCoordinates, todayIsoDate } = deps;
  // Block zones represent planned/current sub-areas inside a block.
  app.post("/api/block-zones", requireRole("planner"), asyncHandler(async (req, res) => {
    const body = blockZoneSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const result = await runWithUndoSnapshot(auth, "Create block area", async (client) => {
      await ensureBlockInFarm(client, body.blockId, auth.farmId);
      return upsertBlockZoneGeometry(client, {
        blockId: body.blockId,
        farmId: auth.farmId,
        name: body.name,
        plannedUse: body.plannedUse,
        actualState: body.actualState,
        coverCropNameId: body.coverCropNameId ?? null,
        coverCropName: body.coverCropName ?? null,
        plannedCoverCropSeedDate: body.plannedCoverCropSeedDate ?? null,
        plannedCoverCropTerminateDate: body.plannedCoverCropTerminateDate ?? null,
        notes: body.notes ?? null,
        coordinates: body.coordinates
      });
    });
    res.status(201).json(result);
  }));
  
  app.post("/api/blocks/:id/split-zone", requireRole("planner"), asyncHandler(async (req, res) => {
    const blockId = Number(req.params.id);
    const body = blockZoneSplitSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await ensureBlockInFarm(client, blockId, auth.farmId);
      const existingZoneCountResult = await client.query<{ count: string }>(
        `
          select count(*)::text as count
          from block_zones zone
          join blocks block on block.id = zone.block_id
          join fields field on field.id = block.field_id
          where zone.block_id = $1 and field.farm_id = $2
        `,
        [blockId, auth.farmId]
      );
      const existingZoneCount = Number(existingZoneCountResult.rows[0]?.count ?? "0");
      const { targetCoordinates, remainderCoordinates } = await splitBlockBoundaryIntoZoneCoordinates(client, {
        blockId,
        farmId: auth.farmId,
        lineCoordinates: body.lineCoordinates,
        splitLines: body.splitLines,
        firstBedSidePoint: body.firstBedSidePoint,
        useLargerSide: body.useLargerSide
      });
  
      await client.query("begin");
      await createUndoSnapshot(client, auth, "Split block area");
      const primaryZone = await upsertBlockZoneGeometry(client, {
        blockId,
        farmId: auth.farmId,
        name: body.name,
        plannedUse: body.plannedUse,
        actualState: body.actualState,
        coverCropNameId: body.coverCropNameId ?? null,
        coverCropName: body.coverCropName ?? null,
        plannedCoverCropSeedDate: body.plannedCoverCropSeedDate ?? null,
        plannedCoverCropTerminateDate: body.plannedCoverCropTerminateDate ?? null,
        notes: body.notes ?? null,
        coordinates: targetCoordinates
      });
      for (const [index, coordinates] of remainderCoordinates.entries()) {
        await upsertBlockZoneGeometry(client, {
          blockId,
          farmId: auth.farmId,
          name: `Area ${existingZoneCount + 2 + index}`,
          plannedUse: null,
          actualState: body.actualState,
          plannedCoverCropSeedDate: null,
          plannedCoverCropTerminateDate: null,
          notes: null,
          coordinates
        });
      }
      await pruneUndoSnapshots(client, auth);
      await client.query("commit");
      res.status(201).json(primaryZone);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));
  
  app.put("/api/block-zones/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const zoneId = Number(req.params.id);
    const body = blockZoneUpdateSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const result = await runWithUndoSnapshot(auth, "Update block area", async (client) => {
      await ensureBlockZoneInFarm(client, zoneId, auth.farmId);
      const zoneResult = await client.query<{ block_id: number }>(
        `
          select zone.block_id
          from block_zones zone
          join blocks block on block.id = zone.block_id
          join fields field on field.id = block.field_id
          where zone.id = $1 and field.farm_id = $2
        `,
        [zoneId, auth.farmId]
      );
      const zone = zoneResult.rows[0];
      if (!zone) {
        throw new Error("Block zone not found");
      }
      return upsertBlockZoneGeometry(client, {
        id: zoneId,
        blockId: zone.block_id,
        farmId: auth.farmId,
        name: body.name,
        plannedUse: body.plannedUse,
        actualState: body.actualState,
        coverCropNameId: body.coverCropNameId ?? null,
        coverCropName: body.coverCropName ?? null,
        plannedCoverCropSeedDate: body.plannedCoverCropSeedDate ?? null,
        plannedCoverCropTerminateDate: body.plannedCoverCropTerminateDate ?? null,
        actualCoverCropSeedDate: body.actualCoverCropSeedDate ?? null,
        actualCoverCropTerminateDate: body.actualCoverCropTerminateDate ?? null,
        notes: body.notes ?? null,
        coordinates: body.coordinates
      });
    });
    res.json(result);
  }));
  
  app.put("/api/block-zones/:id/cover-crop-work", requireRole(), asyncHandler(async (req, res) => {
    const zoneId = Number(req.params.id);
    const body = coverCropWorkSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
  
    if (body.actualCoverCropSeedDate && body.actualCoverCropSeedDate > todayIsoDate()) {
      throw new Error("Actual cover crop seeded date cannot be in the future");
    }
    if (body.actualCoverCropTerminateDate && body.actualCoverCropTerminateDate > todayIsoDate()) {
      throw new Error("Actual cover crop terminated date cannot be in the future");
    }
  
    const client = await pool.connect();
    try {
      await client.query("begin");
      await ensureBlockZoneInFarm(client, zoneId, auth.farmId);
      await createUndoSnapshot(client, auth, "Record cover crop work");
  
      const zoneResult = await client.query<{
        block_id: number;
        block_name: string;
        field_id: number;
        field_name: string;
        name: string;
        planned_use: string | null;
        actual_state: z.infer<typeof zoneActualStateSchema>;
        notes: string | null;
        boundary_wkt: string | null;
      }>(
        `
          select
            zone.block_id,
            block.name as block_name,
            field.id as field_id,
            field.name as field_name,
            zone.name,
            zone.planned_use,
            zone.actual_state,
            zone.notes,
            ST_AsText(zone.boundary) as boundary_wkt
          from block_zones zone
          join blocks block on block.id = zone.block_id
          join fields field on field.id = block.field_id
          where zone.id = $1 and field.farm_id = $2
        `,
        [zoneId, auth.farmId]
      );
      const zone = zoneResult.rows[0];
      if (!zone) {
        throw new Error("Cover crop area not found");
      }
      if (zone.planned_use !== "cover_crop") {
        throw new Error("Selected area is not assigned to cover crop.");
      }
  
      const nextActualState = body.actualState ?? zone.actual_state;
      const nextNotes = body.notes === undefined ? zone.notes : body.notes;
      await client.query(
        `
          update block_zones
          set
            actual_state = $2,
            actual_cover_crop_seed_date = $3::date,
            actual_cover_crop_terminate_date = $4::date,
            notes = $5,
            updated_at = now()
          where id = $1
            and block_id in (
              select block.id
              from blocks block
              join fields field on field.id = block.field_id
              where field.farm_id = $6
            )
        `,
        [
          zoneId,
          nextActualState,
          body.actualCoverCropSeedDate ?? null,
          body.actualCoverCropTerminateDate ?? null,
          nextNotes ?? null,
          auth.farmId
        ]
      );
  
      await client.query(
        `delete from farm_events where farm_id = $1 and zone_id = $2 and event_type in ('cover_crop_seeded', 'cover_crop_terminated')`,
        [auth.farmId, zoneId]
      );
  
      const coordinates = zone.boundary_wkt ? null : null;
      if (body.actualCoverCropSeedDate) {
        await recordFarmEvent(client, {
          farmId: auth.farmId,
          eventDate: body.actualCoverCropSeedDate,
          eventType: "cover_crop_seeded",
          title: `Cover crop seeded: ${zone.name}`,
          notes: nextNotes ?? null,
          metadata: { timelineVisible: true, stateCategory: "cover_crop", source: "cover_crop_work" },
          fieldId: zone.field_id,
          blockId: zone.block_id,
          zoneId,
          coordinates
        });
      }
      if (body.actualCoverCropTerminateDate) {
        await recordFarmEvent(client, {
          farmId: auth.farmId,
          eventDate: body.actualCoverCropTerminateDate,
          eventType: "cover_crop_terminated",
          title: `Cover crop terminated: ${zone.name}`,
          notes: nextNotes ?? null,
          metadata: { timelineVisible: true, stateCategory: "cleanup", source: "cover_crop_work" },
          fieldId: zone.field_id,
          blockId: zone.block_id,
          zoneId,
          coordinates
        });
      }
  
      await pruneUndoSnapshots(client, auth);
      await client.query("commit");
      res.json({ ok: true });
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));
  
  app.post("/api/work-events/unplanned", requireRole("worker"), asyncHandler(async (req, res) => {
    const body = unplannedWorkSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
  
    if (body.eventDate > todayIsoDate()) {
      throw new Error("Work date cannot be in the future");
    }
  
    const result = await runWithUndoSnapshot(auth, "Record unplanned work", async (client) => {
      let fieldId = body.fieldId ?? null;
      let blockId = body.blockId ?? null;
      let zoneId = body.zoneId ?? null;
      let bedId = body.bedId ?? null;
      let locationName = "selected area";
      let coordinates: LatLngInput[] | null = null;
  
      if (bedId != null) {
        await ensureBedInFarm(client, bedId, auth.farmId);
        const bedResult = await client.query<{
          id: number;
          name: string;
          block_id: number;
          block_name: string;
          field_id: number;
          boundary: GeoJsonPolygonInput;
        }>(
          `
            select
              bed.id,
              bed.name,
              bed.block_id,
              block.name as block_name,
              field.id as field_id,
              ST_AsGeoJSON(coalesce(bed.boundary, ST_Transform(bed.geom, 4326)))::json as boundary
            from beds bed
            join blocks block on block.id = bed.block_id
            join fields field on field.id = block.field_id
            where bed.id = $1 and field.farm_id = $2
          `,
          [bedId, auth.farmId]
        );
        const bed = bedResult.rows[0];
        if (!bed) {
          throw new Error("Bed not found");
        }
        blockId = bed.block_id;
        fieldId = bed.field_id;
        locationName = `${bed.name} in ${bed.block_name}`;
        coordinates = geoJsonPolygonToLatLngs(bed.boundary);
      } else if (zoneId != null) {
        await ensureBlockZoneInFarm(client, zoneId, auth.farmId);
        const zoneResult = await client.query<{
          id: number;
          name: string;
          block_id: number;
          block_name: string;
          field_id: number;
          boundary: GeoJsonPolygonInput;
        }>(
          `
            select
              zone.id,
              zone.name,
              zone.block_id,
              block.name as block_name,
              field.id as field_id,
              ST_AsGeoJSON(zone.boundary)::json as boundary
            from block_zones zone
            join blocks block on block.id = zone.block_id
            join fields field on field.id = block.field_id
            where zone.id = $1 and field.farm_id = $2
          `,
          [zoneId, auth.farmId]
        );
        const zone = zoneResult.rows[0];
        if (!zone) {
          throw new Error("Block area not found");
        }
        blockId = zone.block_id;
        fieldId = zone.field_id;
        locationName = `${zone.name} in ${zone.block_name}`;
        coordinates = geoJsonPolygonToLatLngs(zone.boundary);
      } else if (blockId != null) {
        await ensureBlockInFarm(client, blockId, auth.farmId);
        const blockResult = await client.query<{
          id: number;
          name: string;
          field_id: number;
          boundary: GeoJsonPolygonInput;
        }>(
          `
            select
              block.id,
              block.name,
              field.id as field_id,
              ST_AsGeoJSON(block.boundary)::json as boundary
            from blocks block
            join fields field on field.id = block.field_id
            where block.id = $1 and field.farm_id = $2
          `,
          [blockId, auth.farmId]
        );
        const block = blockResult.rows[0];
        if (!block) {
          throw new Error("Block not found");
        }
        fieldId = block.field_id;
        locationName = block.name;
        coordinates = geoJsonPolygonToLatLngs(block.boundary);
      } else if (fieldId != null) {
        await ensureFieldInFarm(client, fieldId, auth.farmId);
        const fieldResult = await client.query<{
          id: number;
          name: string;
          boundary: GeoJsonPolygonInput;
        }>(
          `
            select
              id,
              name,
              ST_AsGeoJSON(boundary)::json as boundary
            from fields
            where id = $1 and farm_id = $2
          `,
          [fieldId, auth.farmId]
        );
        const field = fieldResult.rows[0];
        if (!field) {
          throw new Error("Field not found");
        }
        locationName = field.name;
        coordinates = geoJsonPolygonToLatLngs(field.boundary);
      }
  
      const applicationBedIds = [...new Set(body.applicationBedIds ?? [])];
      const transplantBedIds = [...new Set(body.transplantBedIds ?? [])];
      const cultivationBedIds = [...new Set(body.cultivationBedIds ?? [])];
      const workBedIds = [...new Set([...applicationBedIds, ...transplantBedIds, ...cultivationBedIds])];
      if (workBedIds.length > 0) {
        const bedsResult = await client.query<{
          id: number;
          block_id: number;
          field_id: number;
        }>(
          `
            select bed.id, bed.block_id, field.id as field_id
            from beds bed
            join blocks block on block.id = bed.block_id
            join fields field on field.id = block.field_id
            where bed.id = any($1::int[]) and field.farm_id = $2 and bed.source <> 'road'
          `,
          [workBedIds, auth.farmId]
        );
        if (bedsResult.rows.length !== workBedIds.length) {
          throw new Error("One or more selected work beds are not valid for this farm.");
        }
        const firstBed = bedsResult.rows[0];
        if (firstBed) {
          blockId = blockId ?? firstBed.block_id;
          fieldId = fieldId ?? firstBed.field_id;
        }
      }
      if (body.plantingId != null) {
        await ensurePlantingInFarm(client, body.plantingId, auth.farmId);
      }
      if (body.transplantPlantingId != null) {
        await ensurePlantingInFarm(client, body.transplantPlantingId, auth.farmId);
      }
  
      const workType = body.workType.trim();
      const title = body.title?.trim() || `${workType} at ${locationName}`;
      const metadata = {
        timelineVisible: true,
        source: "unplanned_work",
        workType,
        taskType: body.taskType?.trim() || null,
        workSubcategory: body.workSubcategory?.trim() || null,
        bedMakingBedCount: body.bedMakingBedCount ?? null,
        bedMakingBlockFull: body.bedMakingBlockFull ?? null,
        bedMakingBedCover: body.bedMakingBedCover ?? null,
        plantingId: body.plantingId ?? null,
        applicationRateUsed: body.applicationRateUsed ?? null,
        applicationAmountUsed: body.applicationAmountUsed ?? null,
        applicationProduct: body.applicationProduct?.trim() || null,
        applicationUnit: body.applicationUnit?.trim() || null,
        applicationAreaSqM: body.applicationAreaSqM ?? null,
        transplantPlantingId: body.transplantPlantingId ?? null,
        transplantCrop: body.transplantCrop?.trim() || null,
        transplantVariety: body.transplantVariety?.trim() || null,
        transplantPlantCount: body.transplantPlantCount ?? null,
        transplantTrayCount: body.transplantTrayCount ?? null,
        transplantInRowSpacing: body.transplantInRowSpacing ?? null,
        transplantRowsPerBed: body.transplantRowsPerBed ?? null,
        applicationBedIds,
        transplantBedIds,
        cultivationBedIds
      };
      await recordFarmEvent(client, {
        farmId: auth.farmId,
        eventDate: body.eventDate,
        eventType: "unplanned_work",
        title,
        notes: body.notes?.trim() || null,
        metadata,
        fieldId,
        blockId,
        zoneId,
        bedId,
        plantingId: body.plantingId ?? body.transplantPlantingId ?? null,
        coordinates
      });
  
      return { ok: true };
    });
  
    res.status(201).json(result);
  }));
  
  app.delete("/api/block-zones/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const zoneId = Number(req.params.id);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await ensureBlockZoneInFarm(client, zoneId, auth.farmId);
      await createUndoSnapshot(client, auth, "Delete block area");
      await client.query(
        `
          update plantings
          set intended_bed_id = null, updated_at = now()
          where farm_id = $2
            and intended_bed_id in (
              select bed.id
              from beds bed
              join blocks block on block.id = bed.block_id
              join fields field on field.id = block.field_id
              where bed.zone_id = $1 and field.farm_id = $2
            )
        `,
        [zoneId, auth.farmId]
      );
      await client.query(
        `
          delete from block_zones zone
          using blocks block, fields field
          where zone.block_id = block.id
            and block.field_id = field.id
            and zone.id = $1
            and field.farm_id = $2
        `,
        [zoneId, auth.farmId]
      );
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
}
