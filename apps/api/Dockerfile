# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/sdk/package.json ./packages/sdk/

RUN npm ci --workspace=apps/api --workspace=packages/sdk --ignore-scripts

# Copy source
COPY packages/sdk ./packages/sdk
COPY apps/api ./apps/api

# Build SDK then API
RUN npm run build -w packages/sdk
RUN npm run build -w apps/api

# ── Runner ────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
RUN addgroup -S tariffshield && adduser -S tariffshield -G tariffshield
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/

USER tariffshield
EXPOSE 3002
ENV NODE_ENV=production

CMD ["node", "apps/api/dist/index.js"]
