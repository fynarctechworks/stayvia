import { useEffect, useState } from "react";
import { format } from "date-fns";

// "What is today's date?" — as a value that actually changes when the date
// changes.
//
// A front-desk tab is opened once and left running for days. Computing
// `format(new Date(), "yyyy-MM-dd")` into a module constant froze the answer
// at whatever moment the bundle first evaluated, so after an IST midnight the
// booking form still believed it was yesterday: it seeded check-in with a past
// date, clamped the date input's `max` to that past date (making the REAL
// current date unselectable), and never fired its own "Backdated check-in"
// warning because that compared against the same stale string. A walk-in
// entered that way is booked for a window that has already closed.
//
// The timer alone isn't enough — a suspended laptop wakes with an overdue
// setTimeout — so we also re-check whenever the tab becomes visible or
// regains focus, which is exactly when staff come back to it.
function todayString(): string {
  return format(new Date(), "yyyy-MM-dd");
}

export function useToday(): string {
  const [today, setToday] = useState(todayString);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const scheduleNextRollover = () => {
      const now = new Date();
      // A few seconds past midnight, so the clock has definitely ticked over
      // by the time we re-read it.
      const next = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        0,
        0,
        5,
      );
      timer = setTimeout(() => {
        setToday(todayString());
        scheduleNextRollover();
      }, Math.max(1000, next.getTime() - now.getTime()));
    };

    // setToday with the identity guard so a no-op re-check doesn't re-render.
    const recheck = () => setToday((prev) => (prev === todayString() ? prev : todayString()));

    scheduleNextRollover();
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, []);

  return today;
}
