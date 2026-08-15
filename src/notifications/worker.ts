import { logger } from "../logger.js";
import { boss, QUEUE } from "../queue/index.js";
import { sendCustomerNotification } from "./provider.js";

/** Payload enqueued inside the claim transaction. */
export interface NotifyCustomerJob {
  ticketId: number;
  customerEmail: string;
  agentId: number;
}

/**
 * Delivers the "an agent has picked up your ticket" message.
 *
 * Runs outside the request, so a 20 second call never delays a claim, and —
 * just as importantly — outside any database transaction. Holding a connection
 * across a call this slow would drain the pool and stall every endpoint, not
 * only this one. pg-boss checks the job out in one short transaction, releases
 * the connection, and settles the outcome in another.
 *
 * Throwing hands the job back to pg-boss, which applies the retry policy and
 * finally routes it to the dead letter queue.
 */
export async function registerNotificationWorker(): Promise<void> {
  await boss.work<NotifyCustomerJob>(
    QUEUE.notifyCustomer,
    { batchSize: 1, localConcurrency: 5, pollingIntervalSeconds: 1 },
    async ([job]) => {
      if (!job) return;

      const { ticketId, customerEmail, agentId } = job.data;

      try {
        await sendCustomerNotification({
          ticketId,
          customerEmail,
          idempotencyKey: job.id,
        });
        logger.info({ ticketId, agentId, jobId: job.id }, "customer notified");
      } catch (error) {
        // Logged at warn, not error: a single failure is expected behaviour for
        // this provider and is about to be retried.
        logger.warn(
          { ticketId, agentId, jobId: job.id, err: error },
          "customer notification failed, will retry",
        );
        throw error;
      }
    },
  );

  // The dead letter queue is drained only to make exhausted deliveries loud.
  // These are the claims whose customer was never told.
  await boss.work<NotifyCustomerJob>(
    QUEUE.notifyCustomerDlq,
    { batchSize: 10, pollingIntervalSeconds: 30 },
    async (jobs) => {
      for (const job of jobs) {
        logger.error(
          { ticketId: job.data.ticketId, agentId: job.data.agentId, jobId: job.id },
          "customer notification permanently failed after all retries",
        );
      }
    },
  );

  logger.info("notification worker registered");
}
