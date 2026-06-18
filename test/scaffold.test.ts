import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(join(root, path), "utf8")) as T;

describe("project scaffold", () => {
  it("declares a private Bun TypeScript monorepo", () => {
    const pkg = readJson<{
      private?: boolean;
      packageManager?: string;
      workspaces?: string[];
      scripts?: Record<string, string>;
    }>("package.json");

    expect(pkg.private).toBe(true);
    expect(pkg.packageManager).toBe("bun@1.2.21");
    expect(pkg.workspaces).toEqual(["packages/*"]);
    expect(pkg.scripts?.test).toBe("bun test");
    expect(pkg.scripts?.typecheck).toBe("tsc -b");
  });

  it("documents the project operating rules", () => {
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");

    expect(agents).toContain("Strict TDD");
    expect(agents).toContain("TypeScript");
    expect(agents).toContain("Bun");
    expect(agents).toContain("one local commit per slice");
    expect(agents).toContain("Any ACP-compatible agent");
    expect(agents).toContain("Linear");
    expect(agents).toContain("GitHub");
  });
});
