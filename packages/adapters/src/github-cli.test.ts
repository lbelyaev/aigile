import { describe, expect, it } from "bun:test";
import { createGitHubCliCodeHostAdapter } from "./index.js";

describe("GitHub CLI code host adapter", () => {
  it("creates a draft pull request with gh", async () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const adapter = createGitHubCliCodeHostAdapter({
      cwd: "/repo/aigile",
      exec: async (command, args, options) => {
        calls.push(
          options.cwd === undefined
            ? { command, args: [...args] }
            : { command, args: [...args], cwd: options.cwd },
        );
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

  it("reuses an existing pull request when gh reports one for the branch", async () => {
    const calls: string[][] = [];
    const adapter = createGitHubCliCodeHostAdapter({
      exec: async (_command, args) => {
        calls.push([...args]);
        if (args[0] === "pr" && args[1] === "create") {
          return {
            stdout: "",
            stderr: [
              "Warning: 59 uncommitted changes",
              'a pull request for branch "aigile/LBE-8" into branch "main" already exists:',
              "https://github.com/lbelyaev/aigile/pull/6",
            ].join("\n"),
            exitCode: 1,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    const pr = await adapter.createPullRequest({
      owner: "lbelyaev",
      repo: "aigile",
      branch: "aigile/LBE-8",
      baseBranch: "main",
      title: "LBE-8 Detect PR merge conflicts",
      body: "PR body",
    });

    expect(pr).toMatchObject({
      id: "lbelyaev/aigile#6",
      number: 6,
      url: "https://github.com/lbelyaev/aigile/pull/6",
      comments: [],
      checks: [],
      reviews: [],
    });
    expect(calls).toContainEqual([
      "pr",
      "edit",
      "6",
      "--repo",
      "lbelyaev/aigile",
      "--title",
      "LBE-8 Detect PR merge conflicts",
      "--body",
      "PR body",
    ]);
  });

  it("records comments, check results, and PR reviews", async () => {
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
    await adapter.submitPullRequestReview(pr.id, {
      event: "approve",
      body: "Checker approved",
    });

    expect(await adapter.getPullRequest(pr.id)).toMatchObject({
      comments: ["Verifier passed"],
      checks: [{ name: "aigile/verifier", status: "passed", summary: "All good" }],
      reviews: [{ event: "approve", body: "Checker approved" }],
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
    expect(calls).toContainEqual([
      "pr",
      "review",
      "7",
      "--repo",
      "aigile/aigile",
      "--approve",
      "--body",
      "Checker approved",
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

    await expect(
      adapter.submitPullRequestReview(pr.id, {
        event: "approve",
        body: "Checker passed",
      }),
    ).rejects.toThrow(/gh pr review failed.*review rejected/);
  });

  it("reads mergeable pull request state with gh", async () => {
    const calls: string[][] = [];
    const adapter = createGitHubCliCodeHostAdapter({
      exec: async (_command, args) => {
        calls.push([...args]);
        if (args[0] === "pr" && args[1] === "create") {
          return { stdout: "https://github.com/aigile/aigile/pull/9", stderr: "", exitCode: 0 };
        }
        return {
          stdout: JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
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

    await expect(adapter.getPullRequestMergeability(pr.id)).resolves.toEqual({
      status: "mergeable",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    expect(calls).toContainEqual([
      "pr",
      "view",
      "9",
      "--repo",
      "aigile/aigile",
      "--json",
      "mergeable,mergeStateStatus",
    ]);
  });

  it("reads merged pull request state with gh", async () => {
    const calls: string[][] = [];
    const adapter = createGitHubCliCodeHostAdapter({
      exec: async (_command, args) => {
        calls.push([...args]);
        if (args[0] === "pr" && args[1] === "create") {
          return { stdout: "https://github.com/aigile/aigile/pull/14", stderr: "", exitCode: 0 };
        }
        return {
          stdout: JSON.stringify({
            state: "MERGED",
            merged: true,
            mergedAt: "2026-06-20T12:00:00Z",
          }),
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

    await expect(adapter.getPullRequestMergeState(pr.id)).resolves.toEqual({
      status: "merged",
      state: "MERGED",
      merged: true,
      mergedAt: "2026-06-20T12:00:00Z",
    });
    expect(calls).toContainEqual([
      "pr",
      "view",
      "14",
      "--repo",
      "aigile/aigile",
      "--json",
      "state,merged,mergedAt",
    ]);
  });

  it("treats absent merged pull request fields as unknown", async () => {
    const adapter = createGitHubCliCodeHostAdapter({
      exec: async (_command, args) => {
        if (args[0] === "pr" && args[1] === "create") {
          return { stdout: "https://github.com/aigile/aigile/pull/15", stderr: "", exitCode: 0 };
        }
        return { stdout: JSON.stringify({}), stderr: "", exitCode: 0 };
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

    await expect(adapter.getPullRequestMergeState(pr.id)).resolves.toEqual({
      status: "unknown",
    });
  });

  it("maps conflicting and dirty pull request states to conflicting", async () => {
    for (const payload of [
      { mergeable: "CONFLICTING", mergeStateStatus: "UNKNOWN" },
      { mergeable: "MERGEABLE", mergeStateStatus: "DIRTY" },
    ]) {
      const adapter = createGitHubCliCodeHostAdapter({
        exec: async (_command, args) => {
          if (args[0] === "pr" && args[1] === "create") {
            return { stdout: "https://github.com/aigile/aigile/pull/10", stderr: "", exitCode: 0 };
          }
          return { stdout: JSON.stringify(payload), stderr: "", exitCode: 0 };
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

      await expect(adapter.getPullRequestMergeability(pr.id)).resolves.toMatchObject({
        status: "conflicting",
      });
    }
  });

  it("maps unknown or empty pull request states to unknown", async () => {
    for (const payload of [{ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }, {}]) {
      const adapter = createGitHubCliCodeHostAdapter({
        exec: async (_command, args) => {
          if (args[0] === "pr" && args[1] === "create") {
            return { stdout: "https://github.com/aigile/aigile/pull/11", stderr: "", exitCode: 0 };
          }
          return { stdout: JSON.stringify(payload), stderr: "", exitCode: 0 };
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

      await expect(adapter.getPullRequestMergeability(pr.id)).resolves.toMatchObject({
        status: "unknown",
      });
    }
  });

  it("fails mergeability reads when gh fails", async () => {
    const adapter = createGitHubCliCodeHostAdapter({
      exec: async (_command, args) => {
        if (args[0] === "pr" && args[1] === "create") {
          return { stdout: "https://github.com/aigile/aigile/pull/12", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "not found", exitCode: 1 };
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

    await expect(adapter.getPullRequestMergeability(pr.id)).rejects.toThrow(
      /gh pr view failed \(1\): not found/i,
    );
  });

  it("fails mergeability reads when gh returns invalid JSON", async () => {
    const adapter = createGitHubCliCodeHostAdapter({
      exec: async (_command, args) => {
        if (args[0] === "pr" && args[1] === "create") {
          return { stdout: "https://github.com/aigile/aigile/pull/13", stderr: "", exitCode: 0 };
        }
        return { stdout: "not json", stderr: "", exitCode: 0 };
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

    await expect(adapter.getPullRequestMergeability(pr.id)).rejects.toThrow(
      /could not parse pull request mergeability json/i,
    );
  });
});
