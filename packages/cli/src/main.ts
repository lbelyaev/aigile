#!/usr/bin/env bun
import { readFileSync } from "node:fs";
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

export const formatDemoResult = (result: DemoResult): string => [
  `Aigile demo run: ${result.issueKey}`,
  `Final state: ${result.finalState}`,
  `Pull request: ${result.pullRequest.url}`,
  "",
  "Timeline:",
  ...result.timeline.map((entry) => `- ${entry}`),
  "",
  "Artifacts:",
  ...result.artifacts.map((artifact) => `- ${artifact.kind}: ${artifact.id}`),
].join("\n");

export const formatAcpRoleProgress = (event: AcpRoleProgressEvent): string => {
  const prefix = `[${event.issueId} ${event.roleId}]`;
  if (event.type === "role_started") return `${prefix} starting ${event.runtimeId}`;
  if (event.type === "runtime_connecting") return `${prefix} connecting ${event.runtimeId}`;
  if (event.type === "runtime_connected") {
    return `${prefix} connected ${event.runtimeId} session ${event.acpSessionId}`;
  }
  if (event.type === "runtime_stderr") return `${prefix} stderr: ${event.chunk.trimEnd()}`;
  if (event.type === "prompt_started") return `${prefix} prompt sent`;
  if (event.type === "text_delta") return `${prefix} text: ${event.delta.trimEnd()}`;
  if (event.type === "thinking_delta") return `${prefix} thinking`;
  if (event.type === "tool_start") return `${prefix} tool started: ${event.tool}`;
  if (event.type === "tool_end") return `${prefix} tool finished: ${event.tool}`;
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
  dryRun?: boolean;
}

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
    if (title !== undefined) parsed.title = title;
    if (description !== undefined) parsed.description = description;
    if (acceptanceCriteria.length > 0) parsed.acceptanceCriteria = acceptanceCriteria;
    if (runtimeConfigPath !== undefined) parsed.runtimeConfigPath = runtimeConfigPath;
    if (repoPath !== undefined) parsed.repoPath = repoPath;
    if (worktreesPath !== undefined) parsed.worktreesPath = worktreesPath;
    if (args.includes("--dry-run")) parsed.dryRun = true;
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
  if (args.dryRun) {
    runInput.exec = async (command, commandArgs, options) => {
      if (command === "git" && commandArgs[0] === "diff") {
        return { stdout: "dry-run diff | 1 +", stderr: "", exitCode: 0 };
      }
      return { stdout: `${command} ${commandArgs.join(" ")} in ${options.cwd}`, stderr: "", exitCode: 0 };
    };
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
