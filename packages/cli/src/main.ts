#!/usr/bin/env bun
import {
  runDemoIssue,
  runDemoIssueWithAcpRoles,
  runDemoIssueWithWorkspace,
  type DemoResult,
} from "@aigile/demo";
import type { IssueRecord } from "@aigile/adapters";

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

export type DemoMode = "scripted" | "agents" | "workspace";

export const selectDemoMode = (args: readonly string[]): DemoMode =>
  args.includes("demo:agents") || args.includes("--agents")
    ? "agents"
    : args.includes("demo:workspace") || args.includes("--workspace")
      ? "workspace"
      : "scripted";

const main = async (): Promise<void> => {
  const mode = selectDemoMode(process.argv.slice(2));
  const result = mode === "agents"
    ? await runDemoIssueWithAcpRoles({ issue: defaultIssue })
    : mode === "workspace"
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
      : await runDemoIssue({ issue: defaultIssue });
  process.stdout.write(`${formatDemoResult(result)}\n`);
};

if (import.meta.path === Bun.main) {
  await main();
}
