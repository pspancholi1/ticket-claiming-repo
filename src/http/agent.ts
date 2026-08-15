import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { AppError, ErrorCode } from "./errors.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      agentId: number;
    }
  }
}

const AgentIdSchema = z.coerce.number().int().positive();

/**
 * Establishes who is calling.
 *
 * Authentication is out of scope, so identity arrives in a header. In a real
 * deployment this is the subject of a verified token; the rest of the codebase
 * is unaffected either way, because it only ever reads `req.agentId`.
 */
export function requireAgent(req: Request, _res: Response, next: NextFunction): void {
  const parsed = AgentIdSchema.safeParse(req.header("x-agent-id"));

  if (!parsed.success) {
    next(
      new AppError(
        400,
        ErrorCode.agentIdRequired,
        "X-Agent-Id header must be a positive integer",
      ),
    );
    return;
  }

  req.agentId = parsed.data;
  next();
}
