import { describe, expect, it } from "bun:test";
import { createFakeIssueTrackerAdapter, type BranchPullRequest } from "@aigile/adapters";
import { reconcileIssueStatus, type FindPullRequestForBranch } from "./reconcile.js";

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
