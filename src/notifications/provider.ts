import { config } from "../config.js";

export class NotificationProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationProviderError";
  }
}

export interface CustomerNotification {
  ticketId: number;
  customerEmail: string;
  /** Used as an idempotency key so a real provider can discard duplicates. */
  idempotencyKey: string;
}

/**
 * Stand-in for the external notification service.
 *
 * Deliberately hostile, per the brief: 2-20 seconds of latency and a failure
 * roughly one time in five. Nothing here is our design — everything around it
 * is.
 */
export async function sendCustomerNotification(notification: CustomerNotification): Promise<void> {
  const spread = config.NOTIFY_MAX_LATENCY_MS - config.NOTIFY_MIN_LATENCY_MS;
  const latencyMs = config.NOTIFY_MIN_LATENCY_MS + Math.floor(Math.random() * (spread + 1));

  await new Promise((resolve) => setTimeout(resolve, latencyMs));

  if (Math.random() < config.NOTIFY_FAILURE_RATE) {
    throw new NotificationProviderError(
      `notification provider rejected ticket ${notification.ticketId} after ${latencyMs}ms`,
    );
  }
}
