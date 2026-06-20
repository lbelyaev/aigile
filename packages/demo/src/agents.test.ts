import { describe, expect, it } from "bun:test";
import { createMockAcpConnector, runDemoIssueWithAcpRoles } from "./index.js";

describe("ACP agent demo orchestration", () => {
  it("runs the demo through the ACP role runner seam", async () => {
    const result = await runDemoIssueWithAcpRoles({
      issue: {
        id: "issue-1",
        key: "LIN-123",
        title: "Build ACP demo",
        description: "Exercise ACP role runner wiring.",
        acceptanceCriteria: ["ACP runner is used"],
        status: "todo",
        priority: 1,
        comments: [],
      },
      connector: createMockAcpConnector(),
    });

    expect(result.finalState).toBe("merge_ready");
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual([
      "linear.issue",
      "architect.plan",
      "developer.attempt",
      "verification.result",
      "checker.verdict",
      "github.pull_request",
    ]);
    expect(
      result.artifacts.find((artifact) => artifact.kind === "architect.plan")?.payload,
    ).toMatchObject({
      summary: "Mock ACP architect plan",
    });
  });
});
