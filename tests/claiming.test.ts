import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { claimEvents } from "../src/db/schema.js";
import { sweepExpiredClaims } from "../src/jobs/sweeper.js";
import { boss, startQueue } from "../src/queue/index.js";
import * as tickets from "../src/tickets/service.js";
import { codeOf, insertTicket, resetTickets, statusOf } from "./helpers.js";

// pg-boss runs for real rather than being stubbed: the claim enqueues its
// notification through the same transaction, and that guarantee is worth
// exercising rather than mocking away.
beforeAll(async () => {
  await startQueue();
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await pool.end();
});

beforeEach(resetTickets);

describe("one owner at a time", () => {
  it("gives a ticket to exactly one of 40 simultaneous claimers", async () => {
    const ticket = await insertTicket();

    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) => tickets.claim(ticket.id, i + 1)),
    );

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(39);

    for (const failure of lost) {
      const error = (failure as PromiseRejectedResult).reason;
      expect(statusOf(error)).toBe(409);
      expect(codeOf(error)).toBe("TICKET_ALREADY_CLAIMED");
    }

    // Exactly one claim happened, so exactly one customer notification exists.
    const events = await db.select().from(claimEvents).where(eq(claimEvents.ticketId, ticket.id));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("claimed");
  });

  it("rejects a claim on a ticket another agent already holds", async () => {
    const ticket = await insertTicket({ agentId: 1, minutesAgo: 2 });

    await expect(tickets.claim(ticket.id, 2)).rejects.toMatchObject({
      status: 409,
      code: "TICKET_ALREADY_CLAIMED",
    });
  });

  it("distinguishes a missing ticket from a claimed one", async () => {
    await expect(tickets.claim(999_999, 1)).rejects.toMatchObject({
      status: 404,
      code: "TICKET_NOT_FOUND",
    });
  });

  it("is idempotent for the agent who already holds the ticket", async () => {
    const ticket = await insertTicket();

    await tickets.claim(ticket.id, 7);
    const second = await tickets.claim(ticket.id, 7);

    expect(second.claimedByAgentId).toBe(7);

    // Re-taking your own claim must not tell the customer a second time.
    const events = await db.select().from(claimEvents).where(eq(claimEvents.ticketId, ticket.id));
    expect(events).toHaveLength(1);
  });
});

describe("claims expire after inactivity", () => {
  it("lists a lapsed claim as available without any sweep having run", async () => {
    const stale = await insertTicket({ agentId: 1, minutesAgo: 20 });
    const live = await insertTicket({ agentId: 2, minutesAgo: 2 });

    const { items } = await tickets.pool(50, 0);
    const ids = items.map((t) => t.id);

    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(live.id);
  });

  it("lets another agent take over a lapsed claim", async () => {
    const ticket = await insertTicket({ agentId: 1, minutesAgo: 20 });

    const claimed = await tickets.claim(ticket.id, 2);

    expect(claimed.claimedByAgentId).toBe(2);
    expect(claimed.expiresAt).not.toBeNull();
  });

  it("refuses activity from an agent whose claim has lapsed", async () => {
    const ticket = await insertTicket({ agentId: 1, minutesAgo: 20 });

    await expect(tickets.heartbeat(ticket.id, 1)).rejects.toMatchObject({
      status: 409,
      code: "CLAIM_NOT_HELD",
    });
  });

  it("refuses activity from an agent who never held the ticket", async () => {
    const ticket = await insertTicket({ agentId: 1, minutesAgo: 2 });

    await expect(tickets.heartbeat(ticket.id, 2)).rejects.toMatchObject({
      status: 409,
      code: "CLAIM_NOT_HELD",
    });
  });

  it("extends the claim when the agent is active", async () => {
    const ticket = await insertTicket({ agentId: 1, minutesAgo: 14 });

    const before = await tickets.pool(50, 0);
    expect(before.items.map((t) => t.id)).not.toContain(ticket.id);

    const refreshed = await tickets.heartbeat(ticket.id, 1);
    const expiresAt = new Date(refreshed.expiresAt!).getTime();

    // A fresh heartbeat pushes the deadline out to roughly a full TTL away.
    expect(expiresAt - Date.now()).toBeGreaterThan(14 * 60_000);
  });
});

describe("sweeper", () => {
  it("clears lapsed claims and records why", async () => {
    const stale = await insertTicket({ agentId: 3, minutesAgo: 30 });
    const live = await insertTicket({ agentId: 4, minutesAgo: 1 });

    const released = await sweepExpiredClaims();
    expect(released).toBe(1);

    const [after] = await db.select().from(claimEvents).where(eq(claimEvents.ticketId, stale.id));
    expect(after!.type).toBe("expired");
    expect(after!.agentId).toBe(3);

    const untouched = await db.select().from(claimEvents).where(eq(claimEvents.ticketId, live.id));
    expect(untouched).toHaveLength(0);
  });

  it("changes nothing a query would not already have concluded", async () => {
    await insertTicket({ agentId: 5, minutesAgo: 30 });

    const beforeSweep = await tickets.pool(50, 0);
    await sweepExpiredClaims();
    const afterSweep = await tickets.pool(50, 0);

    expect(afterSweep.items.map((t) => t.id)).toEqual(beforeSweep.items.map((t) => t.id));
  });
});
