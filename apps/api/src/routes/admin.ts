import express from "express";
import { AuthContext } from "../auth";
import { enforceRateLimit, requestIp } from "../auth-rate-limit";
import { pool } from "../db";
import { asyncHandler, currentAuth, requireAdmin, requireRole } from "../route-helpers";
import { farmSettingsSchema, feedbackReplySchema, feedbackSchema } from "../schemas";
import { FarmRole } from "../types";

function stringifiedLength(value: unknown) {
  return JSON.stringify(value).length;
}

function assertFeedbackPayloadLimits(body: {
  context?: Record<string, unknown>;
  recentActivity?: Array<Record<string, unknown>>;
}) {
  const contextLength = stringifiedLength(body.context ?? {});
  const recentActivityLength = stringifiedLength(body.recentActivity ?? []);
  if (contextLength > 50_000) {
    throw new Error("Feedback context is too large");
  }
  if (recentActivityLength > 50_000) {
    throw new Error("Feedback activity details are too large");
  }
}

export function registerAdminRoutes(app: express.Express) {
  // Farm member list. New members are added through the invitation routes.
  app.get("/api/accounts", requireRole("planner"), asyncHandler(async (req, res) => {
    const auth = currentAuth(req) as AuthContext;
    const result = await pool.query<{
      id: number;
      email: string;
      username: string;
      display_name: string | null;
      role: FarmRole;
      created_at: string;
    }>(
      `
        select
          app_user.id,
          app_user.email,
          app_user.username,
          app_user.display_name,
          membership.role,
          app_user.created_at
        from farm_memberships membership
        join app_users app_user on app_user.id = membership.user_id
        where membership.farm_id = $1
        order by
          case when membership.role = 'planner' then 0 else 1 end,
          app_user.username
      `,
      [auth.farmId]
    );

    res.json(result.rows.map((row: {
      id: number;
      email: string;
      username: string;
      display_name: string | null;
      role: FarmRole;
      created_at: string;
    }) => ({
      id: row.id,
      email: row.email,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      createdAt: row.created_at
    })));
  }));

  app.post("/api/accounts", requireRole("planner"), asyncHandler(async (req, res) => {
    res.status(410).json({ error: "Direct account creation has been replaced by invitations." });
  }));

  // Admin panel routes. Admin is separate from the normal farm planner/worker role.
  app.get("/api/admin/users", requireAdmin(), asyncHandler(async (_req, res) => {
    const result = await pool.query<{
      id: number;
      username: string;
      display_name: string | null;
      is_active: boolean;
      is_admin: boolean;
      created_at: string;
      last_session_at: string | null;
      feedback_count: string;
      memberships: Array<{ farmId: number; farmName: string; role: FarmRole }>;
    }>(
      `
        select
          app_user.id,
          app_user.username,
          app_user.display_name,
          app_user.is_active,
          app_user.is_admin,
          app_user.created_at,
          max(session.created_at) as last_session_at,
          count(distinct feedback.id)::text as feedback_count,
          coalesce(
            jsonb_agg(
              distinct jsonb_build_object(
                'farmId', farm.id,
                'farmName', farm.name,
                'role', membership.role
              )
            ) filter (where farm.id is not null),
            '[]'::jsonb
          ) as memberships
        from app_users app_user
        left join farm_memberships membership on membership.user_id = app_user.id
        left join farms farm on farm.id = membership.farm_id
        left join user_sessions session on session.user_id = app_user.id
        left join feedback_reports feedback on feedback.user_id = app_user.id
        group by app_user.id
        order by app_user.is_admin desc, app_user.is_active desc, app_user.created_at desc, app_user.username
      `
    );

    res.json(result.rows.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      isActive: row.is_active,
      isAdmin: row.is_admin,
      createdAt: row.created_at,
      lastSessionAt: row.last_session_at,
      feedbackCount: Number(row.feedback_count),
      memberships: row.memberships
    })));
  }));

  app.delete("/api/admin/users/:id", requireAdmin(), asyncHandler(async (req, res) => {
    const auth = currentAuth(req) as AuthContext;
    const userId = Number(req.params.id);
    if (userId === auth.userId) {
      res.status(400).json({ error: "You cannot delete the admin account you are currently using." });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from user_sessions where user_id = $1`, [userId]);
      await client.query(
        `
          update app_users
          set is_active = false, updated_at = now()
          where id = $1
        `,
        [userId]
      );
      await client.query("commit");
      res.json({ ok: true });
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));

  app.get("/api/messages", requireRole("worker"), asyncHandler(async (req, res) => {
    const auth = currentAuth(req) as AuthContext;
    const result = await pool.query<{
      id: number;
      farm_id: number | null;
      sender_user_id: number | null;
      sender_username: string | null;
      sender_display_name: string | null;
      recipient_user_id: number;
      related_feedback_report_id: number | null;
      subject: string;
      body: string;
      read_at: string | null;
      created_at: string;
    }>(
      `
        select
          message.id,
          message.farm_id,
          message.sender_user_id,
          sender.username as sender_username,
          sender.display_name as sender_display_name,
          message.recipient_user_id,
          message.related_feedback_report_id,
          message.subject,
          message.body,
          message.read_at,
          message.created_at
        from user_messages message
        left join app_users sender on sender.id = message.sender_user_id
        where message.recipient_user_id = $1
        order by message.created_at desc, message.id desc
        limit 100
      `,
      [auth.userId]
    );

    res.json(result.rows.map((row) => ({
      id: row.id,
      farmId: row.farm_id,
      senderUserId: row.sender_user_id,
      senderUsername: row.sender_username,
      senderDisplayName: row.sender_display_name,
      recipientUserId: row.recipient_user_id,
      relatedFeedbackReportId: row.related_feedback_report_id,
      subject: row.subject,
      body: row.body,
      readAt: row.read_at,
      createdAt: row.created_at
    })));
  }));

  app.post("/api/messages/:id/read", requireRole("worker"), asyncHandler(async (req, res) => {
    const auth = currentAuth(req) as AuthContext;
    const messageId = Number(req.params.id);
    await pool.query(
      `
        update user_messages
        set read_at = coalesce(read_at, now())
        where id = $1
          and recipient_user_id = $2
      `,
      [messageId, auth.userId]
    );
    res.json({ ok: true });
  }));

  // Farm-wide settings and feedback/suggestion reporting.
  app.put("/api/farm/settings", requireAdmin(), asyncHandler(async (req, res) => {
    const auth = currentAuth(req) as AuthContext;
    const body = farmSettingsSchema.parse(req.body);
    await pool.query(
      `
        update farms
        set maps_private = $2, updated_at = now()
        where id = $1
      `,
      [auth.farmId, body.mapsPrivate]
    );
    res.json({ ok: true });
  }));

  app.post("/api/feedback", asyncHandler(async (req, res) => {
    if (!(await enforceRateLimit(req, res, `feedback:${requestIp(req)}`, {
      limit: 40,
      windowMs: 60 * 60 * 1000,
      message: "Too many feedback submissions. Try again later."
    }))) {
      return;
    }
    const auth = currentAuth(req);
    const body = feedbackSchema.parse(req.body);
    assertFeedbackPayloadLimits(body);
    const result = await pool.query<{ id: number }>(
      `
        insert into feedback_reports (
          farm_id, user_id, page, comment, context, recent_activity, user_agent
        )
        values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
        returning id
      `,
      [
        auth?.farmId ?? null,
        auth?.userId ?? null,
        body.page,
        body.comment?.trim() || null,
        JSON.stringify(body.context ?? {}),
        JSON.stringify(body.recentActivity ?? []),
        req.get("user-agent") ?? null
      ]
    );

    res.status(201).json({ id: result.rows[0].id });
  }));

  app.get("/api/feedback", requireAdmin(), asyncHandler(async (req, res) => {
    const auth = currentAuth(req) as AuthContext;
    type FeedbackReportRow = {
      id: number;
      farm_id: number | null;
      user_id: number | null;
      username: string | null;
      display_name: string | null;
      page: string;
      comment: string | null;
      context: Record<string, unknown>;
      recent_activity: Array<Record<string, unknown>>;
      user_agent: string | null;
      created_at: string;
      reply_count: string;
      last_reply_at: string | null;
    };
    let rows: FeedbackReportRow[];
    try {
      const result = await pool.query<FeedbackReportRow>(
        `
          select
            report.id,
            report.farm_id,
            report.user_id,
            app_user.username,
            app_user.display_name,
            report.page,
            report.comment,
            report.context,
            report.recent_activity,
            report.user_agent,
            report.created_at,
            count(reply.id)::text as reply_count,
            max(reply.created_at) as last_reply_at
          from feedback_reports report
          left join app_users app_user on app_user.id = report.user_id
          left join user_messages reply on reply.related_feedback_report_id = report.id
          where $1::boolean = true
          group by report.id, app_user.id
          order by report.created_at desc, report.id desc
          limit 50
        `,
        [auth.isAdmin]
      );
      rows = result.rows;
    } catch (error) {
      if ((error as { code?: string }).code !== "42P01") {
        throw error;
      }
      const result = await pool.query<FeedbackReportRow>(
        `
          select
            report.id,
            report.farm_id,
            report.user_id,
            app_user.username,
            app_user.display_name,
            report.page,
            report.comment,
            report.context,
            report.recent_activity,
            report.user_agent,
            report.created_at,
            '0'::text as reply_count,
            null::timestamptz as last_reply_at
          from feedback_reports report
          left join app_users app_user on app_user.id = report.user_id
          where $1::boolean = true
          order by report.created_at desc, report.id desc
          limit 50
        `,
        [auth.isAdmin]
      );
      rows = result.rows;
    }

    res.json(rows.map((row) => ({
      id: row.id,
      farmId: row.farm_id,
      userId: row.user_id,
      username: row.username ?? "anonymous",
      displayName: row.display_name,
      page: row.page,
      comment: row.comment,
      context: row.context,
      recentActivity: row.recent_activity,
      userAgent: row.user_agent,
      createdAt: row.created_at,
      replyCount: Number(row.reply_count),
      lastReplyAt: row.last_reply_at
    })));
  }));

  app.post("/api/feedback/:id/replies", requireAdmin(), asyncHandler(async (req, res) => {
    const auth = currentAuth(req) as AuthContext;
    const feedbackId = Number(req.params.id);
    const body = feedbackReplySchema.parse(req.body);
    const reportResult = await pool.query<{
      id: number;
      farm_id: number | null;
      user_id: number | null;
      comment: string | null;
    }>(
      `
        select id, farm_id, user_id, comment
        from feedback_reports
        where id = $1
        limit 1
      `,
      [feedbackId]
    );
    const report = reportResult.rows[0];
    if (!report) {
      res.status(404).json({ error: "Feedback report not found" });
      return;
    }
    if (report.user_id == null) {
      res.status(400).json({ error: "Anonymous reports cannot receive inbox replies." });
      return;
    }

    const result = await pool.query<{
      id: number;
      farm_id: number | null;
      sender_user_id: number | null;
      sender_username: string | null;
      sender_display_name: string | null;
      recipient_user_id: number;
      related_feedback_report_id: number | null;
      subject: string;
      body: string;
      read_at: string | null;
      created_at: string;
    }>(
      `
        with inserted as (
          insert into user_messages (
            farm_id,
            sender_user_id,
            recipient_user_id,
            related_feedback_report_id,
            subject,
            body
          )
          values ($1, $2, $3, $4, $5, $6)
          returning *
        )
        select
          inserted.id,
          inserted.farm_id,
          inserted.sender_user_id,
          sender.username as sender_username,
          sender.display_name as sender_display_name,
          inserted.recipient_user_id,
          inserted.related_feedback_report_id,
          inserted.subject,
          inserted.body,
          inserted.read_at,
          inserted.created_at
        from inserted
        left join app_users sender on sender.id = inserted.sender_user_id
      `,
      [
        report.farm_id,
        auth.userId,
        report.user_id,
        report.id,
        "Reply to your suggestion/problem report",
        body.body
      ]
    );
    const row = result.rows[0];

    res.status(201).json({
      id: row.id,
      farmId: row.farm_id,
      senderUserId: row.sender_user_id,
      senderUsername: row.sender_username,
      senderDisplayName: row.sender_display_name,
      recipientUserId: row.recipient_user_id,
      relatedFeedbackReportId: row.related_feedback_report_id,
      subject: row.subject,
      body: row.body,
      readAt: row.read_at,
      createdAt: row.created_at
    });
  }));
}
