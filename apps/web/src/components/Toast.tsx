import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

type ToastVariant = "success" | "error" | "info";
interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
}

interface Ctx {
  toast: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<Ctx | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const toast = useCallback((message: string, variant: ToastVariant = "info") => {
    const id = String(++counter.current);
    setToasts((t) => [...t, { id, message, variant }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-[20rem] max-w-[90vw]">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onClose={() => setToasts((s) => s.filter((x) => x.id !== t.id))} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const Icon = toast.variant === "success" ? CheckCircle2 : toast.variant === "error" ? AlertCircle : Info;
  const color =
    toast.variant === "success"
      ? "border-success/40 bg-success/5 text-success"
      : toast.variant === "error"
        ? "border-danger/40 bg-danger/5 text-danger"
        : "border-brand/30 bg-brand-soft text-brand-dark";
  return (
    <div className={`flex items-start gap-2 px-3 py-2.5 rounded-md border shadow-md bg-surface ${color}`}>
      <Icon className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="text-sm flex-1">{toast.message}</div>
      <button onClick={onClose} className="opacity-60 hover:opacity-100">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}

export function useNotificationToasts(unreadIds: string[] | undefined) {
  const { toast } = useToast();
  const seen = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!unreadIds) return;
    if (seen.current.size === 0) {
      // first load: just record without firing toasts
      unreadIds.forEach((id) => seen.current.add(id));
      return;
    }
    for (const id of unreadIds) {
      if (!seen.current.has(id)) {
        seen.current.add(id);
        toast("New notification", "info");
      }
    }
  }, [unreadIds, toast]);
}
