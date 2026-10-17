// Cloudflare Worker: a read-only CORS proxy for TGJU's live feed.
//
// The live feed (https://call1.tgju.org/ajax.json) has the intraday price and time
// (`ts`) of coins, gold, oil and the TEDPIX index, but it sends no CORS header, so a
// browser cannot read it. This Worker fetches it server-side and returns it with
// CORS for the site's own origins. It stores nothing and needs no secret.
//
// Deploy: Cloudflare dashboard > Workers & Pages > Create > Hello World > Edit code,
// paste this file, Deploy. The URL looks like https://tgju-proxy.<account>.workers.dev

const UPSTREAM = 'https://call1.tgju.org/ajax.json';
const ALLOWED_ORIGINS = new Set([
  'https://fanisani.ir',
  'https://www.fanisani.ir',
  'http://127.0.0.1:8097', // local preview (run-local.bat)
  'http://localhost:8097',
]);
// Only the symbols the site uses are returned (the full feed is ~176 KB; these are ~1 KB).
const SYMBOLS = ['sekee', 'nim', 'rob', 'geram18', 'price_dollar_rl', 'oil_brent', 'bourse', 'ons'];
const MAX_AGE_S = 5;       // the Worker caches for 5 s, so many visitors share one upstream call
const TIMEOUT_MS = 6000;

function corsHeaders(origin) {
  const h = { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Vary': 'Origin' };
  if (origin && ALLOWED_ORIGINS.has(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405, headers: corsHeaders(origin) });
    }
    if (url.pathname !== '/' && url.pathname !== '/ajax.json') {
      return new Response('not found', { status: 404, headers: corsHeaders(origin) });
    }

    let upstream;
    try {
      upstream = await fetch(UPSTREAM, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cf: { cacheTtl: MAX_AGE_S, cacheEverything: true },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'upstream unreachable' }), {
        status: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
      });
    }
    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: `upstream ${upstream.status}` }), {
        status: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
      });
    }

    let body;
    try {
      const full = await upstream.json();
      const current = {};
      for (const sym of SYMBOLS) if (full?.current?.[sym]) current[sym] = full.current[sym];
      body = JSON.stringify({ current });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'upstream not json' }), {
        status: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
      });
    }
    return new Response(request.method === 'HEAD' ? null : body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${MAX_AGE_S}`,
        ...corsHeaders(origin),
      },
    });
  },
};
