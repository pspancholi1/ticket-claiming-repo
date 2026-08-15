import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAgent } from "../http/agent.js";
import { AppError, ErrorCode } from "../http/errors.js";
import * as tickets from "./service.js";

const TicketIdParams = z.object({ id: z.coerce.number().int().positive() });

const PoolQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const HistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Parses with Zod, converting a failure into the standard error shape. */
function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(400, ErrorCode.validationFailed, "invalid request", result.error.issues);
  }
  return result.data;
}

export const ticketRoutes: Router = Router();

/** The pool: unclaimed tickets, plus those whose claim has lapsed. */
ticketRoutes.get("/pool", async (req: Request, res: Response) => {
  const { limit, offset } = parse(PoolQuery, req.query);
  res.json(await tickets.pool(limit, offset));
});

/** Tickets this agent currently holds. */
ticketRoutes.get("/mine", requireAgent, async (req: Request, res: Response) => {
  res.json({ items: await tickets.heldBy(req.agentId) });
});

/** Claim history for one ticket, newest first. */
ticketRoutes.get("/:id/events", async (req: Request, res: Response) => {
  const { id } = parse(TicketIdParams, req.params);
  const { limit } = parse(HistoryQuery, req.query);
  res.json({ items: await tickets.history(id, limit) });
});

/** Take ownership. Idempotent for the agent who already holds it. */
ticketRoutes.post("/:id/claim", requireAgent, async (req: Request, res: Response) => {
  const { id } = parse(TicketIdParams, req.params);
  res.json(await tickets.claim(id, req.agentId));
});

/** Record activity, extending the claim by another TTL. */
ticketRoutes.post("/:id/heartbeat", requireAgent, async (req: Request, res: Response) => {
  const { id } = parse(TicketIdParams, req.params);
  res.json(await tickets.heartbeat(id, req.agentId));
});
