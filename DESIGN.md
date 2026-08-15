# Design

~40 agents pulling from a shared pool: one owner at a time, claims lapse after
15 minutes of inactivity, and claiming messages the customer through a slow,
unreliable service.

## Data model

One business table. `tickets` carries `claimed_by_agent_id`, `claimed_at` and
`last_activity_at` — all three NULL together or set together, enforced by a
CHECK constraint, so a half-claimed row cannot exist even if application code is
wrong. The two timestamps are separate because the rule is inactivity-based, not
age-based: an agent working a ticket for forty minutes must keep it.

**Availability is derived, never stored:** a ticket is in the pool when
`claimed_by_agent_id IS NULL OR last_activity_at < now() - 15 min`. A stored
`status` column would be wrong for as long as it took a background job to notice
a lapse, and the pool has to match reality.

`claim_events` is append-only history: `tickets` only remembers the present, so
without it there is no answering *how often do claims actually expire* — the
number that says whether 15 minutes is right. Rejected: a separate claims table
(below); event sourcing, more machinery than 40 agents justify; a `customers`
table, when all we do with a customer is send one message.

## Three approaches to one owner

**1. Conditional UPDATE (compare-and-swap).** The availability check sits in the
`WHERE` clause, so checking and claiming are one statement. Postgres locks the
row for that statement; a concurrent claimer blocks, re-evaluates the predicate
against the row just written, and gets zero rows. *Cost:* the rule lives in SQL
rather than readable TypeScript, and zero rows does not say **why** it failed.

**2. `SELECT … FOR UPDATE` in a transaction.** Lock the row, decide in
application code, write, commit. Branching is plain TypeScript, failure reasons
come for free, and `NOWAIT` lets losers fail fast rather than wait. Paired with
the same outbox, it is a perfectly correct design. *Cost:* the lock is taken at
the `SELECT` and held across a round trip back to the application, so it lasts
strictly longer; the expiry re-check after a lock wait becomes the developer's
responsibility rather than the database's; and an open transaction is an
invitation — a slow call added inside it later compiles fine and drains the
connection pool.

**3. Separate `ticket_claims` table**, partial unique index on `(ticket_id)
WHERE released_at IS NULL`. Claiming is an INSERT; the second violates the
constraint. Strongest guarantee — the schema forbids two owners, not merely the
query — plus history for free. *Cost:* a lapsed claim still occupies the unique
slot, so it must be released before a new insert succeeds: two writes that must
be atomic, i.e. approach 1 reimplemented inside approach 3. Pool reads become
joins.

In short: **1 lets the database hold the lock, 2 makes the application hold it,
3 replaces the lock with a constraint.**

## Chosen: conditional UPDATE

Approach 2 would also work here — paired with the same outbox it is correct — so
this is a margin, not a knockout. Three things decide it.

**The check and the write are one statement,** leaving no gap to reason about
and no round trip taken while holding the lock. **Postgres performs the re-check
itself,** re-running the `WHERE` against the freshly written row after a lock
wait, where approach 2 makes re-evaluating expiry a developer's responsibility.
And **there is no "inside".** The decision is three columns on one row, so an
open transaction would exist only as somewhere for a later edit to put something
slow. Approach 1 is correct by construction; approach 2 is correct by
discipline, and nothing here is bought with the extra flexibility.

The claim still runs in a short transaction so the queue job commits with it, so
the lock spans three fast local writes rather than one — about a millisecond,
with no network call anywhere inside it. Contention is a burst of clicks on one
popular ticket: forty updates to one row, 39 of which do no write work at all
before returning zero rows.

Expiry and claiming also become one atomic act, so **correctness never depends
on a background job having run.** The sweeper is a reconciler — it clears stale
columns and emits `expired` events — and a test asserts the pool is identical
before and after it runs.

The same predicate guards every write — `heartbeat` requires
`claimed_by_agent_id = :agent AND last_activity_at > now() - 15 min` — so an
agent whose claim lapsed while they were reading cannot overwrite whoever took
it over. That re-check is the fence, which is why no version token is needed.

## The notification service

Claiming and notifying are two writes to two systems, and no ordering is safe:
send first, and a rolled-back claim has already messaged the customer; commit
first, and a crash loses the message with nothing remembering it was owed.

So the request never calls the provider. The claim and a queue job are written
in **one transaction** (pg-boss, same Postgres, enqueued through the same
transaction handle) — one write to one database, so either both happened or
neither, and the agent gets an answer in milliseconds.

A worker delivers it afterwards, deliberately outside any transaction: holding a
connection across a 20-second call would drain the pool. One attempt plus three
retries with exponential backoff, a 25s job timeout, then a dead letter queue —
measured, a fully failing delivery gives up after ~54 seconds. Bounding that
well under the TTL is what makes a fencing token unnecessary: a retry can never
outlive its claim.

**What still goes wrong.** About 1 claim in 600 exhausts every attempt: the
customer is never told, while the agent keeps the ticket. That is the right
thing to accept. Releasing the ticket would punish an agent who did nothing
wrong for a vendor's flakiness, and blocking the claim would make an unreliable
third party a dependency of core work. Ownership must be correct; the message is
a courtesy — and it fails loudly, sitting in the dead letter queue, logged at
error, ready to replay. Delivery is also at-least-once, so a crash after a
successful send produces a duplicate; the job id goes out as an idempotency key,
and duplication beats silence.

## With more time, or ten times the traffic

The ownership model does not change; the reads do.

- **Presence.** A WebSocket disconnect is a faster signal than silence: release
  on disconnect, keep the timeout as the backstop. Relatedly, `heartbeat` is an
  endpoint here only because replying and note-taking are out of scope — in
  production it is a side effect of those actions, never a client-side timer,
  which would prove the tab is open rather than that the agent is working.
- **Contention.** `POST /tickets/claim-next` with `FOR UPDATE SKIP LOCKED LIMIT 1`,
  so agents are served one each instead of racing.
- **Scale-out.** `WORKER_ENABLED=false` already splits worker from API by config.
  The pool listing is what gets hot: cursor pagination and a short-TTL cache.
- **Observability**, the real gap: claim conflict rate, expiry rate, notification
  failure rate, dead letter depth.
- **Omitted deliberately:** an explicit release endpoint, and a `users` foreign
  key on `claimed_by_agent_id`.
