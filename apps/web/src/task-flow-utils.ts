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
  delayDays: number;
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

function taskLabel(node: Pick<FlowNodeDraft, "nodeKey" | "label">) {
  return node.label.trim() || node.nodeKey;
}

function isSeedTask(node: Pick<FlowNodeDraft, "taskType">) {
  return node.taskType === "seed_in_tray" || node.taskType === "direct_seed";
}

function isCoreCropTask(node: Pick<FlowNodeDraft, "taskType">) {
  return isSeedTask(node) || node.taskType === "transplant" || node.taskType === "cultivation";
}

function taskRelativeDays(nodes: FlowNodeDraft[], edges: FlowEdgeDraft[]) {
  const nodesByKey = new Map(nodes.map((node) => [node.nodeKey, node]));
  const incomingEdgesByKey = new Map(nodes.map((node) => [node.nodeKey, [] as FlowEdgeDraft[]]));
  for (const edge of edges) {
    incomingEdgesByKey.get(edge.toNodeKey)?.push(edge);
  }
  const dayByKey = new Map<string, number>();
  const visiting = new Set<string>();

  function resolveDay(node: FlowNodeDraft): number {
    const existing = dayByKey.get(node.nodeKey);
    if (existing != null) {
      return existing;
    }
    if (visiting.has(node.nodeKey)) {
      throw new Error("Task flow schedule problem: task scheduling contains a dependency loop.");
    }

    visiting.add(node.nodeKey);
    const incomingEdges = incomingEdgesByKey.get(node.nodeKey) ?? [];
    if (incomingEdges.length === 0) {
      dayByKey.set(node.nodeKey, 0);
      visiting.delete(node.nodeKey);
      return 0;
    }

    const sourceDays = incomingEdges.map((edge) => {
      const sourceNode = nodesByKey.get(edge.fromNodeKey);
      if (!sourceNode) {
        throw new Error(`Task flow schedule problem: "${taskLabel(node)}" is scheduled after a missing task. Reconnect its arrows before saving.`);
      }
      return resolveDay(sourceNode) + edge.delayDays;
    });
    const day = Math.max(...sourceDays);
    dayByKey.set(node.nodeKey, day);
    visiting.delete(node.nodeKey);
    return day;
  }

  for (const node of nodes) {
    resolveDay(node);
  }
  return dayByKey;
}

export function taskFlowScheduleProblem(nodes: FlowNodeDraft[], edges: FlowEdgeDraft[]) {
  const dayByKey = taskRelativeDays(nodes, edges);
  const seedTasks = nodes.filter(isSeedTask);
  const transplantTasks = nodes.filter((node) => node.taskType === "transplant");

  for (const seedTask of seedTasks) {
    const seedDay = dayByKey.get(seedTask.nodeKey);
    for (const transplantTask of transplantTasks) {
      const transplantDay = dayByKey.get(transplantTask.nodeKey);
      if (seedDay != null && transplantDay != null && seedDay > transplantDay) {
        return {
          nodeKey: seedTask.nodeKey,
          message: `Task flow schedule problem: "${taskLabel(seedTask)}" is scheduled after "${taskLabel(transplantTask)}". Move the seeding task earlier, or reconnect the arrows before saving.`
        };
      }
    }
  }

  const coreCropTasks = nodes.filter(isCoreCropTask);
  const cleanupTasks = nodes.filter((node) => node.taskType === "cleanup");
  for (const cleanupTask of cleanupTasks) {
    const cleanupDay = dayByKey.get(cleanupTask.nodeKey);
    if (cleanupDay == null) {
      continue;
    }
    const laterCoreTask = coreCropTasks.find((node) => {
      const coreDay = dayByKey.get(node.nodeKey);
      return coreDay != null && cleanupDay < coreDay;
    });
    if (laterCoreTask) {
      return {
        nodeKey: cleanupTask.nodeKey,
        message: `Task flow schedule problem: "${taskLabel(cleanupTask)}" is scheduled before "${taskLabel(laterCoreTask)}". Cleanup should come after crop work; use bed making or tillage for prep work before planting.`
      };
    }
  }

  return null;
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
