import pino from "pino";
import { env } from "../config/env.js";

// pino-pretty is a dev-only prettifier. Use it only for local `npm run dev`;
// prod logs plain JSON.
const usePretty = env.NODE_ENV === "development";

export const logger = pino({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  transport: usePretty
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
    : undefined,
});
