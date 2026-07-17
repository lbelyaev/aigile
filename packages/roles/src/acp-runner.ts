import {
  DEFAULT_ACP_PROMPT_TIMEOUT_MS,
  connectAcpRuntime,
  extractTokenUsage,
  type AcpPermissionRequest,
  type AcpSession,
  type AcpTokenUsage,
  type ConnectAcpRuntimeInput,
  type PermissionDecision,
} from "@aigile/acp";
import {
  parseRoleArtifactResponse,
  type RuntimeArtifactProvenance,
  type RuntimeTokenUsage,
  type WorkflowArtifact,
} from "@aigile/types";
import type { RoleRunner, RoleRunInput } from "./runner.js";
import { buildRolePrompt, getDefaultRoleInstruction } from "./prompts.js";

export interface AcpRuntimeConnection {
  session: Pick<AcpSession, "sessionId" | "acpSessionId" | "prompt" | "cancel" | "onEvent">;
  process: {
    kill: () => Promise<void>;
  };
}

export type AcpRuntimeConnector = (input: RoleRunInput) => Promise<AcpRuntimeConnection>;

export type AcpRoleProgressEvent =
  | { type: "role_started"; roleId: string; issueId: string; runtimeId: string }
  | { type: "runtime_connecting"; roleId: string; issueId: string; runtimeId: string }
  | {
      type: "runtime_connected";
      roleId: string;
      issueId: string;
      runtimeId: string;
      model: string;
      acpSessionId: string;
    }
  | { type: "runtime_stderr"; roleId: string; issueId: string; runtimeId: string; chunk: string }
  | { type: "prompt_started"; roleId: string; issueId: string; runtimeId: string }
  | { type: "text_delta"; roleId: string; issueId: string; runtimeId: string; delta: string }
  | { type: "thinking_delta"; roleId: string; issueId: string; runtimeId: string; delta: string }
  | {
      type: "token_usage";
      roleId: string;
      issueId: string;
      runtimeId: string;
      usage: RuntimeTokenUsage;
    }
  | {
      type: "tool_start";
      roleId: string;
      issueId: string;
      runtimeId: string;
      tool: string;
      detail?: string | undefined;
    }
  | {
      type: "tool_end";
      roleId: string;
      issueId: string;
      runtimeId: string;
      tool: string;
      detail?: string | undefined;
    }
  | {
      type: "policy_violation";
      roleId: string;
      issueId: string;
      runtimeId: string;
      reason: "broad_discovery" | "file_read_budget";
      detail: string;
    }
  | {
      type: "permission_decision";
      roleId: string;
      issueId: string;
      runtimeId: string;
      tool: string;
      description: string;
      decision: PermissionDecision;
    }
  | {
      type: "approval_request";
      roleId: string;
      issueId: string;
      runtimeId: string;
      tool: string;
      description: string;
    }
  | {
      type: "artifact_parsed";
      roleId: string;
      issueId: string;
      runtimeId: string;
      artifactKind: string;
      artifactPayload?: unknown;
    }
  | { type: "runtime_stopped"; roleId: string; issueId: string; runtimeId: string };

export interface AcpRoleRunnerOptions {
  connector?: AcpRuntimeConnector;
  onProgress?: (event: AcpRoleProgressEvent) => void;
  promptTimeoutMs?: number;
}

export interface BuildAcpRuntimeConnectInputOptions {
  promptTimeoutMs?: number;
}

const resolvePromptTimeoutMs = (timeoutMs: number | undefined): number => {
  const resolved = timeoutMs ?? DEFAULT_ACP_PROMPT_TIMEOUT_MS;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error("ACP prompt timeout must be a finite positive number");
  }
  return resolved;
};

const substituteRuntimeValue = (value: string, runtime: RoleRunInput["runtime"]): string =>
  value.replace(/\$\{defaultModel\}/g, () => {
    if (runtime.defaultModel === undefined) {
      throw new Error(
        `Runtime command references \${defaultModel} without defaultModel: ${runtime.id}`,
      );
    }
    return runtime.defaultModel;
  });

const resolveRuntimeCommand = (
  runtime: RoleRunInput["runtime"],
): readonly [string, ...string[]] => {
  if (runtime.command === undefined) {
    throw new Error(`ACP runtime profile is missing command: ${runtime.id}`);
  }
  return runtime.command.map((part) => substituteRuntimeValue(part, runtime)) as [
    string,
    ...string[],
  ];
};

export const buildAcpRuntimeConnectInput = (
  input: RoleRunInput,
  options: BuildAcpRuntimeConnectInputOptions = {},
): ConnectAcpRuntimeInput => {
  if (input.runtime.transport !== "stdio" || !input.runtime.command) {
    throw new Error(
      `ACP role runner currently supports stdio command runtimes only: ${input.runtime.id}`,
    );
  }

  const connectInput: ConnectAcpRuntimeInput = {
    command: resolveRuntimeCommand(input.runtime),
    sessionId: `${input.issueId}:${input.roleId}`,
    promptTimeoutMs: resolvePromptTimeoutMs(options.promptTimeoutMs),
    initializeParams: {
      protocolVersion: 1,
      clientCapabilities: {},
    },
    sessionParams: {
      cwd: input.runtime.cwd ?? process.cwd(),
      mcpServers: [],
    },
  };
  if (input.runtime.defaultModel !== undefined) {
    connectInput.sessionParams.model = input.runtime.defaultModel;
  }
  if (input.runtime.cwd !== undefined) connectInput.cwd = input.runtime.cwd;
  if (input.runtime.env !== undefined) connectInput.env = input.runtime.env;
  if (input.runtime.envPassthrough !== undefined)
    connectInput.envPassthrough = input.runtime.envPassthrough;
  const decidePermission = buildExecutionPolicyPermissionDecision(input);
  if (decidePermission !== undefined) connectInput.decidePermission = decidePermission;

  return connectInput;
};

const runtimeModel = (input: RoleRunInput): string =>
  input.runtime.defaultModel ?? "runtime-default";

const runtimeProvenance = (
  input: RoleRunInput,
  tokenUsage?: RuntimeTokenUsage,
): RuntimeArtifactProvenance => {
  const provenance: RuntimeArtifactProvenance = {
    runtimeId: input.runtime.id,
    transport: input.runtime.transport,
    model: runtimeModel(input),
  };
  if (input.runtime.displayName !== undefined)
    provenance.runtimeDisplayName = input.runtime.displayName;
  if (input.runtime.command !== undefined)
    provenance.command = [...resolveRuntimeCommand(input.runtime)];
  if (tokenUsage !== undefined) provenance.tokenUsage = tokenUsage;
  return provenance;
};

const mergeTokenUsage = (
  current: RuntimeTokenUsage | undefined,
  next: AcpTokenUsage | undefined,
): RuntimeTokenUsage | undefined => {
  if (next === undefined) return current;
  const merged: RuntimeTokenUsage = { ...(current ?? {}) };
  if (next.inputTokens !== undefined) merged.inputTokens = next.inputTokens;
  if (next.outputTokens !== undefined) merged.outputTokens = next.outputTokens;
  if (next.totalTokens !== undefined) merged.totalTokens = next.totalTokens;
  if (
    merged.totalTokens === undefined &&
    merged.inputTokens !== undefined &&
    merged.outputTokens !== undefined
  ) {
    merged.totalTokens = merged.inputTokens + merged.outputTokens;
  }
  return merged;
};

const buildPrompt = (input: RoleRunInput): string =>
  buildRolePrompt({
    roleId: input.roleId,
    issueId: input.issueId,
    instruction: [
      getDefaultRoleInstruction(input.roleId),
      input.assignment.instructionRef
        ? `Instruction reference: ${input.assignment.instructionRef}`
        : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
    inputArtifacts: input.inputArtifacts,
    ...(input.runtime.capabilities === undefined
      ? {}
      : { runtimeCapabilities: input.runtime.capabilities }),
  });

const EXPECTED_ARTIFACT_KIND_BY_ROLE: Record<string, string> = {
  architect: "architect.plan",
  developer: "developer.attempt",
  checker: "checker.verdict",
  deep_reviewer: "checker.verdict",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type ExecutionPolicyMode = "dry_run" | "agent_write" | "review";

const executionPolicyMode = (input: RoleRunInput): ExecutionPolicyMode | undefined => {
  let firstPolicyMode: ExecutionPolicyMode | undefined;
  let deepReviewerReviewMode: ExecutionPolicyMode | undefined;
  for (const artifact of input.inputArtifacts) {
    if (artifact.kind !== "execution.policy" || !isRecord(artifact.payload)) continue;
    if (
      artifact.payload.mode === "dry_run" ||
      artifact.payload.mode === "agent_write" ||
      artifact.payload.mode === "review"
    ) {
      firstPolicyMode ??= artifact.payload.mode;
      if (input.roleId === "deep_reviewer" && artifact.payload.mode === "review") {
        deepReviewerReviewMode = artifact.payload.mode;
      }
    }
  }
  return deepReviewerReviewMode ?? firstPolicyMode;
};

const extractCommand = (request: AcpPermissionRequest): string => {
  try {
    const parsed = JSON.parse(request.description) as unknown;
    if (isRecord(parsed) && typeof parsed.command === "string") return parsed.command;
  } catch {
    // Description may be a plain tool label or file path.
  }
  return request.description;
};

const commandSegments = (command: string): string[] =>
  command
    .split(/\s*(?:&&|\|\||;|\||\r?\n)\s*/g)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

const gitSubcommandPattern = (subcommands: string): RegExp =>
  new RegExp(
    `^git(?:\\s+(?:-c\\s+(?:"[^"]+"|'[^']+'|\\S+)|-C\\s+(?:"[^"]+"|'[^']+'|\\S+)))*\\s+(?:${subcommands})\\b`,
  );

const toolCommand = (tool: string, params: unknown): string => {
  if (isRecord(params) && typeof params.command === "string") return params.command;
  return tool;
};

const toolProgressDetail = (params: unknown): string | undefined => {
  if (!isRecord(params)) return undefined;
  for (const key of ["command", "file_path", "path", "pattern", "query", "url"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
};

const isWriteLikePermission = (request: AcpPermissionRequest): boolean => {
  const tool = request.tool.toLowerCase();
  const command = extractCommand(request).trim().toLowerCase();
  if (/(^|\s)(edit|write|multiedit|notebookedit)(\s|$)/.test(tool)) return true;
  return commandSegments(command).some((segment) =>
    [
      gitSubcommandPattern("add|commit|push|merge|rebase|checkout|switch|reset|worktree\\s+add"),
      /(^|\s)(rm|mv|cp|mkdir|touch|chmod|chown|tee)\b/,
      />/,
    ].some((pattern) => pattern.test(segment)),
  );
};

const isCommitLikePermission = (request: AcpPermissionRequest): boolean => {
  const command = extractCommand(request).trim().toLowerCase();
  return commandSegments(command).some((segment) =>
    gitSubcommandPattern("add|commit|push|merge|rebase|reset").test(segment),
  );
};

const isPrOpeningPermission = (request: AcpPermissionRequest): boolean => {
  const command = extractCommand(request).trim().toLowerCase();
  return commandSegments(command).some(
    (segment) => /^(gh|hub)\s+pr\s+create\b/.test(segment) || /^hub\s+pull-request\b/.test(segment),
  );
};

const isLinearMutationPermission = (request: AcpPermissionRequest): boolean => {
  const surface = `${request.tool} ${extractCommand(request)}`.toLowerCase();
  return (
    surface.includes("linear") &&
    /(create|update|delete|archive|assign|comment|transition|move|link|unlink|mutat)/.test(surface)
  );
};

const isLinearMutationTool = (tool: string): boolean => {
  const lowered = tool.toLowerCase();
  return (
    lowered.includes("linear") &&
    /(create|update|delete|archive|assign|comment|transition|move|link|unlink|mutat)/.test(lowered)
  );
};

const isPullRequestMutationPermission = (request: AcpPermissionRequest): boolean => {
  const command = extractCommand(request).trim().toLowerCase();
  if (
    commandSegments(command).some(
      (segment) =>
        /^(gh|hub)\s+pr\s+(create|edit|merge|close|reopen|comment|review|ready|lock|unlock)\b/.test(
          segment,
        ) || /^hub\s+pull-request\b/.test(segment),
    )
  ) {
    return true;
  }
  const surface = `${request.tool} ${command}`.toLowerCase();
  return (
    (surface.includes("github") || /(^|[_\W])(gh|pull[_-]?request|pr)([_\W]|$)/.test(surface)) &&
    /(create|update|edit|merge|close|reopen|comment|review|approve|request[_-]?review|mutat)/.test(
      surface,
    )
  );
};

const isPullRequestMutationTool = (tool: string): boolean => {
  const lowered = tool.toLowerCase();
  return (
    (lowered.includes("github") || /(^|[_\W])(gh|pull[_-]?request|pr)([_\W]|$)/.test(lowered)) &&
    /(create|update|edit|merge|close|reopen|comment|review|approve|request[_-]?review|mutat)/.test(
      lowered,
    )
  );
};

const hasTargetedPathArgument = (command: string): boolean =>
  /(^|\s)(\.?\/?[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.(ts|tsx|js|jsx|json|md|yml|yaml|toml|lock))(\s|$)/.test(
    command,
  );

const isBroadDiscoveryCommand = (command: string): boolean => {
  const trimmed = command.trim();
  const segments = commandSegments(trimmed);
  if (segments.length > 1) return segments.some(isBroadDiscoveryCommand);
  const lowered = trimmed.toLowerCase();
  if (/^find\b/.test(lowered)) return true;
  if (/^ls\b/.test(lowered) && /(^|\s)-[A-Za-z]*R[A-Za-z]*(\s|$)/.test(trimmed)) return true;
  if (/^git\b.*\bls-files\b/.test(lowered)) return true;
  if (/^grep\b/.test(lowered) && /(^|\s)-[A-Za-z]*r[A-Za-z]*(\s|$)/.test(trimmed)) return true;
  if (/^(rg|grep)\b/.test(lowered) && !hasTargetedPathArgument(trimmed)) return true;
  if (/^git\s+grep\b/.test(lowered) && !hasTargetedPathArgument(trimmed)) return true;
  return false;
};

const isBroadDiscoveryPermission = (request: AcpPermissionRequest): boolean => {
  return isBroadDiscoveryCommand(extractCommand(request));
};

const isFileReadCommand = (command: string): boolean => {
  const lowered = command.trim().toLowerCase();
  return [/^read(\s+file)?\b/, /^cat\b/, /^sed\s+-n\b/, /^head\b/, /^tail\b/].some((pattern) =>
    pattern.test(lowered),
  );
};

const isReadOnlyPermission = (request: AcpPermissionRequest): boolean => {
  const command = extractCommand(request).trim().toLowerCase();
  return [
    /^pwd$/,
    /^ls\b/,
    gitSubcommandPattern("status|diff|log|show|branch"),
    /^cat\b/,
    /^sed\s+-n\b/,
    /^head\b/,
    /^tail\b/,
    /^rg\b/,
    /^grep\b/,
    /^find\b/,
    /^test\b/,
  ].some((pattern) => pattern.test(command));
};

const isReviewAllowedExecution = (request: AcpPermissionRequest): boolean => {
  const command = extractCommand(request).trim().toLowerCase();
  return commandSegments(command).every((segment) =>
    [
      /^cd\b/,
      /^pwd$/,
      /^ls\b/,
      gitSubcommandPattern("status|diff|log|show|branch"),
      /^cat\b/,
      /^sed\s+-n\b/,
      /^head\b/,
      /^tail\b/,
      /^rg\b/,
      /^grep\b/,
      /^bun\s+(test|run\s+(check|typecheck|test|test:e2e|test:e2e:static|test:e2e:real))\b/,
      /^npm\s+(test|run\s+(check|typecheck|test))\b/,
      /^pnpm\s+(test|run\s+(check|typecheck|test))\b/,
      /^yarn\s+(test|run\s+(check|typecheck|test))\b/,
      /^npx\s+tsc\b/,
      /^bunx\s+tsc\b/,
      /^tsc\b/,
    ].some((pattern) => pattern.test(segment)),
  );
};

const isDiscoveryWarningOnlyRole = (roleId: string): boolean =>
  roleId === "architect" || roleId === "checker" || roleId === "deep_reviewer";

// ACP tool-call kinds (agent-defined): file-mutating vs. read-only categories.
const WRITE_TOOL_KINDS = new Set(["edit", "write", "delete", "move"]);
const READ_TOOL_KINDS = new Set(["read", "search", "fetch"]);

const isEditToolName = (tool: string): boolean =>
  /(^|\s)(edit|write|multiedit|notebookedit)(\s|$)/.test(tool.toLowerCase());

// Classify a shell/execute command: reject destructive or broad-discovery commands,
// otherwise allow ordinary commands (tests, typecheck, builds, targeted reads).
const decideExecutePermission = (
  request: AcpPermissionRequest,
  roleId: string,
  mode: ExecutionPolicyMode,
): PermissionDecision => {
  if (isWriteLikePermission(request)) return "reject_once";
  if (mode === "review") return isReviewAllowedExecution(request) ? "allow_once" : "reject_once";
  if (isBroadDiscoveryPermission(request))
    return isDiscoveryWarningOnlyRole(roleId) ? "allow_once" : "reject_once";
  if (mode === "dry_run") return isReadOnlyPermission(request) ? "allow_once" : "reject_once";
  return "allow_once";
};

const buildExecutionPolicyPermissionDecision = (
  input: RoleRunInput,
): ((request: AcpPermissionRequest) => PermissionDecision | undefined) | undefined => {
  const mode = executionPolicyMode(input);
  if (mode === undefined) return undefined;
  return (request) => {
    // Commits / pushes / PR creation are Aigile's job, never the agent's, in any mode.
    if (isCommitLikePermission(request) || isPrOpeningPermission(request)) return "reject_once";

    // Prefer the ACP tool-call kind; it does not depend on agent-specific tool labels.
    const kind = request.kind?.toLowerCase();
    if (kind !== undefined) {
      if (WRITE_TOOL_KINDS.has(kind)) return mode === "agent_write" ? "allow_once" : "reject_once";
      if (kind === "execute") return decideExecutePermission(request, input.roleId, mode);
      if (
        READ_TOOL_KINDS.has(kind) &&
        mode === "review" &&
        (isLinearMutationTool(request.tool) || isPullRequestMutationTool(request.tool))
      ) {
        return "reject_once";
      }
      if (READ_TOOL_KINDS.has(kind))
        return mode === "review" ||
          isDiscoveryWarningOnlyRole(input.roleId) ||
          !isBroadDiscoveryPermission(request)
          ? "allow_once"
          : "reject_once";
      // Unknown kind: fall through to label/command heuristics below.
    }

    // Fallback for agents that omit `kind`: classify by tool label, then by command.
    if (isEditToolName(request.tool)) return mode === "agent_write" ? "allow_once" : "reject_once";
    if (mode === "review" && isReviewAllowedExecution(request)) return "allow_once";
    if (
      mode === "review" &&
      (isLinearMutationPermission(request) || isPullRequestMutationPermission(request))
    ) {
      return "reject_once";
    }
    return decideExecutePermission(request, input.roleId, mode);
  };
};

const parsePromptArtifactResponse = (promptResult: unknown, streamedText: string) => {
  if (promptResult === undefined || promptResult === null) {
    return parseRoleArtifactResponse(streamedText);
  }
  try {
    return parseRoleArtifactResponse(promptResult);
  } catch (error) {
    if (streamedText.trim().length === 0) throw error;
    return parseRoleArtifactResponse(streamedText);
  }
};

const assertExpectedArtifactKind = (roleId: string, artifactKind: string): void => {
  const expected = EXPECTED_ARTIFACT_KIND_BY_ROLE[roleId];
  if (expected === undefined || artifactKind === expected) return;
  throw new Error(`Role "${roleId}" expected ${expected} but received ${artifactKind}`);
};

export const createAcpRoleRunner = (options: AcpRoleRunnerOptions = {}): RoleRunner => {
  const progressBase = (input: RoleRunInput) => ({
    roleId: input.roleId,
    issueId: input.issueId,
    runtimeId: input.runtime.id,
  });
  const connector =
    options.connector ??
    (async (input) => {
      const connectOptions: BuildAcpRuntimeConnectInputOptions =
        options.promptTimeoutMs === undefined ? {} : { promptTimeoutMs: options.promptTimeoutMs };
      const connectInput = buildAcpRuntimeConnectInput(input, connectOptions);
      connectInput.forwardStderr = (chunk) =>
        options.onProgress?.({
          type: "runtime_stderr",
          ...progressBase(input),
          chunk,
        });
      return connectAcpRuntime(connectInput);
    });

  return {
    run: async (input) => {
      options.onProgress?.({ type: "role_started", ...progressBase(input) });
      options.onProgress?.({ type: "runtime_connecting", ...progressBase(input) });
      const connection = await connector(input);
      let unsubscribe = (): void => undefined;
      try {
        options.onProgress?.({
          type: "runtime_connected",
          ...progressBase(input),
          model: runtimeModel(input),
          acpSessionId: connection.session.acpSessionId,
        });
        let streamedText = "";
        let fileReadCount = 0;
        let tokenUsage: RuntimeTokenUsage | undefined;
        const toolDetailsByCallId = new Map<string, string>();
        let policyViolation:
          | { reason: "broad_discovery" | "file_read_budget"; detail: string }
          | undefined;
        unsubscribe = connection.session.onEvent((event) => {
          if (event.type === "text_delta") {
            streamedText += event.delta;
            tokenUsage = mergeTokenUsage(tokenUsage, event.usage);
            options.onProgress?.({
              type: "text_delta",
              ...progressBase(input),
              delta: event.delta,
            });
            return;
          }
          if (event.type === "thinking_delta") {
            tokenUsage = mergeTokenUsage(tokenUsage, event.usage);
            options.onProgress?.({
              type: "thinking_delta",
              ...progressBase(input),
              delta: event.delta,
            });
            return;
          }
          if (event.type === "token_usage") {
            tokenUsage = mergeTokenUsage(tokenUsage, event.usage);
            if (tokenUsage !== undefined) {
              options.onProgress?.({
                type: "token_usage",
                ...progressBase(input),
                usage: tokenUsage,
              });
            }
            return;
          }
          if (event.type === "tool_start") {
            const detail = toolProgressDetail(event.params);
            if (event.toolCallId !== undefined && detail !== undefined) {
              toolDetailsByCallId.set(event.toolCallId, detail);
            }
            options.onProgress?.({
              type: "tool_start",
              ...progressBase(input),
              tool: event.tool,
              detail,
            });
            const command = toolCommand(event.tool, event.params);
            const mode = executionPolicyMode(input);
            if (mode !== undefined && mode !== "review" && isBroadDiscoveryCommand(command)) {
              // Broad-discovery commands are already denied per-call by the execution
              // policy (decidePermission -> reject_once). Surface the attempt as a
              // warning, but do NOT fail the turn: an agent trying a broad command and
              // being denied is normal exploration, not a fatal violation. (Throwing
              // here previously aborted the entire run — see LBE-36.)
              options.onProgress?.({
                type: "policy_violation",
                ...progressBase(input),
                reason: "broad_discovery",
                detail: command,
              });
              return;
            }
            if (mode === "dry_run" && isFileReadCommand(command)) {
              fileReadCount += 1;
              if (fileReadCount > 5 && policyViolation === undefined) {
                policyViolation = {
                  reason: "file_read_budget",
                  detail: `${fileReadCount}/5 ${command}`,
                };
                options.onProgress?.({
                  type: "policy_violation",
                  ...progressBase(input),
                  reason: policyViolation.reason,
                  detail: policyViolation.detail,
                });
              }
            }
            return;
          }
          if (event.type === "tool_end") {
            tokenUsage = mergeTokenUsage(tokenUsage, event.usage);
            const detail =
              event.toolCallId === undefined
                ? undefined
                : toolDetailsByCallId.get(event.toolCallId);
            if (event.toolCallId !== undefined) toolDetailsByCallId.delete(event.toolCallId);
            options.onProgress?.({
              type: "tool_end",
              ...progressBase(input),
              tool: event.tool,
              detail,
            });
            return;
          }
          if (event.type === "permission_decision") {
            options.onProgress?.({
              type: "permission_decision",
              ...progressBase(input),
              tool: event.tool,
              description: event.description,
              decision: event.decision,
            });
            return;
          }
          if (event.type === "approval_request") {
            options.onProgress?.({
              type: "approval_request",
              ...progressBase(input),
              tool: event.tool,
              description: event.description,
            });
          }
        });
        options.onProgress?.({ type: "prompt_started", ...progressBase(input) });
        const promptResult = await connection.session.prompt(buildPrompt(input));
        tokenUsage = mergeTokenUsage(tokenUsage, extractTokenUsage(promptResult));
        if (policyViolation !== undefined) {
          throw new Error(`Policy violation ${policyViolation.reason}: ${policyViolation.detail}`);
        }
        const response = parsePromptArtifactResponse(promptResult, streamedText);
        assertExpectedArtifactKind(input.roleId, response.artifactKind);
        options.onProgress?.({
          type: "artifact_parsed",
          ...progressBase(input),
          artifactKind: response.artifactKind,
          artifactPayload: structuredClone(response.payload),
        });
        return {
          id: `agent:${input.issueId}:${input.roleId}:${response.artifactKind}`,
          kind: response.artifactKind,
          source: "agent",
          producerRoleId: input.roleId,
          provenance: {
            runtime: runtimeProvenance(input, tokenUsage),
          },
          payload: structuredClone(response.payload),
        } satisfies WorkflowArtifact;
      } finally {
        try {
          unsubscribe();
        } finally {
          await connection.process.kill();
          options.onProgress?.({ type: "runtime_stopped", ...progressBase(input) });
        }
      }
    },
  };
};
