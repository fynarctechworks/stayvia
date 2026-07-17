import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Supabase-inspired system (see DESIGN.md): white canvas, near-black
      // ink, one emerald primary, grey hairlines. Token NAMES are legacy
      // (brass/cream/navy) — only values were remapped so every existing
      // class keeps working. Roles: brass/gold = accent → emerald;
      // cream/ivory = light text/surface → white; navy/brand.dark = dark
      // surface & heading ink → canvas-night.
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
        navy: "#1c1c1c",
        accentBlue: "#24b47e",
        gold: "#3ecf8e",
        brass: "#3ecf8e",
        cream: "#ffffff",
        ivory: "#ffffff",
        success: "#24b47e",
        warning: "#b45309",
        danger: "#dc2626",
        // Informational blue — used for the upcoming-arrivals banner.
        // Same visual weight as `danger` but reads "heads up, not
        // emergency".
        info: "#2563eb",
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
        // 6px is the Supabase signature button/input radius.
        sm: "6px",
        md: "8px",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
