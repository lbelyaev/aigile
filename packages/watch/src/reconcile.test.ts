import { describe, expect, it } from "bun:test";
import {
  createFakeCodeHostAdapter,
  createFakeIssueTrackerAdapter,
  type BranchPullRequest,
} from "@aigile/adapters";
import { createInMemoryRunStore, initialWorkflowSnapshot, replayWorkflow } from "@aigile/workflow";
import {
  ingestExternalReviewFeedback,
  reconcileProducts,
  reconcileIssueStatus,
  type FindPullRequestForBranch,
} from "./reconcile.js";

const labels = { inReview: "In Review", done: "Done", ready: "Todo" };
const target = { owner: "o", repo: "r" };

const trackerFor = (status: string) =>
  createFakeIssueTrackerAdapter([
    {
      id: "i",
      key: "LIN-1",
      title: "t",
      description: "",
      acceptanceCriteria: [],
      status,
      comments: [],
    },
  ]);

const finder =
  (pullRequest: BranchPullRequest | undefined): FindPullRequestForBranch =>
  async () =>
    pullRequest;

const branchPr = (over: Partial<BranchPullRequest>): BranchPullRequest => ({
  id: "o/r#1",
  number: 1,
  url: "u",
  mergeState: "unmerged",
  open: true,
  ...over,
});

describe("reconcileIssueStatus", () => {
  it("moves a merged PR's issue to done", async () => {
    const tracker = trackerFor("In Review");
    const outcome = await reconcileIssueStatus({
      issueKey: "LIN-1",
      currentStatus: "In Review",
      branchName: "aigile/LIN-1",
      target,
      findPullRequest: finder(branchPr({ mergeState: "merged", open: false })),
      tracker,
      labels,
    });

    expect(outcome).toEqual({ kind: "updated", from: "In Review", to: "Done" });
    expect((await tracker.getIssue("LIN-1")).status).toBe("Done");
  });

  it("moves an open PR's issue to in review", async () => {
    const tracker = trackerFor("In Progress");
    const outcome = await reconcileIssueStatus({
      issueKey: "LIN-1",
      currentStatus: "In Progress",
      branchName: "aigile/LIN-1",
      target,
      findPullRequest: finder(branchPr({ open: true })),
      tracker,
      labels,
    });

    expect(outcome).toEqual({ kind: "updated", from: "In Progress", to: "In Review" });
  });

  it("is idempotent when the status already matches", async () => {
    const tracker = trackerFor("In Review");
    let updates = 0;
    const wrapped = {
      ...tracker,
      updateIssueStatus: async (key: string, status: string) => {
        updates += 1;
        await tracker.updateIssueStatus(key, status);
      },
    };
    const outcome = await reconcileIssueStatus({
      issueKey: "LIN-1",
      currentStatus: "In Review",
      branchName: "aigile/LIN-1",
      target,
      findPullRequest: finder(branchPr({ open: true })),
      tracker: wrapped,
      labels,
    });

    expect(outcome).toEqual({ kind: "unchanged", status: "In Review" });
    expect(updates).toBe(0);
  });

  it("returns a closed-without-merge PR's issue to the ready queue", async () => {
    const tracker = trackerFor("In Review");
    const outcome = await reconcileIssueStatus({
      issueKey: "LIN-1",
      currentStatus: "In Review",
      branchName: "aigile/LIN-1",
      target,
      findPullRequest: finder(branchPr({ open: false, mergeState: "unmerged" })),
      tracker,
      labels,
    });

    expect(outcome).toEqual({ kind: "updated", from: "In Review", to: "Todo" });
  });

  it("does nothing when no pull request exists for the branch", async () => {
    const tracker = trackerFor("In Review");
    const outcome = await reconcileIssueStatus({
      issueKey: "LIN-1",
      currentStatus: "In Review",
      branchName: "aigile/LIN-1",
      target,
      findPullRequest: finder(undefined),
      tracker,
      labels,
    });

    expect(outcome).toEqual({ kind: "no_pull_request" });
    expect((await tracker.getIssue("LIN-1")).status).toBe("In Review");
  });
});

const issue = (key: string, status = "In Review") => ({
  id: key,
  key,
  title: key,
  description: "",
  acceptanceCriteria: [],
  status,
  comments: [],
});

const appendRun = async (store: ReturnType<typeof createInMemoryRunStore>, issueKey: string) => {
  await store.appendEvent(issueKey, { type: "issue_received", issueId: issueKey });
};

describe("reconcileProducts", () => {
  it("scans every product run store and reconciles against that product's repo and tracker", async () => {
    const leftStore = createInMemoryRunStore();
    const rightStore = createInMemoryRunStore();
    await appendRun(leftStore, "LFT-1");
    await appendRun(rightStore, "RGT-1");
    const leftTracker = createFakeIssueTrackerAdapter([issue("LFT-1", "In Progress")]);
    const rightTracker = createFakeIssueTrackerAdapter([issue("RGT-1", "In Review")]);
    const leftCodeHost = createFakeCodeHostAdapter({ mergeability: "mergeable" });
    const rightCodeHost = createFakeCodeHostAdapter({ merged: true });
    await leftCodeHost.createPullRequest({
      owner: "left",
      repo: "repo",
      branch: "aigile/LFT-1",
      baseBranch: "main",
      title: "left",
      body: "left",
    });
    const rightPr = await rightCodeHost.createPullRequest({
      owner: "right",
      repo: "repo",
      branch: "aigile/RGT-1",
      baseBranch: "main",
      title: "right",
      body: "right",
    });
    await rightCodeHost.mergePullRequest(rightPr.id);
    const targets: Array<{ productId: string; owner: string; repo: string }> = [];

    const result = await reconcileProducts({
      productConfig: {
        products: [
          {
            id: "left-product",
            linear: { team: "ENG", project: "Left" },
            github: { repo: "left/repo", baseBranch: "main" },
            defaultRun: { startRun: true, mode: "agent_write", publish: true },
          },
          {
            id: "right-product",
            linear: { team: "ENG", project: "Right" },
            github: { repo: "right/repo", baseBranch: "main" },
            defaultRun: { startRun: true, mode: "agent_write", publish: true },
          },
        ],
      },
      createRunStore: (product) => (product.id === "left-product" ? leftStore : rightStore),
      createTracker: (product) => (product.id === "left-product" ? leftTracker : rightTracker),
      createCodeHost: (product) => {
        const codeHost = product.id === "left-product" ? leftCodeHost : rightCodeHost;
        return {
          ...codeHost,
          findPullRequestForBranch: async (branch, target) => {
            targets.push({ productId: product.id, ...target });
            return codeHost.findPullRequestForBranch(branch, target);
          },
        };
      },
      labels,
    });

    expect(await leftTracker.getIssue("LFT-1")).toMatchObject({ status: "In Review" });
    expect(await rightTracker.getIssue("RGT-1")).toMatchObject({ status: "Done" });
    expect(targets).toEqual([
      { productId: "left-product", owner: "left", repo: "repo" },
      { productId: "right-product", owner: "right", repo: "repo" },
    ]);
    expect(result.outcomes).toEqual([
      expect.objectContaining({ productId: "left-product", issueKey: "LFT-1", kind: "updated" }),
      expect.objectContaining({ productId: "right-product", issueKey: "RGT-1", kind: "updated" }),
    ]);
  });

  it("leaves closed, conflicting, and unknown pull requests not done with deduplicated notes", async () => {
    const store = createInMemoryRunStore();
    for (const key of ["LIN-1", "LIN-2", "LIN-3"]) await appendRun(store, key);
    const tracker = createFakeIssueTrackerAdapter([issue("LIN-1"), issue("LIN-2"), issue("LIN-3")]);
    let statusUpdates = 0;
    let comments = 0;
    const wrappedTracker = {
      ...tracker,
      updateIssueStatus: async (key: string, status: string) => {
        statusUpdates += 1;
        await tracker.updateIssueStatus(key, status);
      },
      appendIssueComment: async (key: string, comment: string) => {
        comments += 1;
        await tracker.appendIssueComment(key, comment);
      },
    };
    const codeHost = createFakeCodeHostAdapter({
      mergeability: {
        "org/repo#2": "conflicting",
        "org/repo#3": "unknown",
      },
    });
    const closed = await codeHost.createPullRequest({
      owner: "org",
      repo: "repo",
      branch: "aigile/LIN-1",
      baseBranch: "main",
      title: "closed",
      body: "closed",
    });
    await codeHost.mergePullRequest(closed.id);
    const conflicting = await codeHost.createPullRequest({
      owner: "org",
      repo: "repo",
      branch: "aigile/LIN-2",
      baseBranch: "main",
      title: "conflicting",
      body: "conflicting",
    });
    const unknown = await codeHost.createPullRequest({
      owner: "org",
      repo: "repo",
      branch: "aigile/LIN-3",
      baseBranch: "main",
      title: "unknown",
      body: "unknown",
    });
    const findPullRequestForBranch = async (branch: string) => {
      const pullRequest = await codeHost.findPullRequestForBranch(branch, {
        owner: "org",
        repo: "repo",
      });
      if (pullRequest?.id === closed.id)
        return { ...pullRequest, open: false, mergeState: "unmerged" as const };
      return pullRequest;
    };

    const input = {
      productConfig: {
        products: [
          {
            id: "product",
            linear: { team: "ENG", project: "Project" },
            github: { repo: "org/repo", baseBranch: "main" },
            defaultRun: { startRun: true, mode: "agent_write" as const, publish: true },
          },
        ],
      },
      createRunStore: () => store,
      createTracker: () => wrappedTracker,
      createCodeHost: () => ({ ...codeHost, findPullRequestForBranch }),
      labels,
    };

    const first = await reconcileProducts(input);
    const second = await reconcileProducts(input);

    expect(first.outcomes.map((outcome) => outcome.kind)).toEqual([
      "blocked",
      "blocked",
      "blocked",
    ]);
    expect(second.outcomes.map((outcome) => outcome.kind)).toEqual([
      "blocked_unchanged",
      "blocked_unchanged",
      "blocked_unchanged",
    ]);
    expect(statusUpdates).toBe(0);
    expect(comments).toBe(3);
    expect((await tracker.getIssue("LIN-1")).comments.at(-1)).toContain("closed without merge");
    expect((await tracker.getIssue("LIN-2")).comments.at(-1)).toContain("conflicting");
    expect((await tracker.getIssue("LIN-3")).comments.at(-1)).toContain("unknown");
    expect(conflicting.id).toBe("org/repo#2");
    expect(unknown.id).toBe("org/repo#3");
  });

  it("reports a missing pull request without aborting later runs", async () => {
    const store = createInMemoryRunStore();
    await appendRun(store, "LIN-1");
    await appendRun(store, "LIN-2");
    const tracker = createFakeIssueTrackerAdapter([
      issue("LIN-1", "In Review"),
      issue("LIN-2", "In Progress"),
    ]);
    const codeHost = createFakeCodeHostAdapter({ mergeability: "mergeable" });
    await codeHost.createPullRequest({
      owner: "org",
      repo: "repo",
      branch: "aigile/LIN-2",
      baseBranch: "main",
      title: "open",
      body: "open",
    });

    const result = await reconcileProducts({
      productConfig: {
        products: [
          {
            id: "product",
            linear: { team: "ENG", project: "Project" },
            github: { repo: "org/repo", baseBranch: "main" },
            defaultRun: { startRun: true, mode: "agent_write", publish: true },
          },
        ],
      },
      createRunStore: () => store,
      createTracker: () => tracker,
      createCodeHost: () => codeHost,
      labels,
    });

    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual(["no_pull_request", "updated"]);
    expect(await tracker.getIssue("LIN-2")).toMatchObject({ status: "In Review" });
  });
});

const seedMergeReadyRun = async (issueKey: string) => {
  const store = createInMemoryRunStore();
  for (const event of [
    { type: "issue_received" as const, issueId: issueKey },
    { type: "plan_drafted" as const, issueId: issueKey, artifactId: "plan-1" },
    { type: "plan_approved" as const, issueId: issueKey },
    { type: "developer_finished" as const, issueId: issueKey, artifactId: "attempt-1" },
    { type: "verification_passed" as const, issueId: issueKey, artifactId: "verify-1" },
    { type: "checker_passed" as const, issueId: issueKey, artifactId: "verdict-1" },
  ]) {
    await store.appendEvent(issueKey, event);
  }
  return store;
};

describe("ingestExternalReviewFeedback", () => {
  it("ingests a GitHub changes-requested review into a merge-ready run", async () => {
    const issueKey = "LIN-33";
    const store = await seedMergeReadyRun(issueKey);
    const codeHost = createFakeCodeHostAdapter();
    const pr = await codeHost.createPullRequest({
      owner: "o",
      repo: "r",
      branch: `aigile/${issueKey}`,
      baseBranch: "main",
      title: "t",
      body: "b",
    });
    await codeHost.submitPullRequestReview(pr.id, {
      event: "request_changes",
      body: "Please rework the API boundary.",
      comments: [
        {
          id: "comment-1",
          body: "This adapter should stay pure.",
          path: "packages/watch/src/reconcile.ts",
          line: 12,
        },
      ],
    });

    const outcome = await ingestExternalReviewFeedback({
      issueKey,
      branchName: `aigile/${issueKey}`,
      target,
      codeHost,
      store,
    });
    const run = await store.load(issueKey);
    const replay = replayWorkflow(initialWorkflowSnapshot(issueKey), run?.events ?? []);

    expect(outcome).toMatchObject({ kind: "ingested", source: "github" });
    expect(replay.snapshot).toMatchObject({
      state: "changes_requested",
      developerAttempts: 2,
    });
    expect(replay.snapshot.artifactIds).toContainEqual(expect.stringContaining("review-feedback"));
    expect(run?.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "review.feedback",
        source: "github",
        payload: expect.objectContaining({
          body: "Please rework the API boundary.",
          comments: [
            expect.objectContaining({
              body: "This adapter should stay pure.",
              path: "packages/watch/src/reconcile.ts",
            }),
          ],
          pullRequestId: pr.id,
        }),
      }),
    );
  });

  it("does not ingest the same GitHub review twice", async () => {
    const issueKey = "LIN-34";
    const store = await seedMergeReadyRun(issueKey);
    const codeHost = createFakeCodeHostAdapter();
    const pr = await codeHost.createPullRequest({
      owner: "o",
      repo: "r",
      branch: `aigile/${issueKey}`,
      baseBranch: "main",
      title: "t",
      body: "b",
    });
    await codeHost.submitPullRequestReview(pr.id, {
      event: "request_changes",
      body: "same review",
    });

    await ingestExternalReviewFeedback({
      issueKey,
      branchName: `aigile/${issueKey}`,
      target,
      codeHost,
      store,
    });
    const second = await ingestExternalReviewFeedback({
      issueKey,
      branchName: `aigile/${issueKey}`,
      target,
      codeHost,
      store,
    });

    expect(second).toEqual({ kind: "already_processed" });
    expect(
      (await store.load(issueKey))?.events.filter(
        (event) => event.type === "review_changes_requested",
      ),
    ).toHaveLength(1);
  });

  it("does not reopen a merged pull request", async () => {
    const issueKey = "LIN-35";
    const store = await seedMergeReadyRun(issueKey);
    const codeHost = createFakeCodeHostAdapter();
    const pr = await codeHost.createPullRequest({
      owner: "o",
      repo: "r",
      branch: `aigile/${issueKey}`,
      baseBranch: "main",
      title: "t",
      body: "b",
    });
    await codeHost.submitPullRequestReview(pr.id, {
      event: "request_changes",
      body: "too late",
    });
    await codeHost.mergePullRequest(pr.id);

    const outcome = await ingestExternalReviewFeedback({
      issueKey,
      branchName: `aigile/${issueKey}`,
      target,
      codeHost,
      store,
    });

    expect(outcome).toEqual({ kind: "merged_pull_request" });
    expect((await store.load(issueKey))?.events.map((event) => event.type)).not.toContain(
      "review_changes_requested",
    );
  });

  it("ingests a configured Linear rework status", async () => {
    const issueKey = "LIN-36";
    const store = await seedMergeReadyRun(issueKey);
    const codeHost = createFakeCodeHostAdapter();
    await codeHost.createPullRequest({
      owner: "o",
      repo: "r",
      branch: `aigile/${issueKey}`,
      baseBranch: "main",
      title: "t",
      body: "b",
    });

    const outcome = await ingestExternalReviewFeedback({
      issueKey,
      branchName: `aigile/${issueKey}`,
      target,
      codeHost,
      store,
      issue: {
        id: "i",
        key: issueKey,
        title: "t",
        description: "",
        acceptanceCriteria: [],
        status: "Rework",
        comments: [],
      },
      reworkStatus: "Rework",
    });

    expect(outcome).toMatchObject({ kind: "ingested", source: "linear" });
    expect((await store.load(issueKey))?.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "review.feedback",
        source: "linear",
        payload: expect.objectContaining({ status: "Rework" }),
      }),
    );
  });
});
