import { defaultExecCommand, type ExecCommand, type ExecResult } from "./git-workspace.js";

export interface GitPublishInput {
  worktreePath: string;
  branchName: string;
  remote?: string;
  owner?: string;
  repo?: string;
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

const githubHttpsUrl = (owner: string, repo: string): string =>
  `https://github.com/${owner}/${repo}.git`;

const pushTargetFor = (input: GitPublishInput): string => {
  if (input.owner !== undefined && input.repo !== undefined) {
    return githubHttpsUrl(input.owner, input.repo);
  }
  if (input.remote !== undefined) return input.remote;
  throw new Error("git push target requires owner/repo or remote");
};

export const createGitPublisher = (options: GitPublisherOptions = {}): GitPublisher => {
  const exec = options.exec ?? defaultExecCommand;

  return {
    publish: async (input) => {
      assertSuccess(await exec("git", ["add", "-A"], { cwd: input.worktreePath }), "git add");
      const stagedDiff = await exec("git", ["diff", "--cached", "--quiet"], {
        cwd: input.worktreePath,
      });
      if (stagedDiff.exitCode === 1) {
        assertSuccess(
          await exec("git", ["commit", "-m", input.commitMessage], { cwd: input.worktreePath }),
          "git commit",
        );
      } else {
        assertSuccess(stagedDiff, "git diff --cached --quiet");
      }
      const pushTarget = pushTargetFor(input);
      assertSuccess(
        await exec(
          "git",
          [
            "-c",
            "credential.helper=",
            "-c",
            "credential.helper=!gh auth git-credential",
            "push",
            pushTarget,
            `HEAD:${input.branchName}`,
          ],
          {
            cwd: input.worktreePath,
          },
        ),
        "git push",
      );
    },
  };
};
