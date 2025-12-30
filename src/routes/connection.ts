import { Router, Request, Response } from 'express';
import { MongoClient } from 'mongodb';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { createSession, updateSession, destroySession } from '../lib/sessionStore.js';
import { validateUriForSsrf } from '../utils/ssrf.js';

const router = Router();

function parseMongoUri(uri: string): { connectionString: string; databaseName: string } | null {
  try {
    const url = new URL(uri);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const databaseName = pathParts[0] || 'test';
    return { connectionString: uri, databaseName };
  } catch {
    return null;
  }
}

function maskUri(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.password) {
      url.password = '****';
    }
    return url.toString();
  } catch {
    return '[invalid uri]';
  }
}

router.post('/connect', async (req: Request, res: Response) => {
  const { uri } = req.body;

  if (!uri || typeof uri !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'URI is required',
    });
  }

  const parsed = parseMongoUri(uri);
  if (!parsed) {
    return res.status(400).json({
      success: false,
      error: 'Invalid MongoDB URI format',
    });
  }

  // check for private ranges
  const ssrfCheck = validateUriForSsrf(uri);
  if (!ssrfCheck.valid) {
    return res.status(400).json({
      success: false,
      error: ssrfCheck.error,
    });
  }

  let client: MongoClient | null = null;

  try {
    client = new MongoClient(uri, {
      connectTimeoutMS: 10000,
      serverSelectionTimeoutMS: 10000,
    });

    await client.connect();
    await client.db('admin').command({ ping: 1 });

    // start session
    const sessionId = createSession({
      uri,
      databaseName: parsed.databaseName,
      allowedScope: ['*'],
      readOnly: false,
    });

    const cookieName = process.env.NODE_ENV === 'production' ? 'byselfdb_session' : 'byselfdb_session_dev';
    const isProduction = process.env.NODE_ENV === 'production';

    // cookie only
    res.cookie(cookieName, sessionId, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'strict' : 'lax', // 'strict' is preferred when on the same custom domain
      maxAge: 24 * 60 * 60 * 1000,
      path: '/',
    });

    console.log(`[connection] new session created: ${parsed.databaseName}`);

    return res.json({
      success: true,
      data: {
        databaseName: parsed.databaseName,
        maskedUri: maskUri(uri),
        message: 'Successfully connected to database',
      },
    });
  } catch (error) {
    console.error('[connection] failed:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(401).json({
      success: false,
      error: 'Failed to connect to MongoDB. Please check your URI and network connection.',
    });
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }
    }
  }
});

router.post('/disconnect', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const cookieName = process.env.NODE_ENV === 'production' ? 'byselfdb_session' : 'byselfdb_session_dev';

  // kill session
  if (req.sessionId) {
    destroySession(req.sessionId);
  }

  res.clearCookie(cookieName, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
    path: '/',
  });

  return res.json({
    success: true,
    message: 'Disconnected successfully',
  });
});

router.get('/status', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  if (!req.session) {
    return res.status(401).json({
      success: false,
      error: 'No active session',
    });
  }

  return res.json({
    success: true,
    data: {
      databaseName: req.session.databaseName,
      readOnly: req.session.readOnly,
      expiresAt: new Date(req.session.expiresAt).toISOString(),
    },
  });
});

router.post('/switch-database', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { databaseName } = req.body;

  if (!databaseName || typeof databaseName !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Database name is required',
    });
  }

  if (!req.sessionId) {
    return res.status(401).json({
      success: false,
      error: 'No active session',
    });
  }

  // update
  const updated = updateSession(req.sessionId, { databaseName });

  if (!updated) {
    return res.status(401).json({
      success: false,
      error: 'Session expired',
    });
  }

  return res.json({
    success: true,
    data: {
      databaseName,
      message: `Successfully switched to database: ${databaseName}`,
    },
  });
});

export default router;
