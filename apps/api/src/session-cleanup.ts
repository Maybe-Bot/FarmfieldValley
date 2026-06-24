import { pool } from "./db";

export type SessionCleanupClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<{ count?: number | string }> }>;
};

export const EXPIRED_SESSION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const DELETE_EXPIRED_USER_SESSIONS_SQL = `
  with deleted as (
    delete from user_sessions
    where expires_at <= now()
    returning 1
  )
  select count(*)::int as count from deleted
`;

export async function deleteExpiredUserSessions(client: SessionCleanupClient = pool) {
  const result = await client.query(DELETE_EXPIRED_USER_SESSIONS_SQL);
  return Number(result.rows[0]?.count ?? 0);
}

export function startExpiredSessionCleanup(
  client: SessionCleanupClient = pool,
  intervalMs = EXPIRED_SESSION_CLEANUP_INTERVAL_MS,
  logger: Pick<Console, "error"> = console
) {
  const run = () => {
    void deleteExpiredUserSessions(client).catch((error) => {
      logger.error("Expired session cleanup failed", error);
    });
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}
