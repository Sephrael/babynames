require('dotenv').config(); // Load .env file before anything else
const express = require('express');
const path = require('path');
const QRCode = require('qrcode');
const Datastore = require('nedb-promises');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'babyshower2025';

// ─── Databases ────────────────────────────────────────────────────────────────
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
const namesDb    = Datastore.create({ filename: './data/names.db',    autoload: true });
const votesDb    = Datastore.create({ filename: './data/votes.db',    autoload: true });
const settingsDb = Datastore.create({ filename: './data/settings.db', autoload: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Settings helpers ─────────────────────────────────────────────────────────
async function getSettings() {
  let s = await settingsDb.findOne({ _id: 'settings' });
  if (!s) {
    s = { _id: 'settings', moderationEnabled: false, leaderboardCount: 5 };
    await settingsDb.insert(s);
  }
  return s;
}

async function saveSettings(patch) {
  await settingsDb.update({ _id: 'settings' }, { $set: patch }, { upsert: true });
  return getSettings();
}

// ─── SSE: Live updates ────────────────────────────────────────────────────────
const clients = new Set();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');
  const hb = setInterval(() => res.write('event: heartbeat\ndata: {}\n\n'), 25000);
  clients.add(res);
  req.on('close', () => { clearInterval(hb); clients.delete(res); });
});

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(c => { try { c.write(msg); } catch { clients.delete(c); } });
}

// ─── API: Public settings (safe subset) ──────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  const s = await getSettings();
  res.json({ leaderboardCount: s.leaderboardCount, moderationEnabled: s.moderationEnabled });
});

// ─── API: Get approved names (public) ────────────────────────────────────────
app.get('/api/names', async (req, res) => {
  try {
    // Always return only approved names to the public
    const names = await namesDb.find({ approved: true }).sort({ votes: -1 });
    res.json(names);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Submit a new name ───────────────────────────────────────────────────
app.post('/api/names', async (req, res) => {
  const { name, gender } = req.body;
  if (!name || !gender || !['boy', 'girl'].includes(gender)) {
    return res.status(400).json({ error: 'Name and gender (boy/girl) required' });
  }
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 40) {
    return res.status(400).json({ error: 'Name must be 1–40 characters' });
  }

  // Check duplicate across all names (approved or not)
  const existing = await namesDb.findOne({ nameLower: trimmed.toLowerCase(), gender });
  if (existing) {
    // If it exists but is pending, tell the user
    if (!existing.approved) {
      return res.status(202).json({ pending: true, id: existing._id, message: 'Name is awaiting approval' });
    }
    return res.status(409).json({ error: 'Name already exists', id: existing._id });
  }

  const settings = await getSettings();
  const approved = !settings.moderationEnabled; // auto-approve when moderation is off

  const doc = await namesDb.insert({
    name: trimmed,
    nameLower: trimmed.toLowerCase(),
    gender,
    votes: 0,
    approved,
    createdAt: new Date()
  });

  if (approved) broadcast('update', { ts: Date.now() });
  else broadcast('pending', { ts: Date.now() }); // signals admin panel to refresh

  res.status(approved ? 200 : 202).json({ ...doc, pending: !approved });
});

// ─── API: Vote for a name ─────────────────────────────────────────────────────
app.post('/api/vote', async (req, res) => {
  const { nameId, deviceId, voterName } = req.body;
  if (!nameId || !deviceId) return res.status(400).json({ error: 'nameId and deviceId required' });

  const nameDoc = await namesDb.findOne({ _id: nameId, approved: true });
  if (!nameDoc) return res.status(404).json({ error: 'Name not found or not approved' });

  if (await votesDb.findOne({ nameId, deviceId })) {
    return res.status(409).json({ error: 'Already voted for this name' });
  }

  await votesDb.insert({ nameId, nameName: nameDoc.name, nameGender: nameDoc.gender, deviceId, voterName: voterName || null, votedAt: new Date() });
  await namesDb.update({ _id: nameId }, { $inc: { votes: 1 } });
  const updated = await namesDb.findOne({ _id: nameId });

  broadcast('update', { ts: Date.now() });
  res.json({ success: true, votes: updated.votes });
});

// ─── API: Unvote ──────────────────────────────────────────────────────────────
app.delete('/api/vote', async (req, res) => {
  const { nameId, deviceId } = req.body;
  if (!nameId || !deviceId) return res.status(400).json({ error: 'nameId and deviceId required' });

  if (!await votesDb.findOne({ nameId, deviceId })) return res.status(404).json({ error: 'Vote not found' });

  await votesDb.remove({ nameId, deviceId });
  await namesDb.update({ _id: nameId }, { $inc: { votes: -1 } });
  const updated = await namesDb.findOne({ _id: nameId });

  broadcast('update', { ts: Date.now() });
  res.json({ success: true, votes: Math.max(0, updated.votes) });
});

// ─── API: Get voted name IDs for a device ────────────────────────────────────
app.get('/api/votes/:deviceId', async (req, res) => {
  const votes = await votesDb.find({ deviceId: req.params.deviceId });
  res.json(votes.map(v => v.nameId));
});

// ─── API: QR code ─────────────────────────────────────────────────────────────
app.get('/api/qr', async (req, res) => {
  try {
    const url = `${BASE_URL}/vote`;
    const qr = await QRCode.toDataURL(url, { width: 400, margin: 2, color: { dark: '#4a4a6a', light: '#ffffff00' } });
    res.json({ qr, url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN APIs
// ═══════════════════════════════════════════════════════════════════════════════

// ─── ADMIN: Get all votes ─────────────────────────────────────────────────────
app.get(`/api/admin/${ADMIN_SECRET}/votes`, async (req, res) => {
  res.json(await votesDb.find({}).sort({ votedAt: -1 }));
});

// ─── ADMIN: Get ALL names (including pending) ─────────────────────────────────
app.get(`/api/admin/${ADMIN_SECRET}/names`, async (req, res) => {
  res.json(await namesDb.find({}).sort({ createdAt: -1 }));
});

// ─── ADMIN: Get pending names only ───────────────────────────────────────────
app.get(`/api/admin/${ADMIN_SECRET}/pending`, async (req, res) => {
  res.json(await namesDb.find({ approved: false }).sort({ createdAt: -1 }));
});

// ─── ADMIN: Approve a name ────────────────────────────────────────────────────
app.post(`/api/admin/${ADMIN_SECRET}/names/:id/approve`, async (req, res) => {
  const doc = await namesDb.findOne({ _id: req.params.id });
  if (!doc) return res.status(404).json({ error: 'Name not found' });
  await namesDb.update({ _id: req.params.id }, { $set: { approved: true } });
  broadcast('update', { ts: Date.now() });
  res.json({ success: true });
});

// ─── ADMIN: Reject (delete) a pending name ───────────────────────────────────
app.delete(`/api/admin/${ADMIN_SECRET}/names/:id`, async (req, res) => {
  await namesDb.remove({ _id: req.params.id });
  await votesDb.remove({ nameId: req.params.id }, { multi: true });
  broadcast('update', { ts: Date.now() });
  res.json({ success: true });
});

// ─── ADMIN: Get settings ──────────────────────────────────────────────────────
app.get(`/api/admin/${ADMIN_SECRET}/settings`, async (req, res) => {
  res.json(await getSettings());
});

// ─── ADMIN: Update settings ───────────────────────────────────────────────────
app.post(`/api/admin/${ADMIN_SECRET}/settings`, async (req, res) => {
  const { moderationEnabled, leaderboardCount } = req.body;
  const patch = {};
  if (typeof moderationEnabled === 'boolean') patch.moderationEnabled = moderationEnabled;
  if (typeof leaderboardCount === 'number' && leaderboardCount >= 1 && leaderboardCount <= 10) patch.leaderboardCount = leaderboardCount;
  const updated = await saveSettings(patch);
  broadcast('settings', { leaderboardCount: updated.leaderboardCount, moderationEnabled: updated.moderationEnabled });
  res.json(updated);
});

// ─── ADMIN: Reset everything ──────────────────────────────────────────────────
app.post(`/api/admin/${ADMIN_SECRET}/reset`, async (req, res) => {
  await namesDb.remove({}, { multi: true });
  await votesDb.remove({}, { multi: true });
  broadcast('update', { ts: Date.now() });
  res.json({ success: true });
});

// ─── ADMIN: Export CSV ────────────────────────────────────────────────────────
app.get(`/api/admin/${ADMIN_SECRET}/export`, async (req, res) => {
  const votes = await votesDb.find({}).sort({ votedAt: 1 });
  let csv = 'Voter Name,Baby Name,Gender,Device ID,Voted At\n';
  votes.forEach(v => {
    csv += `"${v.voterName||'Anonymous'}","${v.nameName}","${v.nameGender}","${v.deviceId}","${new Date(v.votedAt).toISOString()}"\n`;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="baby-name-votes.csv"');
  res.send(csv);
});

// ─── Page routes ──────────────────────────────────────────────────────────────
app.get('/',                         (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));
app.get('/vote',                     (req, res) => res.sendFile(path.join(__dirname, 'public', 'vote.html')));
app.get(`/admin-${ADMIN_SECRET}`,    (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🍼 Baby Name Leaderboard running!`);
  console.log(`   Display (TV):  ${BASE_URL}/`);
  console.log(`   Voter page:    ${BASE_URL}/vote`);
  console.log(`   Admin page:    ${BASE_URL}/admin-${ADMIN_SECRET}`);
  console.log(`\n   Port: ${PORT}`);
});
