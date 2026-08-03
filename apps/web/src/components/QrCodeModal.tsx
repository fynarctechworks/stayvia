// Printable QR modal. Renders the target URL as a QR with the hotel/room
// caption, plus Print and Download (PNG). Used by the Rooms page (per-room
// sticker) and Settings (hotel master QR). The token URL is permanent, so a
// printed sticker never needs reprinting.
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, X } from "@/lib/micons";

interface Props {
  open: boolean;
  onClose: () => void;
  url: string;
  title: string;
  subtitle?: string;
}

export default function QrCodeModal({ open, onClose, url, title, subtitle }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dataUrl, setDataUrl] = useState("");
  const [copied, setCopied] = useState(false);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the URL is still selectable as text */
    }
  }

  useEffect(() => {
    if (!open || !url) return;
    QRCode.toCanvas(canvasRef.current, url, { width: 260, margin: 2 }, () => {
      setDataUrl(canvasRef.current?.toDataURL("image/png") ?? "");
    });
  }, [open, url]);

  if (!open) return null;

  function printQr() {
    const w = window.open("", "_blank", "width=420,height=560");
    if (!w) return;
    w.document.write(`<!doctype html><html><head><title>${title}</title>
      <style>@page{size:A4 portrait;margin:12mm}body{font-family:sans-serif;text-align:center;padding:32px}
      h1{font-size:20px;margin:0 0 4px}p{color:#555;margin:0 0 20px;font-size:13px}
      img{width:260px;height:260px}</style></head><body>
      <h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ""}
      <img src="${dataUrl}" alt="QR code" />
      <p>Scan with your phone camera</p>
      <script>window.onload=()=>setTimeout(()=>window.print(),150)</script>
      </body></html>`);
    w.document.close();
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-inkDark/50 backdrop-blur-[3px] grid place-items-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-[18px] shadow-modal w-full max-w-sm overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-divider">
          <div className="text-sm font-semibold text-ink">{title}</div>
          <button
            className="w-[34px] h-[34px] shrink-0 grid place-items-center rounded-[9px] border border-borderControl bg-surface text-textSecondary hover:text-ink"
            onClick={onClose}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 flex flex-col items-center text-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-brand-soft text-brand-deep grid place-items-center font-bold text-[28px]">
            S
          </div>
          {subtitle && <div className="text-[13px] text-inkMuted">{subtitle}</div>}
          <div className="p-3 border border-divider rounded-xl bg-surface">
            <canvas ref={canvasRef} />
          </div>
          <button
            onClick={copyUrl}
            title="Copy link"
            className="w-full flex items-center gap-2 rounded-sm border border-divider bg-surfaceAlt px-2.5 py-1.5 text-left hover:border-brand transition-colors group"
          >
            <span className="flex-1 min-w-0 text-[11.5px] text-inkMuted font-mono truncate">
              {url}
            </span>
            {copied ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-deep shrink-0">
                <Check className="w-3.5 h-3.5" /> Copied
              </span>
            ) : (
              <Copy className="w-3.5 h-3.5 text-inkMuted group-hover:text-ink shrink-0" />
            )}
          </button>
          <div className="flex gap-2 w-full">
            <a
              className="btn-secondary flex-1 inline-flex items-center justify-center"
              href={dataUrl}
              download={`${title.replace(/\s+/g, "-").toLowerCase()}-qr.png`}
            >
              Download PNG
            </a>
            <button className="btn-primary flex-1" onClick={printQr}>
              Print
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
