import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { claimEvents, tickets, type Ticket } from "../src/db/schema.js";

export async function resetTickets(): Promise<void> {
  await db.execute(sql`TRUNCATE ${claimEvents}, ${tickets} RESTART IDENTITY CASCADE`);
}

/**
 * Inserts a ticket, optionally with a claim aged by `minutesAgo` so expiry can
 * be exercised without waiting for real time to pass.
 */
export async function insertTicket(
  claim?: { agentId: number; minutesAgo: number },
): Promise<Ticket> {
  const at = claim ? sql`now() - make_interval(mins => ${claim.minutesAgo}::int)` : null;

  const [row] = await db
    .insert(tickets)
    .values({
      title: "Test ticket",
      customerEmail: "customer@example.com",
      ...(claim ? { claimedByAgentId: claim.agentId, claimedAt: at, lastActivityAt: at } : {}),
    })
    .returning();

  return row!;
}

export function statusOf(error: unknown): number | undefined {
  return (error as { status?: number }).status;
}

export function codeOf(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}
