/**
 * Task scheduler for planting work.
 *
 * A planting points at a task-flow template. Starter nodes schedule from the
 * planting's seeding date; nodes with an `after:<node_key>` anchor schedule
 * from the linked task's completed date, falling back to that task's planned
 * date until work is recorded. This module updates generated tasks in place so
 * task IDs, farm_events.task_id links, and user-visible history survive.
 */
import { PoolClient } from "pg";
import { titleCase } from "./utils";
import { isCurrentTaskType, isLegacyTaskType } from "./types";

type PlantingRow = {
  id: number;
  farm_id: number;
  crop_id: number;
  intended_bed_id: number | null;
  crop_name: string;
  variety_name: string | null;
  task_flow_template_id: number | null;
  planned_sow_date: string | null;
  actual_tray_seeding_date: string | null;
  actual_direct_seeding_date: string | null;
};

type FlowNodeRow = {
  id: number;
  node_key: string;
  task_type: string;
  label: string;
  anchor: string;
  offset_days: number;
  icon_color: string;
  icon_secondary_color: string;
  tractor_model: string | null;
  tractor_profile_id: number | null;
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

type GeneratedTaskTiming = {
  id: number;
  sourceDate: string;
};

// Task flows intentionally use one crop-date anchor: the seeding date. Once real
// seeding work is recorded it becomes the source date; until then, use the plan.
function resolvePlantingStartDate(planting: PlantingRow) {
  return planting.actual_direct_seeding_date ?? planting.actual_tray_seeding_date ?? planting.planned_sow_date;
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

function afterNodeKeys(anchor: string) {
  if (!anchor.startsWith("after:")) {
    return [];
  }

  return anchor
    .slice("after:".length)
    .split(",")
    .map((nodeKey) => nodeKey.trim())
    .filter(Boolean);
}

function latestDate(dates: string[]) {
  return dates.reduce((latest, date) => date > latest ? date : latest, dates[0]);
}

function orderNodesByEdges(nodes: FlowNodeRow[], edges: FlowEdgeRow[]) {
  const nodesByKey = new Map(nodes.map((node) => [node.node_key, node]));
  const indegreeByKey = new Map(nodes.map((node) => [node.node_key, 0]));
  const downstreamByKey = new Map(nodes.map((node) => [node.node_key, [] as string[]]));

  for (const edge of edges) {
    if (!nodesByKey.has(edge.from_node_key) || !nodesByKey.has(edge.to_node_key)) {
      continue;
    }
    downstreamByKey.get(edge.from_node_key)?.push(edge.to_node_key);
    indegreeByKey.set(edge.to_node_key, (indegreeByKey.get(edge.to_node_key) ?? 0) + 1);
  }

  const ready = nodes.filter((node) => (indegreeByKey.get(node.node_key) ?? 0) === 0);
  const ordered: FlowNodeRow[] = [];
  const queued = new Set(ready.map((node) => node.node_key));

  while (ready.length > 0) {
    const node = ready.shift() as FlowNodeRow;
    ordered.push(node);
    for (const downstreamNodeKey of downstreamByKey.get(node.node_key) ?? []) {
      const nextIndegree = (indegreeByKey.get(downstreamNodeKey) ?? 0) - 1;
      indegreeByKey.set(downstreamNodeKey, nextIndegree);
      if (nextIndegree === 0 && !queued.has(downstreamNodeKey)) {
        const downstreamNode = nodesByKey.get(downstreamNodeKey);
        if (downstreamNode) {
          ready.push(downstreamNode);
          queued.add(downstreamNodeKey);
        }
      }
    }
  }

  if (ordered.length !== nodes.length) {
    const orderedKeys = new Set(ordered.map((node) => node.node_key));
    ordered.push(...nodes.filter((node) => !orderedKeys.has(node.node_key)));
  }

  return ordered;
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
        p.actual_tray_seeding_date,
        p.actual_direct_seeding_date
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
        select id, node_key, task_type, label, anchor, offset_days, icon_color, icon_secondary_color, tractor_model, tractor_profile_id
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
  const taskTimingByNodeKey = new Map<string, GeneratedTaskTiming>();
  const existingTasksByFlowNodeId = new Map(
    existingTasksResult.rows
      .filter((task) => task.task_flow_node_id != null)
      .map((task) => [task.task_flow_node_id as number, task])
  );
  const activeTaskIds = new Set<number>();
  const orderedNodes = orderNodesByEdges(nodesResult.rows, edgesResult.rows);
  const staleNode = orderedNodes.find((node) => !isCurrentTaskType(node.task_type));
  if (staleNode) {
    throw new Error(isLegacyTaskType(staleNode.task_type)
      ? `Task flow uses old category "${staleNode.task_type}" on "${staleNode.label}". Update the flow to current task categories before it can schedule tasks.`
      : `Task flow uses unknown category "${staleNode.task_type}" on "${staleNode.label}". Update the flow to current task categories before it can schedule tasks.`);
  }

  for (const node of orderedNodes) {
    const sourceNodeKeys = afterNodeKeys(node.anchor);
    const sourceDates = sourceNodeKeys
      .map((nodeKey) => taskTimingByNodeKey.get(nodeKey)?.sourceDate)
      .filter((value: string | undefined): value is string => value != null);
    const baseDate = sourceNodeKeys.length > 0
      ? sourceDates.length === sourceNodeKeys.length ? latestDate(sourceDates) : null
      : resolvePlantingStartDate(planting);
    if (!baseDate) {
      continue;
    }

    const effectiveOffsetDays = node.offset_days;
    const scheduledDate = addDays(baseDate, effectiveOffsetDays);
    const taskAnchor = node.anchor;
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
            tractor_model = $8,
            tractor_profile_id = $9,
            anchor = $10,
            offset_days = $11,
            scheduled_date = $12,
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
          node.tractor_model,
          node.tractor_profile_id,
          taskAnchor,
          effectiveOffsetDays,
          scheduledDate
        ]
      );
      taskIdsByNodeKey.set(node.node_key, existingTask.id);
      taskTimingByNodeKey.set(node.node_key, {
        id: existingTask.id,
        sourceDate: existingTask.completed_date ? toDateOnlyString(existingTask.completed_date) : scheduledDate
      });
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
            tractor_model,
            tractor_profile_id,
            status,
            anchor,
            offset_days,
            scheduled_date,
            is_auto_generated
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12, $13, true)
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
          node.tractor_model,
          node.tractor_profile_id,
          taskAnchor,
          effectiveOffsetDays,
          scheduledDate
        ]
      );
      taskIdsByNodeKey.set(node.node_key, result.rows[0].id);
      taskTimingByNodeKey.set(node.node_key, {
        id: result.rows[0].id,
        sourceDate: scheduledDate
      });
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
