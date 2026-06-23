import type {
  CheckResult,
  CodeHostAdapter,
  IssueRecord,
  IssueTrackerAdapter,
  PullRequestInput,
  PullRequestMergeabilityStatus,
  PullRequestMergeStateStatus,
  PullRequestRecord,
  PullRequestReview,
  PullRequestReviewInput,
  ReadyIssueSource,
} from "./contracts.js";
import { sortReadyIssues } from "./ready-issue-ordering.js";

const cloneIssue = (issue: IssueRecord): IssueRecord => structuredClone(issue);

const clonePullRequest = (pullRequest: PullRequestRecord): PullRequestRecord =>
  structuredClone(pullRequest);

const reviewStateFor = (event: PullRequestReviewInput["event"]): PullRequestReview["state"] => {
  if (event === "approve") return "APPROVED";
  if (event === "request_changes") return "CHANGES_REQUESTED";
  return "COMMENTED";
};

const requireIssue = (issues: Map<string, IssueRecord>, key: string): IssueRecord => {
  const issue = issues.get(key);
  if (!issue) throw new Error(`Issue not found: ${key}`);
  return issue;
};

const requirePullRequest = (
  pullRequests: Map<string, PullRequestRecord>,
  id: string,
): PullRequestRecord => {
  const pullRequest = pullRequests.get(id);
  if (!pullRequest) throw new Error(`Pull request not found: ${id}`);
  return pullRequest;
};

export interface FakeIssueTrackerAdapterOptions {
  validStatusLabels?: readonly string[];
}

export const createFakeIssueTrackerAdapter = (
  seedIssues: readonly IssueRecord[] = [],
  options: FakeIssueTrackerAdapterOptions = {},
): IssueTrackerAdapter => {
  const issues = new Map(seedIssues.map((issue) => [issue.key, cloneIssue(issue)]));
  const validStatuses =
    options.validStatusLabels === undefined
      ? undefined
      : new Set([...seedIssues.map((issue) => issue.status), ...options.validStatusLabels]);

  return {
    getIssue: async (key) => cloneIssue(requireIssue(issues, key)),
    updateIssueStatus: async (key, status) => {
      const issue = requireIssue(issues, key);
      if (validStatuses !== undefined && !validStatuses.has(status)) {
        throw new Error(`Linear workflow state not found for fake tracker: ${status}`);
      }
      issue.status = status;
    },
    appendIssueComment: async (key, comment) => {
      const issue = requireIssue(issues, key);
      issue.comments.push(comment);
    },
  };
};

export const createFakeReadyIssueSource = (
  seedIssues: readonly IssueRecord[] = [],
  readyStatus = "ready",
): ReadyIssueSource => {
  const issues = seedIssues.map(cloneIssue);

  return {
    listReadyIssues: async () =>
      sortReadyIssues(issues.filter((issue) => issue.status === readyStatus).map(cloneIssue)),
  };
};

export interface FakeCodeHostAdapterOptions {
  mergeability?: PullRequestMergeabilityStatus | Record<string, PullRequestMergeabilityStatus>;
  merged?: boolean | Record<string, boolean>;
}

export const createFakeCodeHostAdapter = (
  options: FakeCodeHostAdapterOptions = {},
): CodeHostAdapter => {
  const pullRequests = new Map<string, PullRequestRecord>();
  const mergedIds = new Set<string>();
  let nextNumber = 1;

  const mergeabilityFor = (id: string): PullRequestMergeabilityStatus => {
    if (mergeStateFor(id) === "merged") return "unknown";
    if (options.mergeability === undefined) return "unknown";
    if (typeof options.mergeability === "string") return options.mergeability;
    return options.mergeability[id] ?? "unknown";
  };

  const mergeStateFor = (id: string): PullRequestMergeStateStatus => {
    if (mergedIds.has(id)) return "merged";
    if (options.merged === undefined) return "unknown";
    if (typeof options.merged === "boolean") return options.merged ? "merged" : "unmerged";
    if (options.merged[id] === undefined) return "unknown";
    return options.merged[id] ? "merged" : "unmerged";
  };

  return {
    createPullRequest: async (input: PullRequestInput) => {
      const number = nextNumber;
      nextNumber += 1;

      const id = `${input.owner}/${input.repo}#${number}`;
      const pullRequest: PullRequestRecord = {
        ...input,
        id,
        number,
        url: `https://github.local/${input.owner}/${input.repo}/pull/${number}`,
        comments: [],
        checks: [],
        reviews: [],
      };
      pullRequests.set(id, pullRequest);
      return clonePullRequest(pullRequest);
    },
    getPullRequest: async (id) => clonePullRequest(requirePullRequest(pullRequests, id)),
    getPullRequestMergeability: async (id) => {
      requirePullRequest(pullRequests, id);
      return { status: mergeabilityFor(id) };
    },
    getPullRequestMergeState: async (id) => {
      requirePullRequest(pullRequests, id);
      return { status: mergeStateFor(id) };
    },
    appendPullRequestComment: async (id, comment) => {
      const pullRequest = requirePullRequest(pullRequests, id);
      pullRequest.comments.push(comment);
    },
    recordCheckResult: async (id, result: CheckResult) => {
      const pullRequest = requirePullRequest(pullRequests, id);
      pullRequest.checks.push(structuredClone(result));
    },
    submitPullRequestReview: async (id, review: PullRequestReviewInput) => {
      const pullRequest = requirePullRequest(pullRequests, id);
      pullRequest.reviews ??= [];
      pullRequest.reviews.push(structuredClone(review));
    },
    listPullRequestReviews: async (id) => {
      const pullRequest = requirePullRequest(pullRequests, id);
      return pullRequest.reviews.map((review, index) => ({
        id: `${id}:review:${index + 1}`,
        state: reviewStateFor(review.event),
        submittedAt: new Date(index * 1000).toISOString(),
        body: review.body,
        comments: [...structuredClone(review.comments ?? [])],
      }));
    },
    mergePullRequest: async (id) => {
      requirePullRequest(pullRequests, id);
      mergedIds.add(id);
    },
    findPullRequestForBranch: async (branch, target) => {
      const record = [...pullRequests.values()].find(
        (pr) => pr.branch === branch && pr.owner === target.owner && pr.repo === target.repo,
      );
      if (record === undefined) return undefined;
      const merged = mergeStateFor(record.id) === "merged";
      return {
        id: record.id,
        number: record.number,
        url: record.url,
        mergeState: merged ? "merged" : "unmerged",
        open: !merged,
      };
    },
  };
};
