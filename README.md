# 🍼 Baby Name Leaderboard

A real-time baby shower name voting app with a beautiful TV display, mobile voting page, and admin panel.

## Features

- 📺 **TV display** — split pink/blue leaderboard, live vote counts, QR code, voter activity ticker
- 📱 **Mobile voter page** — suggest names or vote for existing ones, approval voting style (one vote per name per device)
- 🔒 **Admin panel** — approve/reject names, control leaderboard count, view full vote log, export CSV, reset data
- ✨ **Live updates** — Server-Sent Events push changes instantly to all connected screens
- 🎉 **Confetti** — fires when a new name takes the #1 spot
- 💾 **Persistent data** — NeDB flat-file database survives container restarts
- 🛡️ **Soft abuse prevention** — browser fingerprinting warns if someone tries to vote twice under a different name

## Quick Start (local)

```bash
npm install
node server.js
```

Then open:
- **TV Display:** http://localhost:3000/
- **Voter Page:** http://localhost:3000/vote
- **Admin Panel:** http://localhost:3000/admin-babyshower2026

## Configuration

Copy `.env.example` to `.env` and edit:

```bash
cp .env.example .env
```

| Variable       | Default                        | Description                                      |
|----------------|--------------------------------|--------------------------------------------------|
| `BASE_URL`     | `https://baby.yourdomain.com`  | Public URL used for QR code generation           |
| `ADMIN_SECRET` | `babyshower2026`               | Secret path segment for the admin panel          |
| `DATA_PATH`    | `./data`                       | Host path for database files (Docker only)       |

**Change `ADMIN_SECRET` before deploying.** Your admin URL will be `/admin-<ADMIN_SECRET>`.

## Docker / TrueNAS Deployment

### 1. Build image via GitHub Actions

Push to `main` — GitHub Actions automatically builds and pushes to `ghcr.io/YOUR_USERNAME/babynames:latest`.

### 2. Create data directory on TrueNAS

```bash
mkdir -p /mnt/bubba/80_Apps/babynames/data
chown -R 1000:1000 /mnt/bubba/80_Apps/babynames/data
```

### 3. Deploy via Arcane GUI

Paste the contents of `compose.yaml` into the Docker Compose field. In the `.env` panel set:

```
BASE_URL=https://baby.yourdomain.com
ADMIN_SECRET=yourSecretHere
```

### 4. NGINX Proxy Manager

Add a proxy host pointing to `babynames:3000`. The container must be on the same Docker network (`tunnel_net`) as your NPM instance.

**Critical for live updates (SSE):** In NPM's advanced config for this host, add:
```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 86400s;
```

### 5. Update the running container

After pushing changes to GitHub, in Arcane click **Redeploy** (or stop → start) to pull the new image.

## Admin Panel

Visit: `https://baby.yourdomain.com/admin-babyshower2026`

- 📊 Live stats (total votes, girl/boy breakdown, unique voters, pending count)
- ⚙️ Settings: toggle name moderation, set leaderboard count (1–10)
- ⏳ Pending queue: approve or reject submitted names when moderation is on
- 📋 Full leaderboard with per-name delete
- 🗳️ Complete vote log with voter names, filterable by gender
- 📥 Export all data as CSV
- 🗑️ Reset everything (with confirmation)

## How Voting Works

- Guests scan the QR code on the TV display
- They enter their first name and last initial (shown to parents in admin, not publicly)
- They can suggest new names or vote for existing ones
- Each device gets one vote per name (approval voting — you can vote for as many names as you like)
- Tapping a voted name removes the vote
- If moderation is enabled, new suggestions go to a pending queue for admin approval first

## Data Storage

All data lives in `./data/`:
- `names.db` — submitted names and vote counts
- `votes.db` — individual vote records (device ID, voter name, timestamp)
- `settings.db` — leaderboard count and moderation toggle

These are plain-text JSON files. Back them up before resetting.
