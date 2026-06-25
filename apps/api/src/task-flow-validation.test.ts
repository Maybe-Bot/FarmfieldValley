import test from "node:test";
import assert from "node:assert/strict";
import { taskFlowScheduleProblem, validateTaskFlowGraph } from "./task-flow-validation";

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

test("validateTaskFlowGraph rejects cycles before import or save writes the flow", () => {
  assert.throws(() => validateTaskFlowGraph([
    { nodeKey: "seed", label: "Seed trays" },
    { nodeKey: "transplant", label: "Transplant" }
  ], [
    { fromNodeKey: "seed", toNodeKey: "transplant" },
    { fromNodeKey: "transplant", toNodeKey: "seed" }
  ]), /dependencies cannot contain a loop/);
});

test("validateTaskFlowGraph rejects blank labels and disconnected nodes", () => {
  assert.throws(() => validateTaskFlowGraph([
    { nodeKey: "seed", label: " " }
  ], []), /needs a label/);

  assert.throws(() => validateTaskFlowGraph([
    { nodeKey: "seed", label: "Seed trays" },
    { nodeKey: "transplant", label: "Transplant" },
    { nodeKey: "cleanup", label: "Cleanup" }
  ], [
    { fromNodeKey: "seed", toNodeKey: "transplant" }
  ]), /Cleanup.*disconnected/);

  assert.throws(() => validateTaskFlowGraph([
    { nodeKey: "seed", label: "Seed trays" },
    { nodeKey: "transplant", label: "Transplant" },
    { nodeKey: "wash", label: "Wash totes" },
    { nodeKey: "pack", label: "Pack totes" }
  ], [
    { fromNodeKey: "seed", toNodeKey: "transplant" },
    { fromNodeKey: "wash", toNodeKey: "pack" }
  ]), /Wash totes.*disconnected/);
});
