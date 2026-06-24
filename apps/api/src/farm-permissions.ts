import { PoolClient } from "pg";

export async function ensureFieldInFarm(client: PoolClient, fieldId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `select id from fields where id = $1 and farm_id = $2`,
    [fieldId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Field not found in this farm");
  }
}

export async function ensureBlockInFarm(client: PoolClient, blockId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `
      select block.id
      from blocks block
      join fields field on field.id = block.field_id
      where block.id = $1 and field.farm_id = $2
    `,
    [blockId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Block not found in this farm");
  }
}

export async function ensureBlockZoneInFarm(client: PoolClient, zoneId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `
      select zone.id
      from block_zones zone
      join blocks block on block.id = zone.block_id
      join fields field on field.id = block.field_id
      where zone.id = $1 and field.farm_id = $2
    `,
    [zoneId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Block zone not found in this farm");
  }
}

export async function ensureBedInFarm(client: PoolClient, bedId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `
      select bed.id
      from beds bed
      join blocks block on block.id = bed.block_id
      join fields field on field.id = block.field_id
      where bed.id = $1 and field.farm_id = $2
    `,
    [bedId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Bed not found in this farm");
  }
}

export async function ensurePlantableBedInFarm(client: PoolClient, bedId: number, farmId: number) {
  const result = await client.query<{ id: number; source: string }>(
    `
      select bed.id, bed.source
      from beds bed
      join blocks block on block.id = bed.block_id
      join fields field on field.id = block.field_id
      where bed.id = $1 and field.farm_id = $2
    `,
    [bedId, farmId]
  );
  const bed = result.rows[0];
  if (!bed) {
    throw new Error("Bed not found in this farm");
  }
  if (bed.source === "road") {
    throw new Error("Road/path presets are not plantable beds");
  }
}

export async function ensurePlantingInFarm(client: PoolClient, plantingId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `select id from plantings where id = $1 and farm_id = $2`,
    [plantingId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Planting not found in this farm");
  }
}

export async function ensureTaskInFarm(client: PoolClient, taskId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `select id from tasks where id = $1 and farm_id = $2`,
    [taskId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Task not found in this farm");
  }
}

export async function ensureTaskFlowInFarm(client: PoolClient, taskFlowId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `select id from task_flow_templates where id = $1 and farm_id = $2`,
    [taskFlowId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Task flow template not found in this farm");
  }
}

export async function ensureBedPresetInFarm(client: PoolClient, presetId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `select id from bed_presets where id = $1 and farm_id = $2`,
    [presetId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Bed preset not found in this farm");
  }
}

export async function ensureTractorProfileInFarm(client: PoolClient, profileId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `select id from tractor_profiles where id = $1 and farm_id = $2`,
    [profileId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Tractor not found in this farm");
  }
}

export async function ensureCoverCropNameInFarm(client: PoolClient, coverCropNameId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `select id from cover_crop_names where id = $1 and farm_id = $2`,
    [coverCropNameId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Cover crop name not found in this farm");
  }
}

export async function ensureSeedItemInFarm(client: PoolClient, seedItemId: number, farmId: number) {
  const result = await client.query<{ id: number }>(
    `select id from seed_items where id = $1 and farm_id = $2`,
    [seedItemId, farmId]
  );
  if (!result.rows[0]) {
    throw new Error("Seed item not found in this farm");
  }
}

export async function ensureSeedItemLot(client: PoolClient, seedItemId: number, farmId: number, lotNumber: string) {
  await ensureSeedItemInFarm(client, seedItemId, farmId);
  await client.query(
    `
      insert into seed_item_lots (seed_item_id, lot_number)
      values ($1, $2)
      on conflict (seed_item_id, lot_number) do update set updated_at = now()
    `,
    [seedItemId, lotNumber]
  );
  await client.query(
    `
      update seed_items
      set lot_number = coalesce(lot_number, $2), updated_at = now()
      where id = $1 and farm_id = $3
    `,
    [seedItemId, lotNumber, farmId]
  );
}

