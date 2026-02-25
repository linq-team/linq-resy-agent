import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = process.env.DYNAMODB_TABLE || 'bookings-agent';

const ddbClient = new DynamoDBClient({
  ...(process.env.DYNAMODB_ENDPOINT && {
    endpoint: process.env.DYNAMODB_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  }),
});

const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});

// ── Generic helpers ──────────────────────────────────────────────────────────

export async function getItem<T>(pk: string, sk: string): Promise<T | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: pk, SK: sk } }),
  );
  return (Item as T) ?? null;
}

export async function putItem(
  pk: string,
  sk: string,
  data: Record<string, unknown>,
  ttlSeconds?: number,
): Promise<void> {
  const item: Record<string, unknown> = { PK: pk, SK: sk, ...data };
  if (ttlSeconds) {
    item.TTL = Math.floor(Date.now() / 1000) + ttlSeconds;
  }
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
}

export async function deleteItem(pk: string, sk: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: pk, SK: sk } }),
  );
}

export async function updateItem(
  pk: string,
  sk: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(updates);
  if (keys.length === 0) return;

  const expNames: Record<string, string> = {};
  const expValues: Record<string, unknown> = {};
  const setClauses: string[] = [];

  for (const key of keys) {
    const safeKey = `#${key}`;
    const safeVal = `:${key}`;
    expNames[safeKey] = key;
    expValues[safeVal] = updates[key];
    setClauses.push(`${safeKey} = ${safeVal}`);
  }

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: pk, SK: sk },
      UpdateExpression: `SET ${setClauses.join(', ')}`,
      ExpressionAttributeNames: expNames,
      ExpressionAttributeValues: expValues,
    }),
  );
}

export async function queryByPk<T>(pk: string): Promise<T[]> {
  const { Items } = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': pk },
    }),
  );
  return (Items as T[]) ?? [];
}
