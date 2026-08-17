// Cloudflare Pages Advanced Mode Worker
// Gates public report URLs based on visibility settings stored in KV.
// The internal dashboard toggles call the API endpoints below.

// Reports that can be toggled between public and internal-only.
// Keys are the KV slug, values are the public URL prefix to gate.
const GATED_REPORTS = {
  'hr-report': '/hr-report/',
  'hr-report-v2': '/hr-report-v2/',
  'retail-banking-report': '/retail-banking-report/',
  'retail-banking-report-v2': '/retail-banking-report-v2/',
  'maze-retail-banking-report': '/maze/retail-banking-report/',
  'maze-hr-report': '/maze/hr-report/',
  'uk-neobanks-report': '/uk-neobanks-report/',
  'maze-uk-neobanks-report': '/maze/uk-neobanks-report/',
  'intercom-fin-report': '/intercom-fin-report/',
  'maze-intercom-fin-report': '/maze/intercom-fin-report/',
  'retinol-switching-report': '/retinol-switching-report/',
  'maze-retinol-switching-report': '/maze/retinol-switching-report/',
  'applied-genai-report': '/applied-genai-report/',
};

// Reports that default to public when no KV flag has been set yet.
// The dashboard toggle still takes precedence once a flag has been
// written explicitly, but without this set a brand-new slug would
// 404 on first load until someone opens the internal dashboard.
const DEFAULT_PUBLIC_REPORTS = new Set([
  'maze-retail-banking-report',
  'maze-hr-report',
  'maze-uk-neobanks-report',
  'maze-intercom-fin-report',
  'maze-retinol-switching-report',
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- Calendar Sync API (handled in a separate module) ---
    if (url.pathname.startsWith('/internal/api/calendar-sync/')) {
      return handleCalendarSync(request, env, url);
    }

    // --- API: read all visibility flags ---
    if (url.pathname === '/internal/api/visibility' && request.method === 'GET') {
      const raw = env.REPORT_VISIBILITY
        ? await env.REPORT_VISIBILITY.get('config')
        : null;
      const visibility = raw ? JSON.parse(raw) : {};
      return new Response(JSON.stringify(visibility), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // --- API: update a single report's visibility ---
    if (url.pathname === '/internal/api/visibility' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { slug, isPublic } = body;
        if (!slug || typeof isPublic !== 'boolean') {
          return new Response(JSON.stringify({ error: 'Invalid request. Need slug (string) and isPublic (boolean).' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const raw = env.REPORT_VISIBILITY
          ? await env.REPORT_VISIBILITY.get('config')
          : null;
        const visibility = raw ? JSON.parse(raw) : {};
        visibility[slug] = isPublic;
        await env.REPORT_VISIBILITY.put('config', JSON.stringify(visibility));
        return new Response(JSON.stringify({ ok: true, visibility }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // --- Gate public report URLs ---
    let isGatedReport = false;
    for (const [slug, prefix] of Object.entries(GATED_REPORTS)) {
      if (url.pathname === prefix || url.pathname.startsWith(prefix)) {
        isGatedReport = true;
        // If KV isn't bound, fail open (serve the page)
        if (!env.REPORT_VISIBILITY) break;
        const raw = await env.REPORT_VISIBILITY.get('config');
        const visibility = raw ? JSON.parse(raw) : {};
        // Treat slugs in DEFAULT_PUBLIC_REPORTS as public unless they have been
        // explicitly flipped off in KV. `slug in visibility` distinguishes
        // "never toggled" from "explicitly set to false".
        const explicitlySet = Object.prototype.hasOwnProperty.call(visibility, slug);
        const isPublic = explicitlySet
          ? Boolean(visibility[slug])
          : DEFAULT_PUBLIC_REPORTS.has(slug);
        if (!isPublic) {
          // Report is not toggled public, return 404
          return new Response(
            '<!DOCTYPE html><html><head><title>Not Found</title></head>' +
            '<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#faf9f7">' +
            '<div style="text-align:center"><h1 style="color:#1a1a1a;font-size:2rem">Page not found</h1>' +
            '<p style="color:#666">This page is not currently available.</p>' +
            '<a href="/" style="color:#c44b2d;text-decoration:none">Back to BuyerVoice.AI</a></div></body></html>',
            {
              status: 404,
              headers: {
                'Content-Type': 'text/html;charset=UTF-8',
                'Cache-Control': 'no-store, must-revalidate',
              },
            }
          );
        }
        // Report is public — fall through to serve static asset
        break;
      }
    }

    // --- Serve static asset (possibly with no-cache headers for gated reports) ---
    const assetResponse = await env.ASSETS.fetch(request);
    if (isGatedReport) {
      // Rewrite cache headers so no CDN edge, browser, or LLM-fetch cache
      // pins an old response. Visibility can flip public<->internal at any
      // time, so every request must revalidate.
      const newHeaders = new Headers(assetResponse.headers);
      newHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      newHeaders.set('Pragma', 'no-cache');
      newHeaders.set('Expires', '0');
      newHeaders.set('CDN-Cache-Control', 'no-store');
      newHeaders.set('Cloudflare-CDN-Cache-Control', 'no-store');
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers: newHeaders,
      });
    }
    return assetResponse;
  },
};

// ============================================================================
// Calendar Sync API
// ----------------------------------------------------------------------------
// Routes (all under /internal/api/calendar-sync/, gated by Cloudflare Access):
//   GET  /status              -> connection state, settings, recent log
//   GET  /oauth/start?account=bike|buyer  -> redirects to Google's consent screen
//   GET  /oauth/callback?code=...&state=...  -> finalizes OAuth, stores tokens
//   POST /toggle              -> body { enabled: boolean }
//   POST /disconnect          -> body { account: 'bike'|'buyer' }
//   POST /run-now             -> proxies to the cron worker's /run endpoint
//
// Bindings required on the Pages project:
//   DB                  D1 database
//   GOOGLE_CLIENT_ID    plaintext env var
//   GOOGLE_CLIENT_SECRET   secret
//   OAUTH_REDIRECT_URI  plaintext env var (e.g. https://buyervoice.ai/internal/api/calendar-sync/oauth/callback)
//   CRON_WORKER_URL     plaintext env var (e.g. https://buyervoice-calendar-sync.<subdomain>.workers.dev)
//   RUN_NOW_SECRET      secret (must match the value set on the cron worker)
// ============================================================================

const CAL_SYNC_PREFIX = '/internal/api/calendar-sync';
const VALID_ACCOUNTS = new Set(['bike', 'buyer']);
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

async function handleCalendarSync(request, env, url) {
  if (!env.DB) {
    return jsonResponse({ error: 'D1 database not bound. Run wrangler d1 create + bind to Pages.' }, 500);
  }
  const path = url.pathname.slice(CAL_SYNC_PREFIX.length); // '/status', '/oauth/start', etc.

  try {
    if (path === '/status' && request.method === 'GET') return calStatus(env);
    if (path === '/oauth/start' && request.method === 'GET') return calOAuthStart(env, url);
    if (path === '/oauth/callback' && request.method === 'GET') return calOAuthCallback(env, url, request);
    if (path === '/toggle' && request.method === 'POST') return calToggle(env, request);
    if (path === '/disconnect' && request.method === 'POST') return calDisconnect(env, request);
    if (path === '/run-now' && request.method === 'POST') return calRunNow(env);
    return jsonResponse({ error: 'Not found' }, 404);
  } catch (e) {
    return jsonResponse({ error: String(e.message || e) }, 500);
  }
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

// A sync that has not completed successfully in this many seconds is treated as
// broken. The cron fires every 3 minutes, so this tolerates 5 consecutive
// missed or failed runs before the dashboard goes red.
const CAL_STALE_AFTER_SECONDS = 15 * 60;

async function calStatus(env) {
  const accountsRows = await env.DB
    .prepare('SELECT id, email, sync_token, last_synced_at, last_error, connected_at FROM accounts')
    .all();
  const accounts = {};
  for (const r of accountsRows.results || []) {
    accounts[r.id] = {
      email: r.email,
      connected_at: r.connected_at,
      last_synced_at: r.last_synced_at,
      last_error: r.last_error,
      has_sync_token: Boolean(r.sync_token),
    };
  }
  const enabledRow = await env.DB.prepare("SELECT value FROM settings WHERE key='sync_enabled'").first();
  const sync_enabled = enabledRow ? enabledRow.value === 'true' : false;

  const settingsRes = await env.DB
    .prepare("SELECT key, value FROM settings WHERE key IN ('last_run_at','last_run_success_at','last_run_event_errors')")
    .all();
  const settings = {};
  for (const r of settingsRes.results || []) settings[r.key] = Number(r.value) || null;

  const now = Math.floor(Date.now() / 1000);
  const lastSuccess = settings.last_run_success_at || null;
  const ageSeconds = lastSuccess ? now - lastSuccess : null;
  const connectedCount = Object.keys(accounts).length;
  const firstError = Object.values(accounts).find((a) => a.last_error);

  // Single source of truth for "is this thing actually working right now",
  // computed server-side so the dashboard badge and the tool page agree.
  const eventErrors = settings.last_run_event_errors || 0;

  let state;
  if (!sync_enabled) state = 'paused';
  else if (connectedCount < 2) state = 'error';
  else if (firstError) state = 'error';
  else if (lastSuccess === null) state = 'never_run';
  else if (ageSeconds > CAL_STALE_AFTER_SECONDS) state = 'stale';
  // The run itself succeeded but some individual events would not mirror.
  // Surfaced as its own state so a partial failure cannot hide behind a
  // green badge, without paging on every 3-minute tick.
  else if (eventErrors > 0) state = 'degraded';
  else state = 'ok';

  const health = {
    state,
    healthy: state === 'ok' || state === 'paused',
    last_run_at: settings.last_run_at || null,
    last_success_at: lastSuccess,
    age_seconds: ageSeconds,
    stale_after_seconds: CAL_STALE_AFTER_SECONDS,
    accounts_connected: connectedCount,
    event_errors: eventErrors,
    detail:
      state === 'paused'
        ? 'Sync is switched off'
        : state === 'error'
        ? (firstError && firstError.last_error) || 'An account is not connected'
        : state === 'never_run'
        ? 'No successful run recorded yet'
        : state === 'stale'
        ? 'No successful sync recently'
        : state === 'degraded'
        ? `${eventErrors} event(s) failed to mirror on the last run. See the log on /internal/calendar-sync/.`
        : 'Syncing normally',
  };

  const logRes = await env.DB
    .prepare('SELECT id, ts, level, account, message, details FROM sync_log ORDER BY ts DESC LIMIT 50')
    .all();

  return jsonResponse({
    sync_enabled,
    health,
    accounts,
    log: logRes.results || [],
    config: {
      bike_account_label: 'forest.on.bike@gmail.com (bike)',
      buyer_account_label: 'forest.baker@buyervoice.ai (buyer)',
      title_prefix_bike_to_buyer: 'PER ',
      title_prefix_buyer_to_bike: 'WRK ',
    },
  });
}

async function calOAuthStart(env, url) {
  const account = url.searchParams.get('account');
  if (!VALID_ACCOUNTS.has(account)) {
    return jsonResponse({ error: 'account must be "bike" or "buyer"' }, 400);
  }
  if (!env.GOOGLE_CLIENT_ID || !env.OAUTH_REDIRECT_URI) {
    return jsonResponse({ error: 'GOOGLE_CLIENT_ID and OAUTH_REDIRECT_URI must be set on the Pages project.' }, 500);
  }
  const nonce = crypto.randomUUID();
  const state = base64urlEncode(JSON.stringify({ account, nonce }));
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',                  // forces refresh_token on every connect
    state,
    login_hint: account === 'bike' ? 'forest.on.bike@gmail.com' : 'forest.baker@buyervoice.ai',
  });
  const cookie = `bv_cs_nonce=${nonce}; Path=/internal/api/calendar-sync; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${GOOGLE_AUTH_URL}?${params}`,
      'Set-Cookie': cookie,
    },
  });
}

async function calOAuthCallback(env, url, request) {
  const code = url.searchParams.get('code');
  const stateRaw = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    return htmlResponse(`<h1>Google OAuth error</h1><p>${escapeHtml(oauthError)}</p><p><a href="/internal/calendar-sync/">Back</a></p>`, 400);
  }
  if (!code || !stateRaw) return jsonResponse({ error: 'Missing code or state' }, 400);

  let state;
  try {
    state = JSON.parse(base64urlDecode(stateRaw));
  } catch {
    return jsonResponse({ error: 'Bad state' }, 400);
  }
  if (!VALID_ACCOUNTS.has(state.account)) return jsonResponse({ error: 'Bad account in state' }, 400);

  const cookieNonce = parseCookie(request.headers.get('Cookie') || '', 'bv_cs_nonce');
  if (!cookieNonce || cookieNonce !== state.nonce) {
    return jsonResponse({ error: 'State/nonce mismatch (try Connect again)' }, 400);
  }

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.OAUTH_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok) {
    return htmlResponse(`<h1>Token exchange failed</h1><pre>${escapeHtml(JSON.stringify(tokens, null, 2))}</pre>`, 500);
  }

  if (!tokens.refresh_token) {
    // Happens if user previously authorized this client and Google decided not
    // to issue a new refresh token. We force prompt=consent on /start to avoid
    // this, but if it still happens, ask the user to revoke and retry.
    return htmlResponse(
      `<h1>No refresh token returned</h1>
       <p>Google didn't issue a refresh token. Visit
       <a href="https://myaccount.google.com/connections" target="_blank">myaccount.google.com/connections</a>,
       remove the BuyerVoice calendar-sync app, and click Connect again.</p>
       <p><a href="/internal/calendar-sync/">Back</a></p>`,
      400
    );
  }

  // Look up the email so the UI can display it
  const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const userInfo = await userInfoRes.json();
  const email = userInfo.email || '(unknown)';

  // Sanity-check the account picked vs the email returned
  const expectedDomain = state.account === 'bike' ? 'gmail.com' : 'buyervoice.ai';
  if (!email.toLowerCase().endsWith('@' + expectedDomain)) {
    return htmlResponse(
      `<h1>Wrong Google account</h1>
       <p>You picked the <strong>${state.account}</strong> slot but signed in as <strong>${escapeHtml(email)}</strong>.</p>
       <p>Expected a @${expectedDomain} address. Please <a href="/internal/calendar-sync/">go back</a> and Connect again with the right account.</p>`,
      400
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + (tokens.expires_in || 3600);

  // Upsert the account and clear any prior sync state so the next run backfills.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM accounts WHERE id=?').bind(state.account),
    env.DB
      .prepare(
        `INSERT INTO accounts (id, email, refresh_token, access_token, token_expires_at, connected_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(state.account, email, tokens.refresh_token, tokens.access_token, expiresAt, now),
    env.DB
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, 'false')
         ON CONFLICT(key) DO UPDATE SET value='false'`
      )
      .bind(`backfill_done_${state.account}`),
    env.DB
      .prepare(
        `INSERT INTO sync_log (ts, level, account, message) VALUES (?, 'info', ?, ?)`
      )
      .bind(now, state.account, `Connected ${email}`),
  ]);

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/internal/calendar-sync/?connected=' + state.account,
      'Set-Cookie': 'bv_cs_nonce=; Path=/internal/api/calendar-sync; Max-Age=0',
    },
  });
}

async function calToggle(env, request) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad JSON' }, 400); }
  if (typeof body.enabled !== 'boolean') return jsonResponse({ error: 'enabled must be boolean' }, 400);
  await env.DB
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('sync_enabled', ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    )
    .bind(body.enabled ? 'true' : 'false')
    .run();
  const now = Math.floor(Date.now() / 1000);
  await env.DB
    .prepare(`INSERT INTO sync_log (ts, level, account, message) VALUES (?, 'info', NULL, ?)`)
    .bind(now, body.enabled ? 'Sync enabled' : 'Sync disabled')
    .run();
  return jsonResponse({ ok: true, sync_enabled: body.enabled });
}

async function calDisconnect(env, request) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad JSON' }, 400); }
  if (!VALID_ACCOUNTS.has(body.account)) return jsonResponse({ error: 'account must be "bike" or "buyer"' }, 400);
  // Best-effort revoke at Google
  const acct = await env.DB.prepare('SELECT refresh_token FROM accounts WHERE id=?').bind(body.account).first();
  if (acct && acct.refresh_token) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(acct.refresh_token)}`, { method: 'POST' });
    } catch { /* ignore */ }
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM accounts WHERE id=?').bind(body.account),
    env.DB.prepare('DELETE FROM event_links WHERE source_account=? OR target_account=?').bind(body.account, body.account),
    env.DB.prepare('DELETE FROM settings WHERE key=?').bind(`backfill_done_${body.account}`),
  ]);
  const now = Math.floor(Date.now() / 1000);
  await env.DB
    .prepare(`INSERT INTO sync_log (ts, level, account, message) VALUES (?, 'info', ?, 'Disconnected')`)
    .bind(now, body.account)
    .run();
  return jsonResponse({ ok: true });
}

async function calRunNow(env) {
  if (!env.CRON_WORKER_URL || !env.RUN_NOW_SECRET) {
    return jsonResponse({ error: 'CRON_WORKER_URL and RUN_NOW_SECRET must be set on the Pages project.' }, 500);
  }
  const res = await fetch(`${env.CRON_WORKER_URL.replace(/\/$/, '')}/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RUN_NOW_SECRET}` },
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ---------- small helpers ----------

function htmlResponse(html, status = 200) {
  return new Response(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:640px;margin:4rem auto;padding:0 1rem;color:#1A1A1A">${html}</body>`, {
    status,
    headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function base64urlEncode(s) {
  // s is a string
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function parseCookie(header, name) {
  const parts = header.split(/;\s*/);
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0 && p.slice(0, eq) === name) return decodeURIComponent(p.slice(eq + 1));
  }
  return null;
}
