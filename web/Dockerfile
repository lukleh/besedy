# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS base
WORKDIR /app

# Dependencies stage (all deps for build)
FROM base AS deps
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci

# Production dependencies only (omit optional to exclude prisma CLI and its deps like hono)
FROM base AS deps-prod
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --omit=dev --omit=optional

# Development target
FROM base AS development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev", "--", "--hostname", "0.0.0.0"]

# Build stage
FROM deps AS builder
COPY . .
# Dummy DATABASE_URL for Next.js build (not actually connected)
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
# Dummy auth secret for build-time checks (real secret injected at runtime)
ENV AUTH_SECRET="build-time-only-dummy-secret"
# No dummy VAPID keys needed at build: they are read lazily at runtime
# (lib/notifications/push.ts), and real keys come from the env file at runtime.
# Build args for client-side env vars (embedded in JS bundle)
ARG NEXT_PUBLIC_APP_ENV=production
ENV NEXT_PUBLIC_APP_ENV=${NEXT_PUBLIC_APP_ENV}
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY
ENV NEXT_PUBLIC_VAPID_PUBLIC_KEY=${NEXT_PUBLIC_VAPID_PUBLIC_KEY}
ARG NEXT_PUBLIC_SUPPORT_EMAIL
ENV NEXT_PUBLIC_SUPPORT_EMAIL=${NEXT_PUBLIC_SUPPORT_EMAIL}
ARG NEXT_PUBLIC_SUPPORT_EMAIL_B64
ENV NEXT_PUBLIC_SUPPORT_EMAIL_B64=${NEXT_PUBLIC_SUPPORT_EMAIL_B64}
ARG OAUTH_MOCK_URL
ENV OAUTH_MOCK_URL=${OAUTH_MOCK_URL}
# Web-tree version for client update tracking. The repository commit remains a
# separate runtime diagnostic and does not alter browser assets.
ARG WEB_VERSION=unknown
ENV NEXT_PUBLIC_WEB_VERSION=${WEB_VERSION}
# Service-worker updates are byte-compared by browsers. Stamp it only when the
# tracked web application changes, not for unrelated repository commits.
RUN --mount=type=cache,target=/app/.next/cache,sharing=locked \
    node -e 'require("node:fs").appendFileSync("public/sw.js", `\nself.__BESEDY_WEB_VERSION = ${JSON.stringify(process.argv[1])};\n`)' "$WEB_VERSION" \
    && npm run build

# Production target
FROM base AS production
ENV NODE_ENV=production

# Create the runtime user and remove npm because production never invokes it.
RUN addgroup -g 1001 -S nodejs \
    && adduser -S nextjs -u 1001 \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

COPY --chown=nextjs:nodejs --from=builder /app/.next/standalone ./
COPY --chown=nextjs:nodejs --from=builder /app/.next/static ./.next/static
COPY --chown=nextjs:nodejs --from=builder /app/public ./public
COPY --chown=nextjs:nodejs --from=builder /app/prisma ./prisma
COPY --chown=nextjs:nodejs --from=deps-prod /app/node_modules ./node_modules
COPY --chown=nextjs:nodejs --chmod=755 docker-entrypoint.sh ./

# Refresh Alpine packages on every deployment even when the Node base image is
# unchanged. Keeping this after application copies lets those layers stay cached.
ARG BUILD_TIME
RUN echo "Refreshing Alpine packages (${BUILD_TIME:-unknown})" \
    && apk upgrade --no-cache

# Version tracking changes on every deployment, so keep it after the reusable
# filesystem layers.
ARG GIT_COMMIT=unknown
ARG WEB_VERSION=unknown
ENV GIT_COMMIT=${GIT_COMMIT}
ENV WEB_VERSION=${WEB_VERSION}
ENV BUILD_TIME=${BUILD_TIME}

# Switch to non-root user
USER nextjs

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
