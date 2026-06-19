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
});
