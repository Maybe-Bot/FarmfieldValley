import express from "express";
import { PoolClient } from "pg";
import { AuthContext } from "./auth";
import { pool } from "./db";
import { asyncHandler, currentAuth, requireRole } from "./route-helpers";
import { assertUndoRestoreIsAccountSafe } from "./undo-safety";

const undoSnapshotTableNames = [
  "fields",
  "blocks",
  "cover_crop_names",
  "seed_items",
  "seed_item_lots",
  "bed_presets",
  "tractor_profiles",
  "block_zones",
  "beds",
  "task_flow_templates",
  "task_flow_steps",
  "task_flow_nodes",
  "task_flow_edges",
  "plantings",
  "planting_placements",
  "block_placement_gaps",
  "block_placement_overflows",
  "tasks",
  "harvest_records",
  "farm_events"
] as const;

const undoSnapshotSequenceNames = [
  "fields",
  "blocks",
  "cover_crop_names",
  "seed_items",
  "seed_item_lots",
  "bed_presets",
  "tractor_profiles",
  "block_zones",
  "beds",
  "task_flow_templates",
  "task_flow_steps",
  "task_flow_nodes",
  "task_flow_edges",
  "plantings",
  "planting_placements",
  "block_placement_gaps",
  "block_placement_overflows",
  "tasks",
  "harvest_records",
  "farm_events"
] as const;

async function captureFarmSnapshot(
  client: PoolClient,
  farmId: number
) {
  const result = await client.query<{ snapshot: Record<string, unknown> }>(
    `
      select jsonb_build_object(
        'fields', (select coalesce(jsonb_agg(to_jsonb(field) order by field.id), '[]'::jsonb) from fields field where field.farm_id = $1),
        'blocks', (
          select coalesce(jsonb_agg(to_jsonb(block) order by block.id), '[]'::jsonb)
          from blocks block
          join fields field on field.id = block.field_id
          where field.farm_id = $1
        ),
        'cover_crop_names', (select coalesce(jsonb_agg(to_jsonb(cover_crop) order by cover_crop.id), '[]'::jsonb) from cover_crop_names cover_crop where cover_crop.farm_id = $1),
        'seed_items', (select coalesce(jsonb_agg(to_jsonb(seed) order by seed.id), '[]'::jsonb) from seed_items seed where seed.farm_id = $1),
        'seed_item_lots', (
          select coalesce(jsonb_agg(to_jsonb(lot) order by lot.id), '[]'::jsonb)
          from seed_item_lots lot
          join seed_items seed on seed.id = lot.seed_item_id
          where seed.farm_id = $1
        ),
        'bed_presets', (select coalesce(jsonb_agg(to_jsonb(preset) order by preset.id), '[]'::jsonb) from bed_presets preset where preset.farm_id = $1),
        'tractor_profiles', (select coalesce(jsonb_agg(to_jsonb(profile) order by profile.id), '[]'::jsonb) from tractor_profiles profile where profile.farm_id = $1),
        'block_zones', (
          select coalesce(jsonb_agg(to_jsonb(zone) order by zone.id), '[]'::jsonb)
          from block_zones zone
          join blocks block on block.id = zone.block_id
          join fields field on field.id = block.field_id
          where field.farm_id = $1
        ),
        'beds', (
          select coalesce(jsonb_agg(to_jsonb(bed) order by bed.id), '[]'::jsonb)
          from beds bed
          join blocks block on block.id = bed.block_id
          join fields field on field.id = block.field_id
          where field.farm_id = $1
        ),
        'task_flow_templates', (select coalesce(jsonb_agg(to_jsonb(template) order by template.id), '[]'::jsonb) from task_flow_templates template where template.farm_id = $1),
        'task_flow_steps', (
          select coalesce(jsonb_agg(to_jsonb(step) order by step.id), '[]'::jsonb)
          from task_flow_steps step
          join task_flow_templates template on template.id = step.flow_template_id
          where template.farm_id = $1
        ),
        'task_flow_nodes', (
          select coalesce(jsonb_agg(to_jsonb(node) order by node.id), '[]'::jsonb)
          from task_flow_nodes node
          join task_flow_templates template on template.id = node.flow_template_id
          where template.farm_id = $1
        ),
        'task_flow_edges', (
          select coalesce(jsonb_agg(to_jsonb(edge) order by edge.id), '[]'::jsonb)
          from task_flow_edges edge
          join task_flow_templates template on template.id = edge.flow_template_id
          where template.farm_id = $1
        ),
        'plantings', (select coalesce(jsonb_agg(to_jsonb(planting) order by planting.id), '[]'::jsonb) from plantings planting where planting.farm_id = $1),
        'planting_placements', (
          select coalesce(jsonb_agg(to_jsonb(placement) order by placement.id), '[]'::jsonb)
          from planting_placements placement
          join plantings planting on planting.id = placement.planting_id
          where planting.farm_id = $1
        ),
        'block_placement_gaps', (select coalesce(jsonb_agg(to_jsonb(gap) order by gap.id), '[]'::jsonb) from block_placement_gaps gap where gap.farm_id = $1),
        'block_placement_overflows', (select coalesce(jsonb_agg(to_jsonb(overflow) order by overflow.id), '[]'::jsonb) from block_placement_overflows overflow where overflow.farm_id = $1),
        'tasks', (select coalesce(jsonb_agg(to_jsonb(task) order by task.id), '[]'::jsonb) from tasks task where task.farm_id = $1),
        'harvest_records', (select coalesce(jsonb_agg(to_jsonb(harvest) order by harvest.id), '[]'::jsonb) from harvest_records harvest where harvest.farm_id = $1),
        'farm_events', (select coalesce(jsonb_agg(to_jsonb(event) order by event.id), '[]'::jsonb) from farm_events event where event.farm_id = $1)
      ) as snapshot
    `,
    [farmId]
  );

  return result.rows[0]?.snapshot ?? {};
}

// Undo/redo is snapshot-based. Before a change, we capture the important farm
// tables, then restore that JSON later if the user clicks Undo.
export async function createUndoSnapshot(
  client: PoolClient,
  auth: AuthContext,
  label: string
) {
  // This is a prototype-friendly undo model: capture the farm's mutable planning
  // tables before a write, then restore the latest snapshot if the user clicks Undo.
  // A new write after Undo clears the redo branch, matching normal undo/redo behavior.
  await client.query(
    `delete from undo_snapshots where farm_id = $1 and user_id = $2 and undone_at is not null`,
    [auth.farmId, auth.userId]
  );
  const snapshot = await captureFarmSnapshot(client, auth.farmId);

  await client.query(
    `
      insert into undo_snapshots (farm_id, user_id, label, snapshot)
      values ($1, $2, $3, $4::jsonb)
    `,
    [auth.farmId, auth.userId, label, JSON.stringify(snapshot)]
  );
}

export async function pruneUndoSnapshots(client: PoolClient, auth: AuthContext) {
  await client.query(
    `
      delete from undo_snapshots
      where farm_id = $1
        and user_id = $2
        and id not in (
          select id
          from undo_snapshots
          where farm_id = $1 and user_id = $2 and undone_at is null
          order by created_at desc, id desc
          limit 8
        )
        and id not in (
          select id
          from undo_snapshots
          where farm_id = $1 and user_id = $2 and undone_at is not null
          order by created_at desc, id desc
          limit 4
        )
    `,
    [auth.farmId, auth.userId]
  );
}

async function resetSerialSequence(client: PoolClient, tableName: string) {
  await client.query(`
    select setval(
      pg_get_serial_sequence('${tableName}', 'id'),
      greatest(coalesce((select max(id) from ${tableName}), 0), 1),
      coalesce((select max(id) from ${tableName}), 0) > 0
    )
  `);
}

async function restoreFarmSnapshot(
  client: PoolClient,
  farmId: number,
  snapshot: Record<string, unknown>
) {
  const snapshotHasSeedItemLots = Object.prototype.hasOwnProperty.call(snapshot, "seed_item_lots");
  const fallbackSeedItemLots = snapshotHasSeedItemLots
    ? null
    : await client.query<{ lots: unknown }>(
        `
          select coalesce(jsonb_agg(to_jsonb(lot) order by lot.id), '[]'::jsonb) as lots
          from seed_item_lots lot
          join seed_items seed on seed.id = lot.seed_item_id
          where seed.farm_id = $1
        `,
        [farmId]
      ).then((result) => result.rows[0]?.lots ?? []);
  await client.query(`delete from farm_events where farm_id = $1`, [farmId]);
  await client.query(`delete from harvest_records where farm_id = $1`, [farmId]);
  await client.query(`delete from tasks where farm_id = $1`, [farmId]);
  await client.query(`delete from block_placement_overflows where farm_id = $1`, [farmId]);
  await client.query(`delete from block_placement_gaps where farm_id = $1`, [farmId]);
  await client.query(`delete from planting_placements where planting_id in (select id from plantings where farm_id = $1)`, [farmId]);
  await client.query(`delete from plantings where farm_id = $1`, [farmId]);
  await client.query(`delete from task_flow_edges where flow_template_id in (select id from task_flow_templates where farm_id = $1)`, [farmId]);
  await client.query(`delete from task_flow_nodes where flow_template_id in (select id from task_flow_templates where farm_id = $1)`, [farmId]);
  await client.query(`delete from task_flow_steps where flow_template_id in (select id from task_flow_templates where farm_id = $1)`, [farmId]);
  await client.query(`delete from task_flow_templates where farm_id = $1`, [farmId]);
  await client.query(
    `
      delete from beds
      where block_id in (
        select block.id
        from blocks block
        join fields field on field.id = block.field_id
        where field.farm_id = $1
      )
    `,
    [farmId]
  );
  await client.query(
    `
      delete from block_zones
      where block_id in (
        select block.id
        from blocks block
        join fields field on field.id = block.field_id
        where field.farm_id = $1
      )
    `,
    [farmId]
  );
  await client.query(`delete from cover_crop_names where farm_id = $1`, [farmId]);
  if (snapshotHasSeedItemLots) {
    await client.query(`delete from seed_item_lots where seed_item_id in (select id from seed_items where farm_id = $1)`, [farmId]);
  }
  await client.query(`delete from seed_items where farm_id = $1`, [farmId]);
  await client.query(`delete from bed_presets where farm_id = $1`, [farmId]);
  await client.query(`delete from tractor_profiles where farm_id = $1`, [farmId]);
  await client.query(`delete from blocks where field_id in (select id from fields where farm_id = $1)`, [farmId]);
  await client.query(`delete from fields where farm_id = $1`, [farmId]);

  // jsonb_populate_recordset lets Postgres rehydrate date, numeric, array, jsonb,
  // and PostGIS geometry columns using the same text representations it exported.
  for (const tableName of undoSnapshotTableNames) {
    if (tableName === "seed_item_lots" && !snapshotHasSeedItemLots) {
      continue;
    }
    await client.query(
      `insert into ${tableName} select * from jsonb_populate_recordset(null::${tableName}, $1::jsonb->'${tableName}')`,
      [JSON.stringify(snapshot)]
    );
  }

  if (!snapshotHasSeedItemLots && fallbackSeedItemLots) {
    await client.query(
      `
        insert into seed_item_lots
        select lot.*
        from jsonb_populate_recordset(null::seed_item_lots, $1::jsonb) as lot
        where exists (select 1 from seed_items seed where seed.id = lot.seed_item_id)
      `,
      [JSON.stringify(fallbackSeedItemLots)]
    );
  }

  for (const tableName of undoSnapshotSequenceNames) {
    await resetSerialSequence(client, tableName);
  }
}

export async function runWithUndoSnapshot<T>(
  auth: AuthContext,
  label: string,
  work: (client: PoolClient) => Promise<T>
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await createUndoSnapshot(client, auth, label);
    const result = await work(client);
    await pruneUndoSnapshots(client, auth);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export function registerUndoRoutes(app: express.Express) {
  // Recent undo/redo controls for the current farm user.
  app.get("/api/undo", requireRole("worker"), asyncHandler(async (req, res) => {
    const auth = currentAuth(req) as AuthContext;
    const [undoResult, redoResult] = await Promise.all([
      pool.query(
        `
          select
            id,
            label,
            created_at as "createdAt"
          from undo_snapshots
          where farm_id = $1
            and user_id = $2
            and undone_at is null
          order by created_at desc, id desc
          limit 8
        `,
        [auth.farmId, auth.userId]
      ),
      pool.query(
        `
          select
            id,
            label,
            undone_at as "createdAt"
          from undo_snapshots
          where farm_id = $1
            and user_id = $2
            and undone_at is not null
            and redo_snapshot is not null
          order by undone_at desc, id desc
          limit 8
        `,
        [auth.farmId, auth.userId]
      )
    ]);
    res.json({ undo: undoResult.rows, redo: redoResult.rows });
  }));
  
  app.post("/api/undo", requireRole("worker"), asyncHandler(async (req, res) => {
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<{ id: number; label: string; snapshot: Record<string, unknown>; created_at: string }>(
        `
          select id, label, snapshot, created_at
          from undo_snapshots
          where farm_id = $1
            and user_id = $2
            and undone_at is null
          order by created_at desc, id desc
          limit 1
          for update
        `,
        [auth.farmId, auth.userId]
      );
      const snapshot = result.rows[0];
      if (!snapshot) {
        await client.query("rollback");
        res.status(404).json({ error: "Nothing to undo" });
        return;
      }
  
      await assertUndoRestoreIsAccountSafe(client, auth, snapshot.created_at, "undo");
      const redoSnapshot = await captureFarmSnapshot(client, auth.farmId);
      await restoreFarmSnapshot(client, auth.farmId, snapshot.snapshot);
      await client.query(
        `update undo_snapshots set undone_at = now(), redo_snapshot = $2::jsonb, redone_at = null where id = $1`,
        [snapshot.id, JSON.stringify(redoSnapshot)]
      );
      await client.query("commit");
      res.json({ ok: true, label: snapshot.label });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));
  
  app.post("/api/redo", requireRole("worker"), asyncHandler(async (req, res) => {
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<{ id: number; label: string; redo_snapshot: Record<string, unknown>; undone_at: string }>(
        `
          select id, label, redo_snapshot, undone_at
          from undo_snapshots
          where farm_id = $1
            and user_id = $2
            and undone_at is not null
            and redo_snapshot is not null
          order by undone_at desc, id desc
          limit 1
          for update
        `,
        [auth.farmId, auth.userId]
      );
      const snapshot = result.rows[0];
      if (!snapshot) {
        await client.query("rollback");
        res.status(404).json({ error: "Nothing to redo" });
        return;
      }
  
      await assertUndoRestoreIsAccountSafe(client, auth, snapshot.undone_at, "redo");
      await restoreFarmSnapshot(client, auth.farmId, snapshot.redo_snapshot);
      await client.query(`update undo_snapshots set undone_at = null, redone_at = now() where id = $1`, [snapshot.id]);
      await client.query("commit");
      res.json({ ok: true, label: snapshot.label });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));
}
