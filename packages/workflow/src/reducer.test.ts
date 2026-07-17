import { describe, expect, it } from "bun:test";
import {
  WORKFLOW_EVENT_TYPES,
  WORKFLOW_STATES,
  type WorkflowEvent,
  type WorkflowEventType,
  type WorkflowState,
} from "@aigile/types";
import {
  initialWorkflowSnapshot,
  replayWorkflow,
  transitionWorkflow,
  type WorkflowCommand,
  type WorkflowCommandType,
  type WorkflowSnapshot,
} from "./index.js";

const commandTypes = (commands: readonly WorkflowCommand[]): string[] =>
  commands.map((command) => command.type);

type LegalTransitionExpectation = {
  state: WorkflowState;
  command: WorkflowCommandType;
  developerAttempts?: number;
};

type TransitionExpectation = LegalTransitionExpectation | "illegal";

const expectedTransitions: Record<
  WorkflowState,
  Record<WorkflowEventType, TransitionExpectation>
> = {
  new: {
    issue_received: { state: "planning", command: "start_architect_plan" },
    plan_drafted: "illegal",
    plan_approved: "illegal",
    plan_rejected: "illegal",
    developer_finished: "illegal",
    verification_passed: "illegal",
    verification_failed: "illegal",
    checker_passed: "illegal",
    checker_requested_changes: "illegal",
    review_changes_requested: "illegal",
    human_changes_requested: "illegal",
    checker_escalated: "illegal",
    work_satisfied: "illegal",
    publish_failed: "illegal",
    publish_retry_requested: "illegal",
    human_cancelled: { state: "cancelled", command: "sync_sources_of_truth" },
    merge_completed: "illegal",
    timeout_elapsed: { state: "escalated", command: "request_human_attention" },
    budget_exceeded: { state: "escalated", command: "request_human_attention" },
    handler_failed: { state: "escalated", command: "request_human_attention" },
  },
  planning: {
    issue_received: "illegal",
    plan_drafted: { state: "awaiting_plan_approval", command: "request_plan_approval" },
    plan_approved: "illegal",
    plan_rejected: "illegal",
    developer_finished: "illegal",
    verification_passed: "illegal",
    verification_failed: "illegal",
    checker_passed: "illegal",
    checker_requested_changes: "illegal",
    review_changes_requested: "illegal",
    human_changes_requested: "illegal",
    checker_escalated: "illegal",
    work_satisfied: "illegal",
    publish_failed: "illegal",
    publish_retry_requested: "illegal",
    human_cancelled: { state: "cancelled", command: "sync_sources_of_truth" },
    merge_completed: "illegal",
    timeout_elapsed: { state: "escalated", command: "request_human_attention" },
    budget_exceeded: { state: "escalated", command: "request_human_attention" },
    handler_failed: { state: "escalated", command: "request_human_attention" },
  },
  awaiting_plan_approval: {
    issue_received: "illegal",
    plan_drafted: "illegal",
    plan_approved: {
      state: "developing",
      command: "start_developer_attempt",
      developerAttempts: 1,
    },
    plan_rejected: { state: "planning", command: "start_architect_plan" },
    developer_finished: "illegal",
    verification_passed: "illegal",
    verification_failed: "illegal",
    checker_passed: "illegal",
    checker_requested_changes: "illegal",
    review_changes_requested: "illegal",
    human_changes_requested: "illegal",
    checker_escalated: "illegal",
    work_satisfied: "illegal",
    publish_failed: "illegal",
    publish_retry_requested: "illegal",
    human_cancelled: { state: "cancelled", command: "sync_sources_of_truth" },
    merge_completed: "illegal",
    timeout_elapsed: { state: "escalated", command: "request_human_attention" },
    budget_exceeded: { state: "escalated", command: "request_human_attention" },
    handler_failed: { state: "escalated", command: "request_human_attention" },
  },
  developing: {
    issue_received: "illegal",
    plan_drafted: "illegal",
    plan_approved: "illegal",
    plan_rejected: "illegal",
    developer_finished: { state: "verifying", command: "run_verification" },
    verification_passed: "illegal",
    verification_failed: "illegal",
    checker_passed: "illegal",
    checker_requested_changes: "illegal",
    review_changes_requested: "illegal",
    human_changes_requested: "illegal",
    checker_escalated: "illegal",
    work_satisfied: "illegal",
    publish_failed: "illegal",
    publish_retry_requested: "illegal",
    human_cancelled: { state: "cancelled", command: "sync_sources_of_truth" },
    merge_completed: "illegal",
    timeout_elapsed: { state: "escalated", command: "request_human_attention" },
    budget_exceeded: { state: "escalated", command: "request_human_attention" },
    handler_failed: { state: "escalated", command: "request_human_attention" },
  },
  verifying: {
    issue_received: "illegal",
    plan_drafted: "illegal",
    plan_approved: "illegal",
    plan_rejected: "illegal",
    developer_finished: "illegal",
    verification_passed: { state: "checking", command: "start_checker_review" },
    verification_failed: {
      state: "developing",
      command: "start_developer_attempt",
      developerAttempts: 2,
    },
    checker_passed: "illegal",
    checker_requested_changes: "illegal",
    review_changes_requested: "illegal",
    human_changes_requested: "illegal",
    checker_escalated: "illegal",
    work_satisfied: "illegal",
    publish_failed: "illegal",
    publish_retry_requested: "illegal",
    human_cancelled: { state: "cancelled", command: "sync_sources_of_truth" },
    merge_completed: "illegal",
    timeout_elapsed: { state: "escalated", command: "request_human_attention" },
    budget_exceeded: { state: "escalated", command: "request_human_attention" },
    handler_failed: { state: "escalated", command: "request_human_attention" },
  },
  checking: {
    issue_received: "illegal",
    plan_drafted: "illegal",
    plan_approved: "illegal",
    plan_rejected: "illegal",
    developer_finished: "illegal",
    verification_passed: "illegal",
    verification_failed: "illegal",
    checker_passed: { state: "merge_ready", command: "merge_pull_request" },
    checker_requested_changes: {
      state: "developing",
      command: "start_developer_attempt",
      developerAttempts: 2,
    },
    review_changes_requested: {
      state: "changes_requested",
      command: "start_developer_attempt",
      developerAttempts: 2,
    },
    human_changes_requested: {
      state: "changes_requested",
      command: "start_developer_attempt",
      developerAttempts: 2,
    },
    checker_escalated: { state: "escalated", command: "request_human_attention" },
    work_satisfied: { state: "satisfied", command: "sync_sources_of_truth" },
    publish_failed: "illegal",
    publish_retry_requested: "illegal",
    human_cancelled: { state: "cancelled", command: "sync_sources_of_truth" },
    merge_completed: "illegal",
    timeout_elapsed: { state: "escalated", command: "request_human_attention" },
    budget_exceeded: { state: "escalated", command: "request_human_attention" },
    handler_failed: { state: "escalated", command: "request_human_attention" },
  },
  changes_requested: {
    issue_received: "illegal",
    plan_drafted: "illegal",
    plan_approved: "illegal",
    plan_rejected: "illegal",
    developer_finished: { state: "verifying", command: "run_verification" },
    verification_passed: "illegal",
    verification_failed: "illegal",
    checker_passed: "illegal",
    checker_requested_changes: "illegal",
    review_changes_requested: "illegal",
    human_changes_requested: "illegal",
    checker_escalated: "illegal",
    work_satisfied: "illegal",
    publish_failed: "illegal",
    publish_retry_requested: "illegal",
    human_cancelled: { state: "cancelled", command: "sync_sources_of_truth" },
    merge_completed: "illegal",
    timeout_elapsed: { state: "escalated", command: "request_human_attention" },
    budget_exceeded: { state: "escalated", command: "request_human_attention" },
    handler_failed: { state: "escalated", command: "request_human_attention" },
  },
  escalated: {
    issue_received: "illegal",
    plan_drafted: "illegal",
    plan_approved: "illegal",
    plan_rejected: "illegal",
    developer_finished: "illegal",
    verification_passed: "illegal",
    verification_failed: "illegal",
    checker_passed: "illegal",
    checker_requested_changes: "illegal",
    review_changes_requested: "illegal",
    human_changes_requested: "illegal",
    checker_escalated: "illegal",
    work_satisfied: "illegal",
    publish_failed: "illegal",
    publish_retry_requested: "illegal",
    human_cancelled: { state: "cancelled", command: "sync_sources_of_truth" },
    merge_completed: "illegal",
    timeout_elapsed: { state: "escalated", command: "request_human_attention" },
    budget_exceeded: { state: "escalated", command: "request_human_attention" },
    handler_failed: { state: "escalated", command: "request_human_attention" },
  },
  merge_ready: {
    issue_received: "illegal",
    plan_drafted: "illegal",
    plan_approved: "illegal",
    plan_rejected: "illegal",
    developer_finished: "illegal",
    verification_passed: "illegal",
    verification_failed: "illegal",
    checker_passed: "illegal",
    checker_requested_changes: "illegal",
    review_changes_requested: {
      state: "changes_requested",
      command: "start_developer_attempt",
      developerAttempts: 2,
    },
    human_changes_requested: {
      state: "changes_requested",
      command: "start_developer_attempt",
      developerAttempts: 2,
    },
    checker_escalated: "illegal",
    work_satisfied: "illegal",
    publish_failed: { state: "escalated", command: "request_human_attention" },
    publish_retry_requested: "illegal",
    human_cancelled: { state: "cancelled", command: "sync_sources_of_truth" },
    merge_completed: { state: "merged", command: "sync_sources_of_truth" },
    timeout_elapsed: { state: "escalated", command: "request_human_attention" },
    budget_exceeded: { state: "escalated", command: "request_human_attention" },
    handler_failed: { state: "escalated", command: "request_human_attention" },
  },
  satisfied: {
    issue_received: "illegal",
    plan_drafted: "illegal",
    plan_approved: "illegal",
    plan_rejected: "illegal",
    developer_finished: "illegal",
    verification_passed: "illegal",
    verification_failed: "illegal",
    checker_passed: "illegal",
    checker_requested_changes: "illegal",
    review_changes_requested: "illegal",
    human_changes_requested: "illegal",
    checker_escalated: "illegal",
    work_satisfied: "illegal",
    publish_failed: "illegal",
    publish_retry_requested: "illegal",
    human_cancelled: "illegal",
    merge_completed: "illegal",
    timeout_elapsed: "illegal",
    budget_exceeded: "illegal",
    handler_failed: "illegal",
  },
  merged: {
    issue_received: "illegal",
    plan_drafted: "illegal",
    plan_approved: "illegal",
    plan_rejected: "illegal",
    developer_finished: "illegal",
    verification_passed: "illegal",
    verification_failed: "illegal",
    checker_passed: "illegal",
    checker_requested_changes: "illegal",
    review_changes_requested: "illegal",
    human_changes_requested: "illegal",
    checker_escalated: "illegal",
    work_satisfied: "illegal",
    publish_failed: "illegal",
    publish_retry_requested: "illegal",
    human_cancelled: "illegal",
    merge_completed: "illegal",
    timeout_elapsed: "illegal",
    budget_exceeded: "illegal",
    handler_failed: "illegal",
  },
  cancelled: {
    issue_received: "illegal",
    plan_drafted: "illegal",
    plan_approved: "illegal",
    plan_rejected: "illegal",
    developer_finished: "illegal",
    verification_passed: "illegal",
    verification_failed: "illegal",
    checker_passed: "illegal",
    checker_requested_changes: "illegal",
    review_changes_requested: "illegal",
    human_changes_requested: "illegal",
    checker_escalated: "illegal",
    work_satisfied: "illegal",
    publish_failed: "illegal",
    publish_retry_requested: "illegal",
    human_cancelled: "illegal",
    merge_completed: "illegal",
    timeout_elapsed: "illegal",
    budget_exceeded: "illegal",
    handler_failed: "illegal",
  },
  failed: {
    issue_received: "illegal",
    plan_drafted: "illegal",
    plan_approved: "illegal",
    plan_rejected: "illegal",
    developer_finished: "illegal",
    verification_passed: "illegal",
    verification_failed: "illegal",
    checker_passed: "illegal",
    checker_requested_changes: "illegal",
    review_changes_requested: "illegal",
    human_changes_requested: "illegal",
    checker_escalated: "illegal",
    work_satisfied: "illegal",
    publish_failed: "illegal",
    publish_retry_requested: "illegal",
    human_cancelled: "illegal",
    merge_completed: "illegal",
    timeout_elapsed: "illegal",
    budget_exceeded: "illegal",
    handler_failed: "illegal",
  },
} satisfies Record<WorkflowState, Record<WorkflowEventType, TransitionExpectation>>;

const snapshotFor = (state: WorkflowState, developerAttempts?: number): WorkflowSnapshot => ({
  issueId: "LIN-123",
  state,
  developerAttempts:
    developerAttempts ??
    (state === "new" || state === "planning" || state === "awaiting_plan_approval" ? 0 : 1),
  artifactIds: [],
});

const eventFor = (type: WorkflowEventType, issueId = "LIN-123"): WorkflowEvent => ({
  type,
  issueId,
  artifactId: `artifact-${type}`,
  reason: `reason-${type}`,
});

describe("workflow reducer", () => {
  it("covers every state and event pair with explicit transition expectations", () => {
    for (const state of WORKFLOW_STATES) {
      for (const eventType of WORKFLOW_EVENT_TYPES) {
        const expectation = expectedTransitions[state]?.[eventType];
        expect(expectation, `missing expectation for ${state} x ${eventType}`).toBeDefined();

        const snapshot = snapshotFor(state);
        const event = eventFor(eventType, snapshot.issueId);

        if (expectation === "illegal") {
          expect(() => transitionWorkflow(snapshot, event)).toThrow(
            new RegExp(`Illegal transition from "${state}" on "${eventType}"`),
          );
          continue;
        }

        const result = transitionWorkflow(snapshot, event);

        expect(result.snapshot.state, `${state} x ${eventType} target state`).toBe(
          expectation.state,
        );
        expect(
          result.snapshot.developerAttempts,
          `${state} x ${eventType} developer attempts`,
        ).toBe(expectation.developerAttempts ?? snapshot.developerAttempts);
        expect(commandTypes(result.commands), `${state} x ${eventType} commands`).toEqual([
          expectation.command,
        ]);
      }
    }
  });

  it("asserts both retry and escalation outcomes for attempt-capped transitions", () => {
    // Deep-review change-requests are capped by maxDeepReviewDeveloperAttempts; all
    // other retry-capped transitions use maxDeveloperAttempts.
    const cappedTransitions: Array<{
      state: WorkflowState;
      eventType: WorkflowEventType;
      deep?: boolean;
    }> = [
      { state: "verifying", eventType: "verification_failed" },
      { state: "checking", eventType: "checker_requested_changes" },
      { state: "checking", eventType: "review_changes_requested", deep: true },
      { state: "checking", eventType: "human_changes_requested", deep: true },
      { state: "merge_ready", eventType: "review_changes_requested", deep: true },
      { state: "merge_ready", eventType: "human_changes_requested", deep: true },
    ];

    for (const { state, eventType, deep } of cappedTransitions) {
      const policy = deep ? { maxDeepReviewDeveloperAttempts: 2 } : { maxDeveloperAttempts: 2 };
      const retryResult = transitionWorkflow(snapshotFor(state, 1), eventFor(eventType), policy);

      const retryState =
        eventType === "review_changes_requested" || eventType === "human_changes_requested"
          ? "changes_requested"
          : "developing";
      expect(retryResult.snapshot.state, `${state} x ${eventType} retry state`).toBe(retryState);
      expect(retryResult.snapshot.developerAttempts, `${state} x ${eventType} retry attempts`).toBe(
        2,
      );
      expect(commandTypes(retryResult.commands), `${state} x ${eventType} retry commands`).toEqual([
        "start_developer_attempt",
      ]);

      const escalateResult = transitionWorkflow(snapshotFor(state, 2), eventFor(eventType), policy);

      expect(escalateResult.snapshot.state, `${state} x ${eventType} escalation state`).toBe(
        "escalated",
      );
      expect(
        escalateResult.snapshot.developerAttempts,
        `${state} x ${eventType} escalation attempts`,
      ).toBe(2);
      expect(
        commandTypes(escalateResult.commands),
        `${state} x ${eventType} escalation commands`,
      ).toEqual(["request_human_attention"]);
    }
  });

  it("gives review change-requests a larger default retry budget than the light checker", () => {
    // Light checker: still retrying at attempt 2, escalates after the 3rd (default 3).
    expect(
      transitionWorkflow(snapshotFor("checking", 2), eventFor("checker_requested_changes")).snapshot
        .state,
    ).toBe("developing");
    expect(
      transitionWorkflow(snapshotFor("checking", 3), eventFor("checker_requested_changes")).snapshot
        .state,
    ).toBe("escalated");

    // Deep review: still retrying at attempt 3/4, escalates only after the 5th (default 5).
    expect(
      transitionWorkflow(snapshotFor("checking", 3), eventFor("review_changes_requested")).snapshot
        .state,
    ).toBe("changes_requested");
    expect(
      transitionWorkflow(snapshotFor("checking", 4), eventFor("review_changes_requested")).snapshot
        .state,
    ).toBe("changes_requested");
    expect(
      transitionWorkflow(snapshotFor("checking", 5), eventFor("review_changes_requested")).snapshot
        .state,
    ).toBe("escalated");

    expect(
      transitionWorkflow(snapshotFor("merge_ready", 4), eventFor("human_changes_requested"))
        .snapshot.state,
    ).toBe("changes_requested");
    expect(
      transitionWorkflow(snapshotFor("merge_ready", 5), eventFor("human_changes_requested"))
        .snapshot.state,
    ).toBe("escalated");
  });

  it("advances the happy path through merge with explicit commands", () => {
    const issueId = "LIN-123";
    const result = replayWorkflow(initialWorkflowSnapshot(issueId), [
      { type: "issue_received", issueId, artifactId: "linear-issue" },
      { type: "plan_drafted", issueId, artifactId: "plan-1" },
      { type: "plan_approved", issueId },
      { type: "developer_finished", issueId, artifactId: "attempt-1" },
      { type: "verification_passed", issueId, artifactId: "verify-1" },
      { type: "checker_passed", issueId, artifactId: "verdict-1" },
      { type: "merge_completed", issueId, artifactId: "pr-1" },
    ]);

    expect(result.snapshot).toEqual({
      issueId,
      state: "merged",
      developerAttempts: 1,
      artifactIds: ["linear-issue", "plan-1", "attempt-1", "verify-1", "verdict-1", "pr-1"],
    });
    expect(result.commandLog.map(commandTypes)).toEqual([
      ["start_architect_plan"],
      ["request_plan_approval"],
      ["start_developer_attempt"],
      ["run_verification"],
      ["start_checker_review"],
      ["merge_pull_request"],
      ["sync_sources_of_truth"],
    ]);
  });

  it("routes human PR rework through developer verification and checker on the same run", () => {
    const issueId = "LIN-123";
    const result = replayWorkflow(initialWorkflowSnapshot(issueId), [
      { type: "issue_received", issueId, artifactId: "linear-issue" },
      { type: "plan_drafted", issueId, artifactId: "plan-1" },
      { type: "plan_approved", issueId },
      { type: "developer_finished", issueId, artifactId: "attempt-1" },
      { type: "verification_passed", issueId, artifactId: "verify-1" },
      { type: "checker_passed", issueId, artifactId: "verdict-1" },
      { type: "human_changes_requested", issueId, artifactId: "human-review-1" },
      { type: "developer_finished", issueId, artifactId: "attempt-2" },
      { type: "verification_passed", issueId, artifactId: "verify-2" },
      { type: "checker_passed", issueId, artifactId: "verdict-2" },
    ]);

    expect(result.snapshot).toEqual({
      issueId,
      state: "merge_ready",
      developerAttempts: 2,
      artifactIds: [
        "linear-issue",
        "plan-1",
        "attempt-1",
        "verify-1",
        "verdict-1",
        "human-review-1",
        "attempt-2",
        "verify-2",
        "verdict-2",
      ],
    });
    expect(result.commandLog.map(commandTypes)).toEqual([
      ["start_architect_plan"],
      ["request_plan_approval"],
      ["start_developer_attempt"],
      ["run_verification"],
      ["start_checker_review"],
      ["merge_pull_request"],
      ["start_developer_attempt"],
      ["run_verification"],
      ["start_checker_review"],
      ["merge_pull_request"],
    ]);
  });

  it("rejects events for the wrong issue", () => {
    expect(() =>
      transitionWorkflow(initialWorkflowSnapshot("LIN-123"), {
        type: "issue_received",
        issueId: "LIN-999",
      }),
    ).toThrow(/does not match workflow issue/i);
  });

  it("rejects illegal transitions", () => {
    expect(() =>
      transitionWorkflow(initialWorkflowSnapshot("LIN-123"), {
        type: "plan_approved",
        issueId: "LIN-123",
      }),
    ).toThrow(/illegal transition/i);
  });

  it("keeps terminal states terminal for human change requests", () => {
    for (const state of ["satisfied", "merged", "cancelled", "failed"] as const) {
      expect(() =>
        transitionWorkflow(snapshotFor(state), eventFor("human_changes_requested")),
      ).toThrow(new RegExp(`Illegal transition from "${state}" on "human_changes_requested"`));
    }
  });

  it("loops verification failures back to development until the attempt cap is reached", () => {
    const issueId = "LIN-123";
    const started = replayWorkflow(initialWorkflowSnapshot(issueId), [
      { type: "issue_received", issueId },
      { type: "plan_drafted", issueId },
      { type: "plan_approved", issueId },
      { type: "developer_finished", issueId },
    ]).snapshot;

    const firstFailure = transitionWorkflow(
      started,
      {
        type: "verification_failed",
        issueId,
        artifactId: "verify-failed-1",
      },
      { maxDeveloperAttempts: 2 },
    );

    expect(firstFailure.snapshot.state).toBe("developing");
    expect(firstFailure.snapshot.developerAttempts).toBe(2);
    expect(commandTypes(firstFailure.commands)).toEqual(["start_developer_attempt"]);

    const secondVerification = transitionWorkflow(firstFailure.snapshot, {
      type: "developer_finished",
      issueId,
      artifactId: "attempt-2",
    });

    const secondFailure = transitionWorkflow(
      secondVerification.snapshot,
      {
        type: "verification_failed",
        issueId,
        artifactId: "verify-failed-2",
      },
      { maxDeveloperAttempts: 2 },
    );

    expect(secondFailure.snapshot.state).toBe("escalated");
    expect(secondFailure.snapshot.developerAttempts).toBe(2);
    expect(commandTypes(secondFailure.commands)).toEqual(["request_human_attention"]);
  });

  it("routes checker change requests back to development", () => {
    const issueId = "LIN-123";
    const checking = replayWorkflow(initialWorkflowSnapshot(issueId), [
      { type: "issue_received", issueId },
      { type: "plan_drafted", issueId },
      { type: "plan_approved", issueId },
      { type: "developer_finished", issueId },
      { type: "verification_passed", issueId },
    ]).snapshot;

    const result = transitionWorkflow(checking, {
      type: "checker_requested_changes",
      issueId,
      artifactId: "verdict-changes",
    });

    expect(result.snapshot.state).toBe("developing");
    expect(result.snapshot.developerAttempts).toBe(2);
    expect(commandTypes(result.commands)).toEqual(["start_developer_attempt"]);
  });

  it("routes already satisfied work to a terminal sync state", () => {
    const issueId = "LIN-123";
    const checking = replayWorkflow(initialWorkflowSnapshot(issueId), [
      { type: "issue_received", issueId },
      { type: "plan_drafted", issueId },
      { type: "plan_approved", issueId },
      { type: "developer_finished", issueId, artifactId: "attempt-noop" },
      { type: "verification_passed", issueId, artifactId: "verify-1" },
    ]).snapshot;

    const result = transitionWorkflow(checking, {
      type: "work_satisfied",
      issueId,
      artifactId: "verdict-pass",
    });

    expect(result.snapshot.state).toBe("satisfied");
    expect(result.snapshot.artifactIds).toContain("verdict-pass");
    expect(commandTypes(result.commands)).toEqual(["sync_sources_of_truth"]);
  });

  it("routes publish failures from merge-ready to human attention", () => {
    const issueId = "LIN-123";
    const mergeReady = replayWorkflow(initialWorkflowSnapshot(issueId), [
      { type: "issue_received", issueId },
      { type: "plan_drafted", issueId },
      { type: "plan_approved", issueId },
      { type: "developer_finished", issueId },
      { type: "verification_passed", issueId },
      { type: "checker_passed", issueId },
    ]).snapshot;

    const result = transitionWorkflow(mergeReady, {
      type: "publish_failed",
      issueId,
      artifactId: "pr-1",
      reason: "gh pr comment failed: 401 Unauthorized",
    });

    expect(result.snapshot.state).toBe("escalated");
    expect(result.snapshot.artifactIds).toContain("pr-1");
    expect(commandTypes(result.commands)).toEqual(["request_human_attention"]);
  });

  it("resumes publish from an escalated publish failure without agent-phase commands", () => {
    const issueId = "LIN-123";
    const publishEscalated = replayWorkflow(initialWorkflowSnapshot(issueId), [
      { type: "issue_received", issueId },
      { type: "plan_drafted", issueId, artifactId: "plan-1" },
      { type: "plan_approved", issueId },
      { type: "developer_finished", issueId, artifactId: "attempt-1" },
      { type: "verification_passed", issueId, artifactId: "verify-1" },
      { type: "checker_passed", issueId, artifactId: "verdict-1" },
      { type: "publish_failed", issueId, reason: "git push transient failure exhausted" },
    ]).snapshot;

    const result = transitionWorkflow(publishEscalated, {
      type: "publish_retry_requested",
      issueId,
      reason: "operator requested publish retry",
    });

    expect(result.snapshot.state).toBe("merge_ready");
    expect(commandTypes(result.commands)).toEqual(["merge_pull_request"]);
  });
});
