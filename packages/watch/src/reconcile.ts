import type {
  BranchPullRequest,
  CodeHostAdapter,
  IssueRecord,
  IssueTrackerAdapter,
  PullRequestChecksSummary,
  PullRequestReview,
  PullRequestReviewComment,
} from "@aigile/adapters";
import {
  DEFAULT_ISSUE_STATUS_LABELS,
  effectiveMergePolicy,
  resolveProductPaths,
  splitGithubRepo,
  type IssueStatusLabels,
  type MergePolicy,
  type ProductPathResolutionOptions,
  type RuntimeProduct,
  type RuntimeProductConfig,
} from "@aigile/config";
import type { WorkflowArtifact, WorkflowEvent } from "@aigile/types";
import {
  createFileRunStore,
  initialWorkflowSnapshot,
  replayWorkflow,
  transitionWorkflow,
  type RunStore,
} from "@aigile/workflow";
import { join } from "node:path";

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

export type ReconcileProductOutcome =
  | {
      kind: "no_pull_request";
      productId: string;
      issueKey: string;
      branchName: string;
      target: { owner: string; repo: string };
    }
  | {
      kind: "unchanged";
      productId: string;
      issueKey: string;
      status: string;
      reason?: string;
      branchName: string;
      target: { owner: string; repo: string };
    }
  | {
      kind: "updated";
      productId: string;
      issueKey: string;
      from: string;
      to: string;
      reason?: string;
      branchName: string;
      target: { owner: string; repo: string };
    }
  | {
      kind: "blocked" | "blocked_unchanged";
      productId: string;
      issueKey: string;
      status: string;
      state: "closed" | "conflicting" | "checks_failed" | "missing_review" | "unknown";
      note: string;
      branchName: string;
      target: { owner: string; repo: string };
    }
  | {
      kind: "failed";
      productId: string;
      issueKey?: string;
      error: string;
    };

export interface ReconcileProductsInput {
  productConfig: RuntimeProductConfig;
  createRunStore?: (product: RuntimeProduct, runStatePath: string) => RunStore;
  createTracker: (product: RuntimeProduct) => IssueTrackerAdapter | Promise<IssueTrackerAdapter>;
  createCodeHost: (product: RuntimeProduct) => CodeHostAdapter | Promise<CodeHostAdapter>;
  labels?: ReconcileStatusLabels;
  pathOptions?: ProductPathResolutionOptions;
}

export interface ReconcileProductsResult {
  outcomes: ReconcileProductOutcome[];
}

export interface IngestExternalReviewFeedbackInput {
  issueKey: string;
  branchName: string;
  target: { owner: string; repo: string };
  codeHost: CodeHostAdapter;
  store: RunStore;
  issue?: IssueRecord;
  reworkStatus?: string;
  issueTracker?: IssueTrackerAdapter;
  issueStatusLabels?: Partial<IssueStatusLabels>;
  onStatusSyncError?: ((error: unknown, status: string) => void) | undefined;
}

export type IngestExternalReviewFeedbackOutcome =
  | { kind: "ingested"; source: "github" | "linear"; artifactId: string; state: string }
  | { kind: "already_processed" }
  | { kind: "no_run" }
  | { kind: "not_merge_ready"; state: string }
  | { kind: "no_pull_request" }
  | { kind: "merged_pull_request" }
  | { kind: "no_feedback" };

const desiredStatus = (pullRequest: BranchPullRequest, labels: ReconcileStatusLabels): string => {
  if (pullRequest.mergeState === "merged") return labels.done;
  if (pullRequest.open) return labels.inReview;
  return labels.ready; // closed without merging: return it to the ready queue
};

export const runStatePathForProduct = (
  product: RuntimeProduct,
  options: ProductPathResolutionOptions = {},
): string => join(resolveProductPaths(product, options).worktreesPath, "..", "runs");

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

const safeIdPart = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, "_");

const issueBranch = (issueKey: string): string => `aigile/${issueKey}`;

const processedReviewFeedback = (
  artifacts: readonly WorkflowArtifact[],
): Map<string, WorkflowArtifact> => {
  const processed = new Map<string, WorkflowArtifact>();
  for (const artifact of artifacts) {
    if (artifact.kind === "human.review") {
      const payload = artifact.payload;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) continue;
      const prReview = (payload as { prReview?: unknown }).prReview;
      if (typeof prReview !== "object" || prReview === null || Array.isArray(prReview)) continue;
      const reviewId = (prReview as { reviewId?: unknown }).reviewId;
      if (typeof reviewId === "string" && reviewId.length > 0) processed.set(reviewId, artifact);
      continue;
    }

    if (artifact.kind !== "review.feedback") continue;
    const payload = artifact.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) continue;
    const signalId = (payload as { signalId?: unknown }).signalId;
    if (typeof signalId === "string" && signalId.length > 0) processed.set(signalId, artifact);
  }
  return processed;
};

type BlockedPrState = "closed" | "conflicting" | "checks_failed" | "missing_review" | "unknown";

type ProductPrStatus =
  | { kind: "status"; status: string; reason?: string }
  | { kind: "merge"; status: string }
  | { kind: "blocked"; state: BlockedPrState; reason: string };

const prStatusForProduct = async (
  codeHost: CodeHostAdapter,
  pullRequest: BranchPullRequest,
  labels: ReconcileStatusLabels,
  mergePolicy: MergePolicy,
): Promise<ProductPrStatus> => {
  if (pullRequest.mergeState === "merged") return { kind: "status", status: labels.done };
  if (!pullRequest.open) {
    return {
      kind: "blocked",
      state: "closed",
      reason: `pull request is closed without merge: ${pullRequest.url}`,
    };
  }

  try {
    const mergeability = await codeHost.getPullRequestMergeability(pullRequest.id);
    if (mergeability.status === "conflicting") {
      return {
        kind: "blocked",
        state: "conflicting",
        reason: `pull request is conflicting: ${pullRequest.url}`,
      };
    }
    const checks = await codeHost.getPullRequestChecks(pullRequest.id);
    if (checks.status === "pending") {
      return { kind: "status", status: labels.inReview };
    }
    if (checks.status === "failing") {
      return {
        kind: "blocked",
        state: "checks_failed",
        reason: `pull request checks failed: ${formatCheckDetails(checks)}`,
      };
    }
    if (checks.status === "unknown") {
      return {
        kind: "blocked",
        state: "unknown",
        reason: `pull request check status is unknown: ${pullRequest.url}`,
      };
    }
    if (mergeability.status === "blocked") {
      return {
        kind: "blocked",
        state: "missing_review",
        reason: `pull request is blocked by branch protection or missing reviews: ${pullRequest.url}`,
      };
    }
    if (mergeability.status === "unknown") {
      return {
        kind: "blocked",
        state: "unknown",
        reason: `pull request mergeability is unknown: ${pullRequest.url}`,
      };
    }
    if (
      checks.status === "passing" &&
      mergeability.status === "mergeable" &&
      mergePolicy === "manual"
    ) {
      return {
        kind: "status",
        status: labels.inReview,
        reason: `held by manual merge policy; green pull request remains open for human merge: ${pullRequest.url}`,
      };
    }
    if (
      checks.status === "passing" &&
      mergeability.status === "mergeable" &&
      mergePolicy === "auto"
    ) {
      return { kind: "merge", status: labels.done };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: "blocked",
      state: "unknown",
      reason: `pull request status could not be resolved for ${pullRequest.url}: ${detail}`,
    };
  }

  return { kind: "status", status: labels.inReview };
};

const formatCheckDetails = (checks: PullRequestChecksSummary): string => {
  const failing = checks.checks.filter((check) => check.state === "failing");
  const selected = failing.length > 0 ? failing : checks.checks;
  if (selected.length === 0) return "no failing check details available";
  return selected
    .map((check) =>
      check.detailsUrl === undefined ? check.name : `${check.name} (${check.detailsUrl})`,
    )
    .join(", ");
};

const reconcileBlockedSignalId = (
  productId: string,
  issueKey: string,
  pullRequest: BranchPullRequest,
  state: BlockedPrState,
): string =>
  `aigile:reconcile:${safeIdPart(productId)}:${safeIdPart(issueKey)}:pr-${pullRequest.number}:${state}`;

const blockedProductNote = (
  product: RuntimeProduct,
  issueKey: string,
  pullRequest: BranchPullRequest,
  state: BlockedPrState,
  reason: string,
): string => {
  const signalId = reconcileBlockedSignalId(product.id, issueKey, pullRequest, state);
  return [
    `Aigile reconcile blocked/escalated ${issueKey}.`,
    `Signal: ${signalId}`,
    `Product: ${product.id}`,
    `Reason: ${reason}`,
  ].join("\n");
};

const reconcileProductRun = async (input: {
  product: RuntimeProduct;
  issueKey: string;
  tracker: IssueTrackerAdapter;
  codeHost: CodeHostAdapter;
  labels: ReconcileStatusLabels;
}): Promise<ReconcileProductOutcome> => {
  const target = splitGithubRepo(input.product.github.repo);
  const branchName = issueBranch(input.issueKey);
  const base = {
    productId: input.product.id,
    issueKey: input.issueKey,
    branchName,
    target,
  };
  const issue = await input.tracker.getIssue(input.issueKey);
  const pullRequest = await input.codeHost.findPullRequestForBranch(branchName, target);
  if (pullRequest === undefined) return { kind: "no_pull_request", ...base };

  const prStatus = await prStatusForProduct(
    input.codeHost,
    pullRequest,
    input.labels,
    effectiveMergePolicy(input.product.mergePolicy, issue.description),
  );
  if (prStatus.kind === "blocked") {
    const note = blockedProductNote(
      input.product,
      input.issueKey,
      pullRequest,
      prStatus.state,
      prStatus.reason,
    );
    const signalId = reconcileBlockedSignalId(
      input.product.id,
      input.issueKey,
      pullRequest,
      prStatus.state,
    );
    const alreadyRecorded = issue.comments.some((comment) => comment.includes(signalId));
    if (!alreadyRecorded) await input.tracker.appendIssueComment(input.issueKey, note);
    return {
      kind: alreadyRecorded ? "blocked_unchanged" : "blocked",
      ...base,
      status: issue.status,
      state: prStatus.state,
      note,
    };
  }

  if (prStatus.kind === "merge") {
    try {
      await input.codeHost.mergePullRequest(pullRequest.id);
    } catch (error) {
      const reason =
        error instanceof Error
          ? `pull request merge failed for ${pullRequest.url}: ${error.message}`
          : `pull request merge failed for ${pullRequest.url}: ${String(error)}`;
      const state: BlockedPrState = "unknown";
      const note = blockedProductNote(input.product, input.issueKey, pullRequest, state, reason);
      const signalId = reconcileBlockedSignalId(
        input.product.id,
        input.issueKey,
        pullRequest,
        state,
      );
      const alreadyRecorded = issue.comments.some((comment) => comment.includes(signalId));
      if (!alreadyRecorded) await input.tracker.appendIssueComment(input.issueKey, note);
      return {
        kind: alreadyRecorded ? "blocked_unchanged" : "blocked",
        ...base,
        status: issue.status,
        state,
        note,
      };
    }
  }

  const prStatusReason = prStatus.kind === "status" ? prStatus.reason : undefined;
  if (prStatus.status === issue.status) {
    return {
      kind: "unchanged",
      ...base,
      status: prStatus.status,
      ...(prStatusReason === undefined ? {} : { reason: prStatusReason }),
    };
  }

  await input.tracker.updateIssueStatus(input.issueKey, prStatus.status);
  return {
    kind: "updated",
    ...base,
    from: issue.status,
    to: prStatus.status,
    ...(prStatusReason === undefined ? {} : { reason: prStatusReason }),
  };
};

export const reconcileProducts = async (
  input: ReconcileProductsInput,
): Promise<ReconcileProductsResult> => {
  const labels = input.labels ?? {
    inReview: "In Review",
    done: "Done",
    ready: "Todo",
  };
  const outcomes: ReconcileProductOutcome[] = [];

  for (const product of input.productConfig.products) {
    try {
      const runStatePath = runStatePathForProduct(product, input.pathOptions);
      const store =
        input.createRunStore?.(product, runStatePath) ??
        createFileRunStore({ directory: runStatePath });
      const tracker = await input.createTracker(product);
      const codeHost = await input.createCodeHost(product);
      let issueKeys: string[];
      try {
        issueKeys = await store.list();
      } catch (error) {
        outcomes.push({
          kind: "failed",
          productId: product.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      for (const listedIssueKey of issueKeys) {
        try {
          const run = await store.load(listedIssueKey);
          const issueKey = run?.issueId ?? listedIssueKey;
          outcomes.push(
            await reconcileProductRun({ product, issueKey, tracker, codeHost, labels }),
          );
        } catch (error) {
          outcomes.push({
            kind: "failed",
            productId: product.id,
            issueKey: listedIssueKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      outcomes.push({
        kind: "failed",
        productId: product.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { outcomes };
};

const submittedAtMs = (review: PullRequestReview): number => {
  const timestamp = Date.parse(review.submittedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const latestUnprocessedChangesRequestedReview = (
  reviews: readonly PullRequestReview[],
  processed: ReadonlyMap<string, WorkflowArtifact>,
): PullRequestReview | undefined =>
  reviews
    .filter((review) => review.state === "CHANGES_REQUESTED" && !processed.has(review.id))
    .sort((left, right) => submittedAtMs(right) - submittedAtMs(left))[0];

const reviewSummary = (review: PullRequestReview): string => {
  const body = review.body.trim();
  return body.length > 0 ? body : "GitHub review requested changes.";
};

const reviewCommentFindings = (comments: readonly PullRequestReviewComment[]) =>
  comments.map((comment) => ({
    file: comment.path ?? "pull request review",
    line: comment.line ?? 1,
    scenario: comment.body,
    severity: "medium" as const,
    confidence: 1,
    whyItMatters: "A human reviewer requested this change before merge.",
    minimalFix: comment.body,
  }));

const githubReviewFeedbackArtifact = (
  issueKey: string,
  pullRequest: BranchPullRequest,
  review: PullRequestReview,
): WorkflowArtifact => ({
  id: `human-review:${safeIdPart(issueKey)}:${safeIdPart(review.id)}`,
  kind: "human.review",
  source: "github",
  payload: {
    verdict: "changes_requested",
    summary: reviewSummary(review),
    findings: reviewCommentFindings(review.comments),
    source: "github",
    prReview: {
      reviewId: review.id,
      pullRequestUrl: pullRequest.url,
      submittedAt: review.submittedAt,
      ...(review.author === undefined ? {} : { reviewer: review.author }),
    },
  },
});

const linearReworkSignalId = (issueKey: string, status: string): string =>
  `linear-rework:${issueKey}:${status}`;

const linearReworkFeedbackArtifact = (issue: IssueRecord, status: string): WorkflowArtifact => {
  const signalId = linearReworkSignalId(issue.key, status);
  return {
    id: `review-feedback:${safeIdPart(issue.key)}:${safeIdPart(signalId)}`,
    kind: "review.feedback",
    source: "linear",
    payload: {
      source: "linear",
      signalId,
      status,
      body: `Linear issue moved to rework status: ${status}`,
    },
  };
};

const syncReworkIssueStatus = async (input: IngestExternalReviewFeedbackInput): Promise<void> => {
  if (input.issueTracker === undefined) return;
  const status = {
    ...DEFAULT_ISSUE_STATUS_LABELS,
    ...(input.issueStatusLabels ?? {}),
  }.developing;
  try {
    const current = await input.issueTracker.getIssue(input.issueKey).catch(() => input.issue);
    if (current?.status === status) return;
    await input.issueTracker.updateIssueStatus(input.issueKey, status);
  } catch (error) {
    input.onStatusSyncError?.(error, status);
  }
};

export const ingestExternalReviewFeedback = async (
  input: IngestExternalReviewFeedbackInput,
): Promise<IngestExternalReviewFeedbackOutcome> => {
  const run = await input.store.load(input.issueKey);
  if (run === undefined || run.events.length === 0) return { kind: "no_run" };
  const processed = processedReviewFeedback(run.artifacts);
  const replay = replayWorkflow(initialWorkflowSnapshot(input.issueKey), run.events);
  if (replay.snapshot.state !== "merge_ready") {
    if (processed.size > 0) return { kind: "already_processed" };
    return { kind: "not_merge_ready", state: replay.snapshot.state };
  }

  const pullRequest = await input.codeHost.findPullRequestForBranch(input.branchName, input.target);
  if (pullRequest === undefined) return { kind: "no_pull_request" };
  if (pullRequest.mergeState === "merged" || !pullRequest.open)
    return { kind: "merged_pull_request" };

  let artifact: WorkflowArtifact | undefined;
  let source: "github" | "linear" | undefined;
  if (
    input.issue !== undefined &&
    input.reworkStatus !== undefined &&
    input.issue.status === input.reworkStatus
  ) {
    const signalId = linearReworkSignalId(input.issue.key, input.reworkStatus);
    if (!processed.has(signalId)) {
      artifact = linearReworkFeedbackArtifact(input.issue, input.reworkStatus);
      source = "linear";
    }
  }

  if (artifact === undefined) {
    if (input.codeHost.listPullRequestReviews === undefined) return { kind: "no_feedback" };
    const review = latestUnprocessedChangesRequestedReview(
      await input.codeHost.listPullRequestReviews(pullRequest.id),
      processed,
    );
    if (review === undefined) {
      return processed.size > 0 ? { kind: "already_processed" } : { kind: "no_feedback" };
    }
    artifact = githubReviewFeedbackArtifact(input.issueKey, pullRequest, review);
    source = "github";
  }

  const payload = artifact.payload as { body?: unknown; summary?: unknown };
  const reason =
    typeof payload.summary === "string"
      ? payload.summary
      : typeof payload.body === "string"
        ? payload.body
        : undefined;
  const event: WorkflowEvent = {
    type: artifact.kind === "human.review" ? "human_changes_requested" : "review_changes_requested",
    issueId: input.issueKey,
    artifactId: artifact.id,
    ...(reason === undefined ? {} : { reason }),
  };
  const result = transitionWorkflow(replay.snapshot, event);
  await input.store.appendEvent(input.issueKey, event, [artifact]);
  await syncReworkIssueStatus(input);
  return {
    kind: "ingested",
    source: source!,
    artifactId: artifact.id,
    state: result.snapshot.state,
  };
};
