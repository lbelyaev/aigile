import type { WorkflowArtifact } from "@aigile/types";

export interface IssueRecord {
  id: string;
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: string;
  project?: {
    id: string;
    name: string;
    key?: string;
    slug?: string;
  };
  priority?: number;
  createdAt?: string;
  comments: string[];
}

export interface IssueTrackerAdapter {
  getIssue: (key: string) => Promise<IssueRecord>;
  updateIssueStatus: (key: string, status: string) => Promise<void>;
  appendIssueComment: (key: string, comment: string) => Promise<void>;
}

export interface ReadyIssueSource {
  listReadyIssues: () => Promise<IssueRecord[]>;
}

export interface PullRequestInput {
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}

export interface CheckResult {
  name: string;
  status: "passed" | "failed" | "cancelled";
  summary: string;
}

export interface PullRequestReviewInput {
  event: "approve" | "request_changes" | "comment";
  body: string;
}

export type PullRequestMergeabilityStatus = "mergeable" | "conflicting" | "unknown";

export interface PullRequestMergeability {
  status: PullRequestMergeabilityStatus;
  mergeable?: string;
  mergeStateStatus?: string;
}

export type PullRequestMergeStateStatus = "merged" | "unmerged" | "unknown";

export interface PullRequestMergeState {
  status: PullRequestMergeStateStatus;
  state?: string;
  merged?: boolean;
  mergedAt?: string;
}

export interface PullRequestRecord extends PullRequestInput {
  id: string;
  number: number;
  url: string;
  comments: string[];
  checks: CheckResult[];
  reviews: PullRequestReviewInput[];
}

export type PullRequestMergeMethod = "merge" | "squash" | "rebase";

// A pull request located by its head branch, with just the fields needed to
// reconcile issue status from PR state (no in-memory record required).
export interface BranchPullRequest {
  id: string;
  number: number;
  url: string;
  mergeState: PullRequestMergeStateStatus;
  open: boolean;
}

export interface CodeHostAdapter {
  createPullRequest: (input: PullRequestInput) => Promise<PullRequestRecord>;
  getPullRequest: (id: string) => Promise<PullRequestRecord>;
  getPullRequestMergeability: (id: string) => Promise<PullRequestMergeability>;
  getPullRequestMergeState: (id: string) => Promise<PullRequestMergeState>;
  appendPullRequestComment: (id: string, comment: string) => Promise<void>;
  submitPullRequestReview: (id: string, review: PullRequestReviewInput) => Promise<void>;
  recordCheckResult: (id: string, result: CheckResult) => Promise<void>;
  mergePullRequest: (id: string, method?: PullRequestMergeMethod) => Promise<void>;
  findPullRequestForBranch: (
    branch: string,
    target: { owner: string; repo: string },
  ) => Promise<BranchPullRequest | undefined>;
}

export type IssueArtifact = WorkflowArtifact<IssueRecord>;
export type PullRequestArtifact = WorkflowArtifact<PullRequestRecord>;

export const issueToArtifact = (issue: IssueRecord): IssueArtifact => ({
  id: `linear:${issue.key}`,
  kind: "linear.issue",
  source: "linear",
  payload: structuredClone(issue),
});

export const pullRequestToArtifact = (pullRequest: PullRequestRecord): PullRequestArtifact => ({
  id: `github-pr:${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`,
  kind: "github.pull_request",
  source: "github",
  payload: structuredClone(pullRequest),
});
