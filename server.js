// server.js — Transit proxy with Google Directions + optional DB itineraries
// Routes:
//   GET /health
//   GET /transit    (single leg; arrive/depart sweep; provider=google|db|auto)
//   GET /itinerary  (outbound arrive-by + return depart/sweep; totals & wage)

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT           = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;  // required for Google
const USER_LOCATION  = process.env.USER_LOCATION || 'Pilotystraße 29, 90408 Nürnberg';

// DB feature flags / config
const ENABLE_DB  = String(process.env.ENABLE_DB || '0') === '1'; // OFF by default (DB upstream currently unavailable)
const DB_BASE    = process.env.DB_BASE || 'https://v6.transport.rest'; // only used if ENABLE_DB=1
const USER_AGENT = process.env.USER_AGENT || 'prologistics-proxy/1.0 (contact: set USER_AGENT in Vercel)';

// ──────────────────────────────────────────────────────────────────────────────
// Health
app.get('/health', (_, res) => res.json({ ok: true }));

// ──────────────────────────────────────────────────────────────────────────────
// Helpers

function parseTs(input) {
  if (input == null) return Math.floor(Date.now() / 1000);
  const v = String(input).trim().toLowerCase();
  if (v === 'now') return Math.floor(Date.now() / 1000);
  const n = Number(v);
  if (Number.isFinite(n)) return Math.floor(n);
  return Math.floor(Date.now() / 1000);
}

function parseDurationSec(d) {
  if (d == null) return null;
  if (typeof d === 'number') return d;
  if (typeof d === 'string' && d.includes(':')) {
    const [hh, mm, ss] = d.split(':').map(x => parseInt(x, 10) || 0);
    return hh*3600 + mm*60 + ss;
  }
  const n = Number(d);
  return Number.isFinite(n) ? n : null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Google Geocoding & Directions

async function geocodeToPlaceId(q, country = '') {
  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY missing');
  const base = 'https://maps.googleapis.com/maps/api/geocode/json';
  const p = new URLSearchParams({ address: q, key: GOOGLE_API_KEY, language: 'de' });
  if (country) p.set('components', `country:${country}`);
  const r = await fetch(`${base}?${p.toString()}`);
  const j = await r.json();
  if (j.status !== 'OK' || !j.results?.length) {
    return { ok:false, status:j.status, error:j.error_message || null };
  }
  const res = j.results[0];
  return { ok:true, place_id: res.place_id, formatted: res.formatted_address };
}

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

  const duration = parseDurationSec(leg.duration?.value);
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
        arr: td.arrival_time?.value || null,
        platform: null
      };
    }
    return { type: 'WALK', duration_sec: s.duration?.value || null, distance_m: s.distance?.value || null };
  });

  return { status: 'OK', provider: 'google', duration, transfers, walk: walkMin, details };
}

// ──────────────────────────────────────────────────────────────────────────────
// Optional DB via transport.rest (HAFAS). Currently OFF by default.

async function trFetch(path, params) {
  if (!ENABLE_DB) {
    return { ok:false, disabled:true, message:'DB provider disabled (upstream unavailable). Set ENABLE_DB=1 when a DB endpoint is ready.' };
  }
  const p = new URLSearchParams(params || {});
  try {
    const r = await fetch(`${DB_BASE}${path}?${p.toString()}`, {
      headers: { 'user-agent': USER_AGENT, 'accept': 'application/json' }
    });
    if (!r.ok) {
      const text = await r.text().catch(()=> '');
      return { ok:false, status:r.status, body:text || null };
    }
    const j = await r.json();
    return { ok:true, data:j };
  } catch (e) {
    return { ok:false, network:true, error: e?.message || String(e) };
  }
}

async function trFindLocation(q) {
  const res = await trFetch('/locations', { query: q, results: 1 });
  if (!res.ok) return { ok:false, error: res.message || res.error || res.body || res.status || 'fetch_failed' };
  if (!res.data?.length) return { ok:false, error:'no_results' };
  const loc = res.data[0];
  return { ok:true, id: loc.id, name: loc.name };
}

async function trJourneyOnce({ originId, destId, ts, mode }) {
  const params = {
    from: originId,
    to: destId,
    when: new Date(ts * 1000).toISOString(),
    results: 1,
    stopovers: true,
    remarks: false,
    polylines: false
  };
  if (mode === 'arrive') params.arrival = true;

  const res = await trFetch('/journeys', params);
  if (!res.ok) {
    return { status:'HTTP_ERROR', code:res.status, error: res.message || res.error || res.body || (res.network ? 'network_error' : null) };
  }

  const jn = res.data?.journeys?.[0];
  if (!jn) return { status:'ZERO_RESULTS' };

  const durSec = parseDurationSec(jn.duration) ??
                 (jn.legs || []).reduce((a,l)=>a+(parseDurationSec(l.plannedDuration)||parseDurationSec(l.duration)||0),0);

  const transfers = (jn.legs || []).filter(l => l.mode && l.mode !== 'walking').length - 1;
  const walkSec = (jn.legs || [])
    .filter(l => l.mode === 'walking')
    .reduce((a,l)=> a + (parseDurationSec(l.plannedDuration)||parseDurationSec(l.duration)||0), 0);

  const details = (jn.legs || []).map(l => {
    if (l.mode === 'walking') {
      return { type:'WALK', duration_sec:(parseDurationSec(l.plannedDuration)||parseDurationSec(l.duration)||0), distance_m:l.distance || null };
    }
    return {
      type: 'TRANSIT',
      line: l.line?.name || l.line?.id || '',
      agency: l.operator?.name || '',
      from: l.origin?.name || '',
      to:   l.destination?.name || '',
      dep:  l.departure ? Math.floor(new Date(l.departure).getTime()/1000) : null,
      arr:  l.arrival   ? Math.floor(new Date(l.arrival).getTime()/1000)   : null,
      platform: l.departurePlatform || l.arrivalPlatform || null
    };
  });

  const depUnix = jn.departure ? Math.floor(new Date(jn.departure).getTime()/1000) : null;
  const arrUnix = jn.arrival   ? Math.floor(new Date(jn.arrival).getTime()/1000)   : null;

  return {
    status:'OK', provider:'db',
    duration: durSec,
    transfers,
    walk: Math.round((walkSec||0)/60),
    details,
    depart: depUnix,
    arrive: arrUnix
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Unified sweep: tries requested mode, then opposite if empty

async function sweepBest({ provider, originText, destText, baseTs, windowMin, stepMin, mode, country, debug=false }) {
  let originFmt, destFmt, originPid, destPid, originId, destId;
  const trace = [];

  if (provider === 'db') {
    const [o, d] = await Promise.all([trFindLocation(originText), trFindLocation(destText)]);
    if (!o?.ok || !d?.ok) return { status:'GEOCODE_FAIL', origin:o, destination:d, trace };
    originId = o.id; destId = d.id; originFmt = o.name; destFmt = d.name;
  } else {
    const [o, d] = await Promise.all([geocodeToPlaceId(originText, country), geocodeToPlaceId(destText, country)]);
    if (!o.ok || !d.ok) return { status:'GEOCODE_FAIL', origin:o, destination:d, trace };
    originPid = o.place_id; destPid = d.place_id; originFmt = o.formatted; destFmt = d.formatted;
  }

  const startOff = (mode === 'arrive') ? -windowMin : 0;
  const endOff   = (mode === 'arrive') ?  0        :  windowMin;
  const candidates = [];
  for (let m=startOff; m<=endOff; m+=stepMin) candidates.push(baseTs + m*60);

  async function once(ts, m){
    const r = (provider === 'db')
      ? await trJourneyOnce({ originId, destId, ts, mode:m })
      : await googleTransitOnce({ originPid, destPid, ts, mode:m });
    if (debug) trace.push({ ts, status: r.status, code: r.code || null, m });
    return r;
  }
  function better(a,b){
    return (a.duration - b.duration) ||
           ((a.transfers||0) - (b.transfers||0)) ||
           ((a.walk||0) - (b.walk||0));
  }

  const results = [];
  for (const ts of candidates) {
    const r = await once(ts, mode);
    if (r.status === 'OK') results.push({ ...r, ts });
  }
  if (results.length) {
    results.sort(better);
    const best = results[0];
    return { status:'OK', provider: best.provider, origin: originFmt, destination: destFmt, best, trace };
  }

  const opp = mode === 'arrive' ? 'depart' : 'arrive';
  const results2 = [];
  for (const ts of candidates) {
    const r = await once(ts, opp);
    if (r.status === 'OK') results2.push({ ...r, ts });
  }
  if (!results2.length) return { status:'ZERO_RESULTS', trace };

  results2.sort(better);
  return { status:'OK', provider: results2[0].provider, origin: originFmt, destination: destFmt, best: results2[0], note:'fallback_to_opposite_mode', trace };
}

// ──────────────────────────────────────────────────────────────────────────────
// /transit — single leg (kept for compatibility)
//
// /transit?origin=...&destination=...&arrival_time=UNIX | &departure_time=UNIX
//           &window=90&step=10&country=de|nl|...&provider=google|db|auto&debug=1
// Back-compat: ?ziel=... (origin = USER_LOCATION)

app.get('/transit', async (req, res) => {
  try {
    const legacyZiel = (req.query.ziel || '').trim();
    const textOrigin = (req.query.origin || (legacyZiel ? USER_LOCATION : '') || USER_LOCATION).trim();
    const textDest   = (req.query.destination || legacyZiel || '').trim();
    if (!textDest) return res.status(400).json({ error: 'destination/ziel missing' });

    const providerRq = (req.query.provider || 'google').toLowerCase();
    let provider = providerRq === 'auto' ? (ENABLE_DB ? 'db' : 'google') : providerRq;
    if (provider === 'db' && !ENABLE_DB) {
      return res.status(503).json({ status:'DB_DISABLED', message:'DB upstream unavailable. Use provider=google or set ENABLE_DB=1 when DB endpoint is ready.' });
    }

    const mode = (req.query.arrival_time != null) ? 'arrive'
               : (req.query.departure_time != null) ? 'depart' : 'depart';
    const baseTs = (mode === 'arrive') ? parseTs(req.query.arrival_time)
                                       : parseTs(req.query.departure_time);

    const windowMin = Math.max(0, parseInt(req.query.window || '60', 10));
    const stepMin   = Math.max(1, parseInt(req.query.step   || '10', 10));
    const country   = (req.query.country || '').toLowerCase(); // '' = no country filter
    const debug     = String(req.query.debug || '') === '1';

    const out = await sweepBest({ provider, originText:textOrigin, destText:textDest, baseTs, windowMin, stepMin, mode, country, debug });
    if (out.status !== 'OK') {
      return res.status(502).json({
        status: out.status || 'ZERO_RESULTS',
        message: out.status === 'GEOCODE_FAIL' ? 'Geocoding failed' : 'No routes in window',
        origin_geocoded: out.origin,
        destination_geocoded: out.destination,
        probed: debug ? out.trace : undefined
      });
    }
    const b = out.best;
    return res.json({
      status: 'OK',
      provider: out.provider,
      origin: out.origin,
      destination: out.destination,
      mode,
      requested_time: baseTs,
      chosen_time: b.ts,
      duration: b.duration,
      duration_minu_
