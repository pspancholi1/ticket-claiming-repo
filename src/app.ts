import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { pinoHttp } from "pino-http";
import { AppError, ErrorCode } from "./http/errors.js";
import { logger } from "./logger.js";
import { ticketRoutes } from "./tickets/routes.js";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/healthz" } }));

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.use("/tickets", ticketRoutes);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: ErrorCode.ticketNotFound, message: "route not found" } });
  });

  app.use(errorHandler);

  return app;
}

/**
 * Single place where an error becomes a response.
 *
 * Anything deliberate arrives as an AppError and keeps its status and code.
 * Anything else is a bug: it is logged in full and reported as a generic 500,
 * so internals never leak into a client.
 */
function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
    return;
  }

  req.log.error({ err }, "unhandled error");
  res.status(500).json({ error: { code: ErrorCode.internal, message: "internal server error" } });
}
