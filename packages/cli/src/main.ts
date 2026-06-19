#!/usr/bin/env bun
import { runDemoIssue, runDemoIssueWithAcpRoles, type DemoResult } from "@aigile/demo";
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

export type DemoMode = "scripted" | "agents";

export const selectDemoMode = (args: readonly string[]): DemoMode =>
  args.includes("demo:agents") || args.includes("--agents") ? "agents" : "scripted";

const main = async (): Promise<void> => {
  const mode = selectDemoMode(process.argv.slice(2));
  const result = mode === "agents"
    ? await runDemoIssueWithAcpRoles({ issue: defaultIssue })
    : await runDemoIssue({ issue: defaultIssue });
  process.stdout.write(`${formatDemoResult(result)}\n`);
};

if (import.meta.path === Bun.main) {
  await main();
}
