import { describe, expect, it } from "bun:test";
import {
  DEFAULT_MAX_CONCURRENT_RUNS,
  defaultProductWorktreesPath,
  loadProductConfigFromJson,
  resolveProductPaths,
} from "./index.js";

describe("product config", () => {
  it("loads Linear-to-GitHub product routing from JSON", () => {
    const config = loadProductConfigFromJson(
      JSON.stringify({
        maxConcurrentRuns: 3,
        products: [
          {
            id: "aigile",
            linear: { team: "LBE", project: "Aigile" },
            github: { repo: "lbelyaev/aigile", baseBranch: "main" },
            maxConcurrentRuns: 2,
            packageManager: "bun",
            worktreesPath: "~/.aigile/worktrees/lbelyaev/aigile",
            defaultRun: { startRun: true, mode: "agent_write", publish: true },
            verification: {
              install: [["bun", "install", "--frozen-lockfile"]],
              checks: [["bun", "run", "check"]],
              changedFileGuards: [
                {
                  whenAnyChanged: ["package.json", "packages/*/package.json"],
                  mustAlsoChange: ["bun.lock"],
                  message: "Package manifests changed; update bun.lock.",
                },
              ],
            },
          },
        ],
      }),
    );

    expect(config.products[0]).toEqual({
      id: "aigile",
      linear: { team: "LBE", project: "Aigile" },
      github: { repo: "lbelyaev/aigile", baseBranch: "main" },
      maxConcurrentRuns: 2,
      packageManager: "bun",
      worktreesPath: "~/.aigile/worktrees/lbelyaev/aigile",
      defaultRun: { startRun: true, mode: "agent_write", publish: true },
      verification: {
        install: [["bun", "install", "--frozen-lockfile"]],
        checks: [["bun", "run", "check"]],
        changedFileGuards: [
          {
            whenAnyChanged: ["package.json", "packages/*/package.json"],
            mustAlsoChange: ["bun.lock"],
            message: "Package manifests changed; update bun.lock.",
          },
        ],
      },
    });
    expect(config.maxConcurrentRuns).toBe(3);
  });

  it("defaults global concurrency and leaves product concurrency unbounded by product", () => {
    const config = loadProductConfigFromJson(
      JSON.stringify({
        products: [
          {
            id: "aigile",
            linear: { team: "LBE", project: "Aigile" },
            github: { repo: "lbelyaev/aigile" },
            defaultRun: { startRun: true, mode: "agent_write", publish: true },
          },
        ],
      }),
    );

    expect(config.maxConcurrentRuns).toBe(DEFAULT_MAX_CONCURRENT_RUNS);
    expect(config.products[0]?.maxConcurrentRuns).toBeUndefined();
  });

  it("rejects malformed product config", () => {
    expect(() => loadProductConfigFromJson("{bad json")).toThrow(/valid json/i);
    expect(() =>
      loadProductConfigFromJson(
        JSON.stringify({
          products: [
            {
              id: "aigile",
              linear: { project: "Aigile" },
              github: { repo: "lbelyaev/aigile" },
              defaultRun: { startRun: true, mode: "agent_write", publish: true },
            },
          ],
        }),
      ),
    ).toThrow(/linear\.team/i);
    expect(() =>
      loadProductConfigFromJson(
        JSON.stringify({
          maxConcurrentRuns: 0,
          products: [
            {
              id: "aigile",
              linear: { team: "LBE", project: "Aigile" },
              github: { repo: "lbelyaev/aigile" },
              defaultRun: { startRun: true, mode: "agent_write", publish: true },
            },
          ],
        }),
      ),
    ).toThrow(/maxConcurrentRuns.*positive integer/i);
    expect(() =>
      loadProductConfigFromJson(
        JSON.stringify({
          products: [
            {
              id: "aigile",
              linear: { team: "LBE", project: "Aigile" },
              github: { repo: "lbelyaev/aigile" },
              maxConcurrentRuns: 1.5,
              defaultRun: { startRun: true, mode: "agent_write", publish: true },
            },
          ],
        }),
      ),
    ).toThrow(/products\[0\]\.maxConcurrentRuns.*positive integer/i);
  });

  it("uses deterministic default worktrees paths outside the repo", () => {
    expect(defaultProductWorktreesPath("lbelyaev/aigile", "/home/test")).toBe(
      "/home/test/.aigile/worktrees/lbelyaev/aigile",
    );
    expect(
      resolveProductPaths(
        {
          id: "aigile",
          linear: { team: "LBE", project: "Aigile" },
          github: { repo: "lbelyaev/aigile", baseBranch: "main" },
          defaultRun: { startRun: true, mode: "agent_write", publish: true },
        },
        { cwd: "/repo/aigile", homeDir: "/home/test" },
      ),
    ).toEqual({
      repoPath: "/repo/aigile",
      worktreesPath: "/home/test/.aigile/worktrees/lbelyaev/aigile",
    });
  });
});
