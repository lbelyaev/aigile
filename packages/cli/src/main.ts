#!/usr/bin/env bun
import {
  runDemoIssue,
  runDemoIssueFromLinear,
  runDemoIssueWithAcpRoles,
  runDemoIssueWithGitHub,
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

export type DemoMode = "scripted" | "agents" | "workspace" | "github" | "linear";

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
      : mode === "github"
        ? await runDemoIssueWithGitHub({
          issue: defaultIssue,
          ghExec: async (_command, args) => {
            if (args[0] === "pr" && args[1] === "create") {
              return { stdout: "https://github.com/aigile/aigile/pull/1", stderr: "", exitCode: 0 };
            }
            return { stdout: "", stderr: "", exitCode: 0 };
          },
        })
        : mode === "linear"
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
