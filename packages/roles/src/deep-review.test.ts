import { describe, expect, it } from "bun:test";
import {
  syntheticKnownMissAngles,
  syntheticKnownMissDeepReviewFixtures,
} from "./deep-review-known-miss-fixtures.js";
import { runAssignedDeepReview, runDeepReview, type DeepReviewPassResult } from "./deep-review.js";
import type { WorkflowArtifact } from "@aigile/types";

const pass = (
  angle: DeepReviewPassResult["angle"],
  verdict: DeepReviewPassResult["verdict"],
  findings: DeepReviewPassResult["findings"] = [],
): DeepReviewPassResult => ({ angle, verdict, findings, summary: `${angle} ${verdict}` });

describe("deep review", () => {
  it("runs each configured angle independently and aggregates surviving findings", async () => {
    const calls: string[] = [];
    const result = await runDeepReview({
      diff: "diff --git a/packages/workflow/src/reducer.ts b/packages/workflow/src/reducer.ts",
      changedFiles: ["packages/workflow/src/reducer.ts"],
      reviewerModel: "independent-review-model",
      angles: ["correctness", "removed-behavior", "cross-file", "tests-faithful-to-reality"],
      runPass: async ({ angle, reviewerModel }) => {
        calls.push(`${angle}:${reviewerModel}`);
        return pass(angle, angle === "cross-file" ? "changes_requested" : "pass", [
          {
            id: `${angle}-finding`,
            title: `${angle} issue`,
            detail: `${angle} detail`,
            severity: "high",
          },
        ]);
      },
      refuteFinding: async () => ({ survives: true, reason: "grounded" }),
      refutePass: async () => ({ survives: true, reason: "no contradiction" }),
    });

    expect(calls).toEqual([
      "correctness:independent-review-model",
      "removed-behavior:independent-review-model",
      "cross-file:independent-review-model",
      "tests-faithful-to-reality:independent-review-model",
    ]);
    expect(result.verdict).toBe("changes_requested");
    expect(result.findings.map((finding) => finding.id)).toEqual([
      "correctness-finding",
      "removed-behavior-finding",
      "cross-file-finding",
      "tests-faithful-to-reality-finding",
    ]);
  });

  it("drops refuted findings and refuses to green-light a refuted pass", async () => {
    const result = await runDeepReview({
      diff: "diff",
      changedFiles: ["README.md"],
      reviewerModel: "independent-review-model",
      angles: ["correctness", "cross-file"],
      runPass: async ({ angle }) =>
        angle === "correctness"
          ? pass(angle, "changes_requested", [
              {
                id: "false-positive",
                title: "False positive",
                detail: "Not supported by the diff",
                severity: "medium",
              },
            ])
          : pass(angle, "pass"),
      refuteFinding: async () => ({ survives: false, reason: "not supported" }),
      refutePass: async () => ({ survives: false, reason: "misses caller wiring" }),
    });

    expect(result.verdict).toBe("changes_requested");
    expect(result.findings).toEqual([
      {
        id: "refuted-pass:cross-file",
        angle: "cross-file",
        title: "Pass verdict refuted for cross-file",
        detail: "misses caller wiring",
        severity: "medium",
      },
    ]);
    expect(result.refutations.find((entry) => entry.targetId === "false-positive")?.survives).toBe(
      false,
    );
  });

  it("keeps an unstructured non-pass angle from being silently downgraded", async () => {
    const result = await runDeepReview({
      diff: "diff",
      changedFiles: ["packages/workflow/src/engine.ts"],
      reviewerModel: "independent-review-model",
      angles: ["correctness", "cross-file"],
      runPass: async ({ angle }) =>
        angle === "correctness" ? pass(angle, "changes_requested") : pass(angle, "pass"),
      refuteFinding: async () => ({ survives: true, reason: "grounded" }),
      refutePass: async () => ({ survives: true, reason: "no contradiction" }),
    });

    expect(result.verdict).toBe("changes_requested");
    expect(result.findings).toEqual([
      {
        id: "non-pass:correctness",
        angle: "correctness",
        title: "correctness reported changes_requested without structured findings",
        detail: "correctness changes_requested",
        severity: "medium",
      },
    ]);
  });

  it("caps per-angle finding refutations without green-lighting skipped findings", async () => {
    const refutedFindingIds: string[] = [];
    const result = await runDeepReview({
      diff: "diff",
      changedFiles: ["packages/demo/src/run.ts"],
      reviewerModel: "independent-review-model",
      angles: ["correctness", "cross-file"],
      maxFindingsPerAngle: 2,
      runPass: async ({ angle }) =>
        angle === "correctness"
          ? pass(angle, "changes_requested", [
              { id: "f1", title: "Finding one", detail: "detail", severity: "medium" },
              { id: "f2", title: "Finding two", detail: "detail", severity: "medium" },
              { id: "f3", title: "Finding three", detail: "detail", severity: "medium" },
              { id: "f4", title: "Finding four", detail: "detail", severity: "medium" },
            ])
          : pass(angle, "pass"),
      refuteFinding: async ({ finding }) => {
        refutedFindingIds.push(finding.id);
        return { survives: false, reason: "refuted" };
      },
      refutePass: async () => ({ survives: true, reason: "no contradiction" }),
    });

    expect(refutedFindingIds).toEqual(["f1", "f2"]);
    expect(result.verdict).toBe("changes_requested");
    expect(result.findings).toEqual([
      {
        id: "refutation-cap:correctness",
        angle: "correctness",
        title: "2 correctness finding(s) were not refuted",
        detail:
          "Deep review capped per-angle finding refutations to keep the review bounded; unrefuted findings keep the verdict from passing.",
        severity: "medium",
      },
    ]);
  });

  it("orchestrates production deep review through multiple role calls and refutations", async () => {
    const requestModes: string[] = [];
    const progress: string[] = [];
    const artifact = await runAssignedDeepReview({
      issueId: "LIN-1",
      inputArtifacts: [],
      reviewerModel: "independent-review-model",
      deepReviewMode: "full",
      onProgress: (event) =>
        progress.push(
          `${event.mode}:${event.angle}:${event.angleIndex}/${event.angleCount}:${event.sequence}:${event.completedSubcalls}/${event.totalSubcalls}`,
        ),
      runRole: async (roleId, artifacts) => {
        expect(roleId).toBe("deep_reviewer");
        const request = artifacts.at(-1);
        expect(request?.kind).toBe("deep_review.request");
        const payload = request?.payload as { mode: string; angle?: DeepReviewPassResult["angle"] };
        requestModes.push(`${payload.mode}:${payload.angle ?? "none"}`);
        if (payload.mode === "angle_pass") {
          return {
            id: `agent:LIN-1:deep_reviewer:${payload.angle}`,
            kind: "checker.verdict",
            source: "agent",
            producerRoleId: "deep_reviewer",
            payload: {
              verdict: payload.angle === "cross-file" ? "changes_requested" : "pass",
              summary: `${payload.angle} checked`,
              reasons: payload.angle === "cross-file" ? ["missing engine-path wiring"] : [],
            },
          };
        }
        return {
          id: `agent:LIN-1:deep_reviewer:${payload.mode}:${payload.angle}`,
          kind: "checker.verdict",
          source: "agent",
          producerRoleId: "deep_reviewer",
          payload: {
            verdict: "pass",
            summary: "refutation did not disprove the target",
            reasons: [],
          },
        };
      },
    });

    expect(requestModes).toEqual([
      "angle_pass:correctness",
      "angle_pass:removed-behavior",
      "angle_pass:cross-file",
      "angle_pass:tests-faithful-to-reality",
      "refute_pass:correctness",
      "refute_pass:removed-behavior",
      "refute_finding:cross-file",
      "refute_pass:tests-faithful-to-reality",
    ]);
    expect(progress).toEqual([
      "angle_pass:correctness:1/4:1:0/4",
      "angle_pass:removed-behavior:2/4:2:0/4",
      "angle_pass:cross-file:3/4:3:0/4",
      "angle_pass:tests-faithful-to-reality:4/4:4:0/4",
      "refute_pass:correctness:1/4:5:4/8",
      "refute_pass:removed-behavior:2/4:6:5/8",
      "refute_finding:cross-file:3/4:7:6/8",
      "refute_pass:tests-faithful-to-reality:4/4:8:7/8",
    ]);
    expect(artifact.kind).toBe("checker.verdict");
    expect(artifact.producerRoleId).toBe("deep_reviewer");
    expect(artifact.payload).toEqual({
      verdict: "changes_requested",
      summary: "Deep review found 1 surviving issue(s) after refutation.",
      reasons: ["cross-file: missing engine-path wiring"],
    });
  });

  it("runs independent assigned angle passes under the configured concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const unblock: Array<() => void> = [];
    const started: string[] = [];

    const artifactPromise = runAssignedDeepReview({
      issueId: "LIN-1",
      inputArtifacts: [],
      reviewerModel: "independent-review-model",
      angles: ["correctness", "removed-behavior", "cross-file"],
      deepReviewMode: "full",
      angleConcurrency: 2,
      runRole: async (_roleId, artifacts) => {
        const request = artifacts.at(-1);
        const payload = request?.payload as {
          mode: string;
          angle?: DeepReviewPassResult["angle"];
        };
        if (payload.mode === "angle_pass") {
          started.push(payload.angle ?? "none");
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>((resolve) => unblock.push(resolve));
          active -= 1;
        }
        return {
          id: `agent:LIN-1:deep_reviewer:${payload.mode}:${payload.angle}`,
          kind: "checker.verdict",
          source: "agent",
          producerRoleId: "deep_reviewer",
          payload: {
            verdict: "pass",
            summary: `${payload.mode} ${payload.angle}`,
            reasons: [],
          },
        };
      },
    });

    await Promise.resolve();
    expect(started).toEqual(["correctness", "removed-behavior"]);
    expect(maxActive).toBe(2);
    unblock.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["correctness", "removed-behavior", "cross-file"]);
    unblock.splice(0).forEach((resolve) => resolve());

    const artifact = await artifactPromise;
    expect(artifact.payload).toMatchObject({ verdict: "pass" });
    expect(maxActive).toBe(2);
  });

  it("fail-fast stops before remaining angles after a surviving actionable defect", async () => {
    const requestModes: string[] = [];
    const artifact = await runAssignedDeepReview({
      issueId: "LIN-1",
      inputArtifacts: [],
      reviewerModel: "independent-review-model",
      angles: ["correctness", "removed-behavior", "cross-file"],
      deepReviewMode: "fail-fast",
      runRole: async (_roleId, artifacts) => {
        const request = artifacts.at(-1);
        const payload = request?.payload as {
          mode: string;
          angle?: DeepReviewPassResult["angle"];
        };
        requestModes.push(`${payload.mode}:${payload.angle ?? "none"}`);
        return {
          id: `agent:LIN-1:deep_reviewer:${payload.mode}:${payload.angle}`,
          kind: "checker.verdict",
          source: "agent",
          producerRoleId: "deep_reviewer",
          payload: {
            verdict: payload.mode === "angle_pass" ? "changes_requested" : "pass",
            summary: `${payload.mode} ${payload.angle}`,
            reasons: payload.mode === "angle_pass" ? ["real defect"] : [],
          },
        };
      },
    });

    expect(requestModes).toEqual(["angle_pass:correctness", "refute_finding:correctness"]);
    expect(artifact.payload).toMatchObject({
      verdict: "changes_requested",
      reasons: [
        "correctness: real defect",
        "correctness: Deep review stopped early: fail-fast after 1 surviving finding(s)",
      ],
    });
  });

  it("budget exhaustion returns a conservative non-pass verdict", async () => {
    const requestModes: string[] = [];
    const artifact = await runAssignedDeepReview({
      issueId: "LIN-1",
      inputArtifacts: [],
      reviewerModel: "independent-review-model",
      angles: ["correctness", "removed-behavior"],
      maxDeepReviewCalls: 1,
      runRole: async (_roleId, artifacts) => {
        const request = artifacts.at(-1);
        const payload = request?.payload as {
          mode: string;
          angle?: DeepReviewPassResult["angle"];
        };
        requestModes.push(`${payload.mode}:${payload.angle ?? "none"}`);
        return {
          id: `agent:LIN-1:deep_reviewer:${payload.mode}:${payload.angle}`,
          kind: "checker.verdict",
          source: "agent",
          producerRoleId: "deep_reviewer",
          payload: {
            verdict: "pass",
            summary: `${payload.mode} ${payload.angle}`,
            reasons: [],
          },
        };
      },
    });

    expect(requestModes).toEqual(["angle_pass:correctness"]);
    expect(artifact.payload).toMatchObject({
      verdict: "changes_requested",
      reasons: ["correctness: Deep review stopped early: budget reached: maxDeepReviewCalls=1"],
    });
  });

  it("bounds finding refutations globally", async () => {
    const requestModes: string[] = [];
    const artifact = await runAssignedDeepReview({
      issueId: "LIN-1",
      inputArtifacts: [],
      reviewerModel: "independent-review-model",
      angles: ["correctness", "removed-behavior"],
      maxRefutationsTotal: 1,
      maxSurvivingFindings: 10,
      runRole: async (_roleId, artifacts) => {
        const request = artifacts.at(-1);
        const payload = request?.payload as {
          mode: string;
          angle?: DeepReviewPassResult["angle"];
        };
        requestModes.push(`${payload.mode}:${payload.angle ?? "none"}`);
        return {
          id: `agent:LIN-1:deep_reviewer:${payload.mode}:${payload.angle}`,
          kind: "checker.verdict",
          source: "agent",
          producerRoleId: "deep_reviewer",
          payload: {
            verdict: payload.mode === "angle_pass" ? "changes_requested" : "pass",
            summary: `${payload.mode} ${payload.angle}`,
            reasons: payload.mode === "angle_pass" ? ["first defect", "second defect"] : [],
          },
        };
      },
    });

    expect(requestModes).toEqual(["angle_pass:correctness", "refute_finding:correctness"]);
    expect(artifact.payload).toMatchObject({
      verdict: "changes_requested",
    });
    expect((artifact.payload as { reasons: string[] }).reasons).toContain(
      "correctness: Deep review stopped early: budget reached: maxRefutationsTotal=1",
    );
  });

  it("checkpoints assigned subcalls and reuses them on resume", async () => {
    const checkpointed: WorkflowArtifact[] = [];
    let runRoleCalls = 0;
    const first = await runAssignedDeepReview({
      issueId: "LIN-1",
      inputArtifacts: [],
      reviewerModel: "independent-review-model",
      angles: ["correctness", "cross-file"],
      checkpointArtifact: async (artifact) => {
        checkpointed.push(artifact);
      },
      runRole: async (_roleId, artifacts) => {
        runRoleCalls += 1;
        const request = artifacts.at(-1);
        const payload = request?.payload as {
          mode: string;
          angle?: DeepReviewPassResult["angle"];
        };
        return {
          id: `agent:LIN-1:deep_reviewer:${payload.mode}:${payload.angle}`,
          kind: "checker.verdict",
          source: "agent",
          producerRoleId: "deep_reviewer",
          payload: {
            verdict: "pass",
            summary: `${payload.mode} ${payload.angle}`,
            reasons: [],
          },
        };
      },
    });

    expect(first.payload).toMatchObject({ verdict: "pass" });
    expect(runRoleCalls).toBe(4);
    expect(checkpointed.map((artifact) => artifact.kind)).toEqual([
      "deep_review.checkpoint",
      "deep_review.checkpoint",
      "deep_review.checkpoint",
      "deep_review.checkpoint",
    ]);

    const resumed = await runAssignedDeepReview({
      issueId: "LIN-1",
      inputArtifacts: checkpointed,
      reviewerModel: "independent-review-model",
      angles: ["correctness", "cross-file"],
      runRole: async () => {
        throw new Error("checkpointed subcalls should be reused");
      },
    });

    expect(resumed.payload).toEqual(first.payload);
  });

  it("does not reuse checkpointed subcalls after reviewed artifacts change", async () => {
    const attemptOne: WorkflowArtifact = {
      id: "agent:LIN-1:developer:developer.attempt:attempt-1",
      kind: "developer.attempt",
      source: "agent",
      producerRoleId: "developer",
      payload: {
        summary: "first attempt",
        changedFiles: ["packages/demo/src/run.ts"],
        verificationNotes: "not yet fixed",
      },
    };
    const attemptTwo: WorkflowArtifact = {
      ...attemptOne,
      id: "agent:LIN-1:developer:developer.attempt:attempt-2",
      payload: {
        summary: "second attempt",
        changedFiles: ["packages/demo/src/run.ts"],
        verificationNotes: "fixed reviewer finding",
      },
    };
    const checkpointed: WorkflowArtifact[] = [];
    let runRoleCalls = 0;
    const runRole = async (
      _roleId: "deep_reviewer",
      artifacts: readonly WorkflowArtifact[],
    ): Promise<WorkflowArtifact> => {
      runRoleCalls += 1;
      const request = artifacts.at(-1);
      const payload = request?.payload as {
        mode: string;
        angle?: DeepReviewPassResult["angle"];
      };
      return {
        id: `agent:LIN-1:deep_reviewer:${payload.mode}:${payload.angle}:${runRoleCalls}`,
        kind: "checker.verdict",
        source: "agent",
        producerRoleId: "deep_reviewer",
        payload: {
          verdict: "pass",
          summary: `${payload.mode} ${payload.angle}`,
          reasons: [],
        },
      };
    };

    await runAssignedDeepReview({
      issueId: "LIN-1",
      inputArtifacts: [attemptOne],
      reviewerModel: "independent-review-model",
      angles: ["correctness", "cross-file"],
      checkpointArtifact: async (artifact) => {
        checkpointed.push(artifact);
      },
      runRole,
    });
    expect(runRoleCalls).toBe(4);

    runRoleCalls = 0;
    await runAssignedDeepReview({
      issueId: "LIN-1",
      inputArtifacts: [attemptTwo, ...checkpointed],
      reviewerModel: "independent-review-model",
      angles: ["correctness", "cross-file"],
      runRole,
    });

    expect(runRoleCalls).toBe(4);
  });

  // Pipeline test: proves production orchestration aggregates synthetic per-angle
  // reviewer findings into the expected verdict over real recorded diffs. It does NOT
  // prove a real reviewer detects the defect — that is deep-review.smoke.test.ts.
  it("aggregates synthetic known-miss reviewer findings through production orchestration", async () => {
    for (const knownMiss of syntheticKnownMissDeepReviewFixtures) {
      const seenRequestKeys: string[] = [];
      const artifact = await runAssignedDeepReview({
        issueId: knownMiss.name.replace(/[^A-Z0-9]+/gi, "-"),
        inputArtifacts: [
          {
            id: `fixture:${knownMiss.name}:diff`,
            kind: "workspace.diff",
            source: "system",
            payload: {
              source: knownMiss.source,
              changedFiles: knownMiss.changedFiles,
              diff: knownMiss.diff,
            },
          },
        ],
        reviewerModel: "synthetic-independent-review-model",
        angles: syntheticKnownMissAngles,
        runRole: async (_roleId, artifacts) => {
          const request = artifacts.at(-1);
          expect(request?.kind, knownMiss.name).toBe("deep_review.request");
          const payload = request?.payload as {
            mode?: string;
            angle?: DeepReviewPassResult["angle"];
          };
          const requestKey = `${payload.mode}:${payload.angle}`;
          seenRequestKeys.push(requestKey);
          const syntheticPayload = knownMiss.syntheticReviewerOutputs[requestKey];
          if (syntheticPayload === undefined) {
            throw new Error(`${knownMiss.name} fixture missing reviewer output for ${requestKey}`);
          }
          return {
            id: `fixture:${knownMiss.name}:${requestKey}`,
            kind: "checker.verdict",
            source: "agent",
            producerRoleId: "deep_reviewer",
            payload: syntheticPayload,
          };
        },
      });

      expect(knownMiss.diff.startsWith("diff --git"), knownMiss.name).toBe(true);
      expect(knownMiss.changedFiles.length, knownMiss.name).toBeGreaterThan(0);
      expect(seenRequestKeys, knownMiss.name).toContain("angle_pass:correctness");
      expect(
        seenRequestKeys.some((requestKey) => requestKey.startsWith("refute_finding:")),
        knownMiss.name,
      ).toBe(true);
      expect(artifact.payload, knownMiss.name).toMatchObject({
        verdict: "changes_requested",
      });
      expect(
        (artifact.payload as { reasons: string[] }).reasons.some((reason) =>
          reason.includes(knownMiss.expectedFinding),
        ),
        knownMiss.name,
      ).toBe(true);
    }
  });
});
