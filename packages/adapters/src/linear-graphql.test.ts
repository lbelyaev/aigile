import { describe, expect, it } from "bun:test";
import {
  createLinearGraphqlIssueTrackerAdapter,
  createLinearGraphqlReadyIssueSource,
  listLinearTeams,
  listLinearWorkflowStateNames,
} from "./index.js";

describe("Linear GraphQL issue tracker adapter", () => {
  it("fetches a Linear issue by key", async () => {
    const adapter = createLinearGraphqlIssueTrackerAdapter({
      apiKey: "test-key",
      fetchGraphql: async (query, variables) => {
        expect(query).toContain("createdAt");
        expect(variables).toEqual({ key: "LIN-123" });
        return {
          issue: {
            id: "issue-id",
            identifier: "LIN-123",
            title: "Build Linear adapter",
            description: "Acceptance:\n- It fetches issues",
            priority: 2,
            createdAt: "2024-01-01T00:00:00.000Z",
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
      createdAt: "2024-01-01T00:00:00.000Z",
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

  it("resolves Linear state names to ids before updating status", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const adapter = createLinearGraphqlIssueTrackerAdapter({
      apiKey: "test-key",
      teamKey: "ENG",
      fetchGraphql: async (query, variables) => {
        calls.push({ query, variables });
        if (query.includes("WorkflowStateByName")) {
          return { workflowStates: { nodes: [{ id: "state-in-progress", name: "In Progress" }] } };
        }
        if (query.includes("IssueIdByKey")) {
          return { issue: { id: "issue-id" } };
        }
        return {};
      },
    });

    await adapter.updateIssueStatus("LIN-123", "In Progress");

    expect(calls[0]!.query).toContain("WorkflowStateByName");
    expect(calls[0]!.variables).toEqual({ teamKey: "ENG", name: "In Progress" });
    expect(calls[1]!.query).toContain("IssueIdByKey");
    expect(calls[1]!.variables).toEqual({ key: "LIN-123" });
    expect(calls[2]!.query).toContain("issueUpdate");
    expect(calls[2]!.variables).toEqual({ key: "issue-id", status: "state-in-progress" });
  });

  it("lists ready Linear issues by team key and state name", async () => {
    const source = createLinearGraphqlReadyIssueSource({
      apiKey: "test-key",
      teamKey: "ENG",
      readyStatus: "Ready for Aigile",
      fetchGraphql: async (query, variables) => {
        expect(query).toContain("ReadyIssues");
        expect(query).toContain("createdAt");
        expect(variables).toEqual({
          teamKey: "ENG",
          readyStatus: "Ready for Aigile",
          first: 25,
        });
        return {
          issues: {
            nodes: [
              {
                id: "issue-low",
                identifier: "LIN-901",
                title: "Lower priority",
                description: "",
                priority: 2,
                createdAt: "2024-01-01T00:00:00.000Z",
                state: { name: "Ready for Aigile" },
                comments: { nodes: [] },
              },
              {
                id: "issue-high",
                identifier: "LIN-900",
                title: "Watcher skeleton",
                description: "Acceptance:\n- Claim it",
                priority: 1,
                createdAt: "2024-02-01T00:00:00.000Z",
                state: { name: "Ready for Aigile" },
                comments: { nodes: [] },
              },
            ],
          },
        };
      },
    });

    await expect(source.listReadyIssues()).resolves.toEqual([{
      id: "issue-high",
      key: "LIN-900",
      title: "Watcher skeleton",
      description: "Acceptance:\n- Claim it",
      acceptanceCriteria: ["Claim it"],
      priority: 1,
      createdAt: "2024-02-01T00:00:00.000Z",
      status: "Ready for Aigile",
      comments: [],
    }, {
      id: "issue-low",
      key: "LIN-901",
      title: "Lower priority",
      description: "",
      acceptanceCriteria: [],
      priority: 2,
      createdAt: "2024-01-01T00:00:00.000Z",
      status: "Ready for Aigile",
      comments: [],
    }]);
  });

  it("lists Linear team keys and names", async () => {
    await expect(listLinearTeams({
      apiKey: "test-key",
      fetchGraphql: async (query, variables) => {
        expect(query).toContain("LinearTeams");
        expect(variables).toEqual({ first: 100 });
        return {
          teams: {
            nodes: [
              { key: "ENG", name: "Engineering" },
              { key: "OPS", name: "Operations" },
            ],
          },
        };
      },
    })).resolves.toEqual([
      { key: "ENG", name: "Engineering" },
      { key: "OPS", name: "Operations" },
    ]);
  });

  it("lists Linear workflow state names for a team key", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

    await expect(listLinearWorkflowStateNames({
      apiKey: "test-key",
      teamKey: "ENG",
      fetchGraphql: async (query, variables) => {
        calls.push({ query, variables });
        return {
          workflowStates: {
            nodes: [
              { name: "Ready for Aigile" },
              { name: "In Progress" },
            ],
          },
        };
      },
    })).resolves.toEqual(["Ready for Aigile", "In Progress"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toContain("WorkflowStatesByTeam");
    expect(calls[0]!.variables).toEqual({ teamKey: "ENG", first: 100 });
  });
});
