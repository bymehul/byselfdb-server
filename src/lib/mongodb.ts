import { MongoClient, Db } from 'mongodb';
import { createHash } from 'crypto';
import { SessionData } from './sessionStore.js';

interface ConnectionPool {
  uri: string;
  client: MongoClient;
  db: Db | null;
  lastUsed: number;
}

const CONNECTION_TTL = 5 * 60 * 1000;
const pool = new Map<string, ConnectionPool>();

async function createConnection(uri: string): Promise<MongoClient> {
  const client = new MongoClient(uri, {
    maxPoolSize: 1,
    minPoolSize: 0,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 30000,
  });

  await client.connect();
  return client;
}

/**
 * get connection from session
 */
export async function getConnectionFromSession(session: SessionData): Promise<MongoClient | null> {
  const uriHash = hashUri(session.uri);
  const existing = pool.get(uriHash);

  if (existing) {
    const now = Date.now();
    if (now - existing.lastUsed < CONNECTION_TTL) {
      existing.lastUsed = now;
      try {
        await existing.client.db().command({ ping: 1 });
      } catch {
        existing.client = await createConnection(session.uri);
      }
      return existing.client;
    } else {
      await cleanupConnection(uriHash);
    }
  }

  try {
    const client = await createConnection(session.uri);
    const db = client.db(session.databaseName);

    pool.set(uriHash, {
      uri: session.uri,
      client,
      db,
      lastUsed: Date.now(),
    });

    return client;
  } catch (error) {
    console.error('[mongo] failed to create connection:', error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
}

function hashUri(uri: string): string {
  return createHash('sha256').update(uri).digest('hex');
}

async function cleanupConnection(uriHash: string): Promise<void> {
  const conn = pool.get(uriHash);
  if (conn) {
    try {
      await conn.client.close();
    } catch {
      // ignore noise
    }
    pool.delete(uriHash);
  }
}

export async function closeAllConnections(): Promise<void> {
  for (const [uriHash, conn] of pool.entries()) {
    try {
      await conn.client.close();
    } catch {
      // ignore noise
    }
    pool.delete(uriHash);
  }
}

export function getActiveConnectionCount(): number {
  return pool.size;
}
