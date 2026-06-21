import {
  isArchitectPlanPayload,
  isCheckerVerdictPayload,
  isDeveloperAttemptPayload,
  type WorkflowArtifact,
  type WorkflowEvent,
} from "@aigile/types";
import {
  pullRequestToArtifact,
  type CodeHostAdapter,
  type IssueRecord,
  type PullRequestReviewInput,
} from "@aigile/adapters";
import type { WorkflowCommandHandlers } from "@aigile/workflow";
import { resolveMergePolicy, type MergePolicy } from "./merge-policy.js";

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
  mergePolicy?: MergePolicy;
}

const findByKind = (
  artifacts: readonly WorkflowArtifact[],
  kind: string,
): WorkflowArtifact | undefined => artifacts.find((artifact) => artifact.kind === kind);

const requireByKind = (artifacts: readonly WorkflowArtifact[], kind: string): WorkflowArtifact => {
  const artifact = findByKind(artifacts, kind);
  if (artifact === undefined) throw new Error(`Missing ${kind} artifact`);
  return artifact;
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
): string => {
  const lines = [`Aigile run for ${issue.key}: ${issue.title}`, ""];
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
  const mergePolicy = deps.mergePolicy ?? resolveMergePolicy(issue.description);

  return {
    start_architect_plan: async (ctx) => {
      const artifact = await deps.runRole("architect", ctx.artifacts);
      return { event: eventFor("plan_drafted", issue.key, { artifactId: artifact.id }), artifact };
    },
    request_plan_approval: async () => ({ event: eventFor("plan_approved", issue.key) }),
    start_developer_attempt: async (ctx) => {
      const artifact = await deps.runRole("developer", ctx.artifacts);
      return {
        event: eventFor("developer_finished", issue.key, { artifactId: artifact.id }),
        artifact,
      };
    },
    run_verification: async (ctx) => {
      const artifact = await deps.verify(ctx.artifacts);
      const type = verificationPassed(artifact) ? "verification_passed" : "verification_failed";
      return { event: eventFor(type, issue.key, { artifactId: artifact.id }), artifact };
    },
    start_checker_review: async (ctx) => {
      const verdict = await deps.runRole("checker", ctx.artifacts);
      const base = checkerBaseEvent(verdict);
      const attempt = requireByKind(ctx.artifacts, "developer.attempt");
      const type =
        base === "checker_passed" && !developerHasChanges(attempt) ? "work_satisfied" : base;
      const reason = isCheckerVerdictPayload(verdict.payload) ? verdict.payload.summary : undefined;
      return {
        event: eventFor(type, issue.key, { artifactId: verdict.id, ...(reason ? { reason } : {}) }),
        artifact: verdict,
      };
    },
    merge_pull_request: async (ctx) => {
      try {
        await deps.publish();
        const plan = findByKind(ctx.artifacts, "architect.plan");
        const attempt = findByKind(ctx.artifacts, "developer.attempt");
        const verdict = findByKind(ctx.artifacts, "checker.verdict");

        const pr = await codeHost.createPullRequest({
          owner: pullRequestTarget.owner,
          repo: pullRequestTarget.repo,
          branch: branchName,
          baseBranch: pullRequestTarget.baseBranch,
          title: `${issue.key} ${issue.title}`,
          body: pullRequestBody(issue, plan, attempt, verdict),
        });
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
          await codeHost.submitPullRequestReview(pr.id, checkerReview(verdict));
        }
        const prArtifact = pullRequestToArtifact(await codeHost.getPullRequest(pr.id));

        // Manual override: publish the PR and pause for a human/CI to merge.
        if (mergePolicy === "manual") return { artifact: prArtifact };

        const state = await codeHost.getPullRequestMergeState(pr.id);
        if (state.status === "merged") {
          return { event: eventFor("merge_completed", issue.key), artifact: prArtifact };
        }
        const mergeability = await codeHost.getPullRequestMergeability(pr.id);
        if (mergeability.status === "mergeable") {
          await codeHost.mergePullRequest(pr.id);
          return { event: eventFor("merge_completed", issue.key), artifact: prArtifact };
        }
        // Not mergeable yet (checks pending / conflict): pause; reconcile later.
        return { artifact: prArtifact };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { event: eventFor("publish_failed", issue.key, { reason }) };
      }
    },
  };
};
