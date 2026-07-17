interface LoaderProps {
  label?: string;
  size?: "sm" | "md" | "lg";
  fullscreen?: boolean;
}

const dims = {
  sm: { logo: "w-8 h-8", ring: "w-12 h-12", gap: "gap-2", text: "text-xs" },
  md: { logo: "w-14 h-14", ring: "w-20 h-20", gap: "gap-3", text: "text-sm" },
  lg: { logo: "w-20 h-20", ring: "w-28 h-28", gap: "gap-4", text: "text-base" },
};

export function Loader({ label, size = "md", fullscreen = false }: LoaderProps) {
  const d = dims[size];

  const spinner = (
    <div
      className={`flex flex-col items-center ${d.gap}`}
      role="status"
      aria-label={label ?? "Loading"}
    >
      <div className={`relative grid place-items-center ${d.ring}`}>
        <div
          className="absolute inset-0 rounded-full border-2 border-brand/20 border-t-brand"
          style={{ animation: "loader-spin-cw 1.2s cubic-bezier(0.5, 0.1, 0.5, 0.9) infinite" }}
        />
        <div
          className={`relative ${d.logo} grid place-items-center rounded-full bg-white shadow-sm ring-1 ring-brand/15`}
          style={{ animation: "loader-pulse 1.6s ease-in-out infinite" }}
        >
          <img src="/logo.jpg" alt="" className="w-full h-full object-contain p-1 rounded-full" />
        </div>
      </div>
      {label && (
        <div className={`${d.text} font-medium loader-shimmer-text tracking-wide`}>{label}</div>
      )}
    </div>
  );

  if (fullscreen) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-bg/70 backdrop-blur-sm z-50">
        {spinner}
      </div>
    );
  }

  return <div className="flex items-center justify-center min-h-[50vh] w-full flex-1">{spinner}</div>;
}
