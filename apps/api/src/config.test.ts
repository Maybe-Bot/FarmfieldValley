import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseSessionMaxAgeDays } from "./config";

const repoRoot = path.resolve(__dirname, "../../..");

function productionEnv(overrides: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    NODE_ENV: "production",
    CSRF_SECRET: "test-csrf-secret",
    REQUIRE_EMAIL_VERIFICATION: "true",
    DATABASE_URL: "postgres://loam_ledger:loam_ledger@localhost:5432/loam_ledger",
    CORS_ALLOWED_ORIGINS: "https://loamledger.org",
    PUBLIC_WEB_URL: "https://loamledger.org",
    PUBLIC_API_URL: "https://api.loamledger.org",
    EMAIL_DELIVERY_MODE: "resend",
    RESEND_API_KEY: "test-resend-key",
    EMAIL_FROM: "Loam Ledger <accounts@loamledger.org>",
    SELF_HOSTED_NO_EMAIL: "false",
    ...overrides
  };
}

function importConfigWithEnv(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", "tsx", "-e", "await import('./apps/api/src/config.ts')"], {
    cwd: repoRoot,
    env,
    encoding: "utf8"
  });
}

test("invalid session max-age config falls back to the default", () => {
  assert.equal(parseSessionMaxAgeDays("not-a-number"), 14);
  assert.equal(parseSessionMaxAgeDays("2.5"), 14);
  assert.equal(parseSessionMaxAgeDays(undefined), 14);
});

test("session max-age config is bounded to a safe integer range", () => {
  assert.equal(parseSessionMaxAgeDays("0"), 1);
  assert.equal(parseSessionMaxAgeDays("-5"), 1);
  assert.equal(parseSessionMaxAgeDays("3650"), 90);
});

test("production allows explicit self-hosted console email mode without Resend", () => {
  const result = importConfigWithEnv(productionEnv({
    EMAIL_DELIVERY_MODE: "console",
    SELF_HOSTED_NO_EMAIL: "true",
    RESEND_API_KEY: "",
    EMAIL_FROM: ""
  }));

  assert.equal(result.status, 0, result.stderr);
});

test("production rejects development email mode", () => {
  const result = importConfigWithEnv(productionEnv({
    EMAIL_DELIVERY_MODE: "development"
  }));

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /EMAIL_DELIVERY_MODE=development cannot be used/);
});

test("production console email mode must be explicitly acknowledged as self-hosted", () => {
  const result = importConfigWithEnv(productionEnv({
    EMAIL_DELIVERY_MODE: "console",
    SELF_HOSTED_NO_EMAIL: "false"
  }));

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /SELF_HOSTED_NO_EMAIL=true is required/);
});
