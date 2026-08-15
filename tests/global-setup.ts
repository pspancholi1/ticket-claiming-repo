import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../src/db/client.js";

/** Brings the test database up to the current schema once per run. */
export default async function setup(): Promise<void> {
  await migrate(db, { migrationsFolder: "./drizzle" });
  await pool.end();
}
