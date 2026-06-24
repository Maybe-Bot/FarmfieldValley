/** Applies pending SQL migrations in filename order. */
import fs from "node:fs/promises";
import path from "node:path";
import { pool } from "../db";
import { runMigrations } from "./migration-runner";

async function run() {
  const sqlDir = path.join(__dirname, "..", "sql");
  const files = (await fs.readdir(sqlDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const migrations = await Promise.all(
    files.map(async (filename) => ({
      filename,
      sql: await fs.readFile(path.join(sqlDir, filename), "utf8")
    }))
  );

  const client = await pool.connect();
  let lockAcquired = false;
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", ["farmman:migrations"]);
    lockAcquired = true;
    await runMigrations(client, migrations);
    console.log(`[migration] COMPLETE (${migrations.length} files checked)`);
  } finally {
    try {
      if (lockAcquired) {
        await client.query("select pg_advisory_unlock(hashtext($1))", ["farmman:migrations"]);
      }
    } finally {
      client.release();
    }
  }
  await pool.end();
}

run().catch(async (error) => {
  console.error("[migration] ABORTED", error);
  await pool.end();
  process.exit(1);
});
