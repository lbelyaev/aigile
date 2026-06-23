import {
  isCheckerVerdictPayload,
  type CheckerVerdictPayload,
  type WorkflowArtifact,
} from "@aigile/types";

export const DEEP_REVIEW_ANGLES = [
  "correctness",
  "removed-behavior",
  "cross-file",
  "tests-faithful-to-reality",
] as const;

export type DeepReviewAngle = (typeof DEEP_REVIEW_ANGLES)[number];

export type DeepReviewFindingSeverity = "low" | "medium" | "high";

export interface DeepReviewFinding {
  id: string;
  title: string;
  detail: string;
  severity: DeepReviewFindingSeverity;
}

export interface DeepReviewSurvivingFinding extends DeepReviewFinding {
  angle: DeepReviewAngle;
}

export interface DeepReviewPassResult {
  angle: DeepReviewAngle;
  verdict: "pass" | "changes_requested" | "escalate";
  summary: string;
  findings: readonly DeepReviewFinding[];
}

export interface DeepReviewPassInput {
  angle: DeepReviewAngle;
  diff: string;
  changedFiles: readonly string[];
  reviewerModel: string;
}

export interface DeepReviewRefutationResult {
  survives: boolean;
  reason: string;
}

export interface DeepReviewFindingRefutationInput extends DeepReviewPassInput {
  finding: DeepReviewFinding;
  pass: DeepReviewPassResult;
}

export interface DeepReviewPassRefutationInput extends DeepReviewPassInput {
  pass: DeepReviewPassResult;
}

export interface DeepReviewInput {
  diff: string;
  changedFiles: readonly string[];
  reviewerModel: string;
  angles?: readonly DeepReviewAngle[];
  runPass: (input: DeepReviewPassInput) => Promise<DeepReviewPassResult>;
  refuteFinding: (input: DeepReviewFindingRefutationInput) => Promise<DeepReviewRefutationResult>;
  refutePass: (input: DeepReviewPassRefutationInput) => Promise<DeepReviewRefutationResult>;
}

export interface DeepReviewRefutationRecord {
  targetId: string;
  angle: DeepReviewAngle;
  targetType: "finding" | "pass";
  survives: boolean;
  reason: string;
}

export interface DeepReviewVerdictPayload {
  verdict: "pass" | "changes_requested" | "escalate";
  summary: string;
  reasons: string[];
  reviewerModel: string;
  passResults: DeepReviewPassResult[];
  findings: DeepReviewSurvivingFinding[];
  refutations: DeepReviewRefutationRecord[];
}

const refutedPassFinding = (
  pass: DeepReviewPassResult,
  refutation: DeepReviewRefutationResult,
): DeepReviewSurvivingFinding => ({
  id: `refuted-pass:${pass.angle}`,
  angle: pass.angle,
  title: `Pass verdict refuted for ${pass.angle}`,
  detail: refutation.reason,
  severity: "medium",
});

const nonPassWithoutFinding = (pass: DeepReviewPassResult): DeepReviewSurvivingFinding => ({
  id: `non-pass:${pass.angle}`,
  angle: pass.angle,
  title: `${pass.angle} reported ${pass.verdict} without structured findings`,
  detail: pass.summary,
  severity: pass.verdict === "escalate" ? "high" : "medium",
});

const verdictFor = (
  passResults: readonly DeepReviewPassResult[],
  findings: readonly DeepReviewSurvivingFinding[],
): DeepReviewVerdictPayload["verdict"] => {
  if (passResults.some((pass) => pass.verdict === "escalate")) return "escalate";
  return findings.length > 0 ? "changes_requested" : "pass";
};

export const runDeepReview = async (input: DeepReviewInput): Promise<DeepReviewVerdictPayload> => {
  const angles = input.angles ?? DEEP_REVIEW_ANGLES;
  if (angles.length < 2) {
    throw new Error("Deep review requires at least two independent angle passes");
  }
  const passResults: DeepReviewPassResult[] = [];
  const findings: DeepReviewSurvivingFinding[] = [];
  const refutations: DeepReviewRefutationRecord[] = [];

  for (const angle of angles) {
    const passInput: DeepReviewPassInput = {
      angle,
      diff: input.diff,
      changedFiles: input.changedFiles,
      reviewerModel: input.reviewerModel,
    };
    const pass = await input.runPass(passInput);
    passResults.push(pass);

    for (const finding of pass.findings) {
      const refutation = await input.refuteFinding({ ...passInput, pass, finding });
      refutations.push({
        targetId: finding.id,
        angle,
        targetType: "finding",
        survives: refutation.survives,
        reason: refutation.reason,
      });
      if (refutation.survives) findings.push({ ...finding, angle });
    }

    if (pass.verdict === "pass") {
      const refutation = await input.refutePass({ ...passInput, pass });
      refutations.push({
        targetId: `pass:${angle}`,
        angle,
        targetType: "pass",
        survives: refutation.survives,
        reason: refutation.reason,
      });
      if (!refutation.survives) findings.push(refutedPassFinding(pass, refutation));
    } else if (pass.findings.length === 0) {
      findings.push(nonPassWithoutFinding(pass));
    }
  }

  const verdict = verdictFor(passResults, findings);
  return {
    verdict,
    summary:
      verdict === "pass"
        ? "Deep review found no surviving issues after refutation."
        : `Deep review found ${findings.length} surviving issue(s) after refutation.`,
    reasons: findings.map((finding) => `${finding.angle}: ${finding.title}`),
    reviewerModel: input.reviewerModel,
    passResults,
    findings,
    refutations,
  };
};

export interface RunAssignedDeepReviewInput {
  issueId: string;
  inputArtifacts: readonly WorkflowArtifact[];
  reviewerModel?: string;
  angles?: readonly DeepReviewAngle[];
  runRole: (
    roleId: "deep_reviewer",
    inputArtifacts: readonly WorkflowArtifact[],
  ) => Promise<WorkflowArtifact>;
}

const requestArtifact = (
  issueId: string,
  sequence: number,
  payload: Record<string, unknown>,
): WorkflowArtifact => ({
  id: `deep-review:${issueId}:${sequence}`,
  kind: "deep_review.request",
  source: "system",
  payload,
});

const requireCheckerPayload = (artifact: WorkflowArtifact): CheckerVerdictPayload => {
  if (!isCheckerVerdictPayload(artifact.payload)) {
    throw new Error(`Deep review role returned invalid checker verdict: ${artifact.id}`);
  }
  return artifact.payload;
};

const findingSeverity = (payload: CheckerVerdictPayload): DeepReviewFindingSeverity =>
  payload.verdict === "escalate" ? "high" : "medium";

const passResultFromArtifact = (
  angle: DeepReviewAngle,
  artifact: WorkflowArtifact,
): DeepReviewPassResult => {
  const payload = requireCheckerPayload(artifact);
  return {
    angle,
    verdict: payload.verdict,
    summary: payload.summary,
    findings:
      payload.verdict === "pass"
        ? []
        : payload.reasons.map((reason, index) => ({
            id: `${angle}:${index + 1}`,
            title: reason,
            detail: payload.summary,
            severity: findingSeverity(payload),
          })),
  };
};

const refutationReason = (payload: CheckerVerdictPayload): string =>
  [payload.summary, ...payload.reasons].filter((line) => line.trim().length > 0).join(" ");

export const runAssignedDeepReview = async (
  input: RunAssignedDeepReviewInput,
): Promise<WorkflowArtifact> => {
  let sequence = 0;
  const reviewerModel = input.reviewerModel ?? "configured-deep-reviewer-runtime";
  const result = await runDeepReview({
    diff: "",
    changedFiles: [],
    reviewerModel,
    ...(input.angles === undefined ? {} : { angles: input.angles }),
    runPass: async ({ angle }) =>
      passResultFromArtifact(
        angle,
        await input.runRole("deep_reviewer", [
          ...input.inputArtifacts,
          requestArtifact(input.issueId, ++sequence, {
            mode: "angle_pass",
            angle,
            reviewerModel,
            instructions:
              "Run only this independent deep-review angle. Return checker.verdict: pass only if this angle finds no issues, changes_requested for grounded defects, escalate for uncertainty requiring human attention.",
          }),
        ]),
      ),
    refuteFinding: async ({ angle, finding, pass }) => {
      const payload = requireCheckerPayload(
        await input.runRole("deep_reviewer", [
          ...input.inputArtifacts,
          requestArtifact(input.issueId, ++sequence, {
            mode: "refute_finding",
            angle,
            finding,
            pass,
            reviewerModel,
            instructions:
              "Adversarially try to disprove this finding. Return checker.verdict pass only if the finding survives refutation and should still count; return changes_requested if the refutation succeeds and the finding should be dropped; return escalate if the evidence is too ambiguous.",
          }),
        ]),
      );
      return { survives: payload.verdict === "pass", reason: refutationReason(payload) };
    },
    refutePass: async ({ angle, pass }) => {
      const payload = requireCheckerPayload(
        await input.runRole("deep_reviewer", [
          ...input.inputArtifacts,
          requestArtifact(input.issueId, ++sequence, {
            mode: "refute_pass",
            angle,
            pass,
            reviewerModel,
            instructions:
              "Adversarially try to disprove this pass verdict by looking for missed issues. Return checker.verdict pass only if the pass verdict survives refutation; return changes_requested if you found a missed issue; return escalate if the evidence is too ambiguous.",
          }),
        ]),
      );
      return { survives: payload.verdict === "pass", reason: refutationReason(payload) };
    },
  });

  return {
    id: `agent:${input.issueId}:deep_reviewer:checker.verdict`,
    kind: "checker.verdict",
    source: "agent",
    producerRoleId: "deep_reviewer",
    payload: {
      verdict: result.verdict,
      summary: result.summary,
      reasons: result.reasons,
    },
  };
};
