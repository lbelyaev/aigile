import type {
  CheckResult,
  CodeHostAdapter,
  PullRequestInput,
  PullRequestMergeability,
  PullRequestMergeabilityStatus,
  PullRequestMergeState,
  PullRequestMergeStateStatus,
  PullRequestRecord,
  PullRequestReview,
  PullRequestReviewComment,
  PullRequestReviewInput,
  PullRequestReviewState,
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

const parseJsonArray = (stdout: string, operation: string): unknown[] => {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(
      `Could not parse ${operation} JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(payload)) throw new Error(`Could not parse ${operation} JSON: expected array`);
  return payload;
};

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0
    ? value
    : typeof value === "number"
      ? String(value)
      : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const parseReviewState = (value: unknown): PullRequestReviewState => {
  const state = typeof value === "string" ? value.toUpperCase() : "";
  if (
    state === "APPROVED" ||
    state === "CHANGES_REQUESTED" ||
    state === "COMMENTED" ||
    state === "DISMISSED"
  ) {
    return state;
  }
  return "COMMENTED";
};

const parseReviewComments = (stdout: string): PullRequestReviewComment[] =>
  parseJsonArray(stdout, "pull request review comments").flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const value = entry as Record<string, unknown>;
    const id = stringValue(value.id);
    const body = stringValue(value.body);
    if (id === undefined || body === undefined) return [];
    const comment: PullRequestReviewComment = { id, body };
    const path = stringValue(value.path);
    const line = numberValue(value.line);
    if (path !== undefined) comment.path = path;
    if (line !== undefined) comment.line = line;
    return [comment];
  });

const parseReviews = (
  stdout: string,
  commentsByReviewId: ReadonlyMap<string, PullRequestReviewComment[]>,
): PullRequestReview[] =>
  parseJsonArray(stdout, "pull request reviews").flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const value = entry as Record<string, unknown>;
    const id = stringValue(value.id);
    const body = stringValue(value.body) ?? "";
    if (id === undefined) return [];
    const submittedAt =
      stringValue(value.submitted_at) ??
      stringValue(value.submittedAt) ??
      new Date(0).toISOString();
    const user = value.user;
    const author =
      typeof user === "object" && user !== null && !Array.isArray(user)
        ? stringValue((user as { login?: unknown }).login)
        : undefined;
    const review: PullRequestReview = {
      id,
      state: parseReviewState(value.state),
      submittedAt,
      body,
      comments: commentsByReviewId.get(id) ?? [],
    };
    if (author !== undefined) review.author = author;
    return [review];
  });

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

// The repo "owner/name" encoded in a pull request id ("owner/name#number"), so
// by-id operations work without an in-memory record (e.g. on a fresh process
// resuming an interrupted run).
const repoFromId = (id: string): string => {
  const repo = id.split("#")[0];
  if (!repo || !repo.includes("/")) throw new Error(`Invalid pull request id: ${id}`);
  return repo;
};

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
      const result = await options.exec(
        "gh",
        [
          "pr",
          "view",
          prNumberFromId(id),
          "--repo",
          repoFromId(id),
          "--json",
          "mergeable,mergeStateStatus",
        ],
        execOptions(options.cwd),
      );
      assertSuccess(result, "gh pr view");
      return parseMergeabilityPayload(result.stdout);
    },
    getPullRequestMergeState: async (id) => {
      const result = await options.exec(
        "gh",
        [
          "pr",
          "view",
          prNumberFromId(id),
          "--repo",
          repoFromId(id),
          "--json",
          "state,merged,mergedAt",
        ],
        execOptions(options.cwd),
      );
      assertSuccess(result, "gh pr view");
      return parseMergeStatePayload(result.stdout);
    },
    appendPullRequestComment: async (id, comment) => {
      const result = await options.exec(
        "gh",
        ["pr", "comment", prNumberFromId(id), "--repo", repoFromId(id), "--body", comment],
        execOptions(options.cwd),
      );
      assertSuccess(result, "gh pr comment");
      pullRequests.get(id)?.comments.push(comment);
    },
    submitPullRequestReview: async (id, review) => {
      const result = await options.exec(
        "gh",
        [
          "pr",
          "review",
          prNumberFromId(id),
          "--repo",
          repoFromId(id),
          reviewEventFlag(review.event),
          "--body",
          review.body,
        ],
        execOptions(options.cwd),
      );
      assertSuccess(result, "gh pr review");
      pullRequests.get(id)?.reviews.push(structuredClone(review));
    },
    listPullRequestReviews: async (id) => {
      const reviewsResult = await options.exec(
        "gh",
        ["api", `repos/${repoFromId(id)}/pulls/${prNumberFromId(id)}/reviews`, "--paginate"],
        execOptions(options.cwd),
      );
      assertSuccess(reviewsResult, "gh api pull request reviews");
      const rawReviews = parseJsonArray(reviewsResult.stdout, "pull request reviews");
      const commentsByReviewId = new Map<string, PullRequestReviewComment[]>();
      for (const rawReview of rawReviews) {
        if (typeof rawReview !== "object" || rawReview === null || Array.isArray(rawReview)) {
          continue;
        }
        const reviewId = stringValue((rawReview as { id?: unknown }).id);
        if (reviewId === undefined) continue;
        const commentsResult = await options.exec(
          "gh",
          [
            "api",
            `repos/${repoFromId(id)}/pulls/${prNumberFromId(id)}/reviews/${reviewId}/comments`,
            "--paginate",
          ],
          execOptions(options.cwd),
        );
        assertSuccess(commentsResult, "gh api pull request review comments");
        commentsByReviewId.set(reviewId, parseReviewComments(commentsResult.stdout));
      }
      return parseReviews(JSON.stringify(rawReviews), commentsByReviewId);
    },
    recordCheckResult: async (id, check: CheckResult) => {
      const body = `### ${check.name}: ${check.status}\n\n${check.summary}`;
      const result = await options.exec(
        "gh",
        ["pr", "comment", prNumberFromId(id), "--repo", repoFromId(id), "--body", body],
        execOptions(options.cwd),
      );
      assertSuccess(result, "gh pr comment");
      pullRequests.get(id)?.checks.push(structuredClone(check));
    },
    mergePullRequest: async (id, method = "squash") => {
      const result = await options.exec(
        "gh",
        ["pr", "merge", prNumberFromId(id), "--repo", repoFromId(id), `--${method}`],
        execOptions(options.cwd),
      );
      assertSuccess(result, "gh pr merge");
    },
    findPullRequestForBranch: async (branch, target) => {
      const repo = `${target.owner}/${target.repo}`;
      const result = await options.exec(
        "gh",
        ["pr", "view", branch, "--repo", repo, "--json", "number,url,state,merged"],
        execOptions(options.cwd),
      );
      // gh exits non-zero when no PR exists for the branch.
      if (result.exitCode !== 0) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return undefined;
      }
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const view = parsed as { number?: unknown; url?: unknown; state?: unknown; merged?: unknown };
      if (typeof view.number !== "number" || typeof view.url !== "string") return undefined;
      const id = `${target.owner}/${target.repo}#${view.number}`;
      const merged = view.merged === true || view.state === "MERGED";
      const open = view.state === "OPEN";
      return {
        id,
        number: view.number,
        url: view.url,
        mergeState: merged ? "merged" : "unmerged",
        open,
      };
    },
  };
};
