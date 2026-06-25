import { useEffect, useState } from "react";

type TutorialStep = {
  title: string;
  goal: string;
  action: string;
  check: string;
  legacyStepIndex: number;
  extraHighlightTarget?: TutorialExtraHighlightTarget;
};

type TutorialWorkflow = {
  id: "first_account" | "full_workflow";
  label: string;
  description: string;
  steps: TutorialStep[];
};

const tutorialWorkflows: TutorialWorkflow[] = [
  {
    id: "first_account",
    label: "First account",
    description: "A short setup path for drawing land, making beds, planning one crop, and finding spreadsheet tools.",
    steps: [
      {
        title: "Open the farm map",
        goal: "Start with the map because the rest of the farm records need a field, block, and beds.",
        action: "Go to Map, use Plan mode, choose Draw field, click around the outside edge, enter a name, and save.",
        check: "The saved field appears on the map and can be selected.",
        legacyStepIndex: 0
      },
      {
        title: "Make a block",
        goal: "Create the smaller bed-making area inside the field.",
        action: "Select the field, choose Draw block, click around the bed area, enter a name, and save.",
        check: "The saved block appears inside the field and can be selected.",
        legacyStepIndex: 1
      },
      {
        title: "Fill the block with beds",
        goal: "Turn the block into usable bed records.",
        action: "Select the block, open the bed tools, choose the beginning of the first bed, and fill the block.",
        check: "A row of beds appears in the selected block.",
        legacyStepIndex: 2
      },
      {
        title: "Create one planting",
        goal: "Connect a crop plan to the beds you made.",
        action: "Use New Planting from the map or Annual Crop Plan, pick the crop and bed, fill the needed fields, and create it.",
        check: "The planting appears in the crop plan and can be opened from Planting Detail.",
        legacyStepIndex: 3
      },
      {
        title: "Review the task flow",
        goal: "Confirm the planting generated the work you expect.",
        action: "Open Task Flows, select the flow used by the planting, and review the order of tasks.",
        check: "The flow has the right task types and scheduling anchors.",
        legacyStepIndex: 4
      },
      {
        title: "Record past work",
        goal: "Practice marking scheduled field work as done.",
        action: "Open the map in Work mode, use the Record Work Done panel, check the date, fill any required fields, and record the task.",
        check: "The completed task moves to done and stays tied to the planting.",
        legacyStepIndex: 5
      },
      {
        title: "Find spreadsheet tools",
        goal: "Know where import and backup/export tools live before you need them.",
        action: "Open Annual Crop Plan and find the spreadsheet import and backup/download area.",
        check: "You know where to import a prepared plan or download a farm backup later.",
        legacyStepIndex: 6
      }
    ]
  },
  {
    id: "full_workflow",
    label: "Full workflow",
    description: "A longer test path for checking map setup, planting, scheduled work, recording work, and backup export.",
    steps: [
      {
        title: "Draw a field",
        goal: "Create the field boundary that later records belong to.",
        action: "Go to Map, use Plan mode if needed, choose Draw field, click around the outside edge, enter a name, and save.",
        check: "The saved field appears on the map.",
        legacyStepIndex: 1
      },
      {
        title: "Draw a block",
        goal: "Create the bed-making area inside the field.",
        action: "Select the field, choose Draw block, click around the bed area, enter a name, and save.",
        check: "The saved block appears inside the field.",
        legacyStepIndex: 2
      },
      {
        title: "Make beds",
        goal: "Create beds in the block and check the first-bed entrance.",
        action: "Select the block, open bed tools, choose the beginning of the first bed, and fill the block.",
        check: "Beds appear and the first-bed entrance looks right.",
        legacyStepIndex: 3
      },
      {
        title: "Check bed direction",
        goal: "Confirm the first-bed entrance marker moves the right way before planning crops.",
        action: "Watch the first-bed entrance preview, then continue when it looks right.",
        check: "The marker drives into the first bed and resets correctly.",
        legacyStepIndex: 4,
        extraHighlightTarget: "entrance_preview"
      },
      {
        title: "Create a crop plan",
        goal: "Add one planting that uses a saved bed and a reusable task flow.",
        action: "Create a planting with realistic dates, spacing, plant count, bed selection, and task flow.",
        check: "The planting saves without warnings and appears in the plan.",
        legacyStepIndex: 5
      },
      {
        title: "Review task flow",
        goal: "Confirm the generated flow uses the right categories, sequence, and scheduling.",
        action: "Open Task Flows, select the tutorial flow if needed, and review the nodes.",
        check: "The flow has the expected task types and dates.",
        legacyStepIndex: 6
      },
      {
        title: "Inspect planned tasks",
        goal: "Confirm scheduled work was created from the planting.",
        action: "Open Task List or the map Work mode and look for tasks tied to the planting.",
        check: "The planned tasks have dates, task types, and planting names.",
        legacyStepIndex: 7,
        extraHighlightTarget: "task_layer_toggle"
      },
      {
        title: "Record one task",
        goal: "Make sure completed work updates task status and planting history.",
        action: "Open a scheduled task, set the actual date, fill any required bed or plant-count fields, and record it.",
        check: "The task moves to done and the work record remains visible.",
        legacyStepIndex: 8
      },
      {
        title: "Review crop history",
        goal: "Verify the planting shows the work that was recorded.",
        action: "Open Planting Detail for the crop and inspect the timeline or related task history.",
        check: "The completed work is connected to the correct planting.",
        legacyStepIndex: 9,
        extraHighlightTarget: "done_this_week"
      },
      {
        title: "Export a backup",
        goal: "Finish by checking the data safety path.",
        action: "Open Annual Crop Plan and use the spreadsheet backup or export tool.",
        check: "The backup download starts and has the current farm data.",
        legacyStepIndex: 10
      }
    ]
  }
];

export type TutorialWorkflowId = TutorialWorkflow["id"];
export type TutorialExtraHighlightTarget = "entrance_preview" | "task_layer_toggle" | "done_this_week";

type TutorialHighlightState = {
  active: boolean;
  workflowId: TutorialWorkflowId;
  legacyStepIndex: number;
  extraHighlightTarget?: TutorialExtraHighlightTarget | null;
};

const tutorialStartEventName = "loam-ledger:start-tutorial";
const tutorialHighlightRequestEventName = "loam-ledger:tutorial-highlight-request";
const tutorialHighlightStateEventName = "loam-ledger:tutorial-highlight-state";

function findTutorialWorkflow(workflowId: TutorialWorkflow["id"]) {
  return tutorialWorkflows.find((item) => item.id === workflowId) ?? tutorialWorkflows[0];
}

function startTutorial(workflowId: TutorialWorkflow["id"]) {
  window.dispatchEvent(new CustomEvent(tutorialStartEventName, { detail: { workflowId } }));
}

function publishTutorialHighlightRequest(state: TutorialHighlightState) {
  window.dispatchEvent(new CustomEvent(tutorialHighlightRequestEventName, { detail: state }));
}

export function getTutorialExtraHighlightTarget(workflowId: TutorialWorkflowId, legacyStepIndex: number) {
  return findTutorialWorkflow(workflowId).steps.find((step) => step.legacyStepIndex === legacyStepIndex)?.extraHighlightTarget ?? null;
}

function highlightStateForStep(workflow: TutorialWorkflow, stepIndex: number): TutorialHighlightState {
  const step = workflow.steps[stepIndex] ?? workflow.steps[0];
  return {
    active: true,
    workflowId: workflow.id,
    legacyStepIndex: step?.legacyStepIndex ?? 0,
    extraHighlightTarget: step?.extraHighlightTarget ?? null
  };
}

export function publishTutorialHighlightState(state: TutorialHighlightState) {
  window.dispatchEvent(new CustomEvent(tutorialHighlightStateEventName, { detail: state }));
}

export function subscribeTutorialHighlightRequests(listener: (state: TutorialHighlightState) => void) {
  const handleRequest = (event: Event) => {
    listener((event as CustomEvent<TutorialHighlightState>).detail);
  };
  window.addEventListener(tutorialHighlightRequestEventName, handleRequest);
  return () => window.removeEventListener(tutorialHighlightRequestEventName, handleRequest);
}

function stepIndexForLegacyStep(workflow: TutorialWorkflow, legacyStepIndex: number) {
  const exactIndex = workflow.steps.findIndex((step) => step.legacyStepIndex === legacyStepIndex);
  if (exactIndex >= 0) {
    return exactIndex;
  }
  const nextIndex = workflow.steps.findIndex((step) => step.legacyStepIndex > legacyStepIndex);
  return nextIndex >= 0 ? nextIndex : workflow.steps.length - 1;
}

export function TutorialsCard() {
  const [workflowId, setWorkflowId] = useState<TutorialWorkflow["id"]>("first_account");
  const [stepIndex, setStepIndex] = useState(0);
  const workflow = findTutorialWorkflow(workflowId);
  const currentStep = workflow.steps[stepIndex] ?? workflow.steps[0];
  const isFirstStep = stepIndex === 0;
  const isLastStep = stepIndex >= workflow.steps.length - 1;

  function chooseWorkflow(nextWorkflowId: TutorialWorkflow["id"]) {
    setWorkflowId(nextWorkflowId);
    setStepIndex(0);
  }

  return (
    <div className="card">
      <h2>Tutorials</h2>
      <p className="muted">{workflow.description}</p>
      <div className="button-row">
        {tutorialWorkflows.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === workflow.id ? "primary-button" : "secondary-button"}
            onClick={() => chooseWorkflow(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="primary-button full-span"
        onClick={() => startTutorial(workflow.id)}
      >
        Start {workflow.label.toLowerCase()} tutorial
      </button>
      <article className="tutorial-current-step">
        <p className="eyebrow">Step {stepIndex + 1} of {workflow.steps.length}</p>
        <h3>{currentStep.title}</h3>
        <p>{currentStep.goal}</p>
        <div className="instruction-box">
          <strong>Do this:</strong> {currentStep.action}
        </div>
        <div className="instruction-box">
          <strong>Check:</strong> {currentStep.check}
        </div>
      </article>
      <div className="button-row">
        <button
          type="button"
          className="secondary-button"
          disabled={isFirstStep}
          onClick={() => setStepIndex((current) => Math.max(0, current - 1))}
        >
          Previous
        </button>
        <button
          type="button"
          className={isLastStep ? "secondary-button" : "primary-button"}
          onClick={() => setStepIndex((current) => isLastStep ? 0 : Math.min(workflow.steps.length - 1, current + 1))}
        >
          {isLastStep ? "Restart" : "Next"}
        </button>
      </div>
    </div>
  );
}

export function ActiveTutorialOverlay() {
  const [activeWorkflowId, setActiveWorkflowId] = useState<TutorialWorkflow["id"] | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const workflow = activeWorkflowId == null ? null : findTutorialWorkflow(activeWorkflowId);
  const currentStep = workflow?.steps[stepIndex] ?? null;
  const isFirstStep = stepIndex === 0;
  const isLastStep = workflow != null && stepIndex >= workflow.steps.length - 1;

  useEffect(() => {
    const openTutorial = (event: Event) => {
      const detail = (event as CustomEvent<{ workflowId?: TutorialWorkflow["id"] }>).detail;
      if (detail?.workflowId) {
        const nextWorkflow = findTutorialWorkflow(detail.workflowId);
        setActiveWorkflowId(detail.workflowId);
        setStepIndex(0);
        publishTutorialHighlightRequest(highlightStateForStep(nextWorkflow, 0));
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActiveWorkflowId(null);
        publishTutorialHighlightRequest({ active: false, workflowId: "first_account", legacyStepIndex: 0, extraHighlightTarget: null });
      }
    };
    const syncFromApp = (event: Event) => {
      const detail = (event as CustomEvent<TutorialHighlightState>).detail;
      if (!detail.active) {
        setActiveWorkflowId(null);
        return;
      }
      const nextWorkflow = findTutorialWorkflow(detail.workflowId);
      setActiveWorkflowId(detail.workflowId);
      setStepIndex(stepIndexForLegacyStep(nextWorkflow, detail.legacyStepIndex));
    };
    window.addEventListener(tutorialStartEventName, openTutorial);
    window.addEventListener(tutorialHighlightStateEventName, syncFromApp);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener(tutorialStartEventName, openTutorial);
      window.removeEventListener(tutorialHighlightStateEventName, syncFromApp);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  if (!workflow || !currentStep) {
    return null;
  }

  return (
    <aside
      className="card tutorial-card"
      aria-labelledby="active-tutorial-title"
      style={{
        position: "fixed",
        right: "1rem",
        bottom: "1rem",
        zIndex: 2500,
        width: "min(24rem, calc(100vw - 2rem))",
        maxHeight: "calc(100vh - 2rem)",
        overflow: "auto"
      }}
    >
      <div className="section-header">
        <div className="title-block">
          <p className="eyebrow">{workflow.label} tutorial</p>
          <h2 id="active-tutorial-title">{currentStep.title}</h2>
          <p className="muted">Step {stepIndex + 1} of {workflow.steps.length}</p>
        </div>
        <button
          type="button"
          className="secondary-button compact-button"
          onClick={() => {
            setActiveWorkflowId(null);
            publishTutorialHighlightRequest({ active: false, workflowId: "first_account", legacyStepIndex: 0, extraHighlightTarget: null });
          }}
        >
          Hide
        </button>
      </div>
      <article className="tutorial-current-step">
        <p>{currentStep.goal}</p>
        <div className="instruction-box tutorial-click-target">
          <strong>What to do:</strong> {currentStep.action}
        </div>
        <div className="instruction-box">
          <strong>Check:</strong> {currentStep.check}
        </div>
        <div className="button-row">
          <button
            type="button"
            className="secondary-button"
            disabled={isFirstStep}
            onClick={() => {
              const nextStepIndex = Math.max(0, stepIndex - 1);
              setStepIndex(nextStepIndex);
              publishTutorialHighlightRequest(highlightStateForStep(workflow, nextStepIndex));
            }}
          >
            Back
          </button>
          <button
            type="button"
            className={isLastStep ? "primary-button" : "secondary-button"}
            onClick={() => {
              if (isLastStep) {
                setActiveWorkflowId(null);
                publishTutorialHighlightRequest({ active: false, workflowId: "first_account", legacyStepIndex: 0, extraHighlightTarget: null });
                return;
              }
              const nextStepIndex = Math.min(workflow.steps.length - 1, stepIndex + 1);
              setStepIndex(nextStepIndex);
              publishTutorialHighlightRequest(highlightStateForStep(workflow, nextStepIndex));
            }}
          >
            {isLastStep ? "Done" : "Next"}
          </button>
        </div>
      </article>
    </aside>
  );
}
