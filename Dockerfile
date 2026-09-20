# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv

# Stage 1: Build the client assets
FROM node:24-bookworm-slim AS builder

WORKDIR /app

# Install dependencies first for layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Copy source files needed for build
COPY . .

# Optional build arguments if client-side keys need to be baked into the bundle
ARG GOOGLE_MAPS_API_KEY
ARG CESIUM_ION_TOKEN
ENV GOOGLE_MAPS_API_KEY=$GOOGLE_MAPS_API_KEY \
    CESIUM_ION_TOKEN=$CESIUM_ION_TOKEN

RUN npm run build

# Stage 2: Production runtime image
FROM node:24-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built frontend assets from builder stage
COPY --from=builder /app/dist ./dist

# Copy backend server files, configs, scripts and required runtime source modules
COPY server/ ./server/
COPY src/ ./src/
COPY config/ ./config/
COPY scripts/ ./scripts/

# Ensure cache directory exists and non-root user has write permissions
RUN mkdir -p /app/.gev-cache && chown -R node:node /app

USER node

EXPOSE 8080

# Built-in health check against the standalone server /healthz endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "server/standalone/server.js"]
