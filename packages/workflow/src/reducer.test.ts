import { describe, expect, it } from "bun:test";
import {
  initialWorkflowSnapshot,
  replayWorkflow,
  transitionWorkflow,
  type WorkflowCommand,
} from "./index.js";

const commandTypes = (commands: readonly WorkflowCommand[]): string[] =>
  commands.map((command) => command.type);

describe("workflow reducer", () => {
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
      artifactIds: [
        "linear-issue",
        "plan-1",
        "attempt-1",
        "verify-1",
        "verdict-1",
        "pr-1",
      ],
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

  it("rejects events for the wrong issue", () => {
    expect(() => transitionWorkflow(initialWorkflowSnapshot("LIN-123"), {
      type: "issue_received",
      issueId: "LIN-999",
    })).toThrow(/does not match workflow issue/i);
  });

  it("rejects illegal transitions", () => {
    expect(() => transitionWorkflow(initialWorkflowSnapshot("LIN-123"), {
      type: "plan_approved",
      issueId: "LIN-123",
    })).toThrow(/illegal transition/i);
  });

  it("loops verification failures back to development until the attempt cap is reached", () => {
    const issueId = "LIN-123";
    const started = replayWorkflow(initialWorkflowSnapshot(issueId), [
      { type: "issue_received", issueId },
      { type: "plan_drafted", issueId },
      { type: "plan_approved", issueId },
      { type: "developer_finished", issueId },
    ]).snapshot;

    const firstFailure = transitionWorkflow(started, {
      type: "verification_failed",
      issueId,
      artifactId: "verify-failed-1",
    }, { maxDeveloperAttempts: 2 });

    expect(firstFailure.snapshot.state).toBe("developing");
    expect(firstFailure.snapshot.developerAttempts).toBe(2);
    expect(commandTypes(firstFailure.commands)).toEqual(["start_developer_attempt"]);

    const secondVerification = transitionWorkflow(firstFailure.snapshot, {
      type: "developer_finished",
      issueId,
      artifactId: "attempt-2",
    });

    const secondFailure = transitionWorkflow(secondVerification.snapshot, {
      type: "verification_failed",
      issueId,
      artifactId: "verify-failed-2",
    }, { maxDeveloperAttempts: 2 });

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
});
