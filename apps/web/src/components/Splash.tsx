import { useEffect, useState } from "react";

export function Splash({ onDone, duration = 3500 }: { onDone: () => void; duration?: number }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const fadeAt = duration - 400;
    const fadeTimer = setTimeout(() => setLeaving(true), fadeAt);
    const doneTimer = setTimeout(onDone, duration);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(doneTimer);
    };
  }, [duration, onDone]);

  return (
    <div
      className={`fixed inset-0 z-[9999] grid place-items-center overflow-hidden bg-bg transition-opacity duration-500 ${
        leaving ? "opacity-0" : "opacity-100"
      }`}
      aria-hidden={leaving}
    >
      {/* Soft jade wash on the warm paper canvas — replaces the old
          dark/emerald radial gradient. */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute -top-24 -left-20 w-[420px] h-[420px] rounded-full bg-brand-soft blur-3xl opacity-80" />
        <div className="absolute -bottom-28 -right-24 w-[460px] h-[460px] rounded-full bg-brand-tint blur-3xl opacity-50" />
      </div>
      <div className="relative flex flex-col items-center gap-5 animate-[splashIn_700ms_ease-out]">
        <img
          src="/logo.png"
          alt="Stayvia"
          className="w-56 h-56 sm:w-64 sm:h-64 object-contain"
        />
        <div className="text-center leading-tight">
          <div className="text-ink text-2xl font-semibold tracking-tight">Stayvia</div>
          <div className="text-gold text-[11px] font-bold tracking-[0.25em] uppercase mt-1">Hotel OS</div>
        </div>
      </div>
      <style>{`
        @keyframes splashIn {
          0% { opacity: 0; transform: translateY(8px) scale(0.96); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
