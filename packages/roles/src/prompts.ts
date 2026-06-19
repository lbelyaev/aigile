import type { WorkflowArtifact } from "@aigile/types";

export interface BuildRolePromptInput {
  roleId: string;
  issueId: string;
  instruction: string;
  inputArtifacts: readonly WorkflowArtifact[];
}

const DEFAULT_ROLE_INSTRUCTIONS: Record<string, string> = {
  architect: [
    "Produce the Definition of Ready for the issue as architect.plan.",
    "Define scope, non-goals, implementation plan, risks, and executable acceptance criteria.",
    "Do not edit files. Read at most 5 files. Avoid shell commands unless a listed acceptance criterion requires them.",
  ].join(" "),
  developer: [
    "Implement the approved plan and return developer.attempt.",
    "Summarize changed files, verification expectations, and any unresolved issues.",
    "Do not claim verification passed unless a verifier artifact says so.",
  ].join(" "),
  checker: [
    "Review the plan, implementation artifact, and verification result.",
    "Return checker.verdict with a verdict of pass, changes_requested, or escalate and grounded reasons.",
    "Do not edit files, merge, or update source-of-truth systems directly.",
  ].join(" "),
};

const ARTIFACT_KIND_BY_ROLE: Record<string, string> = {
  architect: "architect.plan",
  developer: "developer.attempt",
  checker: "checker.verdict",
};

const PAYLOAD_EXAMPLES_BY_ROLE: Record<string, unknown> = {
  architect: {
    summary: "string",
    scope: ["string"],
    acceptanceCriteria: ["string"],
    verificationCommands: ["string"],
    risks: ["string"],
  },
  developer: {
    summary: "string",
    changedFiles: ["string"],
    verificationNotes: "string",
  },
  checker: {
    verdict: "pass",
    summary: "string",
    reasons: ["string"],
  },
};

export const getDefaultRoleInstruction = (roleId: string): string =>
  DEFAULT_ROLE_INSTRUCTIONS[roleId] ?? [
    `Fulfill the ${roleId} role using the provided artifacts.`,
    "Return a typed artifact for the workflow runner.",
  ].join(" ");

const artifactKindForRole = (roleId: string): string =>
  ARTIFACT_KIND_BY_ROLE[roleId] ?? `${roleId}.artifact`;

const payloadExampleForRole = (roleId: string): unknown =>
  PAYLOAD_EXAMPLES_BY_ROLE[roleId] ?? {};

export const buildRolePrompt = (input: BuildRolePromptInput): string => [
  `Role: ${input.roleId}`,
  `Issue: ${input.issueId}`,
  "",
  "Execution limits:",
  "- Stay focused on the supplied issue and artifacts.",
  "- Execution policy artifacts are authoritative; obey execution.policy over any role default.",
  "- Read at most 5 files total unless the prompt explicitly says otherwise.",
  "- Do not edit files unless this is the developer role and the plan requires it.",
  "- Do not run broad repository discovery commands.",
  "- No Markdown, no prose, no commentary outside the final JSON object.",
  "",
  "Instructions:",
  input.instruction,
  "",
  `Required artifactKind: ${artifactKindForRole(input.roleId)}`,
  "Return only valid JSON with this shape:",
  JSON.stringify({
    artifactKind: artifactKindForRole(input.roleId),
    payload: payloadExampleForRole(input.roleId),
  }, null, 2),
  "",
  "Input artifacts:",
  JSON.stringify(input.inputArtifacts, null, 2),
].join("\n");
