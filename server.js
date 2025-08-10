// server.js — Transit proxy with arrive-by window sweep (Google Directions)
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;                 // set in Vercel
const USER_LOCATION  = process.env.USER_LOCATION || 'Pilotystraße 29, 90408 Nürnberg';

// Health
app.get('/health', (_, res) => res.json({ ok: true }));

// Call Google Directions (transit) at a single timestamp
async function googleTransitOnce({ origin, destination, ts, mode }) {
  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY missing');
  const base = 'https://maps.googleapis.com/maps/api/directions/json';
  const p = new URLSearchParams({ origin, destination, mode: 'transit', key: GOOGLE_API_KEY });
  if (mode === 'arrive') p.set('arrival_time', String(ts));
  else                   p.set('departure_time', String(ts));

  const r = await fetch(`${base}?${p.toString()}`);
  if (!r.ok) return { status: 'HTTP_ERROR', code: r.status };
  const j = await r.json();
  const leg = j?.routes?.[0]?.legs?.[0];
  if (!leg) return { status: 'ZERO_RESULTS' };

  const duration = leg.duration?.value ?? null; // seconds
  const transfers = (leg.steps || []).filter(s => s.travel_mode === 'TRANSIT').length - 1;
  const walkMin = Math.round(
    (leg.steps || [])
      .filter(s => s.travel_mode === 'WALKING')
      .reduce((a, s) => a + (s.duration?.value || 0), 0) / 60
  );
  const details = (leg.steps || []).map(s => {
    if (s.travel_mode === 'TRANSIT') {
      const td = s.transit_details || {};
      return {
        type: 'TRANSIT',
        line: td.line?.short_name || td.line?.name || '',
        agency: td.line?.agencies?.[0]?.name || '',
        from: td.departure_stop?.name || '',
        to: td.arrival_stop?.name || '',
        dep: td.departure_time?.value || null,
        arr: td.arrival_time?.value || null
      };
    }
    return { type: 'WALK', duration_sec: s.duration?.value || null, distance_m: s.distance?.value || null };
  });

  return { status: 'OK', provider: 'google', duration, transfers, walk: walkMin, details };
}

// NEW endpoint:
// /transit?origin=...&destination=...&arrival_time=UNIX | &departure_time=UNIX
//           &window=90&step=10 (minutes). Defaults: window=60, step=10.
// Back-compat: still accepts ?ziel=... (origin = USER_LOCATION).
app.get('/transit', async (req, res) => {
  try {
    const legacyZiel = (req.query.ziel || '').trim();
    const origin = (req.query.origin || (legacyZiel ? USER_LOCATION : '') || USER_LOCATION).trim();
    const destination = (req.query.destination || legacyZiel || '').trim();
    if (!destination) return res.status(400).json({ error: 'destination/ziel missing' });

    let baseTs, mode;
    if (req.query.arrival_time)       { baseTs = parseInt(req.query.arrival_time, 10); mode = 'arrive'; }
    else if (req.query.departure_time){ baseTs = parseInt(req.query.departure_time, 10); mode = 'depart'; }
    else                              { baseTs = Math.floor(Date.now() / 1000);         mode = 'depart'; }

    const windowMin = Math.max(0, parseInt(req.query.window || '60', 10));
    const stepMin   = Math.max(1, parseInt(req.query.step   || '10', 10));
    const startOff  = (mode === 'arrive') ? -windowMin : 0;
    const endOff    = (mode === 'arrive') ? 0          : windowMin;

    const candidates = [];
    for (let m = startOff; m <= endOff; m += stepMin) candidates.push(baseTs + m * 60);

    const results = [];
    for (const ts of candidates) {
      const r = await googleTransitOnce({ origin, destination, ts, mode });
      if (r.status === 'OK') results.push({ ...r, ts });
    }

    if (!results.length) {
      return res.status(502).json({ status: 'ZERO_RESULTS', message: 'No routes in window' });
    }

    results.sort((a, b) => a.duration - b.duration);
    const best = results[0];

    return res.json({
      status: 'OK',
      provider: best.provider,
      origin, destination, mode,
      requested_time: baseTs,
      chosen_time: best.ts,
      duration: best.duration,
      duration_minutes: Math.round(best.duration / 60),
      transfers: best.transfers ?? null,
      walk_minutes: best.walk ?? null,
      details: best.details || null
    });
  } catch (err) {
    res.status(500).json({ error: 'proxy_error', detail: err.message });
  }
});

app.listen(PORT, () => console.log(`Proxy listening on ${PORT}`));
