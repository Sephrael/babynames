require('dotenv').config();

const express   = require('express');
const path      = require('path');
const QRCode    = require('qrcode');
const Datastore = require('nedb-promises');
const fs        = require('fs');

const app          = express();
const PORT         = process.env.PORT         || 3000;
const BASE_URL     = process.env.BASE_URL     || 'http://localhost:3000';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'babyshower2026';

// ─── Databases ────────────────────────────────────────────────────────────────
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
const namesDb    = Datastore.create({ filename: './data/names.db',    autoload: true });
const votesDb    = Datastore.create({ filename: './data/votes.db',    autoload: true });
const settingsDb = Datastore.create({ filename: './data/settings.db', autoload: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Settings helpers ─────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  _id: 'settings',
  moderationEnabled: false,
  leaderboardCount:  5,
  tickerCount:       20,
  tickerTemplate:    '{gender_emoji} {voter} → {name}',
  tickerSpeed:       'normal',
  theme:             'sage',
  themePageBg:       '#C5D1B8',
  themeCardBg:       '#A8B898',
  themeAccent:       '#9CAF88',
};

async function getSettings() {
  let s = await settingsDb.findOne({ _id: 'settings' });
  if (!s) { s = { ...DEFAULT_SETTINGS }; await settingsDb.insert(s); }
  let dirty = false;
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (s[k] === undefined) { s[k] = v; dirty = true; }
  }
  if (dirty) await settingsDb.update({ _id: 'settings' }, { $set: s });
  return s;
}

async function saveSettings(patch) {
  await settingsDb.update({ _id: 'settings' }, { $set: patch }, { upsert: true });
  return getSettings();
}

// ─── SSE ──────────────────────────────────────────────────────────────────────
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

// ─── Voter name disambiguation ────────────────────────────────────────────────
// If "Priya M." already exists on a DIFFERENT device, return "Priya M-2.",
// "Priya M-3.", etc. Same device always keeps the same name.
async function resolveVoterName(rawName, deviceId) {
  if (!rawName) return null;
  // Find all existing votes that used this base name
  const existing = await votesDb.find({ voterName: new RegExp('^' + escapeRegex(rawName.replace(/\.$/, '')) + '(-\\d+)?\\.?$') });
  // Filter to unique device→name pairs
  const deviceNames = {};
  existing.forEach(v => { if (v.deviceId) deviceNames[v.deviceId] = v.voterName; });

  // If this device already has a stored name variant, use it
  if (deviceNames[deviceId]) return deviceNames[deviceId];

  // If no one else has used this name, use it as-is
  const othersUsing = Object.entries(deviceNames).filter(([did]) => did !== deviceId);
  if (othersUsing.length === 0) return rawName;

  // Find next available suffix
  const usedNames = new Set(Object.values(deviceNames));
  const baseName = rawName.replace(/\.$/, ''); // strip trailing dot for suffix building
  let suffix = 2;
  while (true) {
    const candidate = baseName.replace(/(-\d+)?$/, '') + `-${suffix}.`;
    if (!usedNames.has(candidate)) return candidate;
    suffix++;
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Public: settings ─────────────────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  const s = await getSettings();
  res.json({
    leaderboardCount: s.leaderboardCount, moderationEnabled: s.moderationEnabled,
    tickerCount: s.tickerCount, tickerTemplate: s.tickerTemplate, tickerSpeed: s.tickerSpeed,
    theme: s.theme, themePageBg: s.themePageBg, themeCardBg: s.themeCardBg, themeAccent: s.themeAccent,
  });
});

// ─── Public: approved names ───────────────────────────────────────────────────
app.get('/api/names', async (req, res) => {
  try { res.json(await namesDb.find({ approved: true }).sort({ votes: -1 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Public: recent votes for ticker ─────────────────────────────────────────
// Only show 'vote' actions (not unvotes) in the ticker
app.get('/api/recent-votes', async (req, res) => {
  try {
    const s     = await getSettings();
    const limit = Math.min(parseInt(req.query.limit) || s.tickerCount, 50);
    const votes = await votesDb.find({ action: 'vote' }).sort({ votedAt: -1 });
    res.json(votes.slice(0, limit).map(v => ({ voterName: v.voterName || 'A Guest', nameName: v.nameName, nameGender: v.nameGender, votedAt: v.votedAt })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Public: submit name ──────────────────────────────────────────────────────
app.post('/api/names', async (req, res) => {
  const { name, gender, voterName, deviceId } = req.body;
  if (!name || !gender || !['boy', 'girl'].includes(gender))
    return res.status(400).json({ error: 'Name and gender (boy/girl) required' });
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 40)
    return res.status(400).json({ error: 'Name must be 1–40 characters' });
  const existing = await namesDb.findOne({ nameLower: trimmed.toLowerCase(), gender });
  if (existing) {
    if (!existing.approved) return res.status(202).json({ pending: true, id: existing._id, message: 'Name is awaiting approval' });
    return res.status(409).json({ error: 'Name already exists', id: existing._id });
  }
  const settings = await getSettings();
  const approved = !settings.moderationEnabled;
  // Resolve the submitter's display name (handles disambiguation)
  const resolvedSubmitter = deviceId ? await resolveVoterName(voterName, deviceId) : (voterName || null);
  const doc = await namesDb.insert({
    name: trimmed, nameLower: trimmed.toLowerCase(), gender, votes: 0, approved,
    submittedBy: resolvedSubmitter, submittedByDeviceId: deviceId || null,
    createdAt: new Date()
  });
  // Log the nomination in the activity log
  await votesDb.insert({
    action: 'nominate', nameId: doc._id, nameName: trimmed, nameGender: gender,
    voterName: resolvedSubmitter || 'Anonymous', deviceId: deviceId || 'unknown',
    votedAt: new Date()
  });
  if (approved) broadcast('update', { ts: Date.now() });
  else          broadcast('pending', { ts: Date.now() });
  res.status(approved ? 200 : 202).json({ ...doc, pending: !approved });
});

// ─── Public: vote ─────────────────────────────────────────────────────────────
app.post('/api/vote', async (req, res) => {
  const { nameId, deviceId, voterName } = req.body;
  if (!nameId || !deviceId) return res.status(400).json({ error: 'nameId and deviceId required' });

  const nameDoc = await namesDb.findOne({ _id: nameId, approved: true });
  if (!nameDoc) return res.status(404).json({ error: 'Name not found or not approved' });

  // Resolve disambiguated voter name FIRST
  const resolvedName = await resolveVoterName(voterName, deviceId);

  // Check if this specific user on this device already has an active vote for this name
  const existingVote = await votesDb.findOne({ nameId, deviceId, voterName: resolvedName, action: 'vote' });
  if (existingVote) return res.status(409).json({ error: 'Already voted for this name' });

  // Record vote action in history
  await votesDb.insert({
    nameId, nameName: nameDoc.name, nameGender: nameDoc.gender,
    deviceId, voterName: resolvedName,
    action: 'vote', votedAt: new Date()
  });

  await namesDb.update({ _id: nameId }, { $inc: { votes: 1 } });
  const updated = await namesDb.findOne({ _id: nameId });

  broadcast('update', { ts: Date.now() });
  res.json({ success: true, votes: updated.votes, resolvedVoterName: resolvedName });
});

// ─── Public: unvote ───────────────────────────────────────────────────────────
// Keeps the vote record, adds an 'unvote' history entry instead of deleting
app.delete('/api/vote', async (req, res) => {
  const { nameId, deviceId, voterName } = req.body;
  if (!nameId || !deviceId) return res.status(400).json({ error: 'nameId and deviceId required' });

  const resolvedName = await resolveVoterName(voterName, deviceId);
  const existingVote = await votesDb.findOne({ nameId, deviceId, voterName: resolvedName, action: 'vote' });
  if (!existingVote) return res.status(404).json({ error: 'Vote not found' });

  // Mark the original vote as removed
  await votesDb.update({ _id: existingVote._id }, { $set: { action: 'unvote', removedAt: new Date() } });

  // Add a separate unvote history record
  await votesDb.insert({
    nameId, nameName: existingVote.nameName, nameGender: existingVote.nameGender,
    deviceId, voterName: existingVote.voterName,
    action: 'unvote', votedAt: new Date()
  });

  await namesDb.update({ _id: nameId }, { $inc: { votes: -1 } });
  const updated = await namesDb.findOne({ _id: nameId });

  broadcast('update', { ts: Date.now() });
  res.json({ success: true, votes: Math.max(0, updated.votes) });
});

// ─── Public: active votes for a device and user ─────────────────────────────
app.get('/api/votes/:deviceId', async (req, res) => {
  // Only return nameIds with an active 'vote' action (not unvoted) for this specific user
  const { voterName } = req.query;
  const resolvedName = voterName ? await resolveVoterName(voterName, req.params.deviceId) : null;
  const query = { deviceId: req.params.deviceId, action: 'vote' };
  if (resolvedName) query.voterName = resolvedName;
  const votes = await votesDb.find(query);
  res.json(votes.map(v => v.nameId));
});

// ─── Public: gender prediction ──────────────────────────────────────────────
app.post('/api/gender-vote', async (req, res) => {
  const { gender, deviceId, voterName } = req.body;
  if (!gender || !deviceId) return res.status(400).json({ error: 'gender and deviceId required' });

  const resolvedName = await resolveVoterName(voterName, deviceId);
  const existingVote = await votesDb.findOne({ deviceId, voterName: resolvedName, action: 'gender_vote' });

  if (existingVote && existingVote.gender === gender) return res.json({ success: true });

  if (existingVote) {
    await votesDb.update({ _id: existingVote._id }, { $set: { action: 'gender_unvote', removedAt: new Date() } });
    await votesDb.insert({ gender: existingVote.gender, deviceId, voterName: resolvedName, action: 'gender_unvote', votedAt: new Date() });
  }

  await votesDb.insert({
    gender, deviceId, voterName: resolvedName,
    action: 'gender_vote', votedAt: new Date()
  });

  broadcast('update', { ts: Date.now() });
  res.json({ success: true, resolvedVoterName: resolvedName });
});

app.delete('/api/gender-vote', async (req, res) => {
  const { deviceId, voterName } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const resolvedName = await resolveVoterName(voterName, deviceId);
  const existingVote = await votesDb.findOne({ deviceId, voterName: resolvedName, action: 'gender_vote' });

  if (existingVote) {
    await votesDb.update({ _id: existingVote._id }, { $set: { action: 'gender_unvote', removedAt: new Date() } });
    await votesDb.insert({ gender: existingVote.gender, deviceId, voterName: resolvedName, action: 'gender_unvote', votedAt: new Date() });
    broadcast('update', { ts: Date.now() });
  }

  res.json({ success: true });
});

app.get('/api/gender-votes', async (req, res) => {
  const votes = await votesDb.find({ action: 'gender_vote' });
  let boy = 0, girl = 0;
  for (const v of votes) {
    if (v.gender === 'boy') boy++;
    else if (v.gender === 'girl') girl++;
  }
  res.json({ boy, girl });
});

app.get('/api/my-gender-vote/:deviceId', async (req, res) => {
  const { voterName } = req.query;
  const resolvedName = voterName ? await resolveVoterName(voterName, req.params.deviceId) : null;
  const query = { deviceId: req.params.deviceId, action: 'gender_vote' };
  if (resolvedName) query.voterName = resolvedName;
  const vote = await votesDb.findOne(query);
  res.json({ gender: vote ? vote.gender : null });
});


// ─── Public: QR code ──────────────────────────────────────────────────────────
app.get('/api/qr', async (req, res) => {
  try {
    const url = `${BASE_URL}/vote`;
    const qr  = await QRCode.toDataURL(url, { width: 400, margin: 2, color: { dark: '#4a4a6a', light: '#ffffff00' } });
    res.json({ qr, url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════
// ADMIN APIs
// ═══════════════════════════════════════════════════════

// All vote history (including unvotes), most recent first
app.get(`/api/admin/${ADMIN_SECRET}/votes`, async (req, res) => {
  res.json(await votesDb.find({}).sort({ votedAt: -1 }));
});

app.get(`/api/admin/${ADMIN_SECRET}/names`,    async (req, res) => res.json(await namesDb.find({}).sort({ createdAt: -1 })));
app.get(`/api/admin/${ADMIN_SECRET}/pending`,  async (req, res) => res.json(await namesDb.find({ approved: false }).sort({ createdAt: -1 })));
app.get(`/api/admin/${ADMIN_SECRET}/settings`, async (req, res) => res.json(await getSettings()));

app.post(`/api/admin/${ADMIN_SECRET}/names/:id/approve`, async (req, res) => {
  const doc = await namesDb.findOne({ _id: req.params.id });
  if (!doc) return res.status(404).json({ error: 'Name not found' });
  await namesDb.update({ _id: req.params.id }, { $set: { approved: true } });
  broadcast('update', { ts: Date.now() });
  res.json({ success: true });
});

app.delete(`/api/admin/${ADMIN_SECRET}/names/:id`, async (req, res) => {
  await namesDb.remove({ _id: req.params.id });
  await votesDb.remove({ nameId: req.params.id }, { multi: true });
  broadcast('update', { ts: Date.now() });
  res.json({ success: true });
});

app.post(`/api/admin/${ADMIN_SECRET}/settings`, async (req, res) => {
  const { moderationEnabled, leaderboardCount, tickerCount, tickerTemplate, tickerSpeed, theme, themePageBg, themeCardBg, themeAccent } = req.body;
  const patch = {};
  if (typeof moderationEnabled === 'boolean') patch.moderationEnabled = moderationEnabled;
  if (typeof leaderboardCount  === 'number' && leaderboardCount  >= 1  && leaderboardCount  <= 10) patch.leaderboardCount  = leaderboardCount;
  if (typeof tickerCount       === 'number' && tickerCount       >= 5  && tickerCount       <= 50) patch.tickerCount       = tickerCount;
  if (typeof tickerTemplate    === 'string' && tickerTemplate.length   <= 200)                     patch.tickerTemplate    = tickerTemplate.trim();
  if (['slow','normal','fast'].includes(tickerSpeed))                                               patch.tickerSpeed       = tickerSpeed;
  if (['classic','sage','custom'].includes(theme))                                                  patch.theme             = theme;
  if (typeof themePageBg === 'string' && /^#[0-9a-fA-F]{6}$/.test(themePageBg))                     patch.themePageBg       = themePageBg;
  if (typeof themeCardBg === 'string' && /^#[0-9a-fA-F]{6}$/.test(themeCardBg))                     patch.themeCardBg       = themeCardBg;
  if (typeof themeAccent === 'string' && /^#[0-9a-fA-F]{6}$/.test(themeAccent))                     patch.themeAccent       = themeAccent;
  const updated = await saveSettings(patch);
  broadcast('settings', {
    leaderboardCount: updated.leaderboardCount, moderationEnabled: updated.moderationEnabled,
    tickerCount: updated.tickerCount, tickerTemplate: updated.tickerTemplate, tickerSpeed: updated.tickerSpeed,
    theme: updated.theme, themePageBg: updated.themePageBg, themeCardBg: updated.themeCardBg, themeAccent: updated.themeAccent,
  });
  res.json(updated);
});

app.post(`/api/admin/${ADMIN_SECRET}/reset`, async (req, res) => {
  await namesDb.remove({}, { multi: true });
  await votesDb.remove({}, { multi: true });
  broadcast('update', { ts: Date.now() });
  res.json({ success: true });
});

app.get(`/api/admin/${ADMIN_SECRET}/export`, async (req, res) => {
  const names = await namesDb.find({}).sort({ createdAt: 1 });
  const votes = await votesDb.find({}).sort({ votedAt: 1 });
  // Build a lookup of name ID → submitter
  const nameMap = {};
  names.forEach(n => { nameMap[n._id] = n; });
  let csv = 'Action,Voter Name,Baby Name,Gender,Nominated By,Device ID,Time\n';
  votes.forEach(v => {
    const isGenderVote = v.action === 'gender_vote' || v.action === 'gender_unvote';
    const nom = nameMap[v.nameId];
    const nominatedBy = nom && nom.submittedBy ? nom.submittedBy : '';
    const targetName = isGenderVote ? 'Gender Prediction' : (v.nameName || '');
    const targetGender = isGenderVote ? v.gender : (v.nameGender || '');
    
    csv += `"${v.action||'vote'}","${v.voterName||'Anonymous'}","${targetName}","${targetGender}","${nominatedBy}","${v.deviceId}","${new Date(v.votedAt).toISOString()}"\n`;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="baby-name-votes.csv"');
  res.send(csv);
});

// ─── Page routes ──────────────────────────────────────────────────────────────
app.get('/',                      (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));
app.get('/vote',                  (req, res) => res.sendFile(path.join(__dirname, 'public', 'vote.html')));
app.get(`/admin-${ADMIN_SECRET}`, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🍼 Baby Ballot Box running!`);
  console.log(`   Display (TV):  ${BASE_URL}/`);
  console.log(`   Voter page:    ${BASE_URL}/vote`);
  console.log(`   Admin page:    ${BASE_URL}/admin-${ADMIN_SECRET}`);
  console.log(`\n   Port: ${PORT}`);
});
