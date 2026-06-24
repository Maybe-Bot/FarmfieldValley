import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeUsageEvent } from "./usage-privacy";

test("usage events keep only coarse allow-listed data", () => {
  assert.deepEqual(
    sanitizeUsageEvent({
      eventType: "page_leave",
      page: "seed-bank",
      durationSeconds: 78
    }),
    {
      eventType: "page_leave",
      page: "seed-bank",
      durationBucket: "1_to_4_minutes",
      details: {}
    }
  );
});

test("usage events reject identifiers and raw paths", () => {
  assert.throws(() => sanitizeUsageEvent({
    eventType: "page_view",
    page: "/farms/42",
    userId: 42
  }));
});

test("usage events reject arbitrary event types", () => {
  assert.throws(() => sanitizeUsageEvent({ eventType: "frontend_error", page: "map" }));
});
