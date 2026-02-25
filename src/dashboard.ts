/**
 * Bookings Agent Dashboard
 *
 * Local monitoring dashboard — system health, logs, signups, errors.
 * Uses Linq frontend design system (Geist, dark theme, #C4FF20 accent).
 *
 * Usage: npm run dashboard → http://localhost:3001
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  DescribeLogStreamsCommand,
} from '@aws-sdk/client-cloudwatch-logs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3001;
const TABLE_NAME = process.env.DYNAMODB_TABLE || 'bookings-agent';
const REGION = 'us-east-1';
const LOG_GROUPS = [
  '/aws/lambda/bookings-agent-receiver',
  '/aws/lambda/bookings-agent-processor',
];

const ddb = new DynamoDBClient({ region: REGION });
const cwl = new CloudWatchLogsClient({ region: REGION });

// Serve static logos
app.use('/images', express.static(path.join(__dirname, '..', 'public', 'images')));

function redactPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  return '***' + phone.slice(-4);
}

function classifyError(msg: string): string {
  if (/resy|api\.resy/i.test(msg)) return 'resy';
  if (/claude|anthropic/i.test(msg)) return 'claude';
  if (/dynamodb|ddb/i.test(msg)) return 'dynamo';
  if (/timeout|ETIMEDOUT|ECONNRESET/i.test(msg)) return 'timeout';
  if (/sqs|queue/i.test(msg)) return 'sqs';
  if (/auth|token|credentials/i.test(msg)) return 'auth';
  return 'system';
}

// ── API Routes ───────────────────────────────────────────────────────────────

app.get('/api/stats', async (_req, res) => {
  try {
    const scan = await ddb.send(new ScanCommand({ TableName: TABLE_NAME }));
    const items = (scan.Items ?? []).map((i) => unmarshall(i));

    const totalUsers = items.filter((i) => i.SK === 'PROFILE').length;
    const connected = items.filter((i) => i.SK === 'CREDENTIALS').length;

    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const activeToday = items.filter(
      (i) => i.SK === 'PROFILE' && i.lastActive && new Date(i.lastActive).getTime() > dayAgo,
    ).length;

    // Total texts from CHATCOUNT records
    const totalTexts = items
      .filter((i) => i.SK === 'CHATCOUNT')
      .reduce((sum, i) => sum + (Number(i.count) || 0), 0);

    // Reservations booked — scan CloudWatch for booking confirmations
    let reservationsBooked = 0;
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const logGroup of LOG_GROUPS) {
      try {
        const resp = await cwl.send(
          new FilterLogEventsCommand({
            logGroupName: logGroup,
            startTime: weekAgo,
            filterPattern: '"resy_token"',
            limit: 100,
          }),
        );
        reservationsBooked += resp.events?.length ?? 0;
      } catch { /* log group may not exist */ }
    }

    // Errors in last 24h
    let errorCount = 0;
    for (const logGroup of LOG_GROUPS) {
      try {
        const resp = await cwl.send(
          new FilterLogEventsCommand({
            logGroupName: logGroup,
            startTime: dayAgo,
            filterPattern: 'ERROR',
            limit: 100,
          }),
        );
        errorCount += resp.events?.length ?? 0;
      } catch { /* log group may not exist */ }
    }

    // Uptime — check last log event timestamps
    let lastReceiverEvent = 0;
    let lastProcessorEvent = 0;
    for (const logGroup of LOG_GROUPS) {
      try {
        const resp = await cwl.send(
          new DescribeLogStreamsCommand({
            logGroupName: logGroup,
            orderBy: 'LastEventTime',
            descending: true,
            limit: 1,
          }),
        );
        const lastEvent = resp.logStreams?.[0]?.lastEventTimestamp ?? 0;
        if (logGroup.includes('receiver')) lastReceiverEvent = lastEvent;
        else lastProcessorEvent = lastEvent;
      } catch { /* log group may not exist */ }
    }

    res.json({
      totalUsers,
      activeToday,
      connected,
      totalTexts,
      reservationsBooked,
      errorCount,
      lastReceiverEvent,
      lastProcessorEvent,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logs', async (req, res) => {
  try {
    const minutes = parseInt(req.query.minutes as string) || 30;
    const startTime = Date.now() - minutes * 60 * 1000;
    const allEvents: any[] = [];

    for (const logGroup of LOG_GROUPS) {
      try {
        const resp = await cwl.send(
          new FilterLogEventsCommand({ logGroupName: logGroup, startTime, limit: 200 }),
        );
        const source = logGroup.includes('receiver') ? 'receiver' : 'processor';
        for (const evt of resp.events ?? []) {
          allEvents.push({ timestamp: evt.timestamp, message: (evt.message ?? '').trim(), source });
        }
      } catch { /* log group may not exist */ }
    }

    allEvents.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    res.json(allEvents.slice(0, 300));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/signups', async (_req, res) => {
  try {
    const scan = await ddb.send(new ScanCommand({ TableName: TABLE_NAME }));
    const items = (scan.Items ?? []).map((i) => unmarshall(i));

    const profiles = items
      .filter((i) => i.SK === 'PROFILE')
      .map((p) => ({
        phone: redactPhone(String(p.PK).replace('USER#', '')),
        createdAt: p.createdAt ?? null,
        name: p.name ?? null,
        hasCredentials: items.some((i) => i.PK === p.PK && i.SK === 'CREDENTIALS'),
      }))
      .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());

    res.json(profiles);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/errors', async (_req, res) => {
  try {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const allErrors: any[] = [];

    for (const logGroup of LOG_GROUPS) {
      try {
        const resp = await cwl.send(
          new FilterLogEventsCommand({
            logGroupName: logGroup,
            startTime: dayAgo,
            filterPattern: 'ERROR',
            limit: 50,
          }),
        );
        const source = logGroup.includes('receiver') ? 'receiver' : 'processor';
        for (const evt of resp.events ?? []) {
          const msg = (evt.message ?? '').trim();
          allErrors.push({
            timestamp: evt.timestamp,
            message: msg,
            source,
            type: classifyError(msg),
          });
        }
      } catch { /* log group may not exist */ }
    }

    allErrors.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    res.json(allErrors);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── HTML Dashboard ───────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.type('html').send(/* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bookings Agent — Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Geist', -apple-system, sans-serif;
      background: #0A0A0A;
      color: #FFFFFF;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
      letter-spacing: 0.01em;
    }

    /* ── Header ─────────────────────────────────────────── */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 2rem;
      border-bottom: 1px solid #1F1F1F;
      background: #0E0E0E;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .header-left img.logo { height: 22px; opacity: 0.9; }
    .header-left .divider {
      width: 1px;
      height: 20px;
      background: #333;
    }
    .header-left img.resy-logo { height: 20px; border-radius: 4px; }
    .header h1 {
      font-size: 1rem;
      font-weight: 500;
      color: #E7E7E7;
      margin-left: 0.25rem;
    }
    .header-right {
      display: flex;
      align-items: center;
      gap: 1.25rem;
    }
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #1EB01E;
      box-shadow: 0 0 6px #1EB01E80;
      display: inline-block;
    }
    .status-dot.degraded { background: #FFB800; box-shadow: 0 0 6px #FFB80080; }
    .status-dot.down { background: #E62200; box-shadow: 0 0 6px #E6220080; }
    .header-right .refresh-info {
      font-size: 0.75rem;
      color: #666;
      font-weight: 400;
    }

    /* ── Layout ─────────────────────────────────────────── */
    .container { padding: 1.5rem 2rem; max-width: 1440px; margin: 0 auto; }

    /* ── Stats Grid ─────────────────────────────────────── */
    .stats-row {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 0.75rem;
      margin-bottom: 1.5rem;
    }
    .stat-card {
      background: #141414;
      border: 1px solid #1F1F1F;
      border-radius: 12px;
      padding: 1.125rem 1.25rem;
      transition: border-color 0.15s;
    }
    .stat-card:hover { border-color: #333; }
    .stat-card .label {
      font-size: 0.6875rem;
      font-weight: 500;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 0.5rem;
    }
    .stat-card .value {
      font-size: 1.75rem;
      font-weight: 600;
      color: #E7E7E7;
      line-height: 1;
    }
    .stat-card .value.accent { color: #C4FF20; }
    .stat-card .value.red { color: #E62200; }
    .stat-card .sub {
      font-size: 0.6875rem;
      color: #4F4F4F;
      margin-top: 0.35rem;
    }

    /* ── Section Headers ────────────────────────────────── */
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.625rem;
    }
    .section-header h2 {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #666;
    }
    .time-filters {
      display: flex;
      gap: 0.25rem;
      background: #141414;
      border-radius: 8px;
      padding: 2px;
      border: 1px solid #1F1F1F;
    }
    .time-filters button {
      background: transparent;
      border: none;
      color: #666;
      padding: 0.25rem 0.625rem;
      border-radius: 6px;
      font-family: 'Geist', sans-serif;
      font-size: 0.6875rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }
    .time-filters button:hover { color: #9B9B9B; }
    .time-filters button.active {
      background: #1F1F1F;
      color: #E7E7E7;
    }

    /* ── Cards ──────────────────────────────────────────── */
    .card {
      background: #141414;
      border: 1px solid #1F1F1F;
      border-radius: 12px;
      overflow: hidden;
    }

    /* ── Uptime Module ──────────────────────────────────── */
    .uptime-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
      margin-bottom: 1.5rem;
    }
    .uptime-card {
      background: #141414;
      border: 1px solid #1F1F1F;
      border-radius: 12px;
      padding: 1rem 1.25rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .uptime-card .fn-name {
      font-size: 0.8125rem;
      font-weight: 500;
      color: #E7E7E7;
    }
    .uptime-card .fn-label {
      font-size: 0.6875rem;
      color: #4F4F4F;
      margin-top: 0.15rem;
    }
    .uptime-card .fn-status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .uptime-card .fn-status .last-seen {
      font-size: 0.6875rem;
      color: #666;
      font-family: 'Geist Mono', monospace;
    }

    /* ── Log Feed ───────────────────────────────────────── */
    .log-feed {
      max-height: 340px;
      overflow-y: auto;
      padding: 0.75rem 1rem;
      font-family: 'Geist Mono', monospace;
      font-size: 0.75rem;
      line-height: 1.7;
    }
    .log-feed::-webkit-scrollbar { width: 5px; }
    .log-feed::-webkit-scrollbar-track { background: transparent; }
    .log-feed::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
    .log-line { white-space: pre-wrap; word-break: break-all; }
    .log-line .ts { color: #4F4F4F; }
    .log-line .src { color: #C4FF20; font-weight: 500; }
    .log-line.error { color: #E62200; }
    .log-line.error .src { color: #E62200; }
    .log-line.timing { color: #1EB01E; }
    .log-line.resy { color: #9B9B9B; }
    .log-line.default { color: #666; }

    /* ── Bottom Grid ────────────────────────────────────── */
    .bottom-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
      margin-top: 1.5rem;
    }

    /* ── Signups Table ──────────────────────────────────── */
    table { width: 100%; border-collapse: collapse; }
    th {
      text-align: left;
      font-size: 0.625rem;
      font-weight: 600;
      color: #4F4F4F;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid #1F1F1F;
    }
    td {
      padding: 0.6rem 1rem;
      font-size: 0.8125rem;
      border-bottom: 1px solid #1A1A1A;
      color: #9B9B9B;
    }
    .badge {
      display: inline-block;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.6875rem;
      font-weight: 500;
    }
    .badge.connected { background: #1EB01E18; color: #1EB01E; }
    .badge.pending   { background: #FFB80018; color: #FFB800; }

    /* ── Error Cards ────────────────────────────────────── */
    .errors-list { padding: 0.5rem; }
    .error-card {
      background: #1A1A1A;
      border: 1px solid #262626;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      margin-bottom: 0.5rem;
    }
    .error-card:last-child { margin-bottom: 0; }
    .error-card-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.4rem;
    }
    .error-tag {
      display: inline-block;
      padding: 0.125rem 0.4rem;
      border-radius: 4px;
      font-size: 0.625rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      background: #E6220015;
      color: #E62200;
      border: 1px solid #E6220030;
    }
    .error-tag.resy { background: #FFB80015; color: #FFB800; border-color: #FFB80030; }
    .error-tag.claude { background: #A737FF15; color: #A737FF; border-color: #A737FF30; }
    .error-tag.timeout { background: #FF603415; color: #FF6034; border-color: #FF603430; }
    .error-tag.auth { background: #C4FF2015; color: #C4FF20; border-color: #C4FF2030; }
    .error-card .error-time {
      font-size: 0.6875rem;
      color: #4F4F4F;
      font-family: 'Geist Mono', monospace;
    }
    .error-card .error-source {
      font-size: 0.625rem;
      color: #4F4F4F;
      margin-left: auto;
    }
    .error-card .error-msg {
      font-size: 0.75rem;
      color: #9B9B9B;
      font-family: 'Geist Mono', monospace;
      line-height: 1.5;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    /* ── Empty / Loading ────────────────────────────────── */
    .empty {
      padding: 2.5rem;
      text-align: center;
      color: #4F4F4F;
      font-size: 0.8125rem;
    }
    .loading {
      padding: 2.5rem;
      text-align: center;
      color: #4F4F4F;
      font-size: 0.8125rem;
    }

    /* ── Pulse ──────────────────────────────────────────── */
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .loading { animation: pulse 1.5s ease-in-out infinite; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <img src="/images/linq-logo.svg" alt="Linq" class="logo" />
      <div class="divider"></div>
      <img src="/images/resy.png" alt="Resy" class="resy-logo" />
      <h1>Bookings Agent</h1>
    </div>
    <div class="header-right">
      <span class="status-dot" id="status-dot"></span>
      <span class="refresh-info" id="refresh-info">Loading...</span>
    </div>
  </div>

  <div class="container">
    <!-- Stats -->
    <div class="stats-row">
      <div class="stat-card">
        <div class="label">Total Users</div>
        <div class="value" id="stat-total">—</div>
        <div class="sub">all time</div>
      </div>
      <div class="stat-card">
        <div class="label">Active Today</div>
        <div class="value accent" id="stat-active">—</div>
        <div class="sub">last 24h</div>
      </div>
      <div class="stat-card">
        <div class="label">Connected</div>
        <div class="value" id="stat-connected">—</div>
        <div class="sub">resy linked</div>
      </div>
      <div class="stat-card">
        <div class="label">Total Texts</div>
        <div class="value" id="stat-texts">—</div>
        <div class="sub">7d rolling</div>
      </div>
      <div class="stat-card">
        <div class="label">Reservations</div>
        <div class="value accent" id="stat-reservations">—</div>
        <div class="sub">7d booked</div>
      </div>
      <div class="stat-card">
        <div class="label">Errors</div>
        <div class="value red" id="stat-errors">—</div>
        <div class="sub">last 24h</div>
      </div>
    </div>

    <!-- Uptime -->
    <div class="section-header"><h2>System Status</h2></div>
    <div class="uptime-grid">
      <div class="uptime-card">
        <div>
          <div class="fn-name">Receiver</div>
          <div class="fn-label">API Gateway → Lambda</div>
        </div>
        <div class="fn-status">
          <span class="last-seen" id="uptime-receiver">—</span>
          <span class="status-dot" id="dot-receiver"></span>
        </div>
      </div>
      <div class="uptime-card">
        <div>
          <div class="fn-name">Processor</div>
          <div class="fn-label">SQS → Lambda → Claude</div>
        </div>
        <div class="fn-status">
          <span class="last-seen" id="uptime-processor">—</span>
          <span class="status-dot" id="dot-processor"></span>
        </div>
      </div>
    </div>

    <!-- Live Logs -->
    <div class="section-header">
      <h2>Live Logs</h2>
      <div class="time-filters">
        <button data-minutes="30" class="active">30m</button>
        <button data-minutes="60">1h</button>
        <button data-minutes="240">4h</button>
      </div>
    </div>
    <div class="card">
      <div class="log-feed" id="log-feed"><div class="loading">Loading logs</div></div>
    </div>

    <!-- Bottom: Signups + Errors -->
    <div class="bottom-grid">
      <div>
        <div class="section-header"><h2>Recent Signups</h2></div>
        <div class="card">
          <table>
            <thead><tr><th>Phone</th><th>Signed Up</th><th>Status</th></tr></thead>
            <tbody id="signups-body"><tr><td colspan="3" class="loading">Loading</td></tr></tbody>
          </table>
        </div>
      </div>
      <div>
        <div class="section-header"><h2>Errors (24h)</h2></div>
        <div class="card">
          <div class="errors-list" id="errors-list"><div class="loading">Loading errors</div></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const TZ = 'America/New_York';
    let logMinutes = 30;

    function estTime(ts) {
      return new Date(ts).toLocaleTimeString('en-US', {
        timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
      });
    }

    function estShort(ts) {
      return new Date(ts).toLocaleTimeString('en-US', {
        timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true
      });
    }

    function timeAgo(dateStr) {
      if (!dateStr) return '—';
      const diff = Date.now() - new Date(dateStr).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      return Math.floor(hrs / 24) + 'd ago';
    }

    function escHtml(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function classifyLog(msg) {
      if (/error/i.test(msg)) return 'error';
      if (/\\[timing\\]/.test(msg)) return 'timing';
      if (/\\[resy\\]/.test(msg)) return 'resy';
      return 'default';
    }

    function uptimeStatus(lastEvent) {
      if (!lastEvent) return 'down';
      const mins = (Date.now() - lastEvent) / 60000;
      if (mins < 30) return '';       // healthy
      if (mins < 120) return 'degraded';
      return 'down';
    }

    async function fetchStats() {
      try {
        const r = await fetch('/api/stats');
        const d = await r.json();
        document.getElementById('stat-total').textContent = d.totalUsers;
        document.getElementById('stat-active').textContent = d.activeToday;
        document.getElementById('stat-connected').textContent = d.connected;
        document.getElementById('stat-texts').textContent = d.totalTexts;
        document.getElementById('stat-reservations').textContent = d.reservationsBooked;
        document.getElementById('stat-errors').textContent = d.errorCount;

        // Uptime
        const recvStatus = uptimeStatus(d.lastReceiverEvent);
        const procStatus = uptimeStatus(d.lastProcessorEvent);
        document.getElementById('dot-receiver').className = 'status-dot ' + recvStatus;
        document.getElementById('dot-processor').className = 'status-dot ' + procStatus;
        document.getElementById('uptime-receiver').textContent =
          d.lastReceiverEvent ? timeAgo(new Date(d.lastReceiverEvent)) : 'no data';
        document.getElementById('uptime-processor').textContent =
          d.lastProcessorEvent ? timeAgo(new Date(d.lastProcessorEvent)) : 'no data';

        // Global status dot
        const worst = [recvStatus, procStatus].includes('down') ? 'down'
          : [recvStatus, procStatus].includes('degraded') ? 'degraded' : '';
        document.getElementById('status-dot').className = 'status-dot ' + worst;
      } catch (e) { console.error('Stats fetch failed:', e); }
    }

    async function fetchLogs() {
      try {
        const r = await fetch('/api/logs?minutes=' + logMinutes);
        const logs = await r.json();
        const feed = document.getElementById('log-feed');
        if (!logs.length) { feed.innerHTML = '<div class="empty">No logs in this time range</div>'; return; }
        feed.innerHTML = logs.map(l => {
          const cls = classifyLog(l.message);
          return '<div class="log-line ' + cls + '">'
            + '<span class="ts">' + estTime(l.timestamp) + '</span> '
            + '<span class="src">' + l.source + '</span> '
            + escHtml(l.message) + '</div>';
        }).join('');
      } catch (e) { console.error('Logs fetch failed:', e); }
    }

    async function fetchSignups() {
      try {
        const r = await fetch('/api/signups');
        const signups = await r.json();
        const body = document.getElementById('signups-body');
        if (!signups.length) { body.innerHTML = '<tr><td colspan="3" class="empty">No signups yet</td></tr>'; return; }
        body.innerHTML = signups.map(s =>
          '<tr>'
          + '<td style="font-family:Geist Mono,monospace;font-size:0.8rem;color:#E7E7E7">' + escHtml(s.phone) + '</td>'
          + '<td>' + timeAgo(s.createdAt) + '</td>'
          + '<td><span class="badge ' + (s.hasCredentials ? 'connected' : 'pending') + '">'
          + (s.hasCredentials ? 'Connected' : 'Pending') + '</span></td>'
          + '</tr>'
        ).join('');
      } catch (e) { console.error('Signups fetch failed:', e); }
    }

    async function fetchErrors() {
      try {
        const r = await fetch('/api/errors');
        const errors = await r.json();
        const list = document.getElementById('errors-list');
        if (!errors.length) { list.innerHTML = '<div class="empty">No errors in the last 24h</div>'; return; }
        list.innerHTML = errors.map(e =>
          '<div class="error-card">'
          + '<div class="error-card-header">'
          + '<span class="error-tag ' + escHtml(e.type) + '">' + escHtml(e.type) + '</span>'
          + '<span class="error-time">' + estShort(e.timestamp) + '</span>'
          + '<span class="error-source">' + escHtml(e.source) + '</span>'
          + '</div>'
          + '<div class="error-msg">' + escHtml(e.message.substring(0, 300)) + '</div>'
          + '</div>'
        ).join('');
      } catch (e) { console.error('Errors fetch failed:', e); }
    }

    function refreshAll() {
      fetchStats(); fetchLogs(); fetchSignups(); fetchErrors();
      document.getElementById('refresh-info').textContent =
        'Last refresh ' + estShort(Date.now()) + ' ET';
    }

    document.querySelectorAll('.time-filters button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.time-filters button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        logMinutes = parseInt(btn.dataset.minutes);
        fetchLogs();
      });
    });

    refreshAll();
    setInterval(refreshAll, 30000);
  </script>
</body>
</html>`);
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  Bookings Agent Dashboard`);
  console.log(`  http://localhost:${PORT}\n`);
});
