import type { ReviewFinding, ReviewPunchListPayload, ReviewFindingSeverity } from "@aigile/types";

const severityRank: Record<ReviewFindingSeverity, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const normalizedText = (value: string): string =>
  value.trim().replaceAll(/\s+/g, " ").toLowerCase();

const findingKey = (finding: ReviewFinding): string =>
  [
    normalizedText(finding.file),
    finding.line,
    normalizedText(finding.scenario),
    finding.severity,
  ].join(":");

const byPriority = (left: ReviewFinding, right: ReviewFinding): number => {
  const severity = severityRank[right.severity] - severityRank[left.severity];
  if (severity !== 0) return severity;
  const confidence = right.confidence - left.confidence;
  if (confidence !== 0) return confidence;
  const file = left.file.localeCompare(right.file);
  if (file !== 0) return file;
  const line = left.line - right.line;
  if (line !== 0) return line;
  return left.scenario.localeCompare(right.scenario);
};

export const deduplicateReviewFindings = (findings: readonly ReviewFinding[]): ReviewFinding[] => {
  const byKey = new Map<string, ReviewFinding>();
  for (const finding of findings) {
    const key = findingKey(finding);
    const existing = byKey.get(key);
    if (existing === undefined || byPriority(finding, existing) < 0) {
      byKey.set(key, finding);
    }
  }
  return [...byKey.values()].sort(byPriority);
};

export const createDeveloperPunchList = (
  findings: readonly ReviewFinding[],
  maxFindings = Number.POSITIVE_INFINITY,
): ReviewPunchListPayload => ({
  findings: deduplicateReviewFindings(findings).slice(0, maxFindings),
});
