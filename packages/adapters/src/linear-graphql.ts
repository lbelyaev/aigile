import type { IssueRecord, IssueTrackerAdapter, ReadyIssueSource } from "./contracts.js";
import { sortReadyIssues } from "./ready-issue-ordering.js";

export type LinearFetchGraphql = (
  query: string,
  variables: Record<string, unknown>,
  options: { apiKey: string; endpoint: string },
) => Promise<unknown>;

export interface LinearGraphqlIssueTrackerAdapterOptions {
  apiKey: string;
  endpoint?: string;
  teamKey?: string;
  fetchGraphql?: LinearFetchGraphql;
}

export interface LinearGraphqlReadyIssueSourceOptions {
  apiKey: string;
  teamKey: string;
  readyStatus: string;
  endpoint?: string;
  first?: number;
  fetchGraphql?: LinearFetchGraphql;
}

export interface LinearTeam {
  key: string;
  name: string;
}

export interface LinearGraphqlListTeamsOptions {
  apiKey: string;
  endpoint?: string;
  first?: number;
  fetchGraphql?: LinearFetchGraphql;
}

export interface LinearGraphqlListWorkflowStateNamesOptions {
  apiKey: string;
  teamKey: string;
  endpoint?: string;
  first?: number;
  fetchGraphql?: LinearFetchGraphql;
}

interface LinearIssueResponse {
  issue?: {
    id?: unknown;
    identifier?: unknown;
    title?: unknown;
    description?: unknown;
    priority?: unknown;
    createdAt?: unknown;
    state?: { name?: unknown };
    project?: { id?: unknown; name?: unknown; key?: unknown; slug?: unknown } | null;
    comments?: { nodes?: Array<{ body?: unknown }> };
  };
}

interface LinearIssuesResponse {
  issues?: {
    nodes?: unknown[];
  };
}

interface LinearWorkflowStatesResponse {
  workflowStates?: {
    nodes?: Array<{ id?: unknown; name?: unknown }>;
  };
}

interface LinearTeamsResponse {
  teams?: {
    nodes?: Array<{ key?: unknown; name?: unknown }>;
  };
}

interface LinearIssueIdResponse {
  issue?: {
    id?: unknown;
  };
}

const DEFAULT_ENDPOINT = "https://api.linear.app/graphql";

const defaultFetchGraphql: LinearFetchGraphql = async (query, variables, options) => {
  const response = await fetch(options.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: options.apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`Linear GraphQL request failed (${response.status}): ${await response.text()}`);
  }
  const json = (await response.json()) as { data?: unknown; errors?: unknown };
  if (json.errors)
    throw new Error(`Linear GraphQL returned errors: ${JSON.stringify(json.errors)}`);
  return json.data;
};

const extractAcceptanceCriteria = (description: string): string[] => {
  const acceptanceIndex = description.toLowerCase().indexOf("acceptance:");
  if (acceptanceIndex < 0) return [];
  return description
    .slice(acceptanceIndex + "acceptance:".length)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
};

const asString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Linear issue missing ${field}`);
  return value;
};

const toIssueRecordFromIssue = (issue: LinearIssueResponse["issue"], key: string): IssueRecord => {
  if (!issue) throw new Error(`Linear issue not found: ${key}`);
  const description = typeof issue.description === "string" ? issue.description : "";
  const record: IssueRecord = {
    id: asString(issue.id, "id"),
    key: asString(issue.identifier, "identifier"),
    title: asString(issue.title, "title"),
    description,
    acceptanceCriteria: extractAcceptanceCriteria(description),
    status: typeof issue.state?.name === "string" ? issue.state.name : "",
    comments: (issue.comments?.nodes ?? [])
      .map((comment) => comment.body)
      .filter((body): body is string => typeof body === "string"),
  };
  if (typeof issue.priority === "number") record.priority = issue.priority;
  if (typeof issue.createdAt === "string") record.createdAt = issue.createdAt;
  if (
    typeof issue.project?.id === "string" &&
    issue.project.id.length > 0 &&
    typeof issue.project.name === "string" &&
    issue.project.name.length > 0
  ) {
    record.project = {
      id: issue.project.id,
      name: issue.project.name,
    };
    if (typeof issue.project.key === "string" && issue.project.key.length > 0) {
      record.project.key = issue.project.key;
    }
    if (typeof issue.project.slug === "string" && issue.project.slug.length > 0) {
      record.project.slug = issue.project.slug;
    }
  }
  return record;
};

const toIssueRecord = (value: unknown, key: string): IssueRecord => {
  const response = value as LinearIssueResponse;
  return toIssueRecordFromIssue(response.issue, key);
};

const toIssueRecords = (value: unknown): IssueRecord[] => {
  const response = value as LinearIssuesResponse;
  return (response.issues?.nodes ?? []).map((issue) =>
    toIssueRecordFromIssue(issue as LinearIssueResponse["issue"], "ready issue"),
  );
};

const looksLikeUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export const listLinearTeams = async (
  options: LinearGraphqlListTeamsOptions,
): Promise<LinearTeam[]> => {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchGraphql = options.fetchGraphql ?? defaultFetchGraphql;
  const response = await fetchGraphql(
    `
    query LinearTeams($first: Int!) {
      teams(first: $first) {
        nodes { key name }
      }
    }
  `,
    { first: options.first ?? 100 },
    { apiKey: options.apiKey, endpoint },
  );
  return ((response as LinearTeamsResponse).teams?.nodes ?? [])
    .filter(
      (team): team is { key: string; name: string } =>
        typeof team.key === "string" &&
        team.key.length > 0 &&
        typeof team.name === "string" &&
        team.name.length > 0,
    )
    .map((team) => ({ key: team.key, name: team.name }));
};

export const listLinearWorkflowStateNames = async (
  options: LinearGraphqlListWorkflowStateNamesOptions,
): Promise<string[]> => {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchGraphql = options.fetchGraphql ?? defaultFetchGraphql;
  const response = await fetchGraphql(
    `
    query WorkflowStatesByTeam($teamKey: String!, $first: Int!) {
      workflowStates(filter: { team: { key: { eq: $teamKey } } }, first: $first) {
        nodes { name }
      }
    }
  `,
    {
      teamKey: options.teamKey,
      first: options.first ?? 100,
    },
    { apiKey: options.apiKey, endpoint },
  );
  return ((response as LinearWorkflowStatesResponse).workflowStates?.nodes ?? [])
    .map((state) => state.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
};

export const createLinearGraphqlIssueTrackerAdapter = (
  options: LinearGraphqlIssueTrackerAdapterOptions,
): IssueTrackerAdapter => {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchGraphql = options.fetchGraphql ?? defaultFetchGraphql;
  const request = (query: string, variables: Record<string, unknown>): Promise<unknown> =>
    fetchGraphql(query, variables, { apiKey: options.apiKey, endpoint });
  const resolveIssueId = async (key: string): Promise<string> => {
    if (options.teamKey === undefined || looksLikeUuid(key)) return key;
    const response = await request(
      `
      query IssueIdByKey($key: String!) {
        issue(id: $key) { id }
      }
    `,
      { key },
    );
    const issueId = (response as LinearIssueIdResponse).issue?.id;
    if (typeof issueId !== "string" || issueId.length === 0) {
      throw new Error(`Linear issue not found: ${key}`);
    }
    return issueId;
  };
  const resolveWorkflowStateId = async (status: string): Promise<string> => {
    if (options.teamKey === undefined || looksLikeUuid(status)) return status;
    const response = await request(
      `
      query WorkflowStateByName($teamKey: String!, $name: String!) {
        workflowStates(filter: { team: { key: { eq: $teamKey } }, name: { eq: $name } }, first: 1) {
          nodes { id name }
        }
      }
    `,
      { teamKey: options.teamKey, name: status },
    );
    const nodes = (response as LinearWorkflowStatesResponse).workflowStates?.nodes ?? [];
    const stateId = nodes[0]?.id;
    if (typeof stateId !== "string" || stateId.length === 0) {
      throw new Error(`Linear workflow state not found for team ${options.teamKey}: ${status}`);
    }
    return stateId;
  };

  return {
    getIssue: async (key) =>
      toIssueRecord(
        await request(
          `
      query IssueByKey($key: String!) {
        issue(id: $key) {
          id
          identifier
          title
          description
          priority
          createdAt
          state { name }
          project { id name }
          comments { nodes { body } }
        }
      }
    `,
          { key },
        ),
        key,
      ),
    updateIssueStatus: async (key, status) => {
      const stateId = await resolveWorkflowStateId(status);
      const issueId = await resolveIssueId(key);
      await request(
        `
        mutation UpdateIssueStatus($key: String!, $status: String!) {
          issueUpdate(id: $key, input: { stateId: $status }) { success }
        }
      `,
        { key: issueId, status: stateId },
      );
    },
    appendIssueComment: async (key, body) => {
      const issueId = await resolveIssueId(key);
      await request(
        `
        mutation CreateIssueComment($key: String!, $body: String!) {
          commentCreate(input: { issueId: $key, body: $body }) { success }
        }
      `,
        { key: issueId, body },
      );
    },
  };
};

export const createLinearGraphqlReadyIssueSource = (
  options: LinearGraphqlReadyIssueSourceOptions,
): ReadyIssueSource => {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchGraphql = options.fetchGraphql ?? defaultFetchGraphql;
  const request = (query: string, variables: Record<string, unknown>): Promise<unknown> =>
    fetchGraphql(query, variables, { apiKey: options.apiKey, endpoint });

  return {
    listReadyIssues: async () =>
      sortReadyIssues(
        toIssueRecords(
          await request(
            `
            query ReadyIssues($teamKey: String!, $readyStatus: String!, $first: Int!) {
              issues(
                filter: {
                  team: { key: { eq: $teamKey } }
                  state: { name: { eq: $readyStatus } }
                }
                first: $first
              ) {
                nodes {
                  id
                  identifier
                  title
                  description
                  priority
                  createdAt
                  state { name }
                  project { id name }
                  comments { nodes { body } }
                }
              }
            }
          `,
            {
              teamKey: options.teamKey,
              readyStatus: options.readyStatus,
              first: options.first ?? 25,
            },
          ),
        ),
      ),
  };
};
