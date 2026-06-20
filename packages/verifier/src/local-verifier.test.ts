import { describe, expect, it } from "bun:test";
import { createLocalVerifier } from "./index.js";

describe("local verifier", () => {
  it("returns a passed verification artifact when all commands pass", async () => {
    const verifier = createLocalVerifier({
      exec: async (command, args, options) => ({
        stdout: `${command} ${args.join(" ")} in ${options.cwd}`,
        stderr: "",
        exitCode: 0,
      }),
    });

    const artifact = await verifier.verify({
      issueKey: "LIN-123",
      workspacePath: "/repo/.worktrees/LIN-123",
      commands: [["bun", "run", "check"]],
    });

    expect(artifact).toEqual({
      id: "verifier:LIN-123:local",
      kind: "verification.result",
      source: "verifier",
      payload: {
        status: "passed",
        commands: [
          {
            command: "bun",
            args: ["run", "check"],
            exitCode: 0,
            stdout: "bun run check in /repo/.worktrees/LIN-123",
            stderr: "",
          },
        ],
      },
    });
  });

  it("returns failed when any command fails and stops after the failure", async () => {
    const calls: string[] = [];
    const verifier = createLocalVerifier({
      exec: async (command) => {
        calls.push(command);
        return { stdout: "", stderr: "nope", exitCode: 1 };
      },
    });

    const artifact = await verifier.verify({
      issueKey: "LIN-123",
      workspacePath: "/repo/.worktrees/LIN-123",
      commands: [
        ["bun", "test"],
        ["bun", "run", "typecheck"],
      ],
    });

    expect(artifact.payload.status).toBe("failed");
    expect(artifact.payload.commands).toHaveLength(1);
    expect(calls).toEqual(["bun"]);
  });

  it("fails before configured checks when changed-file guards are violated", async () => {
    const calls: string[] = [];
    const verifier = createLocalVerifier({
      exec: async (command, args) => {
        calls.push([command, ...args].join(" "));
        if (command === "git") {
          return {
            stdout: " M packages/ticketing/package.json\n?? packages/ticketing/src/index.ts\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    const artifact = await verifier.verify({
      issueKey: "LBE-16",
      workspacePath: "/repo/.worktrees/LBE-16",
      commands: [["bun", "run", "check"]],
      changedFileGuards: [
        {
          whenAnyChanged: ["package.json", "packages/*/package.json"],
          mustAlsoChange: ["bun.lock"],
          message: "Package manifests changed; update the configured lockfile.",
        },
      ],
    });

    expect(artifact.payload.status).toBe("failed");
    expect(calls).toEqual(["git status --short --untracked-files=all"]);
    expect(artifact.payload.commands.at(-1)).toMatchObject({
      command: "aigile-verify-guard",
      exitCode: 1,
      stderr: "Package manifests changed; update the configured lockfile.",
    });
  });

  it("runs configured checks when changed-file guard companion files are present", async () => {
    const calls: string[] = [];
    const verifier = createLocalVerifier({
      exec: async (command, args) => {
        calls.push([command, ...args].join(" "));
        if (command === "git") {
          return {
            stdout: " M packages/ticketing/package.json\n M bun.lock\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    const artifact = await verifier.verify({
      issueKey: "LBE-16",
      workspacePath: "/repo/.worktrees/LBE-16",
      commands: [["bun", "run", "check"]],
      changedFileGuards: [
        {
          whenAnyChanged: ["package.json", "packages/*/package.json"],
          mustAlsoChange: ["bun.lock"],
        },
      ],
    });

    expect(artifact.payload.status).toBe("passed");
    expect(calls).toEqual(["git status --short --untracked-files=all", "bun run check"]);
  });
});
