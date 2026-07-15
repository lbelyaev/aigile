import { createHash } from "node:crypto";
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
  maxFindingsPerAngle?: number;
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

const skippedFindingsFinding = (
  pass: DeepReviewPassResult,
  skippedCount: number,
): DeepReviewSurvivingFinding => ({
  id: `refutation-cap:${pass.angle}`,
  angle: pass.angle,
  title: `${skippedCount} ${pass.angle} finding(s) were not refuted`,
  detail:
    "Deep review capped per-angle finding refutations to keep the review bounded; unrefuted findings keep the verdict from passing.",
  severity: pass.verdict === "escalate" ? "high" : "medium",
});

const stoppedFinding = (
  angle: DeepReviewAngle,
  reason: string,
  id = "deep-review-stopped",
): DeepReviewSurvivingFinding => ({
  id,
  angle,
  title: `Deep review stopped early: ${reason}`,
  detail: reason,
  severity: "medium",
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
  const maxFindingsPerAngle = input.maxFindingsPerAngle ?? 2;
  if (
    !Number.isInteger(maxFindingsPerAngle) ||
    maxFindingsPerAngle < 0 ||
    maxFindingsPerAngle > 10
  ) {
    throw new Error("Deep review maxFindingsPerAngle must be an integer between 0 and 10");
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

    for (const finding of pass.findings.slice(0, maxFindingsPerAngle)) {
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
    const skippedFindings = pass.findings.length - maxFindingsPerAngle;
    if (skippedFindings > 0) findings.push(skippedFindingsFinding(pass, skippedFindings));

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
  deepReviewMode?: "fail-fast" | "bounded" | "full";
  maxDeepReviewCalls?: number;
  maxDeepReviewMinutes?: number;
  maxSurvivingFindings?: number;
  maxFindingsPerAngle?: number;
  maxRefutationsTotal?: number;
  angleConcurrency?: number;
  onProgress?: (event: DeepReviewProgressEvent) => void;
  checkpointArtifact?: (artifact: WorkflowArtifact) => Promise<void>;
  runRole: (
    roleId: "deep_reviewer",
    inputArtifacts: readonly WorkflowArtifact[],
  ) => Promise<WorkflowArtifact>;
}

export interface DeepReviewProgressEvent {
  type: "deep_review_step";
  issueId: string;
  mode: "angle_pass" | "refute_finding" | "refute_pass";
  angle: DeepReviewAngle;
  angleIndex: number;
  angleCount: number;
  sequence: number;
  completedSubcalls?: number;
  totalSubcalls?: number;
  elapsedMs?: number;
  findingId?: string;
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

const DEEP_REVIEW_CHECKPOINT_KIND = "deep_review.checkpoint";

interface DeepReviewCheckpointPayload {
  reviewScope: string;
  mode: "angle_pass" | "refute_finding" | "refute_pass";
  angle: DeepReviewAngle;
  findingId?: string;
  result: WorkflowArtifact;
}

const checkpointKey = (
  reviewScope: string,
  mode: DeepReviewCheckpointPayload["mode"],
  angle: DeepReviewAngle,
  findingId?: string,
): string => `${reviewScope}:${mode}:${angle}:${findingId ?? "pass"}`;

const deepReviewScope = (artifacts: readonly WorkflowArtifact[]): string => {
  const scopedIds = artifacts
    .filter((artifact) => artifact.kind !== DEEP_REVIEW_CHECKPOINT_KIND)
    .map((artifact) => artifact.id)
    .sort();
  return createHash("sha256").update(JSON.stringify(scopedIds)).digest("hex").slice(0, 16);
};

const isDeepReviewCheckpointPayload = (value: unknown): value is DeepReviewCheckpointPayload => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const payload = value as Partial<DeepReviewCheckpointPayload>;
  return (
    (payload.mode === "angle_pass" ||
      payload.mode === "refute_finding" ||
      payload.mode === "refute_pass") &&
    DEEP_REVIEW_ANGLES.includes(payload.angle as DeepReviewAngle) &&
    typeof payload.reviewScope === "string" &&
    typeof payload.result === "object" &&
    payload.result !== null &&
    !Array.isArray(payload.result)
  );
};

const checkpointArtifact = (
  issueId: string,
  payload: DeepReviewCheckpointPayload,
): WorkflowArtifact<DeepReviewCheckpointPayload> => ({
  id: `deep-review:${issueId}:${checkpointKey(
    payload.reviewScope,
    payload.mode,
    payload.angle,
    payload.findingId,
  )}`,
  kind: DEEP_REVIEW_CHECKPOINT_KIND,
  source: "system",
  payload,
});

const boundedConcurrency = (requested: number | undefined, itemCount: number): number => {
  const resolved = requested ?? itemCount;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error("Deep review angle concurrency must be a positive integer");
  }
  return Math.min(resolved, Math.max(1, itemCount));
};

const mapWithConcurrency = async <TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  worker: (value: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> => {
  const results = new Array<TOutput>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) continue;
      results[index] = await worker(value, index);
    }
  });
  await Promise.all(workers);
  return results;
};

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
  const angles = input.angles ?? DEEP_REVIEW_ANGLES;
  if (angles.length < 2) throw new Error("Deep review requires at least two angles");
  const deepReviewMode = input.deepReviewMode ?? "bounded";
  const maxFindingsPerAngle = input.maxFindingsPerAngle ?? 2;
  const maxSurvivingFindings =
    input.maxSurvivingFindings ?? (deepReviewMode === "full" ? Number.POSITIVE_INFINITY : 1);
  const maxRefutationsTotal =
    input.maxRefutationsTotal ?? (deepReviewMode === "full" ? Number.POSITIVE_INFINITY : 4);
  const maxDeepReviewCalls = input.maxDeepReviewCalls ?? Number.POSITIVE_INFINITY;
  const deadlineMs =
    input.maxDeepReviewMinutes === undefined
      ? undefined
      : Date.now() + input.maxDeepReviewMinutes * 60_000;
  const anglePassConcurrency = boundedConcurrency(input.angleConcurrency, angles.length);
  const reviewScope = deepReviewScope(input.inputArtifacts);
  const checkpoints = new Map<string, WorkflowArtifact>();
  for (const artifact of input.inputArtifacts) {
    if (artifact.kind !== DEEP_REVIEW_CHECKPOINT_KIND) continue;
    if (!isDeepReviewCheckpointPayload(artifact.payload)) continue;
    if (artifact.payload.reviewScope !== reviewScope) continue;
    if (!isCheckerVerdictPayload(artifact.payload.result.payload)) continue;
    checkpoints.set(
      checkpointKey(
        artifact.payload.reviewScope,
        artifact.payload.mode,
        artifact.payload.angle,
        artifact.payload.findingId,
      ),
      artifact.payload.result,
    );
  }
  const anglePosition = (angle: DeepReviewAngle): number => angles.indexOf(angle) + 1;
  const startedAt = Date.now();
  let completedSubcalls = 0;
  const emitProgress = (
    mode: DeepReviewProgressEvent["mode"],
    angle: DeepReviewAngle,
    totalSubcalls: number,
    findingId?: string,
  ): void => {
    const progress: DeepReviewProgressEvent = {
      type: "deep_review_step",
      issueId: input.issueId,
      mode,
      angle,
      angleIndex: anglePosition(angle),
      angleCount: angles.length,
      sequence: sequence + 1,
      completedSubcalls,
      totalSubcalls,
      elapsedMs: Date.now() - startedAt,
    };
    if (findingId !== undefined) progress.findingId = findingId;
    input.onProgress?.(progress);
  };

  const runCheckpointed = async (
    mode: DeepReviewCheckpointPayload["mode"],
    angle: DeepReviewAngle,
    payload: Record<string, unknown>,
    totalSubcalls: number,
    findingId?: string,
  ): Promise<WorkflowArtifact> => {
    const key = checkpointKey(reviewScope, mode, angle, findingId);
    const existing = checkpoints.get(key);
    if (existing !== undefined) {
      completedSubcalls += 1;
      return existing;
    }
    emitProgress(mode, angle, totalSubcalls, findingId);
    const result = await input.runRole("deep_reviewer", [
      ...input.inputArtifacts,
      requestArtifact(input.issueId, ++sequence, payload),
    ]);
    const checkpointPayload =
      findingId === undefined
        ? { reviewScope, mode, angle, result }
        : { reviewScope, mode, angle, findingId, result };
    const checkpoint = checkpointArtifact(input.issueId, checkpointPayload);
    await input.checkpointArtifact?.(checkpoint);
    checkpoints.set(key, result);
    completedSubcalls += 1;
    return result;
  };

  const budgetStopReason = (): string | undefined => {
    if (sequence >= maxDeepReviewCalls) {
      return `budget reached: maxDeepReviewCalls=${maxDeepReviewCalls}`;
    }
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      return `budget reached: maxDeepReviewMinutes=${input.maxDeepReviewMinutes}`;
    }
    return undefined;
  };

  const findings: DeepReviewSurvivingFinding[] = [];
  const refutations: DeepReviewRefutationRecord[] = [];
  const passResults: DeepReviewPassResult[] = [];
  let refutationsUsed = 0;
  let stopped = false;

  const runAnglePass = async (angle: DeepReviewAngle, totalSubcalls: number) =>
    passResultFromArtifact(
      angle,
      await runCheckpointed(
        "angle_pass",
        angle,
        {
          mode: "angle_pass",
          angle,
          reviewerModel,
          instructions:
            "Run only this independent deep-review angle. Return checker.verdict: pass only if this angle finds no issues, changes_requested for grounded defects, escalate for uncertainty requiring human attention.",
        },
        totalSubcalls,
      ),
    );

  const refuteFinding = async (
    pass: DeepReviewPassResult,
    finding: DeepReviewFinding,
    totalSubcalls: number,
  ): Promise<void> => {
    const payload = requireCheckerPayload(
      await runCheckpointed(
        "refute_finding",
        pass.angle,
        {
          mode: "refute_finding",
          angle: pass.angle,
          finding,
          pass,
          reviewerModel,
          instructions:
            "Adversarially try to disprove this finding. Return checker.verdict pass only if the finding survives refutation and should still count; return changes_requested if the refutation succeeds and the finding should be dropped; return escalate if the evidence is too ambiguous.",
        },
        totalSubcalls,
        finding.id,
      ),
    );
    refutationsUsed += 1;
    const refutation = {
      survives: payload.verdict === "pass",
      reason: refutationReason(payload),
    };
    refutations.push({
      targetId: finding.id,
      angle: pass.angle,
      targetType: "finding",
      survives: refutation.survives,
      reason: refutation.reason,
    });
    if (refutation.survives) findings.push({ ...finding, angle: pass.angle });
  };

  const refutePass = async (pass: DeepReviewPassResult, totalSubcalls: number): Promise<void> => {
    const payload = requireCheckerPayload(
      await runCheckpointed(
        "refute_pass",
        pass.angle,
        {
          mode: "refute_pass",
          angle: pass.angle,
          pass,
          reviewerModel,
          instructions:
            "Adversarially try to disprove this pass verdict by looking for missed issues. Return checker.verdict pass only if the pass verdict survives refutation; return changes_requested if you found a missed issue; return escalate if the evidence is too ambiguous.",
        },
        totalSubcalls,
      ),
    );
    refutationsUsed += 1;
    const refutation = {
      survives: payload.verdict === "pass",
      reason: refutationReason(payload),
    };
    refutations.push({
      targetId: `pass:${pass.angle}`,
      angle: pass.angle,
      targetType: "pass",
      survives: refutation.survives,
      reason: refutation.reason,
    });
    if (!refutation.survives) findings.push(refutedPassFinding(pass, refutation));
  };

  if (deepReviewMode === "full") {
    passResults.push(
      ...(await mapWithConcurrency(angles, anglePassConcurrency, async (angle) =>
        runAnglePass(angle, angles.length),
      )),
    );
    const refutationCount = passResults.reduce((count, pass) => {
      const findingRefutations = Math.min(pass.findings.length, maxFindingsPerAngle);
      return count + findingRefutations + (pass.verdict === "pass" ? 1 : 0);
    }, 0);
    const totalSubcalls = angles.length + refutationCount;
    for (const pass of passResults) {
      let refutedFindingsForPass = 0;
      for (const finding of pass.findings.slice(0, maxFindingsPerAngle)) {
        if (refutationsUsed >= maxRefutationsTotal) {
          findings.push(
            skippedFindingsFinding(pass, pass.findings.length - refutedFindingsForPass),
          );
          stopped = true;
          break;
        }
        const stopReason = budgetStopReason();
        if (stopReason !== undefined) {
          findings.push(stoppedFinding(pass.angle, stopReason, `budget:${pass.angle}`));
          stopped = true;
          break;
        }
        await refuteFinding(pass, finding, totalSubcalls);
        refutedFindingsForPass += 1;
      }
      if (stopped) break;
      const skippedFindings = pass.findings.length - maxFindingsPerAngle;
      if (skippedFindings > 0) findings.push(skippedFindingsFinding(pass, skippedFindings));

      if (pass.verdict === "pass") {
        const stopReason = budgetStopReason();
        if (refutationsUsed >= maxRefutationsTotal) {
          findings.push(
            stoppedFinding(
              pass.angle,
              `budget reached: maxRefutationsTotal=${maxRefutationsTotal}`,
              `refutation-budget:${pass.angle}`,
            ),
          );
          break;
        }
        if (stopReason !== undefined) {
          findings.push(stoppedFinding(pass.angle, stopReason, `budget:${pass.angle}`));
          break;
        }
        await refutePass(pass, totalSubcalls);
      } else if (pass.findings.length === 0) {
        findings.push(nonPassWithoutFinding(pass));
      }
    }
  } else {
    const totalSubcalls = Number.isFinite(maxDeepReviewCalls)
      ? Math.min(maxDeepReviewCalls, angles.length + maxRefutationsTotal)
      : angles.length + maxRefutationsTotal;
    angleLoop: for (const angle of angles) {
      const stopReason = budgetStopReason();
      if (stopReason !== undefined) {
        findings.push(stoppedFinding(angle, stopReason, `budget:${angle}`));
        break;
      }
      const pass = await runAnglePass(angle, totalSubcalls);
      passResults.push(pass);

      for (const finding of pass.findings.slice(0, maxFindingsPerAngle)) {
        if (refutationsUsed >= maxRefutationsTotal) {
          findings.push({ ...finding, angle: pass.angle });
          findings.push(
            stoppedFinding(
              pass.angle,
              `budget reached: maxRefutationsTotal=${maxRefutationsTotal}`,
              `refutation-budget:${pass.angle}`,
            ),
          );
          break angleLoop;
        }
        const refutationStopReason = budgetStopReason();
        if (refutationStopReason !== undefined) {
          findings.push({ ...finding, angle: pass.angle });
          findings.push(stoppedFinding(pass.angle, refutationStopReason, `budget:${pass.angle}`));
          break angleLoop;
        }
        await refuteFinding(pass, finding, totalSubcalls);
        if (findings.length >= maxSurvivingFindings) {
          findings.push(
            stoppedFinding(
              pass.angle,
              `fail-fast after ${findings.length} surviving finding(s)`,
              `fail-fast:${pass.angle}`,
            ),
          );
          break angleLoop;
        }
      }
      const skippedFindings = pass.findings.length - maxFindingsPerAngle;
      if (skippedFindings > 0) findings.push(skippedFindingsFinding(pass, skippedFindings));

      if (pass.verdict === "pass") {
        if (refutationsUsed >= maxRefutationsTotal) {
          findings.push(
            stoppedFinding(
              pass.angle,
              `budget reached: maxRefutationsTotal=${maxRefutationsTotal}`,
              `refutation-budget:${pass.angle}`,
            ),
          );
          break;
        }
        const refutationStopReason = budgetStopReason();
        if (refutationStopReason !== undefined) {
          findings.push(stoppedFinding(pass.angle, refutationStopReason, `budget:${pass.angle}`));
          break;
        }
        await refutePass(pass, totalSubcalls);
      } else if (pass.findings.length === 0) {
        findings.push(nonPassWithoutFinding(pass));
        if (findings.length >= maxSurvivingFindings) {
          findings.push(
            stoppedFinding(
              pass.angle,
              `fail-fast after ${findings.length} surviving finding(s)`,
              `fail-fast:${pass.angle}`,
            ),
          );
          break;
        }
      }
    }
  }

  const verdict = verdictFor(passResults, findings);
  const result: DeepReviewVerdictPayload = {
    verdict,
    summary:
      verdict === "pass"
        ? "Deep review found no surviving issues after refutation."
        : `Deep review found ${findings.length} surviving issue(s) after refutation.`,
    reasons: findings.map((finding) => `${finding.angle}: ${finding.title}`),
    reviewerModel,
    passResults,
    findings,
    refutations,
  };

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
