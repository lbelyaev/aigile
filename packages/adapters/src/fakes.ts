import type {
  CheckResult,
  CodeHostAdapter,
  IssueRecord,
  IssueTrackerAdapter,
  PullRequestInput,
  PullRequestRecord,
  ReadyIssueSource,
} from "./contracts.js";

const cloneIssue = (issue: IssueRecord): IssueRecord => structuredClone(issue);

const clonePullRequest = (pullRequest: PullRequestRecord): PullRequestRecord =>
  structuredClone(pullRequest);

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

export const createFakeIssueTrackerAdapter = (
  seedIssues: readonly IssueRecord[] = [],
): IssueTrackerAdapter => {
  const issues = new Map(seedIssues.map((issue) => [issue.key, cloneIssue(issue)]));

  return {
    getIssue: async (key) => cloneIssue(requireIssue(issues, key)),
    updateIssueStatus: async (key, status) => {
      const issue = requireIssue(issues, key);
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
      issues
        .filter((issue) => issue.status === readyStatus)
        .map(cloneIssue),
  };
};

export const createFakeCodeHostAdapter = (): CodeHostAdapter => {
  const pullRequests = new Map<string, PullRequestRecord>();
  let nextNumber = 1;

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
      };
      pullRequests.set(id, pullRequest);
      return clonePullRequest(pullRequest);
    },
    getPullRequest: async (id) => clonePullRequest(requirePullRequest(pullRequests, id)),
    appendPullRequestComment: async (id, comment) => {
      const pullRequest = requirePullRequest(pullRequests, id);
      pullRequest.comments.push(comment);
    },
    recordCheckResult: async (id, result: CheckResult) => {
      const pullRequest = requirePullRequest(pullRequests, id);
      pullRequest.checks.push(structuredClone(result));
    },
  };
};
