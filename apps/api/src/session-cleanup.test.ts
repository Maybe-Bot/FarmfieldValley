import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  deleteExpiredUserSessions,
  DELETE_EXPIRED_USER_SESSIONS_SQL
} from "./session-cleanup";

test("expired user sessions are deleted by expiry time", async () => {
  const queries: string[] = [];
  const deleted = await deleteExpiredUserSessions({
    async query(text) {
      queries.push(text);
      return { rows: [{ count: 3 }] };
    }
  });

  assert.equal(deleted, 3);
  assert.match(queries[0], /delete from user_sessions/i);
  assert.match(queries[0], /where expires_at <= now\(\)/i);
});

test("session cleanup SQL can use the expires_at index", () => {
  const normalized = DELETE_EXPIRED_USER_SESSIONS_SQL.trim().replace(/\s+/g, " ").toLowerCase();

  assert.match(normalized, /delete from user_sessions where expires_at <= now\(\)/);
});

test("user session expiry index migration is present", async () => {
  const migration = await fs.readFile(
    path.join(__dirname, "sql", "051_user_session_cleanup.sql"),
    "utf8"
  );
  const normalized = migration.trim().replace(/\s+/g, " ").toLowerCase();

  assert.match(normalized, /create index if not exists user_sessions_expires_at_idx/);
  assert.match(normalized, /on user_sessions \(expires_at\)/);
});
