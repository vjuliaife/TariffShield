# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/sdk/package.json ./packages/sdk/

RUN npm ci --workspace=apps/web --workspace=packages/sdk --ignore-scripts

COPY packages/sdk ./packages/sdk
COPY apps/web ./apps/web

RUN npm run build -w packages/sdk

# Next.js standalone output
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w apps/web

# ── Runner ────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
RUN addgroup -S tariffshield && adduser -S tariffshield -G tariffshield
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

USER tariffshield
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "apps/web/server.js"]
