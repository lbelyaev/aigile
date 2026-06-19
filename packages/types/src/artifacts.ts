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

export interface CheckerVerdictPayload {
  verdict: CheckerVerdict;
  summary: string;
  reasons: string[];
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
  isRecord(value)
  && typeof value.summary === "string"
  && isStringArray(value.scope)
  && isStringArray(value.acceptanceCriteria)
  && isStringArray(value.verificationCommands)
  && isStringArray(value.risks);

export const isDeveloperAttemptPayload = (value: unknown): value is DeveloperAttemptPayload =>
  isRecord(value)
  && typeof value.summary === "string"
  && isStringArray(value.changedFiles)
  && typeof value.verificationNotes === "string";

export const isCheckerVerdictPayload = (value: unknown): value is CheckerVerdictPayload =>
  isRecord(value)
  && (value.verdict === "pass" || value.verdict === "changes_requested" || value.verdict === "escalate")
  && typeof value.summary === "string"
  && isStringArray(value.reasons);

const extractJsonObjectText = (value: string): string => {
  const direct = value.trim();
  if (direct.startsWith("{") && direct.endsWith("}")) return direct;

  const start = value.indexOf("{");
  if (start < 0) return direct;

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
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }

  return direct;
};

const parseJsonString = (value: string): unknown => {
  try {
    return JSON.parse(extractJsonObjectText(value)) as unknown;
  } catch (error) {
    throw new Error(`Role artifact response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const validateKnownPayload = (response: RoleArtifactResponse): RoleArtifactResponse => {
  if (response.artifactKind === "architect.plan" && !isArchitectPlanPayload(response.payload)) {
    throw new Error("Invalid architect plan payload");
  }
  if (response.artifactKind === "developer.attempt" && !isDeveloperAttemptPayload(response.payload)) {
    throw new Error("Invalid developer attempt payload");
  }
  if (response.artifactKind === "checker.verdict" && !isCheckerVerdictPayload(response.payload)) {
    throw new Error("Invalid checker verdict payload");
  }
  return response;
};

export const parseRoleArtifactResponse = (value: unknown): RoleArtifactResponse => {
  const candidate = typeof value === "string" ? parseJsonString(value) : value;
  if (
    !isRecord(candidate)
    || typeof candidate.artifactKind !== "string"
    || candidate.artifactKind.trim().length === 0
    || !("payload" in candidate)
  ) {
    throw new Error("Role artifact response did not include artifactKind and payload");
  }

  return validateKnownPayload({
    artifactKind: candidate.artifactKind,
    payload: candidate.payload,
  });
};
