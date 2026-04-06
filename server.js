const express = require('express');
const cors = require('cors');
const path = require('path');
// Load environment variables from .env when present
try { require('dotenv').config(); } catch (e) { /* dotenv not installed or not needed */ }

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files from the project root so frontend and proxy share origin
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3004;
const API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyCg4CVjQh0463Y_X-uiDSwv-AM9uLP11cc';
const GD_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta2/models/text-bison-001:generate?key=${API_KEY}`;

app.post('/api/gemini', async (req, res) => {
  try {
    const { prompt, max_output_tokens = 256 } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    // If the server does not have a configured GEMINI_API_KEY, short-circuit
    // with a helpful JSON response so the frontend can fallback gracefully.
    if (!process.env.GEMINI_API_KEY) {
      return res.json({ error: 'GEMINI_API_KEY not configured on server' });
    }

    const body = {
      prompt: { text: prompt },
      max_output_tokens
    };

    const response = await fetch(GD_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // timeout not available here; rely on caller
    });

    const raw = await response.text().catch(() => '');
    let data;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch (parseErr) {
      console.error('Non-JSON response from Generative API:', raw);
      return res.status(response.status || 502).json({ error: `Non-JSON response from Generative API`, raw: raw });
    }

    if (!response.ok) {
      console.error('Generative API returned error', response.status, data || raw);
      return res.status(response.status || 502).json({ error: data || raw });
    }

    return res.json(data);
  } catch (err) {
    console.error('Proxy error', err);
    return res.status(500).json({ error: String(err) });
  }
});

// Geocoding via Nominatim (no key)
app.get('/api/geocode', async (req, res) => {
  try {
    // Support both forward geocoding (place query) and reverse geocoding (lat+lon)
    const q = req.query.place;
    const lat = req.query.lat;
    const lon = req.query.lon;

    if (lat && lon) {
      // Reverse geocode
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'hackathon-app/1.0' } });
      const json = await r.json();
      if (!json || !json.display_name) return res.status(404).json({ error: 'location not found' });
      return res.json({ lat: parseFloat(lat), lon: parseFloat(lon), display_name: json.display_name });
    }

    if (!q) return res.status(400).json({ error: 'place query required' });
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'hackathon-app/1.0' } });
    const json = await r.json();
    if (!json || !json.length) return res.status(404).json({ error: 'location not found' });
    const item = json[0];
    return res.json({ lat: parseFloat(item.lat), lon: parseFloat(item.lon), display_name: item.display_name });
  } catch (e) {
    console.error('geocode error', e);
    return res.status(500).json({ error: String(e) });
  }
});

// OpenWeather current weather (requires OPENWEATHERMAP_KEY env)
app.get('/api/weather', async (req, res) => {
  try {
    const lat = req.query.lat;
    const lon = req.query.lon;
    const key = process.env.OPENWEATHERMAP_KEY;
    if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });
    if (!key) {
      // Instead of throwing a 4xx error that breaks front-end flows, return a helpful JSON
      // so the client can continue and optionally use mock data.
      return res.json({ error: 'OPENWEATHERMAP_KEY not configured on server', guidance: 'Set OPENWEATHERMAP_KEY env var before starting the server' });
    }
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&appid=${key}`;
    const r = await fetch(url);
    const json = await r.json();
    return res.json(json);
  } catch (e) {
    console.error('weather error', e);
    return res.status(500).json({ error: String(e) });
  }
});

// NASA POWER: daily climate data (no key). Query params: lat, lon, start, end
app.get('/api/nasa-power', async (req, res) => {
  try {
    const lat = req.query.lat;
    const lon = req.query.lon;
    const start = req.query.start; // YYYYMMDD
    const end = req.query.end; // YYYYMMDD
    if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });
    const s = start || ''; const e = end || '';
    const params = ['PRECTOT','T2M'];
    // include community=AG to ensure agricultural datasets are returned
    const url = `https://power.larc.nasa.gov/api/temporal/daily/point?latitude=${lat}&longitude=${lon}&start=${s}&end=${e}&parameters=${params.join(',')}&community=AG&format=JSON`;
    const r = await fetch(url);
    const json = await r.json();
    return res.json(json);
  } catch (err) {
    console.error('nasa-power error', err);
    return res.status(500).json({ error: String(err) });
  }
});

// Fallback to index.html for root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'bindex.html')));

// Serve legacy script path used in index.html (fixes requests to '/script')
app.get('/script', (req, res) => res.sendFile(path.join(__dirname, 'script.js')));

// Silence favicon 404s by returning no content
app.get('/favicon.ico', (req, res) => res.sendStatus(204));

app.listen(PORT, () => console.log(`Gemini proxy + static server listening on http://localhost:${PORT}`));
