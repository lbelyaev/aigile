import {
  isArchitectPlanPayload,
  isCheckerVerdictPayload,
  isDeveloperAttemptPayload,
  type WorkflowArtifact,
  type WorkflowEvent,
} from "@aigile/types";
import {
  pullRequestToArtifact,
  type BranchPullRequest,
  type CodeHostAdapter,
  type IssueRecord,
  type IssueTrackerAdapter,
  type PullRequestChecksSummary,
  type PullRequestRecord,
  type PullRequestReviewInput,
} from "@aigile/adapters";
import type { IssueStatusLabels } from "@aigile/config";
import {
  runAssignedDeepReview,
  type DeepReviewAngle,
  type DeepReviewProgressEvent,
} from "@aigile/roles";
import {
  reviewRoleForChangedFiles,
  reviewStrategyForChangedFiles,
  type WorkflowCommandHandlers,
  type WorkflowReviewStrategy,
  type WorkflowReviewStrategyConfig,
} from "@aigile/workflow";
import { withPublishRetry, type PublishRetryOptions } from "@aigile/workspace";
import { effectiveMergePolicy, type MergePolicy } from "./merge-policy.js";
import { syncIssueStatusForState } from "./status-sync.js";

export interface EngineHandlerDeps {
  issue: IssueRecord;
  branchName: string;
  pullRequestTarget: { owner: string; repo: string; baseBranch: string };
  codeHost: CodeHostAdapter;
  // Side effects bound by the caller to the real adapters (or fakes in tests).
  runRole: (
    roleId: string,
    inputArtifacts: readonly WorkflowArtifact[],
  ) => Promise<WorkflowArtifact>;
  verify: (inputArtifacts: readonly WorkflowArtifact[]) => Promise<WorkflowArtifact>;
  publish: () => Promise<void>;
  // LBE-45 (Aider-pattern checkpointing): commit the current worktree as a
  // restorable checkpoint before review. Returns the commit SHA (undefined if the
  // tree is clean). Omit to keep the legacy uncommitted-worktree behavior.
  checkpoint?: (message: string) => Promise<string | undefined>;
  // LBE-45: restore the worktree to a prior checkpoint SHA (git reset --hard) so the
  // loop can revert a regressed attempt to the best one and escalate the best diff.
  restoreCheckpoint?: (ref: string) => Promise<void>;
  mergePolicy?: MergePolicy;
  issueTracker?: IssueTrackerAdapter;
  issueStatusLabels?: Partial<IssueStatusLabels>;
  reviewStrategies?: WorkflowReviewStrategyConfig;
  publishRetry?: PublishRetryOptions;
  onDeepReviewProgress?: (event: DeepReviewProgressEvent) => void;
}

const findLatestByKind = (
  artifacts: readonly WorkflowArtifact[],
  kind: string,
): WorkflowArtifact | undefined => {
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (artifact?.kind === kind) return artifact;
  }
  return undefined;
};

const requireByKind = (artifacts: readonly WorkflowArtifact[], kind: string): WorkflowArtifact => {
  const artifact = findLatestByKind(artifacts, kind);
  if (artifact === undefined) throw new Error(`Missing ${kind} artifact`);
  return artifact;
};

const artifactWithRunSuffix = (artifact: WorkflowArtifact, suffix: string): WorkflowArtifact => {
  const cloned = structuredClone(artifact);
  return { ...cloned, id: `${cloned.id}:${suffix}` };
};

const nextArtifactSequence = (artifacts: readonly WorkflowArtifact[], kind: string): number =>
  artifacts.filter((artifact) => artifact.kind === kind).length + 1;

// Anti-drift (LBE-45): on a retry the developer should fix exactly the latest
// findings against the current worktree, not re-litigate the whole history. Older
// attempts/verdicts in the input invite rewrites that regress (LBE-34 wandered
// 3->1->3->3->4 findings). Collapse the iterative kinds to their most recent
// instance and keep all other context (issue, plan, policy, workspace) intact.
const ITERATIVE_KINDS = new Set(["developer.attempt", "checker.verdict", "verification.result"]);

export const focusedDeveloperInput = (
  artifacts: readonly WorkflowArtifact[],
): readonly WorkflowArtifact[] => {
  const latestByKind = new Map<string, WorkflowArtifact>();
  for (const artifact of artifacts) {
    if (ITERATIVE_KINDS.has(artifact.kind)) latestByKind.set(artifact.kind, artifact);
  }
  return artifacts.filter(
    (artifact) =>
      !ITERATIVE_KINDS.has(artifact.kind) || latestByKind.get(artifact.kind) === artifact,
  );
};

const deepReviewFindingCount = (verdict: WorkflowArtifact): number => {
  if (!isCheckerVerdictPayload(verdict.payload)) return 0;
  return verdict.payload.verdict === "pass" ? 0 : verdict.payload.reasons.length;
};

// Escalate-the-best (LBE-45): when a deep-review loop escalates, the worktree holds
// the LAST attempt, which may not be the best — LBE-34 drifted 3->1->3->3->4 findings
// and escalated with 4 despite attempt 2 having only 1. Surface the lowest-finding
// attempt and its punch-list so whoever picks up the escalation knows which attempt
// to build on. Returns undefined when there is nothing useful to flag (fewer than
// two reviews, or the last attempt already is the best). The worktree itself is reset
// to this best attempt by restoreToBestIfRegressed; this is the human-readable report.
export const summarizeBestAttempt = (
  artifacts: readonly WorkflowArtifact[],
): string | undefined => {
  const verdicts = artifacts.filter((artifact) => artifact.kind === "checker.verdict");
  if (verdicts.length < 2) return undefined;
  const scored = verdicts.map((verdict, index) => ({
    attempt: index + 1,
    findings: deepReviewFindingCount(verdict),
    verdict,
  }));
  const best = scored.reduce((lowest, current) =>
    current.findings < lowest.findings ? current : lowest,
  );
  const last = scored[scored.length - 1]!;
  if (best.attempt === last.attempt) return undefined;
  const reasons = isCheckerVerdictPayload(best.verdict.payload) ? best.verdict.payload.reasons : [];
  return [
    `Best attempt was attempt ${best.attempt} (${best.findings} finding(s)); the current worktree reflects attempt ${last.attempt} (${last.findings} finding(s)).`,
    `Lowest-finding review (attempt ${best.attempt}):`,
    ...reasons.map((reason) => `- ${reason}`),
  ].join("\n");
};

// LBE-45: among verdicts that recorded a worktree checkpoint, the best is the one
// with the fewest findings. Returns its ref + findings, or undefined if none.
const bestCheckpoint = (
  artifacts: readonly WorkflowArtifact[],
): { ref: string; findings: number } | undefined => {
  let best: { ref: string; findings: number } | undefined;
  for (const artifact of artifacts) {
    if (artifact.kind !== "checker.verdict") continue;
    const ref = artifact.provenance?.worktreeCheckpoint;
    if (ref === undefined) continue;
    const findings = deepReviewFindingCount(artifact);
    if (best === undefined || findings < best.findings) best = { ref, findings };
  }
  return best;
};

// Findings of the most recently checkpointed verdict (the attempt just reviewed).
const latestCheckpointFindings = (artifacts: readonly WorkflowArtifact[]): number | undefined => {
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (
      artifact?.kind === "checker.verdict" &&
      artifact.provenance?.worktreeCheckpoint !== undefined
    )
      return deepReviewFindingCount(artifact);
  }
  return undefined;
};

// Anti-drift restore: if the attempt just reviewed scored worse than the best
// checkpoint so far, revert the worktree to the best one. Returns the ref restored
// to (for logging/escalation), or undefined when no restore was needed.
const restoreToBestIfRegressed = async (
  deps: EngineHandlerDeps,
  artifacts: readonly WorkflowArtifact[],
): Promise<string | undefined> => {
  const best = bestCheckpoint(artifacts);
  const latest = latestCheckpointFindings(artifacts);
  if (best === undefined || latest === undefined || latest <= best.findings) return undefined;
  await deps.restoreCheckpoint?.(best.ref);
  return best.ref;
};

const checkerBaseEvent = (
  verdict: WorkflowArtifact,
): "checker_passed" | "checker_requested_changes" | "checker_escalated" => {
  if (!isCheckerVerdictPayload(verdict.payload)) {
    throw new Error(`Checker artifact payload is invalid: ${verdict.id}`);
  }
  if (verdict.payload.verdict === "pass") return "checker_passed";
  if (verdict.payload.verdict === "changes_requested") return "checker_requested_changes";
  return "checker_escalated";
};

const developerHasChanges = (attempt: WorkflowArtifact): boolean => {
  if (!isDeveloperAttemptPayload(attempt.payload)) {
    throw new Error(`Developer artifact payload is invalid: ${attempt.id}`);
  }
  return attempt.payload.changedFiles.length > 0;
};

const developerChangedFiles = (attempt: WorkflowArtifact): readonly string[] => {
  if (!isDeveloperAttemptPayload(attempt.payload)) {
    throw new Error(`Developer artifact payload is invalid: ${attempt.id}`);
  }
  return attempt.payload.changedFiles;
};

const reviewStrategyArtifact = (
  issueKey: string,
  attemptNumber: number,
  strategy: WorkflowReviewStrategy,
): WorkflowArtifact => ({
  id: `review-strategy:${issueKey}:attempt-${attemptNumber}`,
  kind: "review.strategy",
  source: "system",
  payload: strategy,
});

const deepReviewModeForStrategy = (
  strategy: WorkflowReviewStrategy,
): "fail-fast" | "bounded" | "full" => {
  if (strategy.mode === "full") return "full";
  if (strategy.mode === "deep-parallel") return "bounded";
  return "fail-fast";
};

const deepReviewAnglesForStrategy = (
  strategy: WorkflowReviewStrategy,
): readonly DeepReviewAngle[] =>
  strategy.angles.filter((angle): angle is DeepReviewAngle =>
    ["correctness", "removed-behavior", "cross-file", "tests-faithful-to-reality"].includes(angle),
  );

const checkerReview = (verdict: WorkflowArtifact): PullRequestReviewInput => {
  if (!isCheckerVerdictPayload(verdict.payload))
    return { event: "comment", body: "Checker verdict" };
  const body = [verdict.payload.summary, "", ...verdict.payload.reasons.map((r) => `- ${r}`)].join(
    "\n",
  );
  if (verdict.payload.verdict === "pass") return { event: "approve", body };
  if (verdict.payload.verdict === "changes_requested") return { event: "request_changes", body };
  return { event: "comment", body };
};

const isSelfReviewFailure = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /can not approve your own pull request|cannot approve your own pull request/i.test(
    message,
  );
};

const publishCheckerFeedback = async (
  codeHost: CodeHostAdapter,
  pullRequestId: string,
  review: PullRequestReviewInput,
): Promise<void> => {
  try {
    await codeHost.submitPullRequestReview(pullRequestId, review);
  } catch (error) {
    if (!isSelfReviewFailure(error)) throw error;
    await codeHost.appendPullRequestComment(
      pullRequestId,
      ["## Aigile checker review", "", review.body].join("\n"),
    );
  }
};

const formatCheckDetails = (checks: PullRequestChecksSummary): string => {
  const actionable = checks.checks.filter(
    (check) => check.state === "failing" || check.state === "unknown",
  );
  const selected = actionable.length > 0 ? actionable : checks.checks;
  if (selected.length === 0) return "no check details available";
  return selected
    .map((check) =>
      check.detailsUrl === undefined ? check.name : `${check.name} (${check.detailsUrl})`,
    )
    .join(", ");
};

// Honest verification gate: only an explicit "passed" status passes (AIG-5).
const verificationPassed = (artifact: WorkflowArtifact): boolean => {
  const payload = artifact.payload;
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as { status?: unknown }).status === "passed"
  );
};

const pullRequestBody = (
  issue: IssueRecord,
  plan: WorkflowArtifact | undefined,
  attempt: WorkflowArtifact | undefined,
  verdict: WorkflowArtifact | undefined,
  mergePolicy: MergePolicy,
): string => {
  const lines = [`Aigile run for ${issue.key}: ${issue.title}`, ""];
  lines.push(`Merge policy: ${mergePolicy}`, "");
  if (plan !== undefined && isArchitectPlanPayload(plan.payload)) {
    lines.push(`Plan: ${plan.payload.summary}`, "");
  }
  if (attempt !== undefined && isDeveloperAttemptPayload(attempt.payload)) {
    lines.push(
      `Developer: ${attempt.payload.summary}`,
      "",
      "Changed files:",
      ...attempt.payload.changedFiles.map((file) => `- ${file}`),
      "",
    );
  }
  if (verdict !== undefined && isCheckerVerdictPayload(verdict.payload)) {
    lines.push(`Checker: ${verdict.payload.verdict} — ${verdict.payload.summary}`);
  }
  return lines.join("\n");
};

// Build a pull-request artifact from a branch lookup, for the resume path where
// the full record isn't in memory (a fresh process). comments/checks/reviews are
// already posted on the PR itself; the artifact only needs to carry PR identity.
const branchPullRequestArtifact = (
  pr: BranchPullRequest,
  issue: IssueRecord,
  branchName: string,
  target: { owner: string; repo: string; baseBranch: string },
): WorkflowArtifact => {
  const record: PullRequestRecord = {
    owner: target.owner,
    repo: target.repo,
    branch: branchName,
    baseBranch: target.baseBranch,
    title: `${issue.key} ${issue.title}`,
    body: "",
    id: pr.id,
    number: pr.number,
    url: pr.url,
    comments: [],
    checks: [],
    reviews: [],
  };
  return pullRequestToArtifact(record);
};

const hasManualMergePolicyComment = (comments: readonly string[]): boolean =>
  comments.some(
    (comment) =>
      comment.includes("Merge policy: manual") && comment.includes("manual merge policy"),
  );

const artifactsHaveManualMergePolicyComment = (artifacts: readonly WorkflowArtifact[]): boolean =>
  artifacts.some((artifact) => {
    if (artifact.kind !== "github.pull_request") return false;
    const payload = artifact.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
    const comments = (payload as { comments?: unknown }).comments;
    return Array.isArray(comments) && hasManualMergePolicyComment(comments);
  });

const addPullRequestCommentToArtifact = (
  artifact: WorkflowArtifact,
  comment: string,
): WorkflowArtifact => {
  const cloned = structuredClone(artifact);
  const payload = cloned.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return cloned;
  const comments = (payload as { comments?: unknown }).comments;
  if (!Array.isArray(comments) || hasManualMergePolicyComment(comments)) return cloned;
  (payload as { comments: string[] }).comments = [...comments, comment];
  return cloned;
};

const addCommentToPullRequestArtifact = (
  artifact: WorkflowArtifact,
  comment: string,
  hasComment: (comments: readonly string[]) => boolean,
): WorkflowArtifact => {
  const cloned = structuredClone(artifact);
  const payload = cloned.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return cloned;
  const comments = (payload as { comments?: unknown }).comments;
  if (!Array.isArray(comments) || hasComment(comments)) return cloned;
  (payload as { comments: string[] }).comments = [...comments, comment];
  return cloned;
};

const reworkAttemptMarker = (attemptNumber: number): string =>
  `<!-- aigile:rework-attempt:${attemptNumber} -->`;

const hasReworkAttemptComment = (comments: readonly string[], attemptNumber: number): boolean =>
  comments.some((comment) => comment.includes(reworkAttemptMarker(attemptNumber)));

const artifactsHaveReworkAttemptComment = (
  artifacts: readonly WorkflowArtifact[],
  attemptNumber: number,
): boolean =>
  artifacts.some((artifact) => {
    if (artifact.kind !== "github.pull_request") return false;
    const payload = artifact.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
    const comments = (payload as { comments?: unknown }).comments;
    return Array.isArray(comments) && hasReworkAttemptComment(comments, attemptNumber);
  });

const latestHumanFeedback = (
  artifacts: readonly WorkflowArtifact[],
): WorkflowArtifact | undefined => {
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (artifact?.kind === "human.review" || artifact?.kind === "review.feedback") return artifact;
  }
  return undefined;
};

const textFromPayloadField = (payload: unknown, field: string): string | undefined => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const feedbackReference = (feedback: WorkflowArtifact): string | undefined => {
  const payload = feedback.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const prReview = (payload as { prReview?: unknown }).prReview;
  if (typeof prReview !== "object" || prReview === null || Array.isArray(prReview)) {
    return textFromPayloadField(payload, "signalId");
  }
  const url = (prReview as { pullRequestUrl?: unknown }).pullRequestUrl;
  const reviewId = (prReview as { reviewId?: unknown }).reviewId;
  if (typeof url === "string" && url.length > 0) {
    return typeof reviewId === "string" && reviewId.length > 0 ? `${url} (${reviewId})` : url;
  }
  return typeof reviewId === "string" && reviewId.length > 0 ? reviewId : undefined;
};

const feedbackText = (feedback: WorkflowArtifact): string => {
  const payload = feedback.payload;
  const body =
    textFromPayloadField(payload, "body") ??
    textFromPayloadField(payload, "summary") ??
    textFromPayloadField(payload, "status") ??
    feedback.id;
  return body.length > 1_200 ? `${body.slice(0, 1_197)}...` : body;
};

const quoteBlock = (value: string): string =>
  value
    .split(/\r?\n/)
    .slice(0, 20)
    .map((line) => `> ${line}`)
    .join("\n");

const formatReworkAttemptComment = (
  attemptNumber: number,
  attempt: WorkflowArtifact,
  feedback: WorkflowArtifact,
): string => {
  const summary = isDeveloperAttemptPayload(attempt.payload)
    ? attempt.payload.summary
    : "developer attempt completed";
  const reference = feedbackReference(feedback);
  return [
    reworkAttemptMarker(attemptNumber),
    `## Aigile rework attempt ${attemptNumber}`,
    "",
    `Developer: ${summary}`,
    "",
    "Human feedback:",
    quoteBlock(feedbackText(feedback)),
    ...(reference === undefined ? [] : ["", `Feedback source: ${reference}`]),
  ].join("\n");
};

const pullRequestHasReworkAttemptComment = async (
  codeHost: CodeHostAdapter,
  prId: string,
  artifacts: readonly WorkflowArtifact[],
  attemptNumber: number,
): Promise<boolean> => {
  if (artifactsHaveReworkAttemptComment(artifacts, attemptNumber)) return true;
  try {
    return hasReworkAttemptComment((await codeHost.getPullRequest(prId)).comments, attemptNumber);
  } catch {
    return false;
  }
};

const issueHasManualMergePolicyComment = async (
  issueTracker: IssueTrackerAdapter | undefined,
  issueKey: string,
): Promise<boolean> => {
  if (issueTracker === undefined) return false;
  try {
    return hasManualMergePolicyComment((await issueTracker.getIssue(issueKey)).comments);
  } catch {
    return false;
  }
};

const eventFor = (
  type: WorkflowEvent["type"],
  issueId: string,
  extra?: { artifactId?: string; reason?: string },
): WorkflowEvent => {
  const event: WorkflowEvent = { type, issueId };
  if (extra?.artifactId !== undefined) event.artifactId = extra.artifactId;
  if (extra?.reason !== undefined) event.reason = extra.reason;
  return event;
};

/**
 * Build the engine's command handlers from the real side-effect adapters. Each
 * handler performs its side effect and returns the event that drives the next
 * transition; the merge handler publishes the PR and then either auto-merges a
 * green PR (default) or pauses (manual policy / not-yet-mergeable) for an
 * external merge.
 */
export const createEngineCommandHandlers = (deps: EngineHandlerDeps): WorkflowCommandHandlers => {
  const { issue, codeHost, branchName, pullRequestTarget } = deps;
  const mergePolicy = effectiveMergePolicy(deps.mergePolicy, issue.description);
  const manualMergePolicyReason =
    "held by manual merge policy; PR remains open in review until a human merges it.";

  return {
    start_architect_plan: async (ctx) => {
      const artifact = artifactWithRunSuffix(
        await deps.runRole("architect", ctx.artifacts),
        `plan-${nextArtifactSequence(ctx.artifacts, "architect.plan")}`,
      );
      return { event: eventFor("plan_drafted", issue.key, { artifactId: artifact.id }), artifact };
    },
    request_plan_approval: async () => ({ event: eventFor("plan_approved", issue.key) }),
    start_developer_attempt: async (ctx) => {
      if (ctx.snapshot.state === "changes_requested") {
        await syncIssueStatusForState({
          issueTracker: deps.issueTracker,
          issueKey: issue.key,
          state: ctx.snapshot.state,
          issueStatusLabels: deps.issueStatusLabels,
          originalStatus: issue.status,
          artifacts: ctx.artifacts,
          reason: ctx.command.reason,
        });
      }
      // Anti-drift regression gate: if the attempt just reviewed scored worse than
      // the best checkpoint, revert the worktree to the best one so this attempt
      // hill-climbs from the best instead of building on a regression.
      await restoreToBestIfRegressed(deps, ctx.artifacts);
      const artifact = artifactWithRunSuffix(
        await deps.runRole("developer", focusedDeveloperInput(ctx.artifacts)),
        `attempt-${ctx.snapshot.developerAttempts}`,
      );
      return {
        event: eventFor("developer_finished", issue.key, { artifactId: artifact.id }),
        artifact,
      };
    },
    run_verification: async (ctx) => {
      const artifact = artifactWithRunSuffix(
        await deps.verify(ctx.artifacts),
        `attempt-${ctx.snapshot.developerAttempts}`,
      );
      const type = verificationPassed(artifact) ? "verification_passed" : "verification_failed";
      return { event: eventFor(type, issue.key, { artifactId: artifact.id }), artifact };
    },
    start_checker_review: async (ctx) => {
      const attempt = requireByKind(ctx.artifacts, "developer.attempt");
      // Checkpoint the attempt before review (after verification, so the verifier's
      // working-tree guard is unaffected). The reviewer then diffs base...HEAD, and
      // the loop can later reset --hard back to the best attempt.
      const checkpointRef = await deps.checkpoint?.(
        `${issue.key} attempt ${ctx.snapshot.developerAttempts} (checkpoint)`,
      );
      const changedFiles = developerChangedFiles(attempt);
      const hasConfiguredReviewStrategies = deps.reviewStrategies !== undefined;
      const reviewStrategy = reviewStrategyForChangedFiles(changedFiles, deps.reviewStrategies);
      const reviewRole = reviewRoleForChangedFiles(changedFiles, deps.reviewStrategies);
      const reviewArtifacts = hasConfiguredReviewStrategies
        ? [
            ...ctx.artifacts,
            reviewStrategyArtifact(issue.key, ctx.snapshot.developerAttempts, reviewStrategy),
          ]
        : ctx.artifacts;
      const checkpointArtifacts = ctx.checkpointArtifacts;
      const configuredDeepReviewOptions = hasConfiguredReviewStrategies
        ? {
            angles: deepReviewAnglesForStrategy(reviewStrategy),
            deepReviewMode: deepReviewModeForStrategy(reviewStrategy),
            maxDeepReviewCalls: reviewStrategy.validationBudget.maxCalls,
            maxDeepReviewMinutes: reviewStrategy.validationBudget.maxMinutes,
            maxSurvivingFindings: reviewStrategy.maxFindings,
            maxFindingsPerAngle: reviewStrategy.maxFindings,
            maxRefutationsTotal: reviewStrategy.validationBudget.maxCalls,
            angleConcurrency: reviewStrategy.concurrency,
            reviewStrategyMode: reviewStrategy.mode,
            ...(reviewStrategy.skillHints === undefined
              ? {}
              : { skillHints: reviewStrategy.skillHints }),
          }
        : {};
      const reviewed = artifactWithRunSuffix(
        reviewRole === "deep_reviewer"
          ? await runAssignedDeepReview({
              issueId: issue.key,
              inputArtifacts: reviewArtifacts,
              ...configuredDeepReviewOptions,
              ...(checkpointArtifacts === undefined
                ? {}
                : { checkpointArtifact: (artifact) => checkpointArtifacts([artifact]) }),
              ...(deps.onDeepReviewProgress === undefined
                ? {}
                : { onProgress: deps.onDeepReviewProgress }),
              runRole: deps.runRole,
            })
          : await deps.runRole(reviewRole, reviewArtifacts),
        `attempt-${ctx.snapshot.developerAttempts}`,
      );
      // Tag the verdict with the checkpoint it reviewed so the loop can find and
      // restore the best-scoring attempt later (regression gate / escalate-best).
      const verdict: WorkflowArtifact =
        checkpointRef === undefined
          ? reviewed
          : {
              ...reviewed,
              provenance: { ...reviewed.provenance, worktreeCheckpoint: checkpointRef },
            };
      const base = checkerBaseEvent(verdict);
      const baseType =
        base === "checker_passed" && !developerHasChanges(attempt) ? "work_satisfied" : base;
      // Route a deep reviewer's change-request to its own event so the FSM can
      // grant it the larger deep-review retry budget (vs the light checker).
      const type =
        reviewRole === "deep_reviewer" && baseType === "checker_requested_changes"
          ? "review_changes_requested"
          : baseType;
      const reason = isCheckerVerdictPayload(verdict.payload) ? verdict.payload.summary : undefined;
      return {
        event: eventFor(type, issue.key, { artifactId: verdict.id, ...(reason ? { reason } : {}) }),
        artifact: verdict,
      };
    },
    merge_pull_request: async (ctx) => {
      try {
        // Idempotent on resume: if the PR already exists for this branch, reuse it
        // and skip publish/create/evidence so a re-run never double-creates.
        const existing = await codeHost.findPullRequestForBranch(branchName, pullRequestTarget);
        let prId: string;
        let prArtifact: WorkflowArtifact;
        if (existing !== undefined) {
          if (existing.mergeState === "merged") {
            return {
              event: eventFor("merge_completed", issue.key),
              artifact: branchPullRequestArtifact(existing, issue, branchName, pullRequestTarget),
            };
          }
          if (!existing.open) {
            return {
              event: eventFor("publish_failed", issue.key, {
                reason: `pull request is closed without merge; refusing to reuse ${existing.url}`,
              }),
              artifact: branchPullRequestArtifact(existing, issue, branchName, pullRequestTarget),
            };
          }
          prId = existing.id;
          prArtifact = branchPullRequestArtifact(existing, issue, branchName, pullRequestTarget);
          const latestAttempt = findLatestByKind(ctx.artifacts, "developer.attempt");
          const feedback = latestHumanFeedback(ctx.artifacts);
          const isHumanRework =
            ctx.snapshot.developerAttempts > 1 &&
            latestAttempt !== undefined &&
            feedback !== undefined;
          if (isHumanRework) {
            await deps.publish();
            const alreadyCommented = await pullRequestHasReworkAttemptComment(
              codeHost,
              prId,
              ctx.artifacts,
              ctx.snapshot.developerAttempts,
            );
            if (!alreadyCommented) {
              const comment = formatReworkAttemptComment(
                ctx.snapshot.developerAttempts,
                latestAttempt,
                feedback,
              );
              await codeHost.appendPullRequestComment(prId, comment);
              prArtifact = addCommentToPullRequestArtifact(prArtifact, comment, (comments) =>
                hasReworkAttemptComment(comments, ctx.snapshot.developerAttempts),
              );
            }
            await syncIssueStatusForState({
              issueTracker: deps.issueTracker,
              issueKey: issue.key,
              state: ctx.snapshot.state,
              issueStatusLabels: deps.issueStatusLabels,
              originalStatus: issue.status,
              artifacts: [...ctx.artifacts, prArtifact],
            });
          }
        } else {
          await deps.publish();
          const plan = findLatestByKind(ctx.artifacts, "architect.plan");
          const attempt = findLatestByKind(ctx.artifacts, "developer.attempt");
          const verdict = findLatestByKind(ctx.artifacts, "checker.verdict");

          const pr = await withPublishRetry(
            "create pull request",
            () =>
              codeHost.createPullRequest({
                owner: pullRequestTarget.owner,
                repo: pullRequestTarget.repo,
                branch: branchName,
                baseBranch: pullRequestTarget.baseBranch,
                title: `${issue.key} ${issue.title}`,
                body: pullRequestBody(issue, plan, attempt, verdict, mergePolicy),
              }),
            deps.publishRetry,
          );
          if (attempt !== undefined && isDeveloperAttemptPayload(attempt.payload)) {
            await codeHost.appendPullRequestComment(
              pr.id,
              `Developer attempt:\n${attempt.payload.summary}`,
            );
          }
          await codeHost.recordCheckResult(pr.id, {
            name: "aigile/verifier",
            status: "passed",
            summary: "Verification passed.",
          });
          if (verdict !== undefined) {
            await publishCheckerFeedback(codeHost, pr.id, checkerReview(verdict));
          }
          prId = pr.id;
          prArtifact = pullRequestToArtifact(await codeHost.getPullRequest(pr.id));
        }

        // Manual override: publish the PR and pause for a human/CI to merge.
        if (mergePolicy === "manual") {
          const manualPolicyComment = [
            `Merge policy: manual`,
            `Reason: ${manualMergePolicyReason}`,
          ].join("\n");
          const alreadyRecordedManualPolicy =
            artifactsHaveManualMergePolicyComment(ctx.artifacts) ||
            (await issueHasManualMergePolicyComment(deps.issueTracker, issue.key));
          if (!alreadyRecordedManualPolicy) {
            await codeHost.appendPullRequestComment(prId, manualPolicyComment);
          }
          await syncIssueStatusForState({
            issueTracker: deps.issueTracker,
            issueKey: issue.key,
            state: ctx.snapshot.state,
            issueStatusLabels: deps.issueStatusLabels,
            originalStatus: issue.status,
            artifacts: [...ctx.artifacts, prArtifact],
            reason: `Merge policy: manual; ${manualMergePolicyReason}`,
          });
          return {
            artifact: alreadyRecordedManualPolicy
              ? prArtifact
              : addPullRequestCommentToArtifact(prArtifact, manualPolicyComment),
          };
        }

        const state = await codeHost.getPullRequestMergeState(prId);
        if (state.status === "merged") {
          return { event: eventFor("merge_completed", issue.key), artifact: prArtifact };
        }
        const mergeability = await codeHost.getPullRequestMergeability(prId);
        if (mergeability.status === "conflicting") {
          return {
            event: eventFor("publish_failed", issue.key, {
              reason: "pull request has merge conflicts",
            }),
            artifact: prArtifact,
          };
        }
        const checks = await codeHost.getPullRequestChecks(prId);
        if (checks.status === "pending") {
          await syncIssueStatusForState({
            issueTracker: deps.issueTracker,
            issueKey: issue.key,
            state: ctx.snapshot.state,
            issueStatusLabels: deps.issueStatusLabels,
            originalStatus: issue.status,
            artifacts: [...ctx.artifacts, prArtifact],
          });
          return { artifact: prArtifact };
        }
        if (checks.status === "failing" || checks.status === "unknown") {
          const reason =
            checks.status === "failing"
              ? `pull request checks failed: ${formatCheckDetails(checks)}`
              : `pull request check status is unknown: ${formatCheckDetails(checks)}`;
          return { event: eventFor("publish_failed", issue.key, { reason }), artifact: prArtifact };
        }
        if (mergeability.status === "blocked" || mergeability.status === "unknown") {
          const reason =
            mergeability.status === "blocked"
              ? "pull request is blocked by branch protection or missing reviews"
              : "pull request mergeability is unknown";
          return { event: eventFor("publish_failed", issue.key, { reason }), artifact: prArtifact };
        }
        if (mergeability.status === "mergeable") {
          await codeHost.mergePullRequest(prId);
          return { event: eventFor("merge_completed", issue.key), artifact: prArtifact };
        }
        await syncIssueStatusForState({
          issueTracker: deps.issueTracker,
          issueKey: issue.key,
          state: ctx.snapshot.state,
          issueStatusLabels: deps.issueStatusLabels,
          originalStatus: issue.status,
          artifacts: [...ctx.artifacts, prArtifact],
        });
        return { artifact: prArtifact };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { event: eventFor("publish_failed", issue.key, { reason }) };
      }
    },
    sync_sources_of_truth: async (ctx) => {
      await syncIssueStatusForState({
        issueTracker: deps.issueTracker,
        issueKey: issue.key,
        state: ctx.snapshot.state,
        issueStatusLabels: deps.issueStatusLabels,
        originalStatus: issue.status,
        artifacts: ctx.artifacts,
        reason: ctx.command.reason,
      });
      return {};
    },
    request_human_attention: async (ctx) => {
      // Escalate-the-best: leave the worktree at the best attempt, not the last.
      await restoreToBestIfRegressed(deps, ctx.artifacts);
      const bestAttempt = summarizeBestAttempt(ctx.artifacts);
      const reason =
        bestAttempt === undefined
          ? ctx.command.reason
          : [ctx.command.reason, bestAttempt].filter(Boolean).join("\n\n");
      await syncIssueStatusForState({
        issueTracker: deps.issueTracker,
        issueKey: issue.key,
        state: ctx.snapshot.state,
        issueStatusLabels: deps.issueStatusLabels,
        originalStatus: issue.status,
        artifacts: ctx.artifacts,
        ...(reason === undefined ? {} : { reason }),
      });
      return {};
    },
  };
};
