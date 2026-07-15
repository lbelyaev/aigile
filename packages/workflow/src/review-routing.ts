export type ReviewDepth = "light" | "deep";
export type ReviewStrategyMode = "light" | "deep-parallel" | "full";

export interface WorkflowReviewStrategy {
  mode: ReviewStrategyMode;
  reviewers: readonly string[];
  angles: readonly string[];
  maxFindings: number;
  validationBudget: {
    maxCalls: number;
    maxMinutes: number;
  };
  concurrency: number;
  skillHints?: readonly string[];
}

export interface WorkflowReviewStrategyConfig {
  defaultMode?: ReviewStrategyMode;
  highRiskMode?: ReviewStrategyMode;
  strategies?: Partial<Record<ReviewStrategyMode, WorkflowReviewStrategy>>;
}

const DEFAULT_REVIEW_STRATEGIES: Record<ReviewStrategyMode, WorkflowReviewStrategy> = {
  light: {
    mode: "light",
    reviewers: ["checker"],
    angles: ["correctness"],
    maxFindings: 3,
    validationBudget: { maxCalls: 1, maxMinutes: 5 },
    concurrency: 1,
    skillHints: ["code_review"],
  },
  "deep-parallel": {
    mode: "deep-parallel",
    reviewers: ["deep_reviewer"],
    angles: ["correctness", "removed-behavior", "cross-file", "tests-faithful-to-reality"],
    maxFindings: 1,
    validationBudget: { maxCalls: 8, maxMinutes: 10 },
    concurrency: 4,
    skillHints: ["code_review"],
  },
  full: {
    mode: "full",
    reviewers: ["deep_reviewer"],
    angles: ["correctness", "removed-behavior", "cross-file", "tests-faithful-to-reality"],
    maxFindings: 10,
    validationBudget: { maxCalls: 20, maxMinutes: 20 },
    concurrency: 4,
    skillHints: ["code_review"],
  },
};

const normalizedPath = (filePath: string): string => filePath.replaceAll("\\", "/");

const isHighBlastRadiusPath = (filePath: string): boolean => {
  const path = normalizedPath(filePath);
  const fileName = path.split("/").at(-1);
  return (
    fileName === "reducer.ts" ||
    fileName === "engine.ts" ||
    fileName?.startsWith("engine-") === true ||
    path.includes("/workflow/") ||
    path.startsWith("packages/workflow/") ||
    path.endsWith("/workflow")
  );
};

export const reviewDepthForChangedFiles = (changedFiles: readonly string[]): ReviewDepth =>
  changedFiles.some(isHighBlastRadiusPath) ? "deep" : "light";

export const reviewStrategyForChangedFiles = (
  changedFiles: readonly string[],
  config: WorkflowReviewStrategyConfig = {},
): WorkflowReviewStrategy => {
  const mode =
    reviewDepthForChangedFiles(changedFiles) === "deep"
      ? (config.highRiskMode ?? "deep-parallel")
      : (config.defaultMode ?? "light");
  return config.strategies?.[mode] ?? DEFAULT_REVIEW_STRATEGIES[mode];
};

export const reviewRoleForChangedFiles = (
  changedFiles: readonly string[],
  config?: WorkflowReviewStrategyConfig,
): string =>
  reviewStrategyForChangedFiles(changedFiles, config).reviewers.includes("deep_reviewer")
    ? "deep_reviewer"
    : "checker";
