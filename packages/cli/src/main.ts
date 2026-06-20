#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { formatDistanceStrict } from "date-fns";
import {
  createFakeCodeHostAdapter,
  createFakeIssueTrackerAdapter,
  createFakeReadyIssueSource,
  createGitHubCliCodeHostAdapter,
  createLinearGraphqlIssueTrackerAdapter,
  createLinearGraphqlReadyIssueSource,
  listLinearTeams,
  listLinearWorkflowStateNames,
} from "@aigile/adapters";
import { loadRuntimeConfigFromJson, runtimeConfigToRegistry } from "@aigile/config";
import {
  runDemoIssue,
  runDemoIssueFromLinear,
  runDemoIssueWithAcpRoles,
  runDemoIssueWithGitHub,
  runDemoIssueWithRoles,
  runDemoIssueWithWorkspace,
  type DemoWorkspaceInput,
  type DemoResult,
  type PullRequestTarget,
} from "@aigile/demo";
import type {
  CodeHostAdapter,
  IssueRecord,
  IssueTrackerAdapter,
  LinearFetchGraphql,
  PullRequestMergeabilityStatus,
  ReadyIssueSource,
} from "@aigile/adapters";
import { createAcpRoleRunner, type AcpRoleProgressEvent } from "@aigile/roles";
import { isArchitectPlanPayload, type WorkflowArtifact } from "@aigile/types";
import { defaultClaimComment, watchLoop, watchOnce, type WatchLoopEvent } from "@aigile/watch";
import {
  createGitWorkspaceAdapter,
  defaultExecCommand,
  type ExecCommand,
  type ExecResult,
  type IssueWorkspaceStatus,
} from "@aigile/workspace";

const defaultIssue: IssueRecord = {
  id: "issue-demo-1",
  key: "LIN-123",
  title: "Build hand-testable pipeline",
  description: "Exercise the local role-collaboration loop.",
  acceptanceCriteria: [
    "Architect plan exists",
    "Developer attempt exists",
    "Verifier passes",
    "Checker passes",
    "Pull request artifact exists",
  ],
  status: "todo",
  priority: 1,
  comments: [],
};

const executionPolicyMode = (result: DemoResult): string | undefined => {
  const policy = result.artifacts.find((artifact) => artifact.kind === "execution.policy");
  if (
    !policy ||
    typeof policy.payload !== "object" ||
    policy.payload === null ||
    Array.isArray(policy.payload)
  ) {
    return undefined;
  }
  const mode = (policy.payload as { mode?: unknown }).mode;
  return typeof mode === "string" && mode.length > 0 ? mode : undefined;
};

export const formatDuration = (durationMs: number): string => {
  const boundedMs = Math.max(0, Math.round(durationMs));
  return formatDistanceStrict(0, boundedMs, { roundingMethod: "round" });
};

const formattedNumber = (value: number): string => new Intl.NumberFormat("en-US").format(value);

const formatTokenUsage = (result: DemoResult): string => {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let hasUsage = false;
  for (const artifact of result.artifacts) {
    const usage = artifact.provenance?.runtime?.tokenUsage;
    if (!usage) continue;
    hasUsage = true;
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
      totalTokens += usage.inputTokens + usage.outputTokens;
    } else {
      totalTokens += usage.totalTokens ?? 0;
    }
  }
  if (!hasUsage) return "unavailable";
  return `${formattedNumber(totalTokens)} total (${formattedNumber(inputTokens)} input, ${formattedNumber(outputTokens)} output)`;
};

export const formatDemoResult = (result: DemoResult): string => {
  const mode = executionPolicyMode(result);
  const isDryRun = mode === "dry_run";
  return [
    `Aigile demo run: ${result.issueKey}`,
    ...(mode === undefined ? [] : [`Mode: ${isDryRun ? "dry_run (simulated)" : mode}`]),
    `${isDryRun ? "Workflow state" : "Final state"}: ${result.finalState}`,
    ...(isDryRun
      ? ["External side effects: none (workspace, GitHub, and source-of-truth updates simulated)"]
      : []),
    `Pull request: ${result.pullRequest === undefined ? "none" : `${isDryRun ? "simulated " : ""}${result.pullRequest.url}`}`,
    ...(result.publicationFailure === undefined
      ? []
      : [
          `Publication failure: ${result.publicationFailure.operation}`,
          `Publication detail: ${result.publicationFailure.message}`,
        ]),
    `Duration: ${formatDuration(result.durationMs)}`,
    `Token usage: ${formatTokenUsage(result)}`,
    "",
    "Timeline:",
    ...result.timeline.map((entry) => `- ${entry.label} (+${formatDuration(entry.elapsedMs)})`),
    "",
    "Artifacts:",
    ...result.artifacts.map((artifact) => `- ${artifact.kind}: ${artifact.id}`),
  ].join("\n");
};

export const formatAcpRoleProgress = (event: AcpRoleProgressEvent): string => {
  const prefix = `[${event.issueId} ${event.roleId}]`;
  if (event.type === "role_started") return `${prefix} starting ${event.runtimeId}`;
  if (event.type === "runtime_connecting") return `${prefix} connecting ${event.runtimeId}`;
  if (event.type === "runtime_connected") {
    return `${prefix} connected ${event.runtimeId} model ${event.model} session ${event.acpSessionId}`;
  }
  if (event.type === "runtime_stderr") return `${prefix} stderr: ${event.chunk.trimEnd()}`;
  if (event.type === "prompt_started") return `${prefix} prompt sent`;
  if (event.type === "text_delta") return `${prefix} text: ${event.delta.trimEnd()}`;
  if (event.type === "thinking_delta") return `${prefix} thinking`;
  if (event.type === "token_usage") return "";
  if (event.type === "tool_start") return `${prefix} tool started: ${event.tool}`;
  if (event.type === "tool_end") return `${prefix} tool finished: ${event.tool}`;
  if (event.type === "policy_violation") {
    return `${prefix} policy violation ${event.reason}: ${event.detail}`;
  }
  if (event.type === "permission_decision") {
    return `${prefix} permission ${event.decision}: ${event.tool} ${event.description}`;
  }
  if (event.type === "approval_request") return `${prefix} approval requested: ${event.tool}`;
  if (event.type === "artifact_parsed") return `${prefix} artifact parsed: ${event.artifactKind}`;
  return `${prefix} stopped ${event.runtimeId}`;
};

export interface AcpRoleProgressFormatter {
  format: (event: AcpRoleProgressEvent) => string[];
  flush: () => string[];
}

export interface AcpRoleProgressFormatterOptions {
  textFlushThreshold?: number;
}

const progressKey = (
  event: Pick<AcpRoleProgressEvent, "issueId" | "roleId" | "runtimeId">,
): string => `${event.issueId}\0${event.roleId}\0${event.runtimeId}`;

const formatBufferedText = (
  event: Pick<AcpRoleProgressEvent, "issueId" | "roleId">,
  text: string,
): string | undefined => {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return undefined;
  return `[${event.issueId} ${event.roleId}] text: ${trimmed}`;
};

export const createAcpRoleProgressFormatter = (
  options: AcpRoleProgressFormatterOptions = {},
): AcpRoleProgressFormatter => {
  const textFlushThreshold = options.textFlushThreshold ?? 160;
  const buffers = new Map<string, { issueId: string; roleId: string; text: string }>();

  const flushKey = (key: string): string[] => {
    const buffer = buffers.get(key);
    if (!buffer) return [];
    buffers.delete(key);
    const line = formatBufferedText(buffer, buffer.text);
    return line === undefined ? [] : [line];
  };

  return {
    format: (event) => {
      const key = progressKey(event);
      if (event.type !== "text_delta") {
        return [...flushKey(key), formatAcpRoleProgress(event)].filter(
          (line) => line.trim().length > 0,
        );
      }

      const existing = buffers.get(key)?.text ?? "";
      const combined = `${existing}${event.delta}`;
      const newlineIndex = combined.indexOf("\n");
      if (newlineIndex >= 0) {
        const head = combined.slice(0, newlineIndex);
        const tail = combined.slice(newlineIndex + 1);
        if (tail.length > 0) {
          buffers.set(key, { issueId: event.issueId, roleId: event.roleId, text: tail });
        } else {
          buffers.delete(key);
        }
        const line = formatBufferedText(event, head);
        return line === undefined ? [] : [line];
      }
      if (combined.length >= textFlushThreshold) {
        buffers.delete(key);
        const line = formatBufferedText(event, combined);
        return line === undefined ? [] : [line];
      }
      buffers.set(key, { issueId: event.issueId, roleId: event.roleId, text: combined });
      return [];
    },
    flush: () => {
      const lines: string[] = [];
      for (const key of [...buffers.keys()]) {
        lines.push(...flushKey(key));
      }
      return lines;
    },
  };
};

export type DemoMode =
  | "scripted"
  | "agents"
  | "workspace"
  | "github"
  | "linear"
  | "run"
  | "status"
  | "watch";

export const selectDemoMode = (args: readonly string[]): DemoMode =>
  args.includes("demo:agents") || args.includes("--agents")
    ? "agents"
    : args.includes("demo:workspace") || args.includes("--workspace")
      ? "workspace"
      : args.includes("demo:github") || args.includes("--github")
        ? "github"
        : args.includes("demo:linear") || args.includes("--linear")
          ? "linear"
          : "scripted";

export interface CliArgs {
  mode: DemoMode;
  issueKey?: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  runtimeConfigPath?: string;
  repoPath?: string;
  worktreesPath?: string;
  baseBranch?: string;
  publish?: boolean;
  remote?: string;
  githubRepo?: string;
  dryRun?: boolean;
  agentWrite?: boolean;
  preflightOnly?: boolean;
  once?: boolean;
  readyStatus?: string;
  claimStatus?: string;
  linear?: boolean;
  linearTeam?: string;
  linearApiKeyEnv?: string;
  pollIntervalMs?: number;
  maxPolls?: number;
  startRun?: boolean;
}

export interface PublishPreflightInput {
  repoPath: string;
  githubRepo?: string;
  remote: string;
  baseBranch: string;
  exec?: ExecCommand;
}

export interface PublishPreflightResult {
  githubRepo: string;
  remoteUrl: string;
}

const assertPreflightSuccess = (result: ExecResult, operation: string): void => {
  if (result.exitCode !== 0) {
    throw new Error(
      `publish preflight ${operation} failed (${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
};

export const parseGitHubRepoFromRemoteUrl = (remoteUrl: string): string | undefined => {
  const trimmed = remoteUrl.trim();
  const sshMatch = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(trimmed);
  if (sshMatch) return sshMatch[1];
  const httpsMatch = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (httpsMatch) return httpsMatch[1];
  const sshUrlMatch = /^ssh:\/\/git@github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  return sshUrlMatch?.[1];
};

const resolveGitHubRepo = (explicitRepo: string | undefined, remoteUrl: string): string => {
  if (explicitRepo !== undefined) return explicitRepo;
  const inferredRepo = parseGitHubRepoFromRemoteUrl(remoteUrl);
  if (!inferredRepo) {
    throw new Error(
      "--publish requires --github-repo owner/repo when the git remote is not a GitHub URL",
    );
  }
  return inferredRepo;
};

export const runPublishPreflight = async (
  input: PublishPreflightInput,
): Promise<PublishPreflightResult> => {
  const exec = input.exec ?? defaultExecCommand;
  assertPreflightSuccess(
    await exec("gh", ["auth", "status"], { cwd: input.repoPath }),
    "gh auth status",
  );
  const remoteUrlResult = await exec("git", ["remote", "get-url", input.remote], {
    cwd: input.repoPath,
  });
  assertPreflightSuccess(remoteUrlResult, `git remote get-url ${input.remote}`);
  const remoteUrl = remoteUrlResult.stdout.trim();
  const githubRepo = resolveGitHubRepo(input.githubRepo, remoteUrl);
  assertPreflightSuccess(
    await exec("gh", ["repo", "view", githubRepo, "--json", "name"], { cwd: input.repoPath }),
    `gh repo view ${githubRepo}`,
  );
  assertPreflightSuccess(
    await exec("git", ["rev-parse", "--verify", input.baseBranch], { cwd: input.repoPath }),
    `git rev-parse --verify ${input.baseBranch}`,
  );
  return { githubRepo, remoteUrl };
};

export interface RunModePreflightInput {
  issueKey: string;
  repoPath: string;
  worktreesPath: string;
  baseBranch: string;
  publish?: boolean;
  githubRepo?: string;
  remote?: string;
  exec?: ExecCommand;
}

export interface IssueWorkspaceStatusInput {
  issueKey: string;
  repoPath: string;
  worktreesPath: string;
  baseBranch: string;
  exec?: ExecCommand;
}

const workspaceStateLabel = (status: IssueWorkspaceStatus): string => {
  if (status.state === "dirty") return "worktree_dirty";
  if (status.state === "clean") return "worktree_clean";
  if (status.state === "branch_mismatch") return "branch_mismatch";
  if (status.state === "invalid") return "invalid_worktree";
  return "missing";
};

export const formatIssueWorkspaceStatus = (status: IssueWorkspaceStatus): string => {
  const changedFiles =
    status.changedFiles.length === 0
      ? ["Changed files: none"]
      : ["Changed files:", ...status.changedFiles.map((line) => `- ${line.trimStart()}`)];
  const details = [
    `Aigile status: ${status.workspace.issueKey}`,
    `Workspace: ${status.workspace.worktreePath}`,
    `Branch: ${status.workspace.branchName}`,
    ...(status.currentBranch === undefined ? [] : [`Current branch: ${status.currentBranch}`]),
    `Base: ${status.workspace.baseBranch}`,
    `State: ${workspaceStateLabel(status)}`,
    ...(status.message === undefined ? [] : [`Message: ${status.message.trimEnd()}`]),
    ...changedFiles,
    "Suggested next actions:",
    `- run ${status.workspace.issueKey} --agent-write to continue local agent work`,
    `- run ${status.workspace.issueKey} --publish to let Aigile commit, push, and open a PR`,
    "- cleanup after preserving or discarding local changes",
  ];
  return details.join("\n");
};

export const runIssueWorkspaceStatus = async (
  input: IssueWorkspaceStatusInput,
): Promise<string> => {
  const status = await createGitWorkspaceAdapter({
    repoPath: input.repoPath,
    worktreesPath: input.worktreesPath,
    exec: input.exec ?? defaultExecCommand,
  }).getIssueWorkspaceStatus({
    issueKey: input.issueKey,
    baseBranch: input.baseBranch,
  });
  return formatIssueWorkspaceStatus(status);
};

export const runRunModePreflight = async (input: RunModePreflightInput): Promise<string> => {
  const exec = input.exec ?? defaultExecCommand;
  const workspace = await createGitWorkspaceAdapter({
    repoPath: input.repoPath,
    worktreesPath: input.worktreesPath,
    exec,
  }).checkIssueWorkspaceAvailability({
    issueKey: input.issueKey,
    baseBranch: input.baseBranch,
  });

  let publishLine = "Publish: skipped";
  if (input.publish) {
    const remote = input.remote ?? "origin";
    const publishPreflightInput: PublishPreflightInput = {
      repoPath: input.repoPath,
      remote,
      baseBranch: input.baseBranch,
      exec,
    };
    if (input.githubRepo !== undefined) publishPreflightInput.githubRepo = input.githubRepo;
    const publishPreflight = await runPublishPreflight(publishPreflightInput);
    publishLine = `Publish: ready ${publishPreflight.githubRepo} via ${remote} -> ${input.baseBranch}`;
  }

  return [
    `Aigile preflight: ${input.issueKey}`,
    `Workspace: available ${workspace.worktreePath} on ${workspace.branchName} from ${workspace.baseBranch}`,
    publishLine,
    "Agents: not started",
  ].join("\n");
};

export interface WatchOnceCliInput {
  issue?: IssueRecord;
  source?: ReadyIssueSource;
  tracker?: IssueTrackerAdapter;
  readyStatus?: string;
  claimStatus?: string;
  provider?: string;
  team?: string;
}

const formatWatchOnceResult = async (
  result: Awaited<ReturnType<typeof watchOnce>>,
  tracker: IssueTrackerAdapter,
  context: { provider?: string; team?: string } = {},
): Promise<string> => {
  const claimedIssue =
    result.claimedIssue === undefined ? undefined : await tracker.getIssue(result.claimedIssue.key);

  return [
    "Aigile watch: once",
    ...(context.provider === undefined ? [] : [`Provider: ${context.provider}`]),
    ...(context.team === undefined ? [] : [`Team: ${context.team}`]),
    `Ready issues: ${result.readyCount}`,
    `Claimed: ${claimedIssue?.key ?? "none"}`,
    ...(claimedIssue === undefined
      ? []
      : [
          `Status: ${claimedIssue.status}`,
          `Comment: ${claimedIssue.comments.at(-1) ?? defaultClaimComment}`,
        ]),
    "Agents: not started",
  ].join("\n");
};

export const runWatchOnceCli = async (input: WatchOnceCliInput): Promise<string> => {
  const issue =
    input.issue === undefined
      ? undefined
      : {
          ...input.issue,
          status: input.readyStatus ?? "ready",
        };
  const tracker =
    input.tracker ?? createFakeIssueTrackerAdapter(issue === undefined ? [] : [issue]);
  const source =
    input.source ??
    createFakeReadyIssueSource(issue === undefined ? [] : [issue], issue?.status ?? "ready");
  const watchInput = { source, tracker };
  const result = await watchOnce(
    input.claimStatus === undefined
      ? watchInput
      : { ...watchInput, claimStatus: input.claimStatus },
  );

  const context: { provider?: string; team?: string } = {};
  if (input.provider !== undefined) context.provider = input.provider;
  if (input.team !== undefined) context.team = input.team;
  return formatWatchOnceResult(result, tracker, context);
};

export interface LinearWatchOnceCliInput {
  apiKey: string;
  teamKey: string;
  readyStatus?: string;
  claimStatus?: string;
  fetchGraphql?: LinearFetchGraphql;
}

export interface LinearWatchLoopCliInput extends LinearWatchOnceCliInput {
  pollIntervalMs: number;
  maxPolls?: number;
  signal?: AbortSignal;
  sleep?: (durationMs: number, signal?: AbortSignal) => Promise<void>;
  onLine?: (line: string) => void;
  startRun?: (issue: IssueRecord) => Promise<string>;
}

export interface LinearWatchPreflightCliInput {
  apiKey: string;
  teamKey?: string;
  fetchGraphql?: LinearFetchGraphql;
}

export interface LinearRunIssueInput {
  apiKey: string;
  issueKey: string;
  fetchGraphql?: LinearFetchGraphql;
}

export interface LinearIssueWorkflowCliInput {
  apiKey: string;
  issueKey: string;
  teamKey?: string;
  repoPath: string;
  worktreesPath: string;
  runtimeConfigPath: string;
  baseBranch?: string;
  dryRun?: boolean;
  agentWrite?: boolean;
  publish?: boolean;
  remote?: string;
  pullRequestTarget?: PullRequestTarget;
  codeHost?: CodeHostAdapter;
  fetchGraphql?: LinearFetchGraphql;
  onProgressLine?: (line: string) => void;
  runWorkspace?: (input: DemoWorkspaceInput) => Promise<DemoResult>;
}

const artifactIdByKind = (result: DemoResult, kind: string): string =>
  result.artifacts.find((artifact) => artifact.kind === kind)?.id ?? "unavailable";

const alreadySatisfiedComment = (result: DemoResult): string =>
  [
    "Aigile verified this issue is already satisfied. No code changes were required.",
    "",
    `Final state: ${result.finalState}`,
    `Verification: ${artifactIdByKind(result, "verification.result")}`,
    `Checker: ${artifactIdByKind(result, "checker.verdict")}`,
  ].join("\n");

const publishedComment = (result: DemoResult): string =>
  [
    "Aigile completed this issue and published the result to GitHub.",
    "",
    `Final state: ${result.finalState}`,
    `Pull request: ${result.pullRequest?.url ?? "unavailable"}`,
    `Verification: ${artifactIdByKind(result, "verification.result")}`,
    `Checker: ${artifactIdByKind(result, "checker.verdict")}`,
  ].join("\n");

const formatListSection = (items: readonly string[]): string[] =>
  items.length === 0 ? ["- None."] : items.map((item) => `- ${item}`);

export const formatArchitectPlanComment = (plan: WorkflowArtifact): string => {
  if (plan.kind !== "architect.plan" || !isArchitectPlanPayload(plan.payload)) {
    throw new Error(`Architect plan artifact payload is invalid: ${plan.id}`);
  }

  return [
    "Aigile architect plan",
    "",
    "Summary:",
    plan.payload.summary,
    "",
    "Scope:",
    ...formatListSection(plan.payload.scope),
    "",
    "Acceptance criteria:",
    ...formatListSection(plan.payload.acceptanceCriteria),
    "",
    "Verification commands:",
    ...formatListSection(plan.payload.verificationCommands),
    "",
    "Risks:",
    ...formatListSection(plan.payload.risks),
  ].join("\n");
};

const blockedPublishedComment = (
  result: DemoResult,
  status: Exclude<PullRequestMergeabilityStatus, "mergeable">,
): string =>
  [
    "Aigile published this issue to GitHub, but the pull request is blocked and was not marked Done.",
    "",
    "Outcome: blocked/escalated",
    `Reason: ${status === "conflicting" ? "pull request has merge conflicts" : "pull request mergeability is unknown"}`,
    `Pull request: ${result.pullRequest?.url ?? "unavailable"}`,
    `Verification: ${artifactIdByKind(result, "verification.result")}`,
    `Checker: ${artifactIdByKind(result, "checker.verdict")}`,
  ].join("\n");

const publishedResultBlockedByMergeability = (result: DemoResult): DemoResult => ({
  ...result,
  finalState: "escalated",
});

const getPublishedMergeabilityStatus = async (
  codeHost: CodeHostAdapter | undefined,
  result: DemoResult,
): Promise<PullRequestMergeabilityStatus> => {
  if (result.pullRequest === undefined || codeHost === undefined) return "unknown";
  try {
    return (await codeHost.getPullRequestMergeability(result.pullRequest.id)).status;
  } catch {
    return "unknown";
  }
};

const syncLinearIssueWorkflowResult = async (
  input: LinearIssueWorkflowCliInput,
  result: DemoResult,
  codeHost?: CodeHostAdapter,
): Promise<DemoResult> => {
  if (input.dryRun === true) return result;
  const shouldSyncSatisfied = result.finalState === "satisfied";
  const shouldSyncPublished = input.publish === true && result.finalState === "merged";
  if (!shouldSyncSatisfied && !shouldSyncPublished) return result;

  const mergeabilityStatus = shouldSyncPublished
    ? await getPublishedMergeabilityStatus(codeHost ?? input.codeHost, result)
    : "mergeable";
  const syncResult =
    mergeabilityStatus === "mergeable" ? result : publishedResultBlockedByMergeability(result);

  const tracker = createLinearGraphqlIssueTrackerAdapter(
    input.fetchGraphql === undefined
      ? {
          apiKey: input.apiKey,
          ...(input.teamKey === undefined ? {} : { teamKey: input.teamKey }),
        }
      : {
          apiKey: input.apiKey,
          fetchGraphql: input.fetchGraphql,
          ...(input.teamKey === undefined ? {} : { teamKey: input.teamKey }),
        },
  );
  if (input.teamKey !== undefined && mergeabilityStatus === "mergeable") {
    await tracker.updateIssueStatus(input.issueKey, "Done");
  }
  await tracker.appendIssueComment(
    input.issueKey,
    shouldSyncSatisfied
      ? alreadySatisfiedComment(result)
      : mergeabilityStatus === "mergeable"
        ? publishedComment(result)
        : blockedPublishedComment(result, mergeabilityStatus),
  );
  return syncResult;
};

export const fetchLinearIssueForRun = async (input: LinearRunIssueInput): Promise<IssueRecord> => {
  const adapter = createLinearGraphqlIssueTrackerAdapter(
    input.fetchGraphql === undefined
      ? { apiKey: input.apiKey }
      : { apiKey: input.apiKey, fetchGraphql: input.fetchGraphql },
  );
  return adapter.getIssue(input.issueKey);
};

export const runLinearIssueWorkflowCli = async (
  input: LinearIssueWorkflowCliInput,
): Promise<string> => {
  const issue = await fetchLinearIssueForRun(
    input.fetchGraphql === undefined
      ? { apiKey: input.apiKey, issueKey: input.issueKey }
      : { apiKey: input.apiKey, issueKey: input.issueKey, fetchGraphql: input.fetchGraphql },
  );
  const runInput: DemoWorkspaceInput = {
    issue,
    repoPath: input.repoPath,
    worktreesPath: input.worktreesPath,
    registry: runtimeConfigToRegistry(
      loadRuntimeConfigFromJson(readFileSync(input.runtimeConfigPath, "utf8")),
    ),
  };
  if (input.baseBranch !== undefined) runInput.baseBranch = input.baseBranch;
  if (input.dryRun === true) {
    runInput.dryRun = true;
    runInput.exec = createDryRunExec();
  }
  if (input.publish === true) {
    const codeHost = input.codeHost ?? createFakeCodeHostAdapter();
    runInput.publish = true;
    runInput.remote = input.remote ?? "origin";
    if (input.pullRequestTarget !== undefined) runInput.pullRequestTarget = input.pullRequestTarget;
    runInput.codeHost = codeHost;
  }
  if (input.agentWrite === true && input.publish !== true) runInput.createPullRequest = false;
  const dryRunPlanOutputs: string[] = [];
  runInput.publishPlan = async (plan) => {
    const body = formatArchitectPlanComment(plan);
    if (input.dryRun === true) {
      const output = ["Aigile dry-run architect plan comment:", "", body].join("\n");
      dryRunPlanOutputs.push(output);
      for (const line of output.split("\n")) input.onProgressLine?.(line);
      return;
    }
    const tracker = createLinearGraphqlIssueTrackerAdapter(
      input.fetchGraphql === undefined
        ? {
            apiKey: input.apiKey,
            ...(input.teamKey === undefined ? {} : { teamKey: input.teamKey }),
          }
        : {
            apiKey: input.apiKey,
            fetchGraphql: input.fetchGraphql,
            ...(input.teamKey === undefined ? {} : { teamKey: input.teamKey }),
          },
    );
    await tracker.appendIssueComment(input.issueKey, body);
  };
  const progressFormatter = createAcpRoleProgressFormatter();
  runInput.runner = createAcpRoleRunner({
    onProgress: (event) => {
      for (const line of progressFormatter.format(event)) {
        if (line.trim().length > 0) input.onProgressLine?.(line);
      }
    },
  });
  const result = await (input.runWorkspace ?? runDemoIssueWithWorkspace)(runInput);
  const syncedResult = await syncLinearIssueWorkflowResult(input, result, runInput.codeHost);
  const formattedResult = formatDemoResult(syncedResult);
  return dryRunPlanOutputs.length === 0
    ? formattedResult
    : [...dryRunPlanOutputs, "", formattedResult].join("\n");
};

export const runLinearWatchOnceCli = async (input: LinearWatchOnceCliInput): Promise<string> => {
  const { source, tracker } = createLinearWatchAdapters(input);
  return runWatchOnceCli({
    source,
    tracker,
    claimStatus: input.claimStatus ?? "In Progress",
    provider: "linear",
    team: input.teamKey,
  });
};

const createLinearWatchAdapters = (
  input: LinearWatchOnceCliInput,
): {
  source: ReadyIssueSource;
  tracker: IssueTrackerAdapter;
} => {
  const fetchGraphql = input.fetchGraphql;
  const trackerOptions = {
    apiKey: input.apiKey,
    teamKey: input.teamKey,
  };
  const sourceOptions = {
    apiKey: input.apiKey,
    teamKey: input.teamKey,
    readyStatus: input.readyStatus ?? "Ready for Aigile",
  };
  return {
    tracker: createLinearGraphqlIssueTrackerAdapter(
      fetchGraphql === undefined ? trackerOptions : { ...trackerOptions, fetchGraphql },
    ),
    source: createLinearGraphqlReadyIssueSource(
      fetchGraphql === undefined ? sourceOptions : { ...sourceOptions, fetchGraphql },
    ),
  };
};

const formatWatchLoopEvent = (event: WatchLoopEvent): string => {
  if (event.type === "poll_started") return `Poll ${event.poll}: checking for ready issues`;
  if (event.type === "poll_idle")
    return `Poll ${event.poll}: idle (ready issues: ${event.readyCount})`;
  if (event.type === "issue_claimed") {
    return `Poll ${event.poll}: claimed ${event.issueKey} (ready issues: ${event.readyCount})`;
  }
  return `Stopped: ${event.reason} after ${event.polls} polls`;
};

const runResultStateLine = (output: string): string | undefined =>
  output
    .split("\n")
    .find((line) => line.startsWith("Final state:") || line.startsWith("Workflow state:"));

export const runLinearWatchLoopCli = async (input: LinearWatchLoopCliInput): Promise<string> => {
  const { source, tracker } = createLinearWatchAdapters(input);
  const lines: string[] = [];
  const emit = (line: string): void => {
    lines.push(line);
    input.onLine?.(line);
  };
  emit("Aigile watch: loop");
  emit("Provider: linear");
  emit(`Team: ${input.teamKey}`);
  emit(`Poll interval: ${input.pollIntervalMs}ms`);

  await watchLoop({
    source,
    tracker,
    pollIntervalMs: input.pollIntervalMs,
    ...(input.claimStatus === undefined ? {} : { claimStatus: input.claimStatus }),
    ...(input.maxPolls === undefined ? {} : { maxPolls: input.maxPolls }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
    onEvent: (event) => emit(formatWatchLoopEvent(event)),
    ...(input.startRun === undefined
      ? {}
      : {
          onClaimedIssue: async (issue: IssueRecord) => {
            emit(`Run ${issue.key}: starting`);
            const output = await input.startRun!(issue);
            const stateLine = runResultStateLine(output);
            if (stateLine !== undefined) emit(`Run ${issue.key}: ${stateLine}`);
            emit(`Run ${issue.key}: completed`);
          },
        }),
  });

  emit(input.startRun === undefined ? "Agents: not started" : "Agents: handled claimed issues");
  return lines.join("\n");
};

export const runLinearWatchPreflightCli = async (
  input: LinearWatchPreflightCliInput,
): Promise<string> => {
  const sharedOptions =
    input.fetchGraphql === undefined
      ? { apiKey: input.apiKey }
      : { apiKey: input.apiKey, fetchGraphql: input.fetchGraphql };
  const teams = await listLinearTeams(sharedOptions);
  const lines = [
    "Aigile watch: preflight",
    "Provider: linear",
    "Teams:",
    ...teams.map((team) => `- ${team.key} (${team.name})`),
  ];

  if (input.teamKey !== undefined) {
    const workflowStateOptions =
      input.fetchGraphql === undefined
        ? { apiKey: input.apiKey, teamKey: input.teamKey }
        : { apiKey: input.apiKey, teamKey: input.teamKey, fetchGraphql: input.fetchGraphql };
    const workflowStateNames = await listLinearWorkflowStateNames(workflowStateOptions);
    lines.push(
      `Workflow states (${input.teamKey}):`,
      ...workflowStateNames.map((name) => `- ${name}`),
    );
  }

  lines.push("Agents: not started");
  return lines.join("\n");
};

export const createDryRunExec = (): ExecCommand => async (command, commandArgs, options) => {
  if (command === "test" && commandArgs[0] === "-e") {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
  if (command === "git" && commandArgs[0] === "show-ref") {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
  if (command === "git" && commandArgs[0] === "diff") {
    return { stdout: "dry-run diff | 1 +", stderr: "", exitCode: 0 };
  }
  return {
    stdout: `${command} ${commandArgs.join(" ")} in ${options.cwd}`,
    stderr: "",
    exitCode: 0,
  };
};

const optionValue = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
};

const optionValues = (args: readonly string[], name: string): string[] => {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value) throw new Error(`${name} requires a value`);
    values.push(value);
  }
  return values;
};

export const parseDurationMs = (value: string): number => {
  const match = /^(\d+)(ms|s|m)?$/.exec(value.trim());
  if (!match) throw new Error(`invalid duration: ${value}`);
  const amount = Number(match[1]);
  if (amount <= 0) throw new Error(`invalid duration: ${value}`);
  const unit = match[2] ?? "ms";
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1_000;
  return amount * 60_000;
};

const parsePositiveInteger = (value: string, name: string): number => {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number.parseInt(value, 10);
  if (parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

export const parseCliArgs = (args: readonly string[]): CliArgs => {
  if (args[0] === "watch") {
    const preflightOnly = args.includes("--preflight");
    const pollInterval = optionValue(args, "--poll-interval");
    if (!args.includes("--once") && !preflightOnly && pollInterval === undefined) {
      throw new Error("watch currently requires --once or --poll-interval");
    }
    const parsed: CliArgs = { mode: "watch" };
    if (args.includes("--once")) parsed.once = true;
    if (preflightOnly) parsed.preflightOnly = true;
    if (pollInterval !== undefined) parsed.pollIntervalMs = parseDurationMs(pollInterval);
    const issueKey = optionValue(args, "--issue");
    const title = optionValue(args, "--title");
    const description = optionValue(args, "--description");
    const acceptanceCriteria = optionValues(args, "--acceptance");
    const readyStatus = optionValue(args, "--ready-status");
    const claimStatus = optionValue(args, "--claim-status");
    const runtimeConfigPath = optionValue(args, "--runtime-config");
    const repoPath = optionValue(args, "--repo");
    const worktreesPath = optionValue(args, "--worktrees");
    const baseBranch = optionValue(args, "--base-branch");
    const remote = optionValue(args, "--remote");
    const githubRepo = optionValue(args, "--github-repo");
    const linearTeam = optionValue(args, "--linear-team");
    const linearApiKeyEnv = optionValue(args, "--linear-api-key-env");
    const maxPolls = optionValue(args, "--max-polls");
    if (issueKey !== undefined) parsed.issueKey = issueKey;
    if (title !== undefined) parsed.title = title;
    if (description !== undefined) parsed.description = description;
    if (acceptanceCriteria.length > 0) parsed.acceptanceCriteria = acceptanceCriteria;
    if (readyStatus !== undefined) parsed.readyStatus = readyStatus;
    if (claimStatus !== undefined) parsed.claimStatus = claimStatus;
    if (runtimeConfigPath !== undefined) parsed.runtimeConfigPath = runtimeConfigPath;
    if (repoPath !== undefined) parsed.repoPath = repoPath;
    if (worktreesPath !== undefined) parsed.worktreesPath = worktreesPath;
    if (baseBranch !== undefined) parsed.baseBranch = baseBranch;
    if (remote !== undefined) parsed.remote = remote;
    if (githubRepo !== undefined) parsed.githubRepo = githubRepo;
    if (args.includes("--linear")) parsed.linear = true;
    if (linearTeam !== undefined) parsed.linearTeam = linearTeam;
    if (linearApiKeyEnv !== undefined) parsed.linearApiKeyEnv = linearApiKeyEnv;
    if (maxPolls !== undefined) parsed.maxPolls = parsePositiveInteger(maxPolls, "--max-polls");
    if (args.includes("--start-run")) parsed.startRun = true;
    if (args.includes("--publish")) parsed.publish = true;
    if (args.includes("--dry-run")) parsed.dryRun = true;
    if (args.includes("--agent-write")) parsed.agentWrite = true;
    if (parsed.dryRun && parsed.agentWrite) {
      throw new Error("choose only one of --dry-run or --agent-write");
    }
    if (parsed.startRun) {
      if (parsed.pollIntervalMs === undefined)
        throw new Error("watch --start-run requires --poll-interval");
      if (parsed.runtimeConfigPath === undefined)
        throw new Error("watch --start-run requires --runtime-config");
      if (parsed.dryRun !== true && parsed.agentWrite !== true) {
        throw new Error("watch --start-run requires --dry-run or --agent-write");
      }
    }
    return parsed;
  }
  if (args[0] === "status") {
    const issueKey = args[1];
    if (!issueKey) throw new Error("status requires an issue key");
    const parsed: CliArgs = { mode: "status", issueKey };
    const repoPath = optionValue(args, "--repo");
    const worktreesPath = optionValue(args, "--worktrees");
    const baseBranch = optionValue(args, "--base-branch");
    if (repoPath !== undefined) parsed.repoPath = repoPath;
    if (worktreesPath !== undefined) parsed.worktreesPath = worktreesPath;
    if (baseBranch !== undefined) parsed.baseBranch = baseBranch;
    return parsed;
  }
  if (args[0] === "run") {
    const issueKey = args[1];
    if (!issueKey) throw new Error("run requires an issue key");
    const parsed: CliArgs = { mode: "run", issueKey };
    const title = optionValue(args, "--title");
    const description = optionValue(args, "--description");
    const acceptanceCriteria = optionValues(args, "--acceptance");
    const runtimeConfigPath = optionValue(args, "--runtime-config");
    const repoPath = optionValue(args, "--repo");
    const worktreesPath = optionValue(args, "--worktrees");
    const baseBranch = optionValue(args, "--base-branch");
    const remote = optionValue(args, "--remote");
    const githubRepo = optionValue(args, "--github-repo");
    const linearTeam = optionValue(args, "--linear-team");
    const linearApiKeyEnv = optionValue(args, "--linear-api-key-env");
    if (title !== undefined) parsed.title = title;
    if (description !== undefined) parsed.description = description;
    if (acceptanceCriteria.length > 0) parsed.acceptanceCriteria = acceptanceCriteria;
    if (runtimeConfigPath !== undefined) parsed.runtimeConfigPath = runtimeConfigPath;
    if (repoPath !== undefined) parsed.repoPath = repoPath;
    if (worktreesPath !== undefined) parsed.worktreesPath = worktreesPath;
    if (baseBranch !== undefined) parsed.baseBranch = baseBranch;
    if (remote !== undefined) parsed.remote = remote;
    if (githubRepo !== undefined) parsed.githubRepo = githubRepo;
    if (args.includes("--linear")) parsed.linear = true;
    if (linearTeam !== undefined) parsed.linearTeam = linearTeam;
    if (linearApiKeyEnv !== undefined) parsed.linearApiKeyEnv = linearApiKeyEnv;
    if (args.includes("--publish")) parsed.publish = true;
    if (args.includes("--dry-run")) parsed.dryRun = true;
    if (args.includes("--agent-write")) parsed.agentWrite = true;
    if (parsed.dryRun && parsed.agentWrite) {
      throw new Error("choose only one of --dry-run or --agent-write");
    }
    if (args.includes("--preflight-only")) parsed.preflightOnly = true;
    return parsed;
  }
  const parsed: CliArgs = { mode: selectDemoMode(args) };
  const runtimeConfigPath = optionValue(args, "--runtime-config");
  if (runtimeConfigPath !== undefined) parsed.runtimeConfigPath = runtimeConfigPath;
  return parsed;
};

const main = async (): Promise<void> => {
  const args = parseCliArgs(process.argv.slice(2));
  const linearIssue =
    args.mode === "run" && args.linear
      ? await (async (): Promise<IssueRecord> => {
          const issueKey = args.issueKey ?? defaultIssue.key;
          const apiKeyEnv = args.linearApiKeyEnv ?? "LINEAR_API_KEY";
          const apiKey = process.env[apiKeyEnv];
          if (!apiKey) throw new Error(`run --linear requires ${apiKeyEnv} to be set`);
          return fetchLinearIssueForRun({ apiKey, issueKey });
        })()
      : undefined;
  const runInput: DemoWorkspaceInput = {
    issue: {
      ...(linearIssue ?? defaultIssue),
      key: args.issueKey ?? defaultIssue.key,
      title: args.title ?? linearIssue?.title ?? defaultIssue.title,
      description: args.description ?? linearIssue?.description ?? defaultIssue.description,
      acceptanceCriteria:
        args.acceptanceCriteria ??
        linearIssue?.acceptanceCriteria ??
        defaultIssue.acceptanceCriteria,
    },
    repoPath: args.repoPath ?? process.cwd(),
    worktreesPath: args.worktreesPath ?? `${process.cwd()}/.worktrees`,
  };
  if (args.baseBranch !== undefined) runInput.baseBranch = args.baseBranch;
  if (args.mode === "status") {
    const output = await runIssueWorkspaceStatus({
      issueKey: args.issueKey ?? defaultIssue.key,
      repoPath: args.repoPath ?? process.cwd(),
      worktreesPath: args.worktreesPath ?? `${process.cwd()}/.worktrees`,
      baseBranch: args.baseBranch ?? "main",
    });
    process.stdout.write(`${output}\n`);
    return;
  }
  if (args.mode === "watch") {
    if (args.preflightOnly) {
      if (!args.linear) throw new Error("watch --preflight requires --linear");
      const apiKeyEnv = args.linearApiKeyEnv ?? "LINEAR_API_KEY";
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) throw new Error(`watch --linear requires ${apiKeyEnv} to be set`);
      const preflightInput: LinearWatchPreflightCliInput = { apiKey };
      if (args.linearTeam !== undefined) preflightInput.teamKey = args.linearTeam;
      const output = await runLinearWatchPreflightCli(preflightInput);
      process.stdout.write(`${output}\n`);
      return;
    }
    if (args.linear) {
      if (args.linearTeam === undefined) throw new Error("watch --linear requires --linear-team");
      const apiKeyEnv = args.linearApiKeyEnv ?? "LINEAR_API_KEY";
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) throw new Error(`watch --linear requires ${apiKeyEnv} to be set`);
      if (args.pollIntervalMs !== undefined) {
        const controller = new AbortController();
        process.once("SIGINT", () => controller.abort());
        const loopInput: LinearWatchLoopCliInput = {
          apiKey,
          teamKey: args.linearTeam,
          pollIntervalMs: args.pollIntervalMs,
          signal: controller.signal,
          onLine: (line) => process.stdout.write(`${line}\n`),
        };
        if (args.readyStatus !== undefined) loopInput.readyStatus = args.readyStatus;
        if (args.claimStatus !== undefined) loopInput.claimStatus = args.claimStatus;
        if (args.maxPolls !== undefined) loopInput.maxPolls = args.maxPolls;
        if (args.startRun) {
          if (args.runtimeConfigPath === undefined)
            throw new Error("watch --start-run requires --runtime-config");
          if (args.dryRun !== true && args.agentWrite !== true) {
            throw new Error("watch --start-run requires --dry-run or --agent-write");
          }
          const publishRunInput: Pick<
            LinearIssueWorkflowCliInput,
            "publish" | "remote" | "pullRequestTarget" | "codeHost"
          > = {};
          if (args.publish === true && args.dryRun !== true) {
            const remote = args.remote ?? "origin";
            const baseBranch = args.baseBranch ?? "main";
            const publishPreflightInput: PublishPreflightInput = {
              repoPath: args.repoPath ?? process.cwd(),
              remote,
              baseBranch,
            };
            if (args.githubRepo !== undefined) publishPreflightInput.githubRepo = args.githubRepo;
            const publishPreflight = await runPublishPreflight(publishPreflightInput);
            const [owner, repo] = publishPreflight.githubRepo.split("/");
            if (!owner || !repo) throw new Error("--github-repo must be in owner/repo format");
            publishRunInput.publish = true;
            publishRunInput.remote = remote;
            publishRunInput.pullRequestTarget = { owner, repo, baseBranch };
            publishRunInput.codeHost = createGitHubCliCodeHostAdapter({
              cwd: args.repoPath ?? process.cwd(),
              exec: async (command, commandArgs, options) =>
                defaultExecCommand(command, commandArgs, { cwd: options.cwd ?? process.cwd() }),
            });
          } else if (args.publish === true) {
            publishRunInput.publish = true;
            publishRunInput.remote = args.remote ?? "origin";
          }
          loopInput.startRun = async (issue) =>
            runLinearIssueWorkflowCli({
              apiKey,
              issueKey: issue.key,
              ...(args.linearTeam === undefined ? {} : { teamKey: args.linearTeam }),
              repoPath: args.repoPath ?? process.cwd(),
              worktreesPath: args.worktreesPath ?? `${process.cwd()}/.worktrees`,
              runtimeConfigPath: args.runtimeConfigPath!,
              ...(args.baseBranch === undefined ? {} : { baseBranch: args.baseBranch }),
              ...(args.dryRun === true ? { dryRun: true } : {}),
              ...(args.agentWrite === true ? { agentWrite: true } : {}),
              ...publishRunInput,
              onProgressLine: (line) => process.stderr.write(`${line}\n`),
            });
        }
        await runLinearWatchLoopCli(loopInput);
        return;
      }
      const linearInput: LinearWatchOnceCliInput = {
        apiKey,
        teamKey: args.linearTeam,
      };
      if (args.readyStatus !== undefined) linearInput.readyStatus = args.readyStatus;
      if (args.claimStatus !== undefined) linearInput.claimStatus = args.claimStatus;
      const output = await runLinearWatchOnceCli(linearInput);
      process.stdout.write(`${output}\n`);
      return;
    }
    const watchInput: WatchOnceCliInput = { issue: runInput.issue };
    if (args.readyStatus !== undefined) watchInput.readyStatus = args.readyStatus;
    if (args.claimStatus !== undefined) watchInput.claimStatus = args.claimStatus;
    const output = await runWatchOnceCli(watchInput);
    process.stdout.write(`${output}\n`);
    return;
  }
  if (args.mode === "run" && args.preflightOnly) {
    const preflightInput: RunModePreflightInput = {
      issueKey: args.issueKey ?? defaultIssue.key,
      repoPath: args.repoPath ?? process.cwd(),
      worktreesPath: args.worktreesPath ?? `${process.cwd()}/.worktrees`,
      baseBranch: args.baseBranch ?? "main",
    };
    if (args.publish !== undefined) preflightInput.publish = args.publish;
    if (args.githubRepo !== undefined) preflightInput.githubRepo = args.githubRepo;
    if (args.remote !== undefined) preflightInput.remote = args.remote;
    const output = await runRunModePreflight(preflightInput);
    process.stdout.write(`${output}\n`);
    return;
  }
  if (args.dryRun) {
    runInput.dryRun = true;
    runInput.exec = createDryRunExec();
  }
  if (
    args.mode === "run" &&
    args.runtimeConfigPath &&
    !args.preflightOnly &&
    !args.dryRun &&
    !args.agentWrite
  ) {
    throw new Error("run with --runtime-config requires --dry-run or --agent-write");
  }
  if (args.mode === "run" && args.agentWrite && !args.publish) {
    runInput.createPullRequest = false;
  }
  if (args.mode === "run" && args.publish && !args.dryRun) {
    const remote = args.remote ?? "origin";
    const baseBranch = args.baseBranch ?? "main";
    const publishPreflightInput: PublishPreflightInput = {
      repoPath: args.repoPath ?? process.cwd(),
      remote,
      baseBranch,
    };
    if (args.githubRepo !== undefined) publishPreflightInput.githubRepo = args.githubRepo;
    const publishPreflight = await runPublishPreflight(publishPreflightInput);
    const [owner, repo] = publishPreflight.githubRepo.split("/");
    if (!owner || !repo) throw new Error("--github-repo must be in owner/repo format");
    runInput.publish = true;
    runInput.remote = remote;
    runInput.pullRequestTarget = {
      owner,
      repo,
      baseBranch,
    };
    runInput.codeHost = createGitHubCliCodeHostAdapter({
      cwd: args.repoPath ?? process.cwd(),
      exec: async (command, commandArgs, options) =>
        defaultExecCommand(command, commandArgs, { cwd: options.cwd ?? process.cwd() }),
    });
  }
  if (args.mode === "run" && args.runtimeConfigPath) {
    runInput.registry = runtimeConfigToRegistry(
      loadRuntimeConfigFromJson(readFileSync(args.runtimeConfigPath, "utf8")),
    );
    const progressFormatter = createAcpRoleProgressFormatter();
    runInput.runner = createAcpRoleRunner({
      onProgress: (event) => {
        for (const line of progressFormatter.format(event)) {
          if (line.trim().length > 0) process.stderr.write(`${line}\n`);
        }
      },
    });
  }
  const result =
    args.mode === "run"
      ? await runDemoIssueWithWorkspace(runInput)
      : args.mode === "agents"
        ? args.runtimeConfigPath
          ? await runDemoIssueWithRoles({
              issue: defaultIssue,
              registry: runtimeConfigToRegistry(
                loadRuntimeConfigFromJson(readFileSync(args.runtimeConfigPath, "utf8")),
              ),
              runner: createAcpRoleRunner(),
            })
          : await runDemoIssueWithAcpRoles({ issue: defaultIssue })
        : args.mode === "workspace"
          ? await runDemoIssueWithWorkspace({
              issue: defaultIssue,
              repoPath: "/tmp/aigile-demo-repo",
              worktreesPath: "/tmp/aigile-demo-repo/.worktrees",
              exec: async (command, args, options) => {
                if (command === "git" && args[0] === "worktree")
                  return { stdout: "", stderr: "", exitCode: 0 };
                if (command === "git" && args[0] === "diff") {
                  return { stdout: "packages/demo/src/run.ts | 4 ++++", stderr: "", exitCode: 0 };
                }
                return {
                  stdout: `${command} ${args.join(" ")} in ${options.cwd}`,
                  stderr: "",
                  exitCode: 0,
                };
              },
            })
          : args.mode === "github"
            ? await runDemoIssueWithGitHub({
                issue: defaultIssue,
                ghExec: async (_command, args) => {
                  if (args[0] === "pr" && args[1] === "create") {
                    return {
                      stdout: "https://github.com/aigile/aigile/pull/1",
                      stderr: "",
                      exitCode: 0,
                    };
                  }
                  return { stdout: "", stderr: "", exitCode: 0 };
                },
              })
            : args.mode === "linear"
              ? await runDemoIssueFromLinear({
                  issueKey: "LIN-123",
                  linearApiKey: "demo-key",
                  fetchGraphql: async () => ({
                    issue: {
                      id: "issue-demo-1",
                      identifier: "LIN-123",
                      title: "Build hand-testable pipeline",
                      description:
                        "Acceptance:\n- Architect plan exists\n- Verifier passes\n- Pull request artifact exists",
                      priority: 1,
                      state: { name: "Todo" },
                      comments: { nodes: [] },
                    },
                  }),
                })
              : await runDemoIssue({ issue: defaultIssue });
  process.stdout.write(`${formatDemoResult(result)}\n`);
};

if (import.meta.path === Bun.main) {
  await main();
}
