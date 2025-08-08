const express = require('express');
const fetch = require('node-fetch');
const mongoose = require('mongoose');
const path = require('path');
const cron = require('node-cron'); // Add this import
require('dotenv').config();
const app = express();
app.use(express.json());
// Serve static files from the current directory
app.use(express.static(path.join(__dirname)));
// MongoDB connection
const mongoURI = process.env.MONGO_URI;
mongoose.connect(mongoURI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));
// User Tracker Schema
const userTrackerSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, lowercase: true },
  displayName: String,
  statsHistory: [{
    timestamp: { type: Date, default: Date.now },
    stats: { type: Object } // Store full JSON from profile
  }],
  drops: [{
    itemName: String,
    count: { type: Number, default: 1 },
    timestamps: [Date]
  }],
  ironmanType: Number, // 0: normal, 1: ironman, 2: hardcore, 3: group
  deleted: { type: Boolean, default: false },
  lastUpdated: { type: Date, default: Date.now }
});
const UserTracker = mongoose.model('UserTracker', userTrackerSchema);
// Global CORS middleware (handles OPTIONS preflight)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});
// Helper to add delay
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
// Function to determine ironman type
async function getIronmanType(username) {
  try {
    let res = await fetch(`https://secure.runescape.com/m=hiscore_ironman/index_lite.ws?player=${encodeURIComponent(username)}`);
    if (res.ok) return 1; // Ironman
    res = await fetch(`https://secure.runescape.com/m=hiscore_hardcore_ironman/index_lite.ws?player=${encodeURIComponent(username)}`);
    if (res.ok) return 2; // Hardcore Ironman
    res = await fetch(`https://secure.runescape.com/m=hiscore_group_ironman/index_lite.ws?player=${encodeURIComponent(username)}`);
    if (res.ok) return 3; // Group Ironman
    return 0; // Normal
  } catch (e) {
    return 0;
  }
}
// Function to update user
async function updateUser(username) {
  try {
    let user = await UserTracker.findOne({ username: username.toLowerCase() });
    const now = Date.now();
    if (user) {
      if (user.deleted) {
        user.deleted = false;
      }
    } else {
      user = new UserTracker({ username: username.toLowerCase() });
    }
    const response = await fetch(`https://apps.runescape.com/runemetrics/profile/profile?user=${encodeURIComponent(username)}&activities=20`);
    if (!response.ok) throw new Error('API error');
    const data = await response.json();
    if (data.error || !data.name) throw new Error(data.error || 'Invalid user data');
    user.displayName = data.name;
    user.statsHistory.push({ stats: data });
    user.ironmanType = await getIronmanType(username);
    data.activities.forEach(activity => {
      if (activity.text.includes('I found')) {
        const match = activity.text.match(/I found (an?|some) (.+)/);
        if (match) {
          const itemName = match[2].trim();
          const timestamp = new Date(activity.date);
          let drop = user.drops.find(d => d.itemName === itemName);
          if (drop) {
            if (!drop.timestamps.some(ts => ts.getTime() === timestamp.getTime())) {
              drop.count += 1;
              drop.timestamps.push(timestamp);
            }
          } else {
            user.drops.push({ itemName, count: 1, timestamps: [timestamp] });
          }
        }
      }
    });
    user.lastUpdated = now;
    await user.save();
    return user;
  } catch (e) {
    console.error(`Error updating user ${username}: ${e.message}`);
    return null;
  }
}
// Existing routes
app.get('/api/runemetrics/:username', async (req, res) => {
  try {
    const response = await fetch(`https://apps.runescape.com/runemetrics/profile/profile?user=${encodeURIComponent(req.params.username)}&activities=20`);
    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: `Failed to fetch stats: ${e.message}` });
  }
});
app.get('/api/chronotes', async (req, res) => {
  try {
    const response = await fetch(`https://api.weirdgloop.org/exchange/history/rs/latest?id=49430`);
    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: `Failed to fetch Chronotes price: ${e.message}` });
  }
});
app.get('/api/item/:id', async (req, res) => {
  try {
    const response = await fetch(`https://secure.runescape.com/m=itemdb_rs/api/catalogue/detail.json?item=${req.params.id}`);
    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: `Failed to fetch item details: ${e.message}` });
  }
});
// User tracker routes
app.post('/api/track-user', async (req, res) => {
  const { username } = req.body;
  try {
    const user = await updateUser(username);
    if (!user) throw new Error('Failed to track user');
    res.json({ message: 'User tracked', data: user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/user/:username', async (req, res) => {
  try {
    let user = await UserTracker.findOne({ username: req.params.username.toLowerCase() });
    if (!user || user.deleted) {
      user = await updateUser(req.params.username);
    }
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/users', async (req, res) => {
  try {
    const users = await UserTracker.find({ deleted: { $ne: true } }, 'username displayName');
    res.json(users.map(u => ({ username: u.username, displayName: u.displayName || u.username })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.delete('/api/user/:username', async (req, res) => {
  try {
    const result = await UserTracker.updateOne({ username: req.params.username.toLowerCase() }, { deleted: true });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User removed from list (data kept)' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Cleanup route for null displayNames
app.post('/api/cleanup-nulls', async (req, res) => {
  try {
    const result = await UserTracker.updateMany({ displayName: { $in: [null, ''] } }, { deleted: true });
    res.json({ message: `Marked ${result.modifiedCount} null users as deleted` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Catch-all for 404 - return JSON
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Auto-update job: Runs every 2 hours for all active users
const UPDATE_DELAY_MS = 1000; // Delay between updating each user (in ms); adjust if needed for rate limits
cron.schedule('0 */2 * * *', async () => {
  console.log('Starting auto-update for all active users...');
  try {
    const activeUsers = await UserTracker.find({ deleted: { $ne: true } }, 'username');
    console.log(`Found ${activeUsers.length} active users to update.`);
    for (const user of activeUsers) {
      await updateUser(user.username);
      await delay(UPDATE_DELAY_MS); // Pause to avoid overwhelming APIs
    }
    console.log('Auto-update completed.');
  } catch (e) {
    console.error('Auto-update error:', e.message);
  }
}, {
  timezone: 'UTC' // Use UTC; change to your timezone if preferred (e.g., 'America/New_York')
});

app.listen(process.env.PORT || 3000, () => console.log('Server running on port 3000'));