import { pino } from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.LOG_LEVEL,
  base: undefined,
  ...(config.NODE_ENV === "development"
    ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } }
    : {}),
});

export type Logger = typeof logger;
