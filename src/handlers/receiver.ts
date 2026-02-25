/**
 * Lambda #1 — "Receiver"
 *
 * Handles all API Gateway HTTP events:
 *   POST /linq-webhook  → validate + enqueue to SQS → return 200 (~50ms)
 *   GET  /auth/setup     → serve onboarding HTML
 *   POST /auth/setup/submit → handle credential submission
 *   GET  /health         → health check
 *
 * This Lambda returns quickly. Heavy processing happens in the Processor Lambda
 * triggered by SQS.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  isMessageReceivedEvent,
  extractTextContent,
  extractImageUrls,
  extractAudioUrls,
} from '../webhook/types.js';
import type { WebhookEvent } from '../webhook/types.js';
import { verifyAuthToken, getAuthTokenChatId } from '../auth/db.js';
import { verifyMagicLinkToken } from '../auth/magicLink.js';
import { setCredentials, createUser, getUser } from '../auth/db.js';
import { sendMessage } from '../linq/client.js';
import { redactPhone } from '../utils/redact.js';

const sqs = new SQSClient({});
const QUEUE_URL = process.env.SQS_QUEUE_URL!;

// Bot numbers / sender filters (same as webhook handler)
const botNumbers = process.env.LINQ_AGENT_BOT_NUMBERS?.split(',').map(p => p.trim()).filter(Boolean) || [];
const ignoredSenders = process.env.IGNORED_SENDERS?.split(',').map(p => p.trim()).filter(Boolean) || [];
const allowedSenders = process.env.ALLOWED_SENDERS?.split(',').map(p => p.trim()).filter(Boolean) || [];

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  console.log(`[receiver] ${method} ${path}`);

  // ── Health check ──────────────────────────────────────────────────────
  if (path === '/health' && method === 'GET') {
    return json(200, { status: 'ok', timestamp: new Date().toISOString() });
  }

  // ── Auth setup page ───────────────────────────────────────────────────
  if (path === '/auth/setup' && method === 'GET') {
    return handleAuthSetupPage(event);
  }

  // ── Auth submit ───────────────────────────────────────────────────────
  if (path === '/auth/setup/submit' && method === 'POST') {
    return handleAuthSubmit(event);
  }

  // ── Webhook ───────────────────────────────────────────────────────────
  if (path === '/linq-webhook' && method === 'POST') {
    return handleWebhook(event);
  }

  return json(404, { error: 'Not found' });
}

// ── Webhook handler (validate + SQS enqueue) ────────────────────────────

async function handleWebhook(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!event.body) return json(400, { error: 'Missing body' });

  let webhookEvent: WebhookEvent;
  try {
    webhookEvent = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body);
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const pstTime = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
  console.log(`[webhook] ${pstTime} PST | ${webhookEvent.event_type} (${webhookEvent.event_id})`);

  // Only process message.received events
  if (!isMessageReceivedEvent(webhookEvent)) {
    return json(200, { received: true });
  }

  const { chat_id, from, recipient_phone, message, is_from_me } = webhookEvent.data;

  // Filter checks (same logic as webhook/handler.ts)
  if (botNumbers.length > 0 && !botNumbers.includes(recipient_phone)) {
    console.log(`[webhook] Skipping message to ${redactPhone(recipient_phone)} (not this bot's number)`);
    return json(200, { received: true });
  }
  if (is_from_me) {
    console.log(`[webhook] Skipping own message`);
    return json(200, { received: true });
  }
  if (allowedSenders.length > 0 && !allowedSenders.includes(from)) {
    console.log(`[webhook] Skipping ${redactPhone(from)} (not in allowed senders)`);
    return json(200, { received: true });
  }
  if (ignoredSenders.includes(from)) {
    console.log(`[webhook] Skipping ${redactPhone(from)} (ignored sender)`);
    return json(200, { received: true });
  }

  const text = extractTextContent(message.parts);
  const images = extractImageUrls(message.parts);
  const audio = extractAudioUrls(message.parts);

  if (!text.trim() && images.length === 0 && audio.length === 0) {
    console.log(`[webhook] Skipping empty message`);
    return json(200, { received: true });
  }

  // Enqueue the validated message for async processing
  await sqs.send(new SendMessageCommand({
    QueueUrl: QUEUE_URL,
    MessageBody: JSON.stringify(webhookEvent),
    MessageGroupId: chat_id, // FIFO: serialize per chat
    MessageDeduplicationId: webhookEvent.event_id,
  }));

  console.log(`[webhook] Enqueued message from ${redactPhone(from)} for processing`);
  return json(200, { received: true });
}

// ── Auth setup page ─────────────────────────────────────────────────────

async function handleAuthSetupPage(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const token = event.queryStringParameters?.token;
  if (!token) {
    return html(400, errorPage('Missing token', 'This link is invalid. Text the agent for a new one.'));
  }

  const phoneNumber = await verifyAuthToken(token);
  if (!phoneNumber) {
    return html(400, errorPage('Link expired', 'This link has expired or already been used. Text the agent to get a new one.'));
  }

  const safeToken = token.replace(/[&<>"'`/\\]/g, '');
  return html(200, onboardingPage(safeToken));
}

// ── Auth submit ─────────────────────────────────────────────────────────

async function handleAuthSubmit(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!event.body) return json(400, { error: 'Missing body' });

  let body: { token?: string; resyAuthToken?: string };
  try {
    body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body);
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const { token, resyAuthToken } = body;
  if (!token || !resyAuthToken) {
    return json(400, { error: 'Missing required fields' });
  }

  const trimmed = resyAuthToken.trim();
  if (trimmed.length < 10 || trimmed.length > 500) {
    return json(400, { error: 'Invalid auth token format.' });
  }

  const chatId = await getAuthTokenChatId(token);
  const phoneNumber = await verifyMagicLinkToken(token);
  if (!phoneNumber) {
    return json(400, { error: 'Invalid or expired token. Text the agent for a new link.' });
  }

  if (!(await getUser(phoneNumber))) {
    await createUser(phoneNumber);
  }

  await setCredentials(phoneNumber, { resyAuthToken: trimmed });
  console.log(`[auth] Credentials saved for ${redactPhone(phoneNumber)}`);

  // Send welcome messages in the background (fire-and-forget within Lambda)
  if (chatId) {
    sendMessage(chatId, `youre all set! your resy account is connected`)
      .then(() => new Promise(resolve => setTimeout(resolve, 800)))
      .then(() => sendMessage(chatId, `i can search restaurants, find open tables, make reservations, and manage your bookings on resy — just text me what you need`))
      .then(() => console.log(`[auth] Welcome messages sent`))
      .catch(err => console.error(`[auth] Failed to send welcome message:`, err));
  }

  return json(200, { success: true });
}

// ── Helpers ──────────────────────────────────────────────────────────────

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
    body: JSON.stringify(body),
  };
}

function html(statusCode: number, body: string): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    },
    body,
  };
}

// ── Inline HTML templates (no static file dependency) ────────────────────

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
    <div class="header-bar"><div class="logo-row"><span class="linq-wordmark">Linq</span></div></div>
    <div class="card"><div class="error-wrap"><h1>${title}</h1><p class="muted">${message}</p></div></div>
    <p class="footer-text">Built on <a href="https://linqapp.com" target="_blank" class="accent-link">Linq</a></p>
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
  <style>${baseStyles()}
    form { display: flex; flex-direction: column; gap: 24px; }
    .field { text-align: left; }
    .field label { display: block; font-size: 11px; font-weight: 500; color: #6b6b6b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
    input { width: 100%; padding: 14px 16px; background: #111111; border: 1px solid #222222; border-radius: 10px; color: #ffffff; font-family: 'SF Mono', monospace; font-size: 13px; outline: none; transition: border-color 0.2s; box-sizing: border-box; }
    input::placeholder { color: #333333; }
    input:focus { border-color: #c8ff00; }
    button[type="submit"] { padding: 16px; background: #c8ff00; color: #0a0a0a; border: none; border-radius: 100px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s, transform 0.1s; margin-top: 4px; }
    button[type="submit"]:hover { background: #b8ef00; }
    button[type="submit"]:active { transform: scale(0.98); }
    button[type="submit"]:disabled { background: #222222; color: #6b6b6b; cursor: not-allowed; }
    .success { display: none; text-align: center; padding: 48px 0; }
    .success .check { width: 56px; height: 56px; border-radius: 50%; background: rgba(200,255,0,0.1); display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; }
    .success h2 { color: #ffffff; font-size: 22px; font-weight: 400; margin: 0 0 8px; }
    .success p { color: #a1a1a1; margin: 0; font-size: 15px; }
    .error-msg { color: #ff4444; font-size: 13px; display: none; text-align: left; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-bar"><div class="logo-row"><span class="linq-wordmark">Linq</span></div></div>
    <div class="card"><div class="card-content">
      <div class="title-section"><h1>Connect Resy</h1><p class="muted">Paste your Resy auth token to enable reservations</p></div>
      <div id="form-section">
        <form id="setup-form" onsubmit="return handleSubmit(event)">
          <div class="field">
            <label for="resyAuthToken">Resy Auth Token</label>
            <input type="text" id="resyAuthToken" name="resyAuthToken" placeholder="eyJ0eX..." required>
            <p class="muted" style="font-size:12px;margin-top:8px;">Open resy.com → DevTools (F12) → Network → copy <code style="color:#c8ff00;">x-resy-auth-token</code> header.</p>
          </div>
          <p class="error-msg" id="error-msg"></p>
          <button type="submit" id="submit-btn">Connect</button>
        </form>
      </div>
      <div class="success" id="success-section">
        <div class="check"><svg viewBox="0 0 24 24" fill="none" stroke="#c8ff00" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></div>
        <h2>You're all set</h2><p>Go back to iMessage and start booking</p>
      </div>
    </div></div>
    <p class="footer-text">Built on <a href="https://linqapp.com" target="_blank" class="accent-link">Linq</a></p>
  </div>
  <script>
    async function handleSubmit(e) {
      e.preventDefault();
      var btn = document.getElementById('submit-btn');
      var errorEl = document.getElementById('error-msg');
      errorEl.style.display = 'none';
      var resyAuthToken = document.getElementById('resyAuthToken').value.trim();
      if (!resyAuthToken) { errorEl.textContent = 'Please enter your Resy auth token'; errorEl.style.display = 'block'; return false; }
      btn.disabled = true; btn.textContent = 'Connecting...';
      try {
        var res = await fetch('/auth/setup/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: '${token}', resyAuthToken: resyAuthToken }) });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Something went wrong');
        document.getElementById('form-section').style.display = 'none';
        document.getElementById('success-section').style.display = 'block';
      } catch (err) { errorEl.textContent = err.message; errorEl.style.display = 'block'; btn.disabled = false; btn.textContent = 'Connect'; }
      return false;
    }
  </script>
</body>
</html>`;
}

function baseStyles(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #ffffff; min-height: 100vh; display: flex; justify-content: center; align-items: flex-start; padding: 0 20px; -webkit-font-smoothing: antialiased; }
    .container { max-width: 560px; width: 100%; }
    .header-bar { display: flex; align-items: center; justify-content: center; padding: 28px 0; border-bottom: 1px solid #222222; margin-bottom: 36px; }
    .logo-row { display: flex; align-items: center; gap: 14px; }
    .linq-wordmark { font-size: 24px; font-weight: 600; letter-spacing: -0.5px; }
    .card { background: #111111; border: 1px solid #222222; border-radius: 16px; overflow: hidden; }
    .card-content { padding: 36px 32px; }
    .title-section { margin-bottom: 28px; }
    h1 { font-size: 24px; font-weight: 400; margin-bottom: 8px; letter-spacing: -0.3px; }
    .muted { color: #a1a1a1; font-size: 15px; line-height: 1.5; }
    .accent-link { color: #c8ff00; text-decoration: none; }
    .accent-link:hover { text-decoration: underline; }
    .footer-text { text-align: center; color: #6b6b6b; font-size: 13px; padding: 24px 0 40px; }
  `;
}
