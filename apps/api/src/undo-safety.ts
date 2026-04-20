import { AuthContext } from "./auth";
import { PoolClient } from "pg";

type ConnectedClient = PoolClient;

// Snapshot restore rewrites whole farm planning tables. It is only safe when no
// other user has changed the same farm after the snapshot point being restored.
export async function assertUndoRestoreIsAccountSafe(
  client: ConnectedClient,
  auth: AuthContext,
  snapshotPoint: string | Date,
  action: "undo" | "redo"
) {
  const result = await client.query<{ username: string; label: string; created_at: string }>(
    `
      select app_user.username, snapshot.label, snapshot.created_at
      from undo_snapshots snapshot
      join app_users app_user on app_user.id = snapshot.user_id
      where snapshot.farm_id = $1
        and snapshot.user_id <> $2
        and snapshot.created_at > $3
      order by snapshot.created_at desc, snapshot.id desc
      limit 1
    `,
    [auth.farmId, auth.userId, snapshotPoint]
  );

  const conflict = result.rows[0];
  if (conflict) {
    throw new Error(
      `Cannot ${action}: ${conflict.username} changed this farm after your snapshot. Refresh before continuing so their work is not overwritten.`
    );
  }
}
