import { sql } from "drizzle-orm";
import { db, pool } from "./client.js";
import { claimEvents, tickets } from "./schema.js";
import { logger } from "../logger.js";

/**
 * Seeds a pool with three deliberate states so every rule is observable the
 * moment the server starts:
 *
 *   - unclaimed        -> the normal pool
 *   - claimed recently -> live claims, absent from the pool
 *   - claimed long ago -> lapsed claims, back in the pool and claimable
 *
 * The third group exists so expiry can be demonstrated without waiting fifteen
 * minutes for a claim to age.
 */
const SEED = [
  { title: "Refund not received after 10 days", customerEmail: "ana@example.com", claim: null },
  { title: "Cannot log in after password reset", customerEmail: "ben@example.com", claim: null },
  { title: "Duplicate charge on invoice #4471", customerEmail: "chris@example.com", claim: null },
  { title: "Order shipped to the wrong address", customerEmail: "dee@example.com", claim: null },
  { title: "App crashes when opening attachments", customerEmail: "eli@example.com", claim: null },
  { title: "Subscription renewed despite cancelling", customerEmail: "fran@example.com", claim: null },
  { title: "Discount code rejected at checkout", customerEmail: "gina@example.com", claim: null },
  { title: "Missing item in delivered package", customerEmail: "hugo@example.com", claim: null },
  { title: "Cannot update billing address", customerEmail: "iris@example.com", claim: null },
  { title: "Export to CSV returns an empty file", customerEmail: "jon@example.com", claim: null },

  { title: "Two-factor codes never arrive", customerEmail: "kim@example.com", claim: { agentId: 1, minutesAgo: 1 } },
  { title: "Account locked after failed payment", customerEmail: "lee@example.com", claim: { agentId: 2, minutesAgo: 3 } },
  { title: "Webhook deliveries stopped overnight", customerEmail: "mia@example.com", claim: { agentId: 3, minutesAgo: 6 } },

  { title: "Damaged product received", customerEmail: "nina@example.com", claim: { agentId: 4, minutesAgo: 20 } },
  { title: "Requesting invoice for last quarter", customerEmail: "omar@example.com", claim: { agentId: 5, minutesAgo: 45 } },
] as const;

await db.transaction(async (tx) => {
  await tx.execute(sql`TRUNCATE ${claimEvents}, ${tickets} RESTART IDENTITY CASCADE`);

  await tx.insert(tickets).values(
    SEED.map(({ title, customerEmail, claim }) => {
      if (!claim) return { title, customerEmail };
      const at = sql`now() - make_interval(mins => ${claim.minutesAgo}::int)`;
      return {
        title,
        customerEmail,
        claimedByAgentId: claim.agentId,
        claimedAt: at,
        lastActivityAt: at,
      };
    }),
  );
});

const live = SEED.filter((s) => s.claim && s.claim.minutesAgo < 15).length;
const lapsed = SEED.filter((s) => s.claim && s.claim.minutesAgo >= 15).length;

logger.info(
  { total: SEED.length, unclaimed: SEED.length - live - lapsed, live, lapsed },
  "seeded tickets",
);

await pool.end();
