import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, Info, X } from "@/lib/micons";

type Tone = "default" | "danger" | "warning" | "success";

interface AlertOptions {
  title?: string;
  message: ReactNode;
  okLabel?: string;
  tone?: Tone;
}

interface ConfirmOptions {
  title?: string;
  message: ReactNode;
  okLabel?: string;
  cancelLabel?: string;
  tone?: Tone;
}

interface PromptOption {
  value: string;
  label: string;
}

interface PromptOptions {
  title?: string;
  message?: ReactNode;
  placeholder?: string;
  defaultValue?: string;
  okLabel?: string;
  cancelLabel?: string;
  multiline?: boolean;
  required?: boolean;
  options?: PromptOption[];
  tone?: Tone;
  inputType?: "text" | "number";
}

interface Ctx {
  alert: (opts: AlertOptions) => Promise<void>;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

const DialogContext = createContext<Ctx | null>(null);

interface DialogState {
  id: number;
  kind: "alert" | "confirm" | "prompt";
  opts: AlertOptions | ConfirmOptions | PromptOptions;
  resolve: (v: unknown) => void;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<DialogState[]>([]);
  const counter = useRef(0);

  const push = useCallback(<T,>(kind: DialogState["kind"], opts: AlertOptions | ConfirmOptions | PromptOptions) => {
    return new Promise<T>((resolve) => {
      const id = ++counter.current;
      setStack((s) => [...s, { id, kind, opts, resolve: resolve as (v: unknown) => void }]);
    });
  }, []);

  const close = useCallback((id: number, value: unknown) => {
    setStack((s) => {
      const item = s.find((d) => d.id === id);
      if (item) item.resolve(value);
      return s.filter((d) => d.id !== id);
    });
  }, []);

  const ctx: Ctx = {
    alert: (opts) => push<void>("alert", opts),
    confirm: (opts) => push<boolean>("confirm", opts),
    prompt: (opts) => push<string | null>("prompt", opts),
  };

  return (
    <DialogContext.Provider value={ctx}>
      {children}
      {stack.map((d) => (
        <DialogShell key={d.id} state={d} onClose={(v) => close(d.id, v)} />
      ))}
    </DialogContext.Provider>
  );
}

function toneClasses(tone: Tone | undefined) {
  switch (tone) {
    case "danger":
      return {
        icon: "text-danger",
        btn: "bg-danger text-white border-danger hover:opacity-90",
      };
    case "warning":
      return {
        icon: "text-warning",
        btn: "bg-warning text-white border-warning hover:opacity-90",
      };
    case "success":
      return {
        icon: "text-success",
        btn: "bg-success text-white border-success hover:opacity-90",
      };
    default:
      return {
        icon: "text-brand",
        btn: "bg-brand-dark text-cream border-brand-dark hover:opacity-90",
      };
  }
}

function DialogShell({ state, onClose }: { state: DialogState; onClose: (v: unknown) => void }) {
  const { kind, opts } = state;
  const tone = (opts as { tone?: Tone }).tone;
  const cls = toneClasses(tone);

  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);
  const promptOpts = kind === "prompt" ? (opts as PromptOptions) : null;
  const [value, setValue] = useState(promptOpts?.defaultValue ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Enter" && kind !== "prompt") {
        e.preventDefault();
        confirm();
      } else if (e.key === "Enter" && kind === "prompt" && !(e.target as HTMLElement)?.matches("textarea")) {
        e.preventDefault();
        confirm();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function cancel() {
    if (kind === "alert") onClose(undefined);
    else if (kind === "confirm") onClose(false);
    else onClose(null);
  }

  function confirm() {
    if (kind === "alert") {
      onClose(undefined);
      return;
    }
    if (kind === "confirm") {
      onClose(true);
      return;
    }
    const v = value.trim();
    if (promptOpts?.required && !v) {
      setError("Required");
      return;
    }
    if (promptOpts?.options && promptOpts.options.length > 0) {
      const ok = promptOpts.options.some((o) => o.value === v);
      if (!ok) {
        setError("Pick one");
        return;
      }
    }
    onClose(v || null);
  }

  const Icon = tone === "danger" || tone === "warning" ? AlertTriangle : Info;

  return (
    <div
      className="fixed inset-0 z-[200] grid place-items-center bg-brand-dark/40 p-4 animate-in fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div className="w-full max-w-md bg-surface rounded-md shadow-xl border border-borderc">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-borderc">
          <div className="flex items-start gap-3">
            <div className={`mt-0.5 ${cls.icon}`}>
              <Icon className="w-5 h-5" />
            </div>
            <div>
              <div className="font-semibold text-textPrimary">
                {opts.title ?? (kind === "confirm" ? "Confirm" : kind === "prompt" ? "Enter value" : "Notice")}
              </div>
              {(opts as AlertOptions).message && (
                <div className="text-sm text-textSecondary mt-1">{(opts as AlertOptions).message}</div>
              )}
            </div>
          </div>
          <button
            onClick={cancel}
            className="text-textSecondary hover:text-textPrimary shrink-0"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {kind === "prompt" && promptOpts && (
          <div className="px-5 py-4 space-y-2">
            {promptOpts.options && promptOpts.options.length > 0 ? (
              <div className="grid grid-cols-2 gap-2">
                {promptOpts.options.map((o) => {
                  const active = value === o.value;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => {
                        setValue(o.value);
                        setError(null);
                      }}
                      className={`px-3 py-2.5 rounded-sm text-sm font-semibold border-2 transition-colors ${
                        active
                          ? "border-brand-dark bg-brand-soft text-brand-dark"
                          : "border-borderc text-textSecondary hover:border-brand-dark"
                      }`}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </div>
            ) : promptOpts.multiline ? (
              <textarea
                ref={(el) => {
                  inputRef.current = el;
                }}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
                placeholder={promptOpts.placeholder}
                rows={3}
                className="w-full border border-borderc bg-surface rounded-sm px-3 py-2 text-textPrimary outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20 placeholder:text-textSecondary resize-none leading-relaxed"
              />
            ) : (
              <input
                ref={(el) => {
                  inputRef.current = el;
                }}
                type={promptOpts.inputType ?? "text"}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
                placeholder={promptOpts.placeholder}
                className="input w-full"
              />
            )}
            {error && <div className="text-xs text-danger">{error}</div>}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-borderc bg-bg/50">
          {kind !== "alert" && (
            <button
              onClick={cancel}
              className="px-4 h-9 text-sm font-semibold rounded-sm border-2 border-borderc text-textSecondary hover:border-textSecondary hover:text-textPrimary transition-colors"
            >
              {(opts as ConfirmOptions).cancelLabel ?? "Cancel"}
            </button>
          )}
          <button
            onClick={confirm}
            className={`px-4 h-9 text-sm font-semibold rounded-sm border-2 transition-colors ${cls.btn}`}
          >
            {(opts as ConfirmOptions).okLabel ?? (kind === "alert" ? "OK" : kind === "confirm" ? "Confirm" : "Save")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used inside DialogProvider");
  return ctx;
}
