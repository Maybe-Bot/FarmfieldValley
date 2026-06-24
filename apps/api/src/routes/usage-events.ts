import express from "express";
import { z } from "zod";
import { config } from "../config";
import { pool } from "../db";
import { asyncHandler, currentAuth, requireAdmin } from "../route-helpers";
import { sanitizeUsageEvent } from "../usage-privacy";

let lastRetentionSweep = 0;

export type UsageEventIngestionStore = {
  isUsageTrackingEnabled: (userId: number) => Promise<boolean>;
  consumeUsageRateLimit: (userId: number) => Promise<boolean>;
  recordUsageEvent: (event: {
    eventType: string;
    page: string;
    details: Record<string, string>;
    durationBucket: string | null;
  }) => Promise<void>;
  pruneUsageData: () => Promise<void>;
};

async function pruneStoredUsageData() {
  const now = Date.now();
  if (now - lastRetentionSweep < 60 * 60 * 1000) return;

  await pool.query(
    "delete from usage_events where occurred_at < now() - ($1::int * interval '1 day')",
    [config.usageRetentionDays]
  );
  await pool.query("delete from usage_rate_limits where expires_at < now()");
  lastRetentionSweep = now;
}

async function consumeUsageRateLimit(userId: number) {
  const result = await pool.query(
    `
      insert into usage_rate_limits (user_id, window_start, event_count, expires_at)
      values ($1, date_trunc('minute', now()), 1, now() + interval '2 hours')
      on conflict (user_id, window_start)
      do update set event_count = usage_rate_limits.event_count + 1
      where usage_rate_limits.event_count < $2
      returning event_count
    `,
    [userId, config.usageRateLimitPerMinute]
  );

  return result.rows.length > 0;
}

async function isUsageTrackingEnabled(userId: number) {
  const preference = await pool.query(
    "select usage_tracking_enabled from app_users where id = $1",
    [userId]
  );
  return preference.rows[0]?.usage_tracking_enabled === true;
}

async function recordUsageEvent(event: {
  eventType: string;
  page: string;
  details: Record<string, string>;
  durationBucket: string | null;
}) {
  await pool.query(
    `insert into usage_events (event_type, page, occurred_at, details)
     values ($1, $2, now(), $3)`,
    [
      event.eventType,
      event.page,
      JSON.stringify({
        ...event.details,
        ...(event.durationBucket ? { duration: event.durationBucket } : {})
      })
    ]
  );
}

export async function ingestUsageEventForUser(
  userId: number,
  body: unknown,
  store: UsageEventIngestionStore
) {
  if (!(await store.isUsageTrackingEnabled(userId))) {
    return { ok: true, recorded: false, rateLimited: false };
  }

  const event = sanitizeUsageEvent(body);
  if (!(await store.consumeUsageRateLimit(userId))) {
    return { ok: false, recorded: false, rateLimited: true };
  }

  await store.pruneUsageData();
  await store.recordUsageEvent(event);
  return { ok: true, recorded: true, rateLimited: false };
}

const postgresUsageEventStore: UsageEventIngestionStore = {
  isUsageTrackingEnabled,
  consumeUsageRateLimit,
  async pruneUsageData() {
    void pruneStoredUsageData().catch((error) => console.error("Usage retention sweep failed", error));
  },
  recordUsageEvent
};

export function registerUsageEventRoutes(app: express.Express) {
  app.get("/api/usage/preference", asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    if (!auth) {
      res.status(401).json({ error: "Login required" });
      return;
    }
    const result = await pool.query(
      "select usage_tracking_enabled from app_users where id = $1",
      [auth.userId]
    );
    res.json({ enabled: result.rows[0]?.usage_tracking_enabled === true });
  }));

  app.put("/api/usage/preference", asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    if (!auth) {
      res.status(401).json({ error: "Login required" });
      return;
    }
    const body = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    await pool.query(
      "update app_users set usage_tracking_enabled = $1, updated_at = now() where id = $2",
      [body.enabled, auth.userId]
    );
    res.json({ enabled: body.enabled });
  }));

  app.post("/api/usage/events", asyncHandler(async (req, res) => {
    const auth = currentAuth(req);
    if (!auth) {
      res.status(401).json({ error: "Login required" });
      return;
    }

    const result = await ingestUsageEventForUser(auth.userId, req.body, postgresUsageEventStore);
    if (result.rateLimited) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "Usage tracking rate limit exceeded. Try again shortly." });
      return;
    }

    if (!result.recorded) {
      res.json({ ok: true, recorded: false });
      return;
    }

    res.status(201).json({ ok: true, recorded: true });
  }));

  app.get("/api/usage/events", requireAdmin(), asyncHandler(async (req, res) => {
    await pruneStoredUsageData();
    const limit = z.coerce.number().int().min(1).max(500).default(200).parse(req.query.limit);
    const result = await pool.query(
      `select id, event_type as "eventType", page, occurred_at as "occurredAt",
              details, created_at as "createdAt"
       from usage_events
       order by occurred_at desc, id desc
       limit $1`,
      [limit]
    );
    res.json({ events: result.rows, retentionDays: config.usageRetentionDays });
  }));

  app.delete("/api/usage/events", requireAdmin(), asyncHandler(async (_req, res) => {
    const result = await pool.query(
      "with deleted as (delete from usage_events returning 1) select count(*)::int as count from deleted"
    );
    res.json({ ok: true, deleted: result.rows[0]?.count ?? 0 });
  }));
}
