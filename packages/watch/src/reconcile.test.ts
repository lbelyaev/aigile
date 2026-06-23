import { describe, expect, it } from "bun:test";
import {
  createFakeCodeHostAdapter,
  createFakeIssueTrackerAdapter,
  type BranchPullRequest,
} from "@aigile/adapters";
import { createInMemoryRunStore, initialWorkflowSnapshot, replayWorkflow } from "@aigile/workflow";
import {
  ingestExternalReviewFeedback,
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
