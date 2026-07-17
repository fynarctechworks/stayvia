// Build the offline desktop sidecar bundle: api.exe + the native assets pkg
// can't embed (sharp's @img native module, and — provided separately — the
// Puppeteer Chromium). Produces dist-desktop/sidecar/ ready to drop next to
// the Tauri app as a resource.
//
// Why external assets: pkg snapshots pure JS into api.exe, but native .node
// addons (sharp) and the Chromium binary can't live inside the snapshot. They
// sit in node_modules/@img and a chromium/ dir alongside the exe; the API
// resolves them at runtime relative to process.execPath (see the SHARP and
// PUPPETEER_EXECUTABLE_PATH wiring in the Rust sidecar handshake).
//
// Usage: node scripts/build-sidecar.mjs
//   1. builds dist (tsc)
//   2. runs pkg -> dist-desktop/sidecar/api.exe
//   3. copies node_modules/@img -> dist-desktop/sidecar/node_modules/@img
//   4. prints the Chromium step (operator provides a pinned build)

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, "..");
const repoRoot = resolve(apiRoot, "..", "..");
const outDir = resolve(repoRoot, "dist-desktop", "sidecar");

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
}

console.log("1/4  Compiling API (tsc)…");
run("npm", ["run", "build"], apiRoot);

console.log("2/4  Packaging api.exe (pkg, node22-win-x64)…");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
run(
  "npx",
  ["@yao-pkg/pkg", ".", "--targets", "node22-win-x64", "--output", resolve(outDir, "api.exe"), "--public"],
  apiRoot,
);

console.log("3/5  Copying sharp native module (@img) next to the exe…");
const imgSrc = resolve(repoRoot, "node_modules", "@img");
const imgDst = resolve(outDir, "node_modules", "@img");
if (!existsSync(imgSrc)) {
  console.error("  @img not found — run `npm install --include=optional sharp` first");
  process.exit(1);
}
mkdirSync(dirname(imgDst), { recursive: true });
cpSync(imgSrc, imgDst, { recursive: true });
// sharp's JS wrapper also needs to resolve; ship the sharp package too.
const sharpSrc = resolve(repoRoot, "node_modules", "sharp");
if (existsSync(sharpSrc)) {
  cpSync(sharpSrc, resolve(outDir, "node_modules", "sharp"), { recursive: true });
}

console.log("4/5  Staging puppeteer JS next to the exe (PDF rendering)…");
// The pkg snapshot can't hold puppeteer (dynamic requires + it was loaded via
// import(), which pkg can't trace), so pdf.ts lazy-requires it from the
// exe-adjacent node_modules via createRequire. Stage the full self-contained
// dependency closure with npm (hand-copying misses hoisted transitive deps).
// The browser download is skipped — Chromium ships separately (step 5).
const pptrVersion = "23.11.1"; // keep in lockstep with apps/api package.json
const stageDir = resolve(outDir, ".pptr-stage");
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
writeFileSync(resolve(stageDir, "package.json"), '{"name":"pptr-stage","private":true}');
execFileSync(
  "npm",
  ["install", `puppeteer@${pptrVersion}`, "--omit=dev", "--no-audit", "--no-fund"],
  {
    cwd: stageDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "1", PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: "1" },
  },
);
cpSync(resolve(stageDir, "node_modules"), resolve(outDir, "node_modules"), { recursive: true });
rmSync(stageDir, { recursive: true, force: true });

console.log("5/5  Chromium (manual step):");
console.log("  Puppeteer's Chromium can't be embedded. Ship a pinned build at");
console.log(`  ${resolve(outDir, "chromium")} and point PUPPETEER_EXECUTABLE_PATH at it`);
console.log("  (the Rust sidecar sets this via the handshake). For a quick local");
console.log("  test, copy node_modules/puppeteer/.local-chromium there.");

console.log(`\nDone. Sidecar bundle at: ${outDir}`);
