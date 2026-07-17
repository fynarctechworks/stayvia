import pino from "pino";
import { env } from "../config/env.js";

// pino-pretty is a dev-only prettifier and a separate worker module that the
// pkg-bundled api.exe can't resolve. Use it only for local `npm run dev`
// (development AND not offline) — the offline sidecar and prod log plain JSON.
const usePretty = env.NODE_ENV === "development" && !env.OFFLINE_MODE;

export const logger = pino({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  transport: usePretty
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
    : undefined,
});
