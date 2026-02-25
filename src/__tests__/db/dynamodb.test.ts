import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs before vi.mock hoisting, so mockSend is available in the factory
const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class { constructor(_cfg?: unknown) {} },
}));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: () => ({ send: mockSend }),
  },
  GetCommand: class { input: unknown; constructor(input: unknown) { this.input = input; } },
  PutCommand: class { input: unknown; constructor(input: unknown) { this.input = input; } },
  DeleteCommand: class { input: unknown; constructor(input: unknown) { this.input = input; } },
  UpdateCommand: class { input: unknown; constructor(input: unknown) { this.input = input; } },
  QueryCommand: class { input: unknown; constructor(input: unknown) { this.input = input; } },
}));

import { getItem, putItem, deleteItem, updateItem, queryByPk } from '../../db/dynamodb.js';

beforeEach(() => {
  mockSend.mockReset();
});

describe('dynamodb', () => {
  // ── getItem ──────────────────────────────────────────────────────────────

  it('returns null when item does not exist', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });
    const result = await getItem('PK1', 'SK1');
    expect(result).toBeNull();
  });

  it('returns typed item when found', async () => {
    const item = { PK: 'PK1', SK: 'SK1', name: 'Alice' };
    mockSend.mockResolvedValueOnce({ Item: item });
    const result = await getItem<{ name: string }>('PK1', 'SK1');
    expect(result).toEqual(item);
  });

  // ── putItem ──────────────────────────────────────────────────────────────

  it('stores data with correct PK/SK', async () => {
    mockSend.mockResolvedValueOnce({});
    await putItem('PK1', 'SK1', { foo: 'bar' });

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.Item).toMatchObject({ PK: 'PK1', SK: 'SK1', foo: 'bar' });
    expect(cmd.input.Item.TTL).toBeUndefined();
  });

  it('adds TTL when ttlSeconds provided', async () => {
    mockSend.mockResolvedValueOnce({});
    const before = Math.floor(Date.now() / 1000);
    await putItem('PK1', 'SK1', { foo: 'bar' }, 3600);
    const after = Math.floor(Date.now() / 1000);

    const cmd = mockSend.mock.calls[0][0];
    const ttl = cmd.input.Item.TTL as number;
    expect(ttl).toBeGreaterThanOrEqual(before + 3600);
    expect(ttl).toBeLessThanOrEqual(after + 3600);
  });

  // ── deleteItem ───────────────────────────────────────────────────────────

  it('sends correct key for deleteItem', async () => {
    mockSend.mockResolvedValueOnce({});
    await deleteItem('PK1', 'SK1');

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.Key).toEqual({ PK: 'PK1', SK: 'SK1' });
  });

  // ── updateItem ───────────────────────────────────────────────────────────

  it('builds SET expression correctly', async () => {
    mockSend.mockResolvedValueOnce({});
    await updateItem('PK1', 'SK1', { name: 'Bob', age: 30 });

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.UpdateExpression).toBe('SET #name = :name, #age = :age');
    expect(cmd.input.ExpressionAttributeNames).toEqual({ '#name': 'name', '#age': 'age' });
    expect(cmd.input.ExpressionAttributeValues).toEqual({ ':name': 'Bob', ':age': 30 });
  });

  it('is no-op for empty updates', async () => {
    await updateItem('PK1', 'SK1', {});
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ── queryByPk ────────────────────────────────────────────────────────────

  it('returns matching items', async () => {
    const items = [
      { PK: 'PK1', SK: 'A', val: 1 },
      { PK: 'PK1', SK: 'B', val: 2 },
    ];
    mockSend.mockResolvedValueOnce({ Items: items });
    const result = await queryByPk<{ val: number }>('PK1');
    expect(result).toEqual(items);
  });
});
