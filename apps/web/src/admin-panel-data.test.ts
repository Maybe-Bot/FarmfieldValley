import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAdminUsers, normalizeFeedbackReports, normalizeUsageEventsResponse } from "./admin-panel-data";

test("normalizeAdminUsers keeps the admin table renderable when memberships is not an array", () => {
  const users = normalizeAdminUsers([
    {
      id: 1,
      username: "admin",
      displayName: null,
      isActive: true,
      isAdmin: true,
      createdAt: "2026-06-25T12:00:00.000Z",
      lastSessionAt: null,
      feedbackCount: "3",
      memberships: { farmId: 1, farmName: "Farm", role: "planner" }
    }
  ]);

  assert.equal(users.length, 1);
  assert.deepEqual(users[0].memberships, []);
});

test("normalizeAdminUsers parses JSON membership arrays from database drivers", () => {
  const users = normalizeAdminUsers([
    {
      id: 1,
      username: "admin",
      createdAt: "2026-06-25T12:00:00.000Z",
      memberships: JSON.stringify([{ farmId: 2, farmName: "North Farm", role: "planner" }])
    }
  ]);

  assert.deepEqual(users[0].memberships, [{ farmId: 2, farmName: "North Farm", role: "planner" }]);
});

test("normalizeUsageEventsResponse defaults non-array event payloads", () => {
  const result = normalizeUsageEventsResponse({ events: { id: 1 }, retentionDays: "30" });

  assert.deepEqual(result, { events: [], retentionDays: 30 });
});

test("normalizeFeedbackReports defaults bad report payloads to an empty list", () => {
  assert.deepEqual(normalizeFeedbackReports({ reports: [] }), []);
});
