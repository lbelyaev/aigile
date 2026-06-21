import { describe, expect, it } from "bun:test";
import { createFakeCodeHostAdapter } from "@aigile/adapters";
import type { CodeHostAdapter, IssueTrackerAdapter, PullRequestRecord } from "@aigile/adapters";
import {
  createRoleRuntimeRegistry,
  createScriptedRoleRunner,
  type RoleRunner,
} from "@aigile/roles";
import { runDemoIssue, runDemoIssueWithRoles } from "./index.js";

const issue = {
  id: "issue-1",
  key: "LIN-123",
  title: "Build hand-testable pipeline",
  description: "Exercise the local loop.",
  acceptanceCriteria: ["Plan exists", "Verifier passes", "PR artifact exists"],
  status: "todo" as const,
  priority: 1,
  comments: [],
};

const registry = createRoleRuntimeRegistry({
  runtimes: [
    { id: "demo-architect", transport: "stdio", command: ["demo-acp"] },
    { id: "demo-developer", transport: "stdio", command: ["demo-acp"] },
    { id: "demo-checker", transport: "stdio", command: ["demo-acp"] },
  ],
  assignments: [
    { roleId: "architect", runtimeProfileId: "demo-architect" },
    { roleId: "developer", runtimeProfileId: "demo-developer" },
    { roleId: "checker", runtimeProfileId: "demo-checker" },
  ],
});

const runnerWithCheckerVerdict = (verdict: "pass" | "changes_requested" | "escalate") =>
  createScriptedRoleRunner({
    architect: {
      artifactKind: "architect.plan",
      payload: {
        summary: "Plan",
        scope: ["demo"],
        acceptanceCriteria: ["verdict is routed"],
        verificationCommands: ["bun run check"],
        risks: [],
      },
    },
    developer: {
      artifactKind: "developer.attempt",
      payload: {
        summary: "Attempt",
        changedFiles: ["README.md"],
        verificationNotes: "Verifier runs.",
      },
    },
    checker: {
      artifactKind: "checker.verdict",
      payload: {
        verdict,
        summary: `Checker ${verdict}`,
        reasons: [`verdict=${verdict}`],
      },
    },
  });

const createRecordingIssueTracker = (): {
  issueTracker: IssueTrackerAdapter;
  statusUpdates: string[];
  comments: string[];
} => {
  const statusUpdates: string[] = [];
  const comments: string[] = [];
  return {
    statusUpdates,
    comments,
    issueTracker: {
      getIssue: async () => structuredClone(issue),
      updateIssueStatus: async (_key, status) => {
        statusUpdates.push(status);
      },
      appendIssueComment: async (_key, comment) => {
        comments.push(comment);
      },
    },
  };
};

describe("demo orchestration", () => {
  it("runs a fixture issue through the local happy path", async () => {
    const times = [1_000, 1_000, 43_100, 43_100, 61_100, 64_100, 75_100, 75_100];
    const result = await runDemoIssue({
      issue,
      now: () => times.shift() ?? 75_100,
    });

    expect(result.finalState).toBe("merge_ready");
    expect(result.pullRequest?.url).toBe("https://github.local/aigile/aigile/pull/1");
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual([
      "linear.issue",
      "architect.plan",
      "developer.attempt",
      "verification.result",
      "checker.verdict",
      "github.pull_request",
    ]);
    expect(result.pullRequest?.reviews).toEqual([
      {
        event: "approve",
        body: expect.stringContaining("## Aigile checker review"),
      },
    ]);
    expect(result.timeline).toEqual([
      { label: "issue_received -> planning", elapsedMs: 0 },
      { label: "plan_drafted -> awaiting_plan_approval", elapsedMs: 42_100 },
      { label: "plan_approved -> developing", elapsedMs: 0 },
      { label: "developer_finished -> verifying", elapsedMs: 18_000 },
      { label: "verification_passed -> checking", elapsedMs: 3_000 },
      { label: "checker_passed -> merge_ready", elapsedMs: 11_000 },
    ]);
    expect(result.durationMs).toBe(74_100);
  });

  it("publishes a readable pull request body, developer update, checker review, and final summary", async () => {
    const result = await runDemoIssueWithRoles({
      issue,
      registry,
      runner: runnerWithCheckerVerdict("pass"),
    });

    expect(result.pullRequest?.body).toContain("## LIN-123: Build hand-testable pipeline");
    expect(result.pullRequest?.body).toContain("### Summary");
    expect(result.pullRequest?.body).toContain("### Implementation");
    expect(result.pullRequest?.body).toContain("### Checker");
    expect(result.pullRequest?.comments).toEqual([
      expect.stringContaining("## Aigile developer update"),
      expect.stringContaining("## Aigile final summary"),
    ]);
    expect(result.pullRequest?.checks).toEqual([
      {
        name: "aigile/verifier",
        status: "passed",
        summary: "Local scripted verifier passed.",
      },
    ]);
    expect(result.pullRequest?.reviews).toEqual([
      {
        event: "approve",
        body: expect.stringContaining("## Aigile checker review"),
      },
    ]);
  });

  it("moves a published passing pull request to the configured review status without marking it done", async () => {
    const { issueTracker, statusUpdates, comments } = createRecordingIssueTracker();

    const result = await runDemoIssueWithRoles({
      issue,
      registry,
      runner: runnerWithCheckerVerdict("pass"),
      issueTracker,
      issueStatusLabels: {
        inReview: "Needs Review",
        done: "Completed",
      },
    });

    expect(result.finalState).toBe("merge_ready");
    expect(statusUpdates).toContain("Needs Review");
    expect(statusUpdates).not.toContain("Completed");
    expect(comments).toEqual([]);
    expect(result.timeline.map((entry) => entry.label)).not.toContain("merge_completed -> merged");
  });

  it("moves a published pull request to the configured done status only after it is merged", async () => {
    const { issueTracker, statusUpdates } = createRecordingIssueTracker();

    const result = await runDemoIssueWithRoles({
      issue,
      registry,
      runner: runnerWithCheckerVerdict("pass"),
      issueTracker,
      codeHost: createFakeCodeHostAdapter({ merged: true }),
      issueStatusLabels: {
        inReview: "Ready for QA",
        done: "Released",
      },
    });

    expect(result.finalState).toBe("merged");
    expect(statusUpdates).toContain("Ready for QA");
    expect(statusUpdates).toContain("Released");
    expect(result.timeline.map((entry) => entry.label)).toContain("merge_completed -> merged");
  });

  it("keeps conflicting pull requests in review and appends an escalation comment", async () => {
    const { issueTracker, statusUpdates, comments } = createRecordingIssueTracker();

    const result = await runDemoIssueWithRoles({
      issue,
      registry,
      runner: runnerWithCheckerVerdict("pass"),
      issueTracker,
      codeHost: createFakeCodeHostAdapter({ mergeability: "conflicting" }),
    });

    expect(result.finalState).toBe("merge_ready");
    expect(statusUpdates.at(-1)).toBe("In Review");
    expect(statusUpdates).not.toContain("Done");
    expect(comments).toEqual([expect.stringContaining("conflicting")]);
  });

  it("keeps unknown-mergeability pull requests in review and appends an escalation comment", async () => {
    const { issueTracker, statusUpdates, comments } = createRecordingIssueTracker();

    const result = await runDemoIssueWithRoles({
      issue,
      registry,
      runner: runnerWithCheckerVerdict("pass"),
      issueTracker,
      codeHost: createFakeCodeHostAdapter({ mergeability: "unknown" }),
    });

    expect(result.finalState).toBe("merge_ready");
    expect(statusUpdates.at(-1)).toBe("In Review");
    expect(statusUpdates).not.toContain("Done");
    expect(comments).toEqual([expect.stringContaining("unknown")]);
  });

  it("returns an escalated result when PR evidence publication fails after PR creation", async () => {
    let pullRequest: PullRequestRecord | undefined;
    const codeHost: CodeHostAdapter = {
      createPullRequest: async (input) => {
        pullRequest = {
          ...input,
          id: "aigile/aigile#99",
          number: 99,
          url: "https://github.local/aigile/aigile/pull/99",
          comments: [],
          checks: [],
          reviews: [],
        };
        return structuredClone(pullRequest);
      },
      getPullRequest: async () => {
        if (pullRequest === undefined) throw new Error("pull request missing");
        return structuredClone(pullRequest);
      },
      getPullRequestMergeability: async () => ({ status: "mergeable" }),
      getPullRequestMergeState: async () => ({ status: "unmerged" }),
      appendPullRequestComment: async (_id, comment) => {
        if (pullRequest === undefined) throw new Error("pull request missing");
        pullRequest.comments.push(comment);
      },
      recordCheckResult: async () => {
        throw new Error("gh pr comment failed (1): 401 Unauthorized");
      },
      submitPullRequestReview: async () => {
        throw new Error("review should not run after check publication fails");
      },
      mergePullRequest: async () => {},
      findPullRequestForBranch: async () => undefined,
    };

    const result = await runDemoIssueWithRoles({
      issue,
      registry,
      runner: runnerWithCheckerVerdict("pass"),
      codeHost,
    });

    expect(result.finalState).toBe("escalated");
    expect(result.pullRequest?.url).toBe("https://github.local/aigile/aigile/pull/99");
    expect(result.publicationFailure).toEqual({
      operation: "publish_pull_request_evidence",
      message: "gh pr comment failed (1): 401 Unauthorized",
      pullRequestUrl: "https://github.local/aigile/aigile/pull/99",
    });
    expect(result.timeline.map((entry) => entry.label)).toContain("publish_failed -> escalated");
    expect(result.artifacts.map((artifact) => artifact.kind)).toContain("github.pull_request");
  });

  it("routes checker escalation to escalated and publishes a comment review", async () => {
    const result = await runDemoIssueWithRoles({
      issue,
      registry,
      runner: runnerWithCheckerVerdict("escalate"),
    });

    expect(result.finalState).toBe("escalated");
    expect(result.pullRequest?.reviews).toEqual([
      {
        event: "comment",
        body: expect.stringContaining("## Aigile checker review"),
      },
    ]);
    expect(result.artifacts.map((artifact) => artifact.kind)).toContain("github.pull_request");
    expect(result.timeline.map((entry) => entry.label)).toContain("checker_escalated -> escalated");
    expect(result.timeline.map((entry) => entry.label)).not.toContain("merge_completed -> merged");
  });

  it("routes checker change requests back to development and publishes a request-changes review", async () => {
    const result = await runDemoIssueWithRoles({
      issue,
      registry,
      runner: runnerWithCheckerVerdict("changes_requested"),
    });

    expect(result.finalState).toBe("developing");
    expect(result.pullRequest?.reviews).toEqual([
      {
        event: "request_changes",
        body: expect.stringContaining("## Aigile checker review"),
      },
    ]);
    expect(result.artifacts.map((artifact) => artifact.kind)).toContain("github.pull_request");
    expect(result.timeline.map((entry) => entry.label)).toContain(
      "checker_requested_changes -> developing",
    );
    expect(result.timeline.map((entry) => entry.label)).not.toContain("merge_completed -> merged");
  });

  it("returns an escalated result when checker review publication fails", async () => {
    let pullRequest: PullRequestRecord | undefined;
    const result = await runDemoIssueWithRoles({
      issue,
      registry,
      runner: runnerWithCheckerVerdict("pass"),
      codeHost: {
        createPullRequest: async (input) => {
          pullRequest = {
            id: "aigile/aigile#12",
            number: 12,
            url: "https://github.local/aigile/aigile/pull/12",
            ...input,
            comments: [],
            checks: [],
            reviews: [],
          };
          return structuredClone(pullRequest);
        },
        getPullRequest: async () => {
          if (pullRequest === undefined) throw new Error("pull request missing");
          return structuredClone(pullRequest);
        },
        appendPullRequestComment: async () => undefined,
        submitPullRequestReview: async () => {
          throw new Error("review failed");
        },
        recordCheckResult: async () => undefined,
        getPullRequestMergeability: async () => ({ status: "mergeable" }),
        getPullRequestMergeState: async () => ({ status: "unmerged" }),
        mergePullRequest: async () => undefined,
        findPullRequestForBranch: async () => undefined,
      },
    });

    expect(result.finalState).toBe("escalated");
    expect(result.publicationFailure).toEqual({
      operation: "publish_pull_request_evidence",
      message: "review failed",
      pullRequestUrl: "https://github.local/aigile/aigile/pull/12",
    });
  });

  it("marks verified no-op work as satisfied without creating a pull request", async () => {
    const runner = createScriptedRoleRunner({
      architect: {
        artifactKind: "architect.plan",
        payload: {
          summary: "Plan",
          scope: ["demo"],
          acceptanceCriteria: ["already implemented"],
          verificationCommands: ["bun run check"],
          risks: [],
        },
      },
      developer: {
        artifactKind: "developer.attempt",
        payload: {
          summary: "Acceptance is already satisfied.",
          changedFiles: [],
          verificationNotes: "Verifier should prove the existing behavior.",
        },
      },
      checker: {
        artifactKind: "checker.verdict",
        payload: {
          verdict: "pass",
          summary: "Existing implementation satisfies the issue.",
          reasons: ["No changes required"],
        },
      },
    });

    const result = await runDemoIssueWithRoles({
      issue,
      registry,
      runner,
    });

    expect(result.finalState).toBe("satisfied");
    expect(result.pullRequest).toBeUndefined();
    expect(result.artifacts.map((artifact) => artifact.kind)).not.toContain("github.pull_request");
    expect(result.timeline.map((entry) => entry.label)).toContain("work_satisfied -> satisfied");
    expect(result.timeline.map((entry) => entry.label)).not.toContain("merge_completed -> merged");
  });

  it("routes failed verification back to development without checker or pull request", async () => {
    const result = await runDemoIssueWithRoles({
      issue,
      registry,
      runner: runnerWithCheckerVerdict("pass"),
      verificationArtifact: {
        id: "verifier:LIN-123:failed",
        kind: "verification.result",
        source: "verifier",
        payload: {
          status: "failed",
          commands: [
            {
              command: "bun",
              args: ["run", "check"],
              exitCode: 1,
              stdout: "",
              stderr: "failing test",
            },
          ],
        },
      },
    });

    expect(result.finalState).toBe("developing");
    expect(result.pullRequest).toBeUndefined();
    expect(result.artifacts.map((artifact) => artifact.kind)).not.toContain("checker.verdict");
    expect(result.artifacts.map((artifact) => artifact.kind)).not.toContain("github.pull_request");
    expect(result.timeline.map((entry) => entry.label)).toContain(
      "verification_failed -> developing",
    );
  });

  it.each([
    ["error status", { status: "error" }],
    ["undefined status", { status: undefined }],
    ["missing status", { summary: "Verifier omitted status." }],
    ["malformed non-object payload", "not a verification result"],
    ["malformed null payload", null],
    ["malformed array payload", []],
  ])("routes %s verification back to development", async (_case, payload) => {
    const result = await runDemoIssueWithRoles({
      issue,
      registry,
      runner: runnerWithCheckerVerdict("pass"),
      verificationArtifact: {
        id: `verifier:LIN-123:${_case}`,
        kind: "verification.result",
        source: "verifier",
        payload,
      },
    });

    expect(result.finalState).toBe("developing");
    expect(result.pullRequest).toBeUndefined();
    expect(result.artifacts.map((artifact) => artifact.kind)).not.toContain("checker.verdict");
    expect(result.artifacts.map((artifact) => artifact.kind)).not.toContain("github.pull_request");
    expect(result.timeline.map((entry) => entry.label)).toContain(
      "verification_failed -> developing",
    );
  });

  it("publishes the architect plan after approval and before developer starts", async () => {
    const order: string[] = [];
    const runner: RoleRunner = {
      run: async (input) => {
        order.push(`run:${input.roleId}`);
        if (input.roleId === "architect") {
          return {
            id: "agent:LIN-123:architect:architect.plan",
            kind: "architect.plan",
            source: "agent",
            producerRoleId: "architect",
            payload: {
              summary: "Plan",
              scope: ["demo"],
              acceptanceCriteria: ["publish before development"],
              verificationCommands: ["bun run check"],
              risks: [],
            },
          };
        }
        if (input.roleId === "developer") {
          return {
            id: "agent:LIN-123:developer:developer.attempt",
            kind: "developer.attempt",
            source: "agent",
            producerRoleId: "developer",
            payload: {
              summary: "Attempt",
              changedFiles: ["README.md"],
              verificationNotes: "Verifier runs.",
            },
          };
        }
        return {
          id: "agent:LIN-123:checker:checker.verdict",
          kind: "checker.verdict",
          source: "agent",
          producerRoleId: "checker",
          payload: {
            verdict: "pass",
            summary: "Checker passed.",
            reasons: [],
          },
        };
      },
    };

    await runDemoIssueWithRoles({
      issue,
      registry,
      runner,
      publishPlan: async (plan) => {
        order.push(`publish:${plan.kind}`);
      },
    });

    expect(order.slice(0, 3)).toEqual(["run:architect", "publish:architect.plan", "run:developer"]);
  });

  it("aborts before developer when architect plan publishing fails", async () => {
    const order: string[] = [];
    const runner: RoleRunner = {
      run: async (input) => {
        order.push(`run:${input.roleId}`);
        return {
          id: `agent:LIN-123:${input.roleId}:architect.plan`,
          kind: "architect.plan",
          source: "agent",
          producerRoleId: input.roleId,
          payload: {
            summary: "Plan",
            scope: ["demo"],
            acceptanceCriteria: ["publish fails"],
            verificationCommands: ["bun run check"],
            risks: [],
          },
        };
      },
    };

    await expect(
      runDemoIssueWithRoles({
        issue,
        registry,
        runner,
        publishPlan: async () => {
          order.push("publish:failed");
          throw new Error("Linear comment failed");
        },
      }),
    ).rejects.toThrow("Linear comment failed");

    expect(order).toEqual(["run:architect", "publish:failed"]);
  });
});
