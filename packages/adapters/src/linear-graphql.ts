import type { IssueRecord, IssueTrackerAdapter } from "./contracts.js";

export type LinearFetchGraphql = (
  query: string,
  variables: Record<string, unknown>,
  options: { apiKey: string; endpoint: string },
) => Promise<unknown>;

export interface LinearGraphqlIssueTrackerAdapterOptions {
  apiKey: string;
  endpoint?: string;
  fetchGraphql?: LinearFetchGraphql;
}

interface LinearIssueResponse {
  issue?: {
    id?: unknown;
    identifier?: unknown;
    title?: unknown;
    description?: unknown;
    priority?: unknown;
    state?: { name?: unknown };
    comments?: { nodes?: Array<{ body?: unknown }> };
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
  const json = await response.json() as { data?: unknown; errors?: unknown };
  if (json.errors) throw new Error(`Linear GraphQL returned errors: ${JSON.stringify(json.errors)}`);
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
  if (typeof value !== "string" || value.length === 0) throw new Error(`Linear issue missing ${field}`);
  return value;
};

const toIssueRecord = (value: unknown, key: string): IssueRecord => {
  const response = value as LinearIssueResponse;
  const issue = response.issue;
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
  return record;
};

export const createLinearGraphqlIssueTrackerAdapter = (
  options: LinearGraphqlIssueTrackerAdapterOptions,
): IssueTrackerAdapter => {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchGraphql = options.fetchGraphql ?? defaultFetchGraphql;
  const request = (query: string, variables: Record<string, unknown>): Promise<unknown> =>
    fetchGraphql(query, variables, { apiKey: options.apiKey, endpoint });

  return {
    getIssue: async (key) => toIssueRecord(await request(`
      query IssueByKey($key: String!) {
        issue(id: $key) {
          id
          identifier
          title
          description
          priority
          state { name }
          comments { nodes { body } }
        }
      }
    `, { key }), key),
    updateIssueStatus: async (key, status) => {
      await request(`
        mutation UpdateIssueStatus($key: String!, $status: String!) {
          issueUpdate(id: $key, input: { stateId: $status }) { success }
        }
      `, { key, status });
    },
    appendIssueComment: async (key, body) => {
      await request(`
        mutation CreateIssueComment($key: String!, $body: String!) {
          commentCreate(input: { issueId: $key, body: $body }) { success }
        }
      `, { key, body });
    },
  };
};
