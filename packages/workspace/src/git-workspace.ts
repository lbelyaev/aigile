import { spawn } from "node:child_process";
import { join } from "node:path";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecCommand = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => Promise<ExecResult>;

export interface IssueWorkspaceInput {
  issueKey: string;
  baseBranch: string;
  remote?: string;
}

export interface IssueWorkspace {
  issueKey: string;
  branchName: string;
  worktreePath: string;
  baseBranch: string;
}

export type IssueWorkspaceStatusState =
  | "missing"
  | "clean"
  | "dirty"
  | "branch_mismatch"
  | "invalid";

export interface IssueWorkspaceStatus {
  workspace: IssueWorkspace;
  state: IssueWorkspaceStatusState;
  currentBranch?: string;
  changedFiles: string[];
  message?: string;
}

export interface GitWorkspaceAdapter {
  checkIssueWorkspaceAvailability: (input: IssueWorkspaceInput) => Promise<IssueWorkspace>;
  createIssueWorkspace: (input: IssueWorkspaceInput) => Promise<IssueWorkspace>;
  getIssueWorkspaceStatus: (input: IssueWorkspaceInput) => Promise<IssueWorkspaceStatus>;
  diffSummary: (workspace: IssueWorkspace) => Promise<string>;
}

export interface GitWorkspaceAdapterOptions {
  repoPath: string;
  worktreesPath: string;
  remote?: string;
  exec?: ExecCommand;
}

export const defaultExecCommand: ExecCommand = async (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        exitCode: code ?? 1,
      });
    });
  });

const safeIssueSlug = (issueKey: string): string => {
  const slug = issueKey
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) throw new Error("Issue key cannot produce an empty workspace slug");
  return slug;
};

const assertSuccess = (result: ExecResult, operation: string): void => {
  if (result.exitCode !== 0) {
    throw new Error(`${operation} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }
};

type WorkspaceTargetState = "available" | "existing_worktree" | "existing_branch";

interface SyncedBaseBranch {
  remote: string;
  baseBranch: string;
  remoteRef: string;
}

const remoteBaseRef = (remote: string, baseBranch: string): string =>
  `refs/remotes/${remote}/${baseBranch}`;

const localBaseRef = (baseBranch: string): string => `refs/heads/${baseBranch}`;

const commandOutput = (result: ExecResult): string => (result.stderr || result.stdout).trimEnd();

const syncBaseBranch = async (
  exec: ExecCommand,
  repoPath: string,
  baseBranch: string,
  remote: string,
): Promise<SyncedBaseBranch> => {
  const fetchResult = await exec("git", ["fetch", remote, baseBranch], { cwd: repoPath });
  if (fetchResult.exitCode !== 0) {
    throw new Error(
      `Failed to fetch ${remote} ${baseBranch} before starting Aigile: ${commandOutput(fetchResult)}`,
    );
  }

  const remoteRef = remoteBaseRef(remote, baseBranch);
  const remoteResult = await exec("git", ["rev-parse", "--verify", remoteRef], {
    cwd: repoPath,
  });
  if (remoteResult.exitCode !== 0) {
    throw new Error(
      `Fetched ${remote} ${baseBranch}, but ${remoteRef} could not be resolved: ${commandOutput(remoteResult)}`,
    );
  }

  const localRef = localBaseRef(baseBranch);
  const localResult = await exec("git", ["rev-parse", "--verify", localRef], {
    cwd: repoPath,
  });
  if (localResult.exitCode === 0) {
    const fastForwardResult = await exec(
      "git",
      ["merge-base", "--is-ancestor", localRef, remoteRef],
      { cwd: repoPath },
    );
    if (fastForwardResult.exitCode !== 0) {
      throw new Error(
        `Base branch ${baseBranch} cannot be fast-forwarded to ${remote}/${baseBranch}; synchronize or reset the local base branch before starting Aigile.`,
      );
    }
  } else if (localResult.exitCode !== 128 && localResult.exitCode !== 1) {
    throw new Error(
      `Unable to inspect local base branch ${baseBranch}: ${commandOutput(localResult)}`,
    );
  }

  return { remote, baseBranch, remoteRef };
};

const assertIssueBranchContainsBase = async (
  exec: ExecCommand,
  repoPath: string,
  branchName: string,
  syncedBase: SyncedBaseBranch,
  worktreePath?: string,
): Promise<void> => {
  const containsBaseResult = await exec(
    "git",
    ["merge-base", "--is-ancestor", syncedBase.remoteRef, branchName],
    { cwd: repoPath },
  );
  if (containsBaseResult.exitCode === 0) return;

  const staleResult = await exec(
    "git",
    ["merge-base", "--is-ancestor", branchName, syncedBase.remoteRef],
    { cwd: repoPath },
  );
  if (staleResult.exitCode === 0) {
    await recoverStaleIssueBranch(exec, repoPath, branchName, syncedBase, worktreePath);
    return;
  }

  throw new Error(
    `Issue branch ${branchName} diverged from ${syncedBase.remote}/${syncedBase.baseBranch}; rebase or recreate it before starting Aigile.`,
  );
};

const assertCleanWorktree = async (
  exec: ExecCommand,
  branchName: string,
  worktreePath: string,
): Promise<void> => {
  const statusResult = await exec("git", ["status", "--short"], { cwd: worktreePath });
  assertSuccess(statusResult, "git status --short");
  if (statusResult.stdout.trim().length > 0) {
    throw new Error(
      `Issue branch ${branchName} is stale and has uncommitted changes in ${worktreePath}; rebase or recreate it before starting Aigile.`,
    );
  }
};

const recoverStaleIssueBranch = async (
  exec: ExecCommand,
  repoPath: string,
  branchName: string,
  syncedBase: SyncedBaseBranch,
  worktreePath?: string,
): Promise<void> => {
  const existingWorktreePath =
    worktreePath ?? (await worktreePathForBranch(exec, repoPath, branchName));

  if (existingWorktreePath !== undefined) {
    await assertCleanWorktree(exec, branchName, existingWorktreePath);
    const mergeResult = await exec("git", ["merge", "--ff-only", syncedBase.remoteRef], {
      cwd: existingWorktreePath,
    });
    assertSuccess(mergeResult, `git merge --ff-only ${syncedBase.remoteRef}`);
    return;
  }

  const resetBranchResult = await exec("git", ["branch", "-f", branchName, syncedBase.remoteRef], {
    cwd: repoPath,
  });
  assertSuccess(resetBranchResult, `git branch -f ${branchName} ${syncedBase.remoteRef}`);
};

const worktreePathForBranch = async (
  exec: ExecCommand,
  repoPath: string,
  branchName: string,
): Promise<string | undefined> => {
  const result = await exec("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
  assertSuccess(result, "git worktree list");

  let currentPath: string | undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
      continue;
    }
    if (line === `branch refs/heads/${branchName}`) return currentPath;
  }
  return undefined;
};

const inspectWorkspaceTarget = async (
  exec: ExecCommand,
  repoPath: string,
  workspace: IssueWorkspace,
  syncedBase: SyncedBaseBranch,
): Promise<WorkspaceTargetState> => {
  const pathResult = await exec("test", ["-e", workspace.worktreePath], { cwd: repoPath });
  if (pathResult.exitCode === 0) {
    const branchResult = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workspace.worktreePath,
    });
    if (branchResult.exitCode !== 0) {
      throw new Error(
        `Issue worktree path already exists but is not a git worktree: ${workspace.worktreePath}`,
      );
    }
    const existingBranch = branchResult.stdout.trim();
    if (existingBranch !== workspace.branchName) {
      throw new Error(
        `Issue worktree path already exists for branch ${existingBranch}, expected ${workspace.branchName}`,
      );
    }
    await assertIssueBranchContainsBase(
      exec,
      repoPath,
      workspace.branchName,
      syncedBase,
      workspace.worktreePath,
    );
    return "existing_worktree";
  }

  const branchResult = await exec(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${workspace.branchName}`],
    { cwd: repoPath },
  );
  if (branchResult.exitCode === 0) {
    await assertIssueBranchContainsBase(exec, repoPath, workspace.branchName, syncedBase);
    return "existing_branch";
  }
  if (branchResult.exitCode !== 1) {
    assertSuccess(branchResult, "git show-ref");
  }
  return "available";
};

export const createGitWorkspaceAdapter = (
  options: GitWorkspaceAdapterOptions,
): GitWorkspaceAdapter => {
  const exec = options.exec ?? defaultExecCommand;
  const remote = options.remote ?? "origin";

  const buildWorkspace = (input: IssueWorkspaceInput): IssueWorkspace => {
    const slug = safeIssueSlug(input.issueKey);
    return {
      issueKey: input.issueKey,
      branchName: `aigile/${slug}`,
      worktreePath: join(options.worktreesPath, slug),
      baseBranch: input.baseBranch,
    };
  };

  const checkIssueWorkspaceAvailability = async (
    input: IssueWorkspaceInput,
  ): Promise<IssueWorkspace> => {
    const workspace = buildWorkspace(input);
    const syncedBase = await syncBaseBranch(
      exec,
      options.repoPath,
      input.baseBranch,
      input.remote ?? remote,
    );
    await inspectWorkspaceTarget(exec, options.repoPath, workspace, syncedBase);
    return workspace;
  };

  return {
    checkIssueWorkspaceAvailability,
    createIssueWorkspace: async (input) => {
      const workspace = buildWorkspace(input);
      const syncedBase = await syncBaseBranch(
        exec,
        options.repoPath,
        input.baseBranch,
        input.remote ?? remote,
      );
      const targetState = await inspectWorkspaceTarget(
        exec,
        options.repoPath,
        workspace,
        syncedBase,
      );
      if (targetState === "existing_worktree") return workspace;
      if (targetState === "existing_branch") {
        const existingWorktreePath = await worktreePathForBranch(
          exec,
          options.repoPath,
          workspace.branchName,
        );
        if (existingWorktreePath !== undefined) {
          return { ...workspace, worktreePath: existingWorktreePath };
        }
      }
      const result =
        targetState === "existing_branch"
          ? await exec("git", ["worktree", "add", workspace.worktreePath, workspace.branchName], {
              cwd: options.repoPath,
            })
          : await exec(
              "git",
              [
                "worktree",
                "add",
                "-b",
                workspace.branchName,
                workspace.worktreePath,
                syncedBase.remoteRef,
              ],
              { cwd: options.repoPath },
            );
      assertSuccess(result, "git worktree add");
      return workspace;
    },
    getIssueWorkspaceStatus: async (input) => {
      const workspace = buildWorkspace(input);
      const pathResult = await exec("test", ["-e", workspace.worktreePath], {
        cwd: options.repoPath,
      });
      if (pathResult.exitCode !== 0) {
        return {
          workspace,
          state: "missing",
          changedFiles: [],
        };
      }

      const branchResult = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: workspace.worktreePath,
      });
      if (branchResult.exitCode !== 0) {
        return {
          workspace,
          state: "invalid",
          changedFiles: [],
          message:
            branchResult.stderr ||
            branchResult.stdout ||
            "worktree path is not a valid git worktree",
        };
      }

      const currentBranch = branchResult.stdout.trim();
      if (currentBranch !== workspace.branchName) {
        return {
          workspace,
          state: "branch_mismatch",
          currentBranch,
          changedFiles: [],
        };
      }

      const statusResult = await exec("git", ["status", "--short"], {
        cwd: workspace.worktreePath,
      });
      assertSuccess(statusResult, "git status --short");
      const changedFiles = statusResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
      return {
        workspace,
        state: changedFiles.length > 0 ? "dirty" : "clean",
        currentBranch,
        changedFiles,
      };
    },
    diffSummary: async (workspace) => {
      const result = await exec("git", ["diff", "--stat"], { cwd: workspace.worktreePath });
      assertSuccess(result, "git diff --stat");
      return result.stdout.trimEnd();
    },
  };
};
