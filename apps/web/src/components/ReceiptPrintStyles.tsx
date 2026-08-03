// Shared print stylesheet for the check-in / edit receipt modals.
//
// Both render the same markup contract (.print-portal > .checkin-receipt >
// .receipt-body, with .no-print chrome), so they must print identically:
// one A4 portrait page, every other element on the page removed, brand
// backgrounds preserved. This lived inline in CheckInReceiptModal only,
// which meant EditReceiptModal printed the whole app page at the
// browser's default paper size.
export function ReceiptPrintStyles() {
  return (
    <style>{`
        @media print {
          /* Zero @page margin so Chrome's auto-generated headers (date,
             page title) and footers (URL, page count) have no margin
             strip to render into. We then provide visual margin inside
             the receipt via padding so the content still breathes. */
          @page {
            size: A4 portrait;
            margin: 0;
          }
          html, body {
            margin: 0 !important;
            padding: 0 !important;
            background: #fff !important;
            height: auto !important;
            min-height: 0 !important;
            overflow: hidden !important;
          }
          /* True single-page print strategy: hide every element on the
             page EXCEPT the receipt and its ancestor chain. We use
             :has() (Chrome 105+) so the chain from body down to
             .checkin-receipt stays in layout while every sibling is
             removed. visibility:hidden is not enough -- hidden elements
             still reserve height and paginate into blank pages.
             display:none removes the layout box entirely. */
          body *:not(:has(.checkin-receipt)):not(.checkin-receipt):not(.checkin-receipt *) {
            display: none !important;
          }

          /* Collapse modal wrapper so it doesn't reserve page space */
          .print-portal {
            position: static !important;
            display: block !important;
            inset: auto !important;
            padding: 0 !important;
            margin: 0 !important;
            background: transparent !important;
            height: auto !important;
            min-height: 0 !important;
            overflow: hidden !important;
          }

          /* Pull receipt to the page origin. Hard-cap dimensions at A4
             and use border-box so the internal padding is included in the
             width — otherwise width (210mm) + padding (24mm) = 234mm and
             Chrome shoves overflow onto extra pages. */
          .checkin-receipt {
            box-sizing: border-box !important;
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            width: 210mm !important;
            max-width: 210mm !important;
            min-height: 0 !important;
            height: 296mm !important;
            max-height: 296mm !important;
            margin: 0 !important;
            padding: 12mm !important;
            box-shadow: none !important;
            border: none !important;
            border-radius: 0 !important;
            background: #fff !important;
            overflow: hidden !important;
            page-break-after: avoid !important;
            page-break-inside: avoid !important;
            break-after: avoid !important;
            break-inside: avoid !important;
          }
          /* Also box-size every descendant inside the receipt so child
             paddings don't cause horizontal overflow either. */
          .checkin-receipt * {
            box-sizing: border-box !important;
          }
          /* Keep brand backgrounds (dark Amount Received panel, brass
             accents) in the fallback window.print() path — Chrome strips
             background colors by default unless the user ticks
             "Background graphics". The server-PDF path is unaffected. */
          .checkin-receipt, .checkin-receipt * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          .checkin-receipt > .receipt-body {
            padding: 0 !important;
            font-size: 10.5px !important;
            line-height: 1.35 !important;
          }
          /* Trim large vertical spacings */
          .receipt-body .mt-6 { margin-top: 16px !important; }
          .receipt-body .mt-5 { margin-top: 12px !important; }
          .receipt-body .mt-4 { margin-top: 10px !important; }
          .receipt-body .mt-3 { margin-top: 8px !important; }
          .receipt-body .pt-3 { padding-top: 8px !important; }
          .receipt-body .py-3 { padding-top: 6px !important; padding-bottom: 6px !important; }
          .receipt-body .py-2\\.5 { padding-top: 4px !important; padding-bottom: 4px !important; }
          .receipt-body .p-2\\.5 { padding: 6px !important; }
          .receipt-body .p-3 { padding: 8px !important; }
          .receipt-body .p-4 { padding: 10px !important; }
          .receipt-body .p-6 { padding: 0 !important; }

          .no-print, .no-print * { display: none !important; }
          .receipt-body table { page-break-inside: avoid; break-inside: avoid; }
          .receipt-body .receipt-section { page-break-inside: avoid; break-inside: avoid; }
        }
        /* Watermark layering (print only): section content must paint
           above the faint watermark layer. Kept for the print layer
           below; on-screen has no watermark. */
        .receipt-body .receipt-section { position: relative; z-index: 1; }
        .receipt-body > div:not(.receipt-section) { position: relative; z-index: 1; }
`}</style>
  );
}
