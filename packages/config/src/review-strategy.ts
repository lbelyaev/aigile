export type ReviewStrategyMode = "light" | "deep-parallel" | "full";
export type ReviewStrategyReviewer = "checker" | "deep_reviewer";

export interface ReviewValidationBudget {
  maxCalls: number;
  maxMinutes: number;
}

export interface ReviewStrategy {
  mode: ReviewStrategyMode;
  reviewers: ReviewStrategyReviewer[];
  angles: string[];
  maxFindings: number;
  validationBudget: ReviewValidationBudget;
  concurrency: number;
  skillHints?: string[];
}

export interface ReviewStrategyConfig {
  defaultMode: ReviewStrategyMode;
  highRiskMode: ReviewStrategyMode;
  strategies: Record<ReviewStrategyMode, ReviewStrategy>;
}

const REVIEW_STRATEGY_MODES = ["light", "deep-parallel", "full"] as const;
const REVIEW_STRATEGY_REVIEWERS = ["checker", "deep_reviewer"] as const;
const REVIEW_ANGLES = [
  "correctness",
  "removed-behavior",
  "cross-file",
  "tests-faithful-to-reality",
] as const;

const DEFAULT_REVIEW_STRATEGIES: ReviewStrategyConfig = {
  defaultMode: "light",
  highRiskMode: "deep-parallel",
  strategies: {
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
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cloneDefaults = (): ReviewStrategyConfig => structuredClone(DEFAULT_REVIEW_STRATEGIES);

const parseMode = (
  value: unknown,
  context: string,
  fallback: ReviewStrategyMode,
): ReviewStrategyMode => {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !REVIEW_STRATEGY_MODES.includes(value as ReviewStrategyMode)) {
    throw new Error(`${context} must be light, deep-parallel, or full`);
  }
  return value as ReviewStrategyMode;
};

const parsePositiveInteger = (value: unknown, context: string, fallback: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${context} must be a positive integer`);
  }
  return value;
};

const parseStringArray = (value: unknown, context: string, fallback: string[]): string[] => {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty string array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${context}[${index}] must be a non-empty string`);
    }
    return entry;
  });
};

const parseAngleArray = (value: unknown, context: string, fallback: string[]): string[] =>
  parseStringArray(value, context, fallback).map((angle) => {
    if (!REVIEW_ANGLES.includes(angle as (typeof REVIEW_ANGLES)[number])) {
      throw new Error(`${context} must contain known review angles`);
    }
    return angle;
  });

const parseReviewerArray = (
  value: unknown,
  context: string,
  fallback: ReviewStrategyReviewer[],
): ReviewStrategyReviewer[] =>
  parseStringArray(value, context, fallback).map((reviewer) => {
    if (!REVIEW_STRATEGY_REVIEWERS.includes(reviewer as ReviewStrategyReviewer)) {
      throw new Error(`${context} must contain only checker or deep_reviewer`);
    }
    return reviewer as ReviewStrategyReviewer;
  });

const parseOptionalStringArray = (
  value: unknown,
  context: string,
  fallback: string[] | undefined,
): string[] | undefined => {
  if (value === undefined) return fallback;
  return parseStringArray(value, context, []);
};

const parseValidationBudget = (
  value: unknown,
  context: string,
  fallback: ReviewValidationBudget,
): ReviewValidationBudget => {
  if (value === undefined) return fallback;
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  return {
    maxCalls: parsePositiveInteger(value.maxCalls, `${context}.maxCalls`, fallback.maxCalls),
    maxMinutes: parsePositiveInteger(
      value.maxMinutes,
      `${context}.maxMinutes`,
      fallback.maxMinutes,
    ),
  };
};

const parseStrategy = (
  mode: ReviewStrategyMode,
  value: unknown,
  fallback: ReviewStrategy,
): ReviewStrategy => {
  if (value === undefined) return fallback;
  if (!isRecord(value)) throw new Error(`Review strategy ${mode} must be an object`);
  const strategy: ReviewStrategy = {
    mode,
    reviewers: parseReviewerArray(
      value.reviewers,
      `Review strategy ${mode}.reviewers`,
      fallback.reviewers,
    ),
    angles: parseAngleArray(value.angles, `Review strategy ${mode}.angles`, fallback.angles),
    maxFindings: parsePositiveInteger(
      value.maxFindings,
      `Review strategy ${mode}.maxFindings`,
      fallback.maxFindings,
    ),
    validationBudget: parseValidationBudget(
      value.validationBudget,
      `Review strategy ${mode}.validationBudget`,
      fallback.validationBudget,
    ),
    concurrency: parsePositiveInteger(
      value.concurrency,
      `Review strategy ${mode}.concurrency`,
      fallback.concurrency,
    ),
  };
  const skillHints = parseOptionalStringArray(
    value.skillHints,
    `Review strategy ${mode}.skillHints`,
    fallback.skillHints,
  );
  if (skillHints !== undefined) strategy.skillHints = skillHints;
  if (strategy.reviewers.includes("deep_reviewer") && strategy.angles.length < 2) {
    throw new Error(`Review strategy ${mode} with deep_reviewer must declare at least two angles`);
  }
  return strategy;
};

export const loadReviewStrategyConfig = (value: unknown): ReviewStrategyConfig => {
  const config = cloneDefaults();
  if (value === undefined) return config;
  if (!isRecord(value)) throw new Error("Runtime config reviewStrategies must be an object");
  config.defaultMode = parseMode(
    value.defaultMode,
    "Runtime config reviewStrategies.defaultMode",
    config.defaultMode,
  );
  config.highRiskMode = parseMode(
    value.highRiskMode,
    "Runtime config reviewStrategies.highRiskMode",
    config.highRiskMode,
  );
  const strategies = value.strategies;
  if (strategies === undefined) return config;
  if (!isRecord(strategies))
    throw new Error("Runtime config reviewStrategies.strategies must be an object");
  for (const key of Object.keys(strategies)) {
    if (!REVIEW_STRATEGY_MODES.includes(key as ReviewStrategyMode)) {
      throw new Error(`Unknown review strategy mode: ${key}`);
    }
    const mode = key as ReviewStrategyMode;
    config.strategies[mode] = parseStrategy(mode, strategies[key], config.strategies[mode]);
  }
  return config;
};
