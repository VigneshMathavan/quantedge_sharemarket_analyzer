// server/upstox-oauth.js — 1-click daily token refresh via OAuth.
//
// SEBI mandate: broker access tokens must expire daily by 06:00 IST.
// We can't bypass that. But we CAN reduce the daily ritual from
// "generate token in console → copy → paste into .env → restart"
// to a single browser click.
//
// Flow:
//   1. User clicks 🔑 Refresh button in UI
//   2. Frontend redirects to /api/auth/upstox/login
//   3. We redirect to Upstox OAuth dialog with our client_id + redirect_uri
//   4. User logs in (password + OTP) on Upstox's page — ~10 seconds
//   5. Upstox redirects to /api/auth/upstox/callback?code=XXX
//   6. We POST that code to /v2/login/authorization/token
//   7. Get back access_token, write to .env, hot-reload provider
//   8. Redirect user to home with "Token refreshed ✓" toast

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '.env');

// Reads the .env file as a dict
function readEnv() {
    const out = {};
    if (!fs.existsSync(ENV_PATH)) return out;
    for (const line of fs.readFileSync(ENV_PATH, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

// Writes a single key=value back to .env in-place, preserving everything else.
function writeEnvKey(key, value) {
    if (!fs.existsSync(ENV_PATH)) {
        fs.writeFileSync(ENV_PATH, `${key}=${value}\n`);
        return;
    }
    const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
    let found = false;
    const newLines = lines.map(l => {
        if (l.startsWith(key + '=')) { found = true; return `${key}=${value}`; }
        return l;
    });
    if (!found) newLines.push(`${key}=${value}`);
    fs.writeFileSync(ENV_PATH, newLines.join('\n'));
}

// Mount the OAuth routes onto an Express app.
//   provider — the UpstoxProvider instance to hot-reload after token refresh
//   getBaseUrl — function returning the public URL of the backend (e.g. 'http://localhost:4300')
export function mountUpstoxOAuth(app, provider, getBaseUrl) {

    // Status — does our token(s) look healthy? Never leaks token contents.
    app.get('/api/auth/upstox/status', (req, res) => {
        const env = readEnv();
        const decode = (tk) => {
            if (!tk) return null;
            try {
                const pl = JSON.parse(Buffer.from(tk.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
                const expMs = pl.exp * 1000;
                return {
                    valid: expMs > Date.now(),
                    expiresInMin: Math.round((expMs - Date.now()) / 60000),
                    expiresAt: new Date(expMs).toISOString(),
                    user: pl.sub,
                    isExtended: !!pl.isExtended,
                    isPlusPlan: pl.isPlusPlan
                };
            } catch (e) { return { valid: false, reason: 'malformed' }; }
        };
        const access = decode(env.UPSTOX_ACCESS_TOKEN || '');
        const extended = decode(env.UPSTOX_EXTENDED_TOKEN || '');
        // Combined status — valid if EITHER token works for market data
        const valid = (access?.valid) || (extended?.valid);
        const primary = extended?.valid ? extended : access;
        res.json({
            valid,
            access,
            extended,
            primary,
            expiresInMin: primary?.expiresInMin || 0,
            user: primary?.user,
            refreshUrl: '/api/auth/upstox/login'
        });
    });

    // Step 1 — redirect user to Upstox login dialog
    app.get('/api/auth/upstox/login', (req, res) => {
        const env = readEnv();
        const clientId = env.UPSTOX_API_KEY;
        const redirectUri = `${getBaseUrl()}/api/auth/upstox/callback`;
        if (!clientId) return res.status(400).send('UPSTOX_API_KEY missing in .env');
        const state = Math.random().toString(36).slice(2, 12);
        const url = `https://api.upstox.com/v2/login/authorization/dialog` +
            `?response_type=code` +
            `&client_id=${encodeURIComponent(clientId)}` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&state=${state}`;
        res.redirect(url);
    });

    // Step 2 — Upstox redirects here with ?code=XXX
    app.get('/api/auth/upstox/callback', async (req, res) => {
        const { code, error } = req.query;
        if (error) return res.send(authPage('Login Cancelled', error, false));
        if (!code) return res.send(authPage('No Auth Code', 'Upstox did not return a code', false));

        const env = readEnv();
        const clientId = env.UPSTOX_API_KEY;
        const clientSecret = env.UPSTOX_API_SECRET;
        const redirectUri = `${getBaseUrl()}/api/auth/upstox/callback`;

        try {
            // Step 3 — exchange code for access token
            const body = new URLSearchParams({
                code, client_id: clientId, client_secret: clientSecret,
                redirect_uri: redirectUri, grant_type: 'authorization_code'
            });
            const r = await fetch('https://api.upstox.com/v2/login/authorization/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
                body: body.toString()
            });
            const j = await r.json();
            if (j.status !== 'success' || !j.access_token) {
                throw new Error(JSON.stringify(j).slice(0, 300));
            }
            // Step 4 — write to .env + hot-reload provider in-memory
            writeEnvKey('UPSTOX_ACCESS_TOKEN', j.access_token);
            if (provider && typeof provider.setAccessToken === 'function') {
                provider.setAccessToken(j.access_token);
                console.log('[upstox-oauth] token refreshed in-memory — no restart needed');
            }
            // Step 5 — show success page that auto-closes back to dashboard
            res.send(authPage('✓ Token Refreshed', 'Upstox access token loaded. Redirecting to dashboard...', true));
        } catch (e) {
            console.error('[upstox-oauth] token exchange failed:', e.message);
            res.send(authPage('Token Exchange Failed', e.message, false));
        }
    });
}

function authPage(title, msg, success) {
    const color = success ? '#00d09c' : '#eb5b3c';
    return `<!DOCTYPE html><html><head><title>${title}</title>
<style>
body { font-family: ui-monospace, monospace; background: #0e1119; color: #e8eaed; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
.card { background: #161a23; border: 1px solid ${color}; border-left: 4px solid ${color}; padding: 32px 40px; border-radius: 6px; max-width: 480px; text-align: center; box-shadow: 0 0 24px ${color}40; }
h1 { color: ${color}; font-size: 22px; margin: 0 0 12px 0; letter-spacing: 0.02em; }
.msg { color: #e8eaed; line-height: 1.6; word-break: break-word; font-size: 13px; }
.spinner { margin: 18px auto 0; width: 28px; height: 28px; border: 2px solid #2a3148; border-top-color: ${color}; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.note { margin-top: 14px; font-size: 11px; color: #95a3b8; }
</style></head>
<body><div class="card">
  <h1>${title}</h1>
  <div class="msg">${msg}</div>
  ${success ? '<div class="spinner"></div><div class="note">Window auto-closes in 2s</div>' : ''}
</div>
${success ? '<script>setTimeout(()=>{ try{window.close();}catch(_){} location.href="/"; }, 2000);</script>' : ''}
</body></html>`;
}
