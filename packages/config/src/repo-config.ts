import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  ProductChangedFileGuard,
  ProductMergePolicy,
  ProductRunMode,
  ProductVerificationCommand,
  ProductVerificationPolicy,
  RuntimeProduct,
} from "./product-config.js";

export interface InRepoConfig {
  version: 1;
  id?: string;
  packageManager?: string;
  linear?: {
    team: string;
    project: string;
  };
  github?: {
    repo?: string;
    baseBranch?: string;
  };
  mergePolicy?: ProductMergePolicy;
  defaultRun?: {
    startRun: boolean;
    mode: ProductRunMode;
    publish: boolean;
  };
  verification?: ProductVerificationPolicy;
}

export interface RepoConfigDiscoveryResult {
  path?: string;
  config?: InRepoConfig;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(
      `Repo config was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const stringField = (value: Record<string, unknown>, field: string, context: string): string => {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
    throw new Error(`Repo config ${context}.${field} must be a non-empty string`);
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
    throw new Error(`Repo config ${context}.${field} must be a non-empty string`);
  }
  return fieldValue;
};

const booleanField = (value: Record<string, unknown>, field: string, context: string): boolean => {
  const fieldValue = value[field];
  if (typeof fieldValue !== "boolean") {
    throw new Error(`Repo config ${context}.${field} must be a boolean`);
  }
  return fieldValue;
};

const assertGithubRepo = (repo: string, context: string): void => {
  const parts = repo.split("/");
  if (parts.length !== 2 || parts.some((part) => part.trim().length === 0)) {
    throw new Error(`Repo config ${context} must be in owner/repo format`);
  }
};

const parseLinear = (value: unknown, context: string): InRepoConfig["linear"] | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Repo config ${context}.linear must be an object`);
  return {
    team: stringField(value, "team", `${context}.linear`),
    project: stringField(value, "project", `${context}.linear`),
  };
};

const parseGithub = (value: unknown, context: string): InRepoConfig["github"] | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Repo config ${context}.github must be an object`);
  const repo = optionalStringField(value, "repo", `${context}.github`);
  if (repo !== undefined) assertGithubRepo(repo, `${context}.github.repo`);
  const baseBranch = optionalStringField(value, "baseBranch", `${context}.github`);
  return {
    ...(repo === undefined ? {} : { repo }),
    ...(baseBranch === undefined ? {} : { baseBranch }),
  };
};

const parseDefaultRun = (
  value: unknown,
  context: string,
): InRepoConfig["defaultRun"] | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Repo config ${context}.defaultRun must be an object`);
  const mode = stringField(value, "mode", `${context}.defaultRun`);
  if (mode !== "dry_run" && mode !== "agent_write") {
    throw new Error(`Repo config ${context}.defaultRun.mode must be dry_run or agent_write`);
  }
  return {
    startRun: booleanField(value, "startRun", `${context}.defaultRun`),
    mode,
    publish: booleanField(value, "publish", `${context}.defaultRun`),
  };
};

const parseMergePolicy = (value: unknown, context: string): ProductMergePolicy | undefined => {
  if (value === undefined) return undefined;
  if (value !== "auto" && value !== "manual") {
    throw new Error(`Repo config ${context}.mergePolicy must be auto or manual`);
  }
  return value;
};

const parseCommand = (value: unknown, context: string): ProductVerificationCommand => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Repo config ${context} must be a non-empty string array`);
  }
  const command = value.map((part, index) => {
    if (typeof part !== "string" || part.trim().length === 0) {
      throw new Error(`Repo config ${context}[${index}] must be a non-empty string`);
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
    throw new Error(`Repo config ${context}.${field} must be an array`);
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
    throw new Error(`Repo config ${context}.${field} must be a non-empty string array`);
  }
  return fieldValue.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`Repo config ${context}.${field}[${index}] must be a non-empty string`);
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
    throw new Error(`Repo config ${context}.changedFileGuards must be an array`);
  }
  return guards.map((guard, index) => {
    const guardContext = `${context}.changedFileGuards[${index}]`;
    if (!isRecord(guard)) throw new Error(`Repo config ${guardContext} must be an object`);
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
  if (!isRecord(value)) throw new Error(`Repo config ${context}.verification must be an object`);
  const policy: ProductVerificationPolicy = {};
  const install = parseCommands(value, "install", `${context}.verification`);
  const checks = parseCommands(value, "checks", `${context}.verification`);
  const changedFileGuards = parseChangedFileGuards(value, `${context}.verification`);
  if (install !== undefined) policy.install = install;
  if (checks !== undefined) policy.checks = checks;
  if (changedFileGuards !== undefined) policy.changedFileGuards = changedFileGuards;
  return policy;
};

export const loadRepoConfigFromJson = (json: string): InRepoConfig => {
  const value = parseJson(json);
  if (!isRecord(value)) throw new Error("Repo config must be an object");
  if (value.version !== 1) throw new Error("Repo config version must be 1");
  const id = optionalStringField(value, "id", "");
  const packageManager = optionalStringField(value, "packageManager", "");
  const linear = parseLinear(value.linear, "");
  const github = parseGithub(value.github, "");
  const mergePolicy = parseMergePolicy(value.mergePolicy, "");
  const defaultRun = parseDefaultRun(value.defaultRun, "");
  const verification = parseVerification(value.verification, "");
  return {
    version: 1,
    ...(id === undefined ? {} : { id }),
    ...(packageManager === undefined ? {} : { packageManager }),
    ...(linear === undefined ? {} : { linear }),
    ...(github === undefined ? {} : { github }),
    ...(mergePolicy === undefined ? {} : { mergePolicy }),
    ...(defaultRun === undefined ? {} : { defaultRun }),
    ...(verification === undefined ? {} : { verification }),
  };
};

export const loadRepoConfigFromFile = (path: string): InRepoConfig =>
  loadRepoConfigFromJson(readFileSync(path, "utf8"));

export const findRepoConfig = (cwd = process.cwd()): RepoConfigDiscoveryResult => {
  let current = cwd;
  while (true) {
    const configPath = join(current, ".aigile.json");
    if (existsSync(configPath))
      return { path: configPath, config: loadRepoConfigFromFile(configPath) };
    if (existsSync(join(current, ".git"))) return {};
    const parent = dirname(current);
    if (parent === current) return {};
    current = parent;
  }
};

export const repoConfigToProduct = (config: InRepoConfig, repoPath: string): RuntimeProduct => {
  if (config.linear === undefined) throw new Error("Repo config linear must be set");
  const product: RuntimeProduct = {
    id: config.id ?? basename(repoPath),
    linear: config.linear,
    github: {
      ...(config.github?.repo === undefined ? {} : { repo: config.github.repo }),
      baseBranch: config.github?.baseBranch ?? "main",
    } as RuntimeProduct["github"],
    repoPath,
    mergePolicy: config.mergePolicy ?? "auto",
    defaultRun: config.defaultRun ?? { startRun: false, mode: "dry_run", publish: false },
  };
  if (config.packageManager !== undefined) product.packageManager = config.packageManager;
  if (config.verification !== undefined) product.verification = config.verification;
  return product;
};
