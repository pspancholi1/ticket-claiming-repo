import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client.js";
import { logger } from "../logger.js";

await migrate(db, { migrationsFolder: "./drizzle" });
logger.info("migrations applied");
await pool.end();
