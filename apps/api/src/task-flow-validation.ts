type TaskFlowSequenceNode = {
  nodeKey: string;
  taskType: string;
  label: string;
};

type TaskFlowSequenceEdge = {
  fromNodeKey: string;
  toNodeKey: string;
  delayDays: number;
};

function taskLabel(node: TaskFlowSequenceNode) {
  return node.label.trim() || node.nodeKey;
}

function isSeedTask(node: TaskFlowSequenceNode) {
  return node.taskType === "seed_in_tray" || node.taskType === "direct_seed";
}

function isCoreCropTask(node: TaskFlowSequenceNode) {
  return isSeedTask(node) || node.taskType === "transplant" || node.taskType === "cultivation";
}

function taskRelativeDays(nodes: TaskFlowSequenceNode[], edges: TaskFlowSequenceEdge[]) {
  const nodesByKey = new Map(nodes.map((node) => [node.nodeKey, node]));
  const incomingEdgesByKey = new Map(nodes.map((node) => [node.nodeKey, [] as TaskFlowSequenceEdge[]]));
  for (const edge of edges) {
    incomingEdgesByKey.get(edge.toNodeKey)?.push(edge);
  }
  const dayByKey = new Map<string, number>();
  const visiting = new Set<string>();

  function resolveDay(node: TaskFlowSequenceNode): number {
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

export function taskFlowScheduleProblem(nodes: TaskFlowSequenceNode[], edges: TaskFlowSequenceEdge[]) {
  const dayByKey = taskRelativeDays(nodes, edges);
  const seedTasks = nodes.filter(isSeedTask);
  const transplantTasks = nodes.filter((node) => node.taskType === "transplant");

  for (const seedTask of seedTasks) {
    const seedDay = dayByKey.get(seedTask.nodeKey);
    for (const transplantTask of transplantTasks) {
      const transplantDay = dayByKey.get(transplantTask.nodeKey);
      if (seedDay != null && transplantDay != null && seedDay > transplantDay) {
        return `Task flow schedule problem: "${taskLabel(seedTask)}" is scheduled after "${taskLabel(transplantTask)}". Move the seeding task earlier, or reconnect the arrows before saving.`;
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
      return `Task flow schedule problem: "${taskLabel(cleanupTask)}" is scheduled before "${taskLabel(laterCoreTask)}". Cleanup should come after crop work; use bed making or tillage for prep work before planting.`;
    }
  }

  return null;
}
