import type { CheckerVerdictPayload } from "@aigile/types";
import type { DeepReviewAngle } from "./deep-review.js";

// IMPORTANT: `syntheticReviewerOutputs` are hand-authored, NOT captured from a real
// model. They exercise the deep-review ORCHESTRATION (multi-pass + refutation +
// aggregation) on real recorded diffs, and prove the pipeline surfaces a finding the
// reviewer reports. They do NOT prove a real reviewer DETECTS the defect from the diff
// — that is the job of the opt-in live smoke (deep-review.smoke.test.ts,
// AIGILE_REAL_DEEP_REVIEW_SMOKE=1), which runs the real deep_reviewer against these
// same diffs. Pipeline correctness here; detection there.
export interface KnownMissDeepReviewFixture {
  name: string;
  source: string;
  changedFiles: readonly string[];
  diff: string;
  expectedFinding: string;
  syntheticReviewerOutputs: Record<string, CheckerVerdictPayload>;
}

const pass = (summary: string): CheckerVerdictPayload => ({
  verdict: "pass",
  summary,
  reasons: [],
});

const changesRequested = (summary: string, reasons: readonly string[]): CheckerVerdictPayload => ({
  verdict: "changes_requested",
  summary,
  reasons: [...reasons],
});

const survivingFinding = (reason: string): CheckerVerdictPayload =>
  pass(`Refutation did not disprove the finding: ${reason}`);

export const syntheticKnownMissDeepReviewFixtures: readonly KnownMissDeepReviewFixture[] = [
  {
    name: "LBE-33 engine-path wiring",
    source: "PR #41 patch 1, before the follow-up engine-path fix",
    changedFiles: ["packages/demo/src/run.ts", "packages/demo/src/workspace-run.test.ts"],
    diff: String.raw`diff --git a/packages/demo/src/run.ts b/packages/demo/src/run.ts
index a4207c0..54646e6 100644
--- a/packages/demo/src/run.ts
+++ b/packages/demo/src/run.ts
@@ -220,6 +220,32 @@ const executionPolicyToArtifact = (issueKey: string, dryRun: boolean): WorkflowA
+const checkerReviewPolicyToArtifact = (issueKey: string): WorkflowArtifact => ({
+  id: \`policy:\${issueKey}:review\`,
+  kind: "execution.policy",
+  source: "system",
+  payload: {
+    mode: "review",
+    fileWrites: "forbidden",
+    commits: "forbidden",
+    pushes: "forbidden",
+    pullRequests: "forbidden",
+    shellCommands: "review_read_only",
+  },
+});
+
+const checkerInputArtifacts = (artifacts: readonly WorkflowArtifact[], issueKey: string) =>
+  artifacts.map((artifact) =>
+    artifact.kind === "execution.policy" ? checkerReviewPolicyToArtifact(issueKey) : artifact,
+  );
+
 const checkerEventForVerdict = (artifact: WorkflowArtifact): WorkflowEvent["type"] => {
@@ -551,7 +577,7 @@ export const runDemoIssueWithRoles = async (input: DemoWithRolesInput): Promise<
   const verdict = await runAssignedRole({
     roleId: "checker",
     issueId: issue.key,
-    inputArtifacts: artifacts,
+    inputArtifacts: checkerInputArtifacts(artifacts, issue.key),
     registry: input.registry,
     runner: input.runner,
   });
@@ -977,7 +977,7 @@ export const runWorkspaceIssueWithEngine = async (
     },
     codeHost,
     runRole: (roleId, inputArtifacts) =>
-      runAssignedRole({ roleId, issueId: input.issue.key, inputArtifacts, registry, runner }),
+      runAssignedRole({ roleId, issueId: input.issue.key, inputArtifacts, registry, runner }),
     verify: async () =>
       verifier.verify({`,
    expectedFinding: "engine path checker policy",
    syntheticReviewerOutputs: {
      "angle_pass:correctness": pass("Legacy demo checker policy wiring is coherent."),
      "refute_pass:correctness": pass("No correctness contradiction found in the legacy path."),
      "angle_pass:removed-behavior": pass("No removed behavior found in the touched legacy path."),
      "refute_pass:removed-behavior": pass("No removed-behavior miss found."),
      "angle_pass:cross-file": changesRequested("The diff updates only the legacy role path.", [
        "engine path checker policy is not applied in runWorkspaceIssueWithEngine",
      ]),
      "refute_finding:cross-file": survivingFinding(
        "runWorkspaceIssueWithEngine still forwards inputArtifacts unchanged",
      ),
      "angle_pass:tests-faithful-to-reality": pass(
        "The supplied tests cover legacy handoff policy mode only.",
      ),
      "refute_pass:tests-faithful-to-reality": pass(
        "The cross-file pass already captured the missing engine-path assertion.",
      ),
    },
  },
  {
    name: "LBE-41 invalid gh --json merged field",
    source: "PR #39 hotfix evidence, replayed as the previously missed bad adapter behavior",
    changedFiles: [
      "packages/adapters/src/github-cli.ts",
      "packages/adapters/src/github-cli.test.ts",
    ],
    diff: String.raw`diff --git a/packages/adapters/src/github-cli.ts b/packages/adapters/src/github-cli.ts
index 3862ebf..6654493 100644
--- a/packages/adapters/src/github-cli.ts
+++ b/packages/adapters/src/github-cli.ts
@@ -332,7 +332,15 @@ export const createGitHubCliCodeHostAdapter = (
     getPullRequestMergeState: async (id) => {
       const result = await options.exec(
         "gh",
-        ["pr", "view", prNumberFromId(id), "--repo", repoFromId(id), "--json", "state,mergedAt"],
+        [
+          "pr",
+          "view",
+          prNumberFromId(id),
+          "--repo",
+          repoFromId(id),
+          "--json",
+          "state,merged,mergedAt",
+        ],
         execOptions(options.cwd),
       );
@@ -416,7 +424,7 @@ export const createGitHubCliCodeHostAdapter = (
      const repo = \`\${target.owner}/\${target.repo}\`;
       const result = await options.exec(
         "gh",
-        ["pr", "view", branch, "--repo", repo, "--json", "number,url,state"],
+        ["pr", "view", branch, "--repo", repo, "--json", "number,url,state,merged"],
         execOptions(options.cwd),
       );`,
    expectedFinding: "invalid gh --json merged field",
    syntheticReviewerOutputs: {
      "angle_pass:correctness": changesRequested("The adapter asks gh for unsupported fields.", [
        "invalid gh --json merged field will make gh pr view fail at runtime",
      ]),
      "refute_finding:correctness": survivingFinding(
        "current gh pr view supports state and mergedAt here, but not merged",
      ),
      "angle_pass:removed-behavior": pass("No removed behavior is needed to identify this miss."),
      "refute_pass:removed-behavior": pass("No removed-behavior issue found."),
      "angle_pass:cross-file": pass("Callers consume normalized merge state and branch PR lookup."),
      "refute_pass:cross-file": pass("The adapter-level field list is the root defect."),
      "angle_pass:tests-faithful-to-reality": changesRequested(
        "The test fixture models gh returning a field real gh rejects.",
        ["tests are not faithful to reality for gh --json merged"],
      ),
      "refute_finding:tests-faithful-to-reality": survivingFinding(
        "the fake stdout includes merged even though gh rejects the requested field first",
      ),
    },
  },
  {
    name: "Blocked-label crash",
    source: "PR #39 hotfix evidence, replayed as the previously missed status-sync crash",
    changedFiles: ["packages/demo/src/status-sync.ts"],
    diff: String.raw`diff --git a/packages/demo/src/status-sync.ts b/packages/demo/src/status-sync.ts
index 7da978c..478c26c 100644
--- a/packages/demo/src/status-sync.ts
+++ b/packages/demo/src/status-sync.ts
@@ -78,45 +78,37 @@ export const syncIssueStatusForState = async (input: {
   originalStatus?: string | undefined;
   artifacts?: readonly WorkflowArtifact[] | undefined;
   reason?: string | undefined;
-  onError?: ((error: unknown, state: WorkflowState, status: string) => void) | undefined;
 }): Promise<void> => {
   if (input.issueTracker === undefined) return;
-  const tracker = input.issueTracker;
   const labels: IssueStatusLabels = {
     ...DEFAULT_ISSUE_STATUS_LABELS,
     ...(input.issueStatusLabels ?? {}),
   };
-  const status = issueStatusLabelForState(input.state, labels, input.originalStatus);
-  try {
-    await tracker.updateIssueStatus(input.issueKey, status);
+  await input.issueTracker.updateIssueStatus(
+    input.issueKey,
+    issueStatusLabelForState(input.state, labels, input.originalStatus),
+  );
 
-    const artifacts = input.artifacts ?? [];
-    const pullRequestArtifact = artifacts.find(
-      (artifact) => artifact.kind === "github.pull_request",
-    );
-    const pullRequest =
-      pullRequestArtifact?.payload !== undefined
-        ? (pullRequestArtifact.payload as PullRequestRecord)
-        : undefined;
-    if (input.state === "satisfied") {
-      await tracker.appendIssueComment(input.issueKey, formatSatisfiedStatusComment(input.state, artifacts));
-    } else if ((input.state === "merged" || input.state === "merge_ready") && pullRequest) {
-      await tracker.appendIssueComment(input.issueKey, formatPublishedStatusComment(input.state, pullRequest, artifacts));
-    } else if (input.state === "escalated" || input.state === "failed") {
-      await tracker.appendIssueComment(input.issueKey, formatPullRequestBlockedComment(pullRequest, input.reason, artifacts));
-    }
-  } catch (error) {
-    input.onError?.(error, input.state, status);
-  }
+  const artifacts = input.artifacts ?? [];
+  const pullRequestArtifact = artifacts.find((artifact) => artifact.kind === "github.pull_request");
+  const pullRequest =
+    pullRequestArtifact?.payload !== undefined
+      ? (pullRequestArtifact.payload as PullRequestRecord)
+      : undefined;
+  if (input.state === "escalated" || input.state === "failed") {
+    await input.issueTracker.appendIssueComment(
+      input.issueKey,
+      formatPullRequestBlockedComment(pullRequest, input.reason, artifacts),
+    );
+  }
 };`,
    expectedFinding: "Blocked status may be absent",
    syntheticReviewerOutputs: {
      "angle_pass:correctness": changesRequested(
        "Status sync now lets tracker failures crash runs.",
        ["Blocked status may be absent and updateIssueStatus can reject"],
      ),
      "refute_finding:correctness": survivingFinding(
        "Linear workflow state names are team-local and Blocked is only a default label",
      ),
      "angle_pass:removed-behavior": changesRequested(
        "The best-effort status-sync guard and onError hook are removed.",
        ["removed best-effort handling for unresolvable status labels"],
      ),
      "refute_finding:removed-behavior": survivingFinding(
        "the new body awaits updateIssueStatus outside any catch",
      ),
      "angle_pass:cross-file": pass("Callers treat status sync as terminal bookkeeping."),
      "refute_pass:cross-file": pass("The correctness pass already captures the runtime crash."),
      "angle_pass:tests-faithful-to-reality": changesRequested(
        "The tests need a tracker that rejects an unknown workflow state.",
        ["tests must model Linear rejecting nonexistent Blocked state"],
      ),
      "refute_finding:tests-faithful-to-reality": survivingFinding(
        "real Linear rejects a status label without a workflow state id",
      ),
    },
  },
  {
    name: "PR #31 merged-PR mergeability",
    source: "PR #31 review finding, replayed against the originally risky sync logic",
    changedFiles: ["packages/cli/src/main.ts", "packages/demo/src/run.ts"],
    diff: String.raw`diff --git a/packages/cli/src/main.ts b/packages/cli/src/main.ts
index 41fbba1..bad31 100755
--- a/packages/cli/src/main.ts
+++ b/packages/cli/src/main.ts
@@ -816,14 +816,16 @@ const syncLinearIssueWorkflowResult = async (
 ): Promise<DemoResult> => {
   if (input.dryRun === true) return result;
   const shouldSyncSatisfied = result.finalState === "satisfied";
   const shouldSyncPublished = input.publish === true && result.finalState === "merged";
   if (!shouldSyncSatisfied && !shouldSyncPublished) return result;
 
   const mergeabilityStatus = shouldSyncPublished
     ? await getPublishedMergeabilityStatus(codeHost ?? input.codeHost, result)
     : "mergeable";
   const syncResult =
     mergeabilityStatus === "mergeable" ? result : publishedResultBlockedByMergeability(result);
 
   if (input.teamKey !== undefined && mergeabilityStatus === "mergeable") {
     await tracker.updateIssueStatus(input.issueKey, issueStatusLabels.done);
   }`,
    expectedFinding: "merged pull request mergeability",
    syntheticReviewerOutputs: {
      "angle_pass:correctness": changesRequested(
        "Merged PR status sync still queries mergeability and treats unknown as blocked.",
        ["merged pull request mergeability is unknown after merge and must not block Done sync"],
      ),
      "refute_finding:correctness": survivingFinding(
        "GitHub stops computing mergeability after merge, so merged PRs commonly report unknown",
      ),
      "angle_pass:removed-behavior": pass("No removed behavior needed for this finding."),
      "refute_pass:removed-behavior": pass("The correctness finding is sufficient."),
      "angle_pass:cross-file": changesRequested(
        "The CLI and demo final-state mapping disagree for merged published runs.",
        ["merged published runs can be converted to escalated by post-sync mergeability checks"],
      ),
      "refute_finding:cross-file": survivingFinding(
        "publishedResultBlockedByMergeability rewrites the final result after successful merge",
      ),
      "angle_pass:tests-faithful-to-reality": changesRequested(
        "Tests must model merged PR mergeability as unavailable/unknown.",
        ["fakes should not return mergeable for already merged pull requests"],
      ),
      "refute_finding:tests-faithful-to-reality": survivingFinding(
        "the real GitHub adapter surfaces merged PR mergeability as unknown",
      ),
    },
  },
];

export const syntheticKnownMissAngles: readonly DeepReviewAngle[] = [
  "correctness",
  "removed-behavior",
  "cross-file",
  "tests-faithful-to-reality",
];
