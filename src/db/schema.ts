import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * A claim's lifecycle transitions. `heartbeat` is deliberately not an event —
 * it would produce one row per activity and drown the useful signal.
 */
export const claimEventType = pgEnum("claim_event_type", ["claimed", "expired"]);

/**
 * Ownership lives on the ticket row itself: one owner is one column, so the
 * guarantee is a single atomic UPDATE with no join and no second write.
 *
 * Availability is derived, never stored. A `status` column would go stale the
 * instant a claim lapsed, and the pool would advertise tickets nobody can take.
 */
export const tickets = pgTable(
  "tickets",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    title: varchar("title", { length: 255 }).notNull(),
    customerEmail: varchar("customer_email", { length: 255 }).notNull(),

    /** Opaque agent id. No FK: user management is out of scope. */
    claimedByAgentId: integer("claimed_by_agent_id"),
    /** When the current claim began. Never moves while the claim is held. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** Bumped by real agent activity. This is what expiry reads. */
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Pool, half one: never claimed. Ordered by age so the oldest surfaces first.
    index("ix_tickets_unclaimed")
      .on(t.createdAt)
      .where(sql`${t.claimedByAgentId} IS NULL`),

    // Pool, half two, and the sweeper: claimed, possibly stale.
    // The predicate is immutable on purpose — one containing now() would be
    // rejected by Postgres, which is why expiry is evaluated per query instead.
    index("ix_tickets_claimed_activity")
      .on(t.lastActivityAt)
      .where(sql`${t.claimedByAgentId} IS NOT NULL`),

    // "What am I holding right now?"
    index("ix_tickets_by_agent")
      .on(t.claimedByAgentId)
      .where(sql`${t.claimedByAgentId} IS NOT NULL`),

    // A half-claimed row cannot exist, even if application code is wrong.
    check(
      "claim_fields_consistent",
      sql`(${t.claimedByAgentId} IS NULL AND ${t.claimedAt} IS NULL AND ${t.lastActivityAt} IS NULL)
       OR (${t.claimedByAgentId} IS NOT NULL AND ${t.claimedAt} IS NOT NULL AND ${t.lastActivityAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * Append-only history. `tickets` only remembers the present — every claim
 * overwrites the last one — so without this there is no way to answer
 * "how often do claims actually expire?", which is the metric that tells you
 * whether the 15 minute TTL is the right number.
 */
export const claimEvents = pgTable(
  "claim_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ticketId: bigint("ticket_id", { mode: "number" })
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    agentId: integer("agent_id").notNull(),
    type: claimEventType("type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("ix_claim_events_ticket").on(t.ticketId, t.createdAt.desc()),
    index("ix_claim_events_type_created").on(t.type, t.createdAt.desc()),
  ],
);

export type Ticket = typeof tickets.$inferSelect;
export type ClaimEvent = typeof claimEvents.$inferSelect;
