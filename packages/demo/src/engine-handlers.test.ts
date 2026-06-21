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
    codeHost: overrides.codeHost ?? createFakeCodeHostAdapter(),
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

  it("pauses for a manual merge-policy ticket (publish, await human merge)", async () => {
    const codeHost = createFakeCodeHostAdapter();
    const result = await run(
      buildDeps({ issue: makeIssue({ description: "aigile-merge: manual" }), codeHost }),
    );

    expect(result.outcome).toBe("paused");
    expect(result.snapshot.state).toBe("merge_ready");
    // PR #1 was published but not merged.
    expect((await codeHost.getPullRequestMergeState("o/r#1")).status).toBe("unmerged");
  });

  it("pauses when the PR is not yet mergeable", async () => {
    const codeHost = createFakeCodeHostAdapter({ mergeability: "conflicting" });
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
            return attemptArtifact(`developer:LIN-1:${devCalls}`);
          }
          return defaultRunRole(roleId);
        },
      }),
    );

    expect(result.outcome).toBe("merged");
    expect(verifyCalls).toBe(2);
    expect(devCalls).toBe(2);
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
