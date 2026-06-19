export {
  issueToArtifact,
  pullRequestToArtifact,
} from "./contracts.js";

export {
  createFakeCodeHostAdapter,
  createFakeIssueTrackerAdapter,
} from "./fakes.js";

export {
  createGitHubCliCodeHostAdapter,
} from "./github-cli.js";

export type {
  CheckResult,
  CodeHostAdapter,
  IssueArtifact,
  IssueRecord,
  IssueTrackerAdapter,
  PullRequestArtifact,
  PullRequestInput,
  PullRequestRecord,
} from "./contracts.js";

export type {
  GitHubCliCodeHostAdapterOptions,
  GitHubCliExec,
  GitHubCliExecResult,
} from "./github-cli.js";
