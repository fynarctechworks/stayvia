import type { ReactNode } from "react";

// Sticky wrapper for list-page filter bars. Pins its children to the
// top of the viewport while the list scrolls underneath, so filters
// stay reachable on long pages. Bleeds over AppShell's main padding
// (-mx / px mirror its p-3 sm:p-5 md:p-6) so rows disappear under the
// bar instead of peeking out at the edges. z-30 keeps it below the
// alert stack (z-40) and modals (z-50).
export function StickyBar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky top-0 z-30 -mx-3 sm:-mx-5 md:-mx-6 px-3 sm:px-5 md:px-6 py-2 bg-bg/95 backdrop-blur-sm space-y-3">
      {children}
    </div>
  );
}
