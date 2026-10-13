# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies (including devDependencies for the TypeScript compiler)
COPY package*.json ./
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output from builder
COPY --from=builder /app/build ./build

# The PORT env var is required when running in HTTP/SSE mode (Docker).
# It is set via .env / docker-compose — no default here so a missing value
# fails loudly rather than silently binding to an unexpected port.
ENV NODE_ENV=production

# Expose the port declared in .env (docker-compose maps HOST_PORT → CONTAINER_PORT)
EXPOSE ${PORT}

# Healthcheck — polls /health every 30 s, marks unhealthy after 3 consecutive
# failures.  Cloudflare Tunnel / your reverse proxy can use this too.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "build/index.js"]
