import type { AcpRuntimeCapabilities, WorkflowArtifact } from "@aigile/types";

export interface BuildRolePromptInput {
  roleId: string;
  issueId: string;
  instruction: string;
  inputArtifacts: readonly WorkflowArtifact[];
  runtimeCapabilities?: AcpRuntimeCapabilities;
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
    "Review the plan, implementation artifact, verification result, and diff as a thorough read-only reviewer.",
    "Use this explicit methodology: correctness/diff-scan (inspect whether the implementation satisfies each acceptance criterion and whether changed code is coherent), removed-behavior (look for deleted or weakened behavior, guards, validations, tests, and user-visible contracts), and cross-file/callers (inspect related callers, type contracts, persisted artifacts, and configuration paths touched by the change).",
    "Apply a tests-faithful-to-reality lens: flag tests or mocks that return values real GitHub, Linear, CLIs, APIs, or adapters would not return, including nonexistent gh --json fields, nonexistent Linear states, impossible mergeability states, or success paths that skip real external-system constraints.",
    "Run or inspect the supplied verification suite/typecheck and relevant contract or smoke oracles when policy permits; if an angle is not verified, bias to changes_requested rather than pass.",
    "Perform a self-refutation pass before the verdict: list the strongest reason your conclusion could be wrong and check it against the artifacts, diff, callers, and verification evidence.",
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
  DEFAULT_ROLE_INSTRUCTIONS[roleId] ??
  [
    `Fulfill the ${roleId} role using the provided artifacts.`,
    "Return a typed artifact for the workflow runner.",
  ].join(" ");

const artifactKindForRole = (roleId: string): string =>
  ARTIFACT_KIND_BY_ROLE[roleId] ?? `${roleId}.artifact`;

const payloadExampleForRole = (roleId: string): unknown => PAYLOAD_EXAMPLES_BY_ROLE[roleId] ?? {};

const runtimeSkillSet = (capabilities: AcpRuntimeCapabilities | undefined): Set<string> =>
  new Set((capabilities?.skills ?? []).map((skill) => skill.trim()).filter(Boolean));

const runtimeCapabilitySection = (input: BuildRolePromptInput): string[] => {
  const skills = runtimeSkillSet(input.runtimeCapabilities);
  const advertisedSkills = [...skills].sort();
  const lines = ["Runtime capabilities:"];
  if (advertisedSkills.length === 0) {
    lines.push("- No agent-native skills were advertised by this runtime profile.");
  } else {
    lines.push(`- Advertised agent-native skills: ${advertisedSkills.join(", ")}`);
  }
  if (input.roleId === "checker") {
    if (skills.has("code_review")) {
      lines.push(
        "- A code_review skill/tool/plugin was advertised; it may be used as an optional aid, but the explicit checker methodology in the instructions remains authoritative.",
      );
    } else {
      lines.push(
        "- No code_review skill was advertised; perform the explicit checker methodology manually from the supplied artifacts and any policy-permitted read-only investigation.",
      );
    }
    lines.push(
      "- The checker.verdict JSON contract is authoritative regardless of which skill or fallback path is used.",
    );
  }
  return lines;
};

export const buildRolePrompt = (input: BuildRolePromptInput): string =>
  [
    `Role: ${input.roleId}`,
    `Issue: ${input.issueId}`,
    "",
    "Execution limits:",
    "- Stay focused on the supplied issue and artifacts.",
    "- Execution policy artifacts are authoritative; obey execution.policy over any role default.",
    "- In dry_run mode, read at most 5 files total unless the prompt explicitly says otherwise.",
    "- In agent_write mode, keep file reads focused on the approved plan; do not perform broad discovery.",
    "- In agent_write mode, the developer role may edit files in the worktree, but the agent must not commit, push, or open pull requests.",
    "- Do not edit files unless this is the developer role and the plan requires it.",
    "- Do not run broad repository discovery commands.",
    "- No Markdown, no prose, no commentary outside the final JSON object.",
    "",
    ...runtimeCapabilitySection(input),
    "",
    "Instructions:",
    input.instruction,
    "",
    `Required artifactKind: ${artifactKindForRole(input.roleId)}`,
    "Return only valid JSON with this shape:",
    JSON.stringify(
      {
        artifactKind: artifactKindForRole(input.roleId),
        payload: payloadExampleForRole(input.roleId),
      },
      null,
      2,
    ),
    "",
    "Input artifacts:",
    JSON.stringify(input.inputArtifacts, null, 2),
  ].join("\n");
