import express from "express";
import { z } from "zod";
import { AuthContext } from "../auth";
import { pool } from "../db";

const usageEventSchema = z.object({
  anonymousId: z.string().trim().max(80).nullable().optional(),
  browserSessionId: z.string().trim().max(80).nullable().optional(),
  eventType: z.string().trim().min(1).max(80),
  page: z.string().trim().min(1).max(120),
  path: z.string().trim().min(1).max(512),
  title: z.string().trim().max(200).nullable().optional(),
  occurredAt: z.string().datetime().nullable().optional(),
  durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).nullable().optional(),
  details: z.record(z.unknown()).optional()
});

type UsageEventRouteDeps = {
  asyncHandler: (
    handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>
  ) => express.RequestHandler;
  currentAuth: (req: express.Request) => AuthContext | null;
  requireAdmin: () => express.RequestHandler;
};

function jsonLength(value: unknown) {
  return JSON.stringify(value).length;
}

function assertUsageEventLimits(body: z.infer<typeof usageEventSchema>) {
  if (jsonLength(body.details ?? {}) > 20_000) {
    throw new Error("Usage event details are too large");
  }
}

export function registerUsageEventRoutes(app: express.Express, deps: UsageEventRouteDeps) {
  app.post("/api/usage/events", deps.asyncHandler(async (req, res) => {
    const auth = deps.currentAuth(req);
    const body = usageEventSchema.parse(req.body);
    assertUsageEventLimits(body);

    await pool.query(
      `
        insert into usage_events (
          farm_id,
          user_id,
          anonymous_id,
          browser_session_id,
          event_type,
          page,
          path,
          title,
          occurred_at,
          duration_ms,
          details,
          user_agent
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::timestamptz, now()), $10, $11, $12)
      `,
      [
        auth?.farmId ?? null,
        auth?.userId ?? null,
        body.anonymousId ?? null,
        body.browserSessionId ?? null,
        body.eventType,
        body.page,
        body.path,
        body.title ?? null,
        body.occurredAt ?? null,
        body.durationMs ?? null,
        JSON.stringify(body.details ?? {}),
        req.header("user-agent") ?? null
      ]
    );

    res.status(201).json({ ok: true });
  }));

  app.get("/api/usage/events", deps.requireAdmin(), deps.asyncHandler(async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(500).default(200).parse(req.query.limit);
    const result = await pool.query(
      `
        select
          event.id,
          event.farm_id as "farmId",
          farm.name as "farmName",
          event.user_id as "userId",
          app_user.username,
          app_user.display_name as "displayName",
          event.anonymous_id as "anonymousId",
          event.browser_session_id as "browserSessionId",
          event.event_type as "eventType",
          event.page,
          event.path,
          event.title,
          event.occurred_at as "occurredAt",
          event.duration_ms as "durationMs",
          event.details,
          event.user_agent as "userAgent",
          event.created_at as "createdAt"
        from usage_events event
        left join app_users app_user on app_user.id = event.user_id
        left join farms farm on farm.id = event.farm_id
        order by event.occurred_at desc, event.id desc
        limit $1
      `,
      [limit]
    );

    res.json(result.rows);
  }));
}
