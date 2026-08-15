import { PgBoss } from "pg-boss";
import { config } from "../config.js";
import { logger } from "../logger.js";

export const QUEUE = {
  /** Tell the customer an agent has picked up their ticket. */
  notifyCustomer: "notify-customer",
  /** Notifications that exhausted every retry. Inspect, fix, replay. */
  notifyCustomerDlq: "notify-customer-dlq",
  /** Periodic reconciler that clears lapsed claims. */
  sweepExpiredClaims: "sweep-expired-claims",
} as const;

/**
 * Retry policy for customer notifications.
 *
 * The provider is slow (up to 20s) and fails roughly one call in five, so
 * retries are essential — but bounded. One attempt plus three retries, with
 * exponential backoff, gives up after roughly a minute — comfortably inside the
 * claim TTL. That is what makes a fencing token unnecessary: a retry can never
 * outlive the claim it belongs to.
 */
export const NOTIFY_POLICY = {
  retryLimit: 3,
  retryDelay: 5,
  retryBackoff: true,
  /** Above the provider's 20s worst case; a hung call must not pin a worker. */
  expireInSeconds: 25,
  /** Exhausted jobs are preserved rather than dropped. */
  deadLetter: QUEUE.notifyCustomerDlq,
} as const;

export const boss = new PgBoss({
  connectionString: config.DATABASE_URL,
  schema: "pgboss",
  application_name: "ticket-claiming-worker",
  max: 5,
});

boss.on("error", (error) => logger.error({ err: error }, "pg-boss error"));

/**
 * Queues are declared before anything is sent to them. Doing this at boot means
 * the retry policy lives in one readable place instead of being repeated at
 * every call site.
 */
export async function startQueue(): Promise<void> {
  await boss.start();
  await boss.createQueue(QUEUE.notifyCustomerDlq);
  await boss.createQueue(QUEUE.notifyCustomer, NOTIFY_POLICY);
  await boss.createQueue(QUEUE.sweepExpiredClaims, { retryLimit: 0 });
  logger.info({ schema: "pgboss" }, "queue ready");
}
