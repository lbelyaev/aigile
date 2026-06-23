import { describe, expect, it } from "bun:test";
import type { WorkflowArtifact } from "@aigile/types";
import {
  createFakeCodeHostAdapter,
  issueToArtifact,
  type CodeHostAdapter,
  type IssueRecord,
} from "@aigile/adapters";
import { createInMemoryRunStore, runWorkflowEngine } from "@aigile/workflow";
import { createEngineCommandHandlers, type EngineHandlerDeps } from "./engine-handlers.js";

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
    ...(overrides.mergePolicy === undefined ? {} : { mergePolicy: overrides.mergePolicy }),
  };
};

const run = (deps: EngineHandlerDeps) =>
  runWorkflowEngine({
    issueId: deps.issue.key,
    store: createInMemoryRunStore(),
    handlers: createEngineCommandHandlers(deps),
    initialArtifacts: [issueToArtifact(deps.issue)],
  });

describe("engine command handlers", () => {
  it("auto-merges a green PR end to end", async () => {
    let published = 0;
    const result = await run(buildDeps({ publish: async () => void (published += 1) }));

    expect(result.outcome).toBe("merged");
    expect(result.snapshot.state).toBe("merged");
    expect(published).toBe(1);
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

    // First merge attempt: PR is created but not mergeable -> pause.
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
    expect(first.event).toBeUndefined(); // paused
    expect(publishes).toBe(1);
    expect((await codeHost.getPullRequest("o/r#1")).number).toBe(1);

    // Re-run (resume): must NOT publish again or create a second PR.
    const second = await handlers.merge_pull_request!(ctx);
    expect(second.event).toBeUndefined();
    expect(publishes).toBe(1);
    await expect(codeHost.getPullRequest("o/r#2")).rejects.toThrow(); // no second PR
  });

  it("completes the merge on resume once the existing PR is mergeable", async () => {
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
    const paused = await handlers.merge_pull_request!(ctx);
    expect(paused.event).toBeUndefined();

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

  it("pauses when the PR is not yet mergeable", async () => {
    const codeHost = createFakeCodeHostAdapter({ mergeability: "conflicting", merged: false });
    const result = await run(buildDeps({ codeHost }));

    expect(result.outcome).toBe("paused");
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
    const result = await run(
      buildDeps({
        runRole: async (roleId) =>
          roleId === "checker" ? verdictArtifact("escalate") : defaultRunRole(roleId),
      }),
    );

    expect(result.outcome).toBe("escalated");
    expect(result.reason).toBe("looks good");
  });

  it("treats a no-change developer attempt + checker pass as satisfied", async () => {
    const result = await run(
      buildDeps({
        runRole: async (roleId) =>
          roleId === "developer" ? attemptArtifact("developer:LIN-1", []) : defaultRunRole(roleId),
      }),
    );

    expect(result.outcome).toBe("satisfied");
  });
});
