import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  findRepoConfig,
  loadRepoConfigFromJson,
  repoConfigToProduct,
  type InRepoConfig,
} from "./index.js";

describe("in-repo config", () => {
  it("loads repo-local operational config from JSON", () => {
    expect(
      loadRepoConfigFromJson(
        JSON.stringify({
          version: 1,
          id: "aigile",
          packageManager: "bun",
          linear: { team: "LBE", project: "Aigile" },
          github: { repo: "lbelyaev/aigile", baseBranch: "trunk" },
          mergePolicy: "manual",
          defaultRun: { startRun: true, mode: "agent_write", publish: false },
          verification: {
            install: [["bun", "install", "--frozen-lockfile"]],
            checks: [["bun", "run", "check"]],
          },
        }),
      ),
    ).toEqual({
      version: 1,
      id: "aigile",
      packageManager: "bun",
      linear: { team: "LBE", project: "Aigile" },
      github: { repo: "lbelyaev/aigile", baseBranch: "trunk" },
      mergePolicy: "manual",
      defaultRun: { startRun: true, mode: "agent_write", publish: false },
      verification: {
        install: [["bun", "install", "--frozen-lockfile"]],
        checks: [["bun", "run", "check"]],
      },
    } satisfies InRepoConfig);
  });

  it("rejects malformed repo config with field-scoped errors", () => {
    expect(() => loadRepoConfigFromJson("{bad json")).toThrow(/repo config was not valid json/i);
    expect(() =>
      loadRepoConfigFromJson(JSON.stringify({ version: 1, linear: { project: "Aigile" } })),
    ).toThrow(/linear\.team/i);
  });

  it("finds nearest .aigile.json without crossing the git repo boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "aigile-repo-config-"));
    try {
      writeFileSync(
        join(root, ".aigile.json"),
        JSON.stringify({
          version: 1,
          linear: { team: "PARENT", project: "Parent" },
        }),
      );
      const repo = join(root, "repo");
      const src = join(repo, "packages", "cli", "src");
      mkdirSync(src, { recursive: true });
      mkdirSync(join(repo, ".git"));
      writeFileSync(
        join(repo, ".aigile.json"),
        JSON.stringify({
          version: 1,
          linear: { team: "LBE", project: "Aigile" },
          github: { baseBranch: "main" },
        }),
      );

      expect(findRepoConfig(src)).toEqual({
        path: join(repo, ".aigile.json"),
        config: {
          version: 1,
          linear: { team: "LBE", project: "Aigile" },
          github: { baseBranch: "main" },
        },
      });

      rmSync(join(repo, ".aigile.json"));
      expect(findRepoConfig(src)).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("converts repo config into a runtime product with built-in defaults", () => {
    expect(
      repoConfigToProduct(
        {
          version: 1,
          id: "aigile",
          packageManager: "bun",
          linear: { team: "LBE", project: "Aigile" },
          github: { repo: "lbelyaev/aigile", baseBranch: "main" },
          verification: { checks: [["bun", "test"]] },
        },
        "/repo/aigile",
      ),
    ).toEqual({
      id: "aigile",
      linear: { team: "LBE", project: "Aigile" },
      github: { repo: "lbelyaev/aigile", baseBranch: "main" },
      packageManager: "bun",
      repoPath: "/repo/aigile",
      mergePolicy: "auto",
      defaultRun: { startRun: false, mode: "dry_run", publish: false },
      verification: { checks: [["bun", "test"]] },
    });
  });
});
