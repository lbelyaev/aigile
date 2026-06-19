import { describe, expect, it } from "bun:test";
import { createFakeCodeHostAdapter } from "@aigile/adapters";
import { createRoleRuntimeRegistry, createScriptedRoleRunner } from "@aigile/roles";
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

describe("demo orchestration", () => {
  it("runs a fixture issue through the local happy path", async () => {
    const times = [1_000, 1_000, 43_100, 43_100, 61_100, 64_100, 75_100, 75_100];
    const result = await runDemoIssue({
      issue,
      now: () => times.shift() ?? 75_100,
    });

    expect(result.finalState).toBe("merged");
    expect(result.pullRequest?.url).toBe("https://github.local/aigile/aigile/pull/1");
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual([
      "linear.issue",
      "architect.plan",
      "developer.attempt",
      "verification.result",
      "checker.verdict",
      "github.pull_request",
    ]);
    expect(result.timeline).toEqual([
      { label: "issue_received -> planning", elapsedMs: 0 },
      { label: "plan_drafted -> awaiting_plan_approval", elapsedMs: 42_100 },
      { label: "plan_approved -> developing", elapsedMs: 0 },
      { label: "developer_finished -> verifying", elapsedMs: 18_000 },
      { label: "verification_passed -> checking", elapsedMs: 3_000 },
      { label: "checker_passed -> merge_ready", elapsedMs: 11_000 },
      { label: "merge_completed -> merged", elapsedMs: 0 },
    ]);
    expect(result.durationMs).toBe(74_100);
  });

  it("routes checker escalation to escalated without creating a pull request", async () => {
    const result = await runDemoIssueWithRoles({
      issue,
      registry,
      runner: runnerWithCheckerVerdict("escalate"),
    });

    expect(result.finalState).toBe("escalated");
    expect(result.pullRequest).toBeUndefined();
    expect(result.artifacts.map((artifact) => artifact.kind)).not.toContain("github.pull_request");
    expect(result.timeline.map((entry) => entry.label)).toContain("checker_escalated -> escalated");
    expect(result.timeline.map((entry) => entry.label)).not.toContain("merge_completed -> merged");
  });

  it("routes checker change requests back to development without creating a pull request", async () => {
    const result = await runDemoIssueWithRoles({
      issue,
      registry,
      runner: runnerWithCheckerVerdict("changes_requested"),
    });

    expect(result.finalState).toBe("developing");
    expect(result.pullRequest).toBeUndefined();
    expect(result.artifacts.map((artifact) => artifact.kind)).not.toContain("github.pull_request");
    expect(result.timeline.map((entry) => entry.label)).toContain("checker_requested_changes -> developing");
    expect(result.timeline.map((entry) => entry.label)).not.toContain("merge_completed -> merged");
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
          commands: [{
            command: "bun",
            args: ["run", "check"],
            exitCode: 1,
            stdout: "",
            stderr: "failing test",
          }],
        },
      },
    });

    expect(result.finalState).toBe("developing");
    expect(result.pullRequest).toBeUndefined();
    expect(result.artifacts.map((artifact) => artifact.kind)).not.toContain("checker.verdict");
    expect(result.artifacts.map((artifact) => artifact.kind)).not.toContain("github.pull_request");
    expect(result.timeline.map((entry) => entry.label)).toContain("verification_failed -> developing");
  });

  it("escalates instead of merging when the created pull request has conflicts", async () => {
    const result = await runDemoIssueWithRoles({
      issue,
      registry,
      runner: runnerWithCheckerVerdict("pass"),
      codeHost: createFakeCodeHostAdapter({ mergeability: "conflicting" }),
    });

    expect(result.finalState).toBe("escalated");
    expect(result.pullRequest?.url).toBe("https://github.local/aigile/aigile/pull/1");
    expect(result.pullRequest?.comments).toContain(
      "Blocked: pull request has merge conflicts and requires human attention before this issue can be marked complete: https://github.local/aigile/aigile/pull/1",
    );
    expect(result.timeline.map((entry) => entry.label)).toContain("publish_failed -> escalated");
    expect(result.timeline.map((entry) => entry.label)).not.toContain("merge_completed -> merged");
  });

  it("keeps the successful publish path unchanged when the created pull request is mergeable", async () => {
    const result = await runDemoIssueWithRoles({
      issue,
      registry,
      runner: runnerWithCheckerVerdict("pass"),
      codeHost: createFakeCodeHostAdapter({ mergeability: "mergeable" }),
    });

    expect(result.finalState).toBe("merged");
    expect(result.pullRequest?.url).toBe("https://github.local/aigile/aigile/pull/1");
    expect(result.timeline.map((entry) => entry.label)).toContain("merge_completed -> merged");
    expect(result.timeline.map((entry) => entry.label)).not.toContain("publish_failed -> escalated");
  });
});
