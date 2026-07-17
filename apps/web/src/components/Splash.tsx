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
      className={`fixed inset-0 z-[9999] grid place-items-center bg-brand-dark transition-opacity duration-500 ${
        leaving ? "opacity-0" : "opacity-100"
      }`}
      aria-hidden={leaving}
    >
      <div className="absolute inset-0 opacity-[0.18] [background:radial-gradient(circle_at_18%_15%,#3ecf8e_0,transparent_45%),radial-gradient(circle_at_82%_85%,#24b47e_0,transparent_55%)]" />
      <div className="relative flex flex-col items-center gap-5 animate-[splashIn_700ms_ease-out]">
        <img
          src="/logo.jpg"
          alt="Stayvia"
          className="w-56 h-56 sm:w-64 sm:h-64 rounded-2xl object-contain bg-cream shadow-2xl ring-1 ring-brass/30"
        />
        <div className="text-center leading-tight">
          <div className="text-cream text-2xl font-semibold">Stayvia</div>
          <div className="text-brass text-[11px] tracking-[0.25em] uppercase mt-1">Hotel OS</div>
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
