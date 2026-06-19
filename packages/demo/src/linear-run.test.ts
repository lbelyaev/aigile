import { describe, expect, it } from "bun:test";
import { runDemoIssueFromLinear } from "./index.js";

describe("Linear demo orchestration", () => {
  it("fetches the issue through the Linear adapter before running", async () => {
    const result = await runDemoIssueFromLinear({
      issueKey: "LIN-123",
      linearApiKey: "test-key",
      fetchGraphql: async () => ({
        issue: {
          id: "issue-id",
          identifier: "LIN-123",
          title: "Run from Linear",
          description: "Acceptance:\n- Uses Linear",
          priority: 1,
          state: { name: "Todo" },
          comments: { nodes: [] },
        },
      }),
    });

    expect(result.issueKey).toBe("LIN-123");
    expect(result.finalState).toBe("merged");
    expect(result.artifacts[0]).toMatchObject({
      id: "linear:LIN-123",
      kind: "linear.issue",
      source: "linear",
    });
    expect(result.artifacts[0]?.payload).toMatchObject({
      acceptanceCriteria: ["Uses Linear"],
    });
  });
});
