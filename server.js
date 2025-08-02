const express = require('express');
const fetch = require('node-fetch');
const app = express();
app.use(express.json());
app.get('/api/runemetrics/:username', async (req, res) => {
  try {
    const response = await fetch(`https://apps.runescape.com/runemetrics/profile/profile?user=${encodeURIComponent(req.params.username)}&activities=0`);
    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    res.set('Access-Control-Allow-Origin', '*');
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
    res.set('Access-Control-Allow-Origin', '*');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: `Failed to fetch Chronotes price: ${e.message}` });
  }
});
// NEW: Item details endpoint (proxies to RS Grand Exchange API)
app.get('/api/item/:id', async (req, res) => {
  try {
    const response = await fetch(`https://secure.runescape.com/m=itemdb_rs/api/catalogue/detail.json?item=${req.params.id}`);
    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    res.set('Access-Control-Allow-Origin', '*');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: `Failed to fetch item details: ${e.message}` });
  }
});
app.listen(process.env.PORT || 3000, () => console.log('Proxy running'));