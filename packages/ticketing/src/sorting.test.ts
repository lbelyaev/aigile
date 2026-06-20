import { describe, expect, it } from "bun:test";
import { sortReadyTickets, type Ticket } from "./index.js";

const ticket = (
  key: string,
  overrides: Partial<Omit<Ticket, "ref">> & { provider?: Ticket["ref"]["provider"] } = {},
): Ticket => {
  const { provider = "linear", ...ticketOverrides } = overrides;

  return {
    ref: {
      provider,
      id: key.toLowerCase(),
      key,
    },
    title: key,
    description: "",
    acceptanceCriteria: [],
    status: {
      id: "ready",
      name: "Ready",
      category: "todo",
    },
    labels: [],
    comments: [],
    links: [],
    ...ticketOverrides,
  };
};

const keys = (tickets: Ticket[]): string[] => tickets.map((candidate) => candidate.ref.key);

describe("sortReadyTickets", () => {
  it("sorts higher explicit priority first", () => {
    const tickets = [
      ticket("LOW", { priority: 1 }),
      ticket("HIGH", { priority: 5 }),
      ticket("MIDDLE", { priority: 3 }),
    ];

    expect(keys(sortReadyTickets(tickets))).toEqual(["HIGH", "MIDDLE", "LOW"]);
  });

  it("sorts missing priority after any explicit priority", () => {
    const tickets = [
      ticket("MISSING", { createdAt: "2024-01-01T00:00:00.000Z" }),
      ticket("ZERO", { priority: 0, createdAt: "2024-02-01T00:00:00.000Z" }),
      ticket("NEGATIVE", { priority: -1, createdAt: "2024-03-01T00:00:00.000Z" }),
    ];

    expect(keys(sortReadyTickets(tickets))).toEqual(["ZERO", "NEGATIVE", "MISSING"]);
  });

  it("sorts older createdAt first within equal priority", () => {
    const tickets = [
      ticket("NEWER", { priority: 2, createdAt: "2024-02-01T00:00:00.000Z" }),
      ticket("OLDER", { priority: 2, createdAt: "2024-01-01T00:00:00.000Z" }),
    ];

    expect(keys(sortReadyTickets(tickets))).toEqual(["OLDER", "NEWER"]);
  });

  it("sorts missing createdAt after explicit timestamps", () => {
    const tickets = [
      ticket("MISSING", { priority: 2 }),
      ticket("DATED", { priority: 2, createdAt: "2024-03-01T00:00:00.000Z" }),
    ];

    expect(keys(sortReadyTickets(tickets))).toEqual(["DATED", "MISSING"]);
  });

  it("uses provider:key as the final deterministic tie-breaker", () => {
    const tickets = [
      ticket("TCK-2", { provider: "jira", priority: 1 }),
      ticket("2", { provider: "github", priority: 1 }),
      ticket("TCK-1", { provider: "jira", priority: 1 }),
    ];

    expect(sortReadyTickets(tickets).map((candidate) => candidate.ref)).toMatchObject([
      { provider: "github", key: "2" },
      { provider: "jira", key: "TCK-1" },
      { provider: "jira", key: "TCK-2" },
    ]);
  });

  it("returns a new sorted array without mutating the input", () => {
    const tickets = [ticket("LOW", { priority: 1 }), ticket("HIGH", { priority: 2 })];

    const sorted = sortReadyTickets(tickets);

    expect(sorted).not.toBe(tickets);
    expect(keys(sorted)).toEqual(["HIGH", "LOW"]);
    expect(keys(tickets)).toEqual(["LOW", "HIGH"]);
  });
});
