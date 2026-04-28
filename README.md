# 🍼 Baby Name Leaderboard

A beautiful, real-time baby shower name voting app with:
- 📺 TV display page (leaderboard + QR code)
- 📱 Mobile voter page (scan QR to suggest names or vote)
- 🔒 Secret admin panel (view all votes, delete names, export CSV, reset)
- ✨ Live real-time updates via Server-Sent Events
- 🎉 Confetti when #1 name changes
- 💾 Persistent data (survives restarts)

---

## 🚀 Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Start the server
node server.js
```

Then open:
- **TV Display:**  http://localhost:3000/
- **Voter Page:**  http://localhost:3000/vote
- **Admin Panel:** http://localhost:3000/admin-babyshower2025

---

## ⚙️ Configuration (Environment Variables)

Create a `.env` file (optional) or set these before running:

| Variable       | Default               | Description                          |
|----------------|-----------------------|--------------------------------------|
| `PORT`         | `3000`                | Port to run on                       |
| `BASE_URL`     | `http://localhost:3000` | Public URL for QR code generation   |
| `ADMIN_SECRET` | `babyshower2025`      | Secret path segment for admin panel  |

Example with custom values:
```bash
PORT=3000 BASE_URL=https://baby.vijaymanne.com ADMIN_SECRET=mySuperSecret node server.js
```

Or use dotenv — install with `npm install dotenv` and add `require('dotenv').config()` at top of server.js.

---

## 🌐 TrueNAS / NGINX Deployment Guide

### Step 1: Copy files to your TrueNAS server

```bash
# From your local machine, copy the project folder:
scp -r ./babynames user@YOUR_TRUENAS_IP:/mnt/tank/apps/babynames

# Or use your TrueNAS web UI to upload the folder
```

### Step 2: Install Node.js on TrueNAS (if not already)

TrueNAS Scale (Linux-based):
```bash
# In TrueNAS shell or SSH:
apt-get install -y nodejs npm   # or use their app catalog for Node
```

Alternatively, run it in a **TrueNAS Jails** (TrueNAS Core) or a **Docker container** (see below).

### Step 3: Run with PM2 (process manager — keeps it alive)

```bash
npm install -g pm2
cd /mnt/tank/apps/babynames
pm2 start server.js --name babynames -- --env PORT=3000 BASE_URL=https://baby.vijaymanne.com
pm2 save
pm2 startup   # auto-start on reboot
```

### Step 4: NGINX reverse proxy config

In your TrueNAS NGINX instance, add a new server block or location:

```nginx
server {
    listen 80;
    server_name baby.vijaymanne.com;

    # Redirect HTTP → HTTPS (Cloudflare handles the cert)
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name baby.vijaymanne.com;

    # If you're using Cloudflare "Full (Strict)" mode with an origin cert:
    ssl_certificate     /path/to/origin-cert.pem;
    ssl_certificate_key /path/to/origin-key.pem;

    # SSE needs buffering disabled and long timeouts
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    keepalive_timeout 86400s;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Important for SSE (live updates):** The `proxy_buffering off` and long timeout settings are critical so the live leaderboard updates work through the proxy.

### Step 5: Cloudflare DNS

1. In your Cloudflare dashboard, add an **A record**:
   - Name: `baby` (or whatever subdomain you want)
   - IP: Your home/TrueNAS public IP
   - Proxy: ✅ Enabled (orange cloud)

2. Set SSL/TLS mode to **Full** or **Full (Strict)**

3. (Optional) Add a Page Rule to disable caching for `/api/*`

### Step 6: Set BASE_URL and restart

```bash
pm2 stop babynames
BASE_URL=https://baby.vijaymanne.com pm2 start server.js --name babynames
# OR update your pm2 ecosystem config
```

The QR code on the TV will now point to your public URL — anyone on the internet can scan and vote!

---

## 🐳 Docker Option (Alternative)

Create `Dockerfile`:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN mkdir -p data
EXPOSE 3000
CMD ["node", "server.js"]
```

Run:
```bash
docker build -t babynames .
docker run -d \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -e BASE_URL=https://baby.vijaymanne.com \
  -e ADMIN_SECRET=yourSecret \
  --name babynames \
  babynames
```

---

## 📱 How Guests Use It

1. Guest scans QR code shown on the TV
2. Opens **baby.vijaymanne.com/vote** on their phone
3. Can **suggest a new name** (automatically casts their vote for it)
4. Can **vote for existing names** — one vote per name per device
5. Can **unvote** by tapping again
6. See live vote counts update in real time

---

## 🔒 Admin Panel

Visit: `https://baby.vijaymanne.com/admin-babyshower2025`

Features:
- 📊 Live stats (total votes, girl/boy breakdown, unique voters)
- 📋 Full leaderboards with delete buttons
- 🗳️ Complete vote log (who voted for what, when, from which device)
- 🔍 Filter votes by gender
- 📥 Export all data as CSV
- 🗑️ Reset everything (with confirmation)

---

## 📁 Data Storage

All data lives in `./data/`:
- `names.db` — all submitted names and vote counts
- `votes.db` — all individual vote records (device ID + name + timestamp)

These are plain text JSON files. Back them up if you want!
