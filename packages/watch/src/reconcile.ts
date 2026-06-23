import type {
  BranchPullRequest,
  CodeHostAdapter,
  IssueRecord,
  IssueTrackerAdapter,
  PullRequestReview,
  PullRequestReviewComment,
} from "@aigile/adapters";
import type { WorkflowArtifact } from "@aigile/types";
import {
  initialWorkflowSnapshot,
  replayWorkflow,
  transitionWorkflow,
  type RunStore,
} from "@aigile/workflow";

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

export interface IngestExternalReviewFeedbackInput {
  issueKey: string;
  branchName: string;
  target: { owner: string; repo: string };
  codeHost: CodeHostAdapter;
  store: RunStore;
  issue?: IssueRecord;
  reworkStatus?: string;
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

const processedReviewFeedback = (
  artifacts: readonly WorkflowArtifact[],
): Map<string, WorkflowArtifact> => {
  const processed = new Map<string, WorkflowArtifact>();
  for (const artifact of artifacts) {
    if (artifact.kind !== "review.feedback") continue;
    const payload = artifact.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) continue;
    const signalId = (payload as { signalId?: unknown }).signalId;
    if (typeof signalId === "string" && signalId.length > 0) processed.set(signalId, artifact);
  }
  return processed;
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

const reviewCommentsPayload = (comments: readonly PullRequestReviewComment[]) =>
  comments.map((comment) => ({
    id: comment.id,
    body: comment.body,
    ...(comment.path === undefined ? {} : { path: comment.path }),
    ...(comment.line === undefined ? {} : { line: comment.line }),
  }));

const githubReviewFeedbackArtifact = (
  issueKey: string,
  pullRequest: BranchPullRequest,
  review: PullRequestReview,
): WorkflowArtifact => ({
  id: `review-feedback:${safeIdPart(issueKey)}:${safeIdPart(review.id)}`,
  kind: "review.feedback",
  source: "github",
  payload: {
    source: "github",
    signalId: review.id,
    pullRequestId: pullRequest.id,
    pullRequestUrl: pullRequest.url,
    submittedAt: review.submittedAt,
    body: review.body,
    ...(review.author === undefined ? {} : { author: review.author }),
    comments: reviewCommentsPayload(review.comments),
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

  const reason =
    typeof (artifact.payload as { body?: unknown }).body === "string"
      ? (artifact.payload as { body: string }).body
      : undefined;
  const event = {
    type: "review_changes_requested" as const,
    issueId: input.issueKey,
    artifactId: artifact.id,
    ...(reason === undefined ? {} : { reason }),
  };
  const result = transitionWorkflow(replay.snapshot, event);
  await input.store.appendEvent(input.issueKey, event, [artifact]);
  return {
    kind: "ingested",
    source: source!,
    artifactId: artifact.id,
    state: result.snapshot.state,
  };
};
