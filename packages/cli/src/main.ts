#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { createGitHubCliCodeHostAdapter } from "@aigile/adapters";
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
} from "@aigile/demo";
import type { IssueRecord } from "@aigile/adapters";
import { createAcpRoleRunner, type AcpRoleProgressEvent } from "@aigile/roles";
import { createGitWorkspaceAdapter, defaultExecCommand, type ExecCommand, type ExecResult } from "@aigile/workspace";

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
  if (!policy || typeof policy.payload !== "object" || policy.payload === null || Array.isArray(policy.payload)) {
    return undefined;
  }
  const mode = (policy.payload as { mode?: unknown }).mode;
  return typeof mode === "string" && mode.length > 0 ? mode : undefined;
};

export const formatDemoResult = (result: DemoResult): string => {
  const mode = executionPolicyMode(result);
  const isDryRun = mode === "dry_run";
  return [
    `Aigile demo run: ${result.issueKey}`,
    ...(mode === undefined ? [] : [`Mode: ${isDryRun ? "dry_run (simulated)" : mode}`]),
    `Final state: ${result.finalState}`,
    `Pull request: ${isDryRun ? "simulated " : ""}${result.pullRequest.url}`,
    "",
    "Timeline:",
    ...result.timeline.map((entry) => `- ${entry}`),
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

export type DemoMode = "scripted" | "agents" | "workspace" | "github" | "linear" | "run";

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
  preflightOnly?: boolean;
}

export interface PublishPreflightInput {
  repoPath: string;
  githubRepo: string;
  remote: string;
  baseBranch: string;
  exec?: ExecCommand;
}

const assertPreflightSuccess = (result: ExecResult, operation: string): void => {
  if (result.exitCode !== 0) {
    throw new Error(`publish preflight ${operation} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }
};

export const runPublishPreflight = async (input: PublishPreflightInput): Promise<void> => {
  const exec = input.exec ?? defaultExecCommand;
  assertPreflightSuccess(
    await exec("gh", ["auth", "status"], { cwd: input.repoPath }),
    "gh auth status",
  );
  assertPreflightSuccess(
    await exec("gh", ["repo", "view", input.githubRepo, "--json", "name"], { cwd: input.repoPath }),
    `gh repo view ${input.githubRepo}`,
  );
  assertPreflightSuccess(
    await exec("git", ["remote", "get-url", input.remote], { cwd: input.repoPath }),
    `git remote get-url ${input.remote}`,
  );
  assertPreflightSuccess(
    await exec("git", ["rev-parse", "--verify", input.baseBranch], { cwd: input.repoPath }),
    `git rev-parse --verify ${input.baseBranch}`,
  );
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
    if (!input.githubRepo) throw new Error("--publish requires --github-repo owner/repo");
    const [owner, repo] = input.githubRepo.split("/");
    if (!owner || !repo) throw new Error("--github-repo must be in owner/repo format");
    const remote = input.remote ?? "origin";
    await runPublishPreflight({
      repoPath: input.repoPath,
      githubRepo: input.githubRepo,
      remote,
      baseBranch: input.baseBranch,
      exec,
    });
    publishLine = `Publish: ready ${input.githubRepo} via ${remote} -> ${input.baseBranch}`;
  }

  return [
    `Aigile preflight: ${input.issueKey}`,
    `Workspace: available ${workspace.worktreePath} on ${workspace.branchName} from ${workspace.baseBranch}`,
    publishLine,
    "Agents: not started",
  ].join("\n");
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
  return { stdout: `${command} ${commandArgs.join(" ")} in ${options.cwd}`, stderr: "", exitCode: 0 };
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

export const parseCliArgs = (args: readonly string[]): CliArgs => {
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
    if (title !== undefined) parsed.title = title;
    if (description !== undefined) parsed.description = description;
    if (acceptanceCriteria.length > 0) parsed.acceptanceCriteria = acceptanceCriteria;
    if (runtimeConfigPath !== undefined) parsed.runtimeConfigPath = runtimeConfigPath;
    if (repoPath !== undefined) parsed.repoPath = repoPath;
    if (worktreesPath !== undefined) parsed.worktreesPath = worktreesPath;
    if (baseBranch !== undefined) parsed.baseBranch = baseBranch;
    if (remote !== undefined) parsed.remote = remote;
    if (githubRepo !== undefined) parsed.githubRepo = githubRepo;
    if (args.includes("--publish")) parsed.publish = true;
    if (args.includes("--dry-run")) parsed.dryRun = true;
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
  const runInput: DemoWorkspaceInput = {
    issue: {
      ...defaultIssue,
      key: args.issueKey ?? defaultIssue.key,
      title: args.title ?? defaultIssue.title,
      description: args.description ?? defaultIssue.description,
      acceptanceCriteria: args.acceptanceCriteria ?? defaultIssue.acceptanceCriteria,
    },
    repoPath: args.repoPath ?? process.cwd(),
    worktreesPath: args.worktreesPath ?? `${process.cwd()}/.worktrees`,
  };
  if (args.baseBranch !== undefined) runInput.baseBranch = args.baseBranch;
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
  if (args.mode === "run" && args.publish && !args.dryRun) {
    if (!args.githubRepo) throw new Error("--publish requires --github-repo owner/repo");
    const [owner, repo] = args.githubRepo.split("/");
    if (!owner || !repo) throw new Error("--github-repo must be in owner/repo format");
    const remote = args.remote ?? "origin";
    const baseBranch = args.baseBranch ?? "main";
    await runPublishPreflight({
      repoPath: args.repoPath ?? process.cwd(),
      githubRepo: args.githubRepo,
      remote,
      baseBranch,
    });
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
    runInput.registry = runtimeConfigToRegistry(loadRuntimeConfigFromJson(readFileSync(args.runtimeConfigPath, "utf8")));
    runInput.runner = createAcpRoleRunner({
      onProgress: (event) => {
        const line = formatAcpRoleProgress(event);
        if (line.trim().length > 0) process.stderr.write(`${line}\n`);
      },
    });
  }
  const result = args.mode === "run"
    ? await runDemoIssueWithWorkspace(runInput)
    : args.mode === "agents"
    ? args.runtimeConfigPath
      ? await runDemoIssueWithRoles({
        issue: defaultIssue,
        registry: runtimeConfigToRegistry(loadRuntimeConfigFromJson(readFileSync(args.runtimeConfigPath, "utf8"))),
        runner: createAcpRoleRunner(),
      })
      : await runDemoIssueWithAcpRoles({ issue: defaultIssue })
    : args.mode === "workspace"
      ? await runDemoIssueWithWorkspace({
        issue: defaultIssue,
        repoPath: "/tmp/aigile-demo-repo",
        worktreesPath: "/tmp/aigile-demo-repo/.worktrees",
        exec: async (command, args, options) => {
          if (command === "git" && args[0] === "worktree") return { stdout: "", stderr: "", exitCode: 0 };
          if (command === "git" && args[0] === "diff") {
            return { stdout: "packages/demo/src/run.ts | 4 ++++", stderr: "", exitCode: 0 };
          }
          return { stdout: `${command} ${args.join(" ")} in ${options.cwd}`, stderr: "", exitCode: 0 };
        },
      })
      : args.mode === "github"
        ? await runDemoIssueWithGitHub({
          issue: defaultIssue,
          ghExec: async (_command, args) => {
            if (args[0] === "pr" && args[1] === "create") {
              return { stdout: "https://github.com/aigile/aigile/pull/1", stderr: "", exitCode: 0 };
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
                description: "Acceptance:\n- Architect plan exists\n- Verifier passes\n- Pull request artifact exists",
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
