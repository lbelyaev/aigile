import { describe, expect, it } from "bun:test";
import {
  createFakeCodeHostAdapter,
  createFakeIssueTrackerAdapter,
  createFakeReadyIssueSource,
  issueToArtifact,
  pullRequestToArtifact,
} from "./index.js";

describe("fake source-of-truth adapters", () => {
  it("reads issues and records status/comment updates", async () => {
    const issues = createFakeIssueTrackerAdapter([
      {
        id: "issue-1",
        key: "LIN-123",
        title: "Build the first workflow",
        description: "Coordinate role-based agents.",
        acceptanceCriteria: ["Plan is approved", "PR is verified"],
        status: "todo",
        priority: 1,
        comments: [],
      },
    ]);

    const issue = await issues.getIssue("LIN-123");
    expect(issue.title).toBe("Build the first workflow");

    await issues.updateIssueStatus("LIN-123", "in_progress");
    await issues.appendIssueComment("LIN-123", "Planning started");

    expect(await issues.getIssue("LIN-123")).toMatchObject({
      status: "in_progress",
      comments: ["Planning started"],
    });
  });

  it("lists ready issues without exposing mutable records", async () => {
    const source = createFakeReadyIssueSource([
      {
        id: "issue-1",
        key: "LIN-123",
        title: "Ready issue",
        description: "Ready for Aigile.",
        acceptanceCriteria: [],
        status: "ready",
        comments: [],
      },
      {
        id: "issue-2",
        key: "LIN-124",
        title: "Blocked issue",
        description: "Not ready yet.",
        acceptanceCriteria: [],
        status: "blocked",
        comments: [],
      },
    ]);

    const readyIssues = await source.listReadyIssues();
    readyIssues[0]!.status = "mutated";

    expect(readyIssues.map((issue) => issue.key)).toEqual(["LIN-123"]);
    expect((await source.listReadyIssues())[0]!.status).toBe("ready");
  });

  it("turns issue records into workflow artifacts", async () => {
    const issues = createFakeIssueTrackerAdapter([
      {
        id: "issue-1",
        key: "LIN-123",
        title: "Build the first workflow",
        description: "Coordinate role-based agents.",
        acceptanceCriteria: [],
        status: "todo",
        comments: [],
      },
    ]);

    const artifact = issueToArtifact(await issues.getIssue("LIN-123"));

    expect(artifact).toEqual({
      id: "linear:LIN-123",
      kind: "linear.issue",
      source: "linear",
      payload: {
        id: "issue-1",
        key: "LIN-123",
        title: "Build the first workflow",
        description: "Coordinate role-based agents.",
        acceptanceCriteria: [],
        status: "todo",
        comments: [],
      },
    });
  });

  it("creates pull requests and records comments/checks", async () => {
    const codeHost = createFakeCodeHostAdapter();
    const pr = await codeHost.createPullRequest({
      owner: "example",
      repo: "aigile",
      branch: "aigile/LIN-123",
      baseBranch: "main",
      title: "LIN-123 Build workflow",
      body: "Implements the workflow.",
    });

    expect(pr.number).toBe(1);
    expect(pr.url).toBe("https://github.local/example/aigile/pull/1");

    await codeHost.appendPullRequestComment(pr.id, "Verifier passed");
    await codeHost.recordCheckResult(pr.id, {
      name: "aigile/verifier",
      status: "passed",
      summary: "All commands passed",
    });

    expect(await codeHost.getPullRequest(pr.id)).toMatchObject({
      comments: ["Verifier passed"],
      checks: [{
        name: "aigile/verifier",
        status: "passed",
        summary: "All commands passed",
      }],
    });
  });

  it("turns pull request records into workflow artifacts", async () => {
    const codeHost = createFakeCodeHostAdapter();
    const pr = await codeHost.createPullRequest({
      owner: "example",
      repo: "aigile",
      branch: "aigile/LIN-123",
      baseBranch: "main",
      title: "LIN-123 Build workflow",
      body: "Implements the workflow.",
    });

    expect(pullRequestToArtifact(pr)).toEqual({
      id: "github-pr:example/aigile#1",
      kind: "github.pull_request",
      source: "github",
      payload: pr,
    });
  });
});
