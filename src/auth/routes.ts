import { Router } from 'express';
import type { Request, Response } from 'express';
import { verifyAuthToken, getAuthTokenChatId } from './db.js';
import { verifyMagicLinkToken } from './magicLink.js';
import { setCredentials, createUser, getUser } from './db.js';
import { sendMessage } from '../linq/client.js';
import { redactPhone } from '../utils/redact.js';

export const authRoutes = Router();

// Rate limiting is handled by API Gateway throttling in Lambda mode.
// For local Express dev, we keep a simple in-memory guard.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_SUBMIT = 5;
const RATE_LIMIT_MAX_PAGE = 15;

function rateLimit(max: number) {
  return (req: Request, res: Response, next: () => void) => {
    // Skip rate limiting inside Lambda (API Gateway handles it)
    if (process.env.AWS_LAMBDA_FUNCTION_NAME) { next(); return; }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${ip}:${req.path}`;
    const now = Date.now();
    const entry = rateLimitMap.get(key);

    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      next();
      return;
    }

    entry.count++;
    if (entry.count > max) {
      console.warn(`[auth] Rate limit hit: ${ip} on ${req.path} (${entry.count}/${max})`);
      res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
      return;
    }

    next();
  };
}

// ── Input Validation ───────────────────────────────────────────────────────

function isValidApiKey(key: string): boolean {
  const trimmed = key.trim();
  return trimmed.length >= 10 && trimmed.length <= 500;
}

// Sanitize token for safe HTML embedding (prevent XSS via token parameter)
function sanitizeForHtml(str: string): string {
  return str.replace(/[&<>"'`/\\]/g, '');
}

// CSP header for onboarding pages
function setPageSecurityHeaders(res: Response): void {
  res.setHeader('Content-Security-Policy', [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
}

/**
 * GET /auth/setup?token={token}
 * Verify the magic link token and serve the onboarding page.
 */
authRoutes.get('/auth/setup', rateLimit(RATE_LIMIT_MAX_PAGE), async (req: Request, res: Response) => {
  const token = req.query.token as string;
  if (!token) {
    setPageSecurityHeaders(res);
    res.status(400).send(errorPage('Missing token', 'This link is invalid. Text the agent for a new one.'));
    return;
  }

  const phoneNumber = await verifyAuthToken(token);
  if (!phoneNumber) {
    setPageSecurityHeaders(res);
    res.status(400).send(errorPage('Link expired', 'This link has expired or already been used. Text the agent to get a new one.'));
    return;
  }

  setPageSecurityHeaders(res);
  res.send(onboardingPage(sanitizeForHtml(token)));
});

/**
 * POST /auth/setup/submit
 * Receive API credentials, encrypt and store them.
 */
authRoutes.post('/auth/setup/submit', rateLimit(RATE_LIMIT_MAX_SUBMIT), async (req: Request, res: Response) => {
  // CSRF defense
  const origin = req.get('Origin') || req.get('Referer') || '';
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  if (origin && !origin.startsWith(baseUrl)) {
    console.warn(`[auth] Blocked cross-origin submit from: ${origin}`);
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const { token, resyAuthToken } = req.body as {
    token?: string;
    resyAuthToken?: string;
  };

  if (!token || !resyAuthToken) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  if (!isValidApiKey(resyAuthToken)) {
    res.status(400).json({ error: 'Invalid auth token format.' });
    return;
  }

  const chatId = await getAuthTokenChatId(token);

  const phoneNumber = await verifyMagicLinkToken(token);
  if (!phoneNumber) {
    res.status(400).json({ error: 'Invalid or expired token. Text the agent for a new link.' });
    return;
  }

  const trimmedToken = resyAuthToken.trim();

  // Ensure user exists
  if (!(await getUser(phoneNumber))) {
    await createUser(phoneNumber);
  }

  // Store encrypted credentials
  await setCredentials(phoneNumber, { resyAuthToken: trimmedToken });

  console.log(`[auth] Credentials saved for ${redactPhone(phoneNumber)}`);
  res.json({ success: true });

  // Send welcome message in the background
  if (chatId) {
    sendMessage(chatId, `youre all set! your resy account is connected`)
      .then(() => {
        const delay = 800 + Math.random() * 400;
        return new Promise(resolve => setTimeout(resolve, delay));
      })
      .then(() => sendMessage(chatId, `i can search restaurants, find open tables, make reservations, and manage your bookings on resy — just text me what you need`))
      .then(() => console.log(`[auth] Welcome messages sent to ${redactPhone(phoneNumber)}`))
      .catch(err => console.error(`[auth] Failed to send welcome message:`, err));
  }
});

// ── HTML Templates ─────────────────────────────────────────────────────────

function errorPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bookings — ${title}</title>
  <style>${baseStyles()}
    .error-wrap { text-align: center; padding: 60px 28px; }
    .error-wrap h1 { font-size: 24px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="container">
    ${headerHTML()}
    <div class="card">
      <div class="error-wrap">
        <h1>${title}</h1>
        <p class="muted">${message}</p>
      </div>
    </div>
    ${footerHTML()}
  </div>
</body>
</html>`;
}

function onboardingPage(token: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bookings — Connect Resy</title>
  <meta property="og:title" content="Connect your Resy account">
  <meta property="og:description" content="Tap to link your Resy account — takes 30 seconds">
  <meta property="og:type" content="website">
  <style>${baseStyles()}
    form { display: flex; flex-direction: column; gap: 24px; }
    .field { text-align: left; }
    .field label {
      display: block; font-size: 11px; font-weight: 500; color: #6b6b6b;
      text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;
      font-family: system-ui, -apple-system, sans-serif;
    }
    input {
      width: 100%; padding: 14px 16px; background: #111111;
      border: 1px solid #222222; border-radius: 10px; color: #ffffff;
      font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px;
      outline: none; transition: border-color 0.2s; box-sizing: border-box;
    }
    input::placeholder { color: #333333; }
    input:focus { border-color: #c8ff00; }
    button[type="submit"] {
      padding: 16px; background: #c8ff00; color: #0a0a0a; border: none;
      border-radius: 100px; font-size: 15px; font-weight: 600; cursor: pointer;
      transition: background 0.2s, transform 0.1s; margin-top: 4px;
      font-family: system-ui, -apple-system, sans-serif;
    }
    button[type="submit"]:hover { background: #b8ef00; }
    button[type="submit"]:active { transform: scale(0.98); }
    button[type="submit"]:disabled { background: #222222; color: #6b6b6b; cursor: not-allowed; }
    .success { display: none; text-align: center; padding: 48px 0; }
    .success .check {
      width: 56px; height: 56px; border-radius: 50%;
      background: rgba(200, 255, 0, 0.1); display: flex;
      align-items: center; justify-content: center; margin: 0 auto 20px;
    }
    .success h2 { color: #ffffff; font-size: 22px; font-weight: 400; margin: 0 0 8px; }
    .success p { color: #a1a1a1; margin: 0; font-size: 15px; }
    .error-msg { color: #ff4444; font-size: 13px; display: none; text-align: left; }
  </style>
</head>
<body>
  <div class="container">
    ${headerHTML()}
    <div class="card">
      <div class="card-content">
        <div class="title-section">
          <h1>Connect Resy</h1>
          <p class="muted">Paste your Resy auth token to enable reservations</p>
        </div>

        <div id="form-section">
          <form id="setup-form" onsubmit="return handleSubmit(event)">
            <div class="field">
              <label for="resyAuthToken">Resy Auth Token</label>
              <input type="text" id="resyAuthToken" name="resyAuthToken" placeholder="eyJ0eX..." required>
              <p class="muted" style="font-size: 12px; margin-top: 8px;">Open resy.com, sign in, then open DevTools (F12) → Network tab → look for any request to api.resy.com and copy the <code style="color: #c8ff00;">x-resy-auth-token</code> header value.</p>
            </div>
            <p class="error-msg" id="error-msg"></p>
            <button type="submit" id="submit-btn">Connect</button>
          </form>
        </div>

        <div class="success" id="success-section">
          <div class="check">
            <svg viewBox="0 0 24 24" fill="none" stroke="#c8ff00" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
          <h2>You're all set</h2>
          <p>Go back to iMessage and start booking</p>
        </div>
      </div>
    </div>
    ${footerHTML()}
  </div>

  <script>
    async function handleSubmit(e) {
      e.preventDefault();
      const btn = document.getElementById('submit-btn');
      const errorEl = document.getElementById('error-msg');
      errorEl.style.display = 'none';

      const resyAuthToken = document.getElementById('resyAuthToken').value.trim();
      if (!resyAuthToken) {
        errorEl.textContent = 'Please enter your Resy auth token';
        errorEl.style.display = 'block';
        return false;
      }

      btn.disabled = true;
      btn.textContent = 'Connecting...';

      try {
        const res = await fetch('/auth/setup/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: '${token}', resyAuthToken }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Something went wrong');

        document.getElementById('form-section').style.display = 'none';
        document.getElementById('success-section').style.display = 'block';
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Connect';
      }
      return false;
    }
  </script>
</body>
</html>`;
}

function headerHTML(): string {
  return `
    <div class="header-bar">
      <div class="logo-row">
        <span class="linq-wordmark">Linq</span>
      </div>
    </div>`;
}

function footerHTML(): string {
  return `
    <p class="footer-text">
      Built on <a href="https://linqapp.com" target="_blank" class="accent-link">Linq</a>
    </p>`;
}

function baseStyles(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0a0a0a; color: #ffffff; min-height: 100vh;
      display: flex; justify-content: center; align-items: flex-start;
      padding: 0 20px; -webkit-font-smoothing: antialiased;
    }
    .container { max-width: 560px; width: 100%; }
    .header-bar {
      display: flex; align-items: center; justify-content: center;
      padding: 28px 0; border-bottom: 1px solid #222222; margin-bottom: 36px;
    }
    .logo-row { display: flex; align-items: center; gap: 14px; }
    .linq-wordmark { font-size: 24px; font-weight: 600; letter-spacing: -0.5px; }
    .card {
      background: #111111; border: 1px solid #222222;
      border-radius: 16px; overflow: hidden;
    }
    .card-content { padding: 36px 32px; }
    .title-section { margin-bottom: 28px; }
    h1 { font-size: 24px; font-weight: 400; margin-bottom: 8px; letter-spacing: -0.3px; }
    .muted { color: #a1a1a1; font-size: 15px; line-height: 1.5; }
    .accent-link { color: #c8ff00; text-decoration: none; }
    .accent-link:hover { text-decoration: underline; }
    .footer-text {
      text-align: center; color: #6b6b6b; font-size: 13px; padding: 24px 0 40px;
    }
  `;
}
