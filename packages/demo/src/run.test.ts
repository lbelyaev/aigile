import { describe, expect, it } from "bun:test";
import { runDemoIssue } from "./index.js";

describe("demo orchestration", () => {
  it("runs a fixture issue through the local happy path", async () => {
    const times = [1_000, 1_000, 43_100, 43_100, 61_100, 64_100, 75_100, 75_100];
    const result = await runDemoIssue({
      issue: {
        id: "issue-1",
        key: "LIN-123",
        title: "Build hand-testable pipeline",
        description: "Exercise the local loop.",
        acceptanceCriteria: ["Plan exists", "Verifier passes", "PR artifact exists"],
        status: "todo",
        priority: 1,
        comments: [],
      },
      now: () => times.shift() ?? 75_100,
    });

    expect(result.finalState).toBe("merged");
    expect(result.pullRequest.url).toBe("https://github.local/aigile/aigile/pull/1");
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
});
