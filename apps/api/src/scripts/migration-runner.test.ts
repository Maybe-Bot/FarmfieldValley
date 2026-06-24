import test from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_BASELINE_MIGRATIONS,
  Migration,
  MigrationClient,
  MigrationLogger,
  runMigrations
} from "./migration-runner";

type FakeOptions = {
  existingDatabase?: boolean;
  emailVerificationApplied?: boolean;
  latestBaselineApplied?: boolean;
  failSql?: string;
};

function makeFakeClient(options: FakeOptions = {}) {
  const applied = new Set<string>();
  const executedSql: string[] = [];
  const commands: string[] = [];

  const client: MigrationClient = {
    async query(text, params = []) {
      const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
      commands.push(normalized);

      if (normalized.startsWith("select filename from applied_migrations")) {
        return { rows: [...applied].map((filename) => ({ filename })) };
      }
      if (normalized.includes("to_regclass('public.farms')")) {
        return {
          rows: [
            {
              existing_database: options.existingDatabase ?? false,
              email_verification_applied: options.emailVerificationApplied ?? false,
              latest_baseline_applied: options.latestBaselineApplied ?? false
            }
          ]
        };
      }
      if (normalized.startsWith("insert into applied_migrations")) {
        applied.add(String(params[0]));
        return { rows: [] };
      }
      if (
        normalized === "begin" ||
        normalized === "commit" ||
        normalized === "rollback" ||
        normalized.startsWith("create table if not exists applied_migrations")
      ) {
        return { rows: [] };
      }

      executedSql.push(text);
      if (text === options.failSql) {
        throw new Error("simulated SQL failure");
      }
      return { rows: [] };
    }
  };

  return { client, applied, executedSql, commands };
}

function makeLogger() {
  const logs: string[] = [];
  const errors: string[] = [];
  const logger: MigrationLogger = {
    log(message) {
      logs.push(String(message));
    },
    error(message) {
      errors.push(String(message));
    }
  };
  return { logger, logs, errors };
}

test("040_email_verification.sql executes once and is skipped on later deploys", async () => {
  const migration: Migration = {
    filename: "040_email_verification.sql",
    sql: "update app_users set email_verified_at = now() where email_verified_at is null"
  };
  const fake = makeFakeClient();
  const output = makeLogger();

  await runMigrations(fake.client, [migration], output.logger);
  await runMigrations(fake.client, [migration], output.logger);

  assert.equal(fake.executedSql.filter((sql) => sql === migration.sql).length, 1);
  assert.equal(fake.applied.has(migration.filename), true);
  assert.equal(output.logs.some((line) => line.includes("APPLIED 040_email_verification.sql")), true);
  assert.equal(output.logs.some((line) => line.includes("SKIPPED 040_email_verification.sql")), true);
});

test("existing current deployments baseline historical migrations without executing them", async () => {
  const migrations = LEGACY_BASELINE_MIGRATIONS.map((filename) => ({
    filename,
    sql: `dangerous historical SQL for ${filename}`
  }));
  const fake = makeFakeClient({
    existingDatabase: true,
    emailVerificationApplied: true,
    latestBaselineApplied: true
  });
  const output = makeLogger();

  await runMigrations(fake.client, migrations, output.logger);

  assert.equal(fake.executedSql.length, 0);
  assert.equal(fake.applied.has("040_email_verification.sql"), true);
  assert.equal(fake.applied.size, LEGACY_BASELINE_MIGRATIONS.length);
  assert.equal(output.logs.some((line) => line.includes("BASELINED 040_email_verification.sql")), true);
});

test("existing older deployments fail closed instead of replaying historical migrations", async () => {
  const migration = {
    filename: "040_email_verification.sql",
    sql: "dangerous historical SQL"
  };
  const fake = makeFakeClient({
    existingDatabase: true,
    emailVerificationApplied: false,
    latestBaselineApplied: false
  });

  await assert.rejects(() => runMigrations(fake.client, [migration]), /cannot be safely baselined/);
  assert.deepEqual(fake.executedSql, []);
  assert.equal(fake.applied.size, 0);
});

test("failed transactional migrations roll back and are not recorded", async () => {
  const migration = { filename: "048_failure.sql", sql: "broken SQL" };
  const fake = makeFakeClient({ failSql: migration.sql });
  const output = makeLogger();

  await assert.rejects(
    () => runMigrations(fake.client, [migration], output.logger),
    /Migration failed: 048_failure.sql/
  );

  assert.equal(fake.applied.has(migration.filename), false);
  assert.equal(fake.commands.includes("rollback"), true);
  assert.equal(output.errors.some((line) => line.includes("FAILED 048_failure.sql")), true);
});

test("future migrations run after a legacy baseline", async () => {
  const futureMigration = { filename: "048_new_change.sql", sql: "create table new_change()" };
  const migrations = [
    ...LEGACY_BASELINE_MIGRATIONS.map((filename) => ({ filename, sql: `historical ${filename}` })),
    futureMigration
  ];
  const fake = makeFakeClient({
    existingDatabase: true,
    emailVerificationApplied: true,
    latestBaselineApplied: true
  });

  await runMigrations(fake.client, migrations);

  assert.deepEqual(fake.executedSql, [futureMigration.sql]);
  assert.equal(fake.applied.has(futureMigration.filename), true);
});
