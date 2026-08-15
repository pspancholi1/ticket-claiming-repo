/**
 * Demonstration harness: several agents going for the same ticket at once.
 *
 * Fires real, concurrent HTTP requests against a running server rather than
 * calling the service in-process, so what it exercises is the same path an
 * agent's browser takes — connection pool included.
 *
 *   pnpm race                 pick the first ticket in the pool, 40 agents
 *   pnpm race 3               ticket 3, 40 agents
 *   pnpm race 3 10            ticket 3, 10 agents
 */
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const ticketArg = process.argv[2] ? Number(process.argv[2]) : undefined;
const agentCount = process.argv[3] ? Number(process.argv[3]) : 40;

interface Attempt {
  agentId: number;
  status: number;
  code: string;
  ms: number;
}

async function claim(ticketId: number, agentId: number): Promise<Attempt> {
  const startedAt = performance.now();
  const response = await fetch(`${BASE}/tickets/${ticketId}/claim`, {
    method: "POST",
    headers: { "X-Agent-Id": String(agentId) },
  });
  const body = (await response.json()) as { error?: { code: string } };

  return {
    agentId,
    status: response.status,
    code: body.error?.code ?? "CLAIMED",
    ms: Math.round(performance.now() - startedAt),
  };
}

async function main(): Promise<void> {
  const ticketId = ticketArg ?? (await firstAvailableTicket());

  console.log(`\n${agentCount} agents claiming ticket ${ticketId} simultaneously\n`);

  // Every request is created before any is awaited, so they are all in flight
  // together rather than one after another.
  const attempts = await Promise.all(
    Array.from({ length: agentCount }, (_, i) => claim(ticketId, i + 1)),
  );

  const winners = attempts.filter((a) => a.status === 200);
  const losers = attempts.filter((a) => a.status !== 200);

  console.log("  agent   status  outcome                   time");
  console.log("  " + "-".repeat(52));
  // Long runs are elided in the middle so the output stays readable on screen.
  if (attempts.length <= 12) {
    attempts.forEach(print);
  } else {
    attempts.slice(0, 8).forEach(print);
    console.log(`  ${" ".repeat(4)}… ${attempts.length - 12} more`);
    attempts.slice(-4).forEach(print);
  }

  console.log(`\n  ${winners.length} claimed, ${losers.length} rejected`);
  if (winners.length === 1) {
    console.log(`  → ticket ${ticketId} belongs to agent ${winners[0]!.agentId}\n`);
  } else {
    console.log(`  → UNEXPECTED: ${winners.length} winners\n`);
  }

  const events = (await (await fetch(`${BASE}/tickets/${ticketId}/events`)).json()) as {
    items: Array<{ type: string; agentId: number; createdAt: string }>;
  };

  console.log("  claim history (newest first)");
  for (const e of events.items) {
    console.log(`    ${e.createdAt}  ${e.type.padEnd(8)} agent ${e.agentId}`);
  }
  console.log(
    `\n  ${events.items.filter((e) => e.type === "claimed").length} claim event(s) → ` +
      `that many customer notifications queued\n`,
  );
}

function print(a: Attempt): void {
  const outcome = a.status === 200 ? "claimed it" : a.code.toLowerCase().replace(/_/g, " ");
  console.log(
    `  ${String(a.agentId).padStart(5)}   ${a.status}     ${outcome.padEnd(24)}  ${a.ms}ms`,
  );
}

async function firstAvailableTicket(): Promise<number> {
  const pool = (await (await fetch(`${BASE}/tickets/pool?limit=1`)).json()) as {
    items: Array<{ id: number }>;
  };
  const first = pool.items[0];
  if (!first) throw new Error("pool is empty — run `pnpm db:seed` first");
  return first.id;
}

await main();
