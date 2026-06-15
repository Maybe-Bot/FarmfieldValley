import { taskIconColor } from "./task-display";
import { tractorModelForTask } from "./tractor-icons";

export type FlowNodeDraft = {
  nodeKey: string;
  taskType: string;
  label: string;
  anchor: string;
  offsetDays: number;
  iconColor: string;
  iconSecondaryColor: string;
  tractorModel: string | null;
  tractorProfileId: number | null;
  x: number;
  y: number;
  notes: string;
};

export type FlowEdgeDraft = {
  fromNodeKey: string;
  toNodeKey: string;
};

// The flow editor prevents dependency loops because a task cannot depend on
// itself through a chain of other tasks.
export function taskFlowHasCycle(
  nodes: Array<{ nodeKey: string }>,
  edges: Array<{ fromNodeKey: string; toNodeKey: string }>
) {
  const nodeKeys = new Set(nodes.map((node) => node.nodeKey));
  const downstreamByNode = new Map<string, string[]>();
  for (const nodeKey of nodeKeys) {
    downstreamByNode.set(nodeKey, []);
  }
  for (const edge of edges) {
    downstreamByNode.get(edge.fromNodeKey)?.push(edge.toNodeKey);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeKey: string): boolean => {
    if (visiting.has(nodeKey)) return true;
    if (visited.has(nodeKey)) return false;
    visiting.add(nodeKey);
    for (const downstreamNodeKey of downstreamByNode.get(nodeKey) ?? []) {
      if (visit(downstreamNodeKey)) return true;
    }
    visiting.delete(nodeKey);
    visited.add(nodeKey);
    return false;
  };

  for (const nodeKey of nodeKeys) {
    if (visit(nodeKey)) return true;
  }
  return false;
}

// Creates a new visual task-flow node at a reasonable canvas position.
export function newTaskFlowNode(index: number) {
  const columns = 3;
  const row = Math.floor(index / columns);
  const column = index % columns;

  return {
    nodeKey: `node_${Date.now()}_${index}`,
    taskType: "bed_making",
    label: `Task ${index + 1}`,
    anchor: "planned_sow",
    offsetDays: 0,
    iconColor: taskIconColor("bed_making"),
    iconSecondaryColor: "#f4c430",
    tractorModel: tractorModelForTask("bed_making"),
    tractorProfileId: null,
    x: Math.min(0.14 + column * 0.28, 0.9),
    y: Math.min(0.2 + row * 0.28, 0.86),
    notes: ""
  };
}

export function clampFlowCoordinate(value: number) {
  return Math.max(0.06, Math.min(0.94, value));
}
