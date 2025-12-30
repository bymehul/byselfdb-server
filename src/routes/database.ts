import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { getConnectionFromSession } from '../lib/mongodb.js';
import type { CollectionInfo } from '../types/index.js';

const router = Router();

router.get('/databases', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.session) {
    return res.status(401).json({
      success: false,
      error: 'Session required',
    });
  }

  const client = await getConnectionFromSession(req.session);

  if (!client) {
    return res.status(401).json({
      success: false,
      error: 'Failed to connect to database',
    });
  }

  try {
    const adminDb = client.db('admin');
    const result = await adminDb.command({ listDatabases: 1 });

    const databases = result.databases.map((db: { name: string; sizeOnDisk?: number }) => ({
      name: db.name,
      sizeOnDisk: db.sizeOnDisk,
    }));

    return res.json({
      success: true,
      data: { databases },
    });
  } catch (error) {
    console.error('[databases] error:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(500).json({
      success: false,
      error: 'Failed to list databases',
    });
  }
});

router.get('/collections', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { database } = req.query;

  if (!database || typeof database !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Database name is required',
    });
  }

  if (!req.session) {
    return res.status(401).json({
      success: false,
      error: 'Session required',
    });
  }

  const client = await getConnectionFromSession(req.session);

  if (!client) {
    return res.status(401).json({
      success: false,
      error: 'Failed to connect to database',
    });
  }

  try {
    const db = client.db(database);
    const collections = await db.listCollections().toArray();

    const collectionsWithStats: CollectionInfo[] = await Promise.all(
      collections.map(async (col) => {
        try {
          const count = await db.collection(col.name).countDocuments();
          const stats = await db.command({ collStats: col.name });
          return {
            name: col.name,
            documentCount: count,
            size: stats.size,
          };
        } catch {
          return {
            name: col.name,
            documentCount: 0,
            size: 0,
          };
        }
      })
    );

    return res.json({
      success: true,
      data: {
        collections: collectionsWithStats,
        database,
      },
    });
  } catch (error) {
    console.error('[collections] error:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(500).json({
      success: false,
      error: 'Failed to list collections',
    });
  }
});

router.get('/collection-stats', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { database, collection } = req.query;

  if (!database || !collection || typeof database !== 'string' || typeof collection !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Database and collection names are required',
    });
  }

  if (!req.session) {
    return res.status(401).json({
      success: false,
      error: 'Session required',
    });
  }

  const client = await getConnectionFromSession(req.session);

  if (!client) {
    return res.status(401).json({
      success: false,
      error: 'Failed to connect to database',
    });
  }

  try {
    const db = client.db(database);
    const col = db.collection(collection);

    const [count, stats, indexes] = await Promise.all([
      col.countDocuments(),
      db.command({ collStats: collection }),
      col.indexes(),
    ]);

    return res.json({
      success: true,
      data: {
        documentCount: count,
        size: stats.size,
        storageSize: stats.storageSize,
        indexCount: indexes.length,
        indexes,
      },
    });
  } catch (error) {
    console.error('[stats] error:', error instanceof Error ? error.message : 'Unknown error');

    if (error instanceof Error && (error.message.includes('not authorized') || error.message.includes('auth failed'))) {
      return res.json({
        success: true,
        data: {
          documentCount: 0,
          size: 0,
          storageSize: 0,
          indexCount: 0,
          indexes: [],
          message: 'Access restricted: Stats not available',
        },
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Failed to get collection stats',
    });
  }
});

export default router;
