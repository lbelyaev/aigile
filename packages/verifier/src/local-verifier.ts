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
  changedFileGuards?: ChangedFileGuard[];
}

export interface LocalVerifier {
  verify: (input: VerifyInput) => Promise<VerificationArtifact>;
}

export interface LocalVerifierOptions {
  exec?: ExecCommand;
}

export interface ChangedFileGuard {
  whenAnyChanged: string[];
  mustAlsoChange: string[];
  message?: string;
}

const parseStatusPath = (line: string): string | undefined => {
  const path = line.slice(3).trim();
  if (path.length === 0) return undefined;
  const renameSeparator = " -> ";
  const renameIndex = path.lastIndexOf(renameSeparator);
  return renameIndex === -1 ? path : path.slice(renameIndex + renameSeparator.length);
};

const escapeRegExp = (value: string): string => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");

const globPatternToRegExp = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split("*").map(escapeRegExp).join("[^/]*")}$`);

const pathMatches = (path: string, pattern: string): boolean =>
  globPatternToRegExp(pattern).test(path);

const anyPathMatches = (paths: readonly string[], patterns: readonly string[]): boolean =>
  paths.some((path) => patterns.some((pattern) => pathMatches(path, pattern)));

const changedFileGuardMessage = (guard: ChangedFileGuard): string =>
  guard.message ??
  `Changed files matched ${guard.whenAnyChanged.join(", ")} but none matched required companion files ${guard.mustAlsoChange.join(", ")}`;

const verifyChangedFileGuards = (
  changedFiles: readonly string[],
  guards: readonly ChangedFileGuard[],
): string | undefined => {
  for (const guard of guards) {
    if (!anyPathMatches(changedFiles, guard.whenAnyChanged)) continue;
    if (anyPathMatches(changedFiles, guard.mustAlsoChange)) continue;
    return changedFileGuardMessage(guard);
  }
  return undefined;
};

export const createLocalVerifier = (options: LocalVerifierOptions = {}): LocalVerifier => {
  const exec = options.exec ?? defaultExecCommand;

  return {
    verify: async (input) => {
      const commandResults: VerificationCommandResult[] = [];
      let status: VerificationStatus = "passed";

      if (input.changedFileGuards !== undefined && input.changedFileGuards.length > 0) {
        const statusResult = await exec("git", ["status", "--short", "--untracked-files=all"], {
          cwd: input.workspacePath,
        });
        commandResults.push({
          command: "git",
          args: ["status", "--short", "--untracked-files=all"],
          exitCode: statusResult.exitCode,
          stdout: statusResult.stdout,
          stderr: statusResult.stderr,
        });
        if (statusResult.exitCode !== 0) {
          status = "failed";
        } else {
          const changedFiles = statusResult.stdout
            .split(/\r?\n/)
            .map(parseStatusPath)
            .filter((path): path is string => path !== undefined);
          const guardFailure = verifyChangedFileGuards(changedFiles, input.changedFileGuards);
          if (guardFailure !== undefined) {
            commandResults.push({
              command: "aigile-verify-guard",
              args: ["changed-files"],
              exitCode: 1,
              stdout: "",
              stderr: guardFailure,
            });
            status = "failed";
          }
        }
      }

      for (const [command, ...args] of input.commands) {
        if (status === "failed") break;
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
