import {
  createFakeCodeHostAdapter,
  createFakeIssueTrackerAdapter,
  issueToArtifact,
  pullRequestToArtifact,
  type IssueRecord,
  type PullRequestRecord,
} from "@aigile/adapters";
import {
  createRoleRuntimeRegistry,
  createScriptedRoleRunner,
  runAssignedRole,
} from "@aigile/roles";
import type { WorkflowArtifact, WorkflowEvent, WorkflowState } from "@aigile/types";
import {
  initialWorkflowSnapshot,
  transitionWorkflow,
  type WorkflowSnapshot,
} from "@aigile/workflow";

export interface DemoIssueInput {
  issue: IssueRecord;
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

export const runDemoIssue = async (input: DemoIssueInput): Promise<DemoResult> => {
  const issueTracker = createFakeIssueTrackerAdapter([input.issue]);
  const codeHost = createFakeCodeHostAdapter();
  const issue = await issueTracker.getIssue(input.issue.key);
  const artifacts: WorkflowArtifact[] = [issueToArtifact(issue)];
  const timeline: string[] = [];
  let snapshot = initialWorkflowSnapshot(issue.key);

  const registry = createRoleRuntimeRegistry({
    runtimes: [
      { id: "scripted-architect", transport: "stdio", command: ["scripted-acp"] },
      { id: "scripted-developer", transport: "stdio", command: ["scripted-acp"] },
      { id: "scripted-checker", transport: "stdio", command: ["scripted-acp"] },
    ],
    assignments: [
      { roleId: "architect", runtimeProfileId: "scripted-architect" },
      { roleId: "developer", runtimeProfileId: "scripted-developer" },
      { roleId: "checker", runtimeProfileId: "scripted-checker" },
    ],
  });
  const runner = createScriptedRoleRunner({
    architect: {
      artifactKind: "architect.plan",
      payload: {
        summary: `Plan for ${issue.key}: ${issue.title}`,
        verificationCommands: ["bun run check"],
      },
    },
    developer: {
      artifactKind: "developer.attempt",
      payload: {
        branch: `aigile/${issue.key}`,
        summary: "Scripted implementation completed for local demo.",
      },
    },
    checker: {
      artifactKind: "checker.verdict",
      payload: {
        verdict: "pass",
        summary: "Scripted checker accepts the verified demo change.",
      },
    },
  });

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
    registry,
    runner,
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
    registry,
    runner,
  });
  artifacts.push(attempt);
  snapshot = pushTransition(snapshot, {
    type: "developer_finished",
    issueId: issue.key,
    artifactId: attempt.id,
  }, timeline);

  const verification: WorkflowArtifact = {
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
    registry,
    runner,
  });
  artifacts.push(verdict);
  snapshot = pushTransition(snapshot, {
    type: "checker_passed",
    issueId: issue.key,
    artifactId: verdict.id,
  }, timeline);

  const attemptPayload = artifactByKind(artifacts, "developer.attempt").payload as { branch: string };
  const pullRequest = await codeHost.createPullRequest({
    owner: "aigile",
    repo: "aigile",
    branch: attemptPayload.branch,
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
