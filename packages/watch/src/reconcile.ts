import type { BranchPullRequest, IssueTrackerAdapter } from "@aigile/adapters";

export interface ReconcileStatusLabels {
  inReview: string; // PR open, not merged
  done: string; // PR merged
  ready: string; // PR closed without merging -> back to the queue
}

export type FindPullRequestForBranch = (
  branch: string,
  target: { owner: string; repo: string },
) => Promise<BranchPullRequest | undefined>;

export interface ReconcileIssueStatusInput {
  issueKey: string;
  currentStatus: string;
  branchName: string;
  target: { owner: string; repo: string };
  findPullRequest: FindPullRequestForBranch;
  tracker: IssueTrackerAdapter;
  labels: ReconcileStatusLabels;
}

export type ReconcileOutcome =
  | { kind: "no_pull_request" }
  | { kind: "unchanged"; status: string }
  | { kind: "updated"; from: string; to: string };

const desiredStatus = (pullRequest: BranchPullRequest, labels: ReconcileStatusLabels): string => {
  if (pullRequest.mergeState === "merged") return labels.done;
  if (pullRequest.open) return labels.inReview;
  return labels.ready; // closed without merging: return it to the ready queue
};

/**
 * Derive an issue's Linear status from its pull request state and apply it
 * idempotently (only when it differs). Decoupled from any run: given the
 * `aigile/<issue>` branch, it reconciles the source-of-truth status from the
 * source-of-truth merge state — so a manually merged or crashed run still
 * converges (PR open -> In Review, merged -> Done, closed -> back to queue).
 */
export const reconcileIssueStatus = async (
  input: ReconcileIssueStatusInput,
): Promise<ReconcileOutcome> => {
  const pullRequest = await input.findPullRequest(input.branchName, input.target);
  if (pullRequest === undefined) return { kind: "no_pull_request" };

  const desired = desiredStatus(pullRequest, input.labels);
  if (desired === input.currentStatus) return { kind: "unchanged", status: desired };

  await input.tracker.updateIssueStatus(input.issueKey, desired);
  return { kind: "updated", from: input.currentStatus, to: desired };
};
