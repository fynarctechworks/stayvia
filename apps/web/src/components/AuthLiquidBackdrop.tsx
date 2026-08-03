import { Suspense, lazy, useEffect, useState } from "react";

// The fluid sim is the ONLY thing in the app that pulls `three` (~800 kB).
// Lazy-loading it here keeps three out of the main bundle entirely — signed-in
// staff loading the dashboard never download it; it is fetched only when an
// auth page actually renders the brand pane.
const LiquidEther = lazy(() => import("./LiquidEther"));

// Stayvia's own palette. The upstream default is purple; these are the jade /
// brass stops the forest pane is built from, so the fluid reads as a lit
// version of the surface underneath rather than a foreign gradient.
const PALETTE = ["#0F6E52", "#1A4A3A", "#C6A15B"];

/**
 * Animated liquid backdrop for the auth brand pane.
 *
 * Renders nothing when the visitor prefers reduced motion, or on coarse
 * pointers / narrow viewports where a continuous WebGL loop is a battery
 * cost with no payoff (the pane itself is hidden below lg anyway).
 */
export function AuthLiquidBackdrop() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const wide = window.matchMedia("(min-width: 1024px)");
    const decide = () => setEnabled(!reduced.matches && wide.matches);
    decide();
    reduced.addEventListener("change", decide);
    wide.addEventListener("change", decide);
    return () => {
      reduced.removeEventListener("change", decide);
      wide.removeEventListener("change", decide);
    };
  }, []);

  if (!enabled) return null;

  return (
    <div aria-hidden className="absolute inset-0 pointer-events-none opacity-70">
      {/* Suspense fallback is deliberately empty: the forest gradient beneath
          is already the finished design, so the sim fades in as a bonus
          rather than leaving a loading hole. */}
      <Suspense fallback={null}>
        <LiquidEther
          colors={PALETTE}
          mouseForce={18}
          cursorSize={110}
          resolution={0.4}
          isViscous
          viscous={26}
          iterationsViscous={24}
          iterationsPoisson={24}
          autoDemo
          autoSpeed={0.32}
          autoIntensity={1.7}
          takeoverDuration={0.25}
          autoResumeDelay={2200}
          autoRampDuration={0.8}
          style={{ width: "100%", height: "100%" }}
        />
      </Suspense>
    </div>
  );
}
