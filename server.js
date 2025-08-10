// server.js — Transit proxy with arrive-by window sweep (Directions) + geocoding + debug
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;  // set in Vercel
const USER_LOCATION  = process.env.USER_LOCATION || 'Pilotystraße 29, 90408 Nürnberg';

// Health
app.get('/health', (_, res) => res.json({ ok: true }));

// --- helpers ---
function parseTs(input) {
  if (input == null) return Math.floor(Date.now() / 1000);
  const v = String(input).trim().toLowerCase();
  if (v === 'now') return Math.floor(Date.now() / 1000);
  const n = Number(v);
  if (Number.isFinite(n)) return Math.floor(n);
  return Math.floor(Date.now() / 1000);
}

// Geocode a free-text address to a place_id (much more reliable for transit)
async function geocodeToPlaceId(q, country = '') {
  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY missing');
  const base = 'https://maps.googleapis.com/maps/api/geocode/json';
  const p = new URLSearchParams({ address: q, key: GOOGLE_API_KEY, language: 'de' });
  if (country) p.set('components', `country:${country}`);
  const r = await fetch(`${base}?${p.toString()}`);
  const j = await r.json();
  // Return full status so we can see errors like REQUEST_DENIED, OVER_QUERY_LIMIT, etc.
  if (j.status !== 'OK' || !j.results?.length) {
    return { ok:false, status:j.status, error:j.error_message || null };
  }
  const res = j.results[0];
  return { ok:true, place_id: res.place_id, formatted: res.formatted_address };
}

// Directions (transit) at a single timestamp, using place_ids when available
async function googleTransitOnce({ originPid, destPid, ts, mode }) {
  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY missing');
  const base = 'https://maps.googleapis.com/maps/api/directions/json';
  const p = new URLSearchParams({
    origin: `place_id:${originPid}`,
    destination: `place_id:${destPid}`,
    mode: 'transit',
    key: GOOGLE_API_KEY
  });
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
//           &window=90&step=10&country=de&debug=1
// Back-compat: ?ziel=... (origin = USER_LOCATION)
app.get('/transit', async (req, res) => {
  try {
    const legacyZiel = (req.query.ziel || '').trim();
    const textOrigin = (req.query.origin || (legacyZiel ? USER_LOCATION : '') || USER_LOCATION).trim();
    const textDest   = (req.query.destination || legacyZiel || '').trim();
    if (!textDest) return res.status(400).json({ error: 'destination/ziel missing' });

    const mode = (req.query.arrival_time != null) ? 'arrive'
               : (req.query.departure_time != null) ? 'depart' : 'depart';
    const baseTs = (mode === 'arrive') ? parseTs(req.query.arrival_time)
                                       : parseTs(req.query.departure_time);

    const windowMin = Math.max(0, parseInt(req.query.window || '60', 10));
    const stepMin   = Math.max(1, parseInt(req.query.step   || '10', 10));
    const country   = (req.query.country || '').toLowerCase(); // '' = no country filter
    const debug     = (String(req.query.debug || '') === '1');

    // Geocode both ends to place_ids
    const [o, d] = await Promise.all([
      geocodeToPlaceId(textOrigin, country),
      geocodeToPlaceId(textDest,   country)
    ]);
    
    if (!o.ok || !d.ok) {
      return res.status(400).json({ status: 'GEOCODE_FAIL', origin:o, destination:d });
    }


    const startOff = (mode === 'arrive') ? -windowMin : 0;
    const endOff   = (mode === 'arrive') ? 0          : windowMin;

    const candidates = [];
    for (let m = startOff; m <= endOff; m += stepMin) candidates.push(baseTs + m * 60);

    const results = [];
    const trace = [];
    for (const ts of candidates) {
      const r = await googleTransitOnce({ originPid: o.place_id, destPid: d.place_id, ts, mode });
      if (debug) trace.push({ ts, status: r.status, code: r.code || null });
      if (r.status === 'OK') results.push({ ...r, ts });
    }

    if (!results.length) {
      return res.status(502).json({ status: 'ZERO_RESULTS', message: 'No routes in window',
                                    origin_geocoded: o, destination_geocoded: d, probed: debug ? trace : undefined });
    }

    results.sort((a, b) => a.duration - b.duration);
    const best = results[0];

    return res.json({
      status: 'OK',
      provider: best.provider,
      origin: o.formatted, destination: d.formatted, mode,
      requested_time: baseTs,
      chosen_time: best.ts,
      duration: best.duration,
      duration_minutes: Math.round(best.duration / 60),
      transfers: best.transfers ?? null,
      walk_minutes: best.walk ?? null,
      details: best.details || null,
      probed: debug ? trace : undefined
    });
  } catch (err) {
    res.status(500).json({ error: 'proxy_error', detail: err.message });
  }
});

app.listen(PORT, () => console.log(`Proxy listening on ${PORT}`));


