import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { TaskIconMark } from "./TaskIconMark";
import {
  formatTaskAnchorLabel,
  formatTaskTypeLabel,
  isCurrentTaskType,
  taskIconColor,
  taskTypeOptions,
  staleTaskTypeMessage
} from "../task-display";
import {
  clampFlowCoordinate,
  FlowEdgeDraft,
  FlowNodeDraft,
  newTaskFlowNode,
  taskFlowHasCycle,
  taskFlowScheduleProblem
} from "../task-flow-utils";
import { isTractorTask, tractorModelForTask } from "../tractor-icons";
import { TaskFlowEdge, TaskFlowNode, TaskFlowTemplate, TractorProfile } from "../types";
import { vehicleModelForTask } from "../vehicle-icons";

const FLOW_CANVAS_SIZE_STORAGE_KEY = "loam-ledger-task-flow-canvas-size";
const flowCanvasSizeOptions = [
  { value: "small", label: "Small" },
  { value: "normal", label: "Normal" },
  { value: "tall", label: "Tall" },
  { value: "huge", label: "Huge" }
] as const;
type FlowCanvasSize = (typeof flowCanvasSizeOptions)[number]["value"];

function readInitialFlowCanvasSize(): FlowCanvasSize {
  if (typeof window === "undefined") {
    return "normal";
  }

  try {
    const savedSize = window.localStorage.getItem(FLOW_CANVAS_SIZE_STORAGE_KEY);
    return flowCanvasSizeOptions.some((option) => option.value === savedSize)
      ? savedSize as FlowCanvasSize
      : "normal";
  } catch {
    return "normal";
  }
}

function afterNodeKeys(anchor: string) {
  if (!anchor.startsWith("after:")) {
    return [];
  }

  return anchor
    .slice("after:".length)
    .split(",")
    .map((nodeKey) => nodeKey.trim())
    .filter(Boolean);
}

function afterAnchor(nodeKeys: string[]) {
  return `after:${Array.from(new Set(nodeKeys)).join(",")}`;
}

function edgeKey(edge: Pick<FlowEdgeDraft, "fromNodeKey" | "toNodeKey">) {
  return `${edge.fromNodeKey}->${edge.toNodeKey}`;
}

function nodesWithEdgeAnchors(nodes: FlowNodeDraft[], edges: FlowEdgeDraft[]) {
  return nodes.map((node) => {
    const incomingNodeKeys = edges
      .filter((edge) => edge.toNodeKey === node.nodeKey)
      .map((edge) => edge.fromNodeKey);
    return {
      ...node,
      anchor: incomingNodeKeys.length > 0 ? afterAnchor(incomingNodeKeys) : "planned_sow",
      offsetDays: 0
    };
  });
}

function uniqueTaskTypeOptions(options: string[]) {
  return Array.from(new Set(options.filter(Boolean)));
}

// Visual editor for one task-flow template. It stays separated from App.tsx because
// it has its own graph state, drag handling, dependency validation, and save payload.
export function TaskFlowEditorCard({
  farmId,
  crops,
  template,
  nodes,
  edges,
  tractorProfiles,
  tutorialActive = false,
  onSaved
}: {
  farmId: number | null;
  crops: Array<{ id: number; name: string }>;
  template: TaskFlowTemplate | null;
  nodes: TaskFlowNode[];
  edges: TaskFlowEdge[];
  tractorProfiles: TractorProfile[];
  tutorialActive?: boolean;
  onSaved: (taskFlowId: number) => Promise<void>;
}) {
  function defaultModelForTask(taskType: string) {
    return isTractorTask(taskType) ? tractorModelForTask(taskType) : vehicleModelForTask(taskType);
  }

  function defaultProfileForTask(taskType: string) {
    const model = defaultModelForTask(taskType);
    return tractorProfiles.find((profile) => profile.tractorModel === model) ?? tractorProfiles[0] ?? null;
  }

  const initialNodes = nodes.length > 0
    ? nodes.map((node) => ({
        nodeKey: node.nodeKey,
        taskType: node.taskType,
        label: node.label,
        anchor: node.anchor,
        offsetDays: 0,
        iconColor: node.iconColor ?? taskIconColor(node.taskType),
        iconSecondaryColor: node.iconSecondaryColor ?? "#f4c430",
        tractorModel: node.tractorModel ?? defaultModelForTask(node.taskType),
        tractorProfileId: node.tractorProfileId ?? null,
        x: Number(node.x),
        y: Number(node.y),
        notes: node.notes ?? ""
      }))
    : [
        { ...newTaskFlowNode(0), nodeKey: "shape_beds", label: "Shape beds", taskType: "bed_making", iconColor: defaultProfileForTask("bed_making")?.iconColor ?? taskIconColor("bed_making"), iconSecondaryColor: defaultProfileForTask("bed_making")?.iconSecondaryColor ?? "#f4c430", tractorModel: defaultProfileForTask("bed_making")?.tractorModel ?? defaultModelForTask("bed_making"), tractorProfileId: defaultProfileForTask("bed_making")?.id ?? null },
        { ...newTaskFlowNode(1), nodeKey: "transplant", label: "Transplant", taskType: "transplant", iconColor: defaultProfileForTask("transplant")?.iconColor ?? taskIconColor("transplant"), iconSecondaryColor: defaultProfileForTask("transplant")?.iconSecondaryColor ?? "#f4c430", tractorModel: defaultProfileForTask("transplant")?.tractorModel ?? defaultModelForTask("transplant"), tractorProfileId: defaultProfileForTask("transplant")?.id ?? null, anchor: "after:shape_beds" },
        { ...newTaskFlowNode(2), nodeKey: "cultivation", label: "Cultivate", taskType: "cultivation", iconColor: defaultProfileForTask("cultivation")?.iconColor ?? taskIconColor("cultivation"), iconSecondaryColor: defaultProfileForTask("cultivation")?.iconSecondaryColor ?? "#f4c430", tractorModel: defaultProfileForTask("cultivation")?.tractorModel ?? defaultModelForTask("cultivation"), tractorProfileId: defaultProfileForTask("cultivation")?.id ?? null, anchor: "after:transplant" }
      ];
  const initialEdges = edges.length > 0
    ? edges.map((edge) => ({
        fromNodeKey: edge.fromNodeKey,
        toNodeKey: edge.toNodeKey,
        delayDays: Math.max(0, Math.min(9999, edge.delayDays ?? nodes.find((node) => node.nodeKey === edge.toNodeKey)?.offsetDays ?? 0))
      }))
    : [
        { fromNodeKey: initialNodes[0].nodeKey, toNodeKey: initialNodes[1].nodeKey, delayDays: 5 },
        { fromNodeKey: initialNodes[1].nodeKey, toNodeKey: initialNodes[2].nodeKey, delayDays: 7 }
      ];

  const [name, setName] = useState(template?.name ?? "");
  const [cropId, setCropId] = useState(template?.cropId != null ? String(template.cropId) : "");
  const [notes, setNotes] = useState(template?.notes ?? "");
  const [isDefault, setIsDefault] = useState(template?.isDefault ?? !template);
  const [localNodes, setLocalNodes] = useState<FlowNodeDraft[]>(() => nodesWithEdgeAnchors(initialNodes, initialEdges));
  const [localEdges, setLocalEdges] = useState<FlowEdgeDraft[]>(initialEdges);
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(initialNodes[0]?.nodeKey ?? null);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);
  const [edgeReconnectDraft, setEdgeReconnectDraft] = useState<{
    edgeKey: string;
    end: "from" | "to";
    pointerX: number;
    pointerY: number;
  } | null>(null);
  const [openNodeMenuKey, setOpenNodeMenuKey] = useState<string | null>(null);
  const [openNodeEditorKey, setOpenNodeEditorKey] = useState<string | null>(null);
  const [connectionDraft, setConnectionDraft] = useState<{ sourceNodeKey: string; direction: "upstream" | "downstream" } | null>(null);
  const [editNodeSnapshots, setEditNodeSnapshots] = useState<Record<string, FlowNodeDraft>>({});
  const [tutorialAddedNodeKey, setTutorialAddedNodeKey] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragNodeKey, setDragNodeKey] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState<FlowCanvasSize>(() => readInitialFlowCanvasSize());
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const selectedNode = localNodes.find((node) => node.nodeKey === selectedNodeKey) ?? null;
    const nodeMap = useMemo(() => new Map(localNodes.map((node) => [node.nodeKey, node])), [localNodes]);
    const openNodeMenuNode = openNodeMenuKey ? nodeMap.get(openNodeMenuKey) ?? null : null;
    const incomingNodeKeysByNode = useMemo(() => {
      const next = new Map(localNodes.map((node) => [node.nodeKey, [] as string[]]));
      for (const edge of localEdges) {
        next.get(edge.toNodeKey)?.push(edge.fromNodeKey);
      }
      return next;
    }, [localEdges, localNodes]);
    const tutorialCleanupSourceNode = localNodes.find((node) => node.nodeKey === "cleanup") ?? localNodes.find((node) => node.taskType === "cleanup") ?? null;
  const tutorialExistingExtraCleanupNode = localNodes.find((node) => node.taskType === "cleanup" && node.nodeKey !== tutorialCleanupSourceNode?.nodeKey) ?? null;
  const tutorialAddedNode = tutorialAddedNodeKey ? nodeMap.get(tutorialAddedNodeKey) ?? null : null;
  const tutorialTargetNode = tutorialAddedNode ?? tutorialExistingExtraCleanupNode;
  const tutorialCleanupNode = tutorialTargetNode?.taskType === "cleanup" ? tutorialTargetNode : null;
  const tutorialCleanupLinkedAfterCleanup = Boolean(tutorialCleanupSourceNode && tutorialCleanupNode && localEdges.some((edge) =>
    edge.fromNodeKey === tutorialCleanupSourceNode.nodeKey && edge.toNodeKey === tutorialCleanupNode.nodeKey
  ));
  const tutorialHighlightAddNode = tutorialActive && !tutorialTargetNode;
    const tutorialHighlightMowEdit = tutorialActive
      && tutorialTargetNode != null
      && tutorialTargetNode.taskType !== "cleanup"
      && openNodeEditorKey !== tutorialTargetNode.nodeKey;
  const tutorialHighlightTaskType = tutorialActive
    && tutorialTargetNode != null
    && openNodeEditorKey === tutorialTargetNode.nodeKey
    && tutorialTargetNode.taskType !== "cleanup";
    const tutorialHighlightAnchor = tutorialActive
      && tutorialTargetNode != null
      && openNodeEditorKey === tutorialTargetNode.nodeKey
      && tutorialTargetNode.taskType === "cleanup"
      && false;
    const tutorialReadyToLinkMow = tutorialActive
      && tutorialCleanupSourceNode != null
      && tutorialCleanupNode != null
      && !tutorialCleanupLinkedAfterCleanup;
  const tutorialHighlightHarvestLink = tutorialReadyToLinkMow
    && !connectionDraft
    && openNodeMenuKey !== tutorialCleanupSourceNode?.nodeKey;
  const tutorialHighlightHarvestDownstream = tutorialReadyToLinkMow
    && !connectionDraft
    && openNodeMenuKey === tutorialCleanupSourceNode?.nodeKey;
  const tutorialHighlightMowNodeClick = tutorialReadyToLinkMow
    && connectionDraft?.sourceNodeKey === tutorialCleanupSourceNode?.nodeKey
    && connectionDraft.direction === "downstream";
    const tutorialHighlightSaveFlow = tutorialActive
      && tutorialCleanupNode != null
      && tutorialCleanupLinkedAfterCleanup;
  const tutorialHint = tutorialHighlightAddNode
    ? "Click Add node to create the new cleanup task."
        : tutorialHighlightTaskType
          ? "Set Task type to Cleanup. The label will update so the node is easy to recognize."
        : tutorialHighlightAnchor
          ? "Use the Cleanup link to schedule this after the earlier cleanup task."
          : tutorialHighlightMowEdit
            ? "Open the new node's Edit controls to set the task type."
          : tutorialHighlightHarvestDownstream
              ? "Choose Add next task. That means the new cleanup task will happen after the earlier cleanup task."
            : tutorialHighlightMowNodeClick
              ? "Click the new Cleanup node to finish the link."
              : tutorialHighlightHarvestLink
                ? "Click Link on the Cleanup node. This is the step the new Cleanup should follow."
                : tutorialHighlightSaveFlow
                  ? "The new Cleanup task is linked. Click Save flow to keep the change."
                    : tutorialActive
                      ? "Add a Cleanup task after Cleanup, link them, then save the flow."
                    : null;

  useEffect(() => {
    try {
      window.localStorage.setItem(FLOW_CANVAS_SIZE_STORAGE_KEY, canvasSize);
    } catch {
      // The size control still works for the current page if storage is unavailable.
    }
  }, [canvasSize]);

  useEffect(() => {
    if (!dragNodeKey) {
      return;
    }

    function stopDrag() {
      setDragNodeKey(null);
    }

    function handleMove(event: MouseEvent) {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return;
      }

      const nextX = clampFlowCoordinate((event.clientX - rect.left) / rect.width);
      const nextY = clampFlowCoordinate((event.clientY - rect.top) / rect.height);
      setLocalNodes((current) =>
        current.map((node) => node.nodeKey === dragNodeKey ? { ...node, x: nextX, y: nextY } : node)
      );
    }

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", stopDrag);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", stopDrag);
    };
  }, [dragNodeKey]);

  useEffect(() => {
    if (!edgeReconnectDraft) {
      return;
    }

    function handleMove(event: MouseEvent) {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      setEdgeReconnectDraft((current) => current ? {
        ...current,
        pointerX: clampFlowCoordinate((event.clientX - rect.left) / rect.width),
        pointerY: clampFlowCoordinate((event.clientY - rect.top) / rect.height)
      } : null);
    }

    function handleUp(event: MouseEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest(".flow-node-card")) {
        return;
      }
      setEdgeReconnectDraft(null);
      setStatus("Connection end was not changed.");
    }

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [edgeReconnectDraft]);

  function updateNode(nodeKey: string, patch: Partial<FlowNodeDraft>) {
    setLocalNodes((current) => current.map((node) => node.nodeKey === nodeKey ? { ...node, ...patch } : node));
  }

  function floatingMenuStyle(node: FlowNodeDraft) {
    const leftOffset = node.x > 0.66 ? -34 : 8;
    const topOffset = node.y > 0.72 ? -24 : 8;
    const left = Math.max(2, Math.min(74, node.x * 100 + leftOffset));
    const top = Math.max(2, Math.min(82, node.y * 100 + topOffset));
    return { left: `${left}%`, top: `${top}%` };
  }

  function nodeCardStyle(node: FlowNodeDraft) {
    return {
      left: `${node.x * 100}%`,
      top: `${node.y * 100}%`
    };
  }

  function scheduleSourceLabel(node: FlowNodeDraft) {
    const sourceNodeKeys = afterNodeKeys(node.anchor);
    if (sourceNodeKeys.length > 0) {
      const sourceLabels = sourceNodeKeys.map((nodeKey) => nodeMap.get(nodeKey)?.label ?? nodeKey);
      return `after ${sourceLabels.join(", ")}`;
    }

    return formatTaskAnchorLabel(node.anchor);
  }

  function addNode() {
    setLocalNodes((current) => {
      const nextNode = newTaskFlowNode(current.length);
      setSelectedNodeKey(nextNode.nodeKey);
      setOpenNodeEditorKey(nextNode.nodeKey);
      setEditNodeSnapshots((snapshots) => ({ ...snapshots, [nextNode.nodeKey]: nextNode }));
      setTutorialAddedNodeKey(nextNode.nodeKey);
      return [...current, nextNode];
    });
  }

  function updateNodeTaskType(node: FlowNodeDraft, nextTaskType: string) {
    const defaultProfile = defaultProfileForTask(nextTaskType);
    updateNode(node.nodeKey, {
      taskType: nextTaskType,
      iconColor: defaultProfile?.iconColor ?? taskIconColor(nextTaskType),
      iconSecondaryColor: defaultProfile?.iconSecondaryColor ?? node.iconSecondaryColor,
      tractorModel: defaultProfile?.tractorModel ?? defaultModelForTask(nextTaskType),
      tractorProfileId: defaultProfile?.id ?? null,
      label: !node.label.trim() || /^Task \d+$/.test(node.label) || node.label === formatTaskTypeLabel(node.taskType)
        ? formatTaskTypeLabel(nextTaskType)
        : node.label
    });
  }

  function updateNodeTractorProfile(node: FlowNodeDraft, profileIdValue: string) {
    const profileId = profileIdValue ? Number(profileIdValue) : null;
    const profile = tractorProfiles.find((item) => item.id === profileId) ?? null;
    updateNode(node.nodeKey, {
      tractorProfileId: profile?.id ?? null,
      tractorModel: profile?.tractorModel ?? defaultModelForTask(node.taskType),
      iconColor: profile?.iconColor ?? node.iconColor,
      iconSecondaryColor: profile?.iconSecondaryColor ?? node.iconSecondaryColor
    });
  }

  function toggleNodeEditor(node: FlowNodeDraft) {
    if (openNodeEditorKey === node.nodeKey) {
      setOpenNodeEditorKey(null);
      setEditNodeSnapshots((current) => {
        const next = { ...current };
        delete next[node.nodeKey];
        return next;
      });
      return;
    }

    setSelectedEdgeKey(null);
    setSelectedNodeKey(node.nodeKey);
    setOpenNodeMenuKey(null);
    setConnectionDraft(null);
    setOpenNodeEditorKey(node.nodeKey);
    setEditNodeSnapshots((current) => ({ ...current, [node.nodeKey]: { ...node } }));
  }

  function cancelNodeEditor(nodeKey: string) {
    const snapshot = editNodeSnapshots[nodeKey];
    if (snapshot) {
      setLocalNodes((current) => current.map((node) => node.nodeKey === nodeKey ? snapshot : node));
    }
    setOpenNodeEditorKey(null);
    setEditNodeSnapshots((current) => {
      const next = { ...current };
      delete next[nodeKey];
      return next;
    });
  }

  function removeNode(nodeKey: string) {
    const remainingEdges = localEdges.filter(
      (edge) => edge.fromNodeKey !== nodeKey && edge.toNodeKey !== nodeKey
    );
    const remainingNodes = nodesWithEdgeAnchors(
      localNodes.filter((node) => node.nodeKey !== nodeKey),
      remainingEdges
    );
    setLocalNodes(remainingNodes);
    setLocalEdges(remainingEdges);
    setSelectedNodeKey(null);
    setOpenNodeMenuKey(null);
    setOpenNodeEditorKey(null);
    setConnectionDraft(null);
    setSelectedEdgeKey(null);
    setEdgeReconnectDraft(null);
    setEditNodeSnapshots((current) => {
      const next = { ...current };
      delete next[nodeKey];
      return next;
    });
    setStatus("Task removed. Save the flow to keep this change.");
  }

  function removeSelectedNode() {
    if (selectedEdgeKey) {
      const selectedEdge = localEdges.find((edge) => edgeKey(edge) === selectedEdgeKey);
      if (selectedEdge) {
        removeEdge(selectedEdge.fromNodeKey, selectedEdge.toNodeKey);
      }
      return;
    }

    if (!selectedNode) {
      return;
    }

    removeNode(selectedNode.nodeKey);
  }

  function replaceEdges(nextEdges: FlowEdgeDraft[]) {
    setLocalEdges(nextEdges);
    setLocalNodes((current) => nodesWithEdgeAnchors(current, nextEdges));
  }

  function removeEdge(fromNodeKey: string, toNodeKey: string) {
    const nextEdges = localEdges.filter(
      (edge) => !(edge.fromNodeKey === fromNodeKey && edge.toNodeKey === toNodeKey)
    );
    replaceEdges(nextEdges);
    setSelectedEdgeKey(null);
    setEdgeReconnectDraft(null);
    setStatus("Connection removed. Save the flow to keep this change.");
  }

  function updateEdgeDelay(targetEdgeKey: string, value: number) {
    const delayDays = Math.max(0, Math.min(9999, Number.isFinite(value) ? Math.round(value * 100) / 100 : 0));
    setLocalEdges((current) => current.map((edge) =>
      edgeKey(edge) === targetEdgeKey ? { ...edge, delayDays } : edge
    ));
  }

  function connectNodes(sourceNodeKey: string, targetNodeKey: string, direction: "upstream" | "downstream") {
    if (!sourceNodeKey || !targetNodeKey) {
      setStatus("Choose two nodes to connect.");
      return;
    }

    if (sourceNodeKey === targetNodeKey) {
      setStatus("A node cannot depend on itself.");
      return;
    }

    const fromNodeKey = direction === "downstream" ? sourceNodeKey : targetNodeKey;
    const toNodeKey = direction === "downstream" ? targetNodeKey : sourceNodeKey;

    const exists = localEdges.some(
      (edge) => edge.fromNodeKey === fromNodeKey && edge.toNodeKey === toNodeKey
    );
    if (exists) {
      setStatus("That dependency already exists.");
      return;
    }

    const nextEdges = [...localEdges, { fromNodeKey, toNodeKey, delayDays: 0 }];
    if (taskFlowHasCycle(localNodes, nextEdges)) {
      setStatus("That link would create a loop. Task flows must move in one direction.");
      return;
    }

    replaceEdges(nextEdges);
    setSelectedEdgeKey(edgeKey({ fromNodeKey, toNodeKey }));
    setSelectedNodeKey(null);
    setConnectionDraft(null);
    setOpenNodeMenuKey(null);
    setStatus("Connection added.");
  }

  function reconnectEdgeEnd(nodeKey: string) {
    if (!edgeReconnectDraft) {
      return;
    }
    const edge = localEdges.find((item) => edgeKey(item) === edgeReconnectDraft.edgeKey);
    if (!edge) {
      setEdgeReconnectDraft(null);
      return;
    }

    const replacement = edgeReconnectDraft.end === "from"
      ? { ...edge, fromNodeKey: nodeKey }
      : { ...edge, toNodeKey: nodeKey };
    if (replacement.fromNodeKey === replacement.toNodeKey) {
      setStatus("A connection cannot start and end on the same task.");
      setEdgeReconnectDraft(null);
      return;
    }

    const nextEdges = localEdges.map((item) => edgeKey(item) === edgeReconnectDraft.edgeKey ? replacement : item);
    const hasDuplicate = nextEdges.some((item, index) =>
      nextEdges.findIndex((candidate) => edgeKey(candidate) === edgeKey(item)) !== index
    );
    if (hasDuplicate) {
      setStatus("That connection already exists.");
      setEdgeReconnectDraft(null);
      return;
    }
    if (taskFlowHasCycle(localNodes, nextEdges)) {
      setStatus("That change would create a dependency loop.");
      setEdgeReconnectDraft(null);
      return;
    }

    replaceEdges(nextEdges);
    setSelectedEdgeKey(edgeKey(replacement));
    setSelectedNodeKey(null);
    setEdgeReconnectDraft(null);
    setStatus("Connection moved. Save the flow to keep this change.");
  }

  function beginConnection(sourceNodeKey: string, direction: "upstream" | "downstream") {
    setSelectedEdgeKey(null);
    setConnectionDraft({ sourceNodeKey, direction });
    setSelectedNodeKey(sourceNodeKey);
    setOpenNodeMenuKey(null);
    setOpenNodeEditorKey(null);
    setStatus(
      direction === "upstream"
        ? "Click another node to make it a prerequisite for this node."
        : "Click another node to make it depend on this node."
    );
  }

  function handleNodeClick(nodeKey: string) {
    if (connectionDraft) {
      connectNodes(connectionDraft.sourceNodeKey, nodeKey, connectionDraft.direction);
      return;
    }

    setSelectedEdgeKey(null);
    setSelectedNodeKey(nodeKey);
    setOpenNodeMenuKey(null);
    setStatus(null);
  }

  function clearGraphSelection() {
    setSelectedNodeKey(null);
    setSelectedEdgeKey(null);
    setOpenNodeMenuKey(null);
    setOpenNodeEditorKey(null);
    setConnectionDraft(null);
    setEdgeReconnectDraft(null);
  }

  async function saveFlow() {
    if (!farmId) {
      setStatus("Farm data is not loaded.");
      return;
    }

    if (!name.trim()) {
      setStatus("Enter a name.");
      return;
    }

    if (localNodes.length === 0) {
      setStatus("Add at least one task.");
      return;
    }
    const blankLabelNode = localNodes.find((node) => !node.label.trim());
    if (blankLabelNode) {
      setStatus("Every task needs a label before saving.");
      setSelectedNodeKey(blankLabelNode.nodeKey);
      setOpenNodeEditorKey(blankLabelNode.nodeKey);
      return;
    }
    if (localNodes.length > 1) {
      const adjacentNodeKeys = new Map(localNodes.map((node) => [node.nodeKey, [] as string[]]));
      for (const edge of localEdges) {
        adjacentNodeKeys.get(edge.fromNodeKey)?.push(edge.toNodeKey);
        adjacentNodeKeys.get(edge.toNodeKey)?.push(edge.fromNodeKey);
      }
      const connectedNodeKeys = new Set<string>();
      const queue = [localNodes[0].nodeKey];
      while (queue.length > 0) {
        const nodeKey = queue.shift() as string;
        if (connectedNodeKeys.has(nodeKey)) continue;
        connectedNodeKeys.add(nodeKey);
        queue.push(...(adjacentNodeKeys.get(nodeKey) ?? []));
      }
      if (connectedNodeKeys.size !== localNodes.length) {
        const disconnectedNode = localNodes.find((node) => !connectedNodeKeys.has(node.nodeKey));
        if (!disconnectedNode) {
          setStatus("This task flow has disconnected tasks. Connect all tasks into one flow before saving.");
          return;
        }
        setStatus(`"${disconnectedNode?.label ?? "Task"}" is disconnected. Connect every task into one flow or remove the disconnected task before saving.`);
        setSelectedNodeKey(disconnectedNode.nodeKey);
        setOpenNodeEditorKey(disconnectedNode.nodeKey);
        return;
      }
    }
    if (taskFlowHasCycle(localNodes, localEdges)) {
      setStatus("This task flow has a dependency loop. Remove one link before saving.");
      return;
    }
    const staleTypeNode = localNodes.find((node) => !isCurrentTaskType(node.taskType));
    if (staleTypeNode) {
      setStatus(`${staleTypeNode.label}: ${staleTaskTypeMessage(staleTypeNode.taskType)}`);
      setSelectedNodeKey(staleTypeNode.nodeKey);
      setOpenNodeEditorKey(staleTypeNode.nodeKey);
      return;
    }
    const staleAnchorNode = localNodes.find((node) => node.anchor !== "planned_sow" && !node.anchor.startsWith("after:"));
    if (staleAnchorNode) {
      setStatus(`${staleAnchorNode.label}: old scheduling anchor. Reconnect it with arrows or set it back to the seeding date before saving.`);
      setSelectedNodeKey(staleAnchorNode.nodeKey);
      setOpenNodeEditorKey(staleAnchorNode.nodeKey);
      return;
    }
    let scheduleProblem: ReturnType<typeof taskFlowScheduleProblem>;
    try {
      scheduleProblem = taskFlowScheduleProblem(localNodes, localEdges);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "This task flow has a scheduling problem. Reconnect the arrows before saving.");
      return;
    }
    if (scheduleProblem) {
      setStatus(scheduleProblem.message);
      setSelectedNodeKey(scheduleProblem.nodeKey);
      setOpenNodeEditorKey(scheduleProblem.nodeKey);
      return;
    }

    try {
      setSaving(true);
      setStatus("Saving flow...");
      const payload = {
        farmId,
        cropId: cropId ? Number(cropId) : null,
        name: name.trim(),
        notes: notes.trim() || null,
        isDefault,
        nodes: nodesWithEdgeAnchors(localNodes, localEdges).map((node) => ({
          nodeKey: node.nodeKey,
          taskType: node.taskType,
          label: node.label.trim(),
          anchor: node.anchor,
          offsetDays: 0,
          iconColor: node.iconColor,
          iconSecondaryColor: node.iconSecondaryColor,
          tractorModel: node.tractorModel,
          tractorProfileId: node.tractorProfileId,
          x: clampFlowCoordinate(Number(node.x)),
          y: clampFlowCoordinate(Number(node.y)),
          notes: node.notes.trim() || null
        })),
        edges: localEdges
      };

      let nextId = template?.id ?? null;
      if (template) {
        await api.updateTaskFlow(template.id, payload);
      } else {
        const result = await api.createTaskFlow(payload) as { id?: number };
        nextId = result.id ?? null;
      }
      if (nextId == null) {
        throw new Error("Could not save task flow.");
      }
      setStatus("Saved.");
      await onSaved(nextId);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save task flow.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <h2>{template ? "Edit task flow" : "New task flow"}</h2>
      {status && <p className="muted"><strong>{status}</strong></p>}
      <p className="muted">Build a task flow for a crop. Each card is one job. The days between jobs are stored on the arrows.</p>
      {tutorialHint && (
        <div className="tutorial-helper-bubble">
          <strong>Tutorial next:</strong> {tutorialHint}
        </div>
      )}
      {connectionDraft && (
        <p className="muted">
          <strong>
            {connectionDraft.direction === "upstream" ? "Connecting upstream:" : "Connecting downstream:"}
          </strong>{" "}
          Click the second node to finish, or pick another action.
        </p>
      )}
      <div className="form-grid">
        <label>
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Lettuce quick-turn flow" />
        </label>
        <label>
          <span>Crop</span>
          <select value={cropId} onChange={(event) => setCropId(event.target.value)}>
            <option value="">General / not crop-specific</option>
            {crops.map((crop) => <option key={crop.id} value={crop.id}>{crop.name}</option>)}
          </select>
        </label>
        <label>
          <span>Use as default for this crop</span>
          <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
        </label>
        <label className="full-span">
          <span>Notes</span>
          <textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
      </div>

        <div className="flow-canvas-shell">
          <div className="flow-canvas-toolbar">
            <div className="flow-canvas-toolbar-row">
              <div className="button-row">
                <button
                  type="button"
                  className={`secondary-button compact-button${tutorialHighlightAddNode ? " tutorial-target" : ""}`}
                  data-tutorial-label={tutorialHighlightAddNode ? "Add Cleanup task" : undefined}
                  onClick={addNode}
                >
                  Add node
                </button>
                <button
                  type="button"
                  className="secondary-button compact-button"
                  onClick={removeSelectedNode}
                  disabled={selectedNode == null && selectedEdgeKey == null}
                >
                  Remove selected
                </button>
              </div>
              <div className="flow-canvas-size-control" aria-label="Canvas size">
                <span>Canvas size</span>
                <div className="flow-canvas-size-options">
                  {flowCanvasSizeOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`${canvasSize === option.value ? "primary-button" : "secondary-button"} compact-button`}
                      onClick={() => setCanvasSize(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <p className="muted">Click an arrow's day label to edit it. Click an arrow to show handles, then drag a handle to reconnect that end.</p>
          </div>
          <div
            ref={canvasRef}
            className={`flow-canvas flow-canvas-${canvasSize}`}
            onClick={(event) => {
              if (event.target !== event.currentTarget) {
                return;
              }
              clearGraphSelection();
            }}
          >
          <svg
            className="flow-edge-layer"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                event.stopPropagation();
                clearGraphSelection();
              }
            }}
          >
            <defs>
              <marker id="flow-arrowhead" markerWidth="12" markerHeight="12" refX="10.5" refY="6" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L12,6 L0,12 z" fill="#6b7a58" />
              </marker>
              <marker id="flow-arrowhead-mid" markerWidth="11" markerHeight="11" refX="5.5" refY="5.5" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L11,5.5 L0,11 z" fill="#6b7a58" />
              </marker>
            </defs>
            {localEdges.map((edge) => {
              const fromNode = nodeMap.get(edge.fromNodeKey);
              const toNode = nodeMap.get(edge.toNodeKey);
              if (!fromNode || !toNode) {
                return null;
              }

              return (
                <polyline
                  key={`${edge.fromNodeKey}-${edge.toNodeKey}`}
                  className={selectedEdgeKey === edgeKey(edge) ? "selected" : ""}
                  points={[
                    `${fromNode.x * 100},${fromNode.y * 100}`,
                    `${((fromNode.x + toNode.x) / 2) * 100},${((fromNode.y + toNode.y) / 2) * 100}`,
                    `${toNode.x * 100},${toNode.y * 100}`
                  ].join(" ")}
                  markerMid="url(#flow-arrowhead-mid)"
                  markerEnd="url(#flow-arrowhead)"
                  onClick={(event) => {
                    event.stopPropagation();
                    setConnectionDraft(null);
                    setSelectedEdgeKey(edgeKey(edge));
                    setSelectedNodeKey(null);
                    setOpenNodeEditorKey(null);
                    setOpenNodeMenuKey(null);
                  }}
                />
              );
            })}
            {edgeReconnectDraft && (() => {
              const edge = localEdges.find((item) => edgeKey(item) === edgeReconnectDraft.edgeKey);
              if (!edge) return null;
              const fixedNode = nodeMap.get(edgeReconnectDraft.end === "from" ? edge.toNodeKey : edge.fromNodeKey);
              if (!fixedNode) return null;
              const fromPoint = edgeReconnectDraft.end === "from"
                ? `${edgeReconnectDraft.pointerX * 100},${edgeReconnectDraft.pointerY * 100}`
                : `${fixedNode.x * 100},${fixedNode.y * 100}`;
              const toPoint = edgeReconnectDraft.end === "to"
                ? `${edgeReconnectDraft.pointerX * 100},${edgeReconnectDraft.pointerY * 100}`
                : `${fixedNode.x * 100},${fixedNode.y * 100}`;
              return <line className="flow-edge-reconnect-preview" x1={fromPoint.split(",")[0]} y1={fromPoint.split(",")[1]} x2={toPoint.split(",")[0]} y2={toPoint.split(",")[1]} />;
            })()}
          </svg>
          {localEdges.map((edge) => {
            const fromNode = nodeMap.get(edge.fromNodeKey);
            const toNode = nodeMap.get(edge.toNodeKey);
            if (!fromNode || !toNode) {
              return null;
            }
            const key = edgeKey(edge);
            const selected = selectedEdgeKey === key;
            const midpointStyle = {
              left: `${((fromNode.x + toNode.x) / 2) * 100}%`,
              top: `${((fromNode.y + toNode.y) / 2) * 100}%`,
              marginTop: "-24px"
            };
            return (
              <div key={`controls-${key}`}>
                <div
                  className={`flow-edge-delay${selected ? " selected" : ""}`}
                  style={midpointStyle}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setConnectionDraft(null);
                    setSelectedEdgeKey(key);
                    setSelectedNodeKey(null);
                    setOpenNodeEditorKey(null);
                    setOpenNodeMenuKey(null);
                  }}
                >
                  {selected ? (
                    <label>
                      <input
                        type="number"
                        min={0}
                        max={9999}
                        step={0.01}
                        value={edge.delayDays}
                        aria-label={`Days from ${fromNode.label} to ${toNode.label}`}
                        onChange={(event) => updateEdgeDelay(key, Number(event.target.value))}
                        autoFocus
                      />
                      <span>days</span>
                    </label>
                  ) : (
                    <button type="button">{edge.delayDays}d</button>
                  )}
                </div>
                {selected && (
                  <>
                    <button
                      type="button"
                      className="flow-edge-grip"
                      style={{ left: `${fromNode.x * 100}%`, top: `${fromNode.y * 100}%` }}
                      aria-label="Move the start of this connection"
                      title="Drag to another task"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setEdgeReconnectDraft({ edgeKey: key, end: "from", pointerX: fromNode.x, pointerY: fromNode.y });
                      }}
                    />
                    <button
                      type="button"
                      className="flow-edge-grip"
                      style={{ left: `${toNode.x * 100}%`, top: `${toNode.y * 100}%` }}
                      aria-label="Move the end of this connection"
                      title="Drag to another task"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setEdgeReconnectDraft({ edgeKey: key, end: "to", pointerX: toNode.x, pointerY: toNode.y });
                      }}
                    />
                  </>
                )}
              </div>
            );
          })}
          {localNodes.map((node) => {
            const nodeIsTutorialTarget = tutorialHighlightMowNodeClick && tutorialCleanupNode?.nodeKey === node.nodeKey;
            const editIsTutorialTarget = tutorialHighlightMowEdit && tutorialTargetNode?.nodeKey === node.nodeKey;
            const linkIsTutorialTarget = tutorialHighlightHarvestLink && tutorialCleanupSourceNode?.nodeKey === node.nodeKey;
            const nodeHasStaleCategory = !isCurrentTaskType(node.taskType);
            const nodeHasStaleAnchor = node.anchor !== "planned_sow" && !node.anchor.startsWith("after:");
            return (
              <div
                key={node.nodeKey}
                className={`flow-node-card${selectedNodeKey === node.nodeKey ? " selected" : ""}${connectionDraft?.sourceNodeKey === node.nodeKey ? " connection-source" : ""}${openNodeEditorKey === node.nodeKey ? " expanded" : ""}${nodeIsTutorialTarget ? " tutorial-target" : ""}${nodeHasStaleCategory || nodeHasStaleAnchor ? " stale-flow-node" : ""}`}
                data-tutorial-label={nodeIsTutorialTarget ? "Click Cleanup" : undefined}
                  style={nodeCardStyle(node)}
                onMouseUp={() => reconnectEdgeEnd(node.nodeKey)}
                onMouseDown={(event) => {
                  if (connectionDraft || edgeReconnectDraft) {
                    return;
                  }
                  event.preventDefault();
                  setSelectedEdgeKey(null);
                  setSelectedNodeKey(node.nodeKey);
                  setDragNodeKey(node.nodeKey);
                }}
                onClick={() => handleNodeClick(node.nodeKey)}
              >
                <div className="flow-node-card-main">
                  <strong>{node.label}</strong>
                  <span className="flow-node-icon-preview">
                    <TaskIconMark taskType={node.taskType} color={node.iconColor} secondaryColor={node.iconSecondaryColor} tractorModel={node.tractorModel} mini />
                  </span>
                  <span className="small-chip">{formatTaskTypeLabel(node.taskType)}</span>
                  {(nodeHasStaleCategory || nodeHasStaleAnchor) && <span className="status-pill danger-pill">Update</span>}
                    <span className="table-subtle">{scheduleSourceLabel(node)}</span>
                </div>
                <div className="flow-node-card-actions">
                  <button
                    type="button"
                    className={`secondary-button compact-button flow-node-menu-button${editIsTutorialTarget ? " tutorial-target" : ""}`}
                    data-tutorial-label={editIsTutorialTarget ? "Edit Cleanup" : undefined}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedNodeKey(node.nodeKey);
                      toggleNodeEditor(node);
                    }}
                  >
                    {openNodeEditorKey === node.nodeKey ? "Save" : "Edit"}
                  </button>
                  <button
                    type="button"
                    className={`secondary-button compact-button flow-node-menu-button${linkIsTutorialTarget ? " tutorial-target" : ""}`}
                    data-tutorial-label={linkIsTutorialTarget ? "Link Harvest" : undefined}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setSelectedEdgeKey(null);
                      setSelectedNodeKey(node.nodeKey);
                      setOpenNodeMenuKey((current) => current === node.nodeKey ? null : node.nodeKey);
                      setOpenNodeEditorKey(null);
                      setConnectionDraft(null);
                    }}
                  >
                    Link
                  </button>
                </div>
                {openNodeEditorKey === node.nodeKey && (
                  <div
                    className="flow-node-editor"
                    onMouseDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                    }}
                  >
                  <label>
                    <span>Label</span>
                    <input value={node.label} onChange={(event) => updateNode(node.nodeKey, { label: event.target.value })} />
                  </label>
                  <label
                    className={tutorialHighlightTaskType && tutorialTargetNode?.nodeKey === node.nodeKey ? " tutorial-target" : ""}
                    data-tutorial-label={tutorialHighlightTaskType && tutorialTargetNode?.nodeKey === node.nodeKey ? "Set to Cleanup" : undefined}
                  >
                    <span>Task type</span>
                    <select value={node.taskType} onChange={(event) => updateNodeTaskType(node, event.target.value)}>
                      {uniqueTaskTypeOptions([...taskTypeOptions, node.taskType]).map((taskType) => <option key={taskType} value={taskType}>{formatTaskTypeLabel(taskType)}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Saved vehicle</span>
                    <select value={node.tractorProfileId ?? ""} onChange={(event) => updateNodeTractorProfile(node, event.target.value)}>
                      {tractorProfiles.length === 0 && <option value="">No saved vehicles yet</option>}
                      {tractorProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                    </select>
                  </label>
                    {afterNodeKeys(node.anchor).length > 0 ? (
                      <div className="flow-node-schedule-source">
                        <span>Counts from</span>
                        <strong>{scheduleSourceLabel(node)}</strong>
                        <p className="muted flow-node-menu-note">Change this by adding or removing arrows.</p>
                      </div>
                    ) : (
                      <div
                        className={`flow-node-schedule-source${tutorialHighlightAnchor && tutorialTargetNode?.nodeKey === node.nodeKey ? " tutorial-target" : ""}`}
                        data-tutorial-label={tutorialHighlightAnchor && tutorialTargetNode?.nodeKey === node.nodeKey ? "Seeding date" : undefined}
                      >
                        <span>Counts from</span>
                        <strong>{formatTaskAnchorLabel("planned_sow")}</strong>
                        <p className="muted flow-node-menu-note">Add an arrow if this job is scheduled from  other task</p>
                      </div>
                    )}
                  <label className="full-span">
                    <span>Notes</span>
                    <textarea rows={3} value={node.notes} onChange={(event) => updateNode(node.nodeKey, { notes: event.target.value })} />
                  </label>
                  <div className="flow-node-connections full-span">
                    <span>Connections</span>
                    {localEdges.some((edge) => edge.fromNodeKey === node.nodeKey || edge.toNodeKey === node.nodeKey) ? (
                      <div className="flow-node-connection-list">
                        {localEdges
                          .filter((edge) => edge.fromNodeKey === node.nodeKey || edge.toNodeKey === node.nodeKey)
                          .map((edge) => {
                            const fromLabel = nodeMap.get(edge.fromNodeKey)?.label ?? edge.fromNodeKey;
                            const toLabel = nodeMap.get(edge.toNodeKey)?.label ?? edge.toNodeKey;
                            return (
                              <div key={`${edge.fromNodeKey}-${edge.toNodeKey}`} className="flow-node-connection-row">
                                <span>{fromLabel} {"->"} {toLabel}</span>
                                <button
                                  type="button"
                                  className="secondary-button compact-button"
                                  onClick={() => removeEdge(edge.fromNodeKey, edge.toNodeKey)}
                                >
                                  Remove connection
                                </button>
                              </div>
                            );
                          })}
                      </div>
                    ) : (
                      <p className="muted flow-node-menu-note">No connections yet.</p>
                    )}
                  </div>
                  <div className="button-row full-span">
                    <button type="button" className="primary-button compact-button" onClick={() => toggleNodeEditor(node)}>Save</button>
                    <button type="button" className="secondary-button compact-button" onClick={() => cancelNodeEditor(node.nodeKey)}>Cancel</button>
                    <button type="button" className="danger-button compact-button" onClick={() => removeNode(node.nodeKey)}>Delete node</button>
                  </div>
                </div>
              )}
            </div>
            );
          })}
          {openNodeMenuNode && (
            <div
              className="flow-node-menu flow-node-menu-floating"
              style={floatingMenuStyle(openNodeMenuNode)}
              onMouseDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              <button
                type="button"
                className="flow-node-menu-item"
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  beginConnection(openNodeMenuNode.nodeKey, "upstream");
                }}
              >
                Add previous task
              </button>
              <button
                type="button"
                className={`flow-node-menu-item${tutorialHighlightHarvestDownstream && tutorialCleanupSourceNode?.nodeKey === openNodeMenuNode.nodeKey ? " tutorial-target" : ""}`}
                data-tutorial-label={tutorialHighlightHarvestDownstream && tutorialCleanupSourceNode?.nodeKey === openNodeMenuNode.nodeKey ? "Choose this" : undefined}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  beginConnection(openNodeMenuNode.nodeKey, "downstream");
                }}
              >
                Add next task
              </button>
              {localEdges.some((edge) => edge.fromNodeKey === openNodeMenuNode.nodeKey || edge.toNodeKey === openNodeMenuNode.nodeKey) && (
                <p className="muted flow-node-menu-note">
                  Existing links stay in the dependency list below.
                </p>
              )}
            </div>
          )}
          </div>
        </div>

      <div className="task-flow-editor-grid">
        <div className="task-flow-panel">
          <div className="task-flow-step-header">
            <strong>Selected task</strong>
            {selectedNode && <span className="small-chip">{selectedNode.nodeKey}</span>}
          </div>
          {selectedNode ? (
            <dl className="detail-list">
              <div><dt>Label</dt><dd>{selectedNode.label}</dd></div>
              <div><dt>Task type</dt><dd>{formatTaskTypeLabel(selectedNode.taskType)}</dd></div>
              {!isCurrentTaskType(selectedNode.taskType) && <div><dt>Needs update</dt><dd>{staleTaskTypeMessage(selectedNode.taskType)}</dd></div>}
              {selectedNode.anchor !== "planned_sow" && !selectedNode.anchor.startsWith("after:") && <div><dt>Needs update</dt><dd>Old scheduling anchor. Reconnect this node with arrows or set it back to the seeding date.</dd></div>}
              <div><dt>Saved vehicle</dt><dd>{tractorProfiles.find((profile) => profile.id === selectedNode.tractorProfileId)?.name ?? "Default vehicle"}</dd></div>
                <div><dt>Counts from</dt><dd>{scheduleSourceLabel(selectedNode)}</dd></div>
              <div><dt>Notes</dt><dd>{selectedNode.notes || "—"}</dd></div>
              <div><dt>Edit</dt><dd>Use the node card controls to save or cancel inline edits.</dd></div>
            </dl>
          ) : (
            <p className="muted">Select a task on the chart to edit it.</p>
          )}
        </div>

        <div className="task-flow-panel">
          <div className="task-flow-step-header">
            <strong>Dependencies</strong>
            <span className="small-chip">{localEdges.length} links</span>
          </div>
          <p className="muted">Click a line to edit its days, or drag either end to another task.</p>
          <div className="flow-edge-list">
            {localEdges.length === 0 ? (
              <p className="muted">No dependencies yet. Connect two tasks to start.</p>
            ) : (
              localEdges.map((edge) => (
                <div key={`${edge.fromNodeKey}-${edge.toNodeKey}`} className="flow-edge-row">
                  <span>{nodeMap.get(edge.fromNodeKey)?.label ?? edge.fromNodeKey} {"->"} {nodeMap.get(edge.toNodeKey)?.label ?? edge.toNodeKey} ({edge.delayDays} days)</span>
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    onClick={() => {
                      removeEdge(edge.fromNodeKey, edge.toNodeKey);
                    }}
                  >
                    Remove connection
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="button-row">
        <button
          type="button"
          className={`primary-button${tutorialHighlightSaveFlow ? " tutorial-target" : ""}`}
          data-tutorial-label={tutorialHighlightSaveFlow ? "Save flow" : undefined}
          disabled={saving}
          onClick={() => void saveFlow()}
        >
          {saving ? "Saving..." : "Save flow"}
        </button>
      </div>
    </div>
  );
}
