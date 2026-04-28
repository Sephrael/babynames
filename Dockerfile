FROM node:20-alpine

# Install build tools needed for native modules (none currently, but good practice)
RUN apk add --no-cache dumb-init

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY server.js ./
COPY public ./public

# Data directory (will be bind-mounted in production)
RUN mkdir -p /app/data

# Run as non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3000

# dumb-init handles signal forwarding properly (graceful shutdown)
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
