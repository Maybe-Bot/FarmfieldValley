import test from "node:test";
import assert from "node:assert/strict";
import { ingestUsageEventForUser, UsageEventIngestionStore } from "./routes/usage-events";

function makeStore(enabled: boolean, rateLimitAllowed = true) {
  const calls: string[] = [];
  const recorded: unknown[] = [];
  const store: UsageEventIngestionStore = {
    async isUsageTrackingEnabled() {
      calls.push("preference");
      return enabled;
    },
    async consumeUsageRateLimit() {
      calls.push("rate-limit");
      return rateLimitAllowed;
    },
    async pruneUsageData() {
      calls.push("prune");
    },
    async recordUsageEvent(event) {
      calls.push("record");
      recorded.push(event);
    }
  };

  return { store, calls, recorded };
}

test("opted-in usage tracking consumes quota and records sanitized events", async () => {
  const fake = makeStore(true);

  const result = await ingestUsageEventForUser(
    12,
    { eventType: "feature_used", page: "map", feature: "bed-generator", durationSeconds: 75 },
    fake.store
  );

  assert.deepEqual(result, { ok: true, recorded: true, rateLimited: false });
  assert.deepEqual(fake.calls, ["preference", "rate-limit", "prune", "record"]);
  assert.deepEqual(fake.recorded, [
    {
      eventType: "feature_used",
      page: "map",
      durationBucket: "1_to_4_minutes",
      details: { feature: "bed-generator" }
    }
  ]);
});

test("opted-out usage tracking short-circuits before quota or storage", async () => {
  const fake = makeStore(false);

  const result = await ingestUsageEventForUser(
    12,
    { eventType: "not-allowed", page: "/raw/path-that-would-fail-validation" },
    fake.store
  );

  assert.deepEqual(result, { ok: true, recorded: false, rateLimited: false });
  assert.deepEqual(fake.calls, ["preference"]);
  assert.deepEqual(fake.recorded, []);
});
