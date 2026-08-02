import { Download, ExternalLink, Loader2, Printer, X } from "@/lib/micons";
import { useEffect, useRef, useState } from "react";
import { authHeader } from "@/lib/api";

interface Props {
  open: boolean;
  url: string | null;
  title: string;
  filename: string;
  onClose: () => void;
}

export function PdfPreviewModal({ open, url, title, filename, onClose }: Props) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const lastUrl = useRef<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!open || !url) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBlobUrl(null);

    (async () => {
      try {
        // Shared auth-header helper — same Supabase session token as the
        // JSON API helpers.
        const headers = await authHeader();
        const sep = url.includes("?") ? "&" : "?";
        const res = await fetch(`${url}${sep}disposition=inline&_t=${Date.now()}`, {
          headers,
          cache: "no-store",
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          throw new Error(`Preview failed (${res.status}) ${txt.slice(0, 200)}`);
        }
        const blob = await res.blob();
        if (cancelled) return;
        const objectUrl = URL.createObjectURL(blob);
        lastUrl.current = objectUrl;
        setBlobUrl(objectUrl);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Preview failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, url]);

  useEffect(() => {
    return () => {
      if (lastUrl.current) {
        URL.revokeObjectURL(lastUrl.current);
        lastUrl.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  function download() {
    if (!blobUrl) return;
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    a.click();
  }

  function openNewTab() {
    if (!blobUrl) return;
    window.open(blobUrl, "_blank", "noopener,noreferrer");
  }

  function print() {
    if (!blobUrl) return;
    // Drive the iframe's print dialog directly — no new tab. The iframe
    // is already loaded with the same blob: PDF the user is looking at,
    // so contentWindow.print() opens the system print dialog with that
    // PDF as the target. focus() first because Chrome ignores print()
    // when the iframe doesn't have focus.
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      win.focus();
      win.print();
    } catch {
      /* swallow — Ctrl+P in the modal still works */
    }
  }

  return (
    <div
      className="fixed inset-0 z-[150] grid place-items-center bg-ink/55 backdrop-blur-[3px] p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-4xl h-[90vh] bg-cream rounded-2xl shadow-modal flex flex-col overflow-hidden">
        {/* Dark chrome bar — inkDark surface, cream text, per the spec. */}
        <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 bg-inkDark text-cream shrink-0">
          <div className="font-semibold text-sm truncate">{title}</div>
          <div className="flex items-center gap-2">
            <button
              onClick={openNewTab}
              disabled={!blobUrl}
              className="text-xs font-semibold inline-flex items-center gap-1.5 px-2.5 h-8 rounded-[9px] border border-cream/20 bg-cream/10 text-cream hover:bg-cream/20 transition-colors disabled:opacity-40"
              title="Open in new tab"
            >
              <ExternalLink className="w-3.5 h-3.5" /> New tab
            </button>
            <button
              onClick={print}
              disabled={!blobUrl}
              className="text-xs font-semibold inline-flex items-center gap-1.5 px-2.5 h-8 rounded-[9px] border border-cream/20 bg-cream/10 text-cream hover:bg-cream/20 transition-colors disabled:opacity-40"
              title="Print"
            >
              <Printer className="w-3.5 h-3.5" /> Print
            </button>
            <button
              onClick={download}
              disabled={!blobUrl}
              className="text-xs font-semibold inline-flex items-center gap-1.5 px-2.5 h-8 rounded-[9px] border border-cream/20 bg-cream/10 text-cream hover:bg-cream/20 transition-colors disabled:opacity-40"
            >
              <Download className="w-3.5 h-3.5" /> Download
            </button>
            <button
              onClick={onClose}
              className="w-8 h-8 grid place-items-center rounded-[9px] border border-cream/20 text-cream hover:bg-cream/10 transition-colors"
              title="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 bg-cream relative">
          {loading && (
            <div className="absolute inset-0 grid place-items-center text-textSecondary">
              <div className="flex items-center gap-2 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> Rendering preview…
              </div>
            </div>
          )}
          {error && !loading && (
            <div className="absolute inset-0 grid place-items-center p-6">
              <div className="max-w-md text-center text-danger text-sm">{error}</div>
            </div>
          )}
          {blobUrl && !error && (
            <div className="absolute inset-0 p-3 sm:p-5">
              <iframe
                ref={iframeRef}
                key={blobUrl}
                src={blobUrl}
                title={title}
                className="w-full h-full bg-surface rounded-sm shadow-card"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
