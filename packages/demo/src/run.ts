import {
  createGitHubCliCodeHostAdapter,
  createFakeCodeHostAdapter,
  createFakeIssueTrackerAdapter,
  createLinearGraphqlIssueTrackerAdapter,
  issueToArtifact,
  pullRequestToArtifact,
  type CodeHostAdapter,
  type GitHubCliExec,
  type IssueRecord,
  type IssueTrackerAdapter,
  type LinearFetchGraphql,
  type PullRequestRecord,
  type PullRequestReviewInput,
} from "@aigile/adapters";
import {
  DEFAULT_ISSUE_STATUS_LABELS,
  type IssueStatusLabels,
  type ProductChangedFileGuard,
  type ProductVerificationCommand,
} from "@aigile/config";
import {
  createAcpRoleRunner,
  createRoleRuntimeRegistry,
  createScriptedRoleRunner,
  runAssignedRole,
  type AcpRuntimeConnector,
  type RoleRunner,
  type RoleRuntimeRegistry,
} from "@aigile/roles";
import {
  isArchitectPlanPayload,
  isCheckerVerdictPayload,
  isDeveloperAttemptPayload,
  type WorkflowArtifact,
  type WorkflowEvent,
  type WorkflowState,
} from "@aigile/types";
import { createLocalVerifier } from "@aigile/verifier";
import {
  createGitPublisher,
  createGitWorkspaceAdapter,
  type ExecCommand,
  type GitPublisher,
} from "@aigile/workspace";
import {
  createFileRunStore,
  initialWorkflowSnapshot,
  runWorkflowEngine,
  transitionWorkflow,
  type WorkflowSnapshot,
} from "@aigile/workflow";
import { join } from "node:path";
import { createEngineCommandHandlers, type EngineHandlerDeps } from "./engine-handlers.js";

export interface DemoIssueInput {
  issue: IssueRecord;
  now?: () => number;
}

export interface DemoWithRolesInput extends DemoIssueInput {
  registry: RoleRuntimeRegistry;
  runner: RoleRunner;
  issueTracker?: IssueTrackerAdapter;
  issueStatusLabels?: Partial<IssueStatusLabels>;
  codeHost?: CodeHostAdapter;
  pullRequestTarget?: PullRequestTarget;
  createPullRequest?: boolean;
  initialArtifacts?: WorkflowArtifact[];
  verificationArtifact?: WorkflowArtifact;
  publishPlan?: (plan: WorkflowArtifact) => Promise<void>;
  verify?: (artifacts: readonly WorkflowArtifact[]) => Promise<WorkflowArtifact>;
  beforeVerification?: (artifacts: readonly WorkflowArtifact[]) => Promise<WorkflowArtifact[]>;
  beforePullRequest?: (artifacts: readonly WorkflowArtifact[]) => Promise<void>;
}

export interface DemoWithAcpRolesInput extends DemoIssueInput {
  connector?: AcpRuntimeConnector;
}

export interface DemoWorkspaceInput extends DemoIssueInput {
  repoPath: string;
  worktreesPath: string;
  baseBranch?: string;
  exec?: ExecCommand;
  registry?: RoleRuntimeRegistry;
  runner?: RoleRunner;
  dryRun?: boolean;
  publish?: boolean;
  publisher?: GitPublisher;
  remote?: string;
  codeHost?: CodeHostAdapter;
  issueStatusLabels?: Partial<IssueStatusLabels>;
  pullRequestTarget?: PullRequestTarget;
  createPullRequest?: boolean;
  publishPlan?: (plan: WorkflowArtifact) => Promise<void>;
  verificationCommands?: ProductVerificationCommand[];
  autofixCommands?: ProductVerificationCommand[];
  changedFileGuards?: ProductChangedFileGuard[];
  runStatePath?: string;
  retryEscalated?: boolean;
}

export interface DemoGitHubInput extends DemoIssueInput {
  ghExec: GitHubCliExec;
  cwd?: string;
}

export interface DemoLinearInput {
  issueKey: string;
  linearApiKey: string;
  fetchGraphql?: LinearFetchGraphql;
}

export interface PullRequestTarget {
  owner: string;
  repo: string;
  baseBranch?: string;
}

export interface DemoResult {
  issueKey: string;
  finalState: WorkflowState;
  pullRequest?: PullRequestRecord;
  publicationFailure?: {
    operation: string;
    message: string;
    pullRequestUrl?: string;
  };
  artifacts: WorkflowArtifact[];
  timeline: DemoTimelineEntry[];
  durationMs: number;
}

export interface DemoTimelineEntry {
  label: string;
  elapsedMs: number;
}

const pushTransition = (
  snapshot: WorkflowSnapshot,
  event: WorkflowEvent,
  timeline: DemoTimelineEntry[],
  elapsedSinceLast: () => number,
): WorkflowSnapshot => {
  const result = transitionWorkflow(snapshot, event);
  timeline.push({
    label: `${event.type} -> ${result.snapshot.state}`,
    elapsedMs: elapsedSinceLast(),
  });
  return result.snapshot;
};

const artifactByKind = (artifacts: WorkflowArtifact[], kind: string): WorkflowArtifact => {
  const artifact = artifacts.find((candidate) => candidate.kind === kind);
  if (!artifact) throw new Error(`Missing artifact: ${kind}`);
  return artifact;
};

const workspaceToArtifact = (payload: unknown, issueKey: string): WorkflowArtifact => ({
  id: `workspace:${issueKey}:worktree`,
  kind: "workspace.issue_worktree",
  source: "system",
  payload,
});

const workspaceRolePayload = (
  workspace: { worktreePath: string },
  input: Pick<DemoWorkspaceInput, "repoPath" | "dryRun">,
): unknown => {
  if (input.dryRun !== true) return workspace;
  return {
    ...workspace,
    worktreePath: input.repoPath,
    simulatedWorktreePath: workspace.worktreePath,
    mode: "dry_run",
  };
};

const diffToArtifact = (summary: string, issueKey: string): WorkflowArtifact => ({
  id: `workspace:${issueKey}:diff`,
  kind: "workspace.diff",
  source: "system",
  payload: { summary },
});

const executionPolicyToArtifact = (issueKey: string, dryRun: boolean): WorkflowArtifact => ({
  id: `policy:${issueKey}:${dryRun ? "dry-run" : "agent-write"}`,
  kind: "execution.policy",
  source: "system",
  payload: dryRun
    ? {
        mode: "dry_run",
        fileWrites: "forbidden",
        commits: "forbidden",
        shellCommands: "read_only",
        instructions: [
          "Do not edit files.",
          "Do not create commits.",
          "Do not push branches or open pull requests.",
          "Return the required role artifact describing the intended work or review.",
        ],
      }
    : {
        mode: "agent_write",
        fileWrites: "allowed",
        commits: "forbidden",
        pushes: "forbidden",
        shellCommands: "workspace",
        instructions: [
          "You may edit files in the issue worktree to implement the approved plan.",
          "Do not create commits.",
          "Do not push branches or open pull requests.",
          "Aigile will commit, push, and open the pull request after verification and checker approval.",
        ],
      },
});

const checkerEventForVerdict = (artifact: WorkflowArtifact): WorkflowEvent["type"] => {
  if (!isCheckerVerdictPayload(artifact.payload)) {
    throw new Error(`Checker artifact payload is invalid: ${artifact.id}`);
  }
  if (artifact.payload.verdict === "pass") return "checker_passed";
  if (artifact.payload.verdict === "changes_requested") return "checker_requested_changes";
  return "checker_escalated";
};

const verificationEventForResult = (artifact: WorkflowArtifact): WorkflowEvent["type"] => {
  if (
    typeof artifact.payload !== "object" ||
    artifact.payload === null ||
    Array.isArray(artifact.payload)
  ) {
    return "verification_failed";
  }
  const status = (artifact.payload as { status?: unknown }).status;
  return status === "passed" ? "verification_passed" : "verification_failed";
};

const developerAttemptHasChanges = (artifact: WorkflowArtifact): boolean => {
  if (!isDeveloperAttemptPayload(artifact.payload)) {
    throw new Error(`Developer artifact payload is invalid: ${artifact.id}`);
  }
  return artifact.payload.changedFiles.length > 0;
};

const markdownList = (items: readonly string[]): string[] =>
  items.length === 0 ? ["- None"] : items.map((item) => `- ${item}`);

const verificationSummary = (artifact: WorkflowArtifact): string => {
  const payload = artifact.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return artifact.id;
  const status = (payload as { status?: unknown }).status;
  const summary = (payload as { summary?: unknown }).summary;
  if (typeof summary === "string" && summary.trim().length > 0) {
    return typeof status === "string" ? `${status}: ${summary}` : summary;
  }
  return typeof status === "string" ? status : artifact.id;
};

const formatPullRequestBody = (
  issue: IssueRecord,
  plan: WorkflowArtifact,
  attempt: WorkflowArtifact,
  verification: WorkflowArtifact,
  verdict: WorkflowArtifact,
): string => {
  if (!isArchitectPlanPayload(plan.payload))
    throw new Error(`Architect plan payload is invalid: ${plan.id}`);
  if (!isDeveloperAttemptPayload(attempt.payload))
    throw new Error(`Developer artifact payload is invalid: ${attempt.id}`);
  if (!isCheckerVerdictPayload(verdict.payload))
    throw new Error(`Checker artifact payload is invalid: ${verdict.id}`);

  return [
    `## ${issue.key}: ${issue.title}`,
    "",
    "### Summary",
    plan.payload.summary,
    "",
    "### Acceptance Criteria",
    ...markdownList(
      issue.acceptanceCriteria.length > 0
        ? issue.acceptanceCriteria
        : plan.payload.acceptanceCriteria,
    ),
    "",
    "### Implementation",
    attempt.payload.summary,
    "",
    "### Changed Files",
    ...markdownList(attempt.payload.changedFiles),
    "",
    "### Verification",
    verificationSummary(verification),
    "",
    "### Checker",
    `${verdict.payload.verdict}: ${verdict.payload.summary}`,
    "",
    "### Artifacts",
    `- Plan: ${plan.id}`,
    `- Developer: ${attempt.id}`,
    `- Verification: ${verification.id}`,
    `- Checker: ${verdict.id}`,
  ].join("\n");
};

const formatDeveloperAttemptComment = (attempt: WorkflowArtifact): string => {
  if (!isDeveloperAttemptPayload(attempt.payload)) {
    throw new Error(`Developer artifact payload is invalid: ${attempt.id}`);
  }
  return [
    "## Aigile developer update",
    "",
    attempt.payload.summary,
    "",
    "### Changed Files",
    ...markdownList(attempt.payload.changedFiles),
    "",
    "### Verification Notes",
    attempt.payload.verificationNotes,
  ].join("\n");
};

const formatFinalPullRequestSummary = (
  verification: WorkflowArtifact,
  verdict: WorkflowArtifact,
): string => {
  if (!isCheckerVerdictPayload(verdict.payload))
    throw new Error(`Checker artifact payload is invalid: ${verdict.id}`);
  return [
    "## Aigile final summary",
    "",
    `Verification: ${verificationSummary(verification)}`,
    `Checker verdict: ${verdict.payload.verdict}`,
    "",
    verdict.payload.summary,
    "",
    "### Checker Reasons",
    ...markdownList(verdict.payload.reasons),
  ].join("\n");
};

const checkerReviewForVerdict = (artifact: WorkflowArtifact): PullRequestReviewInput => {
  if (!isCheckerVerdictPayload(artifact.payload)) {
    throw new Error(`Checker artifact payload is invalid: ${artifact.id}`);
  }
  const body = [
    "## Aigile checker review",
    "",
    artifact.payload.summary,
    "",
    "### Reasons",
    ...markdownList(artifact.payload.reasons),
  ].join("\n");
  if (artifact.payload.verdict === "pass") return { event: "approve", body };
  if (artifact.payload.verdict === "changes_requested") return { event: "request_changes", body };
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

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const issueStatusLabelForState = (state: WorkflowState, labels: IssueStatusLabels): string => {
  if (state === "planning") return labels.planning;
  if (state === "developing") return labels.developing;
  if (state === "merge_ready") return labels.inReview;
  if (state === "merged") return labels.done;
  if (state === "escalated") return labels.blocked;
  return state;
};

const formatPullRequestBlockedComment = (
  pullRequest: PullRequestRecord,
  mergeabilityStatus: string,
): string =>
  [
    "Aigile could not mark this issue done because the published pull request is not confirmed merged.",
    "",
    `Pull request: ${pullRequest.url}`,
    `Mergeability: ${mergeabilityStatus}`,
    "",
    "Human attention is required before the issue can move to the done status.",
  ].join("\n");

const createDemoRegistry = (): RoleRuntimeRegistry =>
  createRoleRuntimeRegistry({
    runtimes: [
      { id: "demo-architect", transport: "stdio", command: ["aigile-demo-acp"] },
      { id: "demo-developer", transport: "stdio", command: ["aigile-demo-acp"] },
      { id: "demo-checker", transport: "stdio", command: ["aigile-demo-acp"] },
    ],
    assignments: [
      { roleId: "architect", runtimeProfileId: "demo-architect" },
      { roleId: "developer", runtimeProfileId: "demo-developer" },
      { roleId: "checker", runtimeProfileId: "demo-checker" },
    ],
  });

export const runDemoIssueWithRoles = async (input: DemoWithRolesInput): Promise<DemoResult> => {
  const issueTracker = input.issueTracker ?? createFakeIssueTrackerAdapter([input.issue]);
  const issueStatusLabels: IssueStatusLabels = {
    ...DEFAULT_ISSUE_STATUS_LABELS,
    ...(input.issueStatusLabels ?? {}),
  };
  const codeHost = input.codeHost ?? createFakeCodeHostAdapter();
  const issue = await issueTracker.getIssue(input.issue.key);
  const artifacts: WorkflowArtifact[] = [issueToArtifact(issue), ...(input.initialArtifacts ?? [])];
  const now = input.now ?? Date.now;
  const startedAt = now();
  let lastTimelineAt = startedAt;
  const elapsedSinceLast = (): number => {
    const current = now();
    const elapsedMs = Math.max(0, current - lastTimelineAt);
    lastTimelineAt = current;
    return elapsedMs;
  };
  const timeline: DemoTimelineEntry[] = [];
  let snapshot = initialWorkflowSnapshot(issue.key);

  snapshot = pushTransition(
    snapshot,
    {
      type: "issue_received",
      issueId: issue.key,
      artifactId: artifacts[0]!.id,
    },
    timeline,
    elapsedSinceLast,
  );

  await issueTracker.updateIssueStatus(
    issue.key,
    issueStatusLabelForState("planning", issueStatusLabels),
  );
  const plan = await runAssignedRole({
    roleId: "architect",
    issueId: issue.key,
    inputArtifacts: artifacts,
    registry: input.registry,
    runner: input.runner,
  });
  artifacts.push(plan);
  snapshot = pushTransition(
    snapshot,
    {
      type: "plan_drafted",
      issueId: issue.key,
      artifactId: plan.id,
    },
    timeline,
    elapsedSinceLast,
  );

  snapshot = pushTransition(
    snapshot,
    {
      type: "plan_approved",
      issueId: issue.key,
    },
    timeline,
    elapsedSinceLast,
  );

  await input.publishPlan?.(plan);
  await issueTracker.updateIssueStatus(
    issue.key,
    issueStatusLabelForState("developing", issueStatusLabels),
  );
  const attempt = await runAssignedRole({
    roleId: "developer",
    issueId: issue.key,
    inputArtifacts: artifacts,
    registry: input.registry,
    runner: input.runner,
  });
  artifacts.push(attempt);
  snapshot = pushTransition(
    snapshot,
    {
      type: "developer_finished",
      issueId: issue.key,
      artifactId: attempt.id,
    },
    timeline,
    elapsedSinceLast,
  );

  if (input.beforeVerification) {
    artifacts.push(...(await input.beforeVerification(artifacts)));
  }

  const verification: WorkflowArtifact =
    input.verificationArtifact ??
    (input.verify
      ? await input.verify(artifacts)
      : {
          id: `verifier:${issue.key}:local-check`,
          kind: "verification.result",
          source: "verifier",
          payload: {
            status: "passed",
            command: "bun run check",
            summary: "Local scripted verifier passed.",
          },
        });
  artifacts.push(verification);
  const verificationEvent = verificationEventForResult(verification);
  snapshot = pushTransition(
    snapshot,
    {
      type: verificationEvent,
      issueId: issue.key,
      artifactId: verification.id,
    },
    timeline,
    elapsedSinceLast,
  );
  if (verificationEvent === "verification_failed") {
    await issueTracker.updateIssueStatus(
      issue.key,
      issueStatusLabelForState(snapshot.state, issueStatusLabels),
    );
    return {
      issueKey: issue.key,
      finalState: snapshot.state,
      artifacts,
      timeline,
      durationMs: timeline.reduce((total, entry) => total + entry.elapsedMs, 0),
    };
  }

  const verdict = await runAssignedRole({
    roleId: "checker",
    issueId: issue.key,
    inputArtifacts: artifacts,
    registry: input.registry,
    runner: input.runner,
  });
  artifacts.push(verdict);
  const checkerEvent = checkerEventForVerdict(verdict);
  const developerChangedFiles = developerAttemptHasChanges(attempt);
  const checkerWorkflowEvent: WorkflowEvent = {
    type:
      checkerEvent === "checker_passed" && !developerChangedFiles ? "work_satisfied" : checkerEvent,
    issueId: issue.key,
    artifactId: verdict.id,
  };
  if (isCheckerVerdictPayload(verdict.payload))
    checkerWorkflowEvent.reason = verdict.payload.summary;
  snapshot = pushTransition(snapshot, checkerWorkflowEvent, timeline, elapsedSinceLast);
  if (checkerWorkflowEvent.type === "work_satisfied") {
    await issueTracker.updateIssueStatus(
      issue.key,
      issueStatusLabelForState(snapshot.state, issueStatusLabels),
    );
    return {
      issueKey: issue.key,
      finalState: snapshot.state,
      artifacts,
      timeline,
      durationMs: timeline.reduce((total, entry) => total + entry.elapsedMs, 0),
    };
  }

  artifactByKind(artifacts, "developer.attempt");
  if (input.createPullRequest === false) {
    await issueTracker.updateIssueStatus(
      issue.key,
      issueStatusLabelForState(snapshot.state, issueStatusLabels),
    );
    return {
      issueKey: issue.key,
      finalState: snapshot.state,
      artifacts,
      timeline,
      durationMs: timeline.reduce((total, entry) => total + entry.elapsedMs, 0),
    };
  }
  await input.beforePullRequest?.(artifacts);
  const pullRequestTarget = input.pullRequestTarget ?? {
    owner: "aigile",
    repo: "aigile",
    baseBranch: "main",
  };
  const pullRequest = await codeHost.createPullRequest({
    owner: pullRequestTarget.owner,
    repo: pullRequestTarget.repo,
    branch: `aigile/${issue.key}`,
    baseBranch: pullRequestTarget.baseBranch ?? "main",
    title: `${issue.key} ${issue.title}`,
    body: formatPullRequestBody(issue, plan, attempt, verification, verdict),
  });
  let pullRequestArtifact = pullRequestToArtifact(await codeHost.getPullRequest(pullRequest.id));
  try {
    await codeHost.appendPullRequestComment(pullRequest.id, formatDeveloperAttemptComment(attempt));
    await codeHost.recordCheckResult(pullRequest.id, {
      name: "aigile/verifier",
      status: "passed",
      summary: "Local scripted verifier passed.",
    });
    await publishCheckerFeedback(codeHost, pullRequest.id, checkerReviewForVerdict(verdict));
    await codeHost.appendPullRequestComment(
      pullRequest.id,
      formatFinalPullRequestSummary(verification, verdict),
    );
    pullRequestArtifact = pullRequestToArtifact(await codeHost.getPullRequest(pullRequest.id));
  } catch (error) {
    artifacts.push(pullRequestArtifact);
    const message = errorMessage(error);
    snapshot = pushTransition(
      snapshot,
      {
        type: "publish_failed",
        issueId: issue.key,
        artifactId: pullRequestArtifact.id,
        reason: message,
      },
      timeline,
      elapsedSinceLast,
    );
    await issueTracker.updateIssueStatus(
      issue.key,
      issueStatusLabelForState(snapshot.state, issueStatusLabels),
    );
    return {
      issueKey: issue.key,
      finalState: snapshot.state,
      pullRequest: pullRequestArtifact.payload,
      publicationFailure: {
        operation: "publish_pull_request_evidence",
        message,
        pullRequestUrl: pullRequestArtifact.payload.url,
      },
      artifacts,
      timeline,
      durationMs: timeline.reduce((total, entry) => total + entry.elapsedMs, 0),
    };
  }
  artifacts.push(pullRequestArtifact);
  if (checkerEvent !== "checker_passed") {
    await issueTracker.updateIssueStatus(
      issue.key,
      issueStatusLabelForState(snapshot.state, issueStatusLabels),
    );
    return {
      issueKey: issue.key,
      finalState: snapshot.state,
      pullRequest: pullRequestArtifact.payload,
      artifacts,
      timeline,
      durationMs: timeline.reduce((total, entry) => total + entry.elapsedMs, 0),
    };
  }
  await issueTracker.updateIssueStatus(
    issue.key,
    issueStatusLabelForState(snapshot.state, issueStatusLabels),
  );
  const mergeState = await codeHost.getPullRequestMergeState(pullRequest.id);
  const mergeability = await codeHost.getPullRequestMergeability(pullRequest.id);
  if (mergeState.status !== "merged") {
    if (mergeability.status === "conflicting" || mergeability.status === "unknown") {
      await issueTracker.appendIssueComment(
        issue.key,
        formatPullRequestBlockedComment(pullRequestArtifact.payload, mergeability.status),
      );
    }
    return {
      issueKey: issue.key,
      finalState: snapshot.state,
      pullRequest: pullRequestArtifact.payload,
      artifacts,
      timeline,
      durationMs: timeline.reduce((total, entry) => total + entry.elapsedMs, 0),
    };
  }
  snapshot = pushTransition(
    snapshot,
    {
      type: "merge_completed",
      issueId: issue.key,
      artifactId: pullRequestArtifact.id,
    },
    timeline,
    elapsedSinceLast,
  );
  await issueTracker.updateIssueStatus(
    issue.key,
    issueStatusLabelForState(snapshot.state, issueStatusLabels),
  );

  return {
    issueKey: issue.key,
    finalState: snapshot.state,
    pullRequest: pullRequestArtifact.payload,
    artifacts,
    timeline,
    durationMs: timeline.reduce((total, entry) => total + entry.elapsedMs, 0),
  };
};

export const createMockAcpConnector = (): AcpRuntimeConnector => async (input) => ({
  session: {
    sessionId: `${input.issueId}:${input.roleId}`,
    acpSessionId: `mock-acp:${input.issueId}:${input.roleId}`,
    prompt: async () => {
      if (input.roleId === "architect") {
        return {
          artifactKind: "architect.plan",
          payload: {
            summary: "Mock ACP architect plan",
            scope: ["local demo"],
            acceptanceCriteria: ["ACP runner is used"],
            verificationCommands: ["bun run check"],
            risks: [],
          },
        };
      }
      if (input.roleId === "developer") {
        return {
          artifactKind: "developer.attempt",
          payload: {
            summary: "Mock ACP developer attempt",
            changedFiles: ["packages/demo/src/run.ts"],
            verificationNotes: "Local scripted verifier will run.",
          },
        };
      }
      if (input.roleId === "checker") {
        return {
          artifactKind: "checker.verdict",
          payload: {
            verdict: "pass",
            summary: "Mock ACP checker passed the change.",
            reasons: [],
          },
        };
      }
      throw new Error(`No mock ACP response for role: ${input.roleId}`);
    },
    cancel: () => undefined,
    onEvent: () => () => undefined,
  },
  process: {
    kill: async () => undefined,
  },
});

export const runDemoIssue = async (input: DemoIssueInput): Promise<DemoResult> => {
  const registry = createDemoRegistry();
  const runner = createScriptedRoleRunner({
    architect: {
      artifactKind: "architect.plan",
      payload: {
        summary: `Plan for ${input.issue.key}: ${input.issue.title}`,
        scope: ["local demo"],
        acceptanceCriteria: input.issue.acceptanceCriteria,
        verificationCommands: ["bun run check"],
        risks: [],
      },
    },
    developer: {
      artifactKind: "developer.attempt",
      payload: {
        summary: "Scripted implementation completed for local demo.",
        changedFiles: ["packages/demo/src/run.ts"],
        verificationNotes: "Local scripted verifier will run.",
      },
    },
    checker: {
      artifactKind: "checker.verdict",
      payload: {
        verdict: "pass",
        summary: "Scripted checker accepts the verified demo change.",
        reasons: [],
      },
    },
  });
  return runDemoIssueWithRoles({ ...input, registry, runner });
};

export const runDemoIssueWithAcpRoles = async (
  input: DemoWithAcpRolesInput,
): Promise<DemoResult> => {
  const roleInput: DemoWithRolesInput = {
    issue: input.issue,
    registry: createDemoRegistry(),
    runner: createAcpRoleRunner({ connector: input.connector ?? createMockAcpConnector() }),
  };
  if (input.now !== undefined) roleInput.now = input.now;
  return runDemoIssueWithRoles(roleInput);
};

export const runDemoIssueWithWorkspace = async (input: DemoWorkspaceInput): Promise<DemoResult> => {
  const workspaceOptions = {
    repoPath: input.repoPath,
    worktreesPath: input.worktreesPath,
    remote: input.remote ?? "origin",
  };
  const workspaceAdapter = createGitWorkspaceAdapter(
    input.exec === undefined ? workspaceOptions : { ...workspaceOptions, exec: input.exec },
  );
  const workspace = await workspaceAdapter.createIssueWorkspace({
    issueKey: input.issue.key,
    baseBranch: input.baseBranch ?? "main",
  });
  const verifier = createLocalVerifier(input.exec === undefined ? {} : { exec: input.exec });

  const roleInput: DemoWithRolesInput = {
    issue: input.issue,
    registry: input.registry ?? createDemoRegistry(),
    runner:
      input.runner ??
      createScriptedRoleRunner({
        architect: {
          artifactKind: "architect.plan",
          payload: {
            summary: `Plan for ${input.issue.key}: ${input.issue.title}`,
            scope: ["local workspace"],
            acceptanceCriteria: input.issue.acceptanceCriteria,
            verificationCommands: ["bun run check"],
            risks: [],
          },
        },
        developer: {
          artifactKind: "developer.attempt",
          payload: {
            summary: "Workspace implementation completed for local demo.",
            changedFiles: ["packages/demo/src/run.ts"],
            verificationNotes: "Verifier runs in the issue worktree.",
          },
        },
        checker: {
          artifactKind: "checker.verdict",
          payload: {
            verdict: "pass",
            summary: "Checker accepts workspace demo artifacts.",
            reasons: [],
          },
        },
      }),
    initialArtifacts: [
      workspaceToArtifact(workspaceRolePayload(workspace, input), input.issue.key),
      executionPolicyToArtifact(input.issue.key, input.dryRun === true),
    ],
    beforeVerification: async () => [
      diffToArtifact(await workspaceAdapter.diffSummary(workspace), input.issue.key),
    ],
    verify: async () =>
      verifier.verify({
        issueKey: input.issue.key,
        workspacePath: workspace.worktreePath,
        commands: input.verificationCommands ?? [["bun", "run", "check"]],
        ...(input.changedFileGuards === undefined
          ? {}
          : { changedFileGuards: input.changedFileGuards }),
      }),
  };
  if (input.now !== undefined) roleInput.now = input.now;
  if (input.codeHost !== undefined) roleInput.codeHost = input.codeHost;
  if (input.issueStatusLabels !== undefined) roleInput.issueStatusLabels = input.issueStatusLabels;
  if (input.pullRequestTarget !== undefined) roleInput.pullRequestTarget = input.pullRequestTarget;
  if (input.createPullRequest !== undefined) roleInput.createPullRequest = input.createPullRequest;
  if (input.publishPlan !== undefined) roleInput.publishPlan = input.publishPlan;
  if (input.publish) {
    roleInput.beforePullRequest = async () => {
      const publisher =
        input.publisher ?? createGitPublisher(input.exec === undefined ? {} : { exec: input.exec });
      await publisher.publish({
        worktreePath: workspace.worktreePath,
        branchName: workspace.branchName,
        remote: input.remote ?? "origin",
        commitMessage: `${input.issue.key} ${input.issue.title}`,
      });
    };
  }
  return runDemoIssueWithRoles(roleInput);
};

const DEFAULT_AUTOFIX_COMMANDS: ProductVerificationCommand[] = [["bun", "run", "format"]];

/**
 * Durable, engine-backed equivalent of runDemoIssueWithWorkspace: drives the
 * issue through runWorkflowEngine (event-sourced, retryable, resumable) using
 * the real workspace/role/verifier/publisher/code-host adapters. Verification
 * applies autofix commands (e.g. `bun run format`) before the checks so a
 * merely-unformatted change does not fail the gate.
 */
export const runWorkspaceIssueWithEngine = async (
  input: DemoWorkspaceInput,
): Promise<DemoResult> => {
  const workspaceOptions = {
    repoPath: input.repoPath,
    worktreesPath: input.worktreesPath,
    remote: input.remote ?? "origin",
  };
  const workspaceAdapter = createGitWorkspaceAdapter(
    input.exec === undefined ? workspaceOptions : { ...workspaceOptions, exec: input.exec },
  );
  const workspace = await workspaceAdapter.createIssueWorkspace({
    issueKey: input.issue.key,
    baseBranch: input.baseBranch ?? "main",
  });
  const verifier = createLocalVerifier(input.exec === undefined ? {} : { exec: input.exec });
  const registry = input.registry ?? createDemoRegistry();
  const runner = input.runner ?? createScriptedRoleRunner({});
  const codeHost = input.codeHost ?? createFakeCodeHostAdapter();
  const publisher =
    input.publisher ?? createGitPublisher(input.exec === undefined ? {} : { exec: input.exec });
  const remote = input.remote ?? "origin";
  const target = input.pullRequestTarget ?? { owner: "aigile", repo: "aigile" };
  const checks = input.verificationCommands ?? [["bun", "run", "check"]];
  const autofix = input.autofixCommands ?? DEFAULT_AUTOFIX_COMMANDS;

  const deps: EngineHandlerDeps = {
    issue: input.issue,
    branchName: workspace.branchName,
    pullRequestTarget: {
      owner: target.owner,
      repo: target.repo,
      baseBranch: target.baseBranch ?? input.baseBranch ?? "main",
    },
    codeHost,
    runRole: (roleId, inputArtifacts) =>
      runAssignedRole({ roleId, issueId: input.issue.key, inputArtifacts, registry, runner }),
    verify: async () =>
      verifier.verify({
        issueKey: input.issue.key,
        workspacePath: workspace.worktreePath,
        commands: [...autofix, ...checks],
        ...(input.changedFileGuards === undefined
          ? {}
          : { changedFileGuards: input.changedFileGuards }),
      }),
    publish: async () => {
      await publisher.publish({
        worktreePath: workspace.worktreePath,
        branchName: workspace.branchName,
        remote,
        commitMessage: `${input.issue.key} ${input.issue.title}`,
      });
    },
  };

  const store = createFileRunStore({
    directory: input.runStatePath ?? join(input.worktreesPath, "..", "runs"),
  });
  if (input.retryEscalated === true) await store.deleteRun(input.issue.key);
  const result = await runWorkflowEngine({
    issueId: input.issue.key,
    store,
    handlers: createEngineCommandHandlers(deps),
    initialArtifacts: [
      issueToArtifact(input.issue),
      workspaceToArtifact(workspaceRolePayload(workspace, input), input.issue.key),
      executionPolicyToArtifact(input.issue.key, input.dryRun === true),
    ],
  });

  const pullRequestArtifact = result.artifacts.find(
    (artifact) => artifact.kind === "github.pull_request",
  );
  const demoResult: DemoResult = {
    issueKey: input.issue.key,
    finalState: result.snapshot.state,
    artifacts: result.artifacts,
    timeline: [],
    durationMs: 0,
  };
  if (pullRequestArtifact !== undefined) {
    demoResult.pullRequest = pullRequestArtifact.payload as PullRequestRecord;
  }
  return demoResult;
};

export const runDemoIssueWithGitHub = async (input: DemoGitHubInput): Promise<DemoResult> => {
  const roleInput: DemoWithRolesInput = {
    issue: input.issue,
    registry: createDemoRegistry(),
    runner: createScriptedRoleRunner({
      architect: {
        artifactKind: "architect.plan",
        payload: {
          summary: `Plan for ${input.issue.key}: ${input.issue.title}`,
          scope: ["github demo"],
          acceptanceCriteria: input.issue.acceptanceCriteria,
          verificationCommands: ["bun run check"],
          risks: [],
        },
      },
      developer: {
        artifactKind: "developer.attempt",
        payload: {
          summary: "GitHub demo implementation completed.",
          changedFiles: ["packages/demo/src/run.ts"],
          verificationNotes: "Verifier result is represented as PR feedback.",
        },
      },
      checker: {
        artifactKind: "checker.verdict",
        payload: {
          verdict: "pass",
          summary: "Checker accepts GitHub demo artifacts.",
          reasons: [],
        },
      },
    }),
    codeHost: createGitHubCliCodeHostAdapter(
      input.cwd === undefined ? { exec: input.ghExec } : { exec: input.ghExec, cwd: input.cwd },
    ),
  };
  if (input.now !== undefined) roleInput.now = input.now;
  return runDemoIssueWithRoles(roleInput);
};

export const runDemoIssueFromLinear = async (input: DemoLinearInput): Promise<DemoResult> => {
  const issueTracker = createLinearGraphqlIssueTrackerAdapter(
    input.fetchGraphql === undefined
      ? { apiKey: input.linearApiKey }
      : { apiKey: input.linearApiKey, fetchGraphql: input.fetchGraphql },
  );
  return runDemoIssue({
    issue: await issueTracker.getIssue(input.issueKey),
  });
};
