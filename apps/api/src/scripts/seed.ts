/**
 * Creates sample data for local demos.
 *
 * This script is useful for a fresh local demo database. It intentionally
 * truncates user and farm data, so it requires LOAM_LEDGER_CONFIRM_DESTRUCTIVE_SEED
 * unless the target database appears empty.
 */
import { pool } from "../db";
import { PoolClient } from "pg";
import { hashPassword } from "../auth";
import { generateBedLayouts } from "../beds";
import { boundingBox, Coordinate, polygonWkt } from "../geometry";
import { recalculatePlantingTasks } from "../scheduler";
import { TaskType } from "../types";

export async function databaseHasExistingData(client: PoolClient) {
  const result = await client.query<{ count: string }>(
    `
      select (
        (select count(*) from farms) +
        (select count(*) from app_users) +
        (select count(*) from fields) +
        (select count(*) from plantings) +
        (select count(*) from farm_events)
      )::text as count
    `
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}

export async function assertDestructiveSeedAllowed(client: PoolClient) {
  if (process.env.LOAM_LEDGER_CONFIRM_DESTRUCTIVE_SEED === "yes") {
    return;
  }

  if (!(await databaseHasExistingData(client))) {
    return;
  }

  throw new Error(
    "Refusing to run db:seed because this database already has user/farm data. " +
    "This seed script truncates most tables. If you intentionally want to wipe and reload demo data, run: " +
    "LOAM_LEDGER_CONFIRM_DESTRUCTIVE_SEED=yes npm run db:seed"
  );
}

function rectangleWkt(x: number, y: number, width: number, height: number) {
  const x2 = x + width;
  const y2 = y + height;
  return `POLYGON((${x} ${y}, ${x2} ${y}, ${x2} ${y2}, ${x} ${y2}, ${x} ${y}))`;
}

function centroidOf(points: Coordinate[]) {
  const lat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const lng = points.reduce((sum, point) => sum + point.lng, 0) / points.length;
  return { lat, lng };
}

async function insertField(
  client: PoolClient,
  farmId: number,
  name: string,
  notes: string,
  coordinates: Coordinate[]
) {
  const box = boundingBox(coordinates);
  const centroid = centroidOf(coordinates);
  return client.query<{ id: number }>(
    `
      insert into fields (farm_id, name, notes, x, y, width, height, geom, boundary, centroid, area_sqm)
      values (
        $1, $2, $3, $4, $5, $6, $7,
        ST_Transform(ST_GeomFromText($8, 4326), 3857),
        ST_GeomFromText($8, 4326),
        ST_SetSRID(ST_MakePoint($9, $10), 4326),
        ST_Area(ST_GeomFromText($8, 4326)::geography)
      )
      returning id
    `,
    [farmId, name, notes, box.x, box.y, box.width, box.height, polygonWkt(coordinates), centroid.lng, centroid.lat]
  );
}

async function insertBlock(
  client: PoolClient,
  fieldId: number,
  name: string,
  notes: string,
  coordinates: Coordinate[]
) {
  const box = boundingBox(coordinates);
  const centroid = centroidOf(coordinates);
  return client.query<{ id: number }>(
    `
      insert into blocks (field_id, name, notes, x, y, width, height, geom, boundary, centroid, area_sqm)
      values (
        $1, $2, $3, $4, $5, $6, $7,
        ST_Transform(ST_GeomFromText($8, 4326), 3857),
        ST_GeomFromText($8, 4326),
        ST_SetSRID(ST_MakePoint($9, $10), 4326),
        ST_Area(ST_GeomFromText($8, 4326)::geography)
      )
      returning id
    `,
    [fieldId, name, notes, box.x, box.y, box.width, box.height, polygonWkt(coordinates), centroid.lng, centroid.lat]
  );
}

async function insertBlockZone(
  client: PoolClient,
  options: {
    blockId: number;
    name: string;
    plannedUse: "beds" | "cover_crop" | null;
    actualState: string;
    notes: string;
    coordinates: Coordinate[];
    coverCropNameId?: number | null;
  }
) {
  const box = boundingBox(options.coordinates);
  const centroid = centroidOf(options.coordinates);
  return client.query<{ id: number }>(
    `
      insert into block_zones (
        block_id, cover_crop_name_id, name, planned_use, actual_state, notes,
        x, y, width, height, geom, boundary, centroid, area_sqm
      )
      values (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        ST_Transform(ST_GeomFromText($11, 4326), 3857),
        ST_GeomFromText($11, 4326),
        ST_SetSRID(ST_MakePoint($12, $13), 4326),
        ST_Area(ST_GeomFromText($11, 4326)::geography)
      )
      returning id
    `,
    [
      options.blockId,
      options.coverCropNameId ?? null,
      options.name,
      options.plannedUse,
      options.actualState,
      options.notes,
      box.x,
      box.y,
      box.width,
      box.height,
      polygonWkt(options.coordinates),
      centroid.lng,
      centroid.lat
    ]
  );
}

async function insertFarmEvent(
  client: PoolClient,
  options: {
    farmId: number;
    eventDate: string;
    eventType: string;
    title: string;
    notes: string;
    metadata?: Record<string, unknown>;
    fieldId?: number | null;
    blockId?: number | null;
    zoneId?: number | null;
    bedId?: number | null;
    plantingId?: number | null;
    coordinates?: Coordinate[] | null;
  }
) {
  const wkt = options.coordinates && options.coordinates.length >= 3 ? polygonWkt(options.coordinates) : null;
  return client.query(
    `
      insert into farm_events (
        farm_id, event_date, event_type, title, notes, metadata,
        field_id, block_id, zone_id, bed_id, planting_id,
        boundary, centroid, area_sqm
      )
      values (
        $1, $2, $3, $4, $5, $6::jsonb,
        $7, $8, $9, $10, $11,
        case when $12::text is null then null else ST_GeomFromText($12, 4326) end,
        case when $12::text is null then null else ST_Centroid(ST_GeomFromText($12, 4326)) end,
        case when $12::text is null then null else ST_Area(ST_GeomFromText($12, 4326)::geography) end
      )
    `,
    [
      options.farmId,
      options.eventDate,
      options.eventType,
      options.title,
      options.notes,
      JSON.stringify(options.metadata ?? {}),
      options.fieldId ?? null,
      options.blockId ?? null,
      options.zoneId ?? null,
      options.bedId ?? null,
      options.plantingId ?? null,
      wkt
    ]
  );
}

async function blockBounds3857(
  client: PoolClient,
  blockId: number
) {
  const result = await client.query<{ minx: string; miny: string; maxx: string; maxy: string }>(
    `
      select
        ST_XMin(ST_Transform(boundary, 3857)) as minx,
        ST_YMin(ST_Transform(boundary, 3857)) as miny,
        ST_XMax(ST_Transform(boundary, 3857)) as maxx,
        ST_YMax(ST_Transform(boundary, 3857)) as maxy
      from blocks
      where id = $1
    `,
    [blockId]
  );

  return {
    minX: Number(result.rows[0].minx),
    minY: Number(result.rows[0].miny),
    maxX: Number(result.rows[0].maxx),
    maxY: Number(result.rows[0].maxy)
  };
}

async function insertTaskFlowTemplate(
  client: PoolClient,
  options: {
    farmId: number;
    cropId: number | null;
    name: string;
    notes: string;
    isDefault?: boolean;
    nodes: Array<{
      nodeKey: string;
      taskType: TaskType;
      label: string;
      anchor: string;
      offsetDays: number;
      x: number;
      y: number;
      notes?: string;
    }>;
    edges?: Array<{
      fromNodeKey: string;
      toNodeKey: string;
    }>;
  }
) {
  const template = await client.query<{ id: number }>(
    `
      insert into task_flow_templates (farm_id, crop_id, name, notes, is_default)
      values ($1, $2, $3, $4, $5)
      returning id
    `,
    [options.farmId, options.cropId, options.name, options.notes, options.isDefault ?? false]
  );

  const nodeIdsByKey = new Map<string, number>();
  for (const node of options.nodes) {
    const result = await client.query<{ id: number }>(
      `
        insert into task_flow_nodes (
          flow_template_id, node_key, task_type, label, anchor, offset_days, x_pos, y_pos, notes
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        returning id
      `,
      [
        template.rows[0].id,
        node.nodeKey,
        node.taskType,
        node.label,
        node.anchor,
        node.offsetDays,
        node.x,
        node.y,
        node.notes ?? null
      ]
    );
    nodeIdsByKey.set(node.nodeKey, result.rows[0].id);
  }

  for (const edge of options.edges ?? []) {
    await client.query(
      `
        insert into task_flow_edges (flow_template_id, from_node_id, to_node_id)
        values ($1, $2, $3)
      `,
      [
        template.rows[0].id,
        nodeIdsByKey.get(edge.fromNodeKey),
        nodeIdsByKey.get(edge.toNodeKey)
      ]
    );
  }

  return template.rows[0].id;
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertDestructiveSeedAllowed(client);
    await client.query(`
      truncate user_sessions, farm_memberships, app_users, harvest_records, farm_events, tasks, task_flow_edges, task_flow_nodes, task_flow_steps, task_flow_templates, task_templates, planting_placements, plantings, varieties, crops, beds, block_zones, cover_crop_names, blocks, fields, farms
      restart identity cascade
    `);

    const farm = await client.query<{ id: number }>(
      `insert into farms (name, notes) values ('River Bend Farm', 'Sample vegetable farm for prototype demo') returning id`
    );
    const farmId = farm.rows[0].id;
    const secondFarm = await client.query<{ id: number }>(
      `insert into farms (name, notes) values ('Cedar Meadow Farm', 'Second sample farm for multi-account demo') returning id`
    );
    const secondFarmId = secondFarm.rows[0].id;

    const riverOwner = await client.query<{ id: number }>(
      `
        insert into app_users (email, username, password_hash, display_name, email_verified_at)
        values ('river_owner@loamledger.local', 'river_owner', $1, 'River Owner', now())
        returning id
      `,
      [hashPassword("river123")]
    );
    const riverCrew = await client.query<{ id: number }>(
      `
        insert into app_users (email, username, password_hash, display_name, email_verified_at)
        values ('river_crew@loamledger.local', 'river_crew', $1, 'River Crew', now())
        returning id
      `,
      [hashPassword("river123")]
    );
    const cedarOwner = await client.query<{ id: number }>(
      `
        insert into app_users (email, username, password_hash, display_name, email_verified_at)
        values ('cedar_owner@loamledger.local', 'cedar_owner', $1, 'Cedar Owner', now())
        returning id
      `,
      [hashPassword("cedar123")]
    );
    const cedarCrew = await client.query<{ id: number }>(
      `
        insert into app_users (email, username, password_hash, display_name, email_verified_at)
        values ('cedar_crew@loamledger.local', 'cedar_crew', $1, 'Cedar Crew', now())
        returning id
      `,
      [hashPassword("cedar123")]
    );

    await client.query(
      `
        insert into farm_memberships (farm_id, user_id, role) values
        ($1, $2, 'planner'),
        ($1, $3, 'worker'),
        ($4, $5, 'planner'),
        ($4, $6, 'worker')
      `,
      [farmId, riverOwner.rows[0].id, riverCrew.rows[0].id, secondFarmId, cedarOwner.rows[0].id, cedarCrew.rows[0].id]
    );

    const field1 = await insertField(client, farmId, "North Field", "Main production field on the aerial map", [
      { lng: -76.26772, lat: 40.04512 },
      { lng: -76.26633, lat: 40.04536 },
      { lng: -76.26584, lat: 40.04471 },
      { lng: -76.26602, lat: 40.04382 },
      { lng: -76.26718, lat: 40.04358 },
      { lng: -76.26788, lat: 40.04414 }
    ]);
    const field2 = await insertField(client, farmId, "Tunnel Edge", "Smaller shoulder-season area along the farm lane", [
      { lng: -76.26535, lat: 40.04553 },
      { lng: -76.26459, lat: 40.04562 },
      { lng: -76.26444, lat: 40.04508 },
      { lng: -76.26511, lat: 40.04497 },
      { lng: -76.26542, lat: 40.04522 }
    ]);

    const northA = await insertBlock(client, field1.rows[0].id, "Block A", "Early brassicas and salad greens", [
      { lng: -76.26754, lat: 40.04498 },
      { lng: -76.26677, lat: 40.04508 },
      { lng: -76.26661, lat: 40.04434 },
      { lng: -76.2673, lat: 40.04418 },
      { lng: -76.26763, lat: 40.04446 }
    ]);
    const northB = await insertBlock(client, field1.rows[0].id, "Block B", "Summer plantings", [
      { lng: -76.2667, lat: 40.04513 },
      { lng: -76.26602, lat: 40.04518 },
      { lng: -76.26594, lat: 40.04435 },
      { lng: -76.26652, lat: 40.04417 },
      { lng: -76.26686, lat: 40.04443 }
    ]);
    const tunnelBlock = await insertBlock(client, field2.rows[0].id, "Tunnel Block", "Protected crops and quick successions", [
      { lng: -76.26522, lat: 40.04547 },
      { lng: -76.26473, lat: 40.04553 },
      { lng: -76.26465, lat: 40.04512 },
      { lng: -76.26509, lat: 40.04505 },
      { lng: -76.26528, lat: 40.04522 }
    ]);
    const cedarField = await insertField(client, secondFarmId, "West Market Garden", "Compact mixed vegetable area for the second demo farm", [
      { lng: -76.27335, lat: 40.04627 },
      { lng: -76.27274, lat: 40.04631 },
      { lng: -76.27261, lat: 40.04582 },
      { lng: -76.27318, lat: 40.04576 },
      { lng: -76.2734, lat: 40.04597 }
    ]);
    const cedarBlock = await insertBlock(client, cedarField.rows[0].id, "Main Block", "Simple demo block for second farm accounts", [
      { lng: -76.27323, lat: 40.0462 },
      { lng: -76.27285, lat: 40.04622 },
      { lng: -76.27279, lat: 40.0459 },
      { lng: -76.27313, lat: 40.04585 },
      { lng: -76.27328, lat: 40.04599 }
    ]);

    const standardPreset = await client.query<{ id: number }>(
      `
        insert into bed_presets (farm_id, name, bed_width_m, path_spacing_m, notes)
        values ($1, 'Bare bed 3 ft', 0.9144, 0.6096, 'Default bare bed: 3 ft plantable bed with 2 ft path.')
        returning id
      `,
      [farmId]
    );
    const narrowPreset = await client.query<{ id: number }>(
      `
        insert into bed_presets (farm_id, name, bed_width_m, path_spacing_m, notes)
        values ($1, 'Plastic bed 3 ft', 0.9144, 0.9144, 'Default plastic bed: 3 ft bed with 3 ft path.')
        returning id
      `,
      [farmId]
    );
    await client.query(
      `
        insert into bed_presets (farm_id, name, bed_width_m, path_spacing_m, is_road, notes)
        values ($1, 'Farm road 12 ft', 3.6576, 0, true, 'Default non-plantable farm road: 12 ft wide.')
      `,
      [farmId]
    );
    const cedarPreset = await client.query<{ id: number }>(
      `
        insert into bed_presets (farm_id, name, bed_width_m, path_spacing_m, notes)
        values ($1, 'Bare bed 3 ft', 0.9144, 0.6096, 'Default bare bed: 3 ft plantable bed with 2 ft path.')
        returning id
      `,
      [secondFarmId]
    );
    await client.query(
      `
        insert into bed_presets (farm_id, name, bed_width_m, path_spacing_m, is_road, notes)
        values
          ($1, 'Plastic bed 3 ft', 0.9144, 0.9144, false, 'Default plastic bed: 3 ft bed with 3 ft path.'),
          ($1, 'Farm road 12 ft', 3.6576, 0, true, 'Default non-plantable farm road: 12 ft wide.')
      `,
      [secondFarmId]
    );
    const rye = await client.query<{ id: number }>(
      `insert into cover_crop_names (farm_id, name, notes) values ($1, 'Rye', 'Simple winter cover crop option') returning id`,
      [farmId]
    );
    const oatPea = await client.query<{ id: number }>(
      `insert into cover_crop_names (farm_id, name, notes) values ($1, 'Oat / pea mix', 'Quick spring cover crop mix') returning id`,
      [farmId]
    );
    const buckwheat = await client.query<{ id: number }>(
      `insert into cover_crop_names (farm_id, name, notes) values ($1, 'Buckwheat', 'Fast summer smother crop') returning id`,
      [farmId]
    );

    const northABedCoordinates = [
      { lng: -76.26754, lat: 40.04498 },
      { lng: -76.26677, lat: 40.04508 },
      { lng: -76.26661, lat: 40.04434 },
      { lng: -76.2673, lat: 40.04418 },
      { lng: -76.26763, lat: 40.04446 }
    ];
    const northBBedCoordinates = [
      { lng: -76.2667, lat: 40.04513 },
      { lng: -76.26602, lat: 40.04518 },
      { lng: -76.26594, lat: 40.04435 },
      { lng: -76.26652, lat: 40.04417 },
      { lng: -76.26686, lat: 40.04443 }
    ];
    const northBCoverCropCoordinates = [
      { lng: -76.26621, lat: 40.04514 },
      { lng: -76.26603, lat: 40.04516 },
      { lng: -76.26599, lat: 40.04458 },
      { lng: -76.26617, lat: 40.04456 }
    ];

    const northAZone = await insertBlockZone(client, {
      blockId: northA.rows[0].id,
      name: "A Beds",
      plannedUse: "beds",
      actualState: "beds_made",
      notes: "Primary bed production area for Block A",
      coordinates: northABedCoordinates
    });
    const northBZone = await insertBlockZone(client, {
      blockId: northB.rows[0].id,
      name: "B Beds",
      plannedUse: "beds",
      actualState: "partially_planted",
      notes: "Main production area inside Block B",
      coordinates: northBBedCoordinates
    });
    const northBCoverCropZone = await insertBlockZone(client, {
      blockId: northB.rows[0].id,
      name: "B Cover Crop Strip",
      plannedUse: "cover_crop",
      actualState: "cover_crop_established",
      notes: "Seeded strip reserved for rotation planning",
      coverCropNameId: rye.rows[0].id,
      coordinates: northBCoverCropCoordinates
    });
    const tunnelZone = await insertBlockZone(client, {
      blockId: tunnelBlock.rows[0].id,
      name: "Tunnel Beds",
      plannedUse: "beds",
      actualState: "beds_made",
      notes: "Protected bed area",
      coordinates: [
        { lng: -76.26522, lat: 40.04547 },
        { lng: -76.26473, lat: 40.04553 },
        { lng: -76.26465, lat: 40.04512 },
        { lng: -76.26509, lat: 40.04505 },
        { lng: -76.26528, lat: 40.04522 }
      ]
    });
    const cedarZone = await insertBlockZone(client, {
      blockId: cedarBlock.rows[0].id,
      name: "Main Bed Area",
      plannedUse: "beds",
      actualState: "beds_made",
      notes: "Simple seeded bed area for the second farm",
      coordinates: [
        { lng: -76.27323, lat: 40.0462 },
        { lng: -76.27285, lat: 40.04622 },
        { lng: -76.27279, lat: 40.0459 },
        { lng: -76.27313, lat: 40.04585 },
        { lng: -76.27328, lat: 40.04599 }
      ]
    });

    const bedRows: Array<{
      name: string;
      blockId: number;
      zoneId: number | null;
      x: number;
      y: number;
      width: number;
      height: number;
      bedLengthM: number;
      permanent: boolean;
      presetId: number;
      direction: "north_south" | "east_west";
      sequenceNo: number;
    }> = [];

    for (const row of generateBedLayouts(await blockBounds3857(client, northA.rows[0].id), {
      bedWidthM: 0.9144,
      pathSpacingM: 0.6096,
      count: 6,
      direction: "north_south",
      namePrefix: "A-",
      startNumber: 1
    })) {
      bedRows.push({
        ...row,
        blockId: northA.rows[0].id,
        zoneId: northAZone.rows[0].id,
        permanent: true,
        presetId: standardPreset.rows[0].id,
        direction: "north_south"
      });
    }

    for (const row of generateBedLayouts(await blockBounds3857(client, northB.rows[0].id), {
      bedWidthM: 0.9144,
      pathSpacingM: 0.6096,
      count: 6,
      direction: "north_south",
      namePrefix: "B-",
      startNumber: 1
    })) {
      bedRows.push({
        ...row,
        blockId: northB.rows[0].id,
        zoneId: northBZone.rows[0].id,
        permanent: row.sequenceNo <= 3,
        presetId: standardPreset.rows[0].id,
        direction: "north_south"
      });
    }

    for (const row of generateBedLayouts(await blockBounds3857(client, tunnelBlock.rows[0].id), {
      bedWidthM: 0.9144,
      pathSpacingM: 0.9144,
      count: 3,
      direction: "east_west",
      namePrefix: "T-",
      startNumber: 1
    })) {
      bedRows.push({
        ...row,
        blockId: tunnelBlock.rows[0].id,
        zoneId: tunnelZone.rows[0].id,
        permanent: true,
        presetId: narrowPreset.rows[0].id,
        direction: "east_west"
      });
    }
    for (const row of generateBedLayouts(await blockBounds3857(client, cedarBlock.rows[0].id), {
      bedWidthM: 0.9144,
      pathSpacingM: 0.6096,
      count: 3,
      direction: "north_south",
      namePrefix: "C-",
      startNumber: 1
    })) {
      bedRows.push({
        ...row,
        blockId: cedarBlock.rows[0].id,
        zoneId: cedarZone.rows[0].id,
        permanent: true,
        presetId: cedarPreset.rows[0].id,
        direction: "north_south"
      });
    }

    const bedIdByName = new Map<string, number>();
    for (const bed of bedRows) {
      const bedResult = await client.query<{ id: number }>(
        `
          insert into beds (
            block_id, name, is_permanent, x, y, width, height, bed_length_m, notes,
            geom, boundary, centroid, area_sqm, source, bed_preset_id, direction, sequence_no, zone_id
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,
            ST_GeomFromText($10, 3857),
            ST_Transform(ST_GeomFromText($10, 3857), 4326),
            ST_Centroid(ST_Transform(ST_GeomFromText($10, 3857), 4326)),
            ST_Area(ST_Transform(ST_GeomFromText($10, 3857), 4326)::geography),
            'generated',
            $11,
            $12,
            $13,
            $14
          )
          returning id
        `,
        [
          bed.blockId,
          bed.name,
          bed.permanent,
          bed.x,
          bed.y,
          bed.width,
          bed.height,
          bed.bedLengthM,
          bed.permanent ? "Generated permanent bed" : "Generated seasonal bed",
          rectangleWkt(bed.x, bed.y, bed.width, bed.height),
          bed.presetId,
          bed.direction,
          bed.sequenceNo,
          bed.zoneId
        ]
      );
      bedIdByName.set(bed.name, bedResult.rows[0].id);
    }

    const lettuce = await client.query<{ id: number }>(`insert into crops (name) values ('Lettuce') returning id`);
    const cabbage = await client.query<{ id: number }>(`insert into crops (name) values ('Cabbage') returning id`);
    const carrot = await client.query<{ id: number }>(`insert into crops (name) values ('Carrot') returning id`);
    const kale = await client.query<{ id: number }>(`insert into crops (name) values ('Kale') returning id`);
    const tomato = await client.query<{ id: number }>(`insert into crops (name) values ('Tomato') returning id`);

    const salanova = await client.query<{ id: number }>(
      `insert into varieties (crop_id, name) values ($1, 'Salanova Green') returning id`,
      [lettuce.rows[0].id]
    );
    const storageCabbage = await client.query<{ id: number }>(
      `insert into varieties (crop_id, name) values ($1, 'Capture') returning id`,
      [cabbage.rows[0].id]
    );
    const nantes = await client.query<{ id: number }>(
      `insert into varieties (crop_id, name) values ($1, 'Bolero') returning id`,
      [carrot.rows[0].id]
    );
    const lacinato = await client.query<{ id: number }>(
      `insert into varieties (crop_id, name) values ($1, 'Lacinato') returning id`,
      [kale.rows[0].id]
    );
    const sungold = await client.query<{ id: number }>(
      `insert into varieties (crop_id, name) values ($1, 'Sungold') returning id`,
      [tomato.rows[0].id]
    );

    await client.query(
      `
        insert into seed_items (
          farm_id, crop_id, variety_id, family, crop_type, variety_name,
          supplier, catalog_number, days_to_maturity, notes
        )
        values
          ($1, $2, $3, 'Asteraceae', 'Lettuce', 'Salanova Green', 'Demo catalog', 'LET-SAL-GRN', 55, 'Demo seed catalog record.'),
          ($1, $4, $5, 'Brassica', 'Cabbage', 'Capture', 'Demo catalog', 'CAB-CAP', 80, 'Demo seed catalog record.'),
          ($1, $6, $7, 'Apiaceae', 'Carrot', 'Bolero', 'Demo catalog', 'CAR-BOL', 75, 'Demo seed catalog record.'),
          ($1, $8, $9, 'Brassica', 'Kale', 'Lacinato', 'Demo catalog', 'KAL-LAC', 62, 'Demo seed catalog record.'),
          ($1, $10, $11, 'Solanaceae', 'Tomato', 'Sungold', 'Demo catalog', 'TOM-SUN', 57, 'Demo seed catalog record.')
      `,
      [
        farmId,
        lettuce.rows[0].id,
        salanova.rows[0].id,
        cabbage.rows[0].id,
        storageCabbage.rows[0].id,
        carrot.rows[0].id,
        nantes.rows[0].id,
        kale.rows[0].id,
        lacinato.rows[0].id,
        tomato.rows[0].id,
        sungold.rows[0].id
      ]
    );

    const brassicaFlowId = await insertTaskFlowTemplate(client, {
      farmId,
      cropId: cabbage.rows[0].id,
      name: "Full brassica transplant flow",
      notes: "Fourteen-node sample with tray seeding, pot-up, field prep, transplanting, cultivation, spray/check passes, and cleanup.",
      isDefault: true,
      nodes: [
        { nodeKey: "seed_tray", taskType: "seed_in_tray", label: "Seed trays", anchor: "planned_sow", offsetDays: 0, x: 0.08, y: 0.72 },
        { nodeKey: "pot_up", taskType: "seed_in_tray", label: "Pot up", anchor: "after:seed_tray", offsetDays: 21, x: 0.22, y: 0.72 },
        { nodeKey: "disk", taskType: "bed_making", label: "Disk ground", anchor: "planned_sow", offsetDays: 14, x: 0.08, y: 0.24 },
        { nodeKey: "lime", taskType: "bed_making", label: "Spread lime", anchor: "after:disk", offsetDays: 1, x: 0.22, y: 0.24 },
        { nodeKey: "fertilize", taskType: "bed_making", label: "Fertilize", anchor: "after:lime", offsetDays: 14, x: 0.36, y: 0.24 },
        { nodeKey: "perfecta", taskType: "bed_making", label: "Perfecta pass", anchor: "after:fertilize", offsetDays: 1, x: 0.5, y: 0.24 },
        { nodeKey: "bed_shape", taskType: "bed_making", label: "Bed shape", anchor: "after:perfecta", offsetDays: 1, x: 0.64, y: 0.24 },
        { nodeKey: "transplant", taskType: "transplant", label: "Transplant", anchor: "after:pot_up,bed_shape", offsetDays: 1, x: 0.64, y: 0.52 },
        { nodeKey: "water_in", taskType: "fertilizing_spraying", label: "Water in", anchor: "after:transplant", offsetDays: 1, x: 0.78, y: 0.38 },
        { nodeKey: "cultivate_1", taskType: "cultivation", label: "First cultivation", anchor: "after:transplant", offsetDays: 7, x: 0.78, y: 0.62 },
        { nodeKey: "cultivate_2", taskType: "cultivation", label: "Second cultivation", anchor: "after:cultivation_1", offsetDays: 10, x: 0.9, y: 0.62 },
        { nodeKey: "spray", taskType: "fertilizing_spraying", label: "Spray/check pests", anchor: "after:cultivation_2", offsetDays: 3, x: 0.9, y: 0.38 },
        { nodeKey: "cultivate_3", taskType: "cultivation", label: "Third cultivation", anchor: "after:spray", offsetDays: 7, x: 0.9, y: 0.76 },
        { nodeKey: "cleanup", taskType: "cleanup", label: "Cleanup", anchor: "after:cultivation_3", offsetDays: 40, x: 0.9, y: 0.9 }
      ],
      edges: [
        { fromNodeKey: "seed_tray", toNodeKey: "pot_up" },
        { fromNodeKey: "pot_up", toNodeKey: "transplant" },
        { fromNodeKey: "disk", toNodeKey: "lime" },
        { fromNodeKey: "lime", toNodeKey: "fertilize" },
        { fromNodeKey: "fertilize", toNodeKey: "perfecta" },
        { fromNodeKey: "perfecta", toNodeKey: "bed_shape" },
        { fromNodeKey: "bed_shape", toNodeKey: "transplant" },
        { fromNodeKey: "transplant", toNodeKey: "water_in" },
        { fromNodeKey: "transplant", toNodeKey: "cultivate_1" },
        { fromNodeKey: "cultivate_1", toNodeKey: "cultivate_2" },
        { fromNodeKey: "cultivate_2", toNodeKey: "spray" },
        { fromNodeKey: "spray", toNodeKey: "cultivate_3" },
        { fromNodeKey: "cultivate_3", toNodeKey: "cleanup" }
      ]
    });
    const lettuceFlowId = await insertTaskFlowTemplate(client, {
      farmId,
      cropId: lettuce.rows[0].id,
      name: "Eight-node transplant flow",
      notes: "Compact sample showing field prep leading into transplant and cleanup.",
      isDefault: true,
      nodes: [
        { nodeKey: "seed_tray", taskType: "seed_in_tray", label: "Seed trays", anchor: "planned_sow", offsetDays: 0, x: 0.08, y: 0.7 },
        { nodeKey: "disk", taskType: "bed_making", label: "Disk ground", anchor: "planned_sow", offsetDays: 7, x: 0.08, y: 0.28 },
        { nodeKey: "lime", taskType: "bed_making", label: "Spread lime", anchor: "after:disk", offsetDays: 1, x: 0.22, y: 0.28 },
        { nodeKey: "fertilize", taskType: "bed_making", label: "Fertilize", anchor: "after:lime", offsetDays: 10, x: 0.36, y: 0.28 },
        { nodeKey: "perfecta", taskType: "bed_making", label: "Perfecta pass", anchor: "after:fertilize", offsetDays: 1, x: 0.5, y: 0.28 },
        { nodeKey: "bed_shape", taskType: "bed_making", label: "Bed shape", anchor: "after:perfecta", offsetDays: 1, x: 0.64, y: 0.28 },
        { nodeKey: "transplant", taskType: "transplant", label: "Transplant", anchor: "after:seed_tray,bed_shape", offsetDays: 1, x: 0.64, y: 0.58 },
        { nodeKey: "cleanup", taskType: "cleanup", label: "Cleanup", anchor: "after:transplant", offsetDays: 35, x: 0.86, y: 0.58 }
      ],
      edges: [
        { fromNodeKey: "disk", toNodeKey: "lime" },
        { fromNodeKey: "lime", toNodeKey: "fertilize" },
        { fromNodeKey: "fertilize", toNodeKey: "perfecta" },
        { fromNodeKey: "perfecta", toNodeKey: "bed_shape" },
        { fromNodeKey: "seed_tray", toNodeKey: "transplant" },
        { fromNodeKey: "bed_shape", toNodeKey: "transplant" },
        { fromNodeKey: "transplant", toNodeKey: "cleanup" }
      ]
    });
    const directSeedFlowId = await insertTaskFlowTemplate(client, {
      farmId,
      cropId: carrot.rows[0].id,
      name: "Direct seed root crop flow",
      notes: "Used for carrots and other direct-seeded roots.",
      isDefault: true,
      nodes: [
        { nodeKey: "bed_making", taskType: "bed_making", label: "Fine seedbed prep", anchor: "planned_sow", offsetDays: -2, x: 0.12, y: 0.5 },
        { nodeKey: "seed", taskType: "direct_seed", label: "Direct seed", anchor: "after:bed_making", offsetDays: 2, x: 0.36, y: 0.5 },
        { nodeKey: "thin_stand", taskType: "cultivation", label: "Thin stand", anchor: "after:seed", offsetDays: 18, x: 0.6, y: 0.25 },
        { nodeKey: "weed_pass", taskType: "cultivation", label: "Weed pass", anchor: "after:seed", offsetDays: 22, x: 0.6, y: 0.52 },
        { nodeKey: "cleanup", taskType: "cleanup", label: "Cleanup", anchor: "after:seed", offsetDays: 80, x: 0.6, y: 0.78 },
        { nodeKey: "finish", taskType: "cleanup", label: "Cleanup finish", anchor: "after:cleanup", offsetDays: 21, x: 0.84, y: 0.78 }
      ],
      edges: [
        { fromNodeKey: "bed_making", toNodeKey: "seed" },
        { fromNodeKey: "seed", toNodeKey: "thin_stand" },
        { fromNodeKey: "seed", toNodeKey: "weed_pass" },
        { fromNodeKey: "seed", toNodeKey: "cleanup" },
        { fromNodeKey: "cleanup", toNodeKey: "finish" }
      ]
    });
    const tunnelTomatoFlowId = await insertTaskFlowTemplate(client, {
      farmId,
      cropId: tomato.rows[0].id,
      name: "Tunnel tomato flow",
      notes: "Protected crop flow with transplant and repeated checks.",
      isDefault: true,
      nodes: [
        { nodeKey: "bed_making", taskType: "bed_making", label: "Tunnel bed prep", anchor: "planned_sow", offsetDays: 35, x: 0.1, y: 0.28 },
        { nodeKey: "seed", taskType: "seed_in_tray", label: "Seed in tray", anchor: "planned_sow", offsetDays: 0, x: 0.1, y: 0.7 },
        { nodeKey: "transplant", taskType: "transplant", label: "Transplant", anchor: "after:seed,bed_prep", offsetDays: 7, x: 0.38, y: 0.5 },
        { nodeKey: "irrigation", taskType: "fertilizing_spraying", label: "Irrigation check", anchor: "after:transplant", offsetDays: 1, x: 0.64, y: 0.28 },
        { nodeKey: "cleanup", taskType: "cleanup", label: "Cleanup", anchor: "after:transplant", offsetDays: 54, x: 0.64, y: 0.68 },
        { nodeKey: "finish", taskType: "cleanup", label: "Cleanup finish", anchor: "after:cleanup", offsetDays: 45, x: 0.88, y: 0.68 }
      ],
      edges: [
        { fromNodeKey: "bed_making", toNodeKey: "transplant" },
        { fromNodeKey: "seed", toNodeKey: "transplant" },
        { fromNodeKey: "transplant", toNodeKey: "irrigation" },
        { fromNodeKey: "transplant", toNodeKey: "cleanup" },
        { fromNodeKey: "cleanup", toNodeKey: "finish" }
      ]
    });
    const cedarLettuceFlowId = await insertTaskFlowTemplate(client, {
      farmId: secondFarmId,
      cropId: lettuce.rows[0].id,
      name: "Cedar lettuce flow",
      notes: "Simpler lettuce flow for the second demo farm.",
      isDefault: true,
      nodes: [
        { nodeKey: "bed_making", taskType: "bed_making", label: "Bed prep", anchor: "planned_sow", offsetDays: 26, x: 0.14, y: 0.4 },
        { nodeKey: "seed", taskType: "seed_in_tray", label: "Seed in tray", anchor: "planned_sow", offsetDays: 0, x: 0.14, y: 0.72 },
        { nodeKey: "transplant", taskType: "transplant", label: "Transplant", anchor: "after:seed,bed_prep", offsetDays: 2, x: 0.44, y: 0.56 },
        { nodeKey: "cleanup", taskType: "cleanup", label: "Cleanup", anchor: "after:transplant", offsetDays: 32, x: 0.74, y: 0.56 },
        { nodeKey: "finish", taskType: "cleanup", label: "Cleanup finish", anchor: "after:cleanup", offsetDays: 10, x: 0.9, y: 0.56 }
      ],
      edges: [
        { fromNodeKey: "bed_making", toNodeKey: "transplant" },
        { fromNodeKey: "seed", toNodeKey: "transplant" },
        { fromNodeKey: "transplant", toNodeKey: "cleanup" },
        { fromNodeKey: "cleanup", toNodeKey: "finish" }
      ]
    });

    const planting1 = await client.query<{ id: number }>(
      `
        insert into plantings (
          farm_id,
          crop_id, variety_id, title, status, intended_bed_id, spacing, plant_count, bed_length_used_m, notes,
          task_flow_template_id,
          planned_sow_date, planned_transplant_date, expected_harvest_start, expected_harvest_end,
          actual_tray_seeding_date, actual_transplant_date
        )
        values (
          $1, $2, $3, 'Early head lettuce batch', 'transplanted', $4, '20 cm x 25 cm', 480, 24,
          'Started for spring mix and mini heads. Transplant happened late due to wet week.',
          $5,
          '2026-03-04', '2026-03-25', '2026-04-29', '2026-05-20',
          '2026-03-04', '2026-04-01'
        )
        returning id
      `,
      [farmId, lettuce.rows[0].id, salanova.rows[0].id, bedIdByName.get("A-1"), lettuceFlowId]
    );
    const planting2 = await client.query<{ id: number }>(
      `
        insert into plantings (
          farm_id,
          crop_id, variety_id, title, status, intended_bed_id, spacing, plant_count, bed_length_used_m, notes,
          task_flow_template_id,
          planned_sow_date, planned_transplant_date, expected_harvest_start, expected_harvest_end
        )
        values (
          $1, $2, $3, 'Storage cabbage main block', 'planned', $4, '45 cm x 45 cm', 128, 7.3,
          'Main storage cabbage planting. Planned into two adjacent beds.',
          $5,
          '2026-04-10', '2026-05-01', '2026-07-20', '2026-08-30'
        )
        returning id
      `,
      [farmId, cabbage.rows[0].id, storageCabbage.rows[0].id, bedIdByName.get("A-3"), brassicaFlowId]
    );
    const planting3 = await client.query<{ id: number }>(
      `
        insert into plantings (
          farm_id,
          crop_id, variety_id, title, status, intended_bed_id, spacing, bed_length_used_m, notes,
          task_flow_template_id,
          planned_sow_date, expected_harvest_start, expected_harvest_end, actual_direct_seeding_date
        )
        values (
          $1, $2, $3, 'Carrot succession 1', 'direct_seeded', $4, '3 rows per bed', 42.7,
          'Direct seeded across one and a half beds.',
          $5,
          '2026-03-20', '2026-06-15', '2026-07-15', '2026-03-27'
        )
        returning id
      `,
      [farmId, carrot.rows[0].id, nantes.rows[0].id, bedIdByName.get("B-1"), directSeedFlowId]
    );
    const planting4 = await client.query<{ id: number }>(
      `
        insert into plantings (
          farm_id,
          crop_id, variety_id, title, status, intended_bed_id, spacing, bed_length_used_m, notes,
          task_flow_template_id,
          planned_sow_date, planned_transplant_date, expected_harvest_start, expected_harvest_end,
          actual_tray_seeding_date
        )
        values (
          $1, $2, $3, 'Lacinato kale spring planting', 'ready_to_transplant', $4, '30 cm x 45 cm', 42.7,
          'Expected to split across tunnel edge beds.',
          $5,
          '2026-03-15', '2026-04-05', '2026-05-25', '2026-07-05',
          '2026-03-18'
        )
        returning id
      `,
      [farmId, kale.rows[0].id, lacinato.rows[0].id, bedIdByName.get("T-1"), brassicaFlowId]
    );
    const planting5 = await client.query<{ id: number }>(
      `
        insert into plantings (
          farm_id,
          crop_id, variety_id, title, status, intended_bed_id, spacing, plant_count, bed_length_used_m, notes,
          task_flow_template_id,
          planned_sow_date, planned_transplant_date, expected_harvest_start, expected_harvest_end,
          actual_tray_seeding_date
        )
        values (
          $1, $2, $3, 'Tunnel sungold tomatoes', 'seeded_in_tray', $4, '45 cm in-row', 48, 24,
          'Protected crop for tunnel block.',
          $5,
          '2026-03-22', '2026-05-02', '2026-06-25', '2026-09-15',
          '2026-03-24'
        )
        returning id
      `,
      [farmId, tomato.rows[0].id, sungold.rows[0].id, bedIdByName.get("T-2"), tunnelTomatoFlowId]
    );
    const cedarPlanting = await client.query<{ id: number }>(
      `
        insert into plantings (
          farm_id,
          crop_id, variety_id, title, status, intended_bed_id, spacing, plant_count, bed_length_used_m, notes,
          task_flow_template_id,
          planned_sow_date, planned_transplant_date, expected_harvest_start, expected_harvest_end,
          actual_tray_seeding_date
        )
        values (
          $1, $2, $3, 'Cedar spring lettuce', 'seeded_in_tray', $4, '20 cm x 25 cm', 180, 9.1,
          'Second farm demo planting for account switching.',
          $5,
          '2026-03-25', '2026-04-14', '2026-05-18', '2026-06-05',
          '2026-03-26'
        )
        returning id
      `,
      [secondFarmId, lettuce.rows[0].id, salanova.rows[0].id, bedIdByName.get("C-1"), cedarLettuceFlowId]
    );

    await client.query(
      `insert into planting_placements (planting_id, bed_id, plant_count, bed_length_used_m, placed_on, location_detail, notes) values
        ($1, $2, 240, 12, '2026-04-10', 'North half', 'First half of batch'),
        ($1, $3, 240, 12, '2026-04-10', 'South half', 'Second half of batch'),
        ($4, $5, 64, 3.65, '2026-04-16', 'West side', 'West side'),
        ($4, $6, 64, 3.65, '2026-04-16', 'East side', 'East side'),
        ($7, $8, null, 30, '2026-04-08', 'Main bed', 'Main bed'),
        ($7, $9, null, 12.7, '2026-04-08', 'Overflow end', 'Overflow'),
        ($10, $11, null, 24, '2026-04-22', 'Center tunnel bed', 'First tunnel bed')
      `,
      [
        planting1.rows[0].id,
        bedIdByName.get("A-1"),
        bedIdByName.get("A-2"),
        planting2.rows[0].id,
        bedIdByName.get("A-3"),
        bedIdByName.get("A-4"),
        planting3.rows[0].id,
        bedIdByName.get("B-1"),
        bedIdByName.get("B-2"),
        planting4.rows[0].id,
        bedIdByName.get("T-1")
      ]
    );

    await client.query(
      `insert into tasks (farm_id, bed_id, task_type, title, status, scheduled_date, notes, is_auto_generated)
       values ($1, $2, 'bed_making', 'Refresh seasonal bed B-4', 'pending', '2026-04-06', 'Seasonal bed reset before next crop', false)`,
      [farmId, bedIdByName.get("B-4")]
    );

    await client.query(
      `insert into harvest_records (farm_id, planting_id, bed_id, harvest_date, quantity, unit, notes)
       values ($1, $2, $3, '2026-05-04', 18, 'heads', 'First lettuce cut from A-1')`,
      [farmId, planting1.rows[0].id, bedIdByName.get("A-1")]
    );

    await client.query(
      `insert into farm_events (farm_id, event_date, event_type, title, notes, metadata, planting_id, bed_id)
       values
        ($1, '2026-04-10', 'placement_recorded', 'Placement recorded for Early head lettuce batch', 'Split across A-1 and A-2', '{"source":"seed"}'::jsonb, $2, $3),
        ($1, '2026-04-16', 'placement_recorded', 'Placement recorded for Spring cabbage', 'Split across A-3 and A-4', '{"source":"seed"}'::jsonb, $4, $5),
        ($1, '2026-05-04', 'harvest_logged', 'Harvest logged for Early head lettuce batch', 'First lettuce cut from A-1', '{"quantity":18,"unit":"heads","source":"seed"}'::jsonb, $2, $3)`,
      [farmId, planting1.rows[0].id, bedIdByName.get("A-1"), planting2.rows[0].id, bedIdByName.get("A-3")]
    );

    await insertFarmEvent(client, {
      farmId,
      eventDate: "2023-09-18",
      eventType: "zone_state",
      title: "Rye established in B cover crop strip",
      notes: "Winter cover went in after late summer cleanup.",
      metadata: { timelineVisible: true, stateCategory: "cover_crop" },
      blockId: northB.rows[0].id,
      zoneId: northBCoverCropZone.rows[0].id,
      coordinates: northBCoverCropCoordinates
    });
    await insertFarmEvent(client, {
      farmId,
      eventDate: "2024-04-12",
      eventType: "zone_state",
      title: "Cover crop mowed and incorporated in B cover crop strip",
      notes: "Strip opened back up for spring work.",
      metadata: { timelineVisible: true, stateCategory: "cleanup" },
      blockId: northB.rows[0].id,
      zoneId: northBCoverCropZone.rows[0].id,
      coordinates: northBCoverCropCoordinates
    });
    await insertFarmEvent(client, {
      farmId,
      eventDate: "2024-06-20",
      eventType: "zone_state",
      title: "Buckwheat smother crop established in B beds",
      notes: "Summer reset before fall brassicas.",
      metadata: { timelineVisible: true, stateCategory: "cover_crop" },
      blockId: northB.rows[0].id,
      zoneId: northBZone.rows[0].id,
      coordinates: northBBedCoordinates
    });
    await insertFarmEvent(client, {
      farmId,
      eventDate: "2024-08-15",
      eventType: "zone_state",
      title: "Buckwheat terminated and bed prep started in B beds",
      notes: "Preparing for a fall planting window.",
      metadata: { timelineVisible: true, stateCategory: "cleanup" },
      blockId: northB.rows[0].id,
      zoneId: northBZone.rows[0].id,
      coordinates: northBBedCoordinates
    });
    await insertFarmEvent(client, {
      farmId,
      eventDate: "2024-09-25",
      eventType: "zone_state",
      title: "Oat / pea mix established in B cover crop strip",
      notes: "Quick fall cover before winter.",
      metadata: { timelineVisible: true, stateCategory: "cover_crop" },
      blockId: northB.rows[0].id,
      zoneId: northBCoverCropZone.rows[0].id,
      coordinates: northBCoverCropCoordinates
    });
    await insertFarmEvent(client, {
      farmId,
      eventDate: "2025-04-08",
      eventType: "zone_state",
      title: "Winter cover cleaned up in B cover crop strip",
      notes: "Residue flail-mowed and opened for spring planning.",
      metadata: { timelineVisible: true, stateCategory: "cleanup" },
      blockId: northB.rows[0].id,
      zoneId: northBCoverCropZone.rows[0].id,
      coordinates: northBCoverCropCoordinates
    });
    await insertFarmEvent(client, {
      farmId,
      eventDate: "2025-09-28",
      eventType: "zone_state",
      title: "Rye re-established in B cover crop strip",
      notes: "Back into winter cover after summer production.",
      metadata: { timelineVisible: true, stateCategory: "cover_crop" },
      blockId: northB.rows[0].id,
      zoneId: northBCoverCropZone.rows[0].id,
      coordinates: northBCoverCropCoordinates
    });
    await insertFarmEvent(client, {
      farmId,
      eventDate: "2026-04-05",
      eventType: "zone_state",
      title: "Rye mowed for spring opening in B cover crop strip",
      notes: "Current season cleanup step.",
      metadata: { timelineVisible: true, stateCategory: "cleanup" },
      blockId: northB.rows[0].id,
      zoneId: northBCoverCropZone.rows[0].id,
      coordinates: northBCoverCropCoordinates
    });
    await insertFarmEvent(client, {
      farmId,
      eventDate: "2026-09-22",
      eventType: "zone_state",
      title: "Planned oat / pea mix in B cover crop strip",
      notes: "Planned cover after fall crop cleanup.",
      metadata: { timelineVisible: true, stateCategory: "cover_crop" },
      blockId: northB.rows[0].id,
      zoneId: northBCoverCropZone.rows[0].id,
      coordinates: northBCoverCropCoordinates
    });
    await insertFarmEvent(client, {
      farmId,
      eventDate: "2027-04-10",
      eventType: "zone_state",
      title: "Planned spring cleanup before B beds open",
      notes: "Planning target for mowing and incorporation.",
      metadata: { timelineVisible: true, stateCategory: "cleanup" },
      blockId: northB.rows[0].id,
      zoneId: northBCoverCropZone.rows[0].id,
      coordinates: northBCoverCropCoordinates
    });

    for (const plantingId of [
      planting1.rows[0].id,
      planting2.rows[0].id,
      planting3.rows[0].id,
      planting4.rows[0].id,
      planting5.rows[0].id,
      cedarPlanting.rows[0].id
    ]) {
      await recalculatePlantingTasks(client, plantingId);
    }

    await client.query("commit");
    console.log("Seed complete");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
