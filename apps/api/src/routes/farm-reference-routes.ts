import express from "express";
import { AuthContext } from "../auth";
import { pool } from "../db";
import { asyncHandler, currentAuth, requireRole } from "../route-helpers";
import { bedPresetSchema, coverCropNameSchema, seedItemSchema, tractorProfileSchema } from "../schemas";
import { createUndoSnapshot, pruneUndoSnapshots, runWithUndoSnapshot } from "../undo";
import type { FarmRouteDeps } from "./farm-routes";
import { registerSpreadsheetImportRoutes } from "./spreadsheet-import";

type FarmReferenceRouteDeps = Pick<FarmRouteDeps, "normalizedSeedLots" | "replaceSeedItemLots" | "ensureBedPresetInFarm" | "ensureTractorProfileInFarm" | "ensureSeedItemInFarm">;

export function registerFarmReferenceRoutes(app: express.Express, deps: FarmReferenceRouteDeps) {
  const { normalizedSeedLots, replaceSeedItemLots, ensureBedPresetInFarm, ensureTractorProfileInFarm, ensureSeedItemInFarm } = deps;
  // Small lookup/create routes used by planning forms.
  app.post("/api/bed-presets", requireRole("planner"), asyncHandler(async (req, res) => {
    const body = bedPresetSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const result = await runWithUndoSnapshot(auth, "Create bed preset", async (client) => {
      const insert = await client.query<{ id: number }>(
        `
          insert into bed_presets (farm_id, name, bed_width_m, path_spacing_m, is_road, notes)
          values ($1, $2, $3, $4, $5, $6)
          on conflict (farm_id, name) do update
          set bed_width_m = excluded.bed_width_m,
              path_spacing_m = excluded.path_spacing_m,
              is_road = excluded.is_road,
              notes = excluded.notes,
              updated_at = now()
          returning id
        `,
        [auth.farmId, body.name, body.bedWidthM, body.pathSpacingM, body.isRoad, body.notes ?? null]
      );
      return insert.rows[0];
    });
    res.status(201).json({ id: result.id });
  }));
  
  app.delete("/api/bed-presets/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const auth = currentAuth(req) as AuthContext;
    await runWithUndoSnapshot(auth, "Delete bed preset", async (client) => {
      await ensureBedPresetInFarm(client, id, auth.farmId);
      await client.query(
        `
          update beds bed
          set bed_preset_id = null, updated_at = now()
          from blocks block, fields field
          where bed.block_id = block.id
            and block.field_id = field.id
            and bed.bed_preset_id = $1
            and field.farm_id = $2
        `,
        [id, auth.farmId]
      );
      await client.query(`delete from bed_presets where id = $1 and farm_id = $2`, [id, auth.farmId]);
    });
    res.json({ ok: true });
  }));
  
  app.get("/api/tractor-profiles", requireRole("worker"), asyncHandler(async (req, res) => {
    const auth = currentAuth(req) as AuthContext;
    const result = await pool.query(
      `
        select
          id,
          farm_id as "farmId",
          name,
          tractor_model as "tractorModel",
          icon_color as "iconColor",
          icon_secondary_color as "iconSecondaryColor"
        from tractor_profiles
        where farm_id = $1
        order by name, id
      `,
      [auth.farmId]
    );
    res.json(result.rows);
  }));
  
  app.post("/api/tractor-profiles", requireRole("planner"), asyncHandler(async (req, res) => {
    const body = tractorProfileSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const result = await runWithUndoSnapshot(auth, "Create vehicle", async (client) => {
      const insert = await client.query<{
        id: number;
        farmId: number;
        name: string;
        tractorModel: string;
        iconColor: string;
        iconSecondaryColor: string;
      }>(
        `
          insert into tractor_profiles (farm_id, name, tractor_model, icon_color, icon_secondary_color)
          values ($1, $2, $3, $4, $5)
          returning
            id,
            farm_id as "farmId",
            name,
            tractor_model as "tractorModel",
            icon_color as "iconColor",
            icon_secondary_color as "iconSecondaryColor"
        `,
        [auth.farmId, body.name.trim(), body.tractorModel, body.iconColor, body.iconSecondaryColor]
      );
      return insert.rows[0];
    });
    res.status(201).json(result);
  }));
  
  app.put("/api/tractor-profiles/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = tractorProfileSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const result = await runWithUndoSnapshot(auth, "Update vehicle", async (client) => {
      await ensureTractorProfileInFarm(client, id, auth.farmId);
      const result = await client.query<{
        id: number;
        farmId: number;
        name: string;
        tractorModel: string;
        iconColor: string;
        iconSecondaryColor: string;
      }>(
        `
          update tractor_profiles
          set
            name = $3,
            tractor_model = $4,
            icon_color = $5,
            icon_secondary_color = $6
          where id = $1 and farm_id = $2
          returning
            id,
            farm_id as "farmId",
            name,
            tractor_model as "tractorModel",
            icon_color as "iconColor",
            icon_secondary_color as "iconSecondaryColor"
        `,
        [id, auth.farmId, body.name.trim(), body.tractorModel, body.iconColor, body.iconSecondaryColor]
      );
      await client.query(
        `
          update task_flow_nodes
          set
            tractor_model = $2,
            icon_color = $3,
            icon_secondary_color = $4
          where tractor_profile_id = $1
            and flow_template_id in (
              select id from task_flow_templates where farm_id = $5
            )
        `,
        [id, body.tractorModel, body.iconColor, body.iconSecondaryColor, auth.farmId]
      );
      await client.query(
        `
          update tasks
          set
            tractor_model = $2,
            icon_color = $3,
            icon_secondary_color = $4,
            updated_at = now()
          where tractor_profile_id = $1 and farm_id = $5
        `,
        [id, body.tractorModel, body.iconColor, body.iconSecondaryColor, auth.farmId]
      );
      return result.rows[0];
    });
    res.json(result);
  }));
  
  app.delete("/api/tractor-profiles/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const auth = currentAuth(req) as AuthContext;
    await runWithUndoSnapshot(auth, "Delete vehicle", async (client) => {
      await ensureTractorProfileInFarm(client, id, auth.farmId);
      await client.query(
        `
          update task_flow_nodes
          set tractor_profile_id = null
          where tractor_profile_id = $1
            and flow_template_id in (
              select id from task_flow_templates where farm_id = $2
            )
        `,
        [id, auth.farmId]
      );
      await client.query(`update tasks set tractor_profile_id = null where tractor_profile_id = $1 and farm_id = $2`, [id, auth.farmId]);
      await client.query(`delete from tractor_profiles where id = $1 and farm_id = $2`, [id, auth.farmId]);
    });
    res.json({ ok: true });
  }));
  
  app.post("/api/cover-crops", requireRole("planner"), asyncHandler(async (req, res) => {
    const body = coverCropNameSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    if (body.farmId !== auth.farmId) {
      res.status(403).json({ error: "Planner access required" });
      return;
    }
  
    const result = await runWithUndoSnapshot(auth, "Create cover crop name", async (client) => {
      const insert = await client.query<{ id: number; name: string; notes: string | null }>(
        `
          insert into cover_crop_names (farm_id, name, notes)
          values ($1, $2, $3)
          on conflict (farm_id, name)
          do update set notes = coalesce(excluded.notes, cover_crop_names.notes), updated_at = now()
          returning id, name, notes
        `,
        [body.farmId, body.name.trim(), body.notes ?? null]
      );
      return insert.rows[0];
    });
    res.status(201).json({
      id: result.id,
      farmId: body.farmId,
      name: result.name,
      notes: result.notes
    });
  }));
  
  app.post("/api/seed-items", requireRole("planner"), asyncHandler(async (req, res) => {
    const body = seedItemSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    if (body.farmId !== auth.farmId) {
      res.status(403).json({ error: "Planner access required" });
      return;
    }
  
    const result = await runWithUndoSnapshot(auth, "Create seed genetics item", async (client) => {
      const cropResult = await client.query<{ id: number }>(
        `
          insert into crops (name)
          values ($1)
          on conflict (name) do update set name = excluded.name
          returning id
        `,
        [body.cropType.trim()]
      );
      const cropId = cropResult.rows[0].id;
  
      let varietyId: number | null = null;
      const varietyName = body.varietyName?.trim();
      if (varietyName) {
        const varietyResult = await client.query<{ id: number }>(
          `
            insert into varieties (crop_id, name)
            values ($1, $2)
            on conflict (crop_id, name) do update set name = excluded.name
            returning id
          `,
          [cropId, varietyName]
        );
        varietyId = varietyResult.rows[0].id;
      }
      const lots = normalizedSeedLots(body.lots, body.lotNumber ?? null, body.stockQuantity ?? null);
      const totalStock = lots.some((lot) => lot.stockQuantity != null)
        ? lots.reduce((sum, lot) => sum + (lot.stockQuantity ?? 0), 0)
        : null;
  
      const seedResult = await client.query<{ id: number }>(
        `
          insert into seed_items (
            farm_id, crop_id, variety_id, family, crop_type, variety_name, breed_name, supplier, catalog_number, lot_number, stock_quantity, days_to_maturity, notes
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          returning id
        `,
        [
          auth.farmId,
          cropId,
          varietyId,
          body.family?.trim() || null,
          body.cropType.trim(),
          varietyName || null,
          body.breedName?.trim() || null,
          body.supplier?.trim() || null,
          body.catalogNumber?.trim() || null,
          lots[0]?.lotNumber ?? null,
          totalStock,
          body.daysToMaturity ?? null,
          body.notes ?? null
        ]
      );
      await replaceSeedItemLots(client, seedResult.rows[0].id, auth.farmId, lots);
  
      return { id: seedResult.rows[0].id, cropId, varietyId };
    });
  
    res.status(201).json(result);
  }));
  
  app.put("/api/seed-items/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = seedItemSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    if (body.farmId !== auth.farmId) {
      res.status(403).json({ error: "Planner access required" });
      return;
    }
  
    await runWithUndoSnapshot(auth, "Update seed item", async (client) => {
      await ensureSeedItemInFarm(client, id, auth.farmId);
      const cropResult = await client.query<{ id: number }>(
        `
          insert into crops (name)
          values ($1)
          on conflict (name) do update set name = excluded.name
          returning id
        `,
        [body.cropType.trim()]
      );
      const cropId = cropResult.rows[0].id;
  
      let varietyId: number | null = null;
      const varietyName = body.varietyName?.trim();
      if (varietyName) {
        const varietyResult = await client.query<{ id: number }>(
          `
            insert into varieties (crop_id, name)
            values ($1, $2)
            on conflict (crop_id, name) do update set name = excluded.name
            returning id
          `,
          [cropId, varietyName]
        );
        varietyId = varietyResult.rows[0].id;
      }
      const lots = normalizedSeedLots(body.lots, body.lotNumber ?? null, body.stockQuantity ?? null);
      const totalStock = lots.some((lot) => lot.stockQuantity != null)
        ? lots.reduce((sum, lot) => sum + (lot.stockQuantity ?? 0), 0)
        : null;
  
      await client.query(
        `
          update seed_items
          set
            crop_id = $2,
            variety_id = $3,
            family = $4,
            crop_type = $5,
            variety_name = $6,
            breed_name = $7,
            supplier = $8,
            catalog_number = $9,
            lot_number = $10,
            stock_quantity = $11,
            days_to_maturity = $12,
            notes = $13,
            updated_at = now()
          where id = $1 and farm_id = $14
        `,
        [
          id,
          cropId,
          varietyId,
          body.family?.trim() || null,
          body.cropType.trim(),
          varietyName || null,
          body.breedName?.trim() || null,
          body.supplier?.trim() || null,
          body.catalogNumber?.trim() || null,
          lots[0]?.lotNumber ?? null,
          totalStock,
          body.daysToMaturity ?? null,
          body.notes ?? null,
          auth.farmId
        ]
      );
      await replaceSeedItemLots(client, id, auth.farmId, lots);
    });
  
    res.json({ ok: true });
  }));
  
  app.delete("/api/seed-items/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const auth = currentAuth(req) as AuthContext;
    await runWithUndoSnapshot(auth, "Archive seed item", async (client) => {
      await ensureSeedItemInFarm(client, id, auth.farmId);
      await client.query(
        `update seed_items set archived_at = coalesce(archived_at, now()), updated_at = now() where id = $1 and farm_id = $2`,
        [id, auth.farmId]
      );
    });
    res.json({ ok: true });
  }));
  
  app.post("/api/seed-items/:id/restore", requireRole("planner"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const auth = currentAuth(req) as AuthContext;
    await runWithUndoSnapshot(auth, "Restore seed item", async (client) => {
      await ensureSeedItemInFarm(client, id, auth.farmId);
      await client.query(
        `update seed_items set archived_at = null, updated_at = now() where id = $1 and farm_id = $2`,
        [id, auth.farmId]
      );
    });
    res.json({ ok: true });
  }));
  
  registerSpreadsheetImportRoutes(app);
  
}
