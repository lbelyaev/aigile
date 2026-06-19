import {
  createGitHubCliCodeHostAdapter,
  createFakeCodeHostAdapter,
  createFakeIssueTrackerAdapter,
  createLinearGraphqlIssueTrackerAdapter,
  issueToArtifact,
  pullRequestToArtifact,
  type CodeHostAdapter,
  type GitHubCliExec,
  type IssueRecord,
  type LinearFetchGraphql,
  type PullRequestRecord,
} from "@aigile/adapters";
import {
  createAcpRoleRunner,
  createRoleRuntimeRegistry,
  createScriptedRoleRunner,
  runAssignedRole,
  type AcpRuntimeConnector,
  type RoleRunner,
  type RoleRuntimeRegistry,
} from "@aigile/roles";
import type { WorkflowArtifact, WorkflowEvent, WorkflowState } from "@aigile/types";
import { createLocalVerifier } from "@aigile/verifier";
import { createGitWorkspaceAdapter, type ExecCommand } from "@aigile/workspace";
import {
  initialWorkflowSnapshot,
  transitionWorkflow,
  type WorkflowSnapshot,
} from "@aigile/workflow";

export interface DemoIssueInput {
  issue: IssueRecord;
}

export interface DemoWithRolesInput extends DemoIssueInput {
  registry: RoleRuntimeRegistry;
  runner: RoleRunner;
  codeHost?: CodeHostAdapter;
  initialArtifacts?: WorkflowArtifact[];
  verificationArtifact?: WorkflowArtifact;
  beforeVerification?: (artifacts: readonly WorkflowArtifact[]) => Promise<WorkflowArtifact[]>;
}

export interface DemoWithAcpRolesInput extends DemoIssueInput {
  connector?: AcpRuntimeConnector;
}

export interface DemoWorkspaceInput extends DemoIssueInput {
  repoPath: string;
  worktreesPath: string;
  baseBranch?: string;
  exec?: ExecCommand;
}

export interface DemoGitHubInput extends DemoIssueInput {
  ghExec: GitHubCliExec;
  cwd?: string;
}

export interface DemoLinearInput {
  issueKey: string;
  linearApiKey: string;
  fetchGraphql?: LinearFetchGraphql;
}

export interface DemoResult {
  issueKey: string;
  finalState: WorkflowState;
  pullRequest: PullRequestRecord;
  artifacts: WorkflowArtifact[];
  timeline: string[];
}

const pushTransition = (
  snapshot: WorkflowSnapshot,
  event: WorkflowEvent,
  timeline: string[],
): WorkflowSnapshot => {
  const result = transitionWorkflow(snapshot, event);
  timeline.push(`${event.type} -> ${result.snapshot.state}`);
  return result.snapshot;
};

const artifactByKind = (
  artifacts: WorkflowArtifact[],
  kind: string,
): WorkflowArtifact => {
  const artifact = artifacts.find((candidate) => candidate.kind === kind);
  if (!artifact) throw new Error(`Missing artifact: ${kind}`);
  return artifact;
};

const workspaceToArtifact = (payload: unknown, issueKey: string): WorkflowArtifact => ({
  id: `workspace:${issueKey}:worktree`,
  kind: "workspace.issue_worktree",
  source: "system",
  payload,
});

const diffToArtifact = (summary: string, issueKey: string): WorkflowArtifact => ({
  id: `workspace:${issueKey}:diff`,
  kind: "workspace.diff",
  source: "system",
  payload: { summary },
});

const createDemoRegistry = (): RoleRuntimeRegistry => createRoleRuntimeRegistry({
  runtimes: [
    { id: "demo-architect", transport: "stdio", command: ["aigile-demo-acp"] },
    { id: "demo-developer", transport: "stdio", command: ["aigile-demo-acp"] },
    { id: "demo-checker", transport: "stdio", command: ["aigile-demo-acp"] },
  ],
  assignments: [
    { roleId: "architect", runtimeProfileId: "demo-architect" },
    { roleId: "developer", runtimeProfileId: "demo-developer" },
    { roleId: "checker", runtimeProfileId: "demo-checker" },
  ],
});

export const runDemoIssueWithRoles = async (input: DemoWithRolesInput): Promise<DemoResult> => {
  const issueTracker = createFakeIssueTrackerAdapter([input.issue]);
  const codeHost = input.codeHost ?? createFakeCodeHostAdapter();
  const issue = await issueTracker.getIssue(input.issue.key);
  const artifacts: WorkflowArtifact[] = [issueToArtifact(issue), ...(input.initialArtifacts ?? [])];
  const timeline: string[] = [];
  let snapshot = initialWorkflowSnapshot(issue.key);

  snapshot = pushTransition(snapshot, {
    type: "issue_received",
    issueId: issue.key,
    artifactId: artifacts[0]!.id,
  }, timeline);

  await issueTracker.updateIssueStatus(issue.key, "planning");
  const plan = await runAssignedRole({
    roleId: "architect",
    issueId: issue.key,
    inputArtifacts: artifacts,
    registry: input.registry,
    runner: input.runner,
  });
  artifacts.push(plan);
  snapshot = pushTransition(snapshot, {
    type: "plan_drafted",
    issueId: issue.key,
    artifactId: plan.id,
  }, timeline);

  snapshot = pushTransition(snapshot, {
    type: "plan_approved",
    issueId: issue.key,
  }, timeline);

  await issueTracker.updateIssueStatus(issue.key, "developing");
  const attempt = await runAssignedRole({
    roleId: "developer",
    issueId: issue.key,
    inputArtifacts: artifacts,
    registry: input.registry,
    runner: input.runner,
  });
  artifacts.push(attempt);
  snapshot = pushTransition(snapshot, {
    type: "developer_finished",
    issueId: issue.key,
    artifactId: attempt.id,
  }, timeline);

  if (input.beforeVerification) {
    artifacts.push(...await input.beforeVerification(artifacts));
  }

  const verification: WorkflowArtifact = input.verificationArtifact ?? {
    id: `verifier:${issue.key}:local-check`,
    kind: "verification.result",
    source: "verifier",
    payload: {
      status: "passed",
      command: "bun run check",
      summary: "Local scripted verifier passed.",
    },
  };
  artifacts.push(verification);
  snapshot = pushTransition(snapshot, {
    type: "verification_passed",
    issueId: issue.key,
    artifactId: verification.id,
  }, timeline);

  const verdict = await runAssignedRole({
    roleId: "checker",
    issueId: issue.key,
    inputArtifacts: artifacts,
    registry: input.registry,
    runner: input.runner,
  });
  artifacts.push(verdict);
  snapshot = pushTransition(snapshot, {
    type: "checker_passed",
    issueId: issue.key,
    artifactId: verdict.id,
  }, timeline);

  artifactByKind(artifacts, "developer.attempt");
  const pullRequest = await codeHost.createPullRequest({
    owner: "aigile",
    repo: "aigile",
    branch: `aigile/${issue.key}`,
    baseBranch: "main",
    title: `${issue.key} ${issue.title}`,
    body: [
      `Plan: ${plan.id}`,
      `Verification: ${verification.id}`,
      `Checker: ${verdict.id}`,
    ].join("\n"),
  });
  await codeHost.recordCheckResult(pullRequest.id, {
    name: "aigile/verifier",
    status: "passed",
    summary: "Local scripted verifier passed.",
  });
  await codeHost.appendPullRequestComment(pullRequest.id, `Checker: ${verdict.id}`);
  const pullRequestArtifact = pullRequestToArtifact(await codeHost.getPullRequest(pullRequest.id));
  artifacts.push(pullRequestArtifact);
  snapshot = pushTransition(snapshot, {
    type: "merge_completed",
    issueId: issue.key,
    artifactId: pullRequestArtifact.id,
  }, timeline);
  await issueTracker.updateIssueStatus(issue.key, "merged");

  return {
    issueKey: issue.key,
    finalState: snapshot.state,
    pullRequest: pullRequestArtifact.payload,
    artifacts,
    timeline,
  };
};

export const createMockAcpConnector = (): AcpRuntimeConnector => async (input) => ({
  session: {
    sessionId: `${input.issueId}:${input.roleId}`,
    acpSessionId: `mock-acp:${input.issueId}:${input.roleId}`,
    prompt: async () => {
      if (input.roleId === "architect") {
        return {
          artifactKind: "architect.plan",
          payload: {
            summary: "Mock ACP architect plan",
            scope: ["local demo"],
            acceptanceCriteria: ["ACP runner is used"],
            verificationCommands: ["bun run check"],
            risks: [],
          },
        };
      }
      if (input.roleId === "developer") {
        return {
          artifactKind: "developer.attempt",
          payload: {
            summary: "Mock ACP developer attempt",
            changedFiles: ["packages/demo/src/run.ts"],
            verificationNotes: "Local scripted verifier will run.",
          },
        };
      }
      if (input.roleId === "checker") {
        return {
          artifactKind: "checker.verdict",
          payload: {
            verdict: "pass",
            summary: "Mock ACP checker passed the change.",
            reasons: [],
          },
        };
      }
      throw new Error(`No mock ACP response for role: ${input.roleId}`);
    },
    cancel: () => undefined,
    onEvent: () => () => undefined,
  },
  process: {
    kill: async () => undefined,
  },
});

export const runDemoIssue = async (input: DemoIssueInput): Promise<DemoResult> => {
  const registry = createDemoRegistry();
  const runner = createScriptedRoleRunner({
    architect: {
      artifactKind: "architect.plan",
      payload: {
        summary: `Plan for ${input.issue.key}: ${input.issue.title}`,
        scope: ["local demo"],
        acceptanceCriteria: input.issue.acceptanceCriteria,
        verificationCommands: ["bun run check"],
        risks: [],
      },
    },
    developer: {
      artifactKind: "developer.attempt",
      payload: {
        summary: "Scripted implementation completed for local demo.",
        changedFiles: ["packages/demo/src/run.ts"],
        verificationNotes: "Local scripted verifier will run.",
      },
    },
    checker: {
      artifactKind: "checker.verdict",
      payload: {
        verdict: "pass",
        summary: "Scripted checker accepts the verified demo change.",
        reasons: [],
      },
    },
  });
  return runDemoIssueWithRoles({ ...input, registry, runner });
};

export const runDemoIssueWithAcpRoles = async (
  input: DemoWithAcpRolesInput,
): Promise<DemoResult> => runDemoIssueWithRoles({
  issue: input.issue,
  registry: createDemoRegistry(),
  runner: createAcpRoleRunner({ connector: input.connector ?? createMockAcpConnector() }),
});

export const runDemoIssueWithWorkspace = async (
  input: DemoWorkspaceInput,
): Promise<DemoResult> => {
  const workspaceOptions = {
    repoPath: input.repoPath,
    worktreesPath: input.worktreesPath,
  };
  const workspaceAdapter = createGitWorkspaceAdapter(input.exec === undefined
    ? workspaceOptions
    : { ...workspaceOptions, exec: input.exec });
  const workspace = await workspaceAdapter.createIssueWorkspace({
    issueKey: input.issue.key,
    baseBranch: input.baseBranch ?? "main",
  });
  const verifier = createLocalVerifier(input.exec === undefined ? {} : { exec: input.exec });
  const verificationArtifact = await verifier.verify({
    issueKey: input.issue.key,
    workspacePath: workspace.worktreePath,
    commands: [["bun", "run", "check"]],
  });

  return runDemoIssueWithRoles({
    issue: input.issue,
    registry: createDemoRegistry(),
    runner: createScriptedRoleRunner({
      architect: {
        artifactKind: "architect.plan",
        payload: {
          summary: `Plan for ${input.issue.key}: ${input.issue.title}`,
          scope: ["local workspace"],
          acceptanceCriteria: input.issue.acceptanceCriteria,
          verificationCommands: ["bun run check"],
          risks: [],
        },
      },
      developer: {
        artifactKind: "developer.attempt",
        payload: {
          summary: "Workspace implementation completed for local demo.",
          changedFiles: ["packages/demo/src/run.ts"],
          verificationNotes: "Verifier runs in the issue worktree.",
        },
      },
      checker: {
        artifactKind: "checker.verdict",
        payload: {
          verdict: "pass",
          summary: "Checker accepts workspace demo artifacts.",
          reasons: [],
        },
      },
    }),
    initialArtifacts: [workspaceToArtifact(workspace, input.issue.key)],
    verificationArtifact,
    beforeVerification: async () => [
      diffToArtifact(await workspaceAdapter.diffSummary(workspace), input.issue.key),
    ],
  });
};

export const runDemoIssueWithGitHub = async (
  input: DemoGitHubInput,
): Promise<DemoResult> => runDemoIssueWithRoles({
  issue: input.issue,
  registry: createDemoRegistry(),
  runner: createScriptedRoleRunner({
    architect: {
      artifactKind: "architect.plan",
      payload: {
        summary: `Plan for ${input.issue.key}: ${input.issue.title}`,
        scope: ["github demo"],
        acceptanceCriteria: input.issue.acceptanceCriteria,
        verificationCommands: ["bun run check"],
        risks: [],
      },
    },
    developer: {
      artifactKind: "developer.attempt",
      payload: {
        summary: "GitHub demo implementation completed.",
        changedFiles: ["packages/demo/src/run.ts"],
        verificationNotes: "Verifier result is represented as PR feedback.",
      },
    },
    checker: {
      artifactKind: "checker.verdict",
      payload: {
        verdict: "pass",
        summary: "Checker accepts GitHub demo artifacts.",
        reasons: [],
      },
    },
  }),
  codeHost: createGitHubCliCodeHostAdapter(input.cwd === undefined
    ? { exec: input.ghExec }
    : { exec: input.ghExec, cwd: input.cwd }),
});

export const runDemoIssueFromLinear = async (
  input: DemoLinearInput,
): Promise<DemoResult> => {
  const issueTracker = createLinearGraphqlIssueTrackerAdapter(input.fetchGraphql === undefined
    ? { apiKey: input.linearApiKey }
    : { apiKey: input.linearApiKey, fetchGraphql: input.fetchGraphql });
  return runDemoIssue({
    issue: await issueTracker.getIssue(input.issueKey),
  });
};
