import type { WorkflowArtifact } from "@aigile/types";

export interface BuildRolePromptInput {
  roleId: string;
  issueId: string;
  instruction: string;
  inputArtifacts: readonly WorkflowArtifact[];
}

const DEFAULT_ROLE_INSTRUCTIONS: Record<string, string> = {
  architect: [
    "Produce the Definition of Ready for the issue.",
    "Define scope, non-goals, implementation plan, risks, and executable acceptance criteria.",
    "Do not modify code.",
  ].join(" "),
  developer: [
    "Implement the approved plan and return an implementation artifact.",
    "Summarize changed files, verification expectations, and any unresolved issues.",
    "Do not claim verification passed unless a verifier artifact says so.",
  ].join(" "),
  checker: [
    "Review the plan, implementation artifact, and verification result.",
    "Return a verdict of pass, changes_requested, or escalate with grounded reasons.",
    "Do not merge or update source-of-truth systems directly.",
  ].join(" "),
};

export const getDefaultRoleInstruction = (roleId: string): string =>
  DEFAULT_ROLE_INSTRUCTIONS[roleId] ?? [
    `Fulfill the ${roleId} role using the provided artifacts.`,
    "Return a typed artifact for the workflow runner.",
  ].join(" ");

export const buildRolePrompt = (input: BuildRolePromptInput): string => [
  `Role: ${input.roleId}`,
  `Issue: ${input.issueId}`,
  "",
  "Instructions:",
  input.instruction,
  "",
  "Return only valid JSON with this shape:",
  JSON.stringify({
    artifactKind: `${input.roleId}.artifact`,
    payload: {},
  }),
  "",
  "Input artifacts:",
  JSON.stringify(input.inputArtifacts, null, 2),
].join("\n");
