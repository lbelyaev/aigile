import { defaultExecCommand, type ExecCommand, type ExecResult } from "./git-workspace.js";

export interface GitPublishInput {
  worktreePath: string;
  branchName: string;
  remote: string;
  commitMessage: string;
}

export interface GitPublisher {
  publish: (input: GitPublishInput) => Promise<void>;
}

export interface GitPublisherOptions {
  exec?: ExecCommand;
}

const assertSuccess = (result: ExecResult, operation: string): void => {
  if (result.exitCode !== 0) {
    throw new Error(`${operation} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }
};

export const createGitPublisher = (
  options: GitPublisherOptions = {},
): GitPublisher => {
  const exec = options.exec ?? defaultExecCommand;

  return {
    publish: async (input) => {
      assertSuccess(
        await exec("git", ["add", "-A"], { cwd: input.worktreePath }),
        "git add",
      );
      assertSuccess(
        await exec("git", ["commit", "-m", input.commitMessage], { cwd: input.worktreePath }),
        "git commit",
      );
      assertSuccess(
        await exec("git", ["push", "-u", input.remote, input.branchName], { cwd: input.worktreePath }),
        "git push",
      );
    },
  };
};
