// Printable QR modal. Renders the target URL as a QR with the hotel/room
// caption, plus Print and Download (PNG). Used by the Rooms page (per-room
// sticker) and Settings (hotel master QR). The token URL is permanent, so a
// printed sticker never needs reprinting.
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { X } from "@/lib/micons";

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
      <style>body{font-family:sans-serif;text-align:center;padding:32px}
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
      className="fixed inset-0 z-50 bg-black/50 grid place-items-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-md shadow-xl w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="font-semibold text-navy">{title}</div>
            {subtitle && <div className="text-xs text-textSecondary mt-0.5">{subtitle}</div>}
          </div>
          <button className="text-textSecondary hover:text-navy" onClick={onClose}>
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="grid place-items-center bg-white rounded-sm p-3">
          <canvas ref={canvasRef} />
        </div>
        <div className="text-[11px] text-textSecondary text-center mt-2 break-all">{url}</div>
        <div className="flex gap-2 mt-4">
          <button className="btn-primary flex-1" onClick={printQr}>
            Print
          </button>
          <a
            className="btn-secondary flex-1 inline-flex items-center justify-center"
            href={dataUrl}
            download={`${title.replace(/\s+/g, "-").toLowerCase()}-qr.png`}
          >
            Download PNG
          </a>
        </div>
      </div>
    </div>
  );
}
