import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { TaskIconMark } from "./TaskIconMark";
import {
  formatTaskAnchorLabel,
  formatTaskTypeLabel,
  taskAnchorOptions,
  taskIconColor,
  taskTypeOptions
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
        { ...newTaskFlowNode(0), label: "Bed prep", taskType: "bed_prep", iconColor: defaultProfileForTask("bed_prep")?.iconColor ?? taskIconColor("bed_prep"), iconSecondaryColor: defaultProfileForTask("bed_prep")?.iconSecondaryColor ?? "#f4c430", tractorModel: defaultProfileForTask("bed_prep")?.tractorModel ?? defaultModelForTask("bed_prep"), tractorProfileId: defaultProfileForTask("bed_prep")?.id ?? null, anchor: "planned_transplant", offsetDays: -5 },
        { ...newTaskFlowNode(1), label: "Transplant", taskType: "transplant", iconColor: defaultProfileForTask("transplant")?.iconColor ?? taskIconColor("transplant"), iconSecondaryColor: defaultProfileForTask("transplant")?.iconSecondaryColor ?? "#f4c430", tractorModel: defaultProfileForTask("transplant")?.tractorModel ?? defaultModelForTask("transplant"), tractorProfileId: defaultProfileForTask("transplant")?.id ?? null, anchor: "actual_transplant", offsetDays: 0 },
        { ...newTaskFlowNode(2), label: "Harvest start", taskType: "harvest", iconColor: defaultProfileForTask("harvest")?.iconColor ?? taskIconColor("harvest"), iconSecondaryColor: defaultProfileForTask("harvest")?.iconSecondaryColor ?? "#f4c430", tractorModel: defaultProfileForTask("harvest")?.tractorModel ?? defaultModelForTask("harvest"), tractorProfileId: defaultProfileForTask("harvest")?.id ?? null, anchor: "actual_transplant", offsetDays: 35 }
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
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const selectedNode = localNodes.find((node) => node.nodeKey === selectedNodeKey) ?? null;
  const nodeMap = useMemo(() => new Map(localNodes.map((node) => [node.nodeKey, node])), [localNodes]);
  const tutorialHarvestNode = localNodes.find((node) => node.taskType === "harvest") ?? null;
  const tutorialExistingMowNode = localNodes.find((node) => node.taskType === "mow") ?? null;
  const tutorialAddedNode = tutorialAddedNodeKey ? nodeMap.get(tutorialAddedNodeKey) ?? null : null;
  const tutorialTargetNode = tutorialAddedNode ?? tutorialExistingMowNode;
  const tutorialMowNode = tutorialTargetNode?.taskType === "mow" ? tutorialTargetNode : null;
  const tutorialMowLinkedAfterHarvest = Boolean(tutorialHarvestNode && tutorialMowNode && localEdges.some((edge) =>
    edge.fromNodeKey === tutorialHarvestNode.nodeKey && edge.toNodeKey === tutorialMowNode.nodeKey
  ));
  const tutorialHighlightAddNode = tutorialActive && !tutorialTargetNode;
  const tutorialHighlightMowEdit = tutorialActive
    && tutorialTargetNode != null
    && (tutorialTargetNode.taskType !== "mow" || tutorialTargetNode.anchor !== "actual_harvest")
    && openNodeEditorKey !== tutorialTargetNode.nodeKey;
  const tutorialHighlightTaskType = tutorialActive
    && tutorialTargetNode != null
    && openNodeEditorKey === tutorialTargetNode.nodeKey
    && tutorialTargetNode.taskType !== "mow";
  const tutorialHighlightAnchor = tutorialActive
    && tutorialTargetNode != null
    && openNodeEditorKey === tutorialTargetNode.nodeKey
    && tutorialTargetNode.taskType === "mow"
    && tutorialTargetNode.anchor !== "actual_harvest";
  const tutorialReadyToLinkMow = tutorialActive
    && tutorialHarvestNode != null
    && tutorialMowNode != null
    && tutorialMowNode.anchor === "actual_harvest"
    && !tutorialMowLinkedAfterHarvest;
  const tutorialHighlightHarvestLink = tutorialReadyToLinkMow
    && !connectionDraft
    && openNodeMenuKey !== tutorialHarvestNode?.nodeKey;
  const tutorialHighlightHarvestDownstream = tutorialReadyToLinkMow
    && !connectionDraft
    && openNodeMenuKey === tutorialHarvestNode?.nodeKey;
  const tutorialHighlightMowNodeClick = tutorialReadyToLinkMow
    && connectionDraft?.sourceNodeKey === tutorialHarvestNode?.nodeKey
    && connectionDraft.direction === "downstream";
  const tutorialHighlightSaveFlow = tutorialActive
    && tutorialMowNode != null
    && tutorialMowNode.anchor === "actual_harvest"
    && tutorialMowLinkedAfterHarvest;
  const tutorialHint = tutorialHighlightAddNode
    ? "Click Add node to create the new task that will happen after harvest."
    : tutorialHighlightTaskType
      ? "Set Task type to Mow. The label will update so the node is easy to recognize."
      : tutorialHighlightAnchor
        ? "Set Anchor to Actual harvest so mowing is scheduled from when harvest really happens."
        : tutorialHighlightMowEdit
          ? "Open the new node's Edit controls to finish setting Task type and Anchor."
          : tutorialHighlightHarvestDownstream
            ? "Choose Add downstream dependent. That means Mow will happen after Harvest."
            : tutorialHighlightMowNodeClick
              ? "Click the Mow node to finish the link from Harvest to Mow."
              : tutorialHighlightHarvestLink
                ? "Click Link on the Harvest node. Harvest is the step Mow should follow."
                : tutorialHighlightSaveFlow
                  ? "The Mow task is linked after Harvest. Click Save flow to keep the change."
                  : tutorialActive
                    ? "Add a Mow task after Harvest, anchor it to Actual harvest, then save the flow."
                    : null;

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

  function removeSelectedNode() {
    if (!selectedNode) {
      return;
    }

    setLocalNodes((current) => {
      const remaining = current.filter((node) => node.nodeKey !== selectedNode.nodeKey);
      setSelectedNodeKey(remaining[0]?.nodeKey ?? null);
      setOpenNodeMenuKey(null);
      setOpenNodeEditorKey(null);
      setConnectionDraft(null);
      return remaining;
    });
    setLocalEdges((current) =>
      current.filter((edge) => edge.fromNodeKey !== selectedNode.nodeKey && edge.toNodeKey !== selectedNode.nodeKey)
    );
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
      <p className="muted">Drag nodes on the chart, edit the selected node, and connect nodes to define task dependencies.</p>
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
          <div className="button-row">
            <button
              type="button"
              className={`secondary-button compact-button${tutorialHighlightAddNode ? " tutorial-target" : ""}`}
              data-tutorial-label={tutorialHighlightAddNode ? "Add Mow task" : undefined}
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
          <p className="muted">Each node stores its own anchor and day offset. Edges define which tasks depend on earlier tasks.</p>
        </div>
        <div ref={canvasRef} className="flow-canvas">
          <svg className="flow-edge-layer" viewBox="0 0 100 100" preserveAspectRatio="none">
            <defs>
              <marker id="flow-arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L8,4 L0,8 z" fill="#6b7a58" />
              </marker>
            </defs>
            {localEdges.map((edge) => {
              const fromNode = nodeMap.get(edge.fromNodeKey);
              const toNode = nodeMap.get(edge.toNodeKey);
              if (!fromNode || !toNode) {
                return null;
              }

              return (
                <line
                  key={`${edge.fromNodeKey}-${edge.toNodeKey}`}
                  x1={fromNode.x * 100}
                  y1={fromNode.y * 100}
                  x2={toNode.x * 100}
                  y2={toNode.y * 100}
                  markerEnd="url(#flow-arrowhead)"
                />
              );
            })}
          </svg>
          {localNodes.map((node) => {
            const nodeIsTutorialTarget = tutorialHighlightMowNodeClick && tutorialMowNode?.nodeKey === node.nodeKey;
            const editIsTutorialTarget = tutorialHighlightMowEdit && tutorialTargetNode?.nodeKey === node.nodeKey;
            const linkIsTutorialTarget = tutorialHighlightHarvestLink && tutorialHarvestNode?.nodeKey === node.nodeKey;
            return (
            <div
              key={node.nodeKey}
              className={`flow-node-card${selectedNodeKey === node.nodeKey ? " selected" : ""}${connectionDraft?.sourceNodeKey === node.nodeKey ? " connection-source" : ""}${openNodeEditorKey === node.nodeKey ? " expanded" : ""}${nodeIsTutorialTarget ? " tutorial-target" : ""}`}
              data-tutorial-label={nodeIsTutorialTarget ? "Click Mow" : undefined}
              style={{ left: `${node.x * 100}%`, top: `${node.y * 100}%` }}
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
                <span className="table-subtle">{formatTaskAnchorLabel(node.anchor)} {node.offsetDays >= 0 ? "+" : ""}{node.offsetDays}d</span>
              </div>
              <div className="flow-node-card-actions">
                <button
                  type="button"
                  className={`secondary-button compact-button flow-node-menu-button${editIsTutorialTarget ? " tutorial-target" : ""}`}
                  data-tutorial-label={editIsTutorialTarget ? "Edit Mow" : undefined}
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
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedNodeKey(node.nodeKey);
                    setOpenNodeMenuKey((current) => current === node.nodeKey ? null : node.nodeKey);
                    setOpenNodeEditorKey(null);
                    setConnectionDraft(null);
                  }}
                >
                  Link
                </button>
                {openNodeMenuKey === node.nodeKey && (
                  <div
                    className="flow-node-menu"
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
                      onClick={() => beginConnection(node.nodeKey, "upstream")}
                    >
                      Add upstream dependency
                    </button>
                    <button
                      type="button"
                      className={`flow-node-menu-item${tutorialHighlightHarvestDownstream && tutorialHarvestNode?.nodeKey === node.nodeKey ? " tutorial-target" : ""}`}
                      data-tutorial-label={tutorialHighlightHarvestDownstream && tutorialHarvestNode?.nodeKey === node.nodeKey ? "Choose this" : undefined}
                      onClick={() => beginConnection(node.nodeKey, "downstream")}
                    >
                      Add downstream dependent
                    </button>
                    {localEdges.some((edge) => edge.fromNodeKey === node.nodeKey || edge.toNodeKey === node.nodeKey) && (
                      <p className="muted flow-node-menu-note">
                        Existing links stay in the dependency list below.
                      </p>
                    )}
                  </div>
                )}
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
                    data-tutorial-label={tutorialHighlightTaskType && tutorialTargetNode?.nodeKey === node.nodeKey ? "Set to Mow" : undefined}
                  >
                    <span>Task type</span>
                    <select value={node.taskType} onChange={(event) => updateNodeTaskType(node, event.target.value)}>
                      {taskTypeOptions.map((taskType) => <option key={taskType} value={taskType}>{formatTaskTypeLabel(taskType)}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Saved vehicle</span>
                    <select value={node.tractorProfileId ?? ""} onChange={(event) => updateNodeTractorProfile(node, event.target.value)}>
                      {tractorProfiles.length === 0 && <option value="">No saved vehicles yet</option>}
                      {tractorProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                    </select>
                  </label>
                  <label
                    className={tutorialHighlightAnchor && tutorialTargetNode?.nodeKey === node.nodeKey ? " tutorial-target" : ""}
                    data-tutorial-label={tutorialHighlightAnchor && tutorialTargetNode?.nodeKey === node.nodeKey ? "Actual harvest" : undefined}
                  >
                    <span>Anchor</span>
                    <select value={node.anchor} onChange={(event) => updateNode(node.nodeKey, { anchor: event.target.value })}>
                      {taskAnchorOptions.map((anchor) => <option key={anchor} value={anchor}>{formatTaskAnchorLabel(anchor)}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Offset days</span>
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
                  <div className="button-row full-span">
                    <button type="button" className="primary-button compact-button" onClick={() => toggleNodeEditor(node)}>Save</button>
                    <button type="button" className="secondary-button compact-button" onClick={() => cancelNodeEditor(node.nodeKey)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
            );
          })}
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
              <div><dt>Saved vehicle</dt><dd>{tractorProfiles.find((profile) => profile.id === selectedNode.tractorProfileId)?.name ?? "Default vehicle"}</dd></div>
              <div><dt>Anchor</dt><dd>{formatTaskAnchorLabel(selectedNode.anchor)}</dd></div>
              <div><dt>Offset</dt><dd>{selectedNode.offsetDays >= 0 ? "+" : ""}{selectedNode.offsetDays} days</dd></div>
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
                      setLocalEdges((current) =>
                        current.filter((item) => !(item.fromNodeKey === edge.fromNodeKey && item.toNodeKey === edge.toNodeKey))
                      );
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
