import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ProductRunMode = "dry_run" | "agent_write";

export interface RuntimeProductConfig {
  products: RuntimeProduct[];
}

export type ProductVerificationCommand = [string, ...string[]];

export interface ProductChangedFileGuard {
  whenAnyChanged: string[];
  mustAlsoChange: string[];
  message?: string;
}

export interface ProductVerificationPolicy {
  install?: ProductVerificationCommand[];
  checks?: ProductVerificationCommand[];
  changedFileGuards?: ProductChangedFileGuard[];
}

export interface RuntimeProduct {
  id: string;
  linear: {
    team: string;
    project: string;
  };
  github: {
    repo: string;
    baseBranch: string;
  };
  repoPath?: string;
  worktreesPath?: string;
  defaultRun: {
    startRun: boolean;
    mode: ProductRunMode;
    publish: boolean;
  };
  verification?: ProductVerificationPolicy;
}

export interface ProductPathResolutionOptions {
  cwd?: string;
  homeDir?: string;
}

export interface ResolvedProductPaths {
  repoPath: string;
  worktreesPath: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(
      `Product config was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const stringField = (value: Record<string, unknown>, field: string, context: string): string => {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
    throw new Error(`Product config ${context}.${field} must be a non-empty string`);
  }
  return fieldValue;
};

const optionalStringField = (
  value: Record<string, unknown>,
  field: string,
  context: string,
): string | undefined => {
  const fieldValue = value[field];
  if (fieldValue === undefined) return undefined;
  if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
    throw new Error(`Product config ${context}.${field} must be a non-empty string`);
  }
  return fieldValue;
};

const booleanField = (value: Record<string, unknown>, field: string, context: string): boolean => {
  const fieldValue = value[field];
  if (typeof fieldValue !== "boolean") {
    throw new Error(`Product config ${context}.${field} must be a boolean`);
  }
  return fieldValue;
};

const parseLinear = (value: unknown, context: string): RuntimeProduct["linear"] => {
  if (!isRecord(value)) throw new Error(`Product config ${context}.linear must be an object`);
  return {
    team: stringField(value, "team", `${context}.linear`),
    project: stringField(value, "project", `${context}.linear`),
  };
};

const parseGithub = (value: unknown, context: string): RuntimeProduct["github"] => {
  if (!isRecord(value)) throw new Error(`Product config ${context}.github must be an object`);
  const repo = stringField(value, "repo", `${context}.github`);
  assertGithubRepo(repo, `${context}.github.repo`);
  return {
    repo,
    baseBranch: optionalStringField(value, "baseBranch", `${context}.github`) ?? "main",
  };
};

const parseDefaultRun = (value: unknown, context: string): RuntimeProduct["defaultRun"] => {
  if (!isRecord(value)) throw new Error(`Product config ${context}.defaultRun must be an object`);
  const mode = stringField(value, "mode", `${context}.defaultRun`);
  if (mode !== "dry_run" && mode !== "agent_write") {
    throw new Error(`Product config ${context}.defaultRun.mode must be dry_run or agent_write`);
  }
  return {
    startRun: booleanField(value, "startRun", `${context}.defaultRun`),
    mode,
    publish: booleanField(value, "publish", `${context}.defaultRun`),
  };
};

const parseCommand = (value: unknown, context: string): ProductVerificationCommand => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Product config ${context} must be a non-empty string array`);
  }
  const command = value.map((part, index) => {
    if (typeof part !== "string" || part.trim().length === 0) {
      throw new Error(`Product config ${context}[${index}] must be a non-empty string`);
    }
    return part;
  });
  return command as ProductVerificationCommand;
};

const parseCommands = (
  value: Record<string, unknown>,
  field: string,
  context: string,
): ProductVerificationCommand[] | undefined => {
  const commands = value[field];
  if (commands === undefined) return undefined;
  if (!Array.isArray(commands)) {
    throw new Error(`Product config ${context}.${field} must be an array`);
  }
  return commands.map((command, index) => parseCommand(command, `${context}.${field}[${index}]`));
};

const stringArrayField = (
  value: Record<string, unknown>,
  field: string,
  context: string,
): string[] => {
  const fieldValue = value[field];
  if (!Array.isArray(fieldValue) || fieldValue.length === 0) {
    throw new Error(`Product config ${context}.${field} must be a non-empty string array`);
  }
  return fieldValue.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`Product config ${context}.${field}[${index}] must be a non-empty string`);
    }
    return item;
  });
};

const parseChangedFileGuards = (
  value: Record<string, unknown>,
  context: string,
): ProductChangedFileGuard[] | undefined => {
  const guards = value.changedFileGuards;
  if (guards === undefined) return undefined;
  if (!Array.isArray(guards)) {
    throw new Error(`Product config ${context}.changedFileGuards must be an array`);
  }
  return guards.map((guard, index) => {
    const guardContext = `${context}.changedFileGuards[${index}]`;
    if (!isRecord(guard)) throw new Error(`Product config ${guardContext} must be an object`);
    const parsed: ProductChangedFileGuard = {
      whenAnyChanged: stringArrayField(guard, "whenAnyChanged", guardContext),
      mustAlsoChange: stringArrayField(guard, "mustAlsoChange", guardContext),
    };
    const message = optionalStringField(guard, "message", guardContext);
    if (message !== undefined) parsed.message = message;
    return parsed;
  });
};

const parseVerification = (
  value: unknown,
  context: string,
): ProductVerificationPolicy | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Product config ${context}.verification must be an object`);
  const policy: ProductVerificationPolicy = {};
  const install = parseCommands(value, "install", `${context}.verification`);
  const checks = parseCommands(value, "checks", `${context}.verification`);
  const changedFileGuards = parseChangedFileGuards(value, `${context}.verification`);
  if (install !== undefined) policy.install = install;
  if (checks !== undefined) policy.checks = checks;
  if (changedFileGuards !== undefined) policy.changedFileGuards = changedFileGuards;
  return policy;
};

const parseProduct = (value: unknown, index: number): RuntimeProduct => {
  const context = `products[${index}]`;
  if (!isRecord(value)) throw new Error(`Product config ${context} must be an object`);
  const product: RuntimeProduct = {
    id: stringField(value, "id", context),
    linear: parseLinear(value.linear, context),
    github: parseGithub(value.github, context),
    defaultRun: parseDefaultRun(value.defaultRun, context),
  };
  const repoPath = optionalStringField(value, "repoPath", context);
  const worktreesPath = optionalStringField(value, "worktreesPath", context);
  const verification = parseVerification(value.verification, context);
  if (repoPath !== undefined) product.repoPath = repoPath;
  if (worktreesPath !== undefined) product.worktreesPath = worktreesPath;
  if (verification !== undefined) product.verification = verification;
  return product;
};

export const loadProductConfigFromJson = (json: string): RuntimeProductConfig => {
  const value = parseJson(json);
  if (!isRecord(value)) throw new Error("Product config must be an object");
  if (!Array.isArray(value.products)) throw new Error("Product config products must be an array");
  const products = value.products.map(parseProduct);
  if (products.length === 0)
    throw new Error("Product config products must contain at least one product");
  const seen = new Set<string>();
  for (const product of products) {
    if (seen.has(product.id))
      throw new Error(`Product config product id is duplicated: ${product.id}`);
    seen.add(product.id);
  }
  return { products };
};

export const loadProductConfigFromFile = (path: string): RuntimeProductConfig =>
  loadProductConfigFromJson(readFileSync(path, "utf8"));

export const findProductConfig = (
  config: RuntimeProductConfig,
  productId: string,
): RuntimeProduct => {
  const product = config.products.find((candidate) => candidate.id === productId);
  if (product === undefined)
    throw new Error(`Product config did not contain product: ${productId}`);
  return product;
};

export const splitGithubRepo = (repo: string): { owner: string; repo: string } => {
  assertGithubRepo(repo, "github repo");
  const [owner, name] = repo.split("/");
  return { owner: owner!, repo: name! };
};

export const defaultProductWorktreesPath = (githubRepo: string, homeDir = homedir()): string => {
  const { owner, repo } = splitGithubRepo(githubRepo);
  return join(homeDir, ".aigile", "worktrees", owner, repo);
};

export const expandHomePath = (path: string, homeDir = homedir()): string =>
  path === "~" ? homeDir : path.startsWith("~/") ? join(homeDir, path.slice(2)) : path;

export const resolveProductPaths = (
  product: RuntimeProduct,
  options: ProductPathResolutionOptions = {},
): ResolvedProductPaths => {
  const homeDir = options.homeDir ?? homedir();
  return {
    repoPath: expandHomePath(product.repoPath ?? options.cwd ?? process.cwd(), homeDir),
    worktreesPath: expandHomePath(
      product.worktreesPath ?? defaultProductWorktreesPath(product.github.repo, homeDir),
      homeDir,
    ),
  };
};

const assertGithubRepo = (repo: string, context: string): void => {
  const parts = repo.split("/");
  if (parts.length !== 2 || parts.some((part) => part.trim().length === 0)) {
    throw new Error(`Product config ${context} must be in owner/repo format`);
  }
};
