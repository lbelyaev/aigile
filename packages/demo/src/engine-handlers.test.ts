import { describe, expect, it } from "bun:test";
import type { WorkflowArtifact } from "@aigile/types";
import {
  createFakeCodeHostAdapter,
  issueToArtifact,
  type CodeHostAdapter,
  type IssueRecord,
  type IssueTrackerAdapter,
} from "@aigile/adapters";
import { createInMemoryRunStore, runWorkflowEngine } from "@aigile/workflow";
import {
  createEngineCommandHandlers,
  focusedDeveloperInput,
  summarizeBestAttempt,
  type EngineHandlerDeps,
} from "./engine-handlers.js";

const makeIssue = (overrides: Partial<IssueRecord> = {}): IssueRecord => ({
  id: "lin-1",
  key: "LIN-1",
  title: "Build the thing",
  description: "",
  acceptanceCriteria: [],
  status: "Todo",
  comments: [],
  ...overrides,
});

const planArtifact = (): WorkflowArtifact => ({
  id: "architect:LIN-1",
  kind: "architect.plan",
  source: "agent",
  payload: {
    summary: "plan",
    scope: ["x"],
    acceptanceCriteria: ["a"],
    verificationCommands: [],
    risks: [],
  },
});

const attemptArtifact = (id: string, changedFiles = ["packages/x.ts"]): WorkflowArtifact => ({
  id,
  kind: "developer.attempt",
  source: "agent",
  payload: { summary: "did it", changedFiles, verificationNotes: "ok" },
});

const verdictArtifact = (
  verdict: "pass" | "changes_requested" | "escalate" = "pass",
): WorkflowArtifact => ({
  id: `checker:LIN-1:${verdict}`,
  kind: "checker.verdict",
  source: "agent",
  payload: { verdict, summary: "looks good", reasons: ["clean"] },
});

const verificationArtifact = (status: "passed" | "failed"): WorkflowArtifact => ({
  id: `verifier:LIN-1:${status}`,
  kind: "verification.result",
  source: "verifier",
  payload: { status, commands: [] },
});

const defaultRunRole = async (roleId: string): Promise<WorkflowArtifact> => {
  if (roleId === "architect") return planArtifact();
  if (roleId === "developer") return attemptArtifact("developer:LIN-1");
  if (roleId === "checker") return verdictArtifact("pass");
  throw new Error(`unexpected role ${roleId}`);
};

const buildDeps = (
  overrides: Partial<EngineHandlerDeps> & { issue?: IssueRecord; codeHost?: CodeHostAdapter } = {},
): EngineHandlerDeps => {
  const issue = overrides.issue ?? makeIssue();
  return {
    issue,
    branchName: "aigile/LIN-1",
    pullRequestTarget: { owner: "o", repo: "r", baseBranch: "main" },
    codeHost:
      overrides.codeHost ?? createFakeCodeHostAdapter({ mergeability: "mergeable", merged: false }),
    runRole: overrides.runRole ?? defaultRunRole,
    verify: overrides.verify ?? (async () => verificationArtifact("passed")),
    publish: overrides.publish ?? (async () => {}),
    ...(overrides.checkpoint === undefined ? {} : { checkpoint: overrides.checkpoint }),
    ...(overrides.restoreCheckpoint === undefined
      ? {}
      : { restoreCheckpoint: overrides.restoreCheckpoint }),
    ...(overrides.mergePolicy === undefined ? {} : { mergePolicy: overrides.mergePolicy }),
    ...(overrides.issueTracker === undefined ? {} : { issueTracker: overrides.issueTracker }),
    ...(overrides.issueStatusLabels === undefined
      ? {}
      : { issueStatusLabels: overrides.issueStatusLabels }),
    ...(overrides.publishRetry === undefined ? {} : { publishRetry: overrides.publishRetry }),
  };
};

const run = (deps: EngineHandlerDeps) =>
  runWorkflowEngine({
    issueId: deps.issue.key,
    store: createInMemoryRunStore(),
    handlers: createEngineCommandHandlers(deps),
    initialArtifacts: [issueToArtifact(deps.issue)],
  });

const strictStatusTracker = (statuses: string[], comments: string[] = []): IssueTrackerAdapter => ({
  getIssue: async () => makeIssue(),
  updateIssueStatus: async (_key, status) => {
    if (!["Todo", "In Review", "Done", "Blocked"].includes(status)) {
      throw new Error(`unresolved state name: ${status}`);
    }
    statuses.push(status);
  },
  appendIssueComment: async (_key, comment) => {
    comments.push(comment);
  },
});

describe("engine command handlers", () => {
  it("auto-merges a green PR end to end", async () => {
    let published = 0;
    const result = await run(buildDeps({ publish: async () => void (published += 1) }));

    expect(result.outcome).toBe("merged");
    expect(result.snapshot.state).toBe("merged");
    expect(published).toBe(1);
  });

  it("auto-merges only after checks are passing or absent", async () => {
    const pendingHost = createFakeCodeHostAdapter({
      mergeability: "mergeable",
      merged: false,
      checks: { "o/r#1": { status: "pending", checks: [{ name: "ci", state: "pending" }] } },
    });
    const pending = await run(buildDeps({ codeHost: pendingHost }));

    expect(pending.outcome).toBe("paused");
    expect((await pendingHost.getPullRequestMergeState("o/r#1")).status).toBe("unmerged");

    const passingHost = createFakeCodeHostAdapter({
      mergeability: "mergeable",
      merged: false,
      checks: { "o/r#1": { status: "passing", checks: [{ name: "ci", state: "passing" }] } },
    });
    const passing = await run(buildDeps({ codeHost: passingHost }));

    expect(passing.outcome).toBe("merged");
    expect((await passingHost.getPullRequestMergeState("o/r#1")).status).toBe("merged");
  });

  it("keeps a green PR in review when merge policy is manual", async () => {
    const codeHost = createFakeCodeHostAdapter({
      mergeability: "mergeable",
      merged: false,
      checks: { "o/r#1": { status: "passing", checks: [{ name: "ci", state: "passing" }] } },
    });
    const result = await run(
      buildDeps({
        issue: makeIssue({ description: "aigile-merge: manual" }),
        codeHost,
      }),
    );

    expect(result.outcome).toBe("paused");
    expect(result.snapshot.state).toBe("merge_ready");
    expect((await codeHost.getPullRequestMergeState("o/r#1")).status).toBe("unmerged");
  });

  it("does not merge when checks pass but required reviews are missing", async () => {
    const codeHost = createFakeCodeHostAdapter({
      mergeability: {
        "o/r#1": { status: "blocked", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" },
      },
      merged: false,
      checks: { "o/r#1": { status: "passing", checks: [{ name: "ci", state: "passing" }] } },
    });
    const result = await run(buildDeps({ codeHost }));

    expect(result.outcome).toBe("escalated");
    expect(result.reason).toContain("missing reviews");
    expect((await codeHost.getPullRequestMergeState("o/r#1")).status).toBe("unmerged");
  });

  it("checkpoints the attempt before review (Aider-pattern restore point)", async () => {
    const messages: string[] = [];
    const result = await run(
      buildDeps({
        checkpoint: async (message) => {
          messages.push(message);
          return `sha-${messages.length}`;
        },
      }),
    );

    expect(result.outcome).toBe("merged");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("checkpoint");
  });

  it("restores the worktree to the best checkpoint when an attempt regresses", async () => {
    const restored: string[] = [];
    let checkpointN = 0;
    let checkerN = 0;
    const findingsByReview = [1, 3, 2]; // attempt 1 is best; attempt 2 regresses
    const result = await run(
      buildDeps({
        checkpoint: async () => `sha-${(checkpointN += 1)}`,
        restoreCheckpoint: async (ref) => {
          restored.push(ref);
        },
        runRole: async (roleId, artifacts) => {
          if (roleId === "architect") return planArtifact();
          if (roleId === "developer") return attemptArtifact(`dev-${artifacts.length}`);
          if (roleId === "checker") {
            const findings = findingsByReview[checkerN] ?? 1;
            checkerN += 1;
            return {
              id: `checker:LIN-1:r${checkerN}`,
              kind: "checker.verdict",
              source: "agent",
              payload: {
                verdict: "changes_requested",
                summary: `${findings} issue(s)`,
                reasons: Array.from({ length: findings }, (_, i) => `f${i}`),
              },
            };
          }
          throw new Error(`unexpected role ${roleId}`);
        },
      }),
    );

    expect(result.outcome).toBe("escalated");
    // Attempt 3 (after the regressed attempt 2) and the escalation both reset to the
    // best checkpoint — attempt 1's sha-1.
    expect(restored).toContain("sha-1");
    expect(restored.every((ref) => ref === "sha-1")).toBe(true);
  });

  it("writes merged status through the terminal FSM command exactly once", async () => {
    const statuses: string[] = [];
    const result = await run(buildDeps({ issueTracker: strictStatusTracker(statuses) }));

    expect(result.outcome).toBe("merged");
    expect(statuses).toEqual(["Done"]);
  });

  it("auto-merges when GitHub rejects an approving review from the PR author", async () => {
    const baseCodeHost = createFakeCodeHostAdapter({ mergeability: "mergeable", merged: false });
    const codeHost: CodeHostAdapter = {
      ...baseCodeHost,
      submitPullRequestReview: async () => {
        throw new Error(
          "gh pr review failed (1): failed to create review: GraphQL: Review Can not approve your own pull request (addPullRequestReview)",
        );
      },
    };

    const result = await run(buildDeps({ codeHost }));

    expect(result.outcome).toBe("merged");
    expect(result.snapshot.state).toBe("merged");
    expect((await codeHost.getPullRequestMergeState("o/r#1")).status).toBe("merged");
    expect((await codeHost.getPullRequest("o/r#1")).comments).toContainEqual(
      expect.stringContaining("## Aigile checker review"),
    );
  });

  it("reuses an existing PR on re-run instead of publishing/creating again", async () => {
    const codeHost = createFakeCodeHostAdapter({ mergeability: "conflicting" });
    let publishes = 0;
    const deps = buildDeps({ codeHost, publish: async () => void (publishes += 1) });
    const handlers = createEngineCommandHandlers(deps);

    // First merge attempt: PR is created but terminally not mergeable.
    const ctx = {
      command: { type: "merge_pull_request" as const, issueId: "LIN-1" },
      snapshot: {
        issueId: "LIN-1",
        state: "merge_ready" as const,
        developerAttempts: 1,
        artifactIds: [],
      },
      artifacts: [],
    };
    const first = await handlers.merge_pull_request!(ctx);
    expect(first.event?.type).toBe("publish_failed");
    expect(publishes).toBe(1);
    expect((await codeHost.getPullRequest("o/r#1")).number).toBe(1);

    // Re-run (resume): must NOT publish again or create a second PR.
    const second = await handlers.merge_pull_request!(ctx);
    expect(second.event?.type).toBe("publish_failed");
    expect(publishes).toBe(1);
    await expect(codeHost.getPullRequest("o/r#2")).rejects.toThrow(); // no second PR
  });

  it("retries a transient PR-create failure before publishing failure", async () => {
    const baseCodeHost = createFakeCodeHostAdapter({ mergeability: "mergeable", merged: false });
    let createCalls = 0;
    const codeHost: CodeHostAdapter = {
      ...baseCodeHost,
      createPullRequest: async (input) => {
        createCalls += 1;
        if (createCalls === 1) throw new Error("GitHub API failed: 502 Bad Gateway");
        return baseCodeHost.createPullRequest(input);
      },
    };

    const result = await run(
      buildDeps({
        codeHost,
        publishRetry: { maxAttempts: 2, baseDelayMs: 1, sleep: async () => {} },
      }),
    );

    expect(result.outcome).toBe("merged");
    expect(createCalls).toBe(2);
  });

  it("does not retry a terminal PR-create failure", async () => {
    const baseCodeHost = createFakeCodeHostAdapter();
    let createCalls = 0;
    const codeHost: CodeHostAdapter = {
      ...baseCodeHost,
      createPullRequest: async () => {
        createCalls += 1;
        throw new Error("GitHub API failed: 401 Requires authentication");
      },
    };
    const statuses: string[] = [];
    const comments: string[] = [];

    const result = await run(
      buildDeps({
        codeHost,
        issueTracker: strictStatusTracker(statuses, comments),
        publishRetry: { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
      }),
    );

    expect(result.outcome).toBe("escalated");
    expect(createCalls).toBe(1);
    expect(comments.at(-1)).toContain("Requires authentication");
  });

  it("completes the merge on resume once the existing PR is merged", async () => {
    const codeHost = createFakeCodeHostAdapter({ mergeability: "conflicting" });
    const deps = buildDeps({ codeHost });
    const handlers = createEngineCommandHandlers(deps);
    const ctx = {
      command: { type: "merge_pull_request" as const, issueId: "LIN-1" },
      snapshot: {
        issueId: "LIN-1",
        state: "merge_ready" as const,
        developerAttempts: 1,
        artifactIds: [],
      },
      artifacts: [],
    };
    const blocked = await handlers.merge_pull_request!(ctx);
    expect(blocked.event?.type).toBe("publish_failed");

    // The PR becomes merged externally; resume should report merge_completed.
    await codeHost.mergePullRequest("o/r#1");
    const resumed = await handlers.merge_pull_request!(ctx);
    expect(resumed.event?.type).toBe("merge_completed");
  });

  it("pauses for a manual merge-policy ticket (publish, await human merge)", async () => {
    const codeHost = createFakeCodeHostAdapter();
    const result = await run(
      buildDeps({ issue: makeIssue({ description: "aigile-merge: manual" }), codeHost }),
    );

    expect(result.outcome).toBe("paused");
    expect(result.snapshot.state).toBe("merge_ready");
    // PR #1 was published but not merged.
    expect((await codeHost.getPullRequestMergeState("o/r#1")).status).toBe("unknown");
  });

  it("escalates when the PR is terminally blocked by mergeability", async () => {
    const codeHost = createFakeCodeHostAdapter({ mergeability: "conflicting", merged: false });
    const statuses: string[] = [];
    const comments: string[] = [];
    const result = await run(
      buildDeps({ codeHost, issueTracker: strictStatusTracker(statuses, comments) }),
    );

    expect(result.outcome).toBe("escalated");
    expect(result.snapshot.state).toBe("escalated");
    expect(statuses).toEqual(["Blocked"]);
    expect(comments.at(-1)).toContain("pull request has merge conflicts");
    expect((await codeHost.getPullRequestMergeState("o/r#1")).status).toBe("unmerged");
  });

  it("retries development when verification fails, then merges", async () => {
    let verifyCalls = 0;
    let devCalls = 0;
    const result = await run(
      buildDeps({
        verify: async () => {
          verifyCalls += 1;
          return verificationArtifact(verifyCalls < 2 ? "failed" : "passed");
        },
        runRole: async (roleId) => {
          if (roleId === "developer") {
            devCalls += 1;
            return attemptArtifact("developer:LIN-1");
          }
          return defaultRunRole(roleId);
        },
      }),
    );

    expect(result.outcome).toBe("merged");
    expect(verifyCalls).toBe(2);
    expect(devCalls).toBe(2);
    expect(
      result.artifacts
        .filter((artifact) => artifact.kind === "developer.attempt")
        .map((artifact) => artifact.id),
    ).toEqual(["developer:LIN-1:attempt-1", "developer:LIN-1:attempt-2"]);
    expect(
      result.artifacts
        .filter((artifact) => artifact.kind === "verification.result")
        .map((artifact) => artifact.id),
    ).toEqual(["verifier:LIN-1:failed:attempt-1", "verifier:LIN-1:passed:attempt-2"]);
  });

  it("escalates when the checker escalates", async () => {
    const statuses: string[] = [];
    const result = await run(
      buildDeps({
        issueTracker: strictStatusTracker(statuses),
        runRole: async (roleId) =>
          roleId === "checker" ? verdictArtifact("escalate") : defaultRunRole(roleId),
      }),
    );

    expect(result.outcome).toBe("escalated");
    expect(result.reason).toBe("looks good");
    expect(statuses).toEqual(["Blocked"]);
  });

  it("routes high-risk engine-path changes to the deep reviewer", async () => {
    const roles: string[] = [];
    const requestModes: string[] = [];
    const handlers = createEngineCommandHandlers(
      buildDeps({
        runRole: async (roleId, artifacts) => {
          roles.push(roleId);
          if (roleId === "deep_reviewer") {
            const request = artifacts.at(-1);
            const payload = request?.payload as { mode?: string; angle?: string } | undefined;
            requestModes.push(`${payload?.mode}:${payload?.angle}`);
            return {
              id: `checker:LIN-1:${requestModes.length}`,
              kind: "checker.verdict",
              source: "agent",
              producerRoleId: "deep_reviewer",
              payload: {
                verdict:
                  payload?.mode === "angle_pass" && payload.angle === "cross-file"
                    ? "changes_requested"
                    : "pass",
                summary: `${payload?.mode} ${payload?.angle}`,
                reasons:
                  payload?.mode === "angle_pass" && payload.angle === "cross-file"
                    ? ["missing engine-path wiring"]
                    : [],
              },
            };
          }
          throw new Error(`unexpected role ${roleId}`);
        },
      }),
    );
    const result = await handlers.start_checker_review!({
      command: { type: "start_checker_review", issueId: "LIN-1" },
      snapshot: {
        issueId: "LIN-1",
        state: "checking",
        developerAttempts: 1,
        artifactIds: [],
      },
      artifacts: [attemptArtifact("developer:LIN-1", ["packages/workflow/src/engine.ts"])],
    });

    expect(roles).toContain("deep_reviewer");
    expect(roles).not.toContain("checker");
    expect(requestModes).toEqual([
      "angle_pass:correctness",
      "angle_pass:removed-behavior",
      "angle_pass:cross-file",
      "angle_pass:tests-faithful-to-reality",
      "refute_pass:correctness",
      "refute_pass:removed-behavior",
      "refute_finding:cross-file",
      "refute_pass:tests-faithful-to-reality",
    ]);
    // A deep reviewer's change-request routes to its own event so the FSM grants
    // it the larger deep-review retry budget.
    expect(result.event?.type).toBe("review_changes_requested");
  });

  it("keeps trivial engine-path changes on the light checker", async () => {
    const roles: string[] = [];
    await run(
      buildDeps({
        runRole: async (roleId) => {
          roles.push(roleId);
          if (roleId === "architect") return planArtifact();
          if (roleId === "developer") return attemptArtifact("developer:LIN-1", ["README.md"]);
          if (roleId === "checker") return verdictArtifact("pass");
          throw new Error(`unexpected role ${roleId}`);
        },
      }),
    );

    expect(roles).toContain("checker");
    expect(roles).not.toContain("deep_reviewer");
  });

  it("treats a no-change developer attempt + checker pass as satisfied", async () => {
    const statuses: string[] = [];
    const result = await run(
      buildDeps({
        issueTracker: strictStatusTracker(statuses),
        runRole: async (roleId) =>
          roleId === "developer" ? attemptArtifact("developer:LIN-1", []) : defaultRunRole(roleId),
      }),
    );

    expect(result.outcome).toBe("satisfied");
    expect(statuses).toEqual(["Done"]);
  });

  it("reverts cancelled runs to the original issue status through the shared label map", async () => {
    const statuses: string[] = [];
    const handlers = createEngineCommandHandlers(
      buildDeps({ issueTracker: strictStatusTracker(statuses) }),
    );

    await handlers.sync_sources_of_truth!({
      command: { type: "sync_sources_of_truth", issueId: "LIN-1" },
      snapshot: {
        issueId: "LIN-1",
        state: "cancelled",
        developerAttempts: 0,
        artifactIds: [],
      },
      artifacts: [],
    });

    expect(statuses).toEqual(["Todo"]);
  });
});

describe("focusedDeveloperInput (anti-drift)", () => {
  const artifact = (id: string, kind: string): WorkflowArtifact => ({
    id,
    kind,
    source: "system",
    payload: {},
  });

  it("collapses iterative kinds to their latest while preserving other context and order", () => {
    const input: WorkflowArtifact[] = [
      artifact("issue", "linear.issue"),
      artifact("plan", "architect.plan"),
      artifact("policy", "execution.policy"),
      artifact("attempt-1", "developer.attempt"),
      artifact("verify-1", "verification.result"),
      artifact("verdict-1", "checker.verdict"),
      artifact("attempt-2", "developer.attempt"),
      artifact("verify-2", "verification.result"),
      artifact("verdict-2", "checker.verdict"),
    ];

    expect(focusedDeveloperInput(input).map((a) => a.id)).toEqual([
      "issue",
      "plan",
      "policy",
      "attempt-2",
      "verify-2",
      "verdict-2",
    ]);
  });

  it("is a no-op when there are no prior attempts or verdicts", () => {
    const input: WorkflowArtifact[] = [
      artifact("issue", "linear.issue"),
      artifact("plan", "architect.plan"),
    ];
    expect(focusedDeveloperInput(input).map((a) => a.id)).toEqual(["issue", "plan"]);
  });
});

describe("summarizeBestAttempt (escalate-the-best)", () => {
  const verdictWithFindings = (n: number): WorkflowArtifact => ({
    id: `checker:LIN-1:${n}`,
    kind: "checker.verdict",
    source: "agent",
    producerRoleId: "deep_reviewer",
    payload:
      n === 0
        ? { verdict: "pass", summary: "ok", reasons: [] }
        : {
            verdict: "changes_requested",
            summary: `${n} issue(s)`,
            reasons: Array.from({ length: n }, (_, i) => `finding-${i + 1}`),
          },
  });

  it("flags the lowest-finding attempt and its punch-list when the loop drifted", () => {
    // LBE-34 shape: 3 -> 1 -> 3 -> 3 -> 4 (escalated with the worst attempt).
    const summary = summarizeBestAttempt([3, 1, 3, 3, 4].map(verdictWithFindings));
    expect(summary).toContain("Best attempt was attempt 2 (1 finding(s))");
    expect(summary).toContain("current worktree reflects attempt 5 (4 finding(s))");
    expect(summary).toContain("- finding-1");
  });

  it("returns undefined when the last attempt is already the best", () => {
    expect(summarizeBestAttempt([3, 2, 1].map(verdictWithFindings))).toBeUndefined();
  });

  it("returns undefined with fewer than two reviews", () => {
    expect(summarizeBestAttempt([verdictWithFindings(2)])).toBeUndefined();
  });
});
