import { describe, expect, it } from "bun:test";
import {
  createGitHubCliCodeHostAdapter,
  createFakeCodeHostAdapter,
  createFakeIssueTrackerAdapter,
  createFakeReadyIssueSource,
  type CodeHostAdapter,
  type GitHubCliExec,
  issueToArtifact,
  pullRequestToArtifact,
} from "./index.js";

const createPr = (codeHost: CodeHostAdapter) =>
  codeHost.createPullRequest({
    owner: "example",
    repo: "aigile",
    branch: "aigile/LIN-123",
    baseBranch: "main",
    title: "LIN-123 Build workflow",
    body: "Implements the workflow.",
  });

const expectUnknownDefaultMergeSignals = async (codeHost: CodeHostAdapter): Promise<void> => {
  const pr = await createPr(codeHost);

  await expect(codeHost.getPullRequestMergeability(pr.id)).resolves.toMatchObject({
    status: "unknown",
  });
  await expect(codeHost.getPullRequestMergeState(pr.id)).resolves.toMatchObject({
    status: "unknown",
  });
};

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

  it("rejects unknown issue statuses when valid statuses are configured", async () => {
    const issues = createFakeIssueTrackerAdapter(
      [
        {
          id: "issue-1",
          key: "LIN-123",
          title: "Build the first workflow",
          description: "Coordinate role-based agents.",
          acceptanceCriteria: [],
          status: "Todo",
          priority: 1,
          comments: [],
        },
      ],
      { validStatusLabels: ["In Progress", "Done"] },
    );

    await expect(issues.updateIssueStatus("LIN-123", "Blocked")).rejects.toThrow(
      /Linear workflow state not found .*: Blocked/,
    );
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

  it("lists ready issues by priority before creation time", async () => {
    const source = createFakeReadyIssueSource([
      {
        id: "issue-1",
        key: "LIN-LOW",
        title: "Lower priority",
        description: "",
        acceptanceCriteria: [],
        status: "ready",
        priority: 2,
        createdAt: "2024-01-01T00:00:00.000Z",
        comments: [],
      },
      {
        id: "issue-2",
        key: "LIN-HIGH",
        title: "Higher priority",
        description: "",
        acceptanceCriteria: [],
        status: "ready",
        priority: 1,
        createdAt: "2024-02-01T00:00:00.000Z",
        comments: [],
      },
    ]);

    await expect(source.listReadyIssues()).resolves.toMatchObject([
      { key: "LIN-HIGH" },
      { key: "LIN-LOW" },
    ]);
  });

  it("lists equal-priority ready issues by oldest creation time first", async () => {
    const source = createFakeReadyIssueSource([
      {
        id: "issue-1",
        key: "LIN-NEWER",
        title: "Newer issue",
        description: "",
        acceptanceCriteria: [],
        status: "ready",
        priority: 2,
        createdAt: "2024-02-01T00:00:00.000Z",
        comments: [],
      },
      {
        id: "issue-2",
        key: "LIN-OLDER",
        title: "Older issue",
        description: "",
        acceptanceCriteria: [],
        status: "ready",
        priority: 2,
        createdAt: "2024-01-01T00:00:00.000Z",
        comments: [],
      },
    ]);

    await expect(source.listReadyIssues()).resolves.toMatchObject([
      { key: "LIN-OLDER" },
      { key: "LIN-NEWER" },
    ]);
  });

  it("lists ready issues with missing priority after explicit priorities", async () => {
    const source = createFakeReadyIssueSource([
      {
        id: "issue-1",
        key: "LIN-MISSING",
        title: "Missing priority",
        description: "",
        acceptanceCriteria: [],
        status: "ready",
        createdAt: "2024-01-01T00:00:00.000Z",
        comments: [],
      },
      {
        id: "issue-2",
        key: "LIN-EXPLICIT",
        title: "Explicit priority",
        description: "",
        acceptanceCriteria: [],
        status: "ready",
        priority: 3,
        createdAt: "2024-02-01T00:00:00.000Z",
        comments: [],
      },
    ]);

    await expect(source.listReadyIssues()).resolves.toMatchObject([
      { key: "LIN-EXPLICIT" },
      { key: "LIN-MISSING" },
    ]);
  });

  it("lists ready issues with missing creation time after explicit creation times", async () => {
    const source = createFakeReadyIssueSource([
      {
        id: "issue-1",
        key: "LIN-MISSING",
        title: "Missing createdAt",
        description: "",
        acceptanceCriteria: [],
        status: "ready",
        priority: 2,
        comments: [],
      },
      {
        id: "issue-2",
        key: "LIN-DATED",
        title: "Dated issue",
        description: "",
        acceptanceCriteria: [],
        status: "ready",
        priority: 2,
        createdAt: "2024-03-01T00:00:00.000Z",
        comments: [],
      },
    ]);

    await expect(source.listReadyIssues()).resolves.toMatchObject([
      { key: "LIN-DATED" },
      { key: "LIN-MISSING" },
    ]);
  });

  it("keeps a single ready issue unchanged", async () => {
    const source = createFakeReadyIssueSource([
      {
        id: "issue-1",
        key: "LIN-ONLY",
        title: "Only issue",
        description: "",
        acceptanceCriteria: [],
        status: "ready",
        comments: [],
      },
    ]);

    await expect(source.listReadyIssues()).resolves.toEqual([
      {
        id: "issue-1",
        key: "LIN-ONLY",
        title: "Only issue",
        description: "",
        acceptanceCriteria: [],
        status: "ready",
        comments: [],
      },
    ]);
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

  it("creates pull requests and records comments/checks/reviews", async () => {
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
    expect(pr.reviews).toEqual([]);

    await codeHost.appendPullRequestComment(pr.id, "Verifier passed");
    await codeHost.recordCheckResult(pr.id, {
      name: "aigile/verifier",
      status: "passed",
      summary: "All commands passed",
    });
    await codeHost.submitPullRequestReview(pr.id, {
      event: "approve",
      body: "Checker passed",
    });
    await codeHost.submitPullRequestReview(pr.id, {
      event: "request_changes",
      body: "Checker requested changes",
    });
    await codeHost.submitPullRequestReview(pr.id, {
      event: "comment",
      body: "Checker escalated",
    });

    expect(await codeHost.getPullRequest(pr.id)).toMatchObject({
      comments: ["Verifier passed"],
      checks: [
        {
          name: "aigile/verifier",
          status: "passed",
          summary: "All commands passed",
        },
      ],
      reviews: [
        { event: "approve", body: "Checker passed" },
        { event: "request_changes", body: "Checker requested changes" },
        { event: "comment", body: "Checker escalated" },
      ],
    });
    await expect(codeHost.listPullRequestReviews!(pr.id)).resolves.toMatchObject([
      { id: "example/aigile#1:review:1", state: "APPROVED", body: "Checker passed" },
      {
        id: "example/aigile#1:review:2",
        state: "CHANGES_REQUESTED",
        body: "Checker requested changes",
      },
      { id: "example/aigile#1:review:3", state: "COMMENTED", body: "Checker escalated" },
    ]);
  });

  it("reports configured fake pull request mergeability", async () => {
    const codeHost = createFakeCodeHostAdapter({ mergeability: "conflicting" });
    const pr = await codeHost.createPullRequest({
      owner: "example",
      repo: "aigile",
      branch: "aigile/LIN-123",
      baseBranch: "main",
      title: "LIN-123 Build workflow",
      body: "Implements the workflow.",
    });

    await expect(codeHost.getPullRequestMergeability(pr.id)).resolves.toEqual({
      status: "conflicting",
    });
  });

  it("reports configured fake pull request merge state", async () => {
    const codeHost = createFakeCodeHostAdapter({ merged: true });
    const pr = await codeHost.createPullRequest({
      owner: "example",
      repo: "aigile",
      branch: "aigile/LIN-123",
      baseBranch: "main",
      title: "LIN-123 Build workflow",
      body: "Implements the workflow.",
    });

    await expect(codeHost.getPullRequestMergeState(pr.id)).resolves.toEqual({
      status: "merged",
    });
  });

  it("reports merged fake pull request mergeability as unknown", async () => {
    const codeHost = createFakeCodeHostAdapter({ mergeability: "mergeable", merged: true });
    const pr = await codeHost.createPullRequest({
      owner: "example",
      repo: "aigile",
      branch: "aigile/LIN-123",
      baseBranch: "main",
      title: "LIN-123 Build workflow",
      body: "Implements the workflow.",
    });

    await expect(codeHost.getPullRequestMergeability(pr.id)).resolves.toEqual({
      status: "unknown",
    });
  });

  it("throws when reading an unknown fake pull request", async () => {
    const codeHost = createFakeCodeHostAdapter();

    await expect(codeHost.getPullRequest("example/aigile#404")).rejects.toThrow(
      "Pull request not found: example/aigile#404",
    );
    await expect(codeHost.getPullRequestMergeability("example/aigile#404")).rejects.toThrow(
      "Pull request not found: example/aigile#404",
    );
  });

  it.each([
    ["fake adapter", () => createFakeCodeHostAdapter()],
    [
      "github-cli adapter",
      () => {
        const exec: GitHubCliExec = async (_command, args) => {
          if (args[0] === "pr" && args[1] === "create") {
            return {
              stdout: "https://github.com/example/aigile/pull/1\n",
              stderr: "",
              exitCode: 0,
            };
          }
          if (args[0] === "pr" && args[1] === "view") {
            return { stdout: "{}", stderr: "", exitCode: 0 };
          }
          throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
        };
        return createGitHubCliCodeHostAdapter({ exec });
      },
    ],
  ])("defaults %s merge signals to unknown", async (_name, createCodeHost) => {
    await expectUnknownDefaultMergeSignals(createCodeHost());
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

  it("marks a pull request merged after mergePullRequest", async () => {
    const codeHost = createFakeCodeHostAdapter();
    const pr = await codeHost.createPullRequest({
      owner: "example",
      repo: "aigile",
      branch: "aigile/LIN-123",
      baseBranch: "main",
      title: "LIN-123 Build workflow",
      body: "Implements the workflow.",
    });

    expect((await codeHost.getPullRequestMergeState(pr.id)).status).toBe("unknown");
    await codeHost.mergePullRequest(pr.id);
    expect((await codeHost.getPullRequestMergeState(pr.id)).status).toBe("merged");
  });

  it("finds a pull request by branch and reflects its merge state", async () => {
    const codeHost = createFakeCodeHostAdapter();
    await codeHost.createPullRequest({
      owner: "o",
      repo: "r",
      branch: "aigile/LIN-1",
      baseBranch: "main",
      title: "t",
      body: "b",
    });

    const found = await codeHost.findPullRequestForBranch("aigile/LIN-1", {
      owner: "o",
      repo: "r",
    });
    expect(found).toMatchObject({ id: "o/r#1", open: true, mergeState: "unmerged" });

    await codeHost.mergePullRequest("o/r#1");
    expect(
      (await codeHost.findPullRequestForBranch("aigile/LIN-1", { owner: "o", repo: "r" }))
        ?.mergeState,
    ).toBe("merged");

    expect(
      await codeHost.findPullRequestForBranch("missing", { owner: "o", repo: "r" }),
    ).toBeUndefined();
  });
});
