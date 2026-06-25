import express from "express";
import { PoolClient } from "pg";
import { AuthContext } from "../auth";
import { pool } from "../db";
import { asyncHandler, currentAuth, requireRole } from "../route-helpers";
import { taskFlowSchema, taskFlowUpdateSchema } from "../schemas";
import { recalculatePlantingTasks } from "../scheduler";
import { TaskType } from "../types";
import { createUndoSnapshot, pruneUndoSnapshots } from "../undo";

const MAX_SYNC_TASK_FLOW_DELETE_RECALCULATIONS = 100;

type SaveTaskFlowTemplate = (client: PoolClient, options: {
  id?: number;
  farmId?: number;
  cropId?: number | null;
  name: string;
  notes?: string | null;
  isDefault: boolean;
  nodes: Array<{ nodeKey: string; taskType: TaskType; label: string; anchor: string; offsetDays: number; iconColor: string; iconSecondaryColor: string; tractorModel?: string | null; tractorProfileId?: number | null; x: number; y: number; notes?: string | null }>;
  edges: Array<{ fromNodeKey: string; toNodeKey: string; delayDays: number }>;
}) => Promise<number>;

export function registerTaskFlowRoutes(app: express.Express, saveTaskFlowTemplate: SaveTaskFlowTemplate) {
  // Visual task-flow editor routes.
  app.post("/api/task-flows", requireRole("planner"), asyncHandler(async (req, res) => {
    const body = taskFlowSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await createUndoSnapshot(client, auth, "Create task flow");
      const id = await saveTaskFlowTemplate(client, {
        farmId: auth.farmId,
        cropId: body.cropId ?? null,
        name: body.name,
        notes: body.notes ?? null,
        isDefault: body.isDefault,
        nodes: body.nodes,
        edges: body.edges
      });
      await pruneUndoSnapshots(client, auth);
      await client.query("commit");
      res.status(201).json({ id });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));
  
  app.put("/api/task-flows/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = taskFlowUpdateSchema.parse(req.body);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const existing = await client.query<{ id: number }>(`select id from task_flow_templates where id = $1 and farm_id = $2`, [id, auth.farmId]);
      if (!existing.rows[0]) {
        await client.query("rollback");
        res.status(404).json({ error: "Task flow template not found" });
        return;
      }
      await createUndoSnapshot(client, auth, "Update task flow");
      await saveTaskFlowTemplate(client, {
        id,
        farmId: auth.farmId,
        cropId: body.cropId ?? null,
        name: body.name,
        notes: body.notes ?? null,
        isDefault: body.isDefault,
        nodes: body.nodes,
        edges: body.edges
      });
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
  
  app.post("/api/task-flows/:id/copy", requireRole("planner"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const templateResult = await client.query<{
        farm_id: number;
        crop_id: number | null;
        name: string;
        notes: string | null;
      }>(
        `select farm_id, crop_id, name, notes from task_flow_templates where id = $1 and farm_id = $2`,
        [id, auth.farmId]
      );
      const template = templateResult.rows[0];
      if (!template) {
        await client.query("rollback");
        res.status(404).json({ error: "Task flow template not found" });
        return;
      }
      await createUndoSnapshot(client, auth, "Copy task flow");
  
      const nodesResult = await client.query<{
        node_key: string;
        task_type: TaskType;
        label: string;
        anchor: string;
        offset_days: number;
        icon_color: string;
        icon_secondary_color: string;
        tractor_model: string | null;
        tractor_profile_id: number | null;
        x_pos: number;
        y_pos: number;
        notes: string | null;
      }>(
        `
          select node_key, task_type, label, anchor, offset_days, icon_color, icon_secondary_color, tractor_model, tractor_profile_id, x_pos, y_pos, notes
          from task_flow_nodes
          where flow_template_id = $1
          order by y_pos, x_pos, id
        `,
        [id]
      );
      const edgesResult = await client.query<{
        from_node_key: string;
        to_node_key: string;
        delay_days: number;
      }>(
        `
          select from_node.node_key as from_node_key, to_node.node_key as to_node_key, e.delay_days::float8 as delay_days
          from task_flow_edges e
          join task_flow_nodes from_node on from_node.id = e.from_node_id
          join task_flow_nodes to_node on to_node.id = e.to_node_id
          where e.flow_template_id = $1
          order by e.id
        `,
        [id]
      );
  
      const copyId = await saveTaskFlowTemplate(client, {
        farmId: template.farm_id,
        cropId: template.crop_id,
        name: `${template.name} Copy`,
        notes: template.notes,
        isDefault: false,
        nodes: nodesResult.rows.map((node: {
          node_key: string;
          task_type: TaskType;
          label: string;
          anchor: string;
          offset_days: number;
          icon_color: string;
          icon_secondary_color: string;
          tractor_model: string | null;
          tractor_profile_id: number | null;
          x_pos: number;
          y_pos: number;
          notes: string | null;
        }) => ({
          nodeKey: node.node_key,
          taskType: node.task_type,
          label: node.label,
          anchor: node.anchor,
          offsetDays: node.offset_days,
          iconColor: node.icon_color,
          iconSecondaryColor: node.icon_secondary_color,
          tractorModel: node.tractor_model,
          tractorProfileId: node.tractor_profile_id,
          x: Number(node.x_pos),
          y: Number(node.y_pos),
          notes: node.notes
        })),
        edges: edgesResult.rows.map((edge: { from_node_key: string; to_node_key: string; delay_days: number }) => ({
          fromNodeKey: edge.from_node_key,
          toNodeKey: edge.to_node_key,
          delayDays: Number(edge.delay_days)
        }))
      });
  
      await client.query(
        `update task_flow_templates set source_task_flow_template_id = $2 where id = $1 and farm_id = $3`,
        [copyId, id, auth.farmId]
      );
      await pruneUndoSnapshots(client, auth);
      await client.query("commit");
      res.status(201).json({ id: copyId });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));
  
  app.delete("/api/task-flows/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const auth = currentAuth(req) as AuthContext;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const templateResult = await client.query<{ crop_id: number | null; is_default: boolean }>(
        `select crop_id, is_default from task_flow_templates where id = $1 and farm_id = $2`,
        [id, auth.farmId]
      );
      const template = templateResult.rows[0];
      if (!template) {
        await client.query("rollback");
        res.status(404).json({ error: "Task flow template not found" });
        return;
      }
      await createUndoSnapshot(client, auth, "Delete task flow");
      const plantings = await client.query<{ id: number }>(
        template?.is_default
          ? `
              select id
              from plantings
              where farm_id = $2
                and crop_id = coalesce($3, crop_id)
                and (task_flow_template_id = $1 or task_flow_template_id is null)
              order by id
              limit $4
            `
          : `
              select id
              from plantings
              where farm_id = $2 and task_flow_template_id = $1
              order by id
              limit $4
            `,
        [id, auth.farmId, template.crop_id, MAX_SYNC_TASK_FLOW_DELETE_RECALCULATIONS + 1]
      );
      if (plantings.rows.length > MAX_SYNC_TASK_FLOW_DELETE_RECALCULATIONS) {
        throw new Error(`This task flow affects more than ${MAX_SYNC_TASK_FLOW_DELETE_RECALCULATIONS} plantings. To protect the server, move plantings to another flow in smaller groups before deleting it.`);
      }
      await client.query(`delete from task_flow_templates where id = $1 and farm_id = $2`, [id, auth.farmId]);
      for (const planting of plantings.rows) {
        await recalculatePlantingTasks(client, planting.id);
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
