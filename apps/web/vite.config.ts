import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5180,
    strictPort: true,
    host: true,
  },
  build: {
    rollupOptions: {
      output: {
        // Split the stable vendor libraries out of the app chunk so app
        // deploys don't re-download React/supabase/query for returning
        // browsers, and the main chunk stays under the 500 kB warning.
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          data: ["@tanstack/react-query", "@supabase/supabase-js"],
        },
      },
    },
  },
});
