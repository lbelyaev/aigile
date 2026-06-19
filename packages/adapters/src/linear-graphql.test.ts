import { describe, expect, it } from "bun:test";
import { createLinearGraphqlIssueTrackerAdapter } from "./index.js";

describe("Linear GraphQL issue tracker adapter", () => {
  it("fetches a Linear issue by key", async () => {
    const adapter = createLinearGraphqlIssueTrackerAdapter({
      apiKey: "test-key",
      fetchGraphql: async (_query, variables) => {
        expect(variables).toEqual({ key: "LIN-123" });
        return {
          issue: {
            id: "issue-id",
            identifier: "LIN-123",
            title: "Build Linear adapter",
            description: "Acceptance:\n- It fetches issues",
            priority: 2,
            state: { name: "Todo" },
            comments: { nodes: [{ body: "Existing comment" }] },
          },
        };
      },
    });

    await expect(adapter.getIssue("LIN-123")).resolves.toEqual({
      id: "issue-id",
      key: "LIN-123",
      title: "Build Linear adapter",
      description: "Acceptance:\n- It fetches issues",
      acceptanceCriteria: ["It fetches issues"],
      priority: 2,
      status: "Todo",
      comments: ["Existing comment"],
    });
  });

  it("updates issue status and appends comments", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const adapter = createLinearGraphqlIssueTrackerAdapter({
      apiKey: "test-key",
      fetchGraphql: async (query, variables) => {
        calls.push({ query, variables });
        return {};
      },
    });

    await adapter.updateIssueStatus("LIN-123", "In Progress");
    await adapter.appendIssueComment("LIN-123", "Plan drafted");

    expect(calls[0]!.query).toContain("issueUpdate");
    expect(calls[0]!.variables).toEqual({ key: "LIN-123", status: "In Progress" });
    expect(calls[1]!.query).toContain("commentCreate");
    expect(calls[1]!.variables).toEqual({ key: "LIN-123", body: "Plan drafted" });
  });
});
