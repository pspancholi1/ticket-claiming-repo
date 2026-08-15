import type { Server } from "node:http";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db/client.js";
import { registerSweeper } from "./jobs/sweeper.js";
import { logger } from "./logger.js";
import { registerNotificationWorker } from "./notifications/worker.js";
import { boss, startQueue } from "./queue/index.js";

/** Longest we wait for in-flight work before exiting anyway. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  await startQueue();

  // The worker shares this process because the load is roughly one job a
  // minute; there is nothing to isolate. Setting WORKER_ENABLED=false on API
  // instances splits them into separate deployments as a config change rather
  // than a rewrite.
  if (config.WORKER_ENABLED) {
    await registerNotificationWorker();
    await registerSweeper();
  } else {
    logger.info("worker disabled in this process");
  }

  const server = createApp().listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, claimTtlMinutes: config.CLAIM_TTL_MINUTES, worker: config.WORKER_ENABLED },
      "listening",
    );
  });

  installShutdownHandlers(server);
}

/**
 * Ordered shutdown.
 *
 * Notification calls take up to 20 seconds, so a restart has a real chance of
 * landing mid-call. Killing the process there leaves the job's lease held: it
 * is retried once the lease lapses, and if the original call had in fact
 * succeeded the customer is messaged twice. Draining first makes that rare
 * instead of routine.
 *
 * Stop accepting connections, let in-flight requests finish, let pg-boss settle
 * the jobs it already started, then close the pool. A hard timeout guarantees
 * the process still exits if something external hangs, so a deploy is never
 * blocked by a stuck third party.
 */
function installShutdownHandlers(server: Server): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "shutting down");
    const failsafe = setTimeout(() => {
      logger.error("graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    try {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await boss.stop({ graceful: true, timeout: SHUTDOWN_TIMEOUT_MS });
      await pool.end();

      clearTimeout(failsafe);
      logger.info("shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandled rejection");
  });
}

await main();
