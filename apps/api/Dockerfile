# syntax=docker/dockerfile:1.7

# ----------------------------------------------------------------------------
# Stage 1 — builder
# ----------------------------------------------------------------------------
# Compiles TypeScript to dist/. Uses the full workspace because the API
# imports from @hoteldesk/shared, which lives in packages/shared.
# ----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

WORKDIR /repo

# We skip the Chromium download here — the runtime stage installs Debian's
# chromium package and we point Puppeteer at it via PUPPETEER_EXECUTABLE_PATH.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    NODE_ENV=development

COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/

RUN --mount=type=cache,target=/root/.npm \
    npm install --workspaces --include-workspace-root

COPY tsconfig.base.json* ./
COPY packages/shared packages/shared
COPY apps/api apps/api

RUN npm run build --workspace=@hoteldesk/shared --if-present \
 && npm run build --workspace=@hoteldesk/api

# Prune dev deps so the runtime image only carries production node_modules.
RUN npm prune --workspaces --omit=dev

# ----------------------------------------------------------------------------
# Stage 2 — runtime
# ----------------------------------------------------------------------------
# Slim Debian + Chromium + its fonts. We deliberately do NOT use Alpine —
# Puppeteer/Chromium and Sharp's libvips are both fiddly on musl.
# ----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

# Chromium + the minimum font/lib set Puppeteer needs to render PDFs.
# fonts-noto-color-emoji covers ₹, currency glyphs, emojis on receipts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      fonts-noto \
      fonts-noto-color-emoji \
      libnss3 \
      libatk-bridge2.0-0 \
      libdrm2 \
      libgbm1 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libasound2 \
      tini \
 && rm -rf /var/lib/apt/lists/*

# Run as a non-root user. Chromium's sandbox requires either root (bad) or
# specific kernel caps; we drop --no-sandbox in pdf.ts already, so this user
# is fine. Docker will need --cap-add=SYS_ADMIN OR --security-opt seccomp=...
# only if you re-enable Chromium's sandbox.
RUN groupadd --system app && useradd --system --gid app --create-home app

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Copy compiled output + production node_modules from the builder.
# Order: package manifests first (cache-friendly), then code.
COPY --from=builder --chown=app:app /repo/node_modules ./node_modules
COPY --from=builder --chown=app:app /repo/packages/shared ./packages/shared
COPY --from=builder --chown=app:app /repo/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=app:app /repo/apps/api/package.json ./apps/api/package.json
COPY --from=builder --chown=app:app /repo/apps/api/migrations ./apps/api/migrations
COPY --from=builder --chown=app:app /repo/apps/api/scripts ./apps/api/scripts

USER app
EXPOSE 3000

# tini handles PID 1 signal forwarding so SIGTERM actually reaches Node and
# our graceful shutdown handler (closeBrowser) gets a chance to run.
ENTRYPOINT ["/usr/bin/tini", "--"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3000) +'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/index.js"]
