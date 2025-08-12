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
  // HERE Transit expects ISO8601; UTC ISO works fine.
  return new Date(ts * 1000).toISOString();
}

async function runPool(items, limit, worker){
  const out = new Array(items.length);
  let i = 0, active = 0, done = 0;
  return await new Promise(res=>{
    function next(){
      while(active < limit && i < items.length){
        const idx = i++; active++;
        Promise.resolve(worker(items[idx], idx))
          .then(v => { out[idx] = v; })
          .finally(()=>{ active--; done++; if (done === items.length) res(out); else next(); });
      }
    }
    next();
  });
}

// Products we consider NOT valid for the Deutschlandticket.
// We will reject any route containing these products when dticket=1.
const NON_D_TICKET_PRODUCTS = new Set([
  'highSpeedTrain',      // ICE/TGV/…
  'intercityTrain',      // IC/EC/RJ/…
  'longDistanceTrain',   // fallback category some agencies use
  'internationalTrain'
]);

// Map alpha-2 → alpha-3 (if ?country=de etc.)
const ISO2_TO_3 = { DE:'DEU', AT:'AUT', CH:'CHE', NL:'NLD', BE:'BEL', FR:'FRA', IT:'ITA', ES:'ESP', PT:'PRT', PL:'POL', CZ:'CZE', SK:'SVK', HU:'HUN', DK:'DNK', SE:'SWE', NO:'NOR', FI:'FIN', IE:'IRL', GB:'GBR', LU:'LUX' };

// Keep umlauts etc.; strip control chars/emojis; first non-empty line; cap length.
function sanitizeQ(q) {
  const s = String(q || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[🧭🚗🚆🚇🚍➡️↔︎→•\u200B-\u200D]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.split(/[|;\n]/)[0].slice(0, 140).trim();
}

async function geocode(q, countryBias = '') {
  if (!HERE_API_KEY) throw new Error('HERE_API_KEY missing');

  // 1) Accept "lat,lng"
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(q||''));
  if (m) return { ok:true, lat:+m[1], lng:+m[2], title:`${+m[1]},${+m[2]}` };

  const base = 'https://geocode.search.hereapi.com/v1/geocode';
  const qClean = sanitizeQ(q);
  if (!qClean) return { ok:false, status:400, error:'EMPTY_Q', tried:q };

  const up = (countryBias || '').trim().toUpperCase();
  const iso3 = up.length === 2 ? (ISO2_TO_3[up] || null) : (up.length === 3 ? up : null);
  const cacheKey = `${qClean}|${iso3||''}`;

  const cached = lruGet(GEO_CACHE, cacheKey);
  if (cached) return cached;

  return await inflight(cacheKey, GEO_INFLIGHT, async () => {
    const makeUrl = (withIn) => {
      const p = new URLSearchParams({ q: qClean, apiKey: HERE_API_KEY, lang: 'de-DE', limit: '1' });
      if (withIn && iso3) p.set('in', `countryCode:${iso3}`);
      return `${base}?${p.toString()}`;
    };

    for (const url of [ makeUrl(true), makeUrl(false) ]) {
      const r = await fetch(url);
      if (r.ok) {
        const j = await r.json();
        const it = j.items?.[0];
        if (it?.position) {
          const val = { ok:true, lat:it.position.lat, lng:it.position.lng, title:it.title || qClean };
          lruSet(GEO_CACHE, cacheKey, val, GEO_CACHE_MAX);
          return val;
        }
      } else if (r.status !== 400 && r.status !== 422) {
        const val = { ok:false, status:r.status, error:`HTTP ${r.status}`, tried:qClean };
        lruSet(GEO_CACHE, cacheKey, val, GEO_CACHE_MAX);
        return val;
      }
    }

    // Discover fallback
    const d = new URL('https://discover.search.hereapi.com/v1/discover');
    d.searchParams.set('q', qClean);
    d.searchParams.set('apiKey', HERE_API_KEY);
    d.searchParams.set('limit', '1');
    const rr = await fetch(d.toString());
    if (rr.ok) {
      const jj = await rr.json();
      const it = jj.items?.[0];
      if (it?.position) {
        const val = { ok:true, lat:it.position.lat, lng:it.position.lng, title:it.title || qClean };
        lruSet(GEO_CACHE, cacheKey, val, GEO_CACHE_MAX);
        return val;
      }
    }
    const val = { ok:false, status:'ZERO_RESULTS', error:null, tried:qClean };
    lruSet(GEO_CACHE, cacheKey, val, GEO_CACHE_MAX);
    return val;
  });
}

// ─── Caches ───────────────────────────────────────────────────────────────────
const GEO_CACHE_MAX = 2000;
const TRN_CACHE_MAX = 4000;
const GEO_CACHE = new Map();      // key: q|iso3  → value
const GEO_INFLIGHT = new Map();   // key: q|iso3  → Promise
const TRN_CACHE = new Map();      // key: o|d|mode|ts|dticket → value
const TRN_INFLIGHT = new Map();   // key: same → Promise

function lruGet(map, key){ if (!map.has(key)) return undefined; const v = map.get(key); map.delete(key); map.set(key, v); return v; }
function lruSet(map, key, val, max){
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  if (map.size > max) map.delete(map.keys().next().value);
}

// Small promise de-dup wrapper
async function inflight(key, bag, maker){
  if (bag.has(key)) return bag.get(key);
  const p = (async()=>{ try{ return await maker(); } finally { bag.delete(key); } })();
  bag.set(key, p);
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// HERE Public Transit (v8)
// ─────────────────────────────────────────────────────────────────────────────
async function hereTransitOnce({ origin, destination, ts, mode, dticket }) {
  // origin/destination are {lat, lng}
  const base = 'https://transit.router.hereapi.com/v8/routes';
  const p = new URLSearchParams({
    apiKey: HERE_API_KEY,
    origin: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`,
    [mode === 'arrive' ? 'arrivalTime' : 'departureTime']: toIso(ts),
    alternatives: '0',
    // 'summary' may not always be present on transit; we derive from timestamps if needed
    return: 'travelSummary,intermediate,fares'
  });

  async function hereTransitOnceCached(args){
  const { origin, destination, ts, mode, dticket } = args;
  const key = `${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}|${destination.lat.toFixed(5)},${destination.lng.toFixed(5)}|${mode}|${ts}|${dticket?'1':'0'}`;
  const cached = lruGet(TRN_CACHE, key);
  if (cached) return cached;
  return await inflight(key, TRN_INFLIGHT, async () => {
    const r = await hereTransitOnce(args);
    lruSet(TRN_CACHE, key, r, TRN_CACHE_MAX);
    return r;
  });
}
  
  const r = await fetch(`${base}?${p.toString()}`);
  if (!r.ok) return { ok:false, status:'HTTP_ERROR', code:r.status };

  const j = await r.json();
  const route = j.routes && j.routes[0];
  if (!route?.sections?.length) return { ok:false, status:'ZERO_RESULTS' };

  let violatesDTicket = false;
  let durationSec = 0;
  let firstDep = null;
  let lastArr  = null;

  for (const s of route.sections) {
    const prod = s?.transport?.product?.name || s?.transport?.mode || s?.transport?.category;
    const cat = (s?.transport?.category || s?.transport?.mode || '').trim();
    if (dticket && (NON_D_TICKET_PRODUCTS.has(cat) || NON_D_TICKET_PRODUCTS.has(prod))) {
      violatesDTicket = true;
    }

    const sec = s?.summary?.duration;
    if (Number.isFinite(sec)) durationSec += sec;

    const depIso = s?.departure?.time;
    const arrIso = s?.arrival?.time;
    const dep = depIso ? Date.parse(depIso) : null;
    const arr = arrIso ? Date.parse(arrIso) : null;
    if (dep && (firstDep == null || dep < firstDep)) firstDep = dep;
    if (arr && (lastArr == null || arr > lastArr))   lastArr  = arr;
  }

  if ((!durationSec || durationSec <= 0) && firstDep && lastArr && lastArr > firstDep) {
    durationSec = Math.round((lastArr - firstDep) / 1000);
  }

  if (dticket && violatesDTicket) {
    return { ok:false, status:'REJECTED_D_TICKET' };
  }

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

async function sweepTransit({ origin, destination, baseTs, mode, windowMin, stepMin, dticket, debug }) {
  // Cap probes to keep things fast
  const MAX_PROBES = 8; // <=8 requests per sweep
  const effStep = Math.max(stepMin || 10, Math.ceil((windowMin || 60) / MAX_PROBES));

  const startOff = (mode === 'arrive') ? -windowMin : 0;
  const endOff   = (mode === 'arrive') ? 0          : windowMin;

  const candidates = [];
  for (let m = startOff; m <= endOff; m += effStep) candidates.push(baseTs + m*60);
  if (candidates.length === 0) candidates.push(baseTs);

  const trace = [];
  const worker = async (ts) => {
    const r = await hereTransitOnceCached({ origin, destination, ts, mode, dticket });
    if (debug) trace.push({ ts, status: r.ok ? 'OK' : r.status, code: r.code || null, mode });
    return r.ok ? { ...r, ts } : null;
  };

  // Run in a small pool to increase throughput without hammering the API
  const results = (await runPool(candidates, 4, worker)).filter(Boolean);
  if (!results.length) return { ok:false, status:'ZERO_RESULTS', trace };

  results.sort((a,b) => (a.durationSec || 9e15) - (b.durationSec || 9e15));
  return { ok:true, best: results[0], trace };
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

    const [gO, gD] = await Promise.all([
      textOrigin ? geocode(textOrigin, country) : null,
      geocode(textDest, country)
    ]);

    if (!gD?.ok) {
      return res.status(400).json({ status:'GEOCODE_FAIL', origin:gO, destination:gD });
    }
    if (textOrigin && !gO?.ok) {
      return res.status(400).json({ status:'GEOCODE_FAIL', origin:gO, destination:gD });
    }

    // If origin omitted, dummy self-origin (legacy) → 0 duration
    const originPos = gO?.ok ? { lat: gO.lat, lng: gO.lng } : { lat: gD.lat, lng: gD.lng };

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

