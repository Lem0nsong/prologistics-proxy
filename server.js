// server.js — HERE Transit proxy with arrive-by/depart sweep + geocoding + D-Ticket filter
// Node 18+ / Vercel (@vercel/node).  Copy–paste this file and redeploy.

const express = require('express');
const cors = require('cors');
const fetch = global.fetch || require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const HERE_API_KEY = process.env.HERE_API_KEY;           // REQUIRED
const DEFAULT_COUNTRY = (process.env.DEFAULT_COUNTRY || '').toLowerCase(); // e.g. 'de'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const nowUnix = () => Math.floor(Date.now()/1000);

function parseTs(input) {
  if (input == null) return nowUnix();
  const v = String(input).trim().toLowerCase();
  if (v === 'now') return nowUnix();
  const n = Number(v);
  if (Number.isFinite(n)) return Math.floor(n);
  return nowUnix();
}

function toIso(ts) {
  // HERE Transit expects ISO8601 local time (it tolerates UTC too). We send UTC ISO.
  return new Date(ts * 1000).toISOString();
}

// Products we consider NOT valid for the Deutschlandticket.
// We will reject any route containing these products when dticket=1.
const NON_D_TICKET_PRODUCTS = new Set([
  'highSpeedTrain',      // ICE/TGV/… (category names per HERE docs)
  'intercityTrain',      // IC/EC/RJ/…
  'longDistanceTrain',   // fallback category some agencies use
  'internationalTrain'
]);

// ─────────────────────────────────────────────────────────────────────────────
// Geocoding (HERE Search API v1)
// ─────────────────────────────────────────────────────────────────────────────
async function geocode(q, countryBias = '') {
  if (!HERE_API_KEY) throw new Error('HERE_API_KEY missing');
  const base = 'https://geocode.search.hereapi.com/v1/geocode';
  const p = new URLSearchParams({ q, apiKey: HERE_API_KEY, lang: 'de-DE' });
  if (countryBias) p.set('in', `countryCode:${countryBias.toUpperCase()}`);
  const r = await fetch(`${base}?${p.toString()}`);
  if (!r.ok) return { ok:false, status:r.status, error:`HTTP ${r.status}` };
  const j = await r.json();
  const item = j.items && j.items[0];
  if (!item) return { ok:false, status:'ZERO_RESULTS', error:null };
  return { ok:true, lat:item.position.lat, lng:item.position.lng, title:item.title };
}

// ─────────────────────────────────────────────────────────────────────────────
// HERE Public Transit routing (v8)
// We call it once per candidate time. We derive duration even if summary is missing.
// ─────────────────────────────────────────────────────────────────────────────
async function hereTransitOnce({ origin, destination, ts, mode, dticket }) {
  // origin/destination are {lat, lng}
  const base = 'https://transit.router.hereapi.com/v8/routes';
  const p = new URLSearchParams({
    apiKey: HERE_API_KEY,
    origin: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`,
    // time parameter differs by mode:
    [mode === 'arrive' ? 'arrivalTime' : 'departureTime']: toIso(ts),
    // Keep it simple: 0 alternatives; we sweep multiple timestamps ourselves
    alternatives: '0',
    // Return more details so the client can show leg lines/times
    return: 'travelSummary,intermediate,fares'
  });

  const r = await fetch(`${base}?${p.toString()}`);
  if (!r.ok) return { ok:false, status:'HTTP_ERROR', code:r.status };

  const j = await r.json();
  const route = j.routes && j.routes[0];
  if (!route || !route.sections || !route.sections.length) {
    return { ok:false, status:'ZERO_RESULTS' };
  }

  // Determine if this route violates D-ticket (contains long-distance trains)
  let violatesDTicket = false;

  // Compute duration fallback: sum of per-section durations if present,
  // otherwise derive from departure/arrival timestamps.
  let durationSec = 0;
  let firstDep = null;
  let lastArr  = null;

  for (const s of route.sections) {
    // Capture products for D-ticket filtering
    const prod = s?.transport?.product?.name || s?.transport?.mode || s?.transport?.category;
    // HERE often exposes product categories via transport.category or transport.mode.
    const cat = (s?.transport?.category || s?.transport?.mode || '').trim();
    if (dticket && (NON_D_TICKET_PRODUCTS.has(cat) || NON_D_TICKET_PRODUCTS.has(prod))) {
      violatesDTicket = true;
    }

    // Duration summary if provided
    const sec = s?.summary?.duration;
    if (Number.isFinite(sec)) durationSec += sec;

    // Derive absolute times
    const depIso = s?.departure?.time;
    const arrIso = s?.arrival?.time;
    const dep = depIso ? Date.parse(depIso) : null;
    const arr = arrIso ? Date.parse(arrIso) : null;
    if (dep && (firstDep == null || dep < firstDep)) firstDep = dep;
    if (arr && (lastArr == null || arr > lastArr))   lastArr  = arr;
  }

  // If summary-based duration is zero/absent but we have timestamps, derive it.
  if ((!durationSec || durationSec <= 0) && firstDep && lastArr && lastArr > firstDep) {
    durationSec = Math.round((lastArr - firstDep) / 1000);
  }

  if (dticket && violatesDTicket) {
    // Mark as rejected for D-ticket; caller will ignore it
    return { ok:false, status:'REJECTED_D_TICKET' };
  }

  // Build a leg list for the client
  const details = route.sections.map(s => {
    const depIso = s?.departure?.time;
    const arrIso = s?.arrival?.time;
    const dep = depIso ? Math.floor(Date.parse(depIso)/1000) : null;
    const arr = arrIso ? Math.floor(Date.parse(arrIso)/1000) : null;

    if (s.transport) {
      return {
        type: 'TRANSIT',
        line: s.transport?.name || s.transport?.shortName || s.transport?.mode || '',
        agency: s.transport?.operator || '',
        from: s.departure?.place?.name || '',
        to:   s.arrival?.place?.name || '',
        dep, arr,
        product: s.transport?.category || s.transport?.mode || ''
      };
    }
    // WALK or OTHER legs
    const dur = s?.summary?.duration || (dep && arr ? Math.max(0, Math.round((arr - dep)/1000)) : null);
    const dist = s?.summary?.length ?? null;
    return { type: 'WALK', duration_sec: dur, distance_m: dist };
  });

  return {
    ok:true,
    durationSec: durationSec || 0,
    depart: firstDep ? Math.floor(firstDep/1000) : null,
    arrive: lastArr  ? Math.floor(lastArr/1000)  : null,
    details
  };
}

// Sweeps around the base time (arrive or depart) to pick the shortest valid route
async function sweepTransit({ origin, destination, baseTs, mode, windowMin, stepMin, dticket, debug }) {
  const startOff  = (mode === 'arrive') ? -windowMin : 0;
  const endOff    = (mode === 'arrive') ? 0          : windowMin;

  const candidates = [];
  for (let m = startOff; m <= endOff; m += stepMin) candidates.push(baseTs + m*60);

  const results = [];
  const trace = [];

  for (const ts of candidates) {
    const r = await hereTransitOnce({ origin, destination, ts, mode, dticket });
    if (debug) trace.push({ ts, status: r.ok ? 'OK' : r.status, code: r.code || null, mode });
    if (r.ok) results.push({ ...r, ts });
  }

  if (!results.length) {
    return { ok:false, status:'ZERO_RESULTS', trace };
  }

  results.sort((a,b) => (a.durationSec || 9e15) - (b.durationSec || 9e15));
  const best = results[0];
  return { ok:true, best, trace };
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

// /transit?origin=...&destination=...&arrival_time=UNIX | &departure_time=UNIX
//         &window=90&step=10&country=de&dticket=1&debug=1
// Back-compat: ?ziel=... (origin omitted). In that case we only geocode destination.
app.get('/transit', async (req, res) => {
  try {
    if (!HERE_API_KEY) return res.status(500).json({ error:'config', detail:'HERE_API_KEY is missing' });

    // Inputs
    const legacyZiel  = (req.query.ziel || '').trim();
    const textOrigin  = (req.query.origin || '').trim();
    const textDest    = (req.query.destination || legacyZiel || '').trim();
    if (!textDest) return res.status(400).json({ error: 'destination/ziel missing' });

    const mode = (req.query.arrival_time != null) ? 'arrive'
               : (req.query.departure_time != null) ? 'depart' : 'depart';
    const baseTs = (mode === 'arrive') ? parseTs(req.query.arrival_time)
                                       : parseTs(req.query.departure_time);

    const windowMin = Math.max(0, parseInt(req.query.window || '60', 10));
    const stepMin   = Math.max(1, parseInt(req.query.step   || '10', 10));
    const dticket   = String(req.query.dticket || '') === '1';
    const debug     = String(req.query.debug   || '') === '1';
    const country   = (req.query.country || DEFAULT_COUNTRY || '').toLowerCase();

    // Geocode
    const [gO, gD] = await Promise.all([
      textOrigin ? geocode(textOrigin, country) : null,
      geocode(textDest, country)
    ]);

    if (!gD?.ok) {
      return res.status(400).json({ status:'GEOCODE_FAIL', origin:gO, destination:gD });
    }
    // If origin missing, we fall back to destination-only legacy behavior (not recommended)
    if (textOrigin && !gO?.ok) {
      return res.status(400).json({ status:'GEOCODE_FAIL', origin:gO, destination:gD });
    }

    // If origin omitted: allow calls like /transit?ziel=... for quick duration checks.
    const originPos = gO?.ok ? { lat: gO.lat, lng: gO.lng } : { lat: gD.lat, lng: gD.lng }; // dummy self-origin for legacy: will produce 0 min

    const { ok, best, trace, status } = await sweepTransit({
      origin: originPos,
      destination: { lat: gD.lat, lng: gD.lng },
      baseTs, mode, windowMin, stepMin, dticket, debug
    });

    if (!ok) {
      return res.status(502).json({
        status: status || 'ZERO_RESULTS',
        message: 'No routes in window',
        origin_geocoded: gO?.ok ? { lat:gO.lat, lng:gO.lng, title:gO.title } : null,
        destination_geocoded: { lat:gD.lat, lng:gD.lng, title:gD.title },
        probed: debug ? trace : undefined
      });
    }

    // Build response
    const duration = best.durationSec || 0;
    const minutes  = Math.round(duration / 60);

    return res.json({
      status: 'OK',
      provider: 'here',
      origin: gO?.ok ? gO.title : null,
      destination: gD.title,
      mode,
      requested_time: baseTs,
      chosen_time: best.ts,
      duration,
      duration_minutes: minutes,
      depart: best.depart || null,
      arrive: best.arrive || null,
      // keep only leg info the client uses
      details: best.details?.map(s => ({
        type: s.type,
        line: s.line || '',
        agency: s.agency || '',
        from: s.from || '',
        to:   s.to   || '',
        dep:  s.dep  || null,
        arr:  s.arr  || null,
        product: s.product || ''
      })) || [],
      probed: debug ? trace : undefined
    });
  } catch (err) {
    res.status(500).json({ error: 'proxy_error', detail: err.message });
  }
});

app.listen(PORT, () => console.log(`Proxy listening on ${PORT}`));
