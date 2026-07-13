#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
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
import {
  DEFAULT_ISSUE_STATUS_LABELS,
  findProductConfig,
  loadProductConfigFromFile,
  loadRuntimeConfigFromJson,
  resolveProductPaths,
  runtimeConfigToRegistry,
  splitGithubRepo,
  type ProductVerificationPolicy,
  type RuntimeProduct,
  type RuntimeProductConfig,
} from "@aigile/config";
import {
  runDemoIssue,
  runDemoIssueFromLinear,
  runDemoIssueWithAcpRoles,
  runDemoIssueWithGitHub,
  runDemoIssueWithRoles,
  runDemoIssueWithWorkspace,
  runWorkspaceIssueWithEngine,
  type DemoWorkspaceInput,
  type DemoResult,
  type PullRequestTarget,
} from "@aigile/demo";
import type {
  CodeHostAdapter,
  IssueRecord,
  IssueTrackerAdapter,
  LinearFetchGraphql,
  ReadyIssueSource,
} from "@aigile/adapters";
import { createAcpRoleRunner, type AcpRoleProgressEvent } from "@aigile/roles";
import { isArchitectPlanPayload, type WorkflowArtifact } from "@aigile/types";
import {
  defaultClaimComment,
  ingestExternalReviewFeedback,
  reconcileIssueStatus,
  reconcileProducts,
  runStatePathForProduct,
  watchLoop,
  watchOnce,
  type ReconcileProductOutcome,
  type ReconcileStatusLabels,
  type WatchLoopEvent,
  type WatchProductRoute,
} from "@aigile/watch";
import {
  createGitWorkspaceAdapter,
  defaultExecCommand,
  issueBranchName,
  type ExecCommand,
  type ExecResult,
  type IssueWorkspaceStatus,
} from "@aigile/workspace";
import { createFileRunStore, listResumableRuns } from "@aigile/workflow";
import { join } from "node:path";

const demoCliEnabled = (): boolean => process.env.AIGILE_ENABLE_DEMO_CLI === "1";

const assertDemoCliEnabled = (): void => {
  if (!demoCliEnabled()) {
    throw new Error("demo modes require AIGILE_ENABLE_DEMO_CLI=1");
  }
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

// Progress verbosity. "quiet" = lifecycle milestones + things needing attention
// only; "normal" (default) adds the agent's text output, tool starts, and
// permission decisions; "verbose" adds raw streams (thinking, subprocess stderr,
// connection chatter, tool ends) for debugging.
export type ProgressLevel = "quiet" | "normal" | "verbose";

const LEVEL_RANK: Record<ProgressLevel, number> = { quiet: 0, normal: 1, verbose: 2 };

// Minimum level at which each event type is shown.
const EVENT_MIN_LEVEL: Record<AcpRoleProgressEvent["type"], ProgressLevel> = {
  role_started: "quiet",
  runtime_connected: "quiet",
  policy_violation: "quiet",
  approval_request: "quiet",
  artifact_parsed: "quiet",
  text_delta: "normal",
  tool_start: "normal",
  permission_decision: "normal",
  runtime_stopped: "normal",
  runtime_connecting: "verbose",
  prompt_started: "verbose",
  thinking_delta: "verbose",
  runtime_stderr: "verbose",
  tool_end: "verbose",
  token_usage: "verbose",
};

const isEventVisible = (level: ProgressLevel, type: AcpRoleProgressEvent["type"]): boolean =>
  LEVEL_RANK[level] >= LEVEL_RANK[EVENT_MIN_LEVEL[type]];

export interface AcpRoleProgressFormatterOptions {
  textFlushThreshold?: number;
  level?: ProgressLevel;
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
  const level = options.level ?? "normal";
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
      // Drop events below the configured level, but still flush any buffered text
      // we already committed to showing so it is not lost behind a suppressed event.
      if (!isEventVisible(level, event.type)) {
        return flushKey(key);
      }
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
  | "watch"
  | "reconcile";

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
  productsConfigPath?: string;
  product?: string;
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
  retryEscalated?: boolean;
  progressLevel?: ProgressLevel;
}

export interface ProductCliResolutionOptions {
  cwd?: string;
  homeDir?: string;
}

export interface ResolvedProductCliContext {
  productId?: string;
  linearTeam?: string;
  linearProject?: string;
  githubRepo?: string;
  githubOwner?: string;
  githubRepository?: string;
  baseBranch: string;
  repoPath: string;
  worktreesPath: string;
  dryRun: boolean;
  agentWrite: boolean;
  publish: boolean;
  startRun: boolean;
  verification?: ProductVerificationPolicy;
}

const resolveProductCliContextForProduct = (
  args: CliArgs,
  product: RuntimeProduct | undefined,
  options: ProductCliResolutionOptions = {},
): ResolvedProductCliContext => {
  const productPaths =
    product === undefined
      ? undefined
      : resolveProductPaths(product, {
          cwd: options.cwd ?? process.cwd(),
          ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
        });
  const linearTeam = args.linearTeam ?? product?.linear.team;
  const githubRepo = args.githubRepo ?? product?.github.repo;
  const githubParts = githubRepo === undefined ? undefined : splitGithubRepo(githubRepo);
  const mode =
    args.dryRun === true
      ? "dry_run"
      : args.agentWrite === true
        ? "agent_write"
        : product?.defaultRun.mode;
  return {
    ...(product === undefined ? {} : { productId: product.id }),
    ...(linearTeam === undefined ? {} : { linearTeam }),
    ...(product?.linear.project === undefined ? {} : { linearProject: product.linear.project }),
    ...(githubRepo === undefined ? {} : { githubRepo }),
    ...(githubParts === undefined
      ? {}
      : { githubOwner: githubParts.owner, githubRepository: githubParts.repo }),
    baseBranch: args.baseBranch ?? product?.github.baseBranch ?? "main",
    repoPath: args.repoPath ?? productPaths?.repoPath ?? options.cwd ?? process.cwd(),
    worktreesPath:
      args.worktreesPath ??
      productPaths?.worktreesPath ??
      `${options.cwd ?? process.cwd()}/.worktrees`,
    dryRun: mode === "dry_run",
    agentWrite: mode === "agent_write",
    publish: args.publish ?? product?.defaultRun.publish ?? false,
    startRun: args.startRun ?? product?.defaultRun.startRun ?? false,
    ...(product?.verification === undefined ? {} : { verification: product.verification }),
  };
};

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

export const resolveProductCliContext = (
  args: CliArgs,
  productConfig?: RuntimeProductConfig,
  options: ProductCliResolutionOptions = {},
): ResolvedProductCliContext => {
  const productsConfigPath = args.productsConfigPath ?? "config/aigile.products.json";
  if (
    args.product !== undefined &&
    productConfig === undefined &&
    !existsSync(productsConfigPath)
  ) {
    throw new Error(
      `product config not found: ${productsConfigPath}. Pass --products-config <path> or create config/aigile.products.json from config/aigile.products.example.json.`,
    );
  }
  const product =
    args.product === undefined
      ? undefined
      : findProductConfig(
          productConfig ?? loadProductConfigFromFile(productsConfigPath),
          args.product,
        );
  return resolveProductCliContextForProduct(args, product, options);
};

export const resolveProductCliContexts = (
  args: CliArgs,
  productConfig?: RuntimeProductConfig,
  options: ProductCliResolutionOptions = {},
): ResolvedProductCliContext[] => {
  if (args.product !== undefined) return [resolveProductCliContext(args, productConfig, options)];
  if (args.productsConfigPath === undefined && productConfig === undefined) {
    return [resolveProductCliContext(args, productConfig, options)];
  }
  const productsConfigPath = args.productsConfigPath ?? "config/aigile.products.json";
  if (productConfig === undefined && !existsSync(productsConfigPath)) {
    return [resolveProductCliContext(args, productConfig, options)];
  }
  const config = productConfig ?? loadProductConfigFromFile(productsConfigPath);
  return config.products.map((product) =>
    resolveProductCliContextForProduct(args, product, options),
  );
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
    remote: input.remote ?? "origin",
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
  productId?: string;
  linearProject?: string;
  githubRepo?: string;
}

const formatWatchOnceResult = async (
  result: Awaited<ReturnType<typeof watchOnce>>,
  tracker: IssueTrackerAdapter,
  context: {
    provider?: string;
    team?: string;
    productId?: string;
    linearProject?: string;
    githubRepo?: string;
  } = {},
): Promise<string> => {
  const claimedIssue =
    result.claimedIssue === undefined ? undefined : await tracker.getIssue(result.claimedIssue.key);
  const selectedProductId = result.selectedRoute?.productId ?? context.productId;
  const selectedProject = result.selectedRoute?.linearProject ?? context.linearProject;
  const selectedGithubRepo = result.selectedRoute?.githubRepo ?? context.githubRepo;

  return [
    "Aigile watch: once",
    ...(context.provider === undefined ? [] : [`Provider: ${context.provider}`]),
    ...(selectedProductId === undefined ? [] : [`Product: ${selectedProductId}`]),
    ...(selectedProject === undefined ? [] : [`Project: ${selectedProject}`]),
    ...(context.team === undefined ? [] : [`Team: ${context.team}`]),
    ...(selectedGithubRepo === undefined ? [] : [`GitHub repo: ${selectedGithubRepo}`]),
    `Ready issues: ${result.readyCount}`,
    `Claimed: ${claimedIssue?.key ?? "none"}`,
    ...(result.skippedIssues ?? []).map((issue) => `Skipped: ${issue.issueKey} (${issue.reason})`),
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
  const productRoutes = productRouteFromInput(input);
  const result = await watchOnce(
    input.claimStatus === undefined
      ? { ...watchInput, ...(productRoutes === undefined ? {} : { productRoutes }) }
      : {
          ...watchInput,
          claimStatus: input.claimStatus,
          ...(productRoutes === undefined ? {} : { productRoutes }),
        },
  );

  const context: {
    provider?: string;
    team?: string;
    productId?: string;
    linearProject?: string;
    githubRepo?: string;
  } = {};
  if (input.provider !== undefined) context.provider = input.provider;
  if (input.team !== undefined) context.team = input.team;
  if (input.productId !== undefined) context.productId = input.productId;
  if (input.linearProject !== undefined) context.linearProject = input.linearProject;
  if (input.githubRepo !== undefined) context.githubRepo = input.githubRepo;
  return formatWatchOnceResult(result, tracker, context);
};

export interface LinearWatchOnceCliInput {
  apiKey: string;
  teamKey: string;
  productId?: string;
  linearProject?: string;
  githubRepo?: string;
  readyStatus?: string;
  claimStatus?: string;
  fetchGraphql?: LinearFetchGraphql;
}

export interface LinearWatchLoopCliInput extends LinearWatchOnceCliInput {
  teamKeys?: readonly string[];
  productRoutes?: readonly WatchProductRoute[];
  pollIntervalMs: number;
  maxPolls?: number;
  signal?: AbortSignal;
  sleep?: (durationMs: number, signal?: AbortSignal) => Promise<void>;
  onLine?: (line: string) => void;
  startRun?: (issue: IssueRecord, route?: WatchProductRoute) => Promise<string>;
  // When a code host and repo target are supplied, the loop reconciles in-flight
  // issue status from PR state each poll (PR open -> In Review, merged -> Done,
  // closed -> back to the ready queue), independent of any run.
  codeHost?: CodeHostAdapter;
  pullRequestTarget?: { owner: string; repo: string };
  reviewStatus?: string;
  reworkStatus?: string;
  runStatePath?: string;
  reconcileLabels?: ReconcileStatusLabels;
  resume?: {
    listResumable: () => Promise<string[]>;
    resumeRun: (issueId: string) => Promise<{ outcome: string }>;
  };
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
  verification?: ProductVerificationPolicy;
  runStatePath?: string;
  retryEscalated?: boolean;
  progressLevel?: ProgressLevel;
}

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

const productRouteFromInput = (input: {
  productId?: string;
  linearProject?: string;
  githubRepo?: string;
}): WatchProductRoute[] | undefined => {
  if (
    input.productId === undefined ||
    input.linearProject === undefined ||
    input.githubRepo === undefined
  ) {
    return undefined;
  }
  return [
    {
      productId: input.productId,
      linearProject: input.linearProject,
      githubRepo: input.githubRepo,
    },
  ];
};

const syncLinearIssueWorkflowResult = async (
  input: LinearIssueWorkflowCliInput,
  result: DemoResult,
): Promise<DemoResult> => {
  void input;
  return result;
};

export const fetchLinearIssueForRun = async (input: LinearRunIssueInput): Promise<IssueRecord> => {
  const fetchGraphql = input.fetchGraphql;
  const adapter = createLinearGraphqlIssueTrackerAdapter(
    fetchGraphql === undefined ? { apiKey: input.apiKey } : { apiKey: input.apiKey, fetchGraphql },
  );
  return adapter.getIssue(input.issueKey);
};

export const runLinearIssueWorkflowCli = async (
  input: LinearIssueWorkflowCliInput,
): Promise<string> => {
  const fetchGraphql = input.fetchGraphql;
  const issue = await fetchLinearIssueForRun(
    fetchGraphql === undefined
      ? { apiKey: input.apiKey, issueKey: input.issueKey }
      : { apiKey: input.apiKey, issueKey: input.issueKey, fetchGraphql },
  );
  const runtimeConfig = loadRuntimeConfigFromJson(readFileSync(input.runtimeConfigPath, "utf8"));
  const runInput: DemoWorkspaceInput = {
    issue,
    repoPath: input.repoPath,
    worktreesPath: input.worktreesPath,
    registry: runtimeConfigToRegistry(runtimeConfig),
    issueStatusLabels: runtimeConfig.issueStatusLabels,
  };
  if (input.dryRun !== true) {
    const issueTracker = createLinearGraphqlIssueTrackerAdapter(
      fetchGraphql === undefined
        ? {
            apiKey: input.apiKey,
            ...(input.teamKey === undefined ? {} : { teamKey: input.teamKey }),
          }
        : {
            apiKey: input.apiKey,
            fetchGraphql,
            ...(input.teamKey === undefined ? {} : { teamKey: input.teamKey }),
          },
    );
    runInput.issueTracker = {
      getIssue: issueTracker.getIssue,
      updateIssueStatus: issueTracker.updateIssueStatus,
      appendIssueComment: issueTracker.appendIssueComment,
    };
    runInput.onIssueStatusUpdateError = (error, state, status) => {
      const message = error instanceof Error ? error.message : String(error);
      input.onProgressLine?.(
        `Linear status sync failed for ${input.issueKey} (${state} -> ${status}): ${message}`,
      );
    };
  }
  const verificationCommands = [
    ...(input.verification?.install ?? []),
    ...(input.verification?.checks ?? []),
  ];
  if (verificationCommands.length > 0) runInput.verificationCommands = verificationCommands;
  if (input.verification?.changedFileGuards !== undefined) {
    runInput.changedFileGuards = input.verification.changedFileGuards;
  }
  if (input.runStatePath !== undefined) runInput.runStatePath = input.runStatePath;
  if (input.retryEscalated === true) runInput.retryEscalated = true;
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
      fetchGraphql === undefined
        ? {
            apiKey: input.apiKey,
            ...(input.teamKey === undefined ? {} : { teamKey: input.teamKey }),
          }
        : {
            apiKey: input.apiKey,
            fetchGraphql,
            ...(input.teamKey === undefined ? {} : { teamKey: input.teamKey }),
          },
    );
    await tracker.appendIssueComment(input.issueKey, body);
  };
  const progressFormatter = createAcpRoleProgressFormatter(
    input.progressLevel === undefined ? {} : { level: input.progressLevel },
  );
  runInput.runner = createAcpRoleRunner({
    onProgress: (event) => {
      for (const line of progressFormatter.format(event)) {
        if (line.trim().length > 0) input.onProgressLine?.(line);
      }
    },
  });
  const result = await (input.runWorkspace ?? runWorkspaceIssueWithEngine)(runInput);
  const syncedResult = await syncLinearIssueWorkflowResult(input, result);
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
    ...(input.productId === undefined ? {} : { productId: input.productId }),
    ...(input.linearProject === undefined ? {} : { linearProject: input.linearProject }),
    ...(input.githubRepo === undefined ? {} : { githubRepo: input.githubRepo }),
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

const uniqueStrings = (values: readonly string[]): string[] => [...new Set(values)];

const createLinearReadyIssueSourceForTeams = (input: LinearWatchLoopCliInput): ReadyIssueSource => {
  const teamKeys = uniqueStrings(input.teamKeys ?? [input.teamKey]);
  if (teamKeys.length === 1 && teamKeys[0] === input.teamKey) {
    return createLinearWatchAdapters(input).source;
  }
  const sources = teamKeys.map(
    (teamKey) => createLinearWatchAdapters({ ...input, teamKey }).source,
  );
  return {
    listReadyIssues: async () => {
      const issueGroups = await Promise.all(sources.map((source) => source.listReadyIssues()));
      return issueGroups.flat();
    },
  };
};

const routeSuffix = (route?: WatchProductRoute): string =>
  route === undefined ? "" : ` product: ${route.productId} repo: ${route.githubRepo}`;

const formatWatchLoopEvent = (event: WatchLoopEvent): string | undefined => {
  if (event.type === "poll_started") return undefined;
  if (event.type === "issue_skipped") {
    return `Poll ${event.poll}: skipped ${event.issueKey} (${event.reason})`;
  }
  if (event.type === "poll_idle") return undefined;
  if (event.type === "issue_claimed") {
    return `Poll ${event.poll}: claimed ${event.issueKey} (ready issues: ${event.readyCount})${routeSuffix(event.selectedRoute)}`;
  }
  if (event.type === "claimed_issue_run_failed") {
    return `Poll ${event.poll}: run failed for ${event.issueKey}; restored status to ${event.restoredStatus}: ${event.error}`;
  }
  if (event.type === "issue_status_reconciled") {
    return `Poll ${event.poll}: reconciled ${event.issueKey} (${event.from} -> ${event.to})`;
  }
  if (event.type === "external_feedback_ingested") {
    return `Poll ${event.poll}: ingested ${event.source} feedback for ${event.issueKey} (${event.outcome})`;
  }
  if (event.type === "run_resumed") {
    return `Poll ${event.poll}: resumed ${event.issueId} (${event.outcome})`;
  }
  if (event.type === "run_resume_failed") {
    return `Poll ${event.poll}: resume failed for ${event.issueId}: ${event.error}`;
  }
  return `Stopped: ${event.reason} after ${event.polls} polls`;
};

const runResultStateLine = (output: string): string | undefined =>
  output
    .split("\n")
    .find((line) => line.startsWith("Final state:") || line.startsWith("Workflow state:"));

export const runLinearWatchLoopCli = async (input: LinearWatchLoopCliInput): Promise<string> => {
  const tracker = createLinearWatchAdapters(input).tracker;
  const source = createLinearReadyIssueSourceForTeams(input);
  const lines: string[] = [];
  const productRoutes = input.productRoutes ?? productRouteFromInput(input);

  const labels: ReconcileStatusLabels = input.reconcileLabels ?? {
    inReview: DEFAULT_ISSUE_STATUS_LABELS.inReview,
    done: DEFAULT_ISSUE_STATUS_LABELS.done,
    ready: input.readyStatus ?? "Todo",
  };
  const reconcile =
    input.codeHost === undefined || input.pullRequestTarget === undefined
      ? undefined
      : {
          listIssues: createLinearWatchAdapters({
            ...input,
            readyStatus: input.reviewStatus ?? labels.inReview,
          }).source.listReadyIssues,
          reconcileIssue: (issue: IssueRecord) =>
            reconcileIssueStatus({
              issueKey: issue.key,
              currentStatus: issue.status,
              branchName: issueBranchName(issue.key),
              target: input.pullRequestTarget!,
              findPullRequest: input.codeHost!.findPullRequestForBranch,
              tracker,
              labels,
            }),
          ...(input.runStatePath === undefined
            ? {}
            : {
                ingestExternalFeedback: (issue: IssueRecord) =>
                  ingestExternalReviewFeedback({
                    issueKey: issue.key,
                    branchName: issueBranchName(issue.key),
                    target: input.pullRequestTarget!,
                    codeHost: input.codeHost!,
                    store: createFileRunStore({ directory: input.runStatePath! }),
                    issue,
                    ...(input.reworkStatus === undefined
                      ? {}
                      : { reworkStatus: input.reworkStatus }),
                  }),
              }),
        };
  const emit = (line: string): void => {
    lines.push(line);
    input.onLine?.(line);
  };
  emit("Aigile watch: loop");
  emit("Provider: linear");
  if (input.productId !== undefined) emit(`Product: ${input.productId}`);
  if (input.linearProject !== undefined) emit(`Project: ${input.linearProject}`);
  emit(`Team: ${input.teamKey}`);
  for (const teamKey of uniqueStrings(input.teamKeys ?? []).filter(
    (team) => team !== input.teamKey,
  )) {
    emit(`Team: ${teamKey}`);
  }
  if (input.githubRepo !== undefined) emit(`GitHub repo: ${input.githubRepo}`);
  for (const route of input.productRoutes ?? []) {
    emit(`Product: ${route.productId}`);
    emit(`Project: ${route.linearProject}`);
    emit(`GitHub repo: ${route.githubRepo}`);
  }
  emit(`Poll interval: ${input.pollIntervalMs}ms`);
  emit("Polling for ready issues...");

  await watchLoop({
    source,
    tracker,
    pollIntervalMs: input.pollIntervalMs,
    ...(input.claimStatus === undefined ? {} : { claimStatus: input.claimStatus }),
    ...(reconcile === undefined ? {} : { reconcile }),
    ...(input.resume === undefined ? {} : { resume: input.resume }),
    ...(productRoutes === undefined ? {} : { productRoutes }),
    ...(input.maxPolls === undefined ? {} : { maxPolls: input.maxPolls }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
    onEvent: (event) => {
      const line = formatWatchLoopEvent(event);
      if (line !== undefined) emit(line);
    },
    ...(input.startRun === undefined
      ? {}
      : {
          onClaimedIssue: async (issue: IssueRecord, route?: WatchProductRoute) => {
            emit(`Run ${issue.key}: starting${routeSuffix(route)}`);
            const output = await input.startRun!(issue, route);
            const stateLine = runResultStateLine(output);
            if (stateLine !== undefined)
              emit(`Run ${issue.key}: ${stateLine}${routeSuffix(route)}`);
            emit(`Run ${issue.key}: completed${routeSuffix(route)}`);
          },
        }),
  });

  emit(input.startRun === undefined ? "Agents: not started" : "Agents: handled claimed issues");
  return lines.join("\n");
};

export interface ReconcileProductsCliInput {
  productConfig: RuntimeProductConfig;
  apiKey: string;
  labels?: ReconcileStatusLabels;
  createRunStore?: Parameters<typeof reconcileProducts>[0]["createRunStore"];
  createTracker?: (product: RuntimeProduct) => IssueTrackerAdapter | Promise<IssueTrackerAdapter>;
  createCodeHost?: (product: RuntimeProduct) => CodeHostAdapter | Promise<CodeHostAdapter>;
  cwd?: string;
  homeDir?: string;
}

const formatReconcileOutcome = (outcome: ReconcileProductOutcome): string => {
  const prefix =
    "issueKey" in outcome && outcome.issueKey !== undefined
      ? `${outcome.productId}/${outcome.issueKey}`
      : outcome.productId;
  switch (outcome.kind) {
    case "updated":
      return `- ${prefix}: updated ${outcome.from} -> ${outcome.to}`;
    case "unchanged":
      return `- ${prefix}: unchanged ${outcome.status}`;
    case "no_pull_request":
      return `- ${prefix}: no pull request`;
    case "blocked":
    case "blocked_unchanged":
      return `- ${prefix}: ${outcome.kind} ${outcome.state}`;
    case "failed":
      return `- ${prefix}: failed ${outcome.error}`;
  }
};

export const formatReconcileProductsResult = (
  outcomes: readonly ReconcileProductOutcome[],
): string =>
  [
    "Aigile reconcile: products",
    `Outcomes: ${outcomes.length}`,
    ...outcomes.map(formatReconcileOutcome),
  ].join("\n");

export const runReconcileProductsCli = async (
  input: ReconcileProductsCliInput,
): Promise<string> => {
  const result = await reconcileProducts({
    productConfig: input.productConfig,
    createTracker:
      input.createTracker ??
      ((product) =>
        createLinearGraphqlIssueTrackerAdapter({
          apiKey: input.apiKey,
          teamKey: product.linear.team,
        })),
    createCodeHost:
      input.createCodeHost ??
      ((product) => {
        const paths = resolveProductPaths(product, {
          cwd: input.cwd ?? process.cwd(),
          ...(input.homeDir === undefined ? {} : { homeDir: input.homeDir }),
        });
        return createGitHubCliCodeHostAdapter({
          cwd: paths.repoPath,
          exec: async (command, commandArgs, options) =>
            defaultExecCommand(command, commandArgs, { cwd: options.cwd ?? paths.repoPath }),
        });
      }),
    createRunStore:
      input.createRunStore ??
      ((product) =>
        createFileRunStore({
          directory: runStatePathForProduct(product, {
            cwd: input.cwd ?? process.cwd(),
            ...(input.homeDir === undefined ? {} : { homeDir: input.homeDir }),
          }),
        })),
    ...(input.labels === undefined ? {} : { labels: input.labels }),
    pathOptions: {
      cwd: input.cwd ?? process.cwd(),
      ...(input.homeDir === undefined ? {} : { homeDir: input.homeDir }),
    },
  });
  return formatReconcileProductsResult(result.outcomes);
};

export const runLinearWatchPreflightCli = async (
  input: LinearWatchPreflightCliInput,
): Promise<string> => {
  const fetchGraphql = input.fetchGraphql;
  const sharedOptions =
    fetchGraphql === undefined ? { apiKey: input.apiKey } : { apiKey: input.apiKey, fetchGraphql };
  const teams = await listLinearTeams(sharedOptions);
  const lines = [
    "Aigile watch: preflight",
    "Provider: linear",
    "Teams:",
    ...teams.map((team) => `- ${team.key} (${team.name})`),
  ];

  if (input.teamKey !== undefined) {
    const workflowStateOptions =
      fetchGraphql === undefined
        ? { apiKey: input.apiKey, teamKey: input.teamKey }
        : { apiKey: input.apiKey, teamKey: input.teamKey, fetchGraphql };
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

const resolveProgressLevel = (args: readonly string[]): ProgressLevel | undefined => {
  const quiet = args.includes("--quiet");
  const verbose = args.includes("--verbose");
  if (quiet && verbose) throw new Error("choose only one of --quiet or --verbose");
  if (quiet) return "quiet";
  if (verbose) return "verbose";
  return undefined;
};

export const parseCliArgs = (args: readonly string[]): CliArgs => {
  const progressLevel = resolveProgressLevel(args);
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
    const productsConfigPath = optionValue(args, "--products-config");
    const product = optionValue(args, "--product");
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
    if (productsConfigPath !== undefined) parsed.productsConfigPath = productsConfigPath;
    if (product !== undefined) parsed.product = product;
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
    if (args.includes("--retry-escalated")) parsed.retryEscalated = true;
    if (parsed.dryRun && parsed.agentWrite) {
      throw new Error("choose only one of --dry-run or --agent-write");
    }
    if (parsed.startRun) {
      if (parsed.pollIntervalMs === undefined)
        throw new Error("watch --start-run requires --poll-interval");
      if (parsed.runtimeConfigPath === undefined)
        throw new Error("watch --start-run requires --runtime-config");
      if (parsed.product === undefined && parsed.dryRun !== true && parsed.agentWrite !== true) {
        throw new Error("watch --start-run requires --dry-run or --agent-write");
      }
    }
    if (progressLevel !== undefined) parsed.progressLevel = progressLevel;
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
  if (args[0] === "reconcile") {
    const parsed: CliArgs = { mode: "reconcile" };
    const productsConfigPath = optionValue(args, "--products-config");
    const product = optionValue(args, "--product");
    const linearApiKeyEnv = optionValue(args, "--linear-api-key-env");
    if (productsConfigPath !== undefined) parsed.productsConfigPath = productsConfigPath;
    if (product !== undefined) parsed.product = product;
    if (linearApiKeyEnv !== undefined) parsed.linearApiKeyEnv = linearApiKeyEnv;
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
    const productsConfigPath = optionValue(args, "--products-config");
    const product = optionValue(args, "--product");
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
    if (productsConfigPath !== undefined) parsed.productsConfigPath = productsConfigPath;
    if (product !== undefined) parsed.product = product;
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
    if (args.includes("--retry-escalated")) parsed.retryEscalated = true;
    if (parsed.dryRun && parsed.agentWrite) {
      throw new Error("choose only one of --dry-run or --agent-write");
    }
    if (args.includes("--preflight-only")) parsed.preflightOnly = true;
    if (progressLevel !== undefined) parsed.progressLevel = progressLevel;
    return parsed;
  }
  const parsed: CliArgs = { mode: selectDemoMode(args) };
  const runtimeConfigPath = optionValue(args, "--runtime-config");
  if (runtimeConfigPath !== undefined) parsed.runtimeConfigPath = runtimeConfigPath;
  if (progressLevel !== undefined) parsed.progressLevel = progressLevel;
  return parsed;
};

export interface CliErrorSink {
  write: (chunk: string) => unknown;
}

export interface RunCliOptions {
  stderr?: CliErrorSink;
  setExitCode?: (code: number) => void;
}

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.length > 0) return oneLine(error.message);
  if (typeof error === "string" && error.length > 0) return oneLine(error);
  return "Unknown CLI failure";
};

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

const cliErrorHint = (error: unknown, message: string): string | undefined => {
  const missingApiKey = /\brequires ([A-Z0-9_]+) to be set\b/.exec(message);
  if (missingApiKey) {
    return `Set ${missingApiKey[1]} or pass --linear-api-key-env <name>.`;
  }
  if (
    errorCode(error) === "ENOENT" ||
    /product config not found|no such file or directory|runtime config|invalid config/i.test(
      message,
    )
  ) {
    return "Check the config path or pass --products-config/--runtime-config with an existing file.";
  }
  if (/publish preflight|gh auth|gh repo view|github repo|git remote get-url/i.test(message)) {
    return "Run gh auth status, gh auth login if needed, and verify the GitHub repo and remote.";
  }
  if (
    /requires an issue key|\bissue key\b|invalid issue|bad issue/i.test(message) &&
    !/artifact/i.test(message)
  ) {
    return "Pass an issue key such as LBE-123.";
  }
  if (/worktree|workspace|base branch|fast-forward|dirty/i.test(message)) {
    return "Run status for the issue, clean the worktree, or synchronize the base branch before retrying.";
  }
  return undefined;
};

export const formatCliError = (error: unknown): string => {
  const message = errorMessage(error);
  const hint = cliErrorHint(error, message);
  return hint === undefined ? message : `${message} ${hint}`;
};

export const runCli = async (
  runMain: () => Promise<void>,
  options: RunCliOptions = {},
): Promise<number> => {
  try {
    await runMain();
    return 0;
  } catch (error) {
    options.stderr?.write(`${formatCliError(error)}\n`);
    options.setExitCode?.(1);
    return 1;
  }
};

const isDemoCliMode = (mode: DemoMode): boolean =>
  mode !== "run" && mode !== "status" && mode !== "watch" && mode !== "reconcile";

const issueFromRunArgs = (
  args: CliArgs,
  issueKey: string,
  linearIssue: IssueRecord | undefined,
): IssueRecord => {
  const baseIssue: IssueRecord = linearIssue ?? {
    id: issueKey,
    key: issueKey,
    title: issueKey,
    description: "",
    acceptanceCriteria: [],
    status: "todo",
    priority: 0,
    comments: [],
  };
  return {
    ...baseIssue,
    key: issueKey,
    title: args.title ?? baseIssue.title,
    description: args.description ?? baseIssue.description,
    acceptanceCriteria: args.acceptanceCriteria ?? baseIssue.acceptanceCriteria,
  };
};

const runDevDemoCli = async (args: CliArgs): Promise<DemoResult> => {
  assertDemoCliEnabled();
  const demoIssue: IssueRecord = {
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
  if (args.mode === "agents") {
    if (args.runtimeConfigPath) {
      const runtimeConfig = loadRuntimeConfigFromJson(readFileSync(args.runtimeConfigPath, "utf8"));
      return runDemoIssueWithRoles({
        issue: demoIssue,
        registry: runtimeConfigToRegistry(runtimeConfig),
        runner: createAcpRoleRunner(),
        issueStatusLabels: runtimeConfig.issueStatusLabels,
      });
    }
    return runDemoIssueWithAcpRoles({ issue: demoIssue });
  }
  if (args.mode === "workspace") {
    return runDemoIssueWithWorkspace({
      issue: demoIssue,
      repoPath: "/tmp/aigile-demo-repo",
      worktreesPath: "/tmp/aigile-demo-repo/.worktrees",
      exec: async (command, args, options) => {
        if (command === "test" && args[0] === "-e") return { stdout: "", stderr: "", exitCode: 1 };
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
    });
  }
  if (args.mode === "github") {
    return runDemoIssueWithGitHub({
      issue: demoIssue,
      ghExec: async (_command, args) => {
        if (args[0] === "pr" && args[1] === "create") {
          return {
            stdout: "https://github.com/aigile/aigile/pull/1",
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "pr" && args[1] === "view" && args.at(-1) === "state,mergedAt") {
          return { stdout: JSON.stringify({ state: "OPEN" }), stderr: "", exitCode: 0 };
        }
        if (
          args[0] === "pr" &&
          args[1] === "view" &&
          args.at(-1) === "mergeable,mergeStateStatus"
        ) {
          return {
            stdout: JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
  }
  if (args.mode === "linear") {
    return runDemoIssueFromLinear({
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
    });
  }
  return runDemoIssue({ issue: demoIssue });
};

const main = async (): Promise<void> => {
  const args = parseCliArgs(process.argv.slice(2));
  if (isDemoCliMode(args.mode)) {
    const result = await runDevDemoCli(args);
    process.stdout.write(`${formatDemoResult(result)}\n`);
    return;
  }
  const runContext = args.mode === "run" ? resolveProductCliContext(args) : undefined;
  const linearApiKey = (command: "run" | "watch" | "reconcile"): string => {
    const apiKeyEnv = args.linearApiKeyEnv ?? "LINEAR_API_KEY";
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) throw new Error(`${command} --linear requires ${apiKeyEnv} to be set`);
    return apiKey;
  };
  if (args.mode === "status") {
    if (args.issueKey === undefined) throw new Error("status requires an issue key");
    const output = await runIssueWorkspaceStatus({
      issueKey: args.issueKey,
      repoPath: args.repoPath ?? process.cwd(),
      worktreesPath: args.worktreesPath ?? `${process.cwd()}/.worktrees`,
      baseBranch: args.baseBranch ?? "main",
    });
    process.stdout.write(`${output}\n`);
    return;
  }
  if (args.mode === "reconcile") {
    const productsConfigPath = args.productsConfigPath ?? "config/aigile.products.json";
    const loadedProductConfig = loadProductConfigFromFile(productsConfigPath);
    const productConfig =
      args.product === undefined
        ? loadedProductConfig
        : { products: [findProductConfig(loadedProductConfig, args.product)] };
    const output = await runReconcileProductsCli({
      productConfig,
      apiKey: linearApiKey("reconcile"),
    });
    process.stdout.write(`${output}\n`);
    return;
  }
  let workflowIssueKey = args.issueKey;
  if (args.mode === "run") {
    if (workflowIssueKey === undefined) throw new Error("run requires an issue key");
  } else {
    workflowIssueKey ??= "LOCAL-WATCH";
  }
  const linearIssue =
    args.mode === "run" &&
    args.linear &&
    args.preflightOnly !== true &&
    args.runtimeConfigPath === undefined
      ? await (async (): Promise<IssueRecord> => {
          return fetchLinearIssueForRun({
            apiKey: linearApiKey("run"),
            issueKey: workflowIssueKey,
          });
        })()
      : undefined;
  const runInput: DemoWorkspaceInput = {
    issue: issueFromRunArgs(args, workflowIssueKey, linearIssue),
    repoPath: runContext?.repoPath ?? args.repoPath ?? process.cwd(),
    worktreesPath: runContext?.worktreesPath ?? args.worktreesPath ?? `${process.cwd()}/.worktrees`,
  };
  if (runContext !== undefined) runInput.baseBranch = runContext.baseBranch;
  else if (args.baseBranch !== undefined) runInput.baseBranch = args.baseBranch;
  if (args.mode === "watch") {
    const watchContexts = resolveProductCliContexts(args);
    const watchContext = watchContexts[0];
    if (watchContext === undefined) throw new Error("watch requires at least one product route");
    const watchProductRoutes = watchContexts
      .filter(
        (
          context,
        ): context is ResolvedProductCliContext & {
          productId: string;
          linearProject: string;
          githubRepo: string;
        } =>
          context.productId !== undefined &&
          context.linearProject !== undefined &&
          context.githubRepo !== undefined,
      )
      .map((context) => ({
        productId: context.productId,
        linearProject: context.linearProject,
        githubRepo: context.githubRepo,
      }));
    const watchTeamKeys = uniqueStrings(
      watchContexts
        .map((context) => context.linearTeam)
        .filter((teamKey): teamKey is string => teamKey !== undefined),
    );
    if (args.preflightOnly) {
      if (!args.linear) throw new Error("watch --preflight requires --linear");
      const apiKeyEnv = args.linearApiKeyEnv ?? "LINEAR_API_KEY";
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) throw new Error(`watch --linear requires ${apiKeyEnv} to be set`);
      const preflightInput: LinearWatchPreflightCliInput = { apiKey };
      if (watchContext.linearTeam !== undefined) preflightInput.teamKey = watchContext.linearTeam;
      const output = await runLinearWatchPreflightCli(preflightInput);
      process.stdout.write(`${output}\n`);
      return;
    }
    if (args.linear) {
      if (watchTeamKeys.length === 0)
        throw new Error("watch --linear requires --linear-team, --product, or --products-config");
      const apiKeyEnv = args.linearApiKeyEnv ?? "LINEAR_API_KEY";
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) throw new Error(`watch --linear requires ${apiKeyEnv} to be set`);
      if (args.pollIntervalMs !== undefined) {
        const controller = new AbortController();
        process.once("SIGINT", () => controller.abort());
        const loopInput: LinearWatchLoopCliInput = {
          apiKey,
          teamKey: watchTeamKeys[0]!,
          teamKeys: watchTeamKeys,
          pollIntervalMs: args.pollIntervalMs,
          signal: controller.signal,
          onLine: (line) => process.stdout.write(`${line}\n`),
        };
        if (watchContexts.length === 1) {
          if (watchContext.productId !== undefined) loopInput.productId = watchContext.productId;
          if (watchContext.linearProject !== undefined)
            loopInput.linearProject = watchContext.linearProject;
          if (watchContext.githubRepo !== undefined) loopInput.githubRepo = watchContext.githubRepo;
        } else if (watchProductRoutes.length > 0) {
          loopInput.productRoutes = watchProductRoutes;
        }
        if (args.readyStatus !== undefined) loopInput.readyStatus = args.readyStatus;
        if (args.claimStatus !== undefined) loopInput.claimStatus = args.claimStatus;
        if (args.maxPolls !== undefined) loopInput.maxPolls = args.maxPolls;
        if (watchContexts.some((context) => context.startRun)) {
          if (args.runtimeConfigPath === undefined)
            throw new Error("watch --start-run requires --runtime-config");
          if (
            watchContexts.some(
              (context) =>
                context.startRun && context.dryRun !== true && context.agentWrite !== true,
            )
          ) {
            throw new Error("watch --start-run requires --dry-run or --agent-write");
          }
          const publishRunInputs = new Map<
            string,
            Pick<
              LinearIssueWorkflowCliInput,
              "publish" | "remote" | "pullRequestTarget" | "codeHost"
            >
          >();
          const createPublishRunInput = async (
            context: ResolvedProductCliContext,
          ): Promise<
            Pick<
              LinearIssueWorkflowCliInput,
              "publish" | "remote" | "pullRequestTarget" | "codeHost"
            >
          > => {
            const publishRunInput: Pick<
              LinearIssueWorkflowCliInput,
              "publish" | "remote" | "pullRequestTarget" | "codeHost"
            > = {};
            if (context.publish === true && context.dryRun !== true) {
              const remote = args.remote ?? "origin";
              const publishPreflightInput: PublishPreflightInput = {
                repoPath: context.repoPath,
                remote,
                baseBranch: context.baseBranch,
              };
              if (context.githubRepo !== undefined)
                publishPreflightInput.githubRepo = context.githubRepo;
              const publishPreflight = await runPublishPreflight(publishPreflightInput);
              const [owner, repo] = publishPreflight.githubRepo.split("/");
              if (!owner || !repo) throw new Error("--github-repo must be in owner/repo format");
              publishRunInput.publish = true;
              publishRunInput.remote = remote;
              publishRunInput.pullRequestTarget = {
                owner,
                repo,
                baseBranch: context.baseBranch,
              };
              publishRunInput.codeHost = createGitHubCliCodeHostAdapter({
                cwd: context.repoPath,
                exec: async (command, commandArgs, options) =>
                  defaultExecCommand(command, commandArgs, { cwd: options.cwd ?? process.cwd() }),
              });
            } else if (context.publish === true) {
              publishRunInput.publish = true;
              publishRunInput.remote = args.remote ?? "origin";
              if (context.githubOwner !== undefined && context.githubRepository !== undefined) {
                publishRunInput.pullRequestTarget = {
                  owner: context.githubOwner,
                  repo: context.githubRepository,
                  baseBranch: context.baseBranch,
                };
              }
            }
            return publishRunInput;
          };
          for (const context of watchContexts) {
            publishRunInputs.set(context.productId ?? "", await createPublishRunInput(context));
          }
          const runStatePathForContext = (context: ResolvedProductCliContext): string =>
            join(context.worktreesPath, "..", "runs");
          const primaryRunStatePath = runStatePathForContext(watchContext);
          const primaryPublishRunInput = publishRunInputs.get(watchContext.productId ?? "") ?? {};
          loopInput.runStatePath = primaryRunStatePath;
          const contextForRoute = (route?: WatchProductRoute): ResolvedProductCliContext => {
            if (route === undefined) return watchContext;
            return (
              watchContexts.find((context) => context.productId === route.productId) ?? watchContext
            );
          };
          const runIssueByKey = (
            issueKey: string,
            route?: WatchProductRoute,
            options: { retryEscalated?: boolean } = {},
          ): Promise<string> => {
            const context = contextForRoute(route);
            return runLinearIssueWorkflowCli({
              apiKey,
              issueKey,
              ...(context.linearTeam === undefined ? {} : { teamKey: context.linearTeam }),
              repoPath: context.repoPath,
              worktreesPath: context.worktreesPath,
              runtimeConfigPath: args.runtimeConfigPath!,
              baseBranch: context.baseBranch,
              runStatePath: runStatePathForContext(context),
              ...(context.dryRun === true ? { dryRun: true } : {}),
              ...(context.agentWrite === true ? { agentWrite: true } : {}),
              ...(context.verification === undefined ? {} : { verification: context.verification }),
              ...(options.retryEscalated === true ? { retryEscalated: true } : {}),
              ...(args.progressLevel === undefined ? {} : { progressLevel: args.progressLevel }),
              ...(publishRunInputs.get(context.productId ?? "") ?? {}),
              onProgressLine: (line) => process.stderr.write(`${line}\n`),
            });
          };
          loopInput.startRun = async (issue, route) =>
            runIssueByKey(issue.key, route, { retryEscalated: true });
          // Resume interrupted/paused runs from the persisted run log each poll.
          const runStore = createFileRunStore({ directory: primaryRunStatePath });
          loopInput.resume = {
            listResumable: () => listResumableRuns(runStore),
            resumeRun: async (issueId) => {
              const output = await runIssueByKey(issueId);
              return { outcome: runResultStateLine(output) ?? "resumed" };
            },
          };
          // Reconcile in-flight issue status from PR state when publishing is configured.
          if (
            primaryPublishRunInput.codeHost !== undefined &&
            primaryPublishRunInput.pullRequestTarget !== undefined
          ) {
            loopInput.codeHost = primaryPublishRunInput.codeHost;
            loopInput.pullRequestTarget = {
              owner: primaryPublishRunInput.pullRequestTarget.owner,
              repo: primaryPublishRunInput.pullRequestTarget.repo,
            };
          }
        }
        await runLinearWatchLoopCli(loopInput);
        return;
      }
      const linearInput: LinearWatchOnceCliInput = {
        apiKey,
        teamKey: watchTeamKeys[0]!,
      };
      if (watchContext.productId !== undefined) linearInput.productId = watchContext.productId;
      if (watchContext.linearProject !== undefined)
        linearInput.linearProject = watchContext.linearProject;
      if (watchContext.githubRepo !== undefined) linearInput.githubRepo = watchContext.githubRepo;
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
      issueKey: workflowIssueKey,
      repoPath: runContext?.repoPath ?? args.repoPath ?? process.cwd(),
      worktreesPath:
        runContext?.worktreesPath ?? args.worktreesPath ?? `${process.cwd()}/.worktrees`,
      baseBranch: runContext?.baseBranch ?? args.baseBranch ?? "main",
    };
    if (runContext?.publish !== undefined) preflightInput.publish = runContext.publish;
    else if (args.publish !== undefined) preflightInput.publish = args.publish;
    if (runContext?.githubRepo !== undefined) preflightInput.githubRepo = runContext.githubRepo;
    else if (args.githubRepo !== undefined) preflightInput.githubRepo = args.githubRepo;
    if (args.remote !== undefined) preflightInput.remote = args.remote;
    const output = await runRunModePreflight(preflightInput);
    process.stdout.write(`${output}\n`);
    return;
  }
  if (args.mode === "run" && args.linear && args.runtimeConfigPath !== undefined) {
    if (runContext?.dryRun !== true && runContext?.agentWrite !== true) {
      throw new Error("run with --runtime-config requires --dry-run or --agent-write");
    }
    const publishRunInput: Pick<
      LinearIssueWorkflowCliInput,
      "publish" | "remote" | "pullRequestTarget" | "codeHost"
    > = {};
    if (runContext?.publish === true && runContext.dryRun !== true) {
      const remote = args.remote ?? "origin";
      const publishPreflightInput: PublishPreflightInput = {
        repoPath: runContext.repoPath,
        remote,
        baseBranch: runContext.baseBranch,
      };
      if (runContext.githubRepo !== undefined)
        publishPreflightInput.githubRepo = runContext.githubRepo;
      const publishPreflight = await runPublishPreflight(publishPreflightInput);
      const [owner, repo] = publishPreflight.githubRepo.split("/");
      if (!owner || !repo) throw new Error("--github-repo must be in owner/repo format");
      publishRunInput.publish = true;
      publishRunInput.remote = remote;
      publishRunInput.pullRequestTarget = {
        owner,
        repo,
        baseBranch: runContext.baseBranch,
      };
      publishRunInput.codeHost = createGitHubCliCodeHostAdapter({
        cwd: runContext.repoPath,
        exec: async (command, commandArgs, options) =>
          defaultExecCommand(command, commandArgs, { cwd: options.cwd ?? process.cwd() }),
      });
    } else if (runContext?.publish === true) {
      publishRunInput.publish = true;
      publishRunInput.remote = args.remote ?? "origin";
      if (runContext.githubOwner !== undefined && runContext.githubRepository !== undefined) {
        publishRunInput.pullRequestTarget = {
          owner: runContext.githubOwner,
          repo: runContext.githubRepository,
          baseBranch: runContext.baseBranch,
        };
      }
    }
    const output = await runLinearIssueWorkflowCli({
      apiKey: linearApiKey("run"),
      issueKey: workflowIssueKey,
      ...(runContext?.linearTeam === undefined ? {} : { teamKey: runContext.linearTeam }),
      repoPath: runContext?.repoPath ?? args.repoPath ?? process.cwd(),
      worktreesPath:
        runContext?.worktreesPath ?? args.worktreesPath ?? `${process.cwd()}/.worktrees`,
      runtimeConfigPath: args.runtimeConfigPath,
      ...(runContext?.baseBranch === undefined ? {} : { baseBranch: runContext.baseBranch }),
      ...(runContext?.dryRun === true ? { dryRun: true } : {}),
      ...(runContext?.agentWrite === true ? { agentWrite: true } : {}),
      ...(runContext?.verification === undefined ? {} : { verification: runContext.verification }),
      ...(args.retryEscalated === true ? { retryEscalated: true } : {}),
      ...(args.progressLevel === undefined ? {} : { progressLevel: args.progressLevel }),
      runStatePath: join(
        runContext?.worktreesPath ?? args.worktreesPath ?? `${process.cwd()}/.worktrees`,
        "..",
        "runs",
      ),
      ...publishRunInput,
      onProgressLine: (line) => process.stderr.write(`${line}\n`),
    });
    process.stdout.write(`${output}\n`);
    return;
  }
  if (runContext?.verification !== undefined) {
    const verificationCommands = [
      ...(runContext.verification.install ?? []),
      ...(runContext.verification.checks ?? []),
    ];
    if (verificationCommands.length > 0) runInput.verificationCommands = verificationCommands;
    if (runContext.verification.changedFileGuards !== undefined) {
      runInput.changedFileGuards = runContext.verification.changedFileGuards;
    }
  }
  if (runContext?.dryRun === true || args.dryRun) {
    runInput.dryRun = true;
    runInput.exec = createDryRunExec();
  }
  if (
    args.mode === "run" &&
    args.runtimeConfigPath &&
    !args.preflightOnly &&
    runContext?.dryRun !== true &&
    runContext?.agentWrite !== true
  ) {
    throw new Error("run with --runtime-config requires --dry-run or --agent-write");
  }
  if (args.mode === "run" && runContext?.agentWrite === true && runContext.publish !== true) {
    runInput.createPullRequest = false;
  }
  if (args.mode === "run" && runContext?.publish === true && runContext.dryRun !== true) {
    const remote = args.remote ?? "origin";
    const publishPreflightInput: PublishPreflightInput = {
      repoPath: runContext.repoPath,
      remote,
      baseBranch: runContext.baseBranch,
    };
    if (runContext.githubRepo !== undefined)
      publishPreflightInput.githubRepo = runContext.githubRepo;
    const publishPreflight = await runPublishPreflight(publishPreflightInput);
    const [owner, repo] = publishPreflight.githubRepo.split("/");
    if (!owner || !repo) throw new Error("--github-repo must be in owner/repo format");
    runInput.publish = true;
    runInput.remote = remote;
    runInput.pullRequestTarget = {
      owner,
      repo,
      baseBranch: runContext.baseBranch,
    };
    runInput.codeHost = createGitHubCliCodeHostAdapter({
      cwd: runContext.repoPath,
      exec: async (command, commandArgs, options) =>
        defaultExecCommand(command, commandArgs, { cwd: options.cwd ?? process.cwd() }),
    });
  }
  if (args.mode === "run" && args.runtimeConfigPath) {
    const runtimeConfig = loadRuntimeConfigFromJson(readFileSync(args.runtimeConfigPath, "utf8"));
    runInput.registry = runtimeConfigToRegistry(runtimeConfig);
    runInput.issueStatusLabels = runtimeConfig.issueStatusLabels;
    const progressFormatter = createAcpRoleProgressFormatter(
      args.progressLevel === undefined ? {} : { level: args.progressLevel },
    );
    runInput.runner = createAcpRoleRunner({
      onProgress: (event) => {
        for (const line of progressFormatter.format(event)) {
          if (line.trim().length > 0) process.stderr.write(`${line}\n`);
        }
      },
    });
  }
  if (args.mode === "run" && args.retryEscalated === true) runInput.retryEscalated = true;
  const result = await runWorkspaceIssueWithEngine(runInput);
  process.stdout.write(`${formatDemoResult(result)}\n`);
};

if (import.meta.path === Bun.main) {
  await runCli(main, {
    stderr: process.stderr,
    setExitCode: (code) => {
      process.exitCode = code;
    },
  });
}
