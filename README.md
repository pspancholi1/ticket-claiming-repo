# Ticket Claiming Service

An API for a shared support ticket pool. Agents claim tickets, exactly one owner
at a time, and a claim lapses after 15 minutes of inactivity. Claiming notifies
the customer through a slow, unreliable external service.

The reasoning behind every decision is in **[DESIGN.md](./DESIGN.md)**, which is
the more important document.

## Running it

Requires Node 22+, pnpm, and Docker (or any reachable Postgres).

```bash
pnpm install
cp .env.example .env

docker compose up -d      # Postgres on :5433
pnpm db:migrate
pnpm db:seed
pnpm dev                  # API + worker on :3000
```

Using a Postgres you already have? Point `DATABASE_URL` at an empty database and
skip `docker compose`.

```bash
pnpm test                 # integration tests, needs the database
pnpm typecheck
```

## Trying it

The seed creates 15 tickets: 10 unclaimed, 3 actively claimed, and **2 whose
claims already lapsed** — so expiry is observable immediately rather than after a
15 minute wait.

### Racing several agents for one ticket

```bash
pnpm race           # 40 agents, first ticket in the pool
pnpm race 3 10      # 10 agents, ticket 3
```

Fires real concurrent HTTP claims and reports what each agent got:

```
40 agents claiming ticket 1 simultaneously

  agent   status  outcome                   time
  ----------------------------------------------------
      1   200     claimed it                31ms
      2   409     ticket already claimed    45ms
      …
  1 claimed, 39 rejected
  → ticket 1 belongs to agent 1

  1 claim event(s) → that many customer notifications queued
```

Run it a second time on the same ticket: the winning agent gets `200` again —
claiming is idempotent for the current owner — and the claim history still shows
a single event, so the customer is not messaged twice.

`pnpm test` asserts the same guarantee, plus expiry, heartbeat and sweeper
behaviour.

### Watching the notification behaviour

Claiming returns immediately; the customer message is delivered by a worker
afterwards. With defaults that takes 2-20 seconds, and fails one time in five —
faithful to the brief, but awkward to observe. The provider is configurable so
both paths can be forced.

**Happy path** — fast, always succeeds:

```bash
NOTIFY_MAX_LATENCY_MS=500 NOTIFY_FAILURE_RATE=0 pnpm dev
```
```
INFO: ticket claimed          ← response already sent
INFO: customer notified       ← half a second later, out of band
```

**Failure path** — every attempt fails, retries compressed:

```bash
NOTIFY_FAILURE_RATE=1 NOTIFY_MAX_LATENCY_MS=400 NOTIFY_RETRY_DELAY_SECONDS=1 pnpm dev
```
```
WARN  customer notification failed, will retry        +0s
WARN  customer notification failed, will retry        +2s
WARN  customer notification failed, will retry        +6s
WARN  customer notification failed, will retry       +14s
ERROR customer notification permanently failed       +22s   → dead letter queue
```

Four attempts, exponential backoff, then dead-lettered and logged at error — the
~1-in-600 case where the customer is never told. With production defaults the
same sequence takes about 54 seconds, still far inside the 15 minute claim TTL.

### Postman

Import `postman_collection.json`. Twelve requests in the order the rules build
on each other, each asserting its own expected status — so running the whole
collection is a pass/fail report of the claiming behaviour (28 assertions). The
pool request saves an available ticket id into a variable, so the later requests
need no editing.

```bash
npx newman run postman_collection.json   # same thing on the command line
```

### curl

Agent identity is a header. Authentication is out of scope.

```bash
# The pool: unclaimed tickets plus lapsed claims (14 and 15 are the lapsed ones)
curl -s localhost:3000/tickets/pool | jq

# Claim one
curl -s -XPOST localhost:3000/tickets/1/claim -H 'X-Agent-Id: 7' | jq

# It leaves the pool, and `expiresAt` tells the client when the claim lapses
curl -s localhost:3000/tickets/pool | jq '.items[].id'

# A second agent is refused
curl -s -XPOST localhost:3000/tickets/1/claim -H 'X-Agent-Id: 9' | jq

# The same agent claiming again is fine, and does not re-notify the customer
curl -s -XPOST localhost:3000/tickets/1/claim -H 'X-Agent-Id: 7' | jq

# Stay alive
curl -s -XPOST localhost:3000/tickets/1/heartbeat -H 'X-Agent-Id: 7' | jq

# Take over a ticket whose claim lapsed
curl -s -XPOST localhost:3000/tickets/14/claim -H 'X-Agent-Id: 8' | jq

# What am I holding?
curl -s localhost:3000/tickets/mine -H 'X-Agent-Id: 7' | jq

# Claim history for a ticket
curl -s localhost:3000/tickets/14/events | jq
```

Watch the logs after a claim: the response returns immediately, and the customer
notification lands 2–20 seconds later, retrying when the provider fails.

## API

| Method | Path | |
|---|---|---|
| `GET` | `/tickets/pool` | Available tickets. `?limit=25&offset=0` |
| `GET` | `/tickets/mine` | Live claims held by `X-Agent-Id` |
| `GET` | `/tickets/:id/events` | Claim history, newest first |
| `POST` | `/tickets/:id/claim` | Take ownership. Idempotent for the current owner |
| `POST` | `/tickets/:id/heartbeat` | Record activity, extending the claim |
| `GET` | `/healthz` | Liveness |

`X-Agent-Id` is required on `mine`, `claim` and `heartbeat`.

| Status | Meaning |
|---|---|
| `200` | Claimed, or re-claimed by the agent who already held it |
| `400` | `VALIDATION_FAILED` / `AGENT_ID_REQUIRED` |
| `404` | `TICKET_NOT_FOUND` |
| `409` | `TICKET_ALREADY_CLAIMED` — held by someone else |
| `409` | `CLAIM_NOT_HELD` — your claim lapsed, or was never yours |

Errors are `{ "error": { "code", "message" } }`.

## Layout

```
src/
  config.ts              env parsed once, with Zod
  app.ts                 express wiring and the error handler
  index.ts               bootstrap and graceful shutdown
  db/
    schema.ts            tickets, claim_events
    client.ts            pool (statement_timeout, max 20)
    seed.ts
  tickets/
    routes.ts            HTTP only
    service.ts           business rules, transactions
    queries.ts           the SQL, including the compare-and-swap claim
  notifications/
    provider.ts          the mock: 2-20s, fails ~1 in 5
    worker.ts            delivery, retries, dead lettering
  jobs/
    sweeper.ts           reconciles lapsed claims
  queue/
    index.ts             pg-boss setup and retry policy
tests/
  claiming.test.ts       concurrency, expiry, heartbeat, sweeper
```

`src/tickets/queries.ts` is the file worth reading first — the single statement
that guarantees one owner is there.

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | — | required |
| `PORT` | `3000` | |
| `CLAIM_TTL_MINUTES` | `15` | how long a claim survives silence |
| `WORKER_ENABLED` | `true` | `false` on API-only instances |
| `NOTIFY_FAILURE_RATE` | `0.2` | mock provider failure rate |
| `NOTIFY_MIN_LATENCY_MS` / `NOTIFY_MAX_LATENCY_MS` | `2000` / `20000` | mock provider latency |

Set `NOTIFY_MIN_LATENCY_MS=0 NOTIFY_MAX_LATENCY_MS=100` to watch delivery
without the wait, or `NOTIFY_FAILURE_RATE=1` to force the dead letter path.

## Scope

Built: claiming, expiry, the pool, activity tracking, customer notification.

Not built, per the brief: authentication, user management, ticket creation,
resolving or closing tickets, deployment, CI.
