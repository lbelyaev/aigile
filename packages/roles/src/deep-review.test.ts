import { describe, expect, it } from "bun:test";
import {
  syntheticKnownMissAngles,
  syntheticKnownMissDeepReviewFixtures,
} from "./deep-review-known-miss-fixtures.js";
import { runAssignedDeepReview, runDeepReview, type DeepReviewPassResult } from "./deep-review.js";

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

  it("orchestrates production deep review through multiple role calls and refutations", async () => {
    const requestModes: string[] = [];
    const artifact = await runAssignedDeepReview({
      issueId: "LIN-1",
      inputArtifacts: [],
      reviewerModel: "independent-review-model",
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
      "refute_pass:correctness",
      "angle_pass:removed-behavior",
      "refute_pass:removed-behavior",
      "angle_pass:cross-file",
      "refute_finding:cross-file",
      "angle_pass:tests-faithful-to-reality",
      "refute_pass:tests-faithful-to-reality",
    ]);
    expect(artifact.kind).toBe("checker.verdict");
    expect(artifact.producerRoleId).toBe("deep_reviewer");
    expect(artifact.payload).toEqual({
      verdict: "changes_requested",
      summary: "Deep review found 1 surviving issue(s) after refutation.",
      reasons: ["cross-file: missing engine-path wiring"],
    });
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
