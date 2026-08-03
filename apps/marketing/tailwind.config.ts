import type { Config } from "tailwindcss";

// "Warm Concierge" — the SAME token set the product app uses (see
// apps/web/tailwind.config.ts). The marketing site previously ran the old
// Supabase-inspired palette, so a visitor clicking "Start free trial" went
// from bright-emerald/cool-white marketing into a deep-jade/warm-paper
// product; the two read as different companies.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#0F6E52",
          deep: "#0A5540",
          dark: "#2A302B",
          mid: "#0A5540",
          light: "#0A5540",
          soft: "#E7F0EA",
          softer: "#F2F6F2",
          tint: "#CFE6DB",
        },
        // Forest brand pane, borrowed from the product's auth screens — the
        // one dark surface Stayvia already owns.
        forest: {
          DEFAULT: "#10352A",
          light: "#1A4A3A",
          deep: "#0B281F",
        },
        gold: "#B4884A",
        brass: "#C6A15B",
        cream: "#F1EFE8",
        ink: "#1E2420",
        inkBody: "#4A5049",
        inkMuted: "#8A9088",
        inkFaint: "#B0B4AA",
        inkDark: "#2A302B",
        bg: "#F1EFE8",
        surface: "#FFFFFF",
        surfaceAlt: "#FBFAF7",
        surfaceSubtle: "#F7F5F0",
        paper: "#F4F2EC",
        parchment: "#EEEBE3",
        textPrimary: "#1E2420",
        textSecondary: "#6A7069",
        borderc: "#E9E6DE",
        borderControl: "#E1DED6",
        divider: "#EFEDE7",
        success: "#1F6B4B",
        successBg: "#E4F1EA",
        successBorder: "#C6DDD0",
        warnBg: "#FBF3E3",
        warnFg: "#8A6014",
        warnBorder: "#E9D6B0",
        dangerBg: "#F7E7E2",
        dangerFg: "#93412F",
        dangerBorder: "#E6C1B6",
        infoBg: "#E8EEF5",
        info: "#3C5A7A",
        infoBorder: "#CBD8E4",
        neutralBg: "#EDEBE4",
        neutralBorder: "#E1DED6",
      },
      fontFamily: {
        sans: ["DM Sans", "system-ui", "sans-serif"],
        mono: ["Roboto Mono", "ui-monospace", "monospace"],
      },
      borderRadius: {
        sm: "10px",
        md: "12px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(28,32,29,.04), 0 6px 16px rgba(28,32,29,.03)",
        lift: "0 10px 20px rgba(28,32,29,.12)",
        primary: "0 2px 8px rgba(15,110,82,.22)",
      },
    },
  },
  plugins: [],
} satisfies Config;
