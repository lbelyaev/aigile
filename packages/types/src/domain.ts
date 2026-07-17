export const WORKFLOW_STATES = [
  "new",
  "planning",
  "awaiting_plan_approval",
  "developing",
  "verifying",
  "checking",
  "changes_requested",
  "escalated",
  "merge_ready",
  "satisfied",
  "merged",
  "cancelled",
  "failed",
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const WORKFLOW_EVENT_TYPES = [
  "issue_received",
  "plan_drafted",
  "plan_approved",
  "plan_rejected",
  "developer_finished",
  "verification_passed",
  "verification_failed",
  "checker_passed",
  "checker_requested_changes",
  "review_changes_requested",
  "human_changes_requested",
  "checker_escalated",
  "work_satisfied",
  "publish_failed",
  "publish_retry_requested",
  "human_cancelled",
  "merge_completed",
  "timeout_elapsed",
  "budget_exceeded",
  // Synthesized by the engine when a command handler throws, so a role/tool
  // failure escalates gracefully instead of aborting the run.
  "handler_failed",
] as const;

export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

export const ARTIFACT_SOURCES = [
  "linear",
  "github",
  "agent",
  "verifier",
  "human",
  "operator",
  "system",
] as const;

export type ArtifactSource = (typeof ARTIFACT_SOURCES)[number];

export interface AcpRuntimeCapabilities {
  streaming?: boolean;
  permissionRequests?: boolean;
  sessionResume?: boolean;
  multimodal?: boolean;
  skills?: readonly string[];
}

export interface AcpRuntimeProfile {
  id: string;
  displayName?: string;
  transport: "stdio" | "http" | "websocket";
  command?: readonly [string, ...string[]];
  endpoint?: string;
  cwd?: string;
  env?: Record<string, string>;
  envPassthrough?: readonly string[];
  defaultModel?: string;
  capabilities?: AcpRuntimeCapabilities;
}

export interface RoleAssignment {
  roleId: string;
  runtimeProfileId: string;
  instructionRef?: string;
}

export interface RuntimeTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface RuntimeArtifactProvenance {
  runtimeId: string;
  runtimeDisplayName?: string;
  transport: AcpRuntimeProfile["transport"];
  command?: readonly string[];
  model: string;
  tokenUsage?: RuntimeTokenUsage;
}

export interface ArtifactProvenance {
  runtime?: RuntimeArtifactProvenance;
  // LBE-45: the worktree checkpoint (commit SHA) the reviewer's verdict applies to,
  // so the loop can `git reset --hard` back to the best-scoring attempt.
  worktreeCheckpoint?: string;
}

export interface WorkflowArtifact<TPayload = unknown> {
  id: string;
  kind: string;
  source: ArtifactSource;
  producerRoleId?: string;
  provenance?: ArtifactProvenance;
  payload: TPayload;
}

export interface WorkflowEvent {
  type: WorkflowEventType;
  issueId: string;
  artifactId?: string;
  reason?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const hasOnlyStringValues = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");

const isKnownValue = <T extends readonly string[]>(values: T, value: unknown): value is T[number] =>
  typeof value === "string" && values.includes(value);

const isCapabilities = (value: unknown): value is AcpRuntimeCapabilities =>
  isRecord(value) &&
  ["streaming", "permissionRequests", "sessionResume", "multimodal"].every((key) => {
    const entry = value[key];
    return entry === undefined || typeof entry === "boolean";
  }) &&
  (value.skills === undefined ||
    (Array.isArray(value.skills) && value.skills.every(isNonEmptyString)));

export const isAcpRuntimeProfile = (value: unknown): value is AcpRuntimeProfile => {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (value.displayName !== undefined && !isNonEmptyString(value.displayName)) return false;
  if (!isKnownValue(["stdio", "http", "websocket"] as const, value.transport)) return false;
  if (value.cwd !== undefined && !isNonEmptyString(value.cwd)) return false;
  if (value.endpoint !== undefined && !isNonEmptyString(value.endpoint)) return false;
  if (value.defaultModel !== undefined && !isNonEmptyString(value.defaultModel)) return false;
  if (value.env !== undefined && !hasOnlyStringValues(value.env)) return false;
  if (
    value.envPassthrough !== undefined &&
    (!Array.isArray(value.envPassthrough) || !value.envPassthrough.every(isNonEmptyString))
  ) {
    return false;
  }
  if (value.capabilities !== undefined && !isCapabilities(value.capabilities)) return false;

  if (value.command !== undefined) {
    if (!Array.isArray(value.command)) return false;
    if (value.command.length === 0) return false;
    if (!value.command.every((part) => isNonEmptyString(part))) return false;
  }

  if (value.transport === "stdio") return value.command !== undefined;
  return value.endpoint !== undefined;
};

export const isRoleAssignment = (value: unknown): value is RoleAssignment =>
  isRecord(value) &&
  isNonEmptyString(value.roleId) &&
  isNonEmptyString(value.runtimeProfileId) &&
  (value.instructionRef === undefined || isNonEmptyString(value.instructionRef));

const isRuntimeArtifactProvenance = (value: unknown): value is RuntimeArtifactProvenance =>
  isRecord(value) &&
  isNonEmptyString(value.runtimeId) &&
  (value.runtimeDisplayName === undefined || isNonEmptyString(value.runtimeDisplayName)) &&
  isKnownValue(["stdio", "http", "websocket"] as const, value.transport) &&
  (value.command === undefined ||
    (Array.isArray(value.command) && value.command.every(isNonEmptyString))) &&
  isNonEmptyString(value.model) &&
  (value.tokenUsage === undefined || isRuntimeTokenUsage(value.tokenUsage));

const isNonNegativeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isRuntimeTokenUsage = (value: unknown): value is RuntimeTokenUsage =>
  isRecord(value) &&
  (value.inputTokens === undefined || isNonNegativeNumber(value.inputTokens)) &&
  (value.outputTokens === undefined || isNonNegativeNumber(value.outputTokens)) &&
  (value.totalTokens === undefined || isNonNegativeNumber(value.totalTokens));

const isArtifactProvenance = (value: unknown): value is ArtifactProvenance =>
  isRecord(value) && (value.runtime === undefined || isRuntimeArtifactProvenance(value.runtime));

export const isWorkflowArtifact = (value: unknown): value is WorkflowArtifact =>
  isRecord(value) &&
  isNonEmptyString(value.id) &&
  isNonEmptyString(value.kind) &&
  isKnownValue(ARTIFACT_SOURCES, value.source) &&
  (value.producerRoleId === undefined || isNonEmptyString(value.producerRoleId)) &&
  (value.provenance === undefined || isArtifactProvenance(value.provenance)) &&
  "payload" in value;

export const isWorkflowEvent = (value: unknown): value is WorkflowEvent =>
  isRecord(value) &&
  isKnownValue(WORKFLOW_EVENT_TYPES, value.type) &&
  isNonEmptyString(value.issueId) &&
  (value.artifactId === undefined || isNonEmptyString(value.artifactId)) &&
  (value.reason === undefined || isNonEmptyString(value.reason));
