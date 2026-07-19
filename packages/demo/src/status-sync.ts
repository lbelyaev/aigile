import type { IssueTrackerAdapter, PullRequestRecord } from "@aigile/adapters";
import { DEFAULT_ISSUE_STATUS_LABELS, type IssueStatusLabels } from "@aigile/config";
import type { WorkflowArtifact, WorkflowState } from "@aigile/types";

export const issueStatusLabelForState = (
  state: WorkflowState,
  labels: IssueStatusLabels = DEFAULT_ISSUE_STATUS_LABELS,
  originalStatus = "Todo",
): string => {
  if (state === "planning") return labels.planning;
  if (
    state === "awaiting_plan_approval" ||
    state === "developing" ||
    state === "changes_requested" ||
    state === "verifying" ||
    state === "checking"
  ) {
    return labels.developing;
  }
  if (state === "merge_ready") return labels.inReview;
  if (state === "satisfied" || state === "merged") return labels.done;
  if (state === "escalated" || state === "failed") return labels.blocked;
  if (state === "cancelled") return originalStatus;
  return state;
};

const artifactIdByKind = (artifacts: readonly WorkflowArtifact[], kind: string): string =>
  artifacts.find((artifact) => artifact.kind === kind)?.id ?? "unavailable";

const appendIssueCommentOnce = async (
  tracker: IssueTrackerAdapter,
  issueKey: string,
  existingComments: readonly string[],
  comment: string,
): Promise<void> => {
  if (existingComments.includes(comment)) return;
  await tracker.appendIssueComment(issueKey, comment);
};

export const formatSatisfiedStatusComment = (
  state: WorkflowState,
  artifacts: readonly WorkflowArtifact[],
): string =>
  [
    "Aigile verified this issue is already satisfied. No code changes were required.",
    "",
    `Final state: ${state}`,
    `Verification: ${artifactIdByKind(artifacts, "verification.result")}`,
    `Checker: ${artifactIdByKind(artifacts, "checker.verdict")}`,
  ].join("\n");

export const formatPublishedStatusComment = (
  state: WorkflowState,
  pullRequest: PullRequestRecord,
  artifacts: readonly WorkflowArtifact[],
  reason?: string | undefined,
): string =>
  [
    state === "merged"
      ? "Aigile completed this issue and published the result to GitHub."
      : "Aigile published this issue to GitHub and moved it to review.",
    "",
    `Final state: ${state}`,
    `Pull request: ${pullRequest.url}`,
    ...(reason === undefined ? [] : [`Reason: ${reason}`]),
    `Verification: ${artifactIdByKind(artifacts, "verification.result")}`,
    `Checker: ${artifactIdByKind(artifacts, "checker.verdict")}`,
  ].join("\n");

export const formatPullRequestBlockedComment = (
  pullRequest: PullRequestRecord | undefined,
  reason: string | undefined,
  artifacts: readonly WorkflowArtifact[] = [],
): string =>
  [
    "Aigile published this issue to GitHub, but the pull request is blocked and was not marked done.",
    "",
    "Outcome: blocked/escalated",
    `Reason: ${reason ?? "human attention requested"}`,
    `Pull request: ${pullRequest?.url ?? "unavailable"}`,
    `Verification: ${artifactIdByKind(artifacts, "verification.result")}`,
    `Checker: ${artifactIdByKind(artifacts, "checker.verdict")}`,
  ].join("\n");

export const syncIssueStatusForState = async (input: {
  issueTracker?: IssueTrackerAdapter | undefined;
  issueKey: string;
  state: WorkflowState;
  issueStatusLabels?: Partial<IssueStatusLabels> | undefined;
  originalStatus?: string | undefined;
  artifacts?: readonly WorkflowArtifact[] | undefined;
  reason?: string | undefined;
  // Status sync is advisory: a failure (e.g. a label with no matching Linear
  // workflow state) must never crash the run. Surface it here instead of throwing.
  onError?: ((error: unknown, state: WorkflowState, status: string) => void) | undefined;
}): Promise<void> => {
  if (input.issueTracker === undefined) return;
  const tracker = input.issueTracker;
  const labels: IssueStatusLabels = {
    ...DEFAULT_ISSUE_STATUS_LABELS,
    ...(input.issueStatusLabels ?? {}),
  };
  const status = issueStatusLabelForState(input.state, labels, input.originalStatus);
  try {
    const current = await tracker.getIssue(input.issueKey).catch(() => undefined);
    if (current?.status === status) return;

    await tracker.updateIssueStatus(input.issueKey, status);

    const artifacts = input.artifacts ?? [];
    const pullRequestArtifact = artifacts.find(
      (artifact) => artifact.kind === "github.pull_request",
    );
    const pullRequest =
      pullRequestArtifact?.payload !== undefined
        ? (pullRequestArtifact.payload as PullRequestRecord)
        : undefined;
    if (input.state === "satisfied") {
      const comment = formatSatisfiedStatusComment(input.state, artifacts);
      if (current === undefined) await tracker.appendIssueComment(input.issueKey, comment);
      else await appendIssueCommentOnce(tracker, input.issueKey, current.comments, comment);
    } else if ((input.state === "merged" || input.state === "merge_ready") && pullRequest) {
      const comment = formatPublishedStatusComment(
        input.state,
        pullRequest,
        artifacts,
        input.reason,
      );
      if (current === undefined) await tracker.appendIssueComment(input.issueKey, comment);
      else await appendIssueCommentOnce(tracker, input.issueKey, current.comments, comment);
    } else if (input.state === "escalated" || input.state === "failed") {
      const comment = formatPullRequestBlockedComment(pullRequest, input.reason, artifacts);
      if (current === undefined) await tracker.appendIssueComment(input.issueKey, comment);
      else await appendIssueCommentOnce(tracker, input.issueKey, current.comments, comment);
    }
  } catch (error) {
    input.onError?.(error, input.state, status);
  }
};
