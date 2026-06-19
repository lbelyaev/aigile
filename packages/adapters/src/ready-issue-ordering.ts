import type { IssueRecord } from "./contracts.js";

const missingPriorityRank = Number.POSITIVE_INFINITY;
const missingCreatedAtRank = Number.POSITIVE_INFINITY;

const priorityRank = (issue: IssueRecord): number =>
  typeof issue.priority === "number" && issue.priority > 0 ? issue.priority : missingPriorityRank;

const createdAtRank = (issue: IssueRecord): number => {
  if (typeof issue.createdAt !== "string" || issue.createdAt.length === 0) return missingCreatedAtRank;
  const createdAt = Date.parse(issue.createdAt);
  return Number.isFinite(createdAt) ? createdAt : missingCreatedAtRank;
};

export const compareReadyIssues = (left: IssueRecord, right: IssueRecord): number => {
  const priorityComparison = priorityRank(left) - priorityRank(right);
  if (priorityComparison !== 0) return priorityComparison;

  const createdAtComparison = createdAtRank(left) - createdAtRank(right);
  if (createdAtComparison !== 0) return createdAtComparison;

  return left.key.localeCompare(right.key);
};

export const sortReadyIssues = (issues: readonly IssueRecord[]): IssueRecord[] =>
  [...issues].sort(compareReadyIssues);
