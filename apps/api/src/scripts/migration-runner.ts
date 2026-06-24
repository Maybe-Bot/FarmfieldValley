export type Migration = {
  filename: string;
  sql: string;
};

export type MigrationClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

export type MigrationLogger = Pick<Console, "log" | "error">;

const NO_TRANSACTION_MARKER = "-- migrate:no-transaction";

/**
 * These migrations predate migration tracking. Existing deployments used the
 * old runner, which executed every file on every deploy, so a current schema
 * can safely record this fixed historical set without executing it again.
 *
 * Do not add future migrations to this list.
 */
export const LEGACY_BASELINE_MIGRATIONS = [
  "001_init.sql",
  "002_field_block_polygons.sql",
  "003_bed_presets_and_geometry.sql",
  "004_task_flow_templates.sql",
  "005_task_flow_graph.sql",
  "006_auth_and_farm_scope.sql",
  "007_block_zones.sql",
  "008_block_zone_unassigned.sql",
  "009_block_zone_future_use_optional.sql",
  "010_farm_events_and_placement_detail.sql",
  "011_feedback_reports.sql",
  "012_feedback_public_reports.sql",
  "013_undo_snapshots.sql",
  "014_undo_redo.sql",
  "015_farm_map_privacy.sql",
  "016_bed_geometry_tracking.sql",
  "017_seed_genetics.sql",
  "018_task_icon_colors.sql",
  "019_tray_start_details.sql",
  "020_block_zone_cover_crop_dates.sql",
  "021_admin_accounts.sql",
  "022_seed_catalog_number.sql",
  "023_task_icon_secondary_colors.sql",
  "024_road_presets_and_block_bed_tasks.sql",
  "025_planting_location_and_import_details.sql",
  "026_private_maps_by_default.sql",
  "027_user_emails.sql",
  "028_tractor_model_selection.sql",
  "029_saved_tractor_profiles.sql",
  "030_saved_garage_vehicles.sql",
  "031_block_placement_plan.sql",
  "032_seed_item_archive.sql",
  "033_seed_item_maturity_and_availability.sql",
  "034_remove_seed_on_hand.sql",
  "035_seed_item_stock_quantity.sql",
  "036_seed_item_lots.sql",
  "037_default_bed_presets.sql",
  "038_sample_task_flows.sql",
  "039_seed_item_spacing_defaults.sql",
  "040_email_verification.sql",
  "041_usage_events.sql",
  "042_user_messages.sql",
  "043_beta_signup_email_defaults.sql",
  "044_simplify_task_flow_anchors.sql",
  "045_fractional_tray_counts.sql",
  "046_task_flow_edge_delays.sql",
  "047_fractional_task_flow_delays.sql"
] as const;

const CREATE_APPLIED_MIGRATIONS_TABLE = `
  create table if not exists applied_migrations (
    filename text primary key,
    applied_at timestamptz not null default now(),
    execution_ms integer,
    baselined boolean not null default false
  )
`;

const READ_ADOPTION_STATE = `
  select
    to_regclass('public.farms') is not null as existing_database,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'app_users'
        and column_name = 'email_verified_at'
    ) as email_verification_applied,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'task_flow_edges'
        and column_name = 'delay_days'
        and data_type = 'numeric'
        and numeric_precision = 8
        and numeric_scale = 2
    ) as latest_baseline_applied
`;

function usesTransaction(migration: Migration) {
  return !migration.sql
    .split(/\r?\n/, 1)[0]
    ?.trim()
    .toLowerCase()
    .startsWith(NO_TRANSACTION_MARKER);
}

async function baselineExistingDeployment(
  client: MigrationClient,
  migrations: Migration[],
  logger: MigrationLogger
) {
  const result = await client.query(READ_ADOPTION_STATE);
  const state = result.rows[0] ?? {};

  if (!state.existing_database) {
    return new Set<string>();
  }

  if (!state.email_verification_applied || !state.latest_baseline_applied) {
    throw new Error(
      "Existing database cannot be safely baselined: expected historical schema markers are missing. " +
        "No historical migrations were executed. Restore/update the database to migration 047 before retrying."
    );
  }

  const availableFiles = new Set(migrations.map((migration) => migration.filename));
  const baselineFiles = LEGACY_BASELINE_MIGRATIONS.filter((filename) => availableFiles.has(filename));

  await client.query("BEGIN");
  try {
    for (const filename of baselineFiles) {
      await client.query(
        `insert into applied_migrations (filename, execution_ms, baselined)
         values ($1, 0, true)
         on conflict (filename) do nothing`,
        [filename]
      );
      logger.log(`[migration] BASELINED ${filename}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  return new Set<string>(baselineFiles);
}

export async function runMigrations(
  client: MigrationClient,
  migrations: Migration[],
  logger: MigrationLogger = console
) {
  await client.query(CREATE_APPLIED_MIGRATIONS_TABLE);

  const appliedResult = await client.query("select filename from applied_migrations order by filename");
  let applied = new Set(appliedResult.rows.map((row) => String(row.filename)));

  if (applied.size === 0) {
    applied = await baselineExistingDeployment(client, migrations, logger);
  }

  for (const migration of migrations) {
    if (applied.has(migration.filename)) {
      logger.log(`[migration] SKIPPED ${migration.filename}`);
      continue;
    }

    const startedAt = Date.now();
    const transactional = usesTransaction(migration);

    try {
      if (transactional) {
        await client.query("BEGIN");
      }

      await client.query(migration.sql);
      const executionMs = Date.now() - startedAt;
      await client.query(
        `insert into applied_migrations (filename, execution_ms, baselined)
         values ($1, $2, false)`,
        [migration.filename, executionMs]
      );

      if (transactional) {
        await client.query("COMMIT");
      }

      applied.add(migration.filename);
      logger.log(`[migration] APPLIED ${migration.filename} (${executionMs}ms)`);
    } catch (error) {
      if (transactional) {
        await client.query("ROLLBACK");
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[migration] FAILED ${migration.filename}: ${message}`);
      throw new Error(`Migration failed: ${migration.filename}`, { cause: error });
    }
  }
}
