import type { WorkflowArtifact, WorkflowEvent, WorkflowState } from "@aigile/types";
import {
  initialWorkflowSnapshot,
  replayWorkflow,
  transitionWorkflow,
  type WorkflowCommand,
  type WorkflowCommandType,
  type WorkflowPolicy,
  type WorkflowSnapshot,
} from "./reducer.js";
import type { RunStore } from "./run-store.js";

export interface WorkflowCommandContext {
  command: WorkflowCommand;
  snapshot: WorkflowSnapshot;
  artifacts: readonly WorkflowArtifact[];
}

/**
 * Performing a command's side effect yields the next event that drives the FSM
 * (e.g. run_verification -> verification_passed | verification_failed) plus any
 * artifact it produced.
 */
export interface WorkflowCommandOutput {
  event: WorkflowEvent;
  artifact?: WorkflowArtifact;
}

export type WorkflowCommandHandler = (
  context: WorkflowCommandContext,
) => Promise<WorkflowCommandOutput>;

export type WorkflowCommandHandlers = Partial<Record<WorkflowCommandType, WorkflowCommandHandler>>;

export type WorkflowOutcome =
  | "merged"
  | "satisfied"
  | "escalated"
  | "cancelled"
  | "failed"
  | "stalled";

export interface WorkflowEngineInput {
  issueId: string;
  store: RunStore;
  handlers: WorkflowCommandHandlers;
  policy?: WorkflowPolicy;
  initialArtifacts?: readonly WorkflowArtifact[];
}

export interface WorkflowEngineResult {
  snapshot: WorkflowSnapshot;
  artifacts: WorkflowArtifact[];
  outcome: WorkflowOutcome;
}

// States the engine cannot or should not advance past: terminal states plus
// "escalated" (handed off to a human; the reducer has no transitions out of it).
const STOP_STATES: ReadonlySet<WorkflowState> = new Set<WorkflowState>([
  "satisfied",
  "merged",
  "cancelled",
  "failed",
  "escalated",
]);

const isStopState = (state: WorkflowState): boolean => STOP_STATES.has(state);

const outcomeForState = (state: WorkflowState): WorkflowOutcome => {
  switch (state) {
    case "merged":
      return "merged";
    case "satisfied":
      return "satisfied";
    case "escalated":
      return "escalated";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      return "stalled";
  }
};

const mergeArtifact = (
  artifacts: readonly WorkflowArtifact[],
  artifact: WorkflowArtifact,
): WorkflowArtifact[] =>
  artifacts.some((existing) => existing.id === artifact.id)
    ? [...artifacts]
    : [...artifacts, artifact];

/**
 * Drive a workflow run to a terminal outcome by repeatedly: taking the FSM's
 * pending command, invoking its handler to perform the side effect and produce
 * the next event, applying that event through the reducer, and persisting it.
 *
 * Durable + resumable: state is reconstructed by replaying the persisted event
 * log, so re-invoking after a crash continues from where it left off. Retryable:
 * a verification_failed/checker_requested_changes event sends the FSM back to
 * `developing`, which re-emits start_developer_attempt and re-runs the handler,
 * until verification passes or the attempt budget escalates.
 */
export const runWorkflowEngine = async (
  input: WorkflowEngineInput,
): Promise<WorkflowEngineResult> => {
  const { issueId, store, handlers, policy } = input;

  let snapshot: WorkflowSnapshot;
  let artifacts: WorkflowArtifact[];
  let pending: WorkflowCommand[];

  const persisted = await store.load(issueId);
  if (persisted !== undefined && persisted.events.length > 0) {
    const replay = replayWorkflow(initialWorkflowSnapshot(issueId), persisted.events, policy);
    snapshot = replay.snapshot;
    artifacts = [...persisted.artifacts];
    pending = replay.commandLog.at(-1) ?? [];
  } else {
    snapshot = initialWorkflowSnapshot(issueId);
    artifacts = [...(input.initialArtifacts ?? [])];
    const bootstrap: WorkflowEvent = { type: "issue_received", issueId };
    const result = transitionWorkflow(snapshot, bootstrap, policy);
    snapshot = result.snapshot;
    await store.appendEvent(issueId, bootstrap, input.initialArtifacts ?? []);
    pending = result.commands;
  }

  while (!isStopState(snapshot.state)) {
    const command = pending[0];
    if (command === undefined) break; // no pending work before a stop state: stalled

    const handler = handlers[command.type];
    if (handler === undefined) {
      return { snapshot, artifacts, outcome: "stalled" };
    }

    const output = await handler({ command, snapshot, artifacts: [...artifacts] });
    if (output.artifact !== undefined) artifacts = mergeArtifact(artifacts, output.artifact);
    await store.appendEvent(
      issueId,
      output.event,
      output.artifact !== undefined ? [output.artifact] : [],
    );

    const result = transitionWorkflow(snapshot, output.event, policy);
    snapshot = result.snapshot;
    pending = result.commands;
  }

  return { snapshot, artifacts, outcome: outcomeForState(snapshot.state) };
};
