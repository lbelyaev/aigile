export type MergePolicy = "auto" | "manual";

// Per-ticket override, parsed from the issue description. Default is "auto"
// (auto-merge a green PR); a ticket can opt out so Aigile publishes the PR and
// pauses for a human/CI to merge.
const EXPLICIT_DIRECTIVE = /aigile-merge:\s*(auto|manual)\b/i;
const MANUAL_SHORTHAND = /\bno[-\s]?automerge\b|\bautomerge:\s*off\b/i;

export const resolveMergePolicy = (description: string | undefined): MergePolicy => {
  if (!description) return "auto";
  const explicit = EXPLICIT_DIRECTIVE.exec(description);
  if (explicit?.[1] !== undefined)
    return explicit[1].toLowerCase() === "manual" ? "manual" : "auto";
  if (MANUAL_SHORTHAND.test(description)) return "manual";
  return "auto";
};
