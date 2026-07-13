import type { IssueRecord, IssueTrackerAdapter, ReadyIssueSource } from "@aigile/adapters";
import type { IngestExternalReviewFeedbackOutcome, ReconcileOutcome } from "./reconcile.js";

export interface WatchOnceInput {
  source: ReadyIssueSource;
  tracker: IssueTrackerAdapter;
  claimStatus?: string;
  claimComment?: string;
  productRoutes?: readonly WatchProductRoute[];
}

export interface WatchOnceResult {
  readyCount: number;
  actions: string[];
  claimedIssue?: IssueRecord;
  selectedRoute?: WatchProductRoute;
  skippedIssues?: WatchSkippedIssue[];
}

export type WatchLoopStopReason = "aborted" | "max_polls";

export type WatchLoopEvent =
  | { type: "poll_started"; poll: number }
  | { type: "issue_skipped"; poll: number; issueKey: string; reason: WatchSkipReason }
  | { type: "poll_idle"; poll: number; readyCount: number }
  | {
      type: "issue_claimed";
      poll: number;
      issueKey: string;
      readyCount: number;
      selectedRoute?: WatchProductRoute;
    }
  | {
      type: "claimed_issue_run_failed";
      poll: number;
      issueKey: string;
      restoredStatus: string;
      error: string;
    }
  | { type: "issue_status_reconciled"; poll: number; issueKey: string; from: string; to: string }
  | {
      type: "external_feedback_ingested";
      poll: number;
      issueKey: string;
      source: "github" | "linear";
      outcome: string;
    }
  | { type: "run_resumed"; poll: number; issueId: string; outcome: string }
  | { type: "run_resume_failed"; poll: number; issueId: string; error: string }
  | { type: "watch_stopped"; polls: number; reason: WatchLoopStopReason };

export interface WatchLoopInput extends WatchOnceInput {
  pollIntervalMs: number;
  maxPolls?: number;
  signal?: AbortSignal;
  sleep?: (durationMs: number, signal?: AbortSignal) => Promise<void>;
  onEvent?: (event: WatchLoopEvent) => void;
  onClaimedIssue?: (issue: IssueRecord, route?: WatchProductRoute) => Promise<void>;
  reconcile?: {
    listIssues: () => Promise<IssueRecord[]>;
    reconcileIssue: (issue: IssueRecord) => Promise<ReconcileOutcome>;
    ingestExternalFeedback?: (issue: IssueRecord) => Promise<IngestExternalReviewFeedbackOutcome>;
  };
  // Resume interrupted/paused runs each poll before claiming new work.
  resume?: {
    listResumable: () => Promise<string[]>;
    resumeRun: (issueId: string) => Promise<{ outcome: string }>;
  };
}

export interface WatchProductRoute {
  productId: string;
  linearProject: string;
  githubRepo: string;
}

export type WatchSkipReason = "no_project" | "project_mismatch" | "project_ambiguous";

export interface WatchSkippedIssue {
  issueKey: string;
  reason: WatchSkipReason;
  configuredProjects: string[];
  actualProject?: string;
}

export interface RoutedReadyIssue {
  issue: IssueRecord;
  route: WatchProductRoute;
}

const defaultClaimStatus = "aigile:claimed";
const defaultClaimComment = "Aigile claimed this issue for local processing.";

const defaultSleep = async (durationMs: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, durationMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
};

const normalizedProjectIdentifier = (value: string): string => value.trim().toLowerCase();

const projectIdentifiers = (project: NonNullable<IssueRecord["project"]>): string[] =>
  [project.id, project.name, project.key, project.slug].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );

const projectMatchesRoute = (
  project: NonNullable<IssueRecord["project"]>,
  route: WatchProductRoute,
): boolean => {
  const configured = normalizedProjectIdentifier(route.linearProject);
  return projectIdentifiers(project).some(
    (identifier) => normalizedProjectIdentifier(identifier) === configured,
  );
};

const describeProject = (project: NonNullable<IssueRecord["project"]>): string =>
  project.name || project.id;

export const routeReadyIssuesForProducts = (
  issues: readonly IssueRecord[],
  productRoutes: readonly WatchProductRoute[] = [],
): { readyIssues: RoutedReadyIssue[]; skippedIssues: WatchSkippedIssue[] } => {
  if (productRoutes.length === 0) {
    return {
      readyIssues: issues.map((issue) => ({
        issue,
        route: { productId: "", linearProject: "", githubRepo: "" },
      })),
      skippedIssues: [],
    };
  }

  const readyIssues: RoutedReadyIssue[] = [];
  const skippedIssues: WatchSkippedIssue[] = [];
  const configuredProjects = productRoutes.map((route) => route.linearProject);
  for (const issue of issues) {
    if (issue.project === undefined) {
      skippedIssues.push({ issueKey: issue.key, reason: "no_project", configuredProjects });
      continue;
    }
    const matchingRoutes = productRoutes.filter((candidate) =>
      projectMatchesRoute(issue.project!, candidate),
    );
    if (matchingRoutes.length === 0) {
      skippedIssues.push({
        issueKey: issue.key,
        reason: "project_mismatch",
        configuredProjects,
        actualProject: describeProject(issue.project),
      });
      continue;
    }
    if (matchingRoutes.length > 1) {
      skippedIssues.push({
        issueKey: issue.key,
        reason: "project_ambiguous",
        configuredProjects,
        actualProject: describeProject(issue.project),
      });
      continue;
    }
    const route = matchingRoutes[0]!;
    readyIssues.push({ issue, route });
  }
  return { readyIssues, skippedIssues };
};

const skipAction = (skippedIssue: WatchSkippedIssue): string =>
  `skip:${skippedIssue.issueKey}:${skippedIssue.reason}`;

export const watchOnce = async (input: WatchOnceInput): Promise<WatchOnceResult> => {
  const readyIssues = await input.source.listReadyIssues();
  const routed = routeReadyIssuesForProducts(readyIssues, input.productRoutes);
  const skippedActions = routed.skippedIssues.map(skipAction);
  const selected = routed.readyIssues[0];
  const issue = selected?.issue;
  if (!issue) {
    return {
      readyCount: routed.readyIssues.length,
      actions: [...skippedActions, "no_ready_issues"],
      ...(routed.skippedIssues.length === 0 ? {} : { skippedIssues: routed.skippedIssues }),
    };
  }

  const claimStatus = input.claimStatus ?? defaultClaimStatus;
  const claimComment = input.claimComment ?? defaultClaimComment;
  const hasClaimComment = issue.comments.includes(claimComment);
  await input.tracker.updateIssueStatus(issue.key, claimStatus);
  if (!hasClaimComment) {
    await input.tracker.appendIssueComment(issue.key, claimComment);
  }

  return {
    readyCount: routed.readyIssues.length,
    claimedIssue: issue,
    ...(input.productRoutes === undefined || input.productRoutes.length === 0
      ? {}
      : { selectedRoute: selected.route }),
    ...(routed.skippedIssues.length === 0 ? {} : { skippedIssues: routed.skippedIssues }),
    actions: hasClaimComment
      ? [...skippedActions, `status:${issue.key}:${claimStatus}`]
      : [...skippedActions, `status:${issue.key}:${claimStatus}`, `comment:${issue.key}`],
  };
};

export const watchLoop = async (input: WatchLoopInput): Promise<void> => {
  const claimedKeys = new Set<string>();
  const sleep = input.sleep ?? defaultSleep;
  let polls = 0;

  while (input.signal?.aborted !== true) {
    polls += 1;
    input.onEvent?.({ type: "poll_started", poll: polls });

    if (input.resume !== undefined) {
      const resumable = await input.resume.listResumable().catch(() => [] as string[]);
      for (const issueId of resumable) {
        try {
          const { outcome } = await input.resume.resumeRun(issueId);
          input.onEvent?.({ type: "run_resumed", poll: polls, issueId, outcome });
        } catch (error) {
          input.onEvent?.({
            type: "run_resume_failed",
            poll: polls,
            issueId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (input.reconcile !== undefined) {
      const reconcilable = await input.reconcile.listIssues().catch(() => [] as IssueRecord[]);
      for (const issue of reconcilable) {
        try {
          const outcome = await input.reconcile.reconcileIssue(issue);
          if (outcome.kind === "updated") {
            input.onEvent?.({
              type: "issue_status_reconciled",
              poll: polls,
              issueKey: issue.key,
              from: outcome.from,
              to: outcome.to,
            });
          }
          const feedback = await input.reconcile.ingestExternalFeedback?.(issue);
          if (feedback?.kind === "ingested") {
            input.onEvent?.({
              type: "external_feedback_ingested",
              poll: polls,
              issueKey: issue.key,
              source: feedback.source,
              outcome: feedback.state,
            });
            if (input.resume !== undefined) {
              const { outcome: resumeOutcome } = await input.resume.resumeRun(issue.key);
              input.onEvent?.({
                type: "run_resumed",
                poll: polls,
                issueId: issue.key,
                outcome: resumeOutcome,
              });
            }
          }
        } catch {
          // Reconciliation is best-effort; a single failure must not stop the loop.
        }
      }
    }

    const result = await watchOnce({
      source: {
        listReadyIssues: async () =>
          (await input.source.listReadyIssues()).filter((issue) => !claimedKeys.has(issue.key)),
      },
      tracker: input.tracker,
      ...(input.claimStatus === undefined ? {} : { claimStatus: input.claimStatus }),
      ...(input.claimComment === undefined ? {} : { claimComment: input.claimComment }),
      ...(input.productRoutes === undefined ? {} : { productRoutes: input.productRoutes }),
    });

    for (const skippedIssue of result.skippedIssues ?? []) {
      input.onEvent?.({
        type: "issue_skipped",
        poll: polls,
        issueKey: skippedIssue.issueKey,
        reason: skippedIssue.reason,
      });
    }

    if (result.claimedIssue === undefined) {
      input.onEvent?.({ type: "poll_idle", poll: polls, readyCount: result.readyCount });
    } else {
      claimedKeys.add(result.claimedIssue.key);
      input.onEvent?.({
        type: "issue_claimed",
        poll: polls,
        issueKey: result.claimedIssue.key,
        readyCount: result.readyCount,
        ...(result.selectedRoute === undefined ? {} : { selectedRoute: result.selectedRoute }),
      });
      try {
        await input.onClaimedIssue?.(result.claimedIssue, result.selectedRoute);
      } catch (error) {
        await input.tracker.updateIssueStatus(result.claimedIssue.key, result.claimedIssue.status);
        input.onEvent?.({
          type: "claimed_issue_run_failed",
          poll: polls,
          issueKey: result.claimedIssue.key,
          restoredStatus: result.claimedIssue.status,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (input.maxPolls !== undefined && polls >= input.maxPolls) {
      input.onEvent?.({ type: "watch_stopped", polls, reason: "max_polls" });
      return;
    }
    await sleep(input.pollIntervalMs, input.signal);
  }

  input.onEvent?.({ type: "watch_stopped", polls, reason: "aborted" });
};

export { defaultClaimComment, defaultClaimStatus };

export {
  ingestExternalReviewFeedback,
  reconcileIssueStatus,
  reconcileProducts,
  runStatePathForProduct,
} from "./reconcile.js";

export type {
  FindPullRequestForBranch,
  IngestExternalReviewFeedbackInput,
  IngestExternalReviewFeedbackOutcome,
  ReconcileIssueStatusInput,
  ReconcileOutcome,
  ReconcileProductOutcome,
  ReconcileProductsInput,
  ReconcileProductsResult,
  ReconcileStatusLabels,
} from "./reconcile.js";
