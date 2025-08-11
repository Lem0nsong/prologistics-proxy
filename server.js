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

// Geocoding (HERE Search v1) with robust fallback + country bias handling
async function geocode(q, countryBias = '') {
  if (!HERE_API_KEY) throw new Error('HERE_API_KEY missing');

  // 1) Accept "lat,lng" directly
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(q||''));
  if (m) return { ok:true, lat: +m[1], lng: +m[2], title: `${+m[1]},${+m[2]}` };

  const base = 'https://geocode.search.hereapi.com/v1/geocode';
  const qClean = sanitizeQ(q);
  if (!qClean) return { ok:false, status:400, error:'EMPTY_Q', tried:q };

  const up = (countryBias || '').trim().toUpperCase();
  const iso3 = up.length === 2 ? (ISO2_TO_3[up] || null) : (up.length === 3 ? up : null);

  const makeUrl = (withIn) => {
    const p = new URLSearchParams({ q: qClean, apiKey: HERE_API_KEY, lang: 'de-DE', limit: '1' });
    if (withIn && iso3) p.set('in', `countryCode:${iso3}`);
    return `${base}?${p.toString()}`;
  };

  // Try with bias then without
  for (const url of [ makeUrl(true), makeUrl(false) ]) {
    const r = await fetch(url);
    if (!r.ok) {
      if (r.status === 400 || r.status === 422) continue; // try next attempt
      return { ok:false, status:r.status, error:`HTTP ${r.status}`, tried:qClean };
    }
    const j = await r.json();
    const item = j.items?.[0];
    if (item?.position) {
      return { ok:true, lat:item.position.lat, lng:item.position.lng, title:item.title || qClean };
    }
  }

  // Last resort: Discover (looser)
  const d = new URL('https://discover.search.hereapi.com/v1/discover');
  d.searchParams.set('q', qClean);
  d.searchParams.set('apiKey', HERE_API_KEY);
  d.searchParams.set('limit', '1');
  const rr = await fetch(d.toString());
  if (rr.ok) {
    const jj = await rr.json();
    const it = jj.items?.[0];
    if (it?.position) return { ok:true, lat:it.position.lat, lng:it.position.lng, title:it.title || qClean };
  }

  return { ok:false, status:'ZERO_RESULTS', error:null, tried:qClean };
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
    const prod = s?.transport?.product?.name || s?.tra
