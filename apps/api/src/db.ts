/**
 * Shared PostgreSQL connection pool.
 *
 * Every backend file should use this pool instead of creating its own database
 * connection. That keeps connection usage predictable when the app is hosted.
 */
import { Pool, QueryResultRow } from "pg";
import { config } from "./config";

export const pool = new Pool({
  connectionString: config.databaseUrl
});

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
  return pool.query<T>(text, params);
}
