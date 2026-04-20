/**
 * Applies every SQL migration file in apps/api/src/sql in filename order.
 *
 * Migrations are written to be safe to rerun where practical, but still treat
 * them as database-changing commands. Run this before starting the app after a
 * schema change.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pool } from "../db";

async function run() {
  const sqlDir = path.join(__dirname, "..", "sql");
  const files = (await fs.readdir(sqlDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = await fs.readFile(path.join(sqlDir, file), "utf8");
    await pool.query(sql);
  }
  console.log("Migration complete");
  await pool.end();
}

run().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
