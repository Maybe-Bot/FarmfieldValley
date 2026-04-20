import test from "node:test";
import assert from "node:assert/strict";
import { assertUndoRestoreIsAccountSafe } from "./undo-safety";

function makeClient(rows: Array<{ username: string; label: string; created_at: string }>) {
  return {
    lastParams: null as unknown[] | null,
    async query(_sql: string, params?: unknown[]) {
      this.lastParams = params ?? null;
      return { rows };
    }
  };
}

const auth = {
  userId: 10,
  username: "owner",
  displayName: null,
  farmId: 20,
  farmName: "Test Farm",
  role: "planner",
  isAdmin: false
} as const;

test("assertUndoRestoreIsAccountSafe allows restore when no other user changed the farm", async () => {
  const client = makeClient([]);

  await assertUndoRestoreIsAccountSafe(client as never, auth, "2026-04-16T10:00:00Z", "undo");

  assert.deepEqual(client.lastParams, [20, 10, "2026-04-16T10:00:00Z"]);
});

test("assertUndoRestoreIsAccountSafe blocks restore over another user's newer snapshot", async () => {
  const client = makeClient([
    { username: "crew", label: "Record task", created_at: "2026-04-16T10:05:00Z" }
  ]);

  await assert.rejects(
    () => assertUndoRestoreIsAccountSafe(client as never, auth, "2026-04-16T10:00:00Z", "undo"),
    /crew changed this farm after your snapshot/
  );
});
