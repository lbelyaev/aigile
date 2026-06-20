import { describe, expect, it } from "bun:test";
import { runDemoIssueWithGitHub } from "./index.js";

describe("GitHub demo orchestration", () => {
  it("uses the GitHub code host adapter for PR convergence", async () => {
    const ghCalls: string[][] = [];
    const result = await runDemoIssueWithGitHub({
      issue: {
        id: "issue-1",
        key: "LIN-123",
        title: "Open GitHub PR",
        description: "Exercise GitHub adapter flow.",
        acceptanceCriteria: ["PR exists"],
        status: "todo",
        priority: 1,
        comments: [],
      },
      ghExec: async (_command, args) => {
        ghCalls.push([...args]);
        if (args[0] === "pr" && args[1] === "create") {
          return { stdout: "https://github.com/aigile/aigile/pull/99", stderr: "", exitCode: 0 };
        }
        if (args[0] === "pr" && args[1] === "view" && args.at(-1) === "state,merged,mergedAt") {
          return {
            stdout: JSON.stringify({ state: "OPEN", merged: false }),
            stderr: "",
            exitCode: 0,
          };
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

    expect(result.pullRequest?.url).toBe("https://github.com/aigile/aigile/pull/99");
    expect(result.artifacts.at(-1)).toMatchObject({
      id: "github-pr:aigile/aigile#99",
      kind: "github.pull_request",
      source: "github",
    });
    expect(ghCalls.some((args) => args[0] === "pr" && args[1] === "create")).toBe(true);
    expect(ghCalls.some((args) => args[0] === "pr" && args[1] === "comment")).toBe(true);
  });
});
