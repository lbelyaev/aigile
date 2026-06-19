import type { WorkflowArtifact } from "@aigile/types";

export interface IssueRecord {
  id: string;
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: string;
  priority?: number;
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

export interface PullRequestRecord extends PullRequestInput {
  id: string;
  number: number;
  url: string;
  comments: string[];
  checks: CheckResult[];
  reviews: PullRequestReviewInput[];
}

export interface CodeHostAdapter {
  createPullRequest: (input: PullRequestInput) => Promise<PullRequestRecord>;
  getPullRequest: (id: string) => Promise<PullRequestRecord>;
  appendPullRequestComment: (id: string, comment: string) => Promise<void>;
  submitPullRequestReview: (id: string, input: PullRequestReviewInput) => Promise<void>;
  recordCheckResult: (id: string, result: CheckResult) => Promise<void>;
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
