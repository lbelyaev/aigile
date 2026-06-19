import type { WorkflowArtifact } from "@aigile/types";
import { defaultExecCommand, type ExecCommand } from "@aigile/workspace";

export type VerificationStatus = "passed" | "failed";

export interface VerificationCommandResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface VerificationResultPayload {
  status: VerificationStatus;
  commands: VerificationCommandResult[];
}

export type VerificationArtifact = WorkflowArtifact<VerificationResultPayload>;

export interface VerifyInput {
  issueKey: string;
  workspacePath: string;
  commands: Array<readonly [string, ...string[]]>;
}

export interface LocalVerifier {
  verify: (input: VerifyInput) => Promise<VerificationArtifact>;
}

export interface LocalVerifierOptions {
  exec?: ExecCommand;
}

export const createLocalVerifier = (options: LocalVerifierOptions = {}): LocalVerifier => {
  const exec = options.exec ?? defaultExecCommand;

  return {
    verify: async (input) => {
      const commandResults: VerificationCommandResult[] = [];
      let status: VerificationStatus = "passed";

      for (const [command, ...args] of input.commands) {
        const result = await exec(command, args, { cwd: input.workspacePath });
        commandResults.push({
          command,
          args,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        });
        if (result.exitCode !== 0) {
          status = "failed";
          break;
        }
      }

      return {
        id: `verifier:${input.issueKey}:local`,
        kind: "verification.result",
        source: "verifier",
        payload: {
          status,
          commands: commandResults,
        },
      };
    },
  };
};
