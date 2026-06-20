import { describe, expect, it } from "bun:test";
import {
  defaultProductWorktreesPath,
  loadProductConfigFromJson,
  resolveProductPaths,
} from "./index.js";

describe("product config", () => {
  it("loads Linear-to-GitHub product routing from JSON", () => {
    const config = loadProductConfigFromJson(
      JSON.stringify({
        products: [
          {
            id: "aigile",
            linear: { team: "LBE", project: "Aigile" },
            github: { repo: "lbelyaev/aigile", baseBranch: "main" },
            worktreesPath: "~/.aigile/worktrees/lbelyaev/aigile",
            defaultRun: { startRun: true, mode: "agent_write", publish: true },
          },
        ],
      }),
    );

    expect(config.products[0]).toEqual({
      id: "aigile",
      linear: { team: "LBE", project: "Aigile" },
      github: { repo: "lbelyaev/aigile", baseBranch: "main" },
      worktreesPath: "~/.aigile/worktrees/lbelyaev/aigile",
      defaultRun: { startRun: true, mode: "agent_write", publish: true },
    });
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
