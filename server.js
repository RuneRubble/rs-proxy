// server.js
const express = require('express');
const fetch = require('node-fetch'); // v2 (CommonJS)
const mongoose = require('mongoose');
const path = require('path');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(express.json());

// --- Static (optional, safe to leave) ---
app.use(express.static(path.join(__dirname)));

// --- Mongo ---
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
  console.error('FATAL: MONGO_URI is not set in environment.');
}
mongoose.connect(mongoURI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// --- Schema ---
const userTrackerSchema = new mongoose.Schema({
  username: { type: String, index: true, unique: true, sparse: true },
  displayName: String,
  statsHistory: [{
    timestamp: { type: Date, default: Date.now },
    stats: { type: Object }
  }],
  drops: [{
    itemName: String,
    count: { type: Number, default: 1 },
    timestamps: [Date]
  }],
  ironmanType: Number, // 0 normal, 1 ironman, 2 hardcore, 3 group
  deleted: { type: Boolean, default: false },
  lastUpdated: { type: Date, default: Date.now }
});

const UserTracker = mongoose.model('UserTracker', userTrackerSchema);

// --- CORS (wide open for Netlify frontend) ---
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*'); // tighten later if you want
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Hiscores: determine ironman type (best-effort) ---
async function getIronmanType(username) {
  const enc = encodeURIComponent(username);
  try {
    let res = await fetch(`https://secure.runescape.com/m=hiscore_hardcore_ironman/index_lite.ws?player=${enc}`);
    if (res.ok) return 2; // Hardcore
    res = await fetch(`https://secure.runescape.com/m=hiscore_ironman/index_lite.ws?player=${enc}`);
    if (res.ok) return 1; // Ironman
    res = await fetch(`https://secure.runescape.com/m=hiscore_group_ironman/index_lite.ws?player=${enc}`);
    if (res.ok) return 3; // Group
    return 0;
  } catch {
    return 0;
  }
}

// --- Core updater: pulls RuneMetrics and appends snapshot ---
async function updateUser(username) {
  const enc = encodeURIComponent(username);
  try {
    let user = await UserTracker.findOne({ username: username.toLowerCase() });
    if (!user) user = new UserTracker({ username: username.toLowerCase() });
    if (user.deleted) user.deleted = false;

    // RuneMetrics Profile
    const rm = await fetch(`https://apps.runescape.com/runemetrics/profile/profile?user=${enc}&activities=20`, {
      redirect: 'follow',
      timeout: 15000
    });
    if (!rm.ok) {
      const text = await rm.text();
      throw new Error(`RuneMetrics ${rm.status}: ${text.slice(0,200)}`);
    }
    const data = await rm.json();
    if (data.error || !data.name) {
      throw new Error(`RuneMetrics error: ${data.error || 'invalid profile'}`);
    }

    user.displayName = data.name;

    // Append snapshot
    user.statsHistory.push({
      timestamp: new Date(),
      stats: data
    });

    // Try to mark ironman type (non-fatal)
    user.ironmanType = await getIronmanType(username);

    // Parse recent “I found …” drops
    if (Array.isArray(data.activities)) {
      for (const activity of data.activities) {
        if (!activity || !activity.text || !activity.date) continue;
        if (activity.text.includes('I found')) {
          const m = activity.text.match(/I found (an?|some) (.+)/);
          if (m) {
            const itemName = m[2].trim();
            const ts = new Date(activity.date);
            let drop = user.drops.find(d => d.itemName === itemName);
            if (drop) {
              if (!drop.timestamps.some(t => t.getTime() === ts.getTime())) {
                drop.count += 1;
                drop.timestamps.push(ts);
              }
            } else {
              user.drops.push({ itemName, count: 1, timestamps: [ts] });
            }
          }
        }
      }
    }

    user.lastUpdated = new Date();
    await user.save();
    return user;
  } catch (e) {
    console.error(`updateUser(${username}) failed: ${e.message}`);
    throw e; // rethrow so API returns 4xx/5xx with a useful message
  }
}

// --- Public routes ---
app.get('/api/runemetrics/:username', async (req, res) => {
  try {
    const enc = encodeURIComponent(req.params.username);
    const r = await fetch(`https://apps.runescape.com/runemetrics/profile/profile?user=${enc}&activities=20`);
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json(j);
    res.json(j);
  } catch (e) {
    res.status(500).json({ error: `Runemetrics proxy failed: ${e.message}` });
  }
});

app.get('/api/chronotes', async (_req, res) => {
  try {
    const r = await fetch('https://prices.runescape.wiki/api/v1/osrs/latest?id=23903');
    const j = await r.json();
    res.json(j);
  } catch (e) {
    res.status(500).json({ error: `Chronotes fetch failed: ${e.message}` });
  }
});

app.get('/api/item/:id', async (req, res) => {
  try {
    const r = await fetch(`https://secure.runescape.com/m=itemdb_rs/api/catalogue/detail.json?item=${req.params.id}`);
    if (!r.ok) return res.status(r.status).json({ error: `ItemDB ${r.status}` });
    const j = await r.json();
    res.json(j);
  } catch (e) {
    res.status(500).json({ error: `Item fetch failed: ${e.message}` });
  }
});

// --- Tracker APIs ---
app.post('/api/track-user', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    if (!username) return res.status(400).json({ error: 'username is required' });
    const user = await updateUser(username);
    res.json({ message: 'User tracked', data: { username: user.username, displayName: user.displayName, lastUpdated: user.lastUpdated } });
  } catch (e) {
    // show real cause to the client:
    res.status(502).json({ error: e.message || 'track-user failed' });
  }
});

app.get('/api/user/:username', async (req, res) => {
  try {
    let user = await UserTracker.findOne({ username: req.params.username.toLowerCase() });
    if (!user || user.deleted) {
      // auto-create if needed
      user = await updateUser(req.params.username);
    }
    res.json(user);
  } catch (e) {
    res.status(404).json({ error: e.message || 'user not found' });
  }
});

app.get('/api/users', async (_req, res) => {
  try {
    const users = await UserTracker.find({ deleted: { $ne: true } }, 'username displayName');
    res.json(users.map(u => ({ username: u.username, displayName: u.displayName || u.username })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/snapshots/:username', async (req, res) => {
  try {
    const user = await UserTracker.findOne({ username: req.params.username.toLowerCase() }, 'statsHistory');
    if (!user) return res.status(404).json({ error: 'user not found' });
    const sorted = [...user.statsHistory].sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json(sorted);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/user/:username', async (req, res) => {
  try {
    const r = await UserTracker.updateOne({ username: req.params.username.toLowerCase() }, { $set: { deleted: true } });
    res.json({ ok: true, modified: r.modifiedCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Auto-update cron: every 3 hours at minute 0 (UTC) ---
const UPDATE_DELAY_MS = 1000; // throttle between users
cron.schedule('0 */3 * * *', async () => {
  try {
    console.log('[cron] starting auto-update');
    const activeUsers = await UserTracker.find({ deleted: { $ne: true } }, 'username');
    for (const u of activeUsers) {
      try {
        await updateUser(u.username);
      } catch (e) {
        console.error(`[cron] ${u.username} failed: ${e.message}`);
      }
      await delay(UPDATE_DELAY_MS);
    }
    console.log('[cron] done');
  } catch (e) {
    console.error('[cron] outer error:', e.message);
  }
}, { timezone: 'UTC' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));
