import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { config } from "../config.js";
import type { Executor } from "../db/client.js";
import { claimEvents, tickets, type ClaimEvent, type Ticket } from "../db/schema.js";

/**
 * The moment before which a claim is considered lapsed.
 *
 * Always evaluated by Postgres, never by Node. Several app instances would
 * otherwise disagree about when a claim expired, and two servers disagreeing
 * about expiry is a double-claim.
 */
const staleBefore = sql`now() - make_interval(mins => ${config.CLAIM_TTL_MINUTES}::int)`;

/** A ticket is in the pool if nobody holds it, or the holder went quiet. */
const isAvailable = or(isNull(tickets.claimedByAgentId), lt(tickets.lastActivityAt, staleBefore))!;

export interface ClaimOutcome {
  ticket: Ticket;
  /** Who held it immediately before this claim. Null if it was in the pool. */
  previousAgentId: number | null;
}

/**
 * Compare-and-swap: the availability check and the claim are the same
 * statement, so there is no window between "is it free?" and "take it".
 *
 * Postgres locks the row for the duration of the UPDATE. A concurrent claimer
 * blocks, then re-evaluates this WHERE clause against the row we just wrote,
 * matches nothing, and receives zero rows. Zero rows is the loss signal.
 *
 * The `previous` CTE captures the outgoing owner so the caller can suppress a
 * duplicate customer notification when an agent simply re-takes their own
 * lapsed claim.
 *
 * `claimed_by_agent_id = agent` makes the operation idempotent: a double click,
 * or a request retried by a proxy, returns success rather than a conflict.
 */
export async function claimTicket(
  exec: Executor,
  ticketId: number,
  agentId: number,
): Promise<ClaimOutcome | null> {
  const result = await exec.execute(sql`
    WITH previous AS (
      SELECT id, claimed_by_agent_id
      FROM ${tickets}
      WHERE id = ${ticketId}
    )
    UPDATE ${tickets} AS t
       SET claimed_by_agent_id = ${agentId},
           claimed_at          = now(),
           last_activity_at    = now(),
           updated_at          = now()
      FROM previous AS p
     WHERE t.id = p.id
       AND (
            t.claimed_by_agent_id IS NULL
         OR t.claimed_by_agent_id = ${agentId}
         OR t.last_activity_at < ${staleBefore}
       )
    RETURNING t.*, p.claimed_by_agent_id AS previous_agent_id
  `);

  const row = rowsOf(result)[0];
  if (!row) return null;

  return {
    ticket: toTicket(row),
    previousAgentId: row.previous_agent_id === null ? null : Number(row.previous_agent_id),
  };
}

/**
 * Extends a live claim.
 *
 * Both conditions matter. `claimed_by_agent_id` stops an agent from touching
 * someone else's ticket; the freshness check stops a lapsed holder from
 * reviving a claim that has already returned to the pool. Together they are the
 * fence: a stale holder cannot write, because the row no longer matches.
 */
export async function touchTicket(
  exec: Executor,
  ticketId: number,
  agentId: number,
): Promise<Ticket | null> {
  const [row] = await exec
    .update(tickets)
    .set({ lastActivityAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(tickets.id, ticketId),
        eq(tickets.claimedByAgentId, agentId),
        sql`${tickets.lastActivityAt} > ${staleBefore}`,
      ),
    )
    .returning();

  return row ?? null;
}

/**
 * The pool: unclaimed tickets plus those whose claim has lapsed.
 *
 * Expiry is applied here rather than depending on the sweeper having run, so a
 * lapsed ticket becomes visible the millisecond it lapses. Fetches one extra
 * row to report `hasMore` without a second COUNT query.
 */
export async function listAvailableTickets(
  exec: Executor,
  limit: number,
  offset: number,
): Promise<{ items: Ticket[]; hasMore: boolean }> {
  const rows = await exec
    .select()
    .from(tickets)
    .where(isAvailable)
    .orderBy(asc(tickets.createdAt), asc(tickets.id))
    .limit(limit + 1)
    .offset(offset);

  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

/** Live claims held by one agent. Lapsed claims are excluded — they are gone. */
export async function listTicketsHeldBy(exec: Executor, agentId: number): Promise<Ticket[]> {
  return exec
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.claimedByAgentId, agentId),
        sql`${tickets.lastActivityAt} > ${staleBefore}`,
      ),
    )
    .orderBy(asc(tickets.claimedAt));
}

export async function findTicketById(exec: Executor, ticketId: number): Promise<Ticket | null> {
  const [row] = await exec.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  return row ?? null;
}

export async function listClaimEvents(
  exec: Executor,
  ticketId: number,
  limit: number,
): Promise<ClaimEvent[]> {
  return exec
    .select()
    .from(claimEvents)
    .where(eq(claimEvents.ticketId, ticketId))
    .orderBy(sql`${claimEvents.createdAt} DESC`)
    .limit(limit);
}

export async function recordClaimEvents(
  exec: Executor,
  rows: Array<{ ticketId: number; agentId: number; type: "claimed" | "expired" }>,
): Promise<void> {
  if (rows.length === 0) return;
  await exec.insert(claimEvents).values(rows);
}

/**
 * Reconciler, not the mechanism.
 *
 * Every read and write already treats a lapsed claim as available, so this
 * changes no behaviour — it clears the stale columns so the table stays honest
 * to anything that does not apply the expiry rule, and emits the `expired`
 * events that make lapse rate measurable. It may lag, or not run at all,
 * without affecting correctness.
 *
 * SKIP LOCKED keeps it out of the way of live claims and lets two instances run
 * without contending. The batch is bounded so one pass can never hold a long
 * transaction open over an unbounded number of rows; the next run picks up the
 * remainder a minute later, and nothing depends on it finishing promptly.
 */
export const SWEEP_BATCH_SIZE = 500;

export async function releaseExpiredClaims(
  exec: Executor,
): Promise<Array<{ ticketId: number; agentId: number }>> {
  const result = await exec.execute(sql`
    WITH expired AS (
      SELECT id, claimed_by_agent_id
        FROM ${tickets}
       WHERE claimed_by_agent_id IS NOT NULL
         AND last_activity_at < ${staleBefore}
       ORDER BY last_activity_at
       LIMIT ${SWEEP_BATCH_SIZE}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE ${tickets} AS t
       SET claimed_by_agent_id = NULL,
           claimed_at          = NULL,
           last_activity_at    = NULL,
           updated_at          = now()
      FROM expired AS e
     WHERE t.id = e.id
    RETURNING t.id, e.claimed_by_agent_id AS agent_id
  `);

  return rowsOf(result).map((row) => ({
    ticketId: Number(row.id),
    agentId: Number(row.agent_id),
  }));
}

/* -------------------------------------------------------------------------- */
/* Raw-result helpers                                                          */
/* -------------------------------------------------------------------------- */

type RawRow = Record<string, unknown>;

/** node-postgres returns `{ rows }`; some drivers return the array directly. */
function rowsOf(result: unknown): RawRow[] {
  if (Array.isArray(result)) return result as RawRow[];
  return ((result as { rows?: RawRow[] }).rows ?? []) as RawRow[];
}

/**
 * Maps a snake_case row from a raw statement onto the Drizzle row type.
 *
 * Raw statements bypass Drizzle's column decoders, so timestamps arrive as
 * strings and bigints as strings. Converting here keeps every caller working
 * with the same `Ticket` shape whether the row came from the query builder or
 * from raw SQL.
 */
function toTicket(row: RawRow): Ticket {
  return {
    id: Number(row.id),
    title: String(row.title),
    customerEmail: String(row.customer_email),
    claimedByAgentId: row.claimed_by_agent_id === null ? null : Number(row.claimed_by_agent_id),
    claimedAt: toDate(row.claimed_at),
    lastActivityAt: toDate(row.last_activity_at),
    createdAt: toDate(row.created_at)!,
    updatedAt: toDate(row.updated_at)!,
  };
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(String(value));
}
