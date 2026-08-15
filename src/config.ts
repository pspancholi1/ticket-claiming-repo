import { existsSync } from "node:fs";
import { z } from "zod";

// Node loads .env natively; no dotenv dependency needed.
if (existsSync(".env")) process.loadEnvFile(".env");

/**
 * All environment access happens here. Nothing else in the codebase reads
 * `process.env`, so a missing or malformed variable fails at boot with a
 * readable message rather than at 3am inside a request.
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  /** A claim lapses after this many minutes without agent activity. */
  CLAIM_TTL_MINUTES: z.coerce.number().int().positive().default(15),

  /** Run the queue worker and sweeper in this process. */
  WORKER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  NOTIFY_MIN_LATENCY_MS: z.coerce.number().int().nonnegative().default(2_000),
  NOTIFY_MAX_LATENCY_MS: z.coerce.number().int().nonnegative().default(20_000),
  NOTIFY_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.2),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const config = Object.freeze(parsed.data);
export type Config = typeof config;
