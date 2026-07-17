import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    include: ["src/**/*.test.ts"],
    env: {
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "test-anon",
      SUPABASE_SERVICE_KEY: "test-service",
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "test-token",
      UPSTASH_REDIS_URL: "rediss://default:test@example.upstash.io:6380",
      ENCRYPTION_KEY:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      FRONTEND_URL: "http://localhost:5173",
      NODE_ENV: "test",
      PORT: "4000",
    },
  },
});
