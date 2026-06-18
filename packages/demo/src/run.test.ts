import { describe, expect, it } from "bun:test";
import { runDemoIssue } from "./index.js";

describe("demo orchestration", () => {
  it("runs a fixture issue through the local happy path", async () => {
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
      "issue_received -> planning",
      "plan_drafted -> awaiting_plan_approval",
      "plan_approved -> developing",
      "developer_finished -> verifying",
      "verification_passed -> checking",
      "checker_passed -> merge_ready",
      "merge_completed -> merged",
    ]);
  });
});
