import type { Ticket } from "./contracts.js";

const explicitPriority = (ticket: Ticket): number | undefined =>
  Number.isFinite(ticket.priority) ? ticket.priority : undefined;

const createdAtTime = (ticket: Ticket): number | undefined => {
  if (typeof ticket.createdAt !== "string" || ticket.createdAt.length === 0) return undefined;

  const parsed = Date.parse(ticket.createdAt);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const compareOptionalNumbers = (
  left: number | undefined,
  right: number | undefined,
  direction: "ascending" | "descending",
): number => {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;

  return direction === "ascending" ? left - right : right - left;
};

const ticketSortKey = (ticket: Ticket): string => `${ticket.ref.provider}:${ticket.ref.key}`;

const compareReadyTickets = (left: Ticket, right: Ticket): number => {
  const priorityComparison = compareOptionalNumbers(
    explicitPriority(left),
    explicitPriority(right),
    "descending",
  );
  if (priorityComparison !== 0) return priorityComparison;

  const createdAtComparison = compareOptionalNumbers(
    createdAtTime(left),
    createdAtTime(right),
    "ascending",
  );
  if (createdAtComparison !== 0) return createdAtComparison;

  return ticketSortKey(left).localeCompare(ticketSortKey(right));
};

export const sortReadyTickets = (tickets: Ticket[]): Ticket[] =>
  [...tickets].sort(compareReadyTickets);
