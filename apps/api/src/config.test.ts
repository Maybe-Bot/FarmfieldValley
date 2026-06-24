import test from "node:test";
import assert from "node:assert/strict";
import { parseSessionMaxAgeDays } from "./config";

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
