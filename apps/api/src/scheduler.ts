/**
 * Task scheduler for planting work.
 *
 * A planting points at a task-flow template. Each flow node says what task to
 * create, which date milestone to anchor to, and how many days to offset. When
 * actual work dates are recorded, this module updates generated tasks in place
 * so task IDs, farm_events.task_id links, and user-visible history survive.
 */
import { PoolClient } from "pg";
import { titleCase } from "./utils";
import { TaskAnchor, TaskType } from "./types";

type PlantingRow = {
  id: number;
  farm_id: number;
  crop_id: number;
  intended_bed_id: number | null;
  crop_name: string;
  variety_name: string | null;
  task_flow_template_id: number | null;
  planned_sow_date: string | null;
  planned_transplant_date: string | null;
  expected_harvest_start: string | null;
  actual_tray_seeding_date: string | null;
  actual_direct_seeding_date: string | null;
  actual_transplant_date: string | null;
  actual_cultivation_date: string | null;
  actual_harvest_date: string | null;
  actual_finish_date: string | null;
};

type FlowNodeRow = {
  id: number;
  node_key: string;
  task_type: TaskType;
  label: string;
  anchor: TaskAnchor;
  offset_days: number;
  icon_color: string;
  icon_secondary_color: string;
};

type FlowEdgeRow = {
  from_node_key: string;
  to_node_key: string;
};

type ExistingGeneratedTaskRow = {
  id: number;
  task_flow_node_id: number | null;
  status: string;
  completed_date: string | Date | null;
  event_count: string | number;
};

// Prefer actual dates when they exist, otherwise fall back to the planned dates.
function resolveAnchorDate(planting: PlantingRow, anchor: TaskAnchor) {
  switch (anchor) {
    case "planned_sow":
      return planting.actual_direct_seeding_date ?? planting.actual_tray_seeding_date ?? planting.planned_sow_date;
    case "actual_tray_seeding":
      return planting.actual_tray_seeding_date ?? planting.planned_sow_date;
    case "actual_direct_seeding":
      return planting.actual_direct_seeding_date ?? planting.planned_sow_date;
    case "planned_transplant":
      return planting.actual_transplant_date ?? planting.planned_transplant_date;
    case "actual_transplant":
      return planting.actual_transplant_date ?? planting.planned_transplant_date;
    case "actual_cultivation":
      return planting.actual_cultivation_date ?? planting.actual_transplant_date ?? planting.actual_direct_seeding_date ?? planting.planned_sow_date;
    case "actual_harvest":
      return planting.actual_harvest_date ?? planting.expected_harvest_start;
    default:
      return null;
  }
}

// Normalize dates to YYYY-MM-DD because the UI and task logic do not need times.
function toDateOnlyString(value: string | Date) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const normalized = new Date(value);
  if (!Number.isNaN(normalized.getTime())) {
    return normalized.toISOString().slice(0, 10);
  }

  const direct = String(value).slice(0, 10);
  const fallback = new Date(`${direct}T00:00:00Z`);
  if (Number.isNaN(fallback.getTime())) {
    throw new Error(`Invalid date value: ${String(value)}`);
  }

  return direct;
}

function addDays(dateValue: string | Date, offsetDays: number) {
  const dateString = toDateOnlyString(dateValue);
  const next = new Date(`${dateString}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + offsetDays);
  return next.toISOString().slice(0, 10);
}

// Synchronizes auto-generated tasks for one planting from its selected/default
// flow chart. Existing task rows are updated by task_flow_node_id instead of
// deleted, because task IDs are referenced by event history and by users.
export async function recalculatePlantingTasks(client: PoolClient, plantingId: number) {
  const plantingResult = await client.query<PlantingRow>(
    `
      select
        p.id,
        p.farm_id,
        p.crop_id,
        p.intended_bed_id,
        c.name as crop_name,
        v.name as variety_name,
        p.task_flow_template_id,
        p.planned_sow_date,
        p.planned_transplant_date,
        p.expected_harvest_start,
        p.actual_tray_seeding_date,
        p.actual_direct_seeding_date,
        p.actual_transplant_date,
        p.actual_cultivation_date,
        p.actual_harvest_date,
        p.actual_finish_date
      from plantings p
      join crops c on c.id = p.crop_id
      left join varieties v on v.id = p.variety_id
      where p.id = $1
    `,
    [plantingId]
  );

  const planting = plantingResult.rows[0];
  if (!planting) {
    return;
  }

  const selectedFlowTemplateId = planting.task_flow_template_id ?? (
    await client.query<{ id: number }>(
      `
        select id
        from task_flow_templates
        where farm_id = $2
          and (crop_id = $1 or crop_id is null)
        order by
          case when crop_id = $1 then 0 else 1 end,
          case when is_default then 0 else 1 end,
          id asc
        limit 1
      `,
      [planting.crop_id, planting.farm_id]
    )
  ).rows[0]?.id ?? null;

  if (selectedFlowTemplateId == null) {
    return;
  }

  const [nodesResult, edgesResult, existingTasksResult] = await Promise.all([
    client.query<FlowNodeRow>(
      `
        select id, node_key, task_type, label, anchor, offset_days, icon_color, icon_secondary_color
        from task_flow_nodes
        where flow_template_id = $1
        order by y_pos asc, x_pos asc, id asc
      `,
      [selectedFlowTemplateId]
    ),
    client.query<FlowEdgeRow>(
      `
        select from_node.node_key as from_node_key, to_node.node_key as to_node_key
        from task_flow_edges edge
        join task_flow_nodes from_node on from_node.id = edge.from_node_id
        join task_flow_nodes to_node on to_node.id = edge.to_node_id
        where edge.flow_template_id = $1
        order by edge.id asc
      `,
      [selectedFlowTemplateId]
    ),
    client.query<ExistingGeneratedTaskRow>(
      `
        select
          task.id,
          task.task_flow_node_id,
          task.status,
          task.completed_date,
          count(event.id)::text as event_count
        from tasks task
        left join farm_events event on event.task_id = task.id
        where task.planting_id = $1
          and task.is_auto_generated = true
        group by task.id
      `,
      [plantingId]
    )
  ]);

  const taskIdsByNodeKey = new Map<string, number>();
  const existingTasksByFlowNodeId = new Map(
    existingTasksResult.rows
      .filter((task) => task.task_flow_node_id != null)
      .map((task) => [task.task_flow_node_id as number, task])
  );
  const activeTaskIds = new Set<number>();

  for (const node of nodesResult.rows) {
    const anchorDate = resolveAnchorDate(planting, node.anchor);
    if (!anchorDate) {
      continue;
    }

    const scheduledDate = addDays(anchorDate, node.offset_days);
    const fallbackLabel = `${titleCase(node.task_type)} ${planting.crop_name}`;
    const taskLabel = `${node.label || fallbackLabel} - ${planting.crop_name}${planting.variety_name ? ` (${planting.variety_name})` : ""}`;
    const existingTask = existingTasksByFlowNodeId.get(node.id);

    if (existingTask) {
      await client.query(
        `
          update tasks
          set
            farm_id = $2,
            bed_id = $3,
            task_type = $4,
            title = $5,
            icon_color = $6,
            icon_secondary_color = $7,
            anchor = $8,
            offset_days = $9,
            scheduled_date = $10,
            updated_at = now()
          where id = $1
        `,
        [
          existingTask.id,
          planting.farm_id,
          planting.intended_bed_id,
          node.task_type,
          taskLabel,
          node.icon_color,
          node.icon_secondary_color,
          node.anchor,
          node.offset_days,
          scheduledDate
        ]
      );
      taskIdsByNodeKey.set(node.node_key, existingTask.id);
      activeTaskIds.add(existingTask.id);
    } else {
      const result = await client.query<{ id: number }>(
        `
          insert into tasks (
            planting_id,
            farm_id,
            bed_id,
            task_flow_node_id,
            task_type,
            title,
            icon_color,
            icon_secondary_color,
            status,
            anchor,
            offset_days,
            scheduled_date,
            is_auto_generated
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11, true)
          returning id
        `,
        [
          plantingId,
          planting.farm_id,
          planting.intended_bed_id,
          node.id,
          node.task_type,
          taskLabel,
          node.icon_color,
          node.icon_secondary_color,
          node.anchor,
          node.offset_days,
          scheduledDate
        ]
      );
      taskIdsByNodeKey.set(node.node_key, result.rows[0].id);
      activeTaskIds.add(result.rows[0].id);
    }
  }

  for (const node of nodesResult.rows) {
    const taskId = taskIdsByNodeKey.get(node.node_key);
    if (!taskId) {
      continue;
    }

    const dependencyTaskIds = edgesResult.rows
      .filter((edge: FlowEdgeRow) => edge.to_node_key === node.node_key)
      .map((edge: FlowEdgeRow) => taskIdsByNodeKey.get(edge.from_node_key))
      .filter((value: number | undefined): value is number => value != null);

    await client.query(
      `
        update tasks
        set depends_on_task_ids = $2::int[], updated_at = now()
        where id = $1
      `,
      [taskId, dependencyTaskIds]
    );
  }

  for (const task of existingTasksResult.rows) {
    if (activeTaskIds.has(task.id)) {
      continue;
    }

    const hasHistory = task.status === "done" || task.completed_date != null || Number(task.event_count) > 0;
    if (hasHistory) {
      // If the flow changed after work was recorded, keep the task as a historical
      // manual row instead of deleting the ID that farm_events may reference.
      await client.query(
        `
          update tasks
          set
            is_auto_generated = false,
            task_flow_node_id = null,
            notes = case
              when coalesce(notes, '') like '%Task kept as history after its flow node was removed.%' then notes
              else concat_ws(E'\n', notes, 'Task kept as history after its flow node was removed.')
            end,
            updated_at = now()
          where id = $1
        `,
        [task.id]
      );
    } else {
      await client.query(`delete from tasks where id = $1`, [task.id]);
    }
  }
}
