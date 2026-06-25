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

export function validateTaskFlowGraph(
  nodes: Array<{ nodeKey: string; label: string }>,
  edges: Array<{ fromNodeKey: string; toNodeKey: string }>
) {
  const nodeKeys = new Set(nodes.map((node) => node.nodeKey));
  if (nodeKeys.size !== nodes.length) {
    throw new Error("Task flow node keys must be unique");
  }
  const emptyLabelNode = nodes.find((node) => !node.label.trim());
  if (emptyLabelNode) {
    throw new Error(`Task flow node "${emptyLabelNode.nodeKey}" needs a label before saving.`);
  }

  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    if (!nodeKeys.has(edge.fromNodeKey) || !nodeKeys.has(edge.toNodeKey)) {
      throw new Error("Task flow edge references a missing node");
    }
    if (edge.fromNodeKey === edge.toNodeKey) {
      throw new Error("Task flow edge cannot point to the same node");
    }
    const edgeKey = `${edge.fromNodeKey}->${edge.toNodeKey}`;
    if (edgeKeys.has(edgeKey)) {
      throw new Error("Task flow edges must be unique");
    }
    edgeKeys.add(edgeKey);
  }

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
    if (visiting.has(nodeKey)) {
      return true;
    }
    if (visited.has(nodeKey)) {
      return false;
    }

    visiting.add(nodeKey);
    for (const downstreamNodeKey of downstreamByNode.get(nodeKey) ?? []) {
      if (visit(downstreamNodeKey)) {
        return true;
      }
    }
    visiting.delete(nodeKey);
    visited.add(nodeKey);
    return false;
  };

  for (const nodeKey of nodeKeys) {
    if (visit(nodeKey)) {
      throw new Error("Task flow dependencies cannot contain a loop");
    }
  }

  if (nodes.length > 1) {
    const adjacentNodeKeys = new Map<string, string[]>();
    for (const nodeKey of nodeKeys) {
      adjacentNodeKeys.set(nodeKey, []);
    }
    for (const edge of edges) {
      adjacentNodeKeys.get(edge.fromNodeKey)?.push(edge.toNodeKey);
      adjacentNodeKeys.get(edge.toNodeKey)?.push(edge.fromNodeKey);
    }
    const connected = new Set<string>();
    const queue = [nodes[0].nodeKey];
    while (queue.length > 0) {
      const nodeKey = queue.shift() as string;
      if (connected.has(nodeKey)) continue;
      connected.add(nodeKey);
      queue.push(...(adjacentNodeKeys.get(nodeKey) ?? []));
    }
    if (connected.size !== nodes.length) {
      const disconnected = nodes.find((node) => !connected.has(node.nodeKey));
      throw new Error(`Task flow node "${disconnected?.label.trim() ?? "unknown"}" is disconnected. Connect every task into one flow or remove the disconnected task before saving.`);
    }
  }
}

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
