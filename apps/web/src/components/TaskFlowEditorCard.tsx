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
  taskFlowHasCycle
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

function addAfterAnchor(anchor: string, nodeKey: string) {
  return afterAnchor([...afterNodeKeys(anchor), nodeKey]);
}

function removeAfterAnchor(anchor: string, nodeKey: string) {
  const remaining = afterNodeKeys(anchor).filter((item) => item !== nodeKey);
  return remaining.length > 0 ? afterAnchor(remaining) : "planned_sow";
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
        offsetDays: node.offsetDays,
        iconColor: node.iconColor ?? taskIconColor(node.taskType),
        iconSecondaryColor: node.iconSecondaryColor ?? "#f4c430",
        tractorModel: node.tractorModel ?? defaultModelForTask(node.taskType),
        tractorProfileId: node.tractorProfileId ?? null,
        x: Number(node.x),
        y: Number(node.y),
        notes: node.notes ?? ""
      }))
    : [
        { ...newTaskFlowNode(0), nodeKey: "shape_beds", label: "Shape beds", taskType: "bed_making", iconColor: defaultProfileForTask("bed_making")?.iconColor ?? taskIconColor("bed_making"), iconSecondaryColor: defaultProfileForTask("bed_making")?.iconSecondaryColor ?? "#f4c430", tractorModel: defaultProfileForTask("bed_making")?.tractorModel ?? defaultModelForTask("bed_making"), tractorProfileId: defaultProfileForTask("bed_making")?.id ?? null, anchor: "planned_sow", offsetDays: 23 },
        { ...newTaskFlowNode(1), nodeKey: "transplant", label: "Transplant", taskType: "transplant", iconColor: defaultProfileForTask("transplant")?.iconColor ?? taskIconColor("transplant"), iconSecondaryColor: defaultProfileForTask("transplant")?.iconSecondaryColor ?? "#f4c430", tractorModel: defaultProfileForTask("transplant")?.tractorModel ?? defaultModelForTask("transplant"), tractorProfileId: defaultProfileForTask("transplant")?.id ?? null, anchor: "after:shape_beds", offsetDays: 5 },
        { ...newTaskFlowNode(2), nodeKey: "cultivation", label: "Cultivate", taskType: "cultivation", iconColor: defaultProfileForTask("cultivation")?.iconColor ?? taskIconColor("cultivation"), iconSecondaryColor: defaultProfileForTask("cultivation")?.iconSecondaryColor ?? "#f4c430", tractorModel: defaultProfileForTask("cultivation")?.tractorModel ?? defaultModelForTask("cultivation"), tractorProfileId: defaultProfileForTask("cultivation")?.id ?? null, anchor: "after:transplant", offsetDays: 7 }
      ];
  const initialEdges = edges.length > 0
    ? edges.map((edge) => ({
        fromNodeKey: edge.fromNodeKey,
        toNodeKey: edge.toNodeKey
      }))
    : [
        { fromNodeKey: initialNodes[0].nodeKey, toNodeKey: initialNodes[1].nodeKey },
        { fromNodeKey: initialNodes[1].nodeKey, toNodeKey: initialNodes[2].nodeKey }
      ];

  const [name, setName] = useState(template?.name ?? "");
  const [cropId, setCropId] = useState(template?.cropId != null ? String(template.cropId) : "");
  const [notes, setNotes] = useState(template?.notes ?? "");
  const [isDefault, setIsDefault] = useState(template?.isDefault ?? !template);
  const [localNodes, setLocalNodes] = useState<FlowNodeDraft[]>(initialNodes);
  const [localEdges, setLocalEdges] = useState<FlowEdgeDraft[]>(initialEdges);
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(initialNodes[0]?.nodeKey ?? null);
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
            ? "Choose Add downstream dependent. That means the new cleanup task will happen after the earlier cleanup task."
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
    if (openNodeEditorKey !== node.nodeKey) {
      return { left: `${node.x * 100}%`, top: `${node.y * 100}%` };
    }

    const left = node.x < 0.28 ? 2 : node.x > 0.72 ? 98 : node.x * 100;
    const top = node.y < 0.38 ? 2 : node.y > 0.62 ? 98 : 50;
    const translateX = node.x < 0.28 ? "0" : node.x > 0.72 ? "-100%" : "-50%";
    const translateY = node.y < 0.38 ? "0" : node.y > 0.62 ? "-100%" : "-50%";
    return {
      left: `${left}%`,
      top: `${top}%`,
      transform: `translate(${translateX}, ${translateY})`
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

  function timingSummaryLabel(node: FlowNodeDraft) {
    return `${scheduleSourceLabel(node)} ${node.offsetDays >= 0 ? "+" : ""}${node.offsetDays}d`;
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
    setLocalNodes((current) => {
      const remaining = current.filter((node) => node.nodeKey !== nodeKey);
      setSelectedNodeKey(remaining[0]?.nodeKey ?? null);
      setOpenNodeMenuKey(null);
      setOpenNodeEditorKey(null);
      setConnectionDraft(null);
      return remaining;
    });
    setLocalEdges((current) =>
      current.filter((edge) => edge.fromNodeKey !== nodeKey && edge.toNodeKey !== nodeKey)
    );
    setEditNodeSnapshots((current) => {
      const next = { ...current };
      delete next[nodeKey];
      return next;
    });
    setStatus("Node removed. Save the flow to keep this change.");
  }

  function removeSelectedNode() {
    if (!selectedNode) {
      return;
    }

    removeNode(selectedNode.nodeKey);
  }

    function removeEdge(fromNodeKey: string, toNodeKey: string) {
      setLocalEdges((current) =>
        current.filter((edge) => !(edge.fromNodeKey === fromNodeKey && edge.toNodeKey === toNodeKey))
      );
      setLocalNodes((current) =>
        current.map((node) => node.nodeKey === toNodeKey
          ? { ...node, anchor: removeAfterAnchor(node.anchor, fromNodeKey) }
          : node
        )
      );
      setStatus("Connection removed. Save the flow to keep this change.");
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

    const nextEdges = [...localEdges, { fromNodeKey, toNodeKey }];
    if (taskFlowHasCycle(localNodes, nextEdges)) {
      setStatus("That link would create a dependency loop. Task flows must move one direction.");
      return;
    }

      setLocalEdges(nextEdges);
      setLocalNodes((current) =>
        current.map((node) => node.nodeKey === toNodeKey
          ? { ...node, anchor: addAfterAnchor(node.anchor, fromNodeKey) }
          : node
        )
      );
      setConnectionDraft(null);
    setOpenNodeMenuKey(null);
    setStatus("Connection added.");
  }

  function beginConnection(sourceNodeKey: string, direction: "upstream" | "downstream") {
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

    setSelectedNodeKey(nodeKey);
    setOpenNodeMenuKey(null);
    setStatus(null);
  }

  async function saveFlow() {
    if (!farmId) {
      setStatus("Farm not loaded.");
      return;
    }

    if (!name.trim()) {
      setStatus("Name is required.");
      return;
    }

    if (localNodes.length === 0) {
      setStatus("Add at least one node.");
      return;
    }
    if (taskFlowHasCycle(localNodes, localEdges)) {
      setStatus("Task flow has a dependency loop. Remove one link before saving.");
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

    try {
      setSaving(true);
      setStatus("Saving flow...");
      const payload = {
        farmId,
        cropId: cropId ? Number(cropId) : null,
        name: name.trim(),
        notes: notes.trim() || null,
        isDefault,
        nodes: localNodes.map((node) => ({
          nodeKey: node.nodeKey,
          taskType: node.taskType,
          label: node.label.trim(),
          anchor: node.anchor,
          offsetDays: Number(node.offsetDays),
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
        throw new Error("Task flow save failed.");
      }
      setStatus("Saved.");
      await onSaved(nextId);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Task flow save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <h2>{template ? "Edit task flow" : "New task flow"}</h2>
      {status && <p className="muted"><strong>{status}</strong></p>}
      <p className="muted">Build a work recipe for a crop. Each card is one job. Unlinked jobs count from the seeding date; linked jobs count from the earlier linked job.</p>
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
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Lettuce quick turn flow" />
        </label>
        <label>
          <span>Crop</span>
          <select value={cropId} onChange={(event) => setCropId(event.target.value)}>
            <option value="">General</option>
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
                  disabled={selectedNode == null}
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
            <p className="muted">Use arrows when one job should follow another job. Without an arrow, the job counts from the seeding date.</p>
          </div>
          <div ref={canvasRef} className={`flow-canvas flow-canvas-${canvasSize}`}>
          <svg className="flow-edge-layer" viewBox="0 0 100 100" preserveAspectRatio="none">
            <defs>
              <marker id="flow-arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L8,4 L0,8 z" fill="#6b7a58" />
              </marker>
              <marker id="flow-arrowhead-mid" markerWidth="7" markerHeight="7" refX="3.5" refY="3.5" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L7,3.5 L0,7 z" fill="#6b7a58" />
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
                  points={[
                    `${fromNode.x * 100},${fromNode.y * 100}`,
                    `${((fromNode.x + toNode.x) / 2) * 100},${((fromNode.y + toNode.y) / 2) * 100}`,
                    `${toNode.x * 100},${toNode.y * 100}`
                  ].join(" ")}
                  markerMid="url(#flow-arrowhead-mid)"
                  markerEnd="url(#flow-arrowhead)"
                />
              );
            })}
          </svg>
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
                onMouseDown={(event) => {
                  if (connectionDraft || openNodeEditorKey === node.nodeKey) {
                    return;
                  }
                  event.preventDefault();
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
                    <span className="table-subtle">{timingSummaryLabel(node)}</span>
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
                        <p className="muted flow-node-menu-note">Add an arrow if this job should count from another job instead.</p>
                      </div>
                    )}
                  <label>
                    <span>Days before/after</span>
                    <input
                      type="number"
                      value={node.offsetDays}
                      onChange={(event) => updateNode(node.nodeKey, {
                        offsetDays: Number.isFinite(Number(event.target.value)) ? Number(event.target.value) : 0
                      })}
                    />
                  </label>
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
                                  Remove
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
                Add upstream dependency
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
                Add downstream dependent
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
            <strong>Selected node</strong>
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
              <div><dt>Days before/after</dt><dd>{selectedNode.offsetDays >= 0 ? "+" : ""}{selectedNode.offsetDays} days</dd></div>
              <div><dt>Notes</dt><dd>{selectedNode.notes || "—"}</dd></div>
              <div><dt>Edit</dt><dd>Use the node card controls to save or cancel inline edits.</dd></div>
            </dl>
          ) : (
            <p className="muted">Select a node on the chart to edit it.</p>
          )}
        </div>

        <div className="task-flow-panel">
          <div className="task-flow-step-header">
            <strong>Dependencies</strong>
            <span className="small-chip">{localEdges.length} links</span>
          </div>
          <p className="muted">Open a node's `Link` menu, choose upstream or downstream, then click the other node in the chart.</p>
          <div className="flow-edge-list">
            {localEdges.length === 0 ? (
              <p className="muted">No dependencies yet. Start by connecting two nodes.</p>
            ) : (
              localEdges.map((edge) => (
                <div key={`${edge.fromNodeKey}-${edge.toNodeKey}`} className="flow-edge-row">
                  <span>{nodeMap.get(edge.fromNodeKey)?.label ?? edge.fromNodeKey} {"->"} {nodeMap.get(edge.toNodeKey)?.label ?? edge.toNodeKey}</span>
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    onClick={() => {
                      removeEdge(edge.fromNodeKey, edge.toNodeKey);
                    }}
                  >
                    Remove
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
