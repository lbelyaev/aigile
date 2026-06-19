# Ticketing Adapter And Unified Issue Schema Plan

## Goal

Aigile should treat ticketing systems as interchangeable sources of record. Linear, Jira, and GitHub Issues should all support the same core workflow:

1. Discover candidate work.
2. Select and claim one eligible ticket.
3. Read complete ticket context.
4. Publish architect, developer, verifier, checker, PR, and terminal status updates.
5. Route the ticket to the repository/product configuration that owns the work.

The ticketing system remains the operator-facing board. Aigile should not require operators to drive normal work from CLI arguments once a watch configuration exists.

## Non-Goals

- Full Jira/Linear/GitHub feature parity in the first slice.
- Real-time webhooks as the only ingestion mode. Polling remains valid for local PoC.
- Parallel issue execution. MVP stays single-worker and deterministic.
- Provider-specific workflow logic leaking into the FSM.
- Replacing GitHub PR integration. Ticketing adapters own issues/tickets; code-host adapters own branches, PRs, reviews, checks, and mergeability.

## Core Domain Model

Add a provider-neutral ticketing package, likely `packages/ticketing`.

```ts
export type TicketProvider = "linear" | "jira" | "github";

export interface TicketRef {
  provider: TicketProvider;
  id: string;
  key: string;
  url?: string;
}

export interface TicketStatusRef {
  id: string;
  name: string;
  category?: "todo" | "in_progress" | "review" | "done" | "blocked" | "cancelled";
}

export interface TicketProjectRef {
  id: string;
  key?: string;
  name: string;
}

export interface TicketLabelRef {
  id?: string;
  name: string;
}

export interface TicketComment {
  id: string;
  body: string;
  author?: string;
  createdAt?: string;
}

export interface Ticket {
  ref: TicketRef;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: TicketStatusRef;
  priority?: number;
  createdAt?: string;
  updatedAt?: string;
  assignee?: string;
  reporter?: string;
  project?: TicketProjectRef;
  labels: TicketLabelRef[];
  comments: TicketComment[];
  links: TicketLink[];
  raw?: unknown;
}

export interface TicketLink {
  type: "pull_request" | "branch" | "duplicate" | "blocks" | "blocked_by" | "external";
  url: string;
  title?: string;
}
```

Important sorting semantics:

- Higher explicit priority wins.
- Missing priority sorts below any explicit priority.
- Within equal priority, older `createdAt` wins.
- Missing `createdAt` sorts newer than any explicit timestamp.
- Final tie-breaker is stable lexical `provider:key`.

## Adapter Contract

```ts
export interface TicketingAdapter {
  provider: TicketProvider;

  listReadyTickets(input: ListReadyTicketsInput): Promise<Ticket[]>;
  getTicket(ref: TicketRef | string): Promise<Ticket>;
  claimTicket(input: ClaimTicketInput): Promise<Ticket>;
  transitionTicket(input: TransitionTicketInput): Promise<Ticket>;
  addComment(input: AddTicketCommentInput): Promise<TicketComment>;
  listProjects(input?: ListTicketProjectsInput): Promise<TicketProjectRef[]>;
  listStatuses(input?: ListTicketStatusesInput): Promise<TicketStatusRef[]>;
}
```

Claiming should be idempotent:

- Always update status when claim policy says to claim.
- Do not duplicate the standard claim comment.
- Return the fresh ticket after mutation when the provider makes that practical.

## Provider Mapping

### Linear

Initial fields:

- `Ticket.ref.key` from `issue.identifier`.
- `Ticket.ref.id` from `issue.id`.
- `Ticket.status.name` from `issue.state.name`.
- `Ticket.project` from `issue.project`, when present.
- `Ticket.priority` from Linear priority value.
- `Ticket.createdAt` from `issue.createdAt`.
- `Ticket.comments` from issue comments.

Needed GraphQL additions:

- Ready issue query should include `createdAt`, labels, project, URL, and priority.
- Query ordering can be requested from Linear if available, but Aigile should still sort locally.
- Project/status preflight should remain read-only.

### Jira

Initial fields:

- `Ticket.ref.key` from issue key, for example `ENG-123`.
- `Ticket.ref.id` from Jira issue id.
- `Ticket.status.name` from `fields.status.name`.
- `Ticket.project` from `fields.project`.
- `Ticket.priority` from `fields.priority` mapped through configuration.
- `Ticket.createdAt` from `fields.created`.
- `Ticket.description` converted from Atlassian Document Format to plain Markdown-like text.

Provider-specific complexities:

- Jira status transitions require transition ids, not status names.
- Comment body may use ADF depending API version.
- Priority ordering needs a configurable mapping because Jira priority names are workspace-specific.

### GitHub Issues

Initial fields:

- `Ticket.ref.key` can be `owner/repo#number`.
- `Ticket.ref.id` from GraphQL node id.
- `Ticket.status` derived from issue state, labels, milestone, or project field.
- `Ticket.project` from GitHub Project v2 when configured.
- `Ticket.priority` from labels or project field.
- `Ticket.createdAt` from issue creation time.

Provider-specific complexities:

- GitHub Issues has no universal workflow state. MVP should use labels or Projects v2.
- GitHub Issues and GitHub PRs are adjacent but separate adapter responsibilities.
- Closing issues should be explicit and should not imply PR merge.

## Repository/Product Routing

Ticketing adapters should not know local repository paths. Routing belongs in Aigile config.

Example:

```json
{
  "ticketing": {
    "provider": "linear",
    "team": "LBE",
    "readyStatus": "Todo",
    "claimStatus": "In Progress",
    "doneStatus": "Done",
    "routes": [
      {
        "project": "Aigile",
        "repoPath": "/Users/lbelyaev/dev/aigile",
        "worktreesPath": "/Users/lbelyaev/dev/aigile/.worktrees",
        "githubRepo": "lbelyaev/aigile",
        "runtimeConfig": "config/aigile.runtimes.example.json"
      }
    ]
  }
}
```

Route resolution order:

1. Explicit repo/product field in ticket body.
2. Configured project mapping.
3. Configured label mapping.
4. Single default route.
5. Otherwise mark ticket blocked/needs routing.

## Workflow Integration

Ticketing should map Aigile terminal and intermediate states to source-of-record updates:

- Claim: transition to configured in-progress status and post a claim comment.
- Architect plan: post plan summary before developer starts.
- Satisfied/no-op: transition to done and post verification evidence.
- Published PR: post PR URL and verification evidence; transition depending policy.
- Checker changes requested: transition to todo/retry status and post checker reasons.
- Checker escalated: transition to blocked/escalated status and post reasons.
- PR conflict: do not mark done; transition to retry/blocked and post PR conflict evidence.

Dry-run must not mutate the ticketing provider.

## Proposed Package Layout

```text
packages/ticketing/
  src/
    index.ts
    contracts.ts
    sorting.ts
    comments.ts
    linear-adapter.ts
    jira-adapter.ts
    github-issues-adapter.ts
    routing.ts
```

Existing `packages/adapters` can either:

- Continue owning provider implementations and re-export ticketing-compatible adapters, or
- Be split so ticketing-specific provider code moves into `packages/ticketing`.

The cleaner direction is to introduce `packages/ticketing` and migrate Linear issue code into it gradually.

## Implementation Slices

### Slice 1: Unified Ticket Types And Sorting

- Add `packages/ticketing`.
- Define `Ticket`, `TicketingAdapter`, and input contracts.
- Add deterministic `sortReadyTickets`.
- Cover priority, createdAt, and missing-value behavior with tests.

### Slice 2: Linear Adapter Migration

- Wrap current Linear GraphQL issue functions behind `TicketingAdapter`.
- Include `createdAt`, project, labels, URL, and comments.
- Preserve existing watch behavior.
- Replace current watch source/tracker usage with ticketing adapter calls.

### Slice 3: Ticketing Watch Selection Summary

- Before claim, print ready count and selected issue.
- Print skipped issues with reason.
- Claim the highest-priority oldest eligible issue.
- Keep single-worker execution.

### Slice 4: Source-Of-Record Sync

- Centralize comments/status updates for plan, no-op satisfied, published PR, changes requested, escalation, and conflicts.
- Ensure dry-run has zero ticketing mutations.
- Add tests for each terminal route.

### Slice 5: Jira Adapter

- Add Jira REST adapter for issue fetch, ready search, transitions, comments, project/status preflight.
- Add configurable Jira priority mapping.
- Add ADF description/comment conversion.

### Slice 6: GitHub Issues Adapter

- Add GitHub Issues adapter for issue fetch, ready search, labels/project status, comments.
- Support label-based status as MVP.
- Keep PR operations in the code-host adapter.

## Open Decisions

- Should done/retry/blocked status names live in global config or route config?
- Should claim be implemented with optimistic concurrency where providers support it?
- Should ticket comments be idempotent by stable marker comments rather than exact text?
- Should architecture plan publication require human approval before developer starts?
- Should GitHub Issues support be labels-only first, or require Projects v2?

## Hand-Test Target

The first complete hand-test after the Linear migration should be:

```text
Linear Project: Aigile
Status: Todo
Priority: explicit
CreatedAt: older than another ready ticket
Expected: Aigile selects this ticket, claims it, posts architect plan, runs agent-write, publishes PR, posts PR evidence, and updates final status according to PR/checker result.
```
