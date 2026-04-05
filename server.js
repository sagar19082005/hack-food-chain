const express = require('express');
const cors = require('cors');
const path = require('path');

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

// Fallback to index.html for root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'bindex.html')));

// Serve legacy script path used in index.html (fixes requests to '/script')
app.get('/script', (req, res) => res.sendFile(path.join(__dirname, 'script.js')));

// Silence favicon 404s by returning no content
app.get('/favicon.ico', (req, res) => res.sendStatus(204));

app.listen(PORT, () => console.log(`Gemini proxy + static server listening on http://localhost:${PORT}`));
