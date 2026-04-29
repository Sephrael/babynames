# ── Base Image ────────────────────────────────────────────────────────────────
# Start from the official Node.js 20 image built on Alpine Linux.
# Alpine is a minimal Linux distro (~5MB) used for Docker because it keeps
# image sizes small. The "node" base image includes Node.js and npm pre-installed.
FROM node:20-alpine

# ── System Dependencies ───────────────────────────────────────────────────────
# apk is Alpine's package manager (like apt on Ubuntu or brew on Mac).
# dumb-init is a tiny process manager that properly handles Unix signals
# (like SIGTERM when Docker stops the container), ensuring graceful shutdown
# instead of the process being killed immediately.
RUN apk add --no-cache dumb-init

# ── Working Directory ─────────────────────────────────────────────────────────
# Set /app as the working directory inside the container.
# All subsequent commands (COPY, RUN, CMD) will run relative to this path.
WORKDIR /app

# ── Install Dependencies ──────────────────────────────────────────────────────
# Copy package.json and package-lock.json first (before the rest of the code).
# Docker builds in layers — by copying package files separately, Docker can
# cache the npm install step and skip it on rebuilds if dependencies haven't
# changed, making builds much faster.
COPY package*.json ./

# npm ci (clean install) is preferred over npm install in Docker/CI because:
# - It installs exactly what's in package-lock.json (reproducible builds)
# - It's faster
# - --omit=dev skips devDependencies since we don't need them in production
RUN npm ci --omit=dev

# ── Application Source ────────────────────────────────────────────────────────
# Copy the application files into the container.
# These are copied after npm install so that code changes don't invalidate
# the dependency cache layer above.
COPY server.js ./
COPY public ./public

# ── Data Directory ────────────────────────────────────────────────────────────
# Create the data directory that NeDB uses to store its database files.
# In production this path is bind-mounted to the TrueNAS host
# (/mnt/bubba/80_Apps/babynames/data), so data persists across container
# restarts and rebuilds. The chown sets ownership to UID:GID 1000:1000
# so our non-root user (created below) can write to it.
RUN mkdir -p /app/data && chown -R 1000:1000 /app/data

# ── Non-Root User ─────────────────────────────────────────────────────────────
# Running containers as root is a security risk — if the app is compromised,
# the attacker would have root access inside the container.
# The node:20-alpine base image ships with a built-in user called "node"
# at exactly UID 1000 and GID 1000, so we use that instead of creating
# a new user (which would get a different UID and cause permission issues
# with the bind-mounted volume on the host).
USER node

# ── Network Port ──────────────────────────────────────────────────────────────
# Document that the app listens on port 3000. This is informational only —
# it doesn't actually publish the port. Port mapping is handled in compose.yaml
# (or by nginx proxy manager via the shared tunnel_net Docker network).
EXPOSE 3000

# ── Entrypoint & Start Command ────────────────────────────────────────────────
# ENTRYPOINT sets the base executable. dumb-init wraps our process so that
# Unix signals (SIGTERM, SIGINT) are forwarded correctly to Node.js,
# allowing the app to shut down gracefully when Docker stops the container.
#
# CMD is the default argument passed to ENTRYPOINT.
# Together they run: dumb-init -- node server.js
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]