FROM node:24-alpine AS base
WORKDIR /app

# Dependencies stage (all deps for build)
FROM base AS deps
COPY package*.json ./
RUN npm ci

# Production dependencies only (omit optional to exclude prisma CLI and its deps like hono)
FROM base AS deps-prod
COPY package*.json ./
RUN npm ci --omit=dev --omit=optional

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
RUN printf '\nself.__BESEDY_WEB_VERSION = "%s";\n' "$WEB_VERSION" >> public/sw.js \
    && npm run build

# Production target
FROM base AS production
ENV NODE_ENV=production

# Version tracking (passed from build stage)
ARG GIT_COMMIT=unknown
ARG WEB_VERSION=unknown
ARG BUILD_TIME
ENV GIT_COMMIT=${GIT_COMMIT}
ENV WEB_VERSION=${WEB_VERSION}
ENV BUILD_TIME=${BUILD_TIME}

# Refresh Alpine packages even when the local Node base image is stale, and
# remove npm from the runtime image because production never invokes it.
RUN apk upgrade --no-cache \
    && addgroup -g 1001 -S nodejs \
    && adduser -S nextjs -u 1001 \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=deps-prod /app/node_modules ./node_modules
COPY docker-entrypoint.sh ./

# Set ownership and permissions
RUN chmod +x docker-entrypoint.sh && chown -R nextjs:nodejs /app

# Switch to non-root user
USER nextjs

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
