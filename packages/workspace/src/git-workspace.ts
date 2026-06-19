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

export interface GitWorkspaceAdapter {
  checkIssueWorkspaceAvailability: (input: IssueWorkspaceInput) => Promise<IssueWorkspace>;
  createIssueWorkspace: (input: IssueWorkspaceInput) => Promise<IssueWorkspace>;
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
  const slug = issueKey.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length === 0) throw new Error("Issue key cannot produce an empty workspace slug");
  return slug;
};

const assertSuccess = (result: ExecResult, operation: string): void => {
  if (result.exitCode !== 0) {
    throw new Error(`${operation} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }
};

const assertWorkspaceTargetAvailable = async (
  exec: ExecCommand,
  repoPath: string,
  workspace: IssueWorkspace,
): Promise<void> => {
  const pathResult = await exec("test", ["-e", workspace.worktreePath], { cwd: repoPath });
  if (pathResult.exitCode === 0) {
    throw new Error(`Issue worktree path already exists: ${workspace.worktreePath}`);
  }

  const branchResult = await exec("git", [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${workspace.branchName}`,
  ], { cwd: repoPath });
  if (branchResult.exitCode === 0) {
    throw new Error(`Issue branch already exists: ${workspace.branchName}`);
  }
  if (branchResult.exitCode !== 1) {
    assertSuccess(branchResult, "git show-ref");
  }
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

  const checkIssueWorkspaceAvailability = async (input: IssueWorkspaceInput): Promise<IssueWorkspace> => {
    const workspace = buildWorkspace(input);
    await assertWorkspaceTargetAvailable(exec, options.repoPath, workspace);
    return workspace;
  };

  return {
    checkIssueWorkspaceAvailability,
    createIssueWorkspace: async (input) => {
      const workspace = await checkIssueWorkspaceAvailability(input);
      const result = await exec("git", [
        "worktree",
        "add",
        "-b",
        workspace.branchName,
        workspace.worktreePath,
        input.baseBranch,
      ], { cwd: options.repoPath });
      assertSuccess(result, "git worktree add");
      return workspace;
    },
    diffSummary: async (workspace) => {
      const result = await exec("git", ["diff", "--stat"], { cwd: workspace.worktreePath });
      assertSuccess(result, "git diff --stat");
      return result.stdout.trimEnd();
    },
  };
};
