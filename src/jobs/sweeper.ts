import { db } from "../db/client.js";
import { recordClaimEvents, releaseExpiredClaims } from "../tickets/queries.js";
import { logger } from "../logger.js";
import { boss, QUEUE } from "../queue/index.js";

/**
 * Clears claims that have gone quiet.
 *
 * This is a reconciler, not the expiry mechanism. Every read and every write
 * already treats a lapsed claim as available, so a ticket returns to the pool
 * the moment it lapses whether or not this ever runs. What this adds is tidy
 * rows for anything reading the table directly, and the `expired` events that
 * make the lapse rate measurable — the number that tells you whether the TTL
 * is set correctly.
 *
 * It may lag, or fail, without affecting correctness.
 */
export async function sweepExpiredClaims(): Promise<number> {
  const released = await db.transaction(async (tx) => {
    const rows = await releaseExpiredClaims(tx);
    await recordClaimEvents(
      tx,
      rows.map(({ ticketId, agentId }) => ({ ticketId, agentId, type: "expired" as const })),
    );
    return rows;
  });

  if (released.length > 0) {
    logger.info({ count: released.length, tickets: released.map((r) => r.ticketId) }, "claims expired");
  }

  return released.length;
}

export async function registerSweeper(): Promise<void> {
  await boss.work(
    QUEUE.sweepExpiredClaims,
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async () => {
      await sweepExpiredClaims();
    },
  );

  // pg-boss owns the schedule, so no external cron is needed and multiple
  // instances will not each run their own copy.
  await boss.schedule(QUEUE.sweepExpiredClaims, "* * * * *");

  logger.info("claim sweeper scheduled");
}
