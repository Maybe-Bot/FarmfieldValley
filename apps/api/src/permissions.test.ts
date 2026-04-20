import test from "node:test";
import assert from "node:assert/strict";
import { roleMeetsRequirement } from "./permissions";

test("roleMeetsRequirement lets planners plan and workers only record work", () => {
  assert.equal(roleMeetsRequirement(null, "worker"), false);
  assert.equal(roleMeetsRequirement({ role: "worker" }, "worker"), true);
  assert.equal(roleMeetsRequirement({ role: "worker" }, "planner"), false);
  assert.equal(roleMeetsRequirement({ role: "planner" }, "worker"), true);
  assert.equal(roleMeetsRequirement({ role: "planner" }, "planner"), true);
});
