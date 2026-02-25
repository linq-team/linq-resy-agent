import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQSEvent, SQSRecord, Context } from 'aws-lambda';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockSendMessage = vi.fn().mockResolvedValue({});
const mockMarkAsRead = vi.fn().mockResolvedValue(undefined);
const mockStartTyping = vi.fn().mockResolvedValue(undefined);
const mockSendReaction = vi.fn().mockResolvedValue(undefined);
const mockShareContactCard = vi.fn().mockResolvedValue(undefined);
const mockRenameGroupChat = vi.fn().mockResolvedValue(undefined);
const mockGetChat = vi.fn().mockResolvedValue({
  id: 'chat_1',
  display_name: null,
  handles: [
    { handle: '+14155551234', service: 'iMessage' },
    { handle: '+14155550000', service: 'iMessage' },
  ],
  is_group: false,
  service: 'iMessage',
});

vi.mock('../../linq/client.js', () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  markAsRead: (...args: unknown[]) => mockMarkAsRead(...args),
  startTyping: (...args: unknown[]) => mockStartTyping(...args),
  sendReaction: (...args: unknown[]) => mockSendReaction(...args),
  shareContactCard: (...args: unknown[]) => mockShareContactCard(...args),
  getChat: (...args: unknown[]) => mockGetChat(...args),
  renameGroupChat: (...args: unknown[]) => mockRenameGroupChat(...args),
}));

const mockChat = vi.fn().mockResolvedValue({
  text: 'hi there!',
  reaction: null,
  effect: null,
  renameChat: null,
  rememberedUser: null,
});
const mockGetGroupChatAction = vi.fn().mockResolvedValue({ action: 'respond' });
const mockGetTextForEffect = vi.fn().mockResolvedValue('wow!');

vi.mock('../../claude/client.js', () => ({
  chat: (...args: unknown[]) => mockChat(...args),
  getGroupChatAction: (...args: unknown[]) => mockGetGroupChatAction(...args),
  getTextForEffect: (...args: unknown[]) => mockGetTextForEffect(...args),
}));

const mockGetUserProfile = vi.fn().mockResolvedValue(null);
const mockAddMessage = vi.fn().mockResolvedValue(undefined);

vi.mock('../../state/conversation.js', () => ({
  getUserProfile: (...args: unknown[]) => mockGetUserProfile(...args),
  addMessage: (...args: unknown[]) => mockAddMessage(...args),
}));

const mockGetUser = vi.fn().mockResolvedValue(null);
const mockCreateUser = vi.fn().mockResolvedValue({ phoneNumber: '+14155551234' });
const mockLoadUserContext = vi.fn();
const mockConsumeJustOnboarded = vi.fn().mockResolvedValue(false);
const mockSetPendingOTP = vi.fn().mockResolvedValue(undefined);
const mockGetPendingOTP = vi.fn().mockResolvedValue(null);
const mockClearPendingOTP = vi.fn().mockResolvedValue(undefined);
const mockSetPendingChallenge = vi.fn().mockResolvedValue(undefined);
const mockGetPendingChallenge = vi.fn().mockResolvedValue(null);
const mockClearPendingChallenge = vi.fn().mockResolvedValue(undefined);
const mockSetCredentials = vi.fn().mockResolvedValue(undefined);
const mockClearSignedOut = vi.fn().mockResolvedValue(undefined);

vi.mock('../../auth/index.js', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
  createUser: (...args: unknown[]) => mockCreateUser(...args),
  loadUserContext: (...args: unknown[]) => mockLoadUserContext(...args),
  consumeJustOnboarded: (...args: unknown[]) => mockConsumeJustOnboarded(...args),
  setPendingOTP: (...args: unknown[]) => mockSetPendingOTP(...args),
  getPendingOTP: (...args: unknown[]) => mockGetPendingOTP(...args),
  clearPendingOTP: (...args: unknown[]) => mockClearPendingOTP(...args),
  setPendingChallenge: (...args: unknown[]) => mockSetPendingChallenge(...args),
  getPendingChallenge: (...args: unknown[]) => mockGetPendingChallenge(...args),
  clearPendingChallenge: (...args: unknown[]) => mockClearPendingChallenge(...args),
  setCredentials: (...args: unknown[]) => mockSetCredentials(...args),
  clearSignedOut: (...args: unknown[]) => mockClearSignedOut(...args),
}));

const mockSendResyOTP = vi.fn().mockResolvedValue('sms');
const mockVerifyResyOTP = vi.fn();
const mockCompleteResyChallenge = vi.fn();

vi.mock('../../bookings/index.js', () => ({
  sendResyOTP: (...args: unknown[]) => mockSendResyOTP(...args),
  verifyResyOTP: (...args: unknown[]) => mockVerifyResyOTP(...args),
  completeResyChallenge: (...args: unknown[]) => mockCompleteResyChallenge(...args),
}));

// Mock DynamoDB getItem/putItem for chat count
const mockDbGetItem = vi.fn().mockResolvedValue(null);
const mockDbPutItem = vi.fn().mockResolvedValue(undefined);
vi.mock('../../db/dynamodb.js', () => ({
  getItem: (...args: unknown[]) => mockDbGetItem(...args),
  putItem: (...args: unknown[]) => mockDbPutItem(...args),
}));

import { handler } from '../../handlers/processor.js';

function makeSQSEvent(text: string, overrides: Record<string, unknown> = {}): SQSEvent {
  const webhookEvent = {
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
        parts: [{ type: 'text', value: text }],
      },
      ...overrides,
    },
  };

  const record: SQSRecord = {
    messageId: 'sqs_1',
    receiptHandle: 'rh_1',
    body: JSON.stringify(webhookEvent),
    attributes: {} as SQSRecord['attributes'],
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123:queue',
    awsRegion: 'us-east-1',
  };

  return { Records: [record] };
}

const dummyContext: Context = {
  callbackWaitsForEmptyEventLoop: true,
  functionName: 'test',
  functionVersion: '1',
  invokedFunctionArn: 'arn:aws:lambda:us-east-1:123:function:test',
  memoryLimitInMB: '128',
  awsRequestId: 'req1',
  logGroupName: '/test',
  logStreamName: 'stream1',
  getRemainingTimeInMillis: () => 60000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDbGetItem.mockResolvedValue(null);
  mockDbPutItem.mockResolvedValue(undefined);
  mockGetPendingOTP.mockResolvedValue(null);
  mockGetPendingChallenge.mockResolvedValue(null);
  mockGetUserProfile.mockResolvedValue(null);
  // Restore default 1:1 chat (2 handles = not a group)
  mockGetChat.mockResolvedValue({
    id: 'chat_1',
    display_name: null,
    handles: [
      { handle: '+14155551234', service: 'iMessage' },
      { handle: '+14155550000', service: 'iMessage' },
    ],
    is_group: false,
    service: 'iMessage',
  });
  mockChat.mockResolvedValue({
    text: 'hi there!',
    reaction: null,
    effect: null,
    renameChat: null,
    rememberedUser: null,
  });
});

describe('processor handler', () => {
  it('inline JWT stores credentials directly', async () => {
    const jwtToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

    await handler(makeSQSEvent(jwtToken), dummyContext, () => {});

    expect(mockSetCredentials).toHaveBeenCalledWith('+14155551234', { resyAuthToken: jwtToken });
    expect(mockSendMessage).toHaveBeenCalled();
  });

  it('OTP code triggers verification flow', async () => {
    mockGetPendingOTP.mockResolvedValue({ chatId: 'chat_1', sentAt: new Date() });
    mockVerifyResyOTP.mockResolvedValue({ token: 'resy_tok_123' });

    await handler(makeSQSEvent('123456'), dummyContext, () => {});

    expect(mockVerifyResyOTP).toHaveBeenCalledWith('+14155551234', '123456');
    expect(mockSetCredentials).toHaveBeenCalledWith('+14155551234', { resyAuthToken: 'resy_tok_123' });
  });

  it('email during pending challenge triggers challenge completion', async () => {
    mockGetPendingChallenge.mockResolvedValue({
      chatId: 'chat_1',
      claimToken: 'ct_1',
      challengeId: 'ch_1',
      mobileNumber: '+14155551234',
      firstName: 'Alice',
      requiredFields: [{ name: 'em_address', type: 'email', message: 'Enter email' }],
      sentAt: new Date().toISOString(),
    });
    mockCompleteResyChallenge.mockResolvedValue('resy_tok_from_challenge');

    await handler(makeSQSEvent('alice@example.com'), dummyContext, () => {});

    expect(mockCompleteResyChallenge).toHaveBeenCalled();
    expect(mockSetCredentials).toHaveBeenCalledWith('+14155551234', { resyAuthToken: 'resy_tok_from_challenge' });
  });

  it('unauthenticated user triggers OTP send', async () => {
    mockLoadUserContext.mockResolvedValue(null);
    mockGetUser.mockResolvedValue(null);
    mockSendResyOTP.mockResolvedValue('sms');

    await handler(makeSQSEvent('find me a restaurant'), dummyContext, () => {});

    expect(mockSendResyOTP).toHaveBeenCalledWith('+14155551234');
    expect(mockSetPendingOTP).toHaveBeenCalled();
  });

  it('group chat message runs classifier', async () => {
    mockLoadUserContext.mockResolvedValue({
      user: { phoneNumber: '+14155551234' },
      bookingsCredentials: { resyAuthToken: 'tok' },
    });
    mockGetChat.mockResolvedValue({
      id: 'chat_1',
      display_name: 'Friends',
      handles: [
        { handle: '+14155551234', service: 'iMessage' },
        { handle: '+14155550000', service: 'iMessage' },
        { handle: '+14155559999', service: 'iMessage' }, // 3 handles = group
      ],
      is_group: true,
      service: 'iMessage',
    });
    mockGetGroupChatAction.mockResolvedValue({ action: 'ignore' });

    await handler(makeSQSEvent('hey everyone'), dummyContext, () => {});

    expect(mockGetGroupChatAction).toHaveBeenCalled();
    expect(mockChat).not.toHaveBeenCalled(); // Ignored
  });

  it('main flow calls Claude chat and sends response', async () => {
    mockLoadUserContext.mockResolvedValue({
      user: { phoneNumber: '+14155551234' },
      bookingsCredentials: { resyAuthToken: 'tok' },
    });
    mockChat.mockResolvedValue({
      text: 'sure, searching for restaurants now',
      reaction: null,
      effect: null,
      renameChat: null,
      rememberedUser: null,
    });

    await handler(makeSQSEvent('find me sushi in NYC'), dummyContext, () => {});

    expect(mockChat).toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      'chat_1',
      'sure, searching for restaurants now',
      undefined,
      undefined,
    );
  });
});
