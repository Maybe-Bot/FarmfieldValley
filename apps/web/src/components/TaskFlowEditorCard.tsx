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
import { TaskFlowEdge, TaskFlowNode, TaskFlowTemplate } from "../types";

// Visual editor for one task-flow template. It stays separated from App.tsx because
// it has its own graph state, drag handling, dependency validation, and save payload.
export function TaskFlowEditorCard({
  farmId,
  crops,
  template,
  nodes,
  edges,
  onSaved
}: {
  farmId: number | null;
  crops: Array<{ id: number; name: string }>;
  template: TaskFlowTemplate | null;
  nodes: TaskFlowNode[];
  edges: TaskFlowEdge[];
  onSaved: (taskFlowId: number) => Promise<void>;
}) {
  const initialNodes = nodes.length > 0
    ? nodes.map((node) => ({
        nodeKey: node.nodeKey,
        taskType: node.taskType,
        label: node.label,
        anchor: node.anchor,
        offsetDays: node.offsetDays,
        iconColor: node.iconColor ?? taskIconColor(node.taskType),
        iconSecondaryColor: node.iconSecondaryColor ?? "#f4c430",
        x: Number(node.x),
        y: Number(node.y),
        notes: node.notes ?? ""
      }))
    : [
        { ...newTaskFlowNode(0), label: "Bed prep", taskType: "bed_prep", iconColor: taskIconColor("bed_prep"), iconSecondaryColor: "#f4c430", anchor: "planned_transplant", offsetDays: -5 },
        { ...newTaskFlowNode(1), label: "Transplant", taskType: "transplant", iconColor: taskIconColor("transplant"), iconSecondaryColor: "#f4c430", anchor: "actual_transplant", offsetDays: 0 },
        { ...newTaskFlowNode(2), label: "Harvest start", taskType: "harvest", iconColor: taskIconColor("harvest"), iconSecondaryColor: "#f4c430", anchor: "actual_transplant", offsetDays: 35 }
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
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragNodeKey, setDragNodeKey] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const selectedNode = localNodes.find((node) => node.nodeKey === selectedNodeKey) ?? null;
  const nodeMap = useMemo(() => new Map(localNodes.map((node) => [node.nodeKey, node])), [localNodes]);

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
      return [...current, nextNode];
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
            <button type="button" className="secondary-button compact-button" onClick={addNode}>Add node</button>
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
          {localNodes.map((node) => (
            <div
              key={node.nodeKey}
              className={`flow-node-card${selectedNodeKey === node.nodeKey ? " selected" : ""}${connectionDraft?.sourceNodeKey === node.nodeKey ? " connection-source" : ""}${openNodeEditorKey === node.nodeKey ? " expanded" : ""}`}
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
                  <TaskIconMark taskType={node.taskType} color={node.iconColor} secondaryColor={node.iconSecondaryColor} mini />
                </span>
                <span className="small-chip">{formatTaskTypeLabel(node.taskType)}</span>
                <span className="table-subtle">{formatTaskAnchorLabel(node.anchor)} {node.offsetDays >= 0 ? "+" : ""}{node.offsetDays}d</span>
              </div>
              <div className="flow-node-card-actions">
                <button
                  type="button"
                  className="secondary-button compact-button flow-node-menu-button"
                  onMouseDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedNodeKey(node.nodeKey);
                    setOpenNodeMenuKey(null);
                    setConnectionDraft(null);
                    setOpenNodeEditorKey((current) => current === node.nodeKey ? null : node.nodeKey);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="secondary-button compact-button flow-node-menu-button"
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
                      className="flow-node-menu-item"
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
                  <label>
                    <span>Task type</span>
                    <select value={node.taskType} onChange={(event) => updateNode(node.nodeKey, { taskType: event.target.value, iconColor: taskIconColor(event.target.value) })}>
                      {taskTypeOptions.map((taskType) => <option key={taskType} value={taskType}>{formatTaskTypeLabel(taskType)}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Tractor/body color</span>
                    <input type="color" value={node.iconColor} onChange={(event) => updateNode(node.nodeKey, { iconColor: event.target.value })} />
                  </label>
                  <label>
                    <span>Accent color</span>
                    <input type="color" value={node.iconSecondaryColor} onChange={(event) => updateNode(node.nodeKey, { iconSecondaryColor: event.target.value })} />
                  </label>
                  <label>
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
                </div>
              )}
            </div>
          ))}
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
              <div><dt>Body color</dt><dd>{selectedNode.iconColor}</dd></div>
              <div><dt>Accent color</dt><dd>{selectedNode.iconSecondaryColor}</dd></div>
              <div><dt>Anchor</dt><dd>{formatTaskAnchorLabel(selectedNode.anchor)}</dd></div>
              <div><dt>Offset</dt><dd>{selectedNode.offsetDays >= 0 ? "+" : ""}{selectedNode.offsetDays} days</dd></div>
              <div><dt>Notes</dt><dd>{selectedNode.notes || "—"}</dd></div>
              <div><dt>Edit</dt><dd>Use the `Edit` button on the node card to expand its inline form.</dd></div>
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
        <button type="button" className="primary-button" disabled={saving} onClick={() => void saveFlow()}>
          {saving ? "Saving..." : "Save flow"}
        </button>
      </div>
    </div>
  );
}
