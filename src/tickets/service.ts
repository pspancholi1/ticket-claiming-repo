import { sql } from "drizzle-orm";
import { fromDrizzle } from "pg-boss";
import { config } from "../config.js";
import { db } from "../db/client.js";
import type { ClaimEvent, Ticket } from "../db/schema.js";
import { alreadyClaimed, claimNotHeld, notFound } from "../http/errors.js";
import { logger } from "../logger.js";
import type { NotifyCustomerJob } from "../notifications/worker.js";
import { boss, QUEUE } from "../queue/index.js";
import {
  claimTicket,
  findTicketById,
  listAvailableTickets,
  listClaimEvents,
  listTicketsHeldBy,
  recordClaimEvents,
  touchTicket,
} from "./queries.js";

const TTL_MS = config.CLAIM_TTL_MINUTES * 60_000;

export interface TicketView {
  id: number;
  title: string;
  customerEmail: string;
  claimedByAgentId: number | null;
  claimedAt: string | null;
  lastActivityAt: string | null;
  /** When this claim lapses if the agent stays silent. Null when unclaimed. */
  expiresAt: string | null;
  createdAt: string;
}

/**
 * Claims a ticket for an agent.
 *
 * Ownership and the customer notification commit together. The claim is a
 * single compare-and-swap, and the queue job is enqueued through the same
 * transaction, so there is no window in which a ticket is claimed but nothing
 * remembers to tell the customer — nor one in which a customer is told about a
 * claim that rolled back.
 *
 * The external call itself deliberately happens later, in a worker.
 */
export async function claim(ticketId: number, agentId: number): Promise<TicketView> {
  const outcome = await db.transaction(async (tx) => {
    const result = await claimTicket(tx, ticketId, agentId);
    if (!result) return null;

    const { ticket, previousAgentId } = result;

    // An agent re-taking their own claim is a no-op for the customer, who was
    // already told. Only a change of owner is worth a message.
    const ownerChanged = previousAgentId !== agentId;

    if (ownerChanged) {
      await recordClaimEvents(tx, [{ ticketId: ticket.id, agentId, type: "claimed" }]);

      const job: NotifyCustomerJob = {
        ticketId: ticket.id,
        customerEmail: ticket.customerEmail,
        agentId,
      };
      await boss.send(QUEUE.notifyCustomer, job, { db: fromDrizzle(tx, sql) });
    }

    return { ticket, ownerChanged };
  });

  if (!outcome) {
    // Zero rows means "not available to you", which covers both a missing
    // ticket and one somebody else holds. One extra read — only on the failure
    // path — separates the two so the agent gets a useful answer.
    const existing = await findTicketById(db, ticketId);
    if (!existing) throw notFound(`ticket ${ticketId} does not exist`);
    throw alreadyClaimed(`ticket ${ticketId} is currently claimed by another agent`);
  }

  logger.info(
    { ticketId, agentId, notified: outcome.ownerChanged },
    outcome.ownerChanged ? "ticket claimed" : "claim refreshed by current owner",
  );

  return toView(outcome.ticket);
}

/**
 * Records agent activity, extending the claim.
 *
 * Stands in for the real actions — replying, adding a note, opening the ticket
 * — which are out of scope here. In production this same update would run as a
 * side effect of those endpoints and there would be no dedicated route: a
 * client-side keepalive would only prove the tab is open, which is precisely
 * what the expiry rule exists to see through.
 */
export async function heartbeat(ticketId: number, agentId: number): Promise<TicketView> {
  const ticket = await touchTicket(db, ticketId, agentId);

  if (!ticket) {
    const existing = await findTicketById(db, ticketId);
    if (!existing) throw notFound(`ticket ${ticketId} does not exist`);
    throw claimNotHeld(
      `you no longer hold ticket ${ticketId}; the claim lapsed or belongs to another agent`,
    );
  }

  return toView(ticket);
}

export async function pool(
  limit: number,
  offset: number,
): Promise<{ items: TicketView[]; limit: number; offset: number; hasMore: boolean }> {
  const { items, hasMore } = await listAvailableTickets(db, limit, offset);
  return { items: items.map(toView), limit, offset, hasMore };
}

export async function heldBy(agentId: number): Promise<TicketView[]> {
  const rows = await listTicketsHeldBy(db, agentId);
  return rows.map(toView);
}

export async function history(ticketId: number, limit: number): Promise<ClaimEvent[]> {
  const existing = await findTicketById(db, ticketId);
  if (!existing) throw notFound(`ticket ${ticketId} does not exist`);
  return listClaimEvents(db, ticketId, limit);
}

/**
 * Serialises a row for the API.
 *
 * `expiresAt` is derived rather than stored, and returned on every response so
 * a client can warn an agent before their claim lapses instead of discovering
 * it through a rejected write.
 */
function toView(ticket: Ticket): TicketView {
  const expiresAt = ticket.lastActivityAt
    ? new Date(ticket.lastActivityAt.getTime() + TTL_MS)
    : null;

  return {
    id: ticket.id,
    title: ticket.title,
    customerEmail: ticket.customerEmail,
    claimedByAgentId: ticket.claimedByAgentId,
    claimedAt: ticket.claimedAt?.toISOString() ?? null,
    lastActivityAt: ticket.lastActivityAt?.toISOString() ?? null,
    expiresAt: expiresAt?.toISOString() ?? null,
    createdAt: ticket.createdAt.toISOString(),
  };
}
