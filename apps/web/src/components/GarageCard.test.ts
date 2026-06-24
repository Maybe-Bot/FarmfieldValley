import test from "node:test";
import assert from "node:assert/strict";
import { removeSavedTractorProfile, upsertSavedTractorProfile } from "../tractor-profiles";
import type { TractorProfile } from "../types";

function profile(patch: Partial<TractorProfile> & Pick<TractorProfile, "id" | "name">): TractorProfile {
  return {
    farmId: 1,
    tractorModel: "cab",
    iconColor: "#111111",
    iconSecondaryColor: "#eeeeee",
    ...patch
  };
}

test("upsertSavedTractorProfile appends new garage vehicles for shared task-flow options", () => {
  const existing = [profile({ id: 1, name: "Red tractor" })];
  const saved = profile({ id: 2, name: "Blue pickup", tractorModel: "pickup" });

  const next = upsertSavedTractorProfile(existing, saved);

  assert.deepEqual(next.map((item) => item.name), ["Red tractor", "Blue pickup"]);
});

test("upsertSavedTractorProfile replaces edited garage vehicles in place", () => {
  const existing = [
    profile({ id: 1, name: "Red tractor" }),
    profile({ id: 2, name: "Blue pickup", tractorModel: "pickup" })
  ];
  const saved = profile({ id: 2, name: "Blue pickup updated", tractorModel: "box" });

  const next = upsertSavedTractorProfile(existing, saved);

  assert.deepEqual(next.map((item) => item.name), ["Red tractor", "Blue pickup updated"]);
  assert.equal(next[1].tractorModel, "box");
});

test("removeSavedTractorProfile removes deleted garage vehicles from shared options", () => {
  const existing = [
    profile({ id: 1, name: "Red tractor" }),
    profile({ id: 2, name: "Blue pickup" })
  ];

  const next = removeSavedTractorProfile(existing, 1);

  assert.deepEqual(next.map((item) => item.id), [2]);
});
