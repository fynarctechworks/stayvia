import sharp from "sharp";
import { writeFileSync } from "node:fs";

async function enc(path, width) {
  const buf = await sharp(path).resize({ width, withoutEnlargement: true }).png({ compressionLevel: 9, palette: true }).toBuffer();
  return { uri: `data:image/png;base64,${buf.toString("base64")}`, bytes: buf.length };
}

const stayvia = await enc("apps/web/public/logo.png", 160);
const fyn = await enc("apps/web/public/fyn-arc-logo.png", 96);
console.log("stayvia", stayvia.bytes, "fyn", fyn.bytes);

const out = `// AUTO-GENERATED brand assets, inlined as data URIs.
//
// Printed documents must render identically on the VPS (headless Chromium
// with no network access to our own web origin) and offline, so the two
// marks that appear on every document are embedded rather than fetched:
//   - Stayvia: fallback hotel mark when a property has not uploaded a logo.
//   - FYN ARC: the "Powered by" credit in the document footer.
// Regenerate by re-running the script in scripts/ if the artwork changes.

export const STAYVIA_LOGO_DATA_URI =
  "${stayvia.uri}";

export const FYN_ARC_LOGO_DATA_URI =
  "${fyn.uri}";
`;
writeFileSync("apps/api/src/lib/brandAssets.ts", out);
console.log("written", out.length, "chars");
