import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // "Warm Concierge" system (see design_handoff_stayvia_redesign/README.md):
      // warm paper canvas, white cards, deep-jade primary, warm-grey ink,
      // brass/gold accents. Token NAMES are legacy (brand/brass/cream/navy) —
      // only VALUES were remapped so every existing class keeps working.
      // Roles: brand = jade primary; brand.dark = dark surface (#2A302B);
      // cream = text on dark surfaces; brass = on-dark brass accent;
      // gold = on-light gold accent.
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
        navy: "#1E2420",
        accentBlue: "#3C5A7A",
        gold: "#B4884A",
        brass: "#C6A15B",
        cream: "#F1EFE8",
        ivory: "#FBFAF7",
        success: "#1F6B4B",
        warning: "#B45309",
        danger: "#BB4A38",
        info: "#3C5A7A",
        bg: "#F1EFE8",
        surface: "#FFFFFF",
        surfaceAlt: "#FBFAF7",
        surfaceSubtle: "#F7F5F0",
        textPrimary: "#1E2420",
        textSecondary: "#6A7069",
        borderc: "#E9E6DE",
        borderControl: "#E1DED6",
        divider: "#EFEDE7",
        // Ink scale for finer text hierarchy than textPrimary/textSecondary.
        ink: "#1E2420",
        inkBody: "#4A5049",
        inkMuted: "#8A9088",
        inkFaint: "#B0B4AA",
        inkDark: "#2A302B",
        // Room-state extras (dashboard proportion bar, tiles).
        reserved: "#4F6D8A",
        notReady: "#C79A3F",
        // Semantic bg/fg/border triads for pills, badges, strips.
        infoBg: "#E8EEF5",
        infoBorder: "#CBD8E4",
        successBg: "#E4F1EA",
        successBorder: "#C6DDD0",
        warnBg: "#FBF3E3",
        warnFg: "#8A6014",
        warnDeep: "#9A6B14",
        warnBorder: "#E9D6B0",
        dangerBg: "#F7E7E2",
        dangerFg: "#93412F",
        dangerBorder: "#E6C1B6",
        neutralBg: "#EDEBE4",
        neutralBorder: "#E1DED6",
      },
      fontFamily: {
        sans: ["Hanken Grotesk", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      borderRadius: {
        // Warm Concierge: buttons/inputs 10-12px, cards use rounded-2xl (16px).
        sm: "10px",
        md: "12px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(28,32,29,.04), 0 6px 16px rgba(28,32,29,.03)",
        lift: "0 10px 20px rgba(28,32,29,.12)",
        modal: "0 30px 80px rgba(20,24,20,.4)",
        primary: "0 2px 8px rgba(15,110,82,.22)",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
