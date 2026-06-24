import type { WorkflowEvent, WorkflowState } from "@aigile/types";

export const WORKFLOW_COMMAND_TYPES = [
  "start_architect_plan",
  "request_plan_approval",
  "start_developer_attempt",
  "run_verification",
  "start_checker_review",
  "merge_pull_request",
  "sync_sources_of_truth",
  "request_human_attention",
] as const;

export type WorkflowCommandType = (typeof WORKFLOW_COMMAND_TYPES)[number];

export interface WorkflowCommand {
  type: WorkflowCommandType;
  issueId: string;
  reason?: string;
}

export interface WorkflowSnapshot {
  issueId: string;
  state: WorkflowState;
  developerAttempts: number;
  artifactIds: string[];
}

export interface WorkflowPolicy {
  maxDeveloperAttempts?: number;
  // Deep (high-blast-radius) reviews are intentionally harder to satisfy, so a
  // change-request from the deep reviewer grants a larger retry budget than the
  // light checker before escalating.
  maxDeepReviewDeveloperAttempts?: number;
}

export interface TransitionResult {
  snapshot: WorkflowSnapshot;
  commands: WorkflowCommand[];
}

export interface ReplayResult {
  snapshot: WorkflowSnapshot;
  commandLog: WorkflowCommand[][];
}

const DEFAULT_POLICY: Required<WorkflowPolicy> = {
  maxDeveloperAttempts: 3,
  maxDeepReviewDeveloperAttempts: 5,
};

export const initialWorkflowSnapshot = (issueId: string): WorkflowSnapshot => ({
  issueId,
  state: "new",
  developerAttempts: 0,
  artifactIds: [],
});

const command = (type: WorkflowCommandType, issueId: string, reason?: string): WorkflowCommand =>
  reason === undefined ? { type, issueId } : { type, issueId, reason };

const withArtifact = (snapshot: WorkflowSnapshot, event: WorkflowEvent): WorkflowSnapshot => {
  if (event.artifactId === undefined) return snapshot;
  return {
    ...snapshot,
    artifactIds: [...snapshot.artifactIds, event.artifactId],
  };
};

const moveTo = (
  snapshot: WorkflowSnapshot,
  state: WorkflowState,
  commands: WorkflowCommand[],
  event: WorkflowEvent,
  developerAttempts = snapshot.developerAttempts,
): TransitionResult => ({
  snapshot: {
    ...withArtifact(snapshot, event),
    state,
    developerAttempts,
  },
  commands,
});

const illegalTransition = (state: WorkflowState, event: WorkflowEvent): never => {
  throw new Error(`Illegal transition from "${state}" on "${event.type}"`);
};

const ensureIssueMatches = (snapshot: WorkflowSnapshot, event: WorkflowEvent): void => {
  if (snapshot.issueId !== event.issueId) {
    throw new Error(
      `Event issue "${event.issueId}" does not match workflow issue "${snapshot.issueId}"`,
    );
  }
};

const isTerminalState = (state: WorkflowState): boolean =>
  state === "satisfied" || state === "merged" || state === "cancelled" || state === "failed";

const shouldRetryDevelopment = (snapshot: WorkflowSnapshot, maxAttempts: number): boolean =>
  snapshot.developerAttempts < maxAttempts;

const retryDevelopmentOrEscalate = (
  snapshot: WorkflowSnapshot,
  event: WorkflowEvent,
  maxAttempts: number,
): TransitionResult => {
  if (!shouldRetryDevelopment(snapshot, maxAttempts)) {
    return moveTo(
      snapshot,
      "escalated",
      [command("request_human_attention", snapshot.issueId, event.reason)],
      event,
    );
  }

  const nextAttempt = snapshot.developerAttempts + 1;
  return moveTo(
    snapshot,
    "developing",
    [command("start_developer_attempt", snapshot.issueId, event.reason)],
    event,
    nextAttempt,
  );
};

const requestChangesOrEscalate = (
  snapshot: WorkflowSnapshot,
  event: WorkflowEvent,
  maxAttempts: number,
): TransitionResult => {
  if (!shouldRetryDevelopment(snapshot, maxAttempts)) {
    return moveTo(
      snapshot,
      "escalated",
      [command("request_human_attention", snapshot.issueId, event.reason)],
      event,
    );
  }

  const nextAttempt = snapshot.developerAttempts + 1;
  return moveTo(
    snapshot,
    "changes_requested",
    [command("start_developer_attempt", snapshot.issueId, event.reason)],
    event,
    nextAttempt,
  );
};

export const transitionWorkflow = (
  snapshot: WorkflowSnapshot,
  event: WorkflowEvent,
  policyOverrides: WorkflowPolicy = {},
): TransitionResult => {
  ensureIssueMatches(snapshot, event);

  const policy = { ...DEFAULT_POLICY, ...policyOverrides };

  if (isTerminalState(snapshot.state)) {
    return illegalTransition(snapshot.state, event);
  }

  if (event.type === "human_cancelled") {
    return moveTo(
      snapshot,
      "cancelled",
      [command("sync_sources_of_truth", snapshot.issueId, event.reason)],
      event,
    );
  }

  if (event.type === "timeout_elapsed" || event.type === "budget_exceeded") {
    return moveTo(
      snapshot,
      "escalated",
      [command("request_human_attention", snapshot.issueId, event.reason)],
      event,
    );
  }

  switch (snapshot.state) {
    case "new":
      if (event.type === "issue_received") {
        return moveTo(
          snapshot,
          "planning",
          [command("start_architect_plan", snapshot.issueId)],
          event,
        );
      }
      return illegalTransition(snapshot.state, event);

    case "planning":
      if (event.type === "plan_drafted") {
        return moveTo(
          snapshot,
          "awaiting_plan_approval",
          [command("request_plan_approval", snapshot.issueId)],
          event,
        );
      }
      return illegalTransition(snapshot.state, event);

    case "awaiting_plan_approval":
      if (event.type === "plan_approved") {
        return moveTo(
          snapshot,
          "developing",
          [command("start_developer_attempt", snapshot.issueId)],
          event,
          snapshot.developerAttempts + 1,
        );
      }
      if (event.type === "plan_rejected") {
        return moveTo(
          snapshot,
          "planning",
          [command("start_architect_plan", snapshot.issueId, event.reason)],
          event,
        );
      }
      return illegalTransition(snapshot.state, event);

    case "developing":
    case "changes_requested":
      if (event.type === "developer_finished") {
        return moveTo(
          snapshot,
          "verifying",
          [command("run_verification", snapshot.issueId)],
          event,
        );
      }
      return illegalTransition(snapshot.state, event);

    case "verifying":
      if (event.type === "verification_passed") {
        return moveTo(
          snapshot,
          "checking",
          [command("start_checker_review", snapshot.issueId)],
          event,
        );
      }
      if (event.type === "verification_failed") {
        return retryDevelopmentOrEscalate(snapshot, event, policy.maxDeveloperAttempts);
      }
      return illegalTransition(snapshot.state, event);

    case "checking":
      if (event.type === "work_satisfied") {
        return moveTo(
          snapshot,
          "satisfied",
          [command("sync_sources_of_truth", snapshot.issueId, event.reason)],
          event,
        );
      }
      if (event.type === "checker_passed") {
        return moveTo(
          snapshot,
          "merge_ready",
          [command("merge_pull_request", snapshot.issueId)],
          event,
        );
      }
      if (event.type === "checker_requested_changes") {
        return retryDevelopmentOrEscalate(snapshot, event, policy.maxDeveloperAttempts);
      }
      // A deep (high-blast-radius) review is harder to satisfy, so it gets the
      // larger deep-review retry budget before escalating.
      if (event.type === "review_changes_requested") {
        return requestChangesOrEscalate(snapshot, event, policy.maxDeepReviewDeveloperAttempts);
      }
      if (event.type === "checker_escalated") {
        return moveTo(
          snapshot,
          "escalated",
          [command("request_human_attention", snapshot.issueId, event.reason)],
          event,
        );
      }
      return illegalTransition(snapshot.state, event);

    case "merge_ready":
      if (event.type === "publish_failed") {
        return moveTo(
          snapshot,
          "escalated",
          [command("request_human_attention", snapshot.issueId, event.reason)],
          event,
        );
      }
      if (event.type === "merge_completed") {
        return moveTo(
          snapshot,
          "merged",
          [command("sync_sources_of_truth", snapshot.issueId)],
          event,
        );
      }
      if (event.type === "review_changes_requested") {
        return requestChangesOrEscalate(snapshot, event, policy.maxDeepReviewDeveloperAttempts);
      }
      return illegalTransition(snapshot.state, event);

    case "escalated":
      return illegalTransition(snapshot.state, event);

    case "failed":
    case "cancelled":
    case "satisfied":
    case "merged":
      return illegalTransition(snapshot.state, event);
  }
};

export const replayWorkflow = (
  initialSnapshot: WorkflowSnapshot,
  events: readonly WorkflowEvent[],
  policy?: WorkflowPolicy,
): ReplayResult => {
  let snapshot = initialSnapshot;
  const commandLog: WorkflowCommand[][] = [];

  for (const event of events) {
    const result = transitionWorkflow(snapshot, event, policy);
    snapshot = result.snapshot;
    commandLog.push(result.commands);
  }

  return { snapshot, commandLog };
};
