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

const inspectWorkspaceTarget = async (
  exec: ExecCommand,
  repoPath: string,
  workspace: IssueWorkspace,
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
    return "existing_worktree";
  }

  const branchResult = await exec(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${workspace.branchName}`],
    { cwd: repoPath },
  );
  if (branchResult.exitCode === 0) {
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
    await inspectWorkspaceTarget(exec, options.repoPath, workspace);
    return workspace;
  };

  return {
    checkIssueWorkspaceAvailability,
    createIssueWorkspace: async (input) => {
      const workspace = buildWorkspace(input);
      const targetState = await inspectWorkspaceTarget(exec, options.repoPath, workspace);
      if (targetState === "existing_worktree") return workspace;
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
                input.baseBranch,
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
