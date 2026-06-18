import test from "node:test";
import assert from "node:assert/strict";
import { taskFlowScheduleProblem } from "./task-flow-validation";

const baseNode = {
  iconColor: "#111111",
  iconSecondaryColor: "#f4c430"
};

test("taskFlowScheduleProblem allows normal transplant sequence", () => {
  const problem = taskFlowScheduleProblem([
    { ...baseNode, nodeKey: "seed", taskType: "seed_in_tray", label: "Seed trays" },
    { ...baseNode, nodeKey: "transplant", taskType: "transplant", label: "Transplant" },
    { ...baseNode, nodeKey: "cleanup", taskType: "cleanup", label: "Cleanup" }
  ], [
    { fromNodeKey: "seed", toNodeKey: "transplant", delayDays: 28 },
    { fromNodeKey: "transplant", toNodeKey: "cleanup", delayDays: 60 }
  ]);

  assert.equal(problem, null);
});

test("taskFlowScheduleProblem catches seeding after transplant", () => {
  const problem = taskFlowScheduleProblem([
    { ...baseNode, nodeKey: "transplant", taskType: "transplant", label: "Transplant" },
    { ...baseNode, nodeKey: "seed", taskType: "seed_in_tray", label: "Seed trays" }
  ], [
    { fromNodeKey: "transplant", toNodeKey: "seed", delayDays: 1 }
  ]);

  assert.match(problem ?? "", /Seed trays.*after.*Transplant/);
});

test("taskFlowScheduleProblem catches cleanup before crop work", () => {
  const problem = taskFlowScheduleProblem([
    { ...baseNode, nodeKey: "cleanup", taskType: "cleanup", label: "Cleanup" },
    { ...baseNode, nodeKey: "seed", taskType: "direct_seed", label: "Direct seed" }
  ], [{ fromNodeKey: "cleanup", toNodeKey: "seed", delayDays: 7 }]);

  assert.match(problem ?? "", /Cleanup.*before.*Direct seed/);
});
