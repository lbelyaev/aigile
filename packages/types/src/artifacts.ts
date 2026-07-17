export interface ArchitectPlanPayload {
  summary: string;
  scope: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  risks: string[];
}

export interface DeveloperAttemptPayload {
  summary: string;
  changedFiles: string[];
  verificationNotes: string;
}

export type CheckerVerdict = "pass" | "changes_requested" | "escalate";
export type ReviewFindingSeverity = "low" | "medium" | "high";

export interface ReviewFinding {
  file: string;
  line: number;
  scenario: string;
  severity: ReviewFindingSeverity;
  confidence: number;
  whyItMatters: string;
  minimalFix: string;
}

export interface ReviewPunchListPayload {
  findings: ReviewFinding[];
}

export interface CheckerVerdictPayload {
  verdict: CheckerVerdict;
  summary: string;
  reasons: string[];
  findings?: ReviewFinding[];
  developerPunchList?: ReviewPunchListPayload;
}

export interface RoleArtifactResponse {
  artifactKind: "architect.plan" | "developer.attempt" | "checker.verdict" | string;
  payload: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

export const isArchitectPlanPayload = (value: unknown): value is ArchitectPlanPayload =>
  isRecord(value) &&
  typeof value.summary === "string" &&
  isStringArray(value.scope) &&
  isStringArray(value.acceptanceCriteria) &&
  isStringArray(value.verificationCommands) &&
  isStringArray(value.risks);

export const isDeveloperAttemptPayload = (value: unknown): value is DeveloperAttemptPayload =>
  isRecord(value) &&
  typeof value.summary === "string" &&
  isStringArray(value.changedFiles) &&
  typeof value.verificationNotes === "string";

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isConfidence = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const isReviewFinding = (value: unknown): value is ReviewFinding =>
  isRecord(value) &&
  isNonEmptyString(value.file) &&
  isPositiveInteger(value.line) &&
  isNonEmptyString(value.scenario) &&
  (value.severity === "low" || value.severity === "medium" || value.severity === "high") &&
  isConfidence(value.confidence) &&
  isNonEmptyString(value.whyItMatters) &&
  isNonEmptyString(value.minimalFix);

const isReviewFindingArray = (value: unknown): value is ReviewFinding[] =>
  Array.isArray(value) && value.every(isReviewFinding);

export const isReviewPunchListPayload = (value: unknown): value is ReviewPunchListPayload =>
  isRecord(value) && isReviewFindingArray(value.findings);

export const isCheckerVerdictPayload = (value: unknown): value is CheckerVerdictPayload =>
  isRecord(value) &&
  (value.verdict === "pass" ||
    value.verdict === "changes_requested" ||
    value.verdict === "escalate") &&
  typeof value.summary === "string" &&
  isStringArray(value.reasons) &&
  (value.findings === undefined || isReviewFindingArray(value.findings)) &&
  (value.developerPunchList === undefined || isReviewPunchListPayload(value.developerPunchList));

const extractJsonObjectTexts = (value: string): string[] => {
  const direct = value.trim();
  const candidates: string[] = [];
  if (direct.startsWith("{") && direct.endsWith("}")) candidates.push(direct);

  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const char = value[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(value.slice(start, index + 1));
          break;
        }
      }
    }
  }

  return candidates.length > 0 ? [...new Set(candidates)] : [direct];
};

const parseJsonString = (value: string): unknown => {
  try {
    return JSON.parse(value.trim()) as unknown;
  } catch (error) {
    throw new Error(
      `Role artifact response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const validateKnownPayload = (response: RoleArtifactResponse): RoleArtifactResponse => {
  if (response.artifactKind === "architect.plan" && !isArchitectPlanPayload(response.payload)) {
    throw new Error("Invalid architect plan payload");
  }
  if (
    response.artifactKind === "developer.attempt" &&
    !isDeveloperAttemptPayload(response.payload)
  ) {
    throw new Error("Invalid developer attempt payload");
  }
  if (response.artifactKind === "checker.verdict" && !isCheckerVerdictPayload(response.payload)) {
    throw new Error("Invalid checker verdict payload");
  }
  if (response.artifactKind === "review.punchlist" && !isReviewPunchListPayload(response.payload)) {
    throw new Error("Invalid review punch-list payload");
  }
  return response;
};

export const parseRoleArtifactResponse = (value: unknown): RoleArtifactResponse => {
  if (typeof value === "string") {
    let lastError: Error | undefined;
    for (const candidateText of extractJsonObjectTexts(value)) {
      let candidate: unknown;
      try {
        candidate = parseJsonString(candidateText);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      if (
        !isRecord(candidate) ||
        typeof candidate.artifactKind !== "string" ||
        candidate.artifactKind.trim().length === 0 ||
        !("payload" in candidate)
      ) {
        continue;
      }
      try {
        return validateKnownPayload({
          artifactKind: candidate.artifactKind,
          payload: candidate.payload,
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (lastError) throw lastError;
    throw new Error("Role artifact response did not include artifactKind and payload");
  }

  const candidate = value;
  if (
    !isRecord(candidate) ||
    typeof candidate.artifactKind !== "string" ||
    candidate.artifactKind.trim().length === 0 ||
    !("payload" in candidate)
  ) {
    throw new Error("Role artifact response did not include artifactKind and payload");
  }

  return validateKnownPayload({
    artifactKind: candidate.artifactKind,
    payload: candidate.payload,
  });
};
