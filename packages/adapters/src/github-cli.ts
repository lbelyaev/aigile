import type {
  CheckResult,
  CodeHostAdapter,
  PullRequestInput,
  PullRequestMergeability,
  PullRequestMergeabilityStatus,
  PullRequestMergeState,
  PullRequestMergeStateStatus,
  PullRequestRecord,
  PullRequestReviewInput,
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

const pullRequestUrlFromOutput = (output: string): string | undefined => {
  const match = output.match(/https:\/\/github\.com\/[^\s]+\/[^\s]+\/pull\/\d+\/?/);
  return match?.[0];
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const parseMergeabilityPayload = (stdout: string): PullRequestMergeability => {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(
      `Could not parse pull request mergeability JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Could not parse pull request mergeability JSON: expected object");
  }
  const mergeable = optionalString((payload as { mergeable?: unknown }).mergeable);
  const mergeStateStatus = optionalString(
    (payload as { mergeStateStatus?: unknown }).mergeStateStatus,
  );
  const mergeableValue = mergeable?.toUpperCase();
  const mergeStateStatusValue = mergeStateStatus?.toUpperCase();
  let status: PullRequestMergeabilityStatus = "unknown";
  if (mergeableValue === "CONFLICTING" || mergeStateStatusValue === "DIRTY") {
    status = "conflicting";
  } else if (mergeableValue === "MERGEABLE") {
    status = "mergeable";
  }
  return {
    status,
    ...(mergeable === undefined ? {} : { mergeable }),
    ...(mergeStateStatus === undefined ? {} : { mergeStateStatus }),
  };
};

const optionalBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const parseMergeStatePayload = (stdout: string): PullRequestMergeState => {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(
      `Could not parse pull request merge state JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Could not parse pull request merge state JSON: expected object");
  }
  const state = optionalString((payload as { state?: unknown }).state);
  const merged = optionalBoolean((payload as { merged?: unknown }).merged);
  const mergedAt = optionalString((payload as { mergedAt?: unknown }).mergedAt);
  const stateValue = state?.toUpperCase();
  let status: PullRequestMergeStateStatus = "unknown";
  if (merged === true || stateValue === "MERGED" || mergedAt !== undefined) {
    status = "merged";
  } else if (merged === false || stateValue === "OPEN" || stateValue === "CLOSED") {
    status = "unmerged";
  }
  return {
    status,
    ...(state === undefined ? {} : { state }),
    ...(merged === undefined ? {} : { merged }),
    ...(mergedAt === undefined ? {} : { mergedAt }),
  };
};

const assertSuccess = (result: GitHubCliExecResult, operation: string): void => {
  if (result.exitCode !== 0) {
    throw new Error(`${operation} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }
};

const createPullRequestRecord = (
  input: PullRequestInput,
  parsed: { id: string; number: number; url: string },
): PullRequestRecord => ({
  ...input,
  ...parsed,
  comments: [],
  checks: [],
  reviews: [],
});

const updateExistingPullRequest = async (
  options: GitHubCliCodeHostAdapterOptions,
  input: PullRequestInput,
  parsed: { id: string; number: number; url: string },
): Promise<void> => {
  const result = await options.exec(
    "gh",
    [
      "pr",
      "edit",
      String(parsed.number),
      "--repo",
      `${input.owner}/${input.repo}`,
      "--title",
      input.title,
      "--body",
      input.body,
    ],
    execOptions(options.cwd),
  );
  assertSuccess(result, "gh pr edit");
};

const prNumberFromId = (id: string): string => {
  const number = id.split("#")[1];
  if (!number) throw new Error(`Invalid pull request id: ${id}`);
  return number;
};

const repoFromRecord = (record: PullRequestRecord): string => `${record.owner}/${record.repo}`;

const execOptions = (cwd: string | undefined): { cwd?: string } =>
  cwd === undefined ? {} : { cwd };

const reviewEventFlag = (event: PullRequestReviewInput["event"]): string => {
  if (event === "approve") return "--approve";
  if (event === "request_changes") return "--request-changes";
  return "--comment";
};

export const createGitHubCliCodeHostAdapter = (
  options: GitHubCliCodeHostAdapterOptions,
): CodeHostAdapter => {
  const pullRequests = new Map<string, PullRequestRecord>();

  return {
    createPullRequest: async (input) => {
      const result = await options.exec(
        "gh",
        [
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
        ],
        execOptions(options.cwd),
      );
      if (result.exitCode !== 0) {
        const existingPullRequestUrl = pullRequestUrlFromOutput(
          `${result.stderr}\n${result.stdout}`,
        );
        if (existingPullRequestUrl === undefined) {
          assertSuccess(result, "gh pr create");
          throw new Error("gh pr create failed without an existing pull request URL");
        }
        const parsed = parsePullRequestUrl(existingPullRequestUrl, input);
        await updateExistingPullRequest(options, input, parsed);
        const existingRecord = createPullRequestRecord(input, parsed);
        pullRequests.set(existingRecord.id, existingRecord);
        return structuredClone(existingRecord);
      }
      const parsed = parsePullRequestUrl(result.stdout, input);
      const record = createPullRequestRecord(input, parsed);
      pullRequests.set(record.id, record);
      return structuredClone(record);
    },
    getPullRequest: async (id) => {
      const record = pullRequests.get(id);
      if (!record) throw new Error(`Pull request not found: ${id}`);
      return structuredClone(record);
    },
    getPullRequestMergeability: async (id) => {
      const record = pullRequests.get(id);
      if (!record) throw new Error(`Pull request not found: ${id}`);
      const result = await options.exec(
        "gh",
        [
          "pr",
          "view",
          prNumberFromId(id),
          "--repo",
          repoFromRecord(record),
          "--json",
          "mergeable,mergeStateStatus",
        ],
        execOptions(options.cwd),
      );
      assertSuccess(result, "gh pr view");
      return parseMergeabilityPayload(result.stdout);
    },
    getPullRequestMergeState: async (id) => {
      const record = pullRequests.get(id);
      if (!record) throw new Error(`Pull request not found: ${id}`);
      const result = await options.exec(
        "gh",
        [
          "pr",
          "view",
          prNumberFromId(id),
          "--repo",
          repoFromRecord(record),
          "--json",
          "state,merged,mergedAt",
        ],
        execOptions(options.cwd),
      );
      assertSuccess(result, "gh pr view");
      return parseMergeStatePayload(result.stdout);
    },
    appendPullRequestComment: async (id, comment) => {
      const record = pullRequests.get(id);
      if (!record) throw new Error(`Pull request not found: ${id}`);
      const result = await options.exec(
        "gh",
        ["pr", "comment", prNumberFromId(id), "--repo", repoFromRecord(record), "--body", comment],
        execOptions(options.cwd),
      );
      assertSuccess(result, "gh pr comment");
      record.comments.push(comment);
    },
    submitPullRequestReview: async (id, review) => {
      const record = pullRequests.get(id);
      if (!record) throw new Error(`Pull request not found: ${id}`);
      const result = await options.exec(
        "gh",
        [
          "pr",
          "review",
          prNumberFromId(id),
          "--repo",
          repoFromRecord(record),
          reviewEventFlag(review.event),
          "--body",
          review.body,
        ],
        execOptions(options.cwd),
      );
      assertSuccess(result, "gh pr review");
      record.reviews.push(structuredClone(review));
    },
    recordCheckResult: async (id, check: CheckResult) => {
      const record = pullRequests.get(id);
      if (!record) throw new Error(`Pull request not found: ${id}`);
      const body = `### ${check.name}: ${check.status}\n\n${check.summary}`;
      const result = await options.exec(
        "gh",
        ["pr", "comment", prNumberFromId(id), "--repo", repoFromRecord(record), "--body", body],
        execOptions(options.cwd),
      );
      assertSuccess(result, "gh pr comment");
      record.checks.push(structuredClone(check));
    },
    mergePullRequest: async (id, method = "squash") => {
      const record = pullRequests.get(id);
      if (!record) throw new Error(`Pull request not found: ${id}`);
      const result = await options.exec(
        "gh",
        ["pr", "merge", prNumberFromId(id), "--repo", repoFromRecord(record), `--${method}`],
        execOptions(options.cwd),
      );
      assertSuccess(result, "gh pr merge");
    },
  };
};
