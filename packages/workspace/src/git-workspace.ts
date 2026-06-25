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

export interface DefaultExecCommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

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

const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export const createDefaultExecCommand =
  ({
    timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_EXEC_MAX_OUTPUT_BYTES,
  }: DefaultExecCommandOptions = {}): ExecCommand =>
  async (command, args, options) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let totalOutputBytes = 0;
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timeout);
        child.stdout.off("data", onStdoutData);
        child.stderr.off("data", onStderrData);
        child.off("error", onError);
        child.off("close", onClose);
      };

      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };

      const rejectAndKill = (error: Error): void => {
        if (!child.killed) child.kill();
        settle(() => reject(error));
      };

      const appendOutput = (target: Buffer[], chunk: Buffer): void => {
        if (settled) return;
        totalOutputBytes += chunk.byteLength;
        if (totalOutputBytes > maxOutputBytes) {
          rejectAndKill(
            new Error(
              `${command} exceeded max output of ${maxOutputBytes} bytes; process was killed.`,
            ),
          );
          return;
        }
        target.push(chunk);
      };

      const onStdoutData = (chunk: Buffer): void => appendOutput(stdout, chunk);
      const onStderrData = (chunk: Buffer): void => appendOutput(stderr, chunk);
      const onError = (error: Error): void => {
        const errorCode =
          typeof (error as Error & { code?: unknown }).code === "string"
            ? (error as Error & { code: string }).code
            : error.message.includes("not found")
              ? "ENOENT"
              : undefined;
        const errorLabel = errorCode === undefined ? "" : ` (${errorCode})`;
        settle(() =>
          reject(new Error(`Failed to spawn ${command}${errorLabel}: ${error.message}`)),
        );
      };
      const onClose = (code: number | null): void => {
        settle(() =>
          resolve({
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
            exitCode: code ?? 1,
          }),
        );
      };

      const timeout = setTimeout(() => {
        rejectAndKill(new Error(`${command} timed out after ${timeoutMs}ms; process was killed.`));
      }, timeoutMs);

      child.stdout.on("data", onStdoutData);
      child.stderr.on("data", onStderrData);
      child.on("error", onError);
      child.on("close", onClose);
    });

export const defaultExecCommand: ExecCommand = createDefaultExecCommand();

const safeIssueSlug = (issueKey: string): string => {
  const slug = issueKey
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) throw new Error("Issue key cannot produce an empty workspace slug");
  return slug;
};

// The branch an issue's workspace is created on; the single source of truth for
// the `aigile/<slug>` convention shared by workspace creation and status reconciliation.
export const issueBranchName = (issueKey: string): string => `aigile/${safeIssueSlug(issueKey)}`;

const assertSuccess = (result: ExecResult, operation: string): void => {
  if (result.exitCode !== 0) {
    throw new Error(`${operation} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }
};

// LBE-45 (Aider-pattern checkpointing): commit the current worktree as a checkpoint
// so each developer attempt is a restorable point. Aigile performs the commit (the
// agent never commits); untracked files are included via `git add -A`. Returns the
// commit SHA, or undefined when the worktree is clean (nothing to checkpoint).
export const commitWorktreeCheckpoint = async (
  exec: ExecCommand,
  worktreePath: string,
  message: string,
): Promise<string | undefined> => {
  assertSuccess(await exec("git", ["add", "-A"], { cwd: worktreePath }), "git add");
  const staged = await exec("git", ["diff", "--cached", "--quiet"], { cwd: worktreePath });
  if (staged.exitCode === 0) return undefined; // clean — nothing to checkpoint
  if (staged.exitCode !== 1) assertSuccess(staged, "git diff --cached --quiet");
  assertSuccess(
    await exec("git", ["commit", "--no-verify", "-m", message], { cwd: worktreePath }),
    "git commit",
  );
  const head = await exec("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
  assertSuccess(head, "git rev-parse HEAD");
  return head.stdout.trim();
};

// Restore the worktree (and branch HEAD) exactly to a prior checkpoint commit.
export const resetWorktreeTo = async (
  exec: ExecCommand,
  worktreePath: string,
  ref: string,
): Promise<void> => {
  assertSuccess(
    await exec("git", ["reset", "--hard", ref], { cwd: worktreePath }),
    "git reset --hard",
  );
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

const worktreeIsDirty = async (exec: ExecCommand, worktreePath: string): Promise<boolean> => {
  const statusResult = await exec("git", ["status", "--short"], { cwd: worktreePath });
  assertSuccess(statusResult, "git status --short");
  return statusResult.stdout.trim().length > 0;
};

// Issue worktrees are owned entirely by Aigile and keyed per issue, so uncommitted
// changes are abandoned leftovers from a failed run. Discard them and reset the
// worktree to the base branch rather than refusing to recover (which wedges the issue).
const resetWorktreeToBase = async (
  exec: ExecCommand,
  worktreePath: string,
  syncedBase: SyncedBaseBranch,
): Promise<void> => {
  const resetResult = await exec("git", ["reset", "--hard", syncedBase.remoteRef], {
    cwd: worktreePath,
  });
  assertSuccess(resetResult, `git reset --hard ${syncedBase.remoteRef}`);
  const cleanResult = await exec("git", ["clean", "-fd"], { cwd: worktreePath });
  assertSuccess(cleanResult, "git clean -fd");
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
    if (await worktreeIsDirty(exec, existingWorktreePath)) {
      await resetWorktreeToBase(exec, existingWorktreePath, syncedBase);
      return;
    }
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
