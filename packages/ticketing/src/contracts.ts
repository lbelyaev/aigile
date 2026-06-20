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

export interface TicketLink {
  type: "pull_request" | "branch" | "duplicate" | "blocks" | "blocked_by" | "external";
  url: string;
  title?: string;
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

export interface ListReadyTicketsInput {
  projectKey?: string;
  statusNames?: string[];
  labelNames?: string[];
  limit?: number;
}

export interface ClaimTicketInput {
  ref: TicketRef | string;
  assignee?: string;
  status?: TicketStatusRef | string;
  comment?: string;
}

export interface TransitionTicketInput {
  ref: TicketRef | string;
  status: TicketStatusRef | string;
}

export interface AddTicketCommentInput {
  ref: TicketRef | string;
  body: string;
}

export interface ListTicketProjectsInput {
  query?: string;
}

export interface ListTicketStatusesInput {
  project?: TicketProjectRef | string;
}

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
