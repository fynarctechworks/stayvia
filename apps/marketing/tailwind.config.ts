import type { Config } from "tailwindcss";

// Same Supabase-inspired token set as apps/web (see apps/web/DESIGN.md):
// white canvas, near-black ink, one emerald primary, grey hairlines.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#3ecf8e",
          deep: "#24b47e",
          dark: "#1c1c1c",
          mid: "#24b47e",
          light: "#4ade80",
          soft: "#ecfdf5",
          softer: "#f6fefa",
        },
        ink: "#171717",
        bg: "#fafafa",
        surface: "#ffffff",
        textPrimary: "#171717",
        textSecondary: "#707070",
        borderc: "#dfdfdf",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      borderRadius: {
        sm: "6px",
        md: "8px",
      },
    },
  },
  plugins: [],
} satisfies Config;
