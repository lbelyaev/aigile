import { describe, expect, it } from "bun:test";
import { createGitHubCliCodeHostAdapter } from "./index.js";

describe("GitHub CLI code host adapter", () => {
  it("creates a draft pull request with gh", async () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const adapter = createGitHubCliCodeHostAdapter({
      cwd: "/repo/aigile",
      exec: async (command, args, options) => {
        calls.push(options.cwd === undefined
          ? { command, args: [...args] }
          : { command, args: [...args], cwd: options.cwd });
        return {
          stdout: "https://github.com/aigile/aigile/pull/42\n",
          stderr: "",
          exitCode: 0,
        };
      },
    });

    const pr = await adapter.createPullRequest({
      owner: "aigile",
      repo: "aigile",
      branch: "aigile/LIN-123",
      baseBranch: "main",
      title: "LIN-123 Build workflow",
      body: "PR body",
    });

    expect(pr).toMatchObject({
      id: "aigile/aigile#42",
      number: 42,
      url: "https://github.com/aigile/aigile/pull/42",
      comments: [],
      checks: [],
      reviews: [],
    });
    expect(calls[0]).toEqual({
      command: "gh",
      cwd: "/repo/aigile",
      args: [
        "pr",
        "create",
        "--repo",
        "aigile/aigile",
        "--head",
        "aigile/LIN-123",
        "--base",
        "main",
        "--title",
        "LIN-123 Build workflow",
        "--body",
        "PR body",
        "--draft",
      ],
    });
  });

  it("records comments and check results as PR comments", async () => {
    const calls: string[][] = [];
    const adapter = createGitHubCliCodeHostAdapter({
      exec: async (_command, args) => {
        calls.push([...args]);
        if (args[0] === "pr" && args[1] === "create") {
          return { stdout: "https://github.com/aigile/aigile/pull/7", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const pr = await adapter.createPullRequest({
      owner: "aigile",
      repo: "aigile",
      branch: "aigile/LIN-123",
      baseBranch: "main",
      title: "LIN-123 Build workflow",
      body: "PR body",
    });

    await adapter.appendPullRequestComment(pr.id, "Verifier passed");
    await adapter.recordCheckResult(pr.id, {
      name: "aigile/verifier",
      status: "passed",
      summary: "All good",
    });

    expect(await adapter.getPullRequest(pr.id)).toMatchObject({
      comments: ["Verifier passed"],
      checks: [{ name: "aigile/verifier", status: "passed", summary: "All good" }],
    });
    expect(calls).toContainEqual([
      "pr",
      "comment",
      "7",
      "--repo",
      "aigile/aigile",
      "--body",
      "Verifier passed",
    ]);
    expect(calls).toContainEqual([
      "pr",
      "comment",
      "7",
      "--repo",
      "aigile/aigile",
      "--body",
      "### aigile/verifier: passed\n\nAll good",
    ]);
  });

  it("submits approve, request-changes, and comment reviews with gh", async () => {
    const calls: string[][] = [];
    const adapter = createGitHubCliCodeHostAdapter({
      exec: async (_command, args) => {
        calls.push([...args]);
        if (args[0] === "pr" && args[1] === "create") {
          return { stdout: "https://github.com/aigile/aigile/pull/9", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const pr = await adapter.createPullRequest({
      owner: "aigile",
      repo: "aigile",
      branch: "aigile/LIN-123",
      baseBranch: "main",
      title: "LIN-123 Build workflow",
      body: "PR body",
    });

    await adapter.submitPullRequestReview(pr.id, {
      event: "approve",
      body: "Checker passed",
    });
    await adapter.submitPullRequestReview(pr.id, {
      event: "request_changes",
      body: "Checker requested changes",
    });
    await adapter.submitPullRequestReview(pr.id, {
      event: "comment",
      body: "Checker escalated",
    });

    expect(calls).toContainEqual([
      "pr",
      "review",
      "9",
      "--repo",
      "aigile/aigile",
      "--approve",
      "--body",
      "Checker passed",
    ]);
    expect(calls).toContainEqual([
      "pr",
      "review",
      "9",
      "--repo",
      "aigile/aigile",
      "--request-changes",
      "--body",
      "Checker requested changes",
    ]);
    expect(calls).toContainEqual([
      "pr",
      "review",
      "9",
      "--repo",
      "aigile/aigile",
      "--comment",
      "--body",
      "Checker escalated",
    ]);
    expect(await adapter.getPullRequest(pr.id)).toMatchObject({
      reviews: [
        { event: "approve", body: "Checker passed" },
        { event: "request_changes", body: "Checker requested changes" },
        { event: "comment", body: "Checker escalated" },
      ],
    });
  });

  it("throws when gh pull request review fails", async () => {
    const adapter = createGitHubCliCodeHostAdapter({
      exec: async (_command, args) => {
        if (args[0] === "pr" && args[1] === "create") {
          return { stdout: "https://github.com/aigile/aigile/pull/9", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "review rejected", exitCode: 1 };
      },
    });
    const pr = await adapter.createPullRequest({
      owner: "aigile",
      repo: "aigile",
      branch: "aigile/LIN-123",
      baseBranch: "main",
      title: "LIN-123 Build workflow",
      body: "PR body",
    });

    await expect(adapter.submitPullRequestReview(pr.id, {
      event: "approve",
      body: "Checker passed",
    })).rejects.toThrow(/gh pr review failed.*review rejected/);
  });
});
