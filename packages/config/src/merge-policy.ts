import type { ProductMergePolicy } from "./product-config.js";

export type MergePolicy = ProductMergePolicy;

// Per-ticket override, parsed from the issue description. The product config
// supplies the default; a ticket can override it explicitly.
const EXPLICIT_DIRECTIVE = /aigile-merge:\s*(auto|manual)\b/i;
const MANUAL_SHORTHAND = /\bno[-\s]?automerge\b|\bautomerge:\s*off\b/i;

export const issueMergePolicyOverride = (
  description: string | undefined,
): MergePolicy | undefined => {
  if (!description) return undefined;
  const explicit = EXPLICIT_DIRECTIVE.exec(description);
  if (explicit?.[1] !== undefined)
    return explicit[1].toLowerCase() === "manual" ? "manual" : "auto";
  if (MANUAL_SHORTHAND.test(description)) return "manual";
  return undefined;
};

export const effectiveMergePolicy = (
  productDefault: MergePolicy | undefined,
  issueDescription: string | undefined,
): MergePolicy => issueMergePolicyOverride(issueDescription) ?? productDefault ?? "auto";

export const resolveMergePolicy = (description: string | undefined): MergePolicy =>
  effectiveMergePolicy(undefined, description);
