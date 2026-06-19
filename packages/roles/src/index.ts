export {
  createRoleRuntimeRegistry,
  createScriptedRoleRunner,
  runAssignedRole,
} from "./runner.js";

export {
  buildAcpRuntimeConnectInput,
  createAcpRoleRunner,
} from "./acp-runner.js";

export {
  buildRolePrompt,
  getDefaultRoleInstruction,
} from "./prompts.js";

export type {
  RoleRunInput,
  RoleRunner,
  RoleRuntimeRegistry,
  RoleRuntimeRegistryConfig,
  RunAssignedRoleInput,
  ScriptedRoleOutput,
} from "./runner.js";

export type {
  AcpRoleProgressEvent,
  AcpRoleRunnerOptions,
  AcpRuntimeConnection,
  AcpRuntimeConnector,
} from "./acp-runner.js";

export type {
  BuildRolePromptInput,
} from "./prompts.js";
