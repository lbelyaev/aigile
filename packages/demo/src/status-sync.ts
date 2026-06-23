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
): string =>
  [
    state === "merged"
      ? "Aigile completed this issue and published the result to GitHub."
      : "Aigile published this issue to GitHub and moved it to review.",
    "",
    `Final state: ${state}`,
    `Pull request: ${pullRequest.url}`,
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
}): Promise<void> => {
  if (input.issueTracker === undefined) return;
  const labels: IssueStatusLabels = {
    ...DEFAULT_ISSUE_STATUS_LABELS,
    ...(input.issueStatusLabels ?? {}),
  };
  await input.issueTracker.updateIssueStatus(
    input.issueKey,
    issueStatusLabelForState(input.state, labels, input.originalStatus),
  );

  const artifacts = input.artifacts ?? [];
  const pullRequestArtifact = artifacts.find((artifact) => artifact.kind === "github.pull_request");
  const pullRequest =
    pullRequestArtifact?.payload !== undefined
      ? (pullRequestArtifact.payload as PullRequestRecord)
      : undefined;
  if (input.state === "satisfied") {
    await input.issueTracker.appendIssueComment(
      input.issueKey,
      formatSatisfiedStatusComment(input.state, artifacts),
    );
  } else if ((input.state === "merged" || input.state === "merge_ready") && pullRequest) {
    await input.issueTracker.appendIssueComment(
      input.issueKey,
      formatPublishedStatusComment(input.state, pullRequest, artifacts),
    );
  } else if (input.state === "escalated" || input.state === "failed") {
    await input.issueTracker.appendIssueComment(
      input.issueKey,
      formatPullRequestBlockedComment(pullRequest, input.reason, artifacts),
    );
  }
};
