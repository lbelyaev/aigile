import type {
  CheckResult,
  CodeHostAdapter,
  PullRequestInput,
  PullRequestRecord,
} from "./contracts.js";

export interface GitHubCliExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitHubCliExec = (
  command: string,
  args: readonly string[],
  options: { cwd?: string },
) => Promise<GitHubCliExecResult>;

export interface GitHubCliCodeHostAdapterOptions {
  cwd?: string;
  exec: GitHubCliExec;
}

const parsePullRequestUrl = (
  url: string,
  input: PullRequestInput,
): { id: string; number: number; url: string } => {
  const trimmed = url.trim();
  const match = trimmed.match(/\/pull\/(\d+)\/?$/);
  if (!match) throw new Error(`Could not parse pull request URL: ${trimmed}`);
  const number = Number(match[1]);
  return {
    id: `${input.owner}/${input.repo}#${number}`,
    number,
    url: trimmed,
  };
};

const assertSuccess = (result: GitHubCliExecResult, operation: string): void => {
  if (result.exitCode !== 0) {
    throw new Error(`${operation} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }
};

const prNumberFromId = (id: string): string => {
  const number = id.split("#")[1];
  if (!number) throw new Error(`Invalid pull request id: ${id}`);
  return number;
};

const repoFromRecord = (record: PullRequestRecord): string => `${record.owner}/${record.repo}`;

const execOptions = (cwd: string | undefined): { cwd?: string } =>
  cwd === undefined ? {} : { cwd };

export const createGitHubCliCodeHostAdapter = (
  options: GitHubCliCodeHostAdapterOptions,
): CodeHostAdapter => {
  const pullRequests = new Map<string, PullRequestRecord>();

  return {
    createPullRequest: async (input) => {
      const result = await options.exec("gh", [
        "pr",
        "create",
        "--repo",
        `${input.owner}/${input.repo}`,
        "--head",
        input.branch,
        "--base",
        input.baseBranch,
        "--title",
        input.title,
        "--body",
        input.body,
        "--draft",
      ], execOptions(options.cwd));
      assertSuccess(result, "gh pr create");
      const parsed = parsePullRequestUrl(result.stdout, input);
      const record: PullRequestRecord = {
        ...input,
        ...parsed,
        comments: [],
        checks: [],
      };
      pullRequests.set(record.id, record);
      return structuredClone(record);
    },
    getPullRequest: async (id) => {
      const record = pullRequests.get(id);
      if (!record) throw new Error(`Pull request not found: ${id}`);
      return structuredClone(record);
    },
    appendPullRequestComment: async (id, comment) => {
      const record = pullRequests.get(id);
      if (!record) throw new Error(`Pull request not found: ${id}`);
      const result = await options.exec("gh", [
        "pr",
        "comment",
        prNumberFromId(id),
        "--repo",
        repoFromRecord(record),
        "--body",
        comment,
      ], execOptions(options.cwd));
      assertSuccess(result, "gh pr comment");
      record.comments.push(comment);
    },
    recordCheckResult: async (id, check: CheckResult) => {
      const record = pullRequests.get(id);
      if (!record) throw new Error(`Pull request not found: ${id}`);
      const body = `### ${check.name}: ${check.status}\n\n${check.summary}`;
      const result = await options.exec("gh", [
        "pr",
        "comment",
        prNumberFromId(id),
        "--repo",
        repoFromRecord(record),
        "--body",
        body,
      ], execOptions(options.cwd));
      assertSuccess(result, "gh pr comment");
      record.checks.push(structuredClone(check));
    },
  };
};
