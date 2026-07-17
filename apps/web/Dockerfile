# syntax=docker/dockerfile:1.7

# ----------------------------------------------------------------------------
# Stage 1 — build the Vite bundle
# ----------------------------------------------------------------------------
# Build-time env vars are baked into the bundle. Pass them with:
#   docker build --build-arg VITE_API_URL=... --build-arg VITE_SUPABASE_URL=... \
#                --build-arg VITE_SUPABASE_ANON_KEY=... -f apps/web/Dockerfile .
# ----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

WORKDIR /repo

ARG VITE_API_URL
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_UI_PREVIEW=false

ENV VITE_API_URL=$VITE_API_URL \
    VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_UI_PREVIEW=$VITE_UI_PREVIEW

COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

RUN --mount=type=cache,target=/root/.npm \
    npm install --workspaces --include-workspace-root

COPY tsconfig.base.json* ./
COPY packages/shared packages/shared
COPY apps/web apps/web

RUN npm run build --workspace=@hoteldesk/shared --if-present \
 && npm run build:web --workspace=@hoteldesk/web

# ----------------------------------------------------------------------------
# Stage 2 — serve with nginx
# ----------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# SPA-friendly nginx config: history fallback to index.html, gzip on, cache
# hashed assets aggressively, no-cache index.html so deploys land instantly.
RUN rm /etc/nginx/conf.d/default.conf
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
