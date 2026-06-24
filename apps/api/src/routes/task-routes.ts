import express from "express";
import { AuthContext } from "../auth";
import { pool } from "../db";
import { polygonWkt } from "../geometry";
import { asyncHandler, currentAuth, requireRole } from "../route-helpers";
import { taskRecordSchema } from "../schemas";
import { recalculatePlantingTasks } from "../scheduler";
import { isCurrentTaskType, isLegacyTaskType } from "../types";
import { createUndoSnapshot, pruneUndoSnapshots } from "../undo";
import {
  bedMakingGuideLine,
  GeoJsonPolygonInput,
  inferHarvestRoadPatternFromBeds,
  loadBedMakingPreset,
  loadGeneratedBedBoundary,
  resolveBedMakingPreset
} from "./farm-route-helpers";
import type { FarmRouteDeps } from "./farm-routes";

type TaskRouteDeps = Pick<FarmRouteDeps, "ensurePlantableBedInFarm" | "ensureTaskInFarm" | "ensureSeedItemLot" | "learnSeedItemSpacingFromPlanting" | "insertGeneratedBeds" | "blockIdForBed" | "fieldIdForBlock" | "upsertBlockBedMakingTask" | "reflowExistingBlockPlacementPlan" | "moveBlockBedAssignmentsToOverflowForReplacement" | "getBedContext" | "recordFarmEvent" | "actualUpdateForTaskType" | "assertNoFuturePlantingDate">;

export function registerTaskRoutes(app: express.Express, deps: TaskRouteDeps) {
  const { ensurePlantableBedInFarm, ensureTaskInFarm, ensureSeedItemLot, learnSeedItemSpacingFromPlanting, insertGeneratedBeds, blockIdForBed, fieldIdForBlock, upsertBlockBedMakingTask, reflowExistingBlockPlacementPlan, moveBlockBedAssignmentsToOverflowForReplacement, getBedContext, recordFarmEvent, actualUpdateForTaskType, assertNoFuturePlantingDate } = deps;
  app.post("/api/tasks/:id/record", requireRole("worker"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = taskRecordSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await ensureTaskInFarm(client, id, auth.farmId);
      await createUndoSnapshot(client, auth, "Record task");
  
      const taskResult = await client.query<{
        id: number;
        planting_id: number | null;
        bed_id: number | null;
        task_type: string;
        title: string;
        notes: string | null;
      }>(
        `select id, planting_id, bed_id, task_type, title, notes from tasks where id = $1 and farm_id = $2`,
        [id, auth.farmId]
      );
  
      const task = taskResult.rows[0];
      if (!task) {
        await client.query("rollback");
        res.status(404).json({ error: "Task not found" });
        return;
      }
      if (!isCurrentTaskType(task.task_type)) {
        throw new Error(isLegacyTaskType(task.task_type)
          ? `This task uses the old category "${task.task_type}". Update its task flow to a current category before recording work.`
          : `This task uses the unknown category "${task.task_type}". Update its task flow to a current category before recording work.`);
      }
  
      let bedMakingMetadata: Record<string, unknown> | null = null;
      let recordedTaskBedId = task.bed_id;
      const bedMakingCompletedPlantingIds = new Set<number>();
      if (body.bedMakingBedCount != null || body.bedMakingMode != null || body.bedMakingBlockFull != null || body.bedMakingRows != null) {
        if (auth.role !== "planner") {
          throw new Error("Planner access required for bed-making adjustments");
        }
        if (task.task_type !== "bed_making") {
          throw new Error("Bed counts can only be recorded on bed-making tasks.");
        }
  
        const requestedRows = body.bedMakingRows?.filter((row) => row.count > 0) ?? [];
        const requestedRowCount = requestedRows.reduce((sum, row) => sum + row.count, 0);
        const bedCount = requestedRowCount > 0 ? requestedRowCount : body.bedMakingBedCount ?? null;
        if (bedCount == null || bedCount <= 0) {
          throw new Error("Enter the number of beds made.");
        }
        const requestedBlockFull = body.bedMakingBlockFull === true;
        const inferredMode = task.title.toLowerCase().includes("more beds") ? "add_after_existing" : "replace_existing";
        const mode = requestedBlockFull ? "replace_existing" : body.bedMakingMode ?? inferredMode;
  
        const blockResult = await client.query<{
          id: number;
          name: string;
          field_name: string;
          boundary: GeoJsonPolygonInput;
        }>(
          `
            with task_location as (
              select
                coalesce(task_bed.block_id, planting_bed.block_id, planting.intended_block_id) as block_id
              from tasks task
              left join plantings planting on planting.id = task.planting_id and planting.farm_id = task.farm_id
              left join beds task_bed on task_bed.id = task.bed_id
              left join beds planting_bed on planting_bed.id = planting.intended_bed_id
              where task.id = $1 and task.farm_id = $2
            )
            select
              block.id,
              block.name,
              field.name as field_name,
              ST_AsGeoJSON(block.boundary)::json as boundary
            from task_location
            join blocks block on block.id = task_location.block_id
            join fields field on field.id = block.field_id
            where field.farm_id = $2
          `,
          [task.id, auth.farmId]
        );
        const block = blockResult.rows[0];
        if (!block) {
          throw new Error("This bed-making task is not tied to a mapped block.");
        }
  
        const existingBeds = await client.query<{
          id: number;
          zone_id: number | null;
          bed_preset_id: number | null;
          is_permanent: boolean;
          sequence_no: number | null;
          bed_width_m: string | null;
          path_spacing_m: string | null;
          area_sqm: string | null;
          bed_length_m: string | null;
          boundary: GeoJsonPolygonInput;
        }>(
          `
            select
              bed.id,
              bed.zone_id,
              bed.bed_preset_id,
              bed.is_permanent,
              bed.sequence_no,
              preset.bed_width_m,
              preset.path_spacing_m,
              bed.area_sqm,
              bed.bed_length_m,
              ST_AsGeoJSON(coalesce(bed.boundary, ST_Transform(bed.geom, 4326)))::json as boundary
            from beds bed
            join blocks block on block.id = bed.block_id
            join fields field on field.id = block.field_id
            left join bed_presets preset on preset.id = bed.bed_preset_id
            where bed.block_id = $1
              and field.farm_id = $2
              and bed.source <> 'road'
            order by bed.sequence_no nulls last, bed.id
          `,
          [block.id, auth.farmId]
        );
        if (existingBeds.rows.length === 0) {
          throw new Error("Make at least one planned bed before recording actual bed-making.");
        }
  
        const plannedBedCount = existingBeds.rows.length;
        const unfinishedPlannedMatch = task.notes?.match(/(\d+)\s+planned beds were not made/i) ?? null;
        const plannedReferenceCount = unfinishedPlannedMatch
          ? existingBeds.rows.length + Number(unfinishedPlannedMatch[1])
          : plannedBedCount;
        const blockFull = requestedBlockFull || (mode === "replace_existing" && bedCount >= plannedReferenceCount);
        const targetBed = mode === "replace_existing" ? existingBeds.rows[0] : existingBeds.rows[existingBeds.rows.length - 1];
        const fallbackPreset = await resolveBedMakingPreset(client, auth.farmId, targetBed);
        const rowPresets = new Map<number, Awaited<ReturnType<typeof loadBedMakingPreset>>>();
        for (const row of requestedRows) {
          if (!rowPresets.has(row.presetId)) {
            rowPresets.set(row.presetId, await loadBedMakingPreset(client, auth.farmId, row.presetId));
          }
        }
        const recordedRows = requestedRows.length > 0
          ? requestedRows.map((row) => ({ count: row.count, preset: rowPresets.get(row.presetId) ?? fallbackPreset }))
          : [{ count: bedCount, preset: fallbackPreset }];
        const existingRowsForBlockFull: Array<{ count: number; preset: typeof fallbackPreset }> = [];
        if (blockFull && inferredMode === "add_after_existing") {
          for (const bed of existingBeds.rows) {
            let preset = fallbackPreset;
            if (bed.bed_preset_id != null) {
              if (!rowPresets.has(bed.bed_preset_id)) {
                rowPresets.set(bed.bed_preset_id, await loadBedMakingPreset(client, auth.farmId, bed.bed_preset_id));
              }
              preset = rowPresets.get(bed.bed_preset_id) ?? fallbackPreset;
            }
            existingRowsForBlockFull.push({ count: 1, preset });
          }
        }
        const rowsToGenerate = [...existingRowsForBlockFull, ...recordedRows];
  
        const lineCoordinates = bedMakingGuideLine(targetBed.boundary, block.boundary, mode);
        if (lineCoordinates.length < 2) {
          throw new Error("Could not read the planned bed edge for actual bed-making.");
        }
        const harvestRoadPattern = inferHarvestRoadPatternFromBeds(
          existingBeds.rows,
          bedMakingGuideLine(existingBeds.rows[0].boundary, block.boundary, "replace_existing")
        );
  
        if (mode === "replace_existing") {
          await moveBlockBedAssignmentsToOverflowForReplacement(client, auth.farmId, block.id, null);
        }
  
        const startNumber = mode === "replace_existing"
          ? 1
          : Math.max(
              existingBeds.rows.length + 1,
              ...existingBeds.rows.map((bed) => Number(bed.sequence_no ?? 0) + 1)
            );
        const bedsToGenerate = rowsToGenerate.flatMap((row) => Array.from({ length: row.count }, () => row.preset));
        const generatedBedCount = bedsToGenerate.length;
        const referencePreset = rowsToGenerate[0]?.preset ?? fallbackPreset;
        const plannedRoadSlotCount = harvestRoadPattern
          ? Math.floor(Math.max(0, plannedReferenceCount - 1) / harvestRoadPattern.everyBeds) * harvestRoadPattern.widthBeds
          : 0;
        const plannedSpanM =
          plannedReferenceCount * referencePreset.bedWidthM +
          Math.max(0, plannedReferenceCount - 1) * referencePreset.pathSpacingM +
          plannedRoadSlotCount * (referencePreset.bedWidthM + referencePreset.pathSpacingM);
        const generatedBedWidthM = rowsToGenerate.reduce((sum, row) => sum + row.count * row.preset.bedWidthM, 0);
        const generatedRoadSlotCount = harvestRoadPattern
          ? Math.floor(Math.max(0, generatedBedCount - 1) / harvestRoadPattern.everyBeds) * harvestRoadPattern.widthBeds
          : 0;
        const overTargetBlockFull = blockFull && mode === "replace_existing" && generatedBedCount > plannedReferenceCount;
        const overTargetScale = overTargetBlockFull
          ? Math.min(
              1,
              plannedSpanM / Math.max(
                0.1,
                generatedBedWidthM +
                  Math.max(0, generatedBedCount - 1) * referencePreset.pathSpacingM +
                  generatedRoadSlotCount * (referencePreset.bedWidthM + referencePreset.pathSpacingM)
              )
            )
          : null;
        const stretchedPathSpacingM = blockFull && generatedBedCount > 1
          ? overTargetScale != null
            ? referencePreset.pathSpacingM * overTargetScale
            : Math.max(
                0,
                (plannedSpanM - generatedBedWidthM - generatedRoadSlotCount * referencePreset.bedWidthM) /
                  Math.max(1, generatedBedCount - 1 + generatedRoadSlotCount)
              )
          : null;
        const bedWidthScale = overTargetScale;
        const insertedIds: number[] = [];
        let nextLineCoordinates = lineCoordinates;
        let nextStartNumber = startNumber;
        let replaceOnThisRun = mode === "replace_existing";
        const canBatchReplaceFromOriginalEdge = mode === "replace_existing"
          && bedsToGenerate.length > 0
          && bedsToGenerate.every((preset) => preset.id === bedsToGenerate[0].id);
        if (canBatchReplaceFromOriginalEdge) {
          const result = await insertGeneratedBeds(client, {
            blockId: block.id,
            farmId: auth.farmId,
            presetId: bedsToGenerate[0].id,
            zoneId: targetBed.zone_id ?? null,
            lineMode: "straight",
            lineCoordinates,
            count: generatedBedCount,
            layoutStartIndex: 0,
            edgeOffsetM: 0,
            namePrefix: `${block.name}-`,
            startNumber,
            isPermanent: targetBed.is_permanent,
            replaceExisting: true,
            invertSide: false,
            fillWholeBlock: blockFull,
            harvestRoadEveryBeds: harvestRoadPattern?.everyBeds ?? null,
            harvestRoadWidthBeds: harvestRoadPattern?.widthBeds ?? 0,
            pathSpacingOverrideM: stretchedPathSpacingM,
            bedWidthOverrideM: bedWidthScale == null ? null : bedsToGenerate[0].bedWidthM * bedWidthScale
          });
          const generatedIds = result.insertedIds ?? [];
          const keptIds = blockFull ? generatedIds.slice(0, generatedBedCount) : generatedIds;
          const extraIds = blockFull ? generatedIds.slice(generatedBedCount) : [];
          if (extraIds.length > 0) {
            await client.query(
              `
                delete from beds bed
                using blocks block, fields field
                where bed.block_id = block.id
                  and block.field_id = field.id
                  and field.farm_id = $2
                  and bed.id = any($1::int[])
              `,
              [extraIds, auth.farmId]
            );
          }
          if (keptIds.length !== generatedBedCount) {
            throw new Error(`Only ${keptIds.length} of ${generatedBedCount} beds fit from the planned bed edge.`);
          }
          insertedIds.push(...keptIds);
        } else {
          let plantableBedsBefore = mode === "replace_existing" ? 0 : existingBeds.rows.length;
          for (const preset of bedsToGenerate) {
            const basePathSpacingM = stretchedPathSpacingM ?? preset.pathSpacingM;
            const roadOffsetM = harvestRoadPattern && plantableBedsBefore > 0 && plantableBedsBefore % harvestRoadPattern.everyBeds === 0
              ? harvestRoadPattern.widthBeds * (preset.bedWidthM + basePathSpacingM)
              : 0;
            const rowEdgeOffsetM = replaceOnThisRun && mode === "replace_existing"
              ? 0
              : basePathSpacingM + roadOffsetM;
            const result = await insertGeneratedBeds(client, {
              blockId: block.id,
              farmId: auth.farmId,
              presetId: preset.id,
              zoneId: targetBed.zone_id ?? null,
              lineMode: "straight",
              lineCoordinates: nextLineCoordinates,
              count: 1,
              layoutStartIndex: 0,
              edgeOffsetM: rowEdgeOffsetM,
              namePrefix: `${block.name}-`,
              startNumber: nextStartNumber,
              isPermanent: targetBed.is_permanent,
              replaceExisting: replaceOnThisRun,
              invertSide: false,
              fillWholeBlock: false,
              harvestRoadEveryBeds: null,
              harvestRoadWidthBeds: 0,
              pathSpacingOverrideM: basePathSpacingM,
              bedWidthOverrideM: bedWidthScale == null ? null : preset.bedWidthM * bedWidthScale,
              ignoreBedIds: insertedIds
            });
            if (result.inserted !== 1) {
              throw new Error(`Only ${insertedIds.length + result.inserted} of ${generatedBedCount} beds fit from the planned bed edge.`);
            }
            insertedIds.push(...(result.insertedIds ?? []));
            const lastInsertedId = result.insertedIds?.[result.insertedIds.length - 1] ?? null;
            if (lastInsertedId != null) {
              const lastBoundary = await loadGeneratedBedBoundary(client, lastInsertedId, auth.farmId);
              nextLineCoordinates = bedMakingGuideLine(lastBoundary, block.boundary, "add_after_existing");
            }
            nextStartNumber += 1;
            plantableBedsBefore += 1;
            replaceOnThisRun = false;
          }
        }
        if (insertedIds.length !== generatedBedCount) {
          throw new Error(`Only ${insertedIds.length} of ${generatedBedCount} beds fit from the planned bed edge.`);
        }
        if (insertedIds.length) {
          recordedTaskBedId = mode === "replace_existing"
            ? insertedIds[0]
            : insertedIds[insertedIds.length - 1];
        }
  
        if (targetBed.zone_id != null) {
          await client.query(
            `
              update block_zones zone
              set actual_state = 'beds_made', updated_at = now()
              from blocks block, fields field
              where zone.block_id = block.id
                and block.field_id = field.id
                and zone.id = $1
                and field.farm_id = $2
            `,
            [targetBed.zone_id, auth.farmId]
          );
          if (task.planting_id != null) {
            await learnSeedItemSpacingFromPlanting(client, auth.farmId, task.planting_id);
          }
        }
        await reflowExistingBlockPlacementPlan(client, auth.farmId, block.id);
  
        if (!blockFull && mode === "replace_existing" && bedCount < plannedBedCount && insertedIds.length) {
          await client.query(
            `
              insert into tasks (
                farm_id, bed_id, task_type, title, status, anchor, offset_days,
                scheduled_date, notes, is_auto_generated, icon_color, icon_secondary_color
              )
              select $1, $2, 'bed_making', $3, 'pending', null, null, null, $4, true, '#8b6f43', '#f4c430'
              where not exists (
                select 1
                from tasks
                where farm_id = $1
                  and planting_id is null
                  and task_type = 'bed_making'
                  and status <> 'done'
                  and title = $3
              )
            `,
            [
              auth.farmId,
              insertedIds[insertedIds.length - 1],
              `Make more beds in ${block.field_name} / ${block.name}`,
              `Auto-created follow-up bed-making task. ${plannedBedCount - bedCount} planned beds were not made yet. Original planned bed count: ${plannedBedCount}.`
            ]
          );
        }
  
        bedMakingMetadata = {
          mode,
          bedCount,
          blockFull,
          plannedBedCount,
          plannedReferenceCount,
          generatedBedCount,
          insertedBedCount: insertedIds.length,
          rows: recordedRows.map((row) => ({ count: row.count, presetId: row.preset.id })),
          harvestRoadPattern,
          blockId: block.id
        };
  
        if (blockFull && task.planting_id != null) {
          const completedRelatedTasks = await client.query<{ planting_id: number }>(
            `
              update tasks related_task
              set
                status = 'done',
                completed_date = $3,
                notes = concat_ws(E'\n', related_task.notes, $4::text),
                bed_id = coalesce(related_task.bed_id, $5::integer),
                updated_at = now()
              from plantings planting
              left join beds intended_bed on intended_bed.id = planting.intended_bed_id
              where related_task.farm_id = $1
                and related_task.id <> $2
                and related_task.task_type = 'bed_making'
                and related_task.status <> 'done'
                and related_task.planting_id = planting.id
                and (
                  planting.intended_block_id = $6
                  or intended_bed.block_id = $6
                  or related_task.bed_id in (
                    select bed.id
                    from beds bed
                    join blocks block on block.id = bed.block_id
                    join fields field on field.id = block.field_id
                    where bed.block_id = $6 and field.farm_id = $1
                  )
                )
              returning related_task.planting_id
            `,
            [
              auth.farmId,
              id,
              body.actualDate,
              `Block beds made from ${task.title}; marked complete because Block full was recorded.`,
              recordedTaskBedId,
              block.id
            ]
          );
          for (const row of completedRelatedTasks.rows) {
            bedMakingCompletedPlantingIds.add(row.planting_id);
          }
        }
      }
  
      if (task.planting_id != null) {
        const taskActualUpdate = actualUpdateForTaskType(task.task_type);
        if (taskActualUpdate) {
          assertNoFuturePlantingDate(taskActualUpdate.eventType, body.actualDate);
        }
        const plantingResult = await client.query<{
          title: string;
          crop_id: number;
          variety_id: number | null;
          seed_item_id: number | null;
          crop_name: string;
          variety_name: string | null;
          seed_lot_number: string | null;
        }>(
          `
            select
              planting.title,
              planting.crop_id,
              planting.variety_id,
              planting.seed_item_id,
              crop.name as crop_name,
              variety.name as variety_name,
              seed.lot_number as seed_lot_number
            from plantings planting
            join crops crop on crop.id = planting.crop_id
            left join varieties variety on variety.id = planting.variety_id
            left join seed_items seed on seed.id = planting.seed_item_id
            where planting.id = $1 and planting.farm_id = $2
          `,
          [task.planting_id, auth.farmId]
        );
        const plantingRow = plantingResult.rows[0];
        const plantingTitle = plantingRow?.title ?? "Planting";
        const lotNumber = body.lotNumber?.trim() || null;
        const taskRequiresLotNumber = ["seed_in_tray", "direct_seed", "transplant"].includes(task.task_type);
        if (taskRequiresLotNumber) {
          if (!lotNumber) {
            throw new Error("Lot number is required when recording this planting task.");
          }
          if (!plantingRow) {
            throw new Error("Planting not found");
          }
          if (plantingRow.seed_item_id != null && (!plantingRow.seed_lot_number || plantingRow.seed_lot_number === lotNumber)) {
            await ensureSeedItemLot(client, plantingRow.seed_item_id, auth.farmId, lotNumber);
          } else {
            const matchingSeed = await client.query<{ id: number }>(
              `
                select seed.id
                from seed_items seed
                left join seed_item_lots lot on lot.seed_item_id = seed.id
                where seed.farm_id = $1
                  and seed.crop_id = $2
                  and (($3::integer is null and seed.variety_id is null) or seed.variety_id = $3)
                  and (seed.lot_number = $4 or lot.lot_number = $4)
                order by seed.id
                limit 1
              `,
              [auth.farmId, plantingRow.crop_id, plantingRow.variety_id, lotNumber]
            );
            const seedItemId = matchingSeed.rows[0]?.id ?? (await client.query<{ id: number }>(
              `
                insert into seed_items (
                  farm_id, crop_id, variety_id, family, crop_type, variety_name, breed_name, supplier, catalog_number, lot_number, notes
                )
                values ($1, $2, $3, null, $4, $5, null, null, null, $6, $7)
                returning id
              `,
              [
                auth.farmId,
                plantingRow.crop_id,
                plantingRow.variety_id,
                plantingRow.crop_name,
                plantingRow.variety_name,
                lotNumber,
                "Created from field work task completion."
              ]
            )).rows[0].id;
            await ensureSeedItemLot(client, seedItemId, auth.farmId, lotNumber);
            await client.query(
              `update plantings set seed_item_id = $2, updated_at = now() where id = $1 and farm_id = $3`,
              [task.planting_id, seedItemId, auth.farmId]
            );
          }
        }
        const hasPlantingAdjustments =
          body.intendedBedId !== undefined ||
          body.plantCount !== undefined ||
          body.bedLengthUsedM !== undefined ||
          body.trayCount !== undefined ||
          body.cellsPerTray !== undefined ||
          body.spacing !== undefined;
  
        if (hasPlantingAdjustments) {
          if (auth.role !== "planner") {
            throw new Error("Planner access required for planting adjustments");
          }
          if (body.intendedBedId != null) {
            await ensurePlantableBedInFarm(client, body.intendedBedId, auth.farmId);
          }
          const adjustedBlockId = body.intendedBedId != null ? await blockIdForBed(client, body.intendedBedId, auth.farmId) : null;
          const adjustedFieldId = adjustedBlockId != null ? await fieldIdForBlock(client, adjustedBlockId, auth.farmId) : null;
          await client.query(
            `
              update plantings
              set
                intended_field_id = case when $2::boolean then $3::integer else intended_field_id end,
                intended_block_id = case when $2::boolean then $4::integer else intended_block_id end,
                intended_bed_id = case when $2::boolean then $5::integer else intended_bed_id end,
                plant_count = case when $6::boolean then $7::integer else plant_count end,
                bed_length_used_m = case when $8::boolean then $9::numeric else bed_length_used_m end,
                spacing = case when $10::boolean then $11::text else spacing end,
                tray_count = case when $12::boolean then $13::numeric else tray_count end,
                cells_per_tray = case when $14::boolean then $15::integer else cells_per_tray end,
                updated_at = now()
              where id = $1 and farm_id = $16
            `,
            [
              task.planting_id,
              body.intendedBedId !== undefined,
              adjustedFieldId,
              adjustedBlockId,
              body.intendedBedId ?? null,
              body.plantCount !== undefined,
              body.plantCount ?? null,
              body.bedLengthUsedM !== undefined,
              body.bedLengthUsedM ?? null,
              body.spacing !== undefined,
              body.spacing ?? null,
              body.trayCount !== undefined,
              body.trayCount ?? null,
              body.cellsPerTray !== undefined,
              body.cellsPerTray ?? null,
              auth.farmId
            ]
          );
        }
  
        if (body.placementBedId != null && (body.placementPlantCount != null || body.placementBedLengthUsedM != null)) {
          if (auth.role !== "planner") {
            throw new Error("Planner access required for planting adjustments");
          }
          await ensurePlantableBedInFarm(client, body.placementBedId, auth.farmId);
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
              task.planting_id,
              body.placementBedId,
              body.placementPlantCount ?? null,
              body.placementBedLengthUsedM ?? null,
              body.actualDate,
              body.placementLocationDetail ?? null,
              body.placementNotes ?? null,
              body.placementCoordinates && body.placementCoordinates.length >= 3 ? polygonWkt(body.placementCoordinates) : null
            ]
          );
          const bedContext = await getBedContext(client, body.placementBedId, auth.farmId);
          await recordFarmEvent(client, {
            farmId: auth.farmId,
            eventDate: body.actualDate,
            eventType: "placement_recorded",
            title: `Placement recorded for ${plantingTitle}`,
            notes: body.placementNotes ?? null,
            metadata: {
              plantCount: body.placementPlantCount ?? null,
              bedLengthUsedM: body.placementBedLengthUsedM ?? null,
              locationDetail: body.placementLocationDetail ?? null,
              source: "task_record"
            },
            fieldId: bedContext.field_id,
            blockId: bedContext.block_id,
            zoneId: bedContext.zone_id,
            bedId: body.placementBedId,
            plantingId: task.planting_id,
            placementId: placementInsert.rows[0].id,
            taskId: id,
            coordinates: body.placementCoordinates ?? null
          });
        }
  
        const actualUpdate = actualUpdateForTaskType(task.task_type);
        if (actualUpdate) {
          await client.query(
            `
              update plantings
              set ${actualUpdate.field} = $2, status = $3, notes = concat_ws(E'\n', notes, $4::text), updated_at = now()
              where id = $1 and farm_id = $5
            `,
            [task.planting_id, body.actualDate, actualUpdate.status, body.notes ?? null, auth.farmId]
          );
        }
  
        const bedIdForBlockTask = body.placementBedId ?? body.intendedBedId ?? null;
        if (bedIdForBlockTask != null) {
          const blockId = await blockIdForBed(client, bedIdForBlockTask, auth.farmId);
          if (blockId != null) {
            await upsertBlockBedMakingTask(client, auth.farmId, blockId);
          }
        }
  
      }
  
      await client.query(
        `
          update tasks
          set
            status = 'done',
            completed_date = $2,
            notes = concat_ws(E'\n', notes, $3::text),
            bed_id = $4,
            updated_at = now()
          where id = $1 and farm_id = $5
        `,
        [id, body.actualDate, body.notes ?? null, recordedTaskBedId, auth.farmId]
      );
  
      await recordFarmEvent(client, {
        farmId: auth.farmId,
        eventDate: body.actualDate,
        eventType: "task_recorded",
        title: task.task_type.replaceAll("_", " "),
        notes: body.notes ?? null,
        metadata: {
          taskType: task.task_type,
          plantCount: body.plantCount ?? null,
          trayCount: body.trayCount ?? null,
          cellsPerTray: body.cellsPerTray ?? null,
          bedMaking: bedMakingMetadata
        },
        bedId: recordedTaskBedId ?? null,
        plantingId: task.planting_id ?? null,
        taskId: id
      });
  
      if (task.planting_id != null) {
        bedMakingCompletedPlantingIds.add(task.planting_id);
        await recalculatePlantingTasks(client, task.planting_id);
        const plantingBlock = await client.query<{ intended_block_id: number | null }>(
          `select intended_block_id from plantings where id = $1 and farm_id = $2`,
          [task.planting_id, auth.farmId]
        );
        const blockId = plantingBlock.rows[0]?.intended_block_id ?? null;
        if (blockId != null) {
          await reflowExistingBlockPlacementPlan(client, auth.farmId, blockId);
        }
      }
      for (const plantingId of bedMakingCompletedPlantingIds) {
        if (plantingId !== task.planting_id) {
          await recalculatePlantingTasks(client, plantingId);
        }
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
  
}
