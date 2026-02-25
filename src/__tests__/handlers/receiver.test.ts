import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// vi.hoisted runs before vi.mock hoisting — set env vars here so they're
// available when the handler module's top-level code reads process.env
const { mockSqsSend } = vi.hoisted(() => {
  process.env.SQS_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/queue';
  process.env.LINQ_AGENT_BOT_NUMBERS = '';
  process.env.IGNORED_SENDERS = '+1ignored';
  process.env.ALLOWED_SENDERS = '';
  return { mockSqsSend: vi.fn().mockResolvedValue({}) };
});

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class { send = mockSqsSend; },
  SendMessageCommand: class { constructor(public input: unknown) {} },
}));

// Mock auth DB
const mockVerifyAuthToken = vi.fn();
const mockGetAuthTokenChatId = vi.fn();
const mockVerifyMagicLinkToken = vi.fn();
const mockSetCredentials = vi.fn();
const mockCreateUser = vi.fn();
const mockGetUser = vi.fn();

vi.mock('../../auth/db.js', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
  getAuthTokenChatId: (...args: unknown[]) => mockGetAuthTokenChatId(...args),
  createUser: (...args: unknown[]) => mockCreateUser(...args),
  getUser: (...args: unknown[]) => mockGetUser(...args),
  setCredentials: (...args: unknown[]) => mockSetCredentials(...args),
}));

vi.mock('../../auth/magicLink.js', () => ({
  verifyMagicLinkToken: (...args: unknown[]) => mockVerifyMagicLinkToken(...args),
}));

vi.mock('../../linq/client.js', () => ({
  sendMessage: vi.fn().mockResolvedValue({}),
}));

import { handler } from '../../handlers/receiver.js';

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> & { method?: string; path?: string }): APIGatewayProxyEventV2 {
  const { method = 'GET', path = '/', ...rest } = overrides;
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123',
      apiId: 'api1',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req1',
      routeKey: '$default',
      stage: '$default',
      time: '',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...rest,
  } as APIGatewayProxyEventV2;
}

function makeWebhookBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    api_version: 'v3',
    event_id: 'evt_1',
    created_at: new Date().toISOString(),
    trace_id: 'tr_1',
    partner_id: 'p_1',
    event_type: 'message.received',
    data: {
      chat_id: 'chat_1',
      from: '+14155551234',
      recipient_phone: '+14155550000',
      received_at: new Date().toISOString(),
      is_from_me: false,
      service: 'iMessage',
      message: {
        id: 'msg_1',
        parts: [{ type: 'text', value: 'hello' }],
      },
      ...overrides,
    },
  });
}

beforeEach(() => {
  mockSqsSend.mockClear();
  mockVerifyAuthToken.mockReset();
  mockGetAuthTokenChatId.mockReset();
  mockVerifyMagicLinkToken.mockReset();
  mockSetCredentials.mockReset();
  mockCreateUser.mockReset();
  mockGetUser.mockReset();
});

describe('receiver handler', () => {
  // ── Health check ─────────────────────────────────────────────────────

  it('GET /health returns 200 + status ok', async () => {
    const result = await handler(makeEvent({ method: 'GET', path: '/health' }));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.status).toBe('ok');
  });

  // ── Webhook ──────────────────────────────────────────────────────────

  it('POST /linq-webhook with valid event enqueues to SQS + returns 200', async () => {
    const result = await handler(makeEvent({
      method: 'POST',
      path: '/linq-webhook',
      body: makeWebhookBody(),
    }));

    expect(result.statusCode).toBe(200);
    expect(mockSqsSend).toHaveBeenCalledTimes(1);
  });

  it('POST /linq-webhook skips own messages (is_from_me)', async () => {
    const result = await handler(makeEvent({
      method: 'POST',
      path: '/linq-webhook',
      body: makeWebhookBody({ is_from_me: true }),
    }));

    expect(result.statusCode).toBe(200);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it('POST /linq-webhook skips ignored senders', async () => {
    const result = await handler(makeEvent({
      method: 'POST',
      path: '/linq-webhook',
      body: makeWebhookBody({ from: '+1ignored' }),
    }));

    expect(result.statusCode).toBe(200);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  // ── Auth setup page ──────────────────────────────────────────────────

  it('GET /auth/setup with valid token returns HTML 200', async () => {
    mockVerifyAuthToken.mockResolvedValue('+14155551234');

    const result = await handler(makeEvent({
      method: 'GET',
      path: '/auth/setup',
      queryStringParameters: { token: 'valid_tok' },
    }));

    expect(result.statusCode).toBe(200);
    expect((result.headers as Record<string, string>)['Content-Type']).toContain('text/html');
  });

  it('GET /auth/setup with expired token returns 400', async () => {
    mockVerifyAuthToken.mockResolvedValue(null);

    const result = await handler(makeEvent({
      method: 'GET',
      path: '/auth/setup',
      queryStringParameters: { token: 'expired_tok' },
    }));

    expect(result.statusCode).toBe(400);
  });

  // ── Auth submit ──────────────────────────────────────────────────────

  it('POST /auth/setup/submit stores credentials + returns success', async () => {
    mockGetAuthTokenChatId.mockResolvedValue('chat_1');
    mockVerifyMagicLinkToken.mockResolvedValue('+14155551234');
    mockGetUser.mockResolvedValue({ phoneNumber: '+14155551234' });
    mockSetCredentials.mockResolvedValue(undefined);

    const result = await handler(makeEvent({
      method: 'POST',
      path: '/auth/setup/submit',
      body: JSON.stringify({ token: 'valid_tok', resyAuthToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' }),
    }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.success).toBe(true);
    expect(mockSetCredentials).toHaveBeenCalledWith('+14155551234', {
      resyAuthToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    });
  });

  it('POST /auth/setup/submit with bad token returns 400', async () => {
    mockGetAuthTokenChatId.mockResolvedValue(null);
    mockVerifyMagicLinkToken.mockResolvedValue(null);

    const result = await handler(makeEvent({
      method: 'POST',
      path: '/auth/setup/submit',
      body: JSON.stringify({ token: 'bad_tok', resyAuthToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' }),
    }));

    expect(result.statusCode).toBe(400);
  });
});
