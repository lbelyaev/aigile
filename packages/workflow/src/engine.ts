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
  // The event that drives the next transition. Omit to pause the run at the
  // current state (e.g. PR published, awaiting an external merge); re-running
  // resumes and re-invokes this command's handler idempotently.
  event?: WorkflowEvent;
  artifact?: WorkflowArtifact;
}

export type WorkflowCommandHandler = (
  context: WorkflowCommandContext,
) => Promise<WorkflowCommandOutput>;

export type WorkflowCommandHandlers = Partial<Record<WorkflowCommandType, WorkflowCommandHandler>>;

export interface WorkflowStateChangeContext {
  previousSnapshot: WorkflowSnapshot;
  snapshot: WorkflowSnapshot;
  event: WorkflowEvent;
  artifacts: readonly WorkflowArtifact[];
}

export interface WorkflowStateChangeErrorContext extends WorkflowStateChangeContext {
  error: unknown;
}

export type WorkflowStateChangeHandler = (
  context: WorkflowStateChangeContext,
) => Promise<void> | void;

export type WorkflowStateChangeErrorHandler = (
  context: WorkflowStateChangeErrorContext,
) => Promise<void> | void;

export type WorkflowOutcome =
  | "merged"
  | "satisfied"
  | "escalated"
  | "cancelled"
  | "failed"
  | "paused"
  | "stalled";

export interface WorkflowEngineInput {
  issueId: string;
  store: RunStore;
  handlers: WorkflowCommandHandlers;
  policy?: WorkflowPolicy;
  initialArtifacts?: readonly WorkflowArtifact[];
  onStateChange?: WorkflowStateChangeHandler;
  onStateChangeError?: WorkflowStateChangeErrorHandler;
}

export interface WorkflowEngineResult {
  snapshot: WorkflowSnapshot;
  artifacts: WorkflowArtifact[];
  outcome: WorkflowOutcome;
  // Why the run ended where it did (e.g. the escalation reason), when available.
  reason?: string;
}

const buildResult = (
  snapshot: WorkflowSnapshot,
  artifacts: WorkflowArtifact[],
  outcome: WorkflowOutcome,
  reason: string | undefined,
): WorkflowEngineResult => {
  const result: WorkflowEngineResult = { snapshot, artifacts, outcome };
  if (reason !== undefined) result.reason = reason;
  return result;
};

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

/**
 * Issue ids of persisted runs that have not reached a stop state — i.e. runs
 * that were interrupted (crash/restart) or paused (awaiting an external merge)
 * and can be re-driven by runWorkflowEngine to continue from where they left off.
 */
export const listResumableRuns = async (
  store: RunStore,
  policy?: WorkflowPolicy,
): Promise<string[]> => {
  const issueIds = await store.list();
  const resumable: string[] = [];
  for (const issueId of issueIds) {
    const run = await store.load(issueId);
    if (run === undefined || run.events.length === 0) continue;
    const { snapshot } = replayWorkflow(initialWorkflowSnapshot(issueId), run.events, policy);
    if (!isStopState(snapshot.state)) resumable.push(issueId);
  }
  return resumable;
};

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
    : [...artifacts, structuredClone(artifact)];

const notifyStateChange = async (
  input: Pick<WorkflowEngineInput, "onStateChange" | "onStateChangeError">,
  context: WorkflowStateChangeContext,
): Promise<void> => {
  if (context.previousSnapshot.state === context.snapshot.state) return;
  if (input.onStateChange === undefined) return;
  try {
    await input.onStateChange(context);
  } catch (error) {
    await input.onStateChangeError?.({ ...context, error });
  }
};

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
  let dispatchStopCommand = false;

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
    const previousSnapshot = snapshot;
    const result = transitionWorkflow(snapshot, bootstrap, policy);
    snapshot = result.snapshot;
    await store.appendEvent(issueId, bootstrap, input.initialArtifacts ?? []);
    await notifyStateChange(input, {
      previousSnapshot,
      snapshot,
      event: bootstrap,
      artifacts: [...artifacts],
    });
    pending = result.commands;
  }

  while (!isStopState(snapshot.state)) {
    const command = pending[0];
    if (command === undefined) break; // no pending work before a stop state: stalled

    const handler = handlers[command.type];
    if (handler === undefined) {
      return buildResult(snapshot, artifacts, "stalled", command.reason);
    }

    let output: WorkflowCommandOutput;
    try {
      output = await handler({ command, snapshot, artifacts: [...artifacts] });
    } catch (error) {
      // A handler/role/tool failure must escalate gracefully, never abort the run.
      // Persist a handler_failed event so the escalation is durable and replayable,
      // then let the FSM route to request_human_attention.
      const detail = error instanceof Error ? error.message : String(error);
      const failureEvent: WorkflowEvent = {
        type: "handler_failed",
        issueId,
        reason: `${command.type} failed: ${detail}`,
      };
      await store.appendEvent(issueId, failureEvent, []);
      const previousSnapshot = snapshot;
      const result = transitionWorkflow(snapshot, failureEvent, policy);
      snapshot = result.snapshot;
      await notifyStateChange(input, {
        previousSnapshot,
        snapshot,
        event: failureEvent,
        artifacts: [...artifacts],
      });
      pending = result.commands;
      dispatchStopCommand = isStopState(snapshot.state);
      continue;
    }
    if (output.artifact !== undefined) artifacts = mergeArtifact(artifacts, output.artifact);
    if (output.event === undefined) {
      // Handler performed its side effect but produced no transition: pause here.
      // Nothing is persisted, so re-running re-invokes this command idempotently
      // (e.g. re-check whether the published PR has merged yet).
      return buildResult(snapshot, artifacts, "paused", command.reason);
    }
    await store.appendEvent(
      issueId,
      output.event,
      output.artifact !== undefined ? [output.artifact] : [],
    );

    const previousSnapshot = snapshot;
    const result = transitionWorkflow(snapshot, output.event, policy);
    snapshot = result.snapshot;
    await notifyStateChange(input, {
      previousSnapshot,
      snapshot,
      event: output.event,
      artifacts: [...artifacts],
    });
    pending = result.commands;
    dispatchStopCommand = isStopState(snapshot.state);
  }

  if (isStopState(snapshot.state) && dispatchStopCommand) {
    const command = pending[0];
    const handler = command === undefined ? undefined : handlers[command.type];
    if (command !== undefined && handler !== undefined) {
      try {
        const output = await handler({ command, snapshot, artifacts: [...artifacts] });
        if (output.artifact !== undefined) artifacts = mergeArtifact(artifacts, output.artifact);
      } catch {
        // Best-effort terminal side effect (e.g. status sync on escalation). The run
        // has already reached a stop state; a failure here must not abort the result.
      }
    }
  }

  return buildResult(snapshot, artifacts, outcomeForState(snapshot.state), pending[0]?.reason);
};
