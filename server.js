// server.js — HERE-only Transit proxy
// Features:
//  - Geocode (HERE Search v7)
//  - Transit routing (HERE Transit v8) with arrival/departure sweep
//  - Deutschlandticket filter (excludes ICE/IC/EC/RJ/ECE/etc.)
//  - Minimal params to avoid 400s; adds debug messages on HTTP errors
//  - Endpoints: /health, /geocode?q=..., /transit?... (see below)

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const HERE_API_KEY = process.env.HERE_API_KEY;
const USER_AGENT = process.env.USER_AGENT || 'prologistics-proxy/1.0';

if (!HERE_API_KEY) {
  console.error('HERE_API_KEY is missing. Set it in Vercel → Project → Settings → Environment Variables.');
}

// ─────────────── Helpers ───────────────
function parseTs(input) {
  if (input == null) return Math.floor(Date.now() / 1000);
  const s = String(input).trim().toLowerCase();
  if (s === 'now') return Math.floor(Date.now() / 1000);
  const n = Number(s);
  return Number.isFinite(n) ? Math.floor(n) : Math.floor(Date.now() / 1000);
}
function toIsoUTC(unixSec) { return new Date(unixSec * 1000).toISOString(); }

function longDistanceMatcher(name = '', shortName = '', agency = '') {
  const ln = (name || '').toUpperCase();
  const sn = (shortName || '').toUpperCase();
  const ag = (agency || '').toUpperCase();
  const re = /^(ICE|IC|EC|ECE|RJ|RJX|D|TLX)/; // extend as needed
  return re.test(sn) || re.test(ln) || ag.includes('DB FERNVERKEHR');
}

// ─────────────── HERE: Geocoding & Search (v7) ───────────────
async function geocodeHere(query, country = '') {
  const base = 'https://geocode.search.hereapi.com/v1/geocode';
  const params = new URLSearchParams({ q: query, apiKey: HERE_API_KEY, lang: 'de-DE' });
  if (country) params.set('in', `countryCode:${country.toUpperCase()}`);

  const r = await fetch(`${base}?${params}`, { headers: { 'user-agent': USER_AGENT } });
  if (!r.ok) return { ok: false, status: r.status, error: 'GEOCODE_HTTP' };

  const j = await r.json();
  const item = j.items?.[0];
  if (!item) return { ok: false, status: 'ZERO_RESULTS' };

  return { ok: true, lat: item.position?.lat, lng: item.position?.lng, title: item.title };
}

// ─────────────── HERE: Transit Routing (v8) — minimal & robust ───────────────
async function hereTransitRoute({ origin, destination, ts, mode, dticketOnly }) {
  const base = 'https://transit.router.hereapi.com/v8/routes';
  const p = new URLSearchParams({
    apiKey: HERE_API_KEY,
    origin: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`
    // No extras (modes/products/return/changes/walkTime). Minimal = fewest 400s.
  });
  if (mode === 'arrive') p.set('arrivalTime', toIsoUTC(ts));
  else                   p.set('departureTime', toIsoUTC(ts));

  const url = `${base}?${p.toString()}`;
  const r = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  const text = await r.text(); // read body even on error for diagnostics
  let j = null; try { j = JSON.parse(text); } catch {}

  if (!r.ok) {
    const msg = (j && (j.title || j.message || j.error || j.cause)) || text.slice(0, 300);
    return { status: 'HTTP_ERROR', code: r.status, message: msg };
  }

  const route = j?.routes?.[0];
  if (!route) return { status: 'ZERO_RESULTS' };

  // Optional Deutschlandticket filter: reject long-distance trains
  if (dticketOnly) {
    const hasLD = (route.sections || []).some(sec => {
      if (sec.transport?.mode !== 'transit') return false;
      const line = sec.transport?.name || '';
      const short = sec.transport?.shortName || '';
      const agency = sec.agency?.name || '';
      return longDistanceMatcher(line, short, agency);
    });
    if (hasLD) return { status: 'FILTERED_LONG_DISTANCE' };
  }

  // Fallback: compute duration from departure/arrival if summary is missing
  const duration = (route.sections || []).reduce((sum, s) => {
    const sd = s.summary?.duration;
    if (Number.isFinite(sd)) return sum + sd;
    const depMs = s.departure?.time ? Date.parse(s.departure.time) : null;
    const arrMs = s.arrival?.time ? Date.parse(s.arrival.time) : null;
    return sum + (depMs != null && arrMs != null ? Math.max(0, Math.round((arrMs - depMs) / 1000)) : 0);
  }, 0);

  const details = (route.sections || []).map(sec => {
    if (sec.transport?.mode === 'transit') {
      return {
        type: 'TRANSIT',
        line: sec.transport?.shortName || sec.transport?.name || '',
        agency: sec.agency?.name || '',
        from: sec.departure?.place?.name || '',
        to:   sec.arrival?.place?.name || '',
        dep:  sec.departure?.time ? Math.floor(new Date(sec.departure.time).getTime()/1000) : null,
        arr:  sec.arrival?.time   ? Math.floor(new Date(sec.arrival.time).getTime()/1000)   : null
      };
    }
    if (sec.transport?.mode === 'pedestrian') {
      return { type: 'WALK', duration_sec: sec.summary?.duration || 0, distance_m: sec.summary?.length || 0 };
    }
    return { type: (sec.transport?.mode || 'OTHER').toUpperCase() };
  });

  const depUnix = route.sections?.[0]?.departure?.time
    ? Math.floor(new Date(route.sections[0].departure.time).getTime()/1000) : null;
  const arrUnix = route.sections?.slice(-1)[0]?.arrival?.time
    ? Math.floor(new Date(route.sections.slice(-1)[0].arrival.time).getTime()/1000) : null;

  return { status: 'OK', provider: 'here', duration, transfers, details, depart: depUnix, arrive: arrUnix };
}

// ─────────────── Sweep window: test multiple timestamps & pick fastest ───────────────
async function sweepBest({ originText, destText, baseTs, windowMin, stepMin, mode, country, dticketOnly, debug=false }) {
  const [o, d] = await Promise.all([ geocodeHere(originText, country), geocodeHere(destText, country) ]);
  if (!o.ok || !d.ok) return { status: 'GEOCODE_FAIL', origin:o, destination:d, trace: [] };

  const startOff = (mode === 'arrive') ? -windowMin : 0;
  const endOff   = (mode === 'arrive') ?  0        : windowMin;
  const candidates = [];
  for (let m = startOff; m <= endOff; m += stepMin) candidates.push(baseTs + m*60);

  const trace = [], options = [];
  for (const ts of candidates) {
    const r = await hereTransitRoute({ origin:{lat:o.lat,lng:o.lng}, destination:{lat:d.lat,lng:d.lng}, ts, mode, dticketOnly });
    if (debug) trace.push({ ts, status: r.status, code: r.code || null, message: r.message || null, mode });
    if (r.status === 'OK') options.push({ ...r, ts });
  }
  if (!options.length) return { status:'ZERO_RESULTS', origin:o, destination:d, trace };

  options.sort((a,b)=> (a.duration - b.duration) || (a.transfers - b.transfers));
  return { status:'OK', provider:'here', origin:o.title, destination:d.title, best: options[0], trace };
}

// ─────────────── Endpoints ───────────────

// Health
app.get('/health', (_, res) => res.json({ ok: true }));

// Simple geocode probe: /geocode?q=Erlangen Bahnhof&country=de
app.get('/geocode', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const country = (req.query.country || '').trim();
    if (!q) return res.status(400).json({ error: 'q required' });
    const g = await geocodeHere(q, country);
    return res.status(g.ok ? 200 : 502).json(g);
  } catch (err) {
    res.status(500).json({ error: 'proxy_error', detail: err.message });
  }
});

// Transit planner:
// /transit?origin=...&destination=...&arrival_time=UNIX | &departure_time=UNIX
//          &window=90&step=10&country=de&dticket=1&debug=1
app.get('/transit', async (req, res) => {
  try {
    const originText = (req.query.origin || '').trim();
    const destText   = (req.query.destination || req.query.ziel || '').trim();
    if (!originText || !destText) return res.status(400).json({ error: 'origin and destination required' });

    const mode   = (req.query.arrival_time != null) ? 'arrive'
                  : (req.query.departure_time != null) ? 'depart' : 'depart';
    const baseTs = (mode === 'arrive') ? parseTs(req.query.arrival_time) : parseTs(req.query.departure_time);
    const windowMin = Math.max(0, parseInt(req.query.window || '60', 10));
    const stepMin   = Math.max(1, parseInt(req.query.step   || '10', 10));
    const country   = (req.query.country || '').toLowerCase();
    const dticketOnly = String(req.query.dticket || '0') === '1';
    const debug = String(req.query.debug || '') === '1';

    const out = await sweepBest({
      originText, destText, baseTs, windowMin, stepMin, mode, country, dticketOnly, debug
    });

    if (out.status !== 'OK') {
      return res.status(502).json({
        status: out.status,
        message: out.status === 'GEOCODE_FAIL' ? 'Geocoding failed' : 'No routes in window',
        origin_geocoded: out.origin,
        destination_geocoded: out.destination,
        probed: out.trace
      });
    }
    const b = out.best;
    res.json({
      status: 'OK',
      provider: out.provider,
      origin: out.origin,
      destination: out.destination,
      mode,
      requested_time: baseTs,
      chosen_time: b.ts,
      duration: b.duration,
      duration_minutes: Math.round((b.duration || 0) / 60),
      transfers: b.transfers ?? null,
      details: b.details || null,
      depart: b.depart || null,
      arrive: b.arrive || null
    });
  } catch (err) {
    res.status(500).json({ error: 'proxy_error', detail: err.message });
  }
});

app.listen(PORT, () => console.log(`HERE transit proxy listening on :${PORT}`));

