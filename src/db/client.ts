import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

/**
 * A claim holds a connection for roughly a millisecond, so a modest pool
 * comfortably serves 40 agents. `statement_timeout` is the safety net: no
 * single query may pin a connection long enough to starve the pool.
 */
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 5_000,
  application_name: "ticket-claiming-service",
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;
/** A transaction handle, as passed to `db.transaction(...)`. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Anything queries can run against: the pool or an open transaction. */
export type Executor = Database | Transaction;
