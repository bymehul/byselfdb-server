import { Router, Response } from 'express';
import { ObjectId } from 'mongodb';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { getConnectionFromSession } from '../lib/mongodb.js';
import { isValidObjectId } from '../types/index.js';
import { sanitizeFilter, sanitizeUpdate } from '../utils/sanitize.js';

const router = Router();

function parseFilter(filterStr: string | undefined): Record<string, unknown> | undefined {
  if (!filterStr) return undefined;
  try {
    return JSON.parse(filterStr);
  } catch {
    return undefined;
  }
}

function parseSort(sortStr: string | undefined): Record<string, 1 | -1> | undefined {
  if (!sortStr) return undefined;
  try {
    const parsed = JSON.parse(sortStr);
    const result: Record<string, 1 | -1> = {};
    for (const [key, value] of Object.entries(parsed)) {
      result[key] = value === 1 || value === -1 ? (value as 1 | -1) : 1;
    }
    return result;
  } catch {
    return undefined;
  }
}

router.get('/documents', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { database, collection, filter, sort, limit, skip, projection } = req.query;

  if (!database || !collection || typeof database !== 'string' || typeof collection !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Database and collection names are required',
    });
  }

  const parsedFilter = parseFilter(filter as string | undefined);
  const parsedSort = parseSort(sort as string | undefined);
  const parsedLimit = limit ? Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 1000) : 20;
  const parsedSkip = skip ? Math.max(parseInt(skip as string, 10) || 0, 0) : 0;
  const parsedProjection = projection ? parseFilter(projection as string) : undefined;

  const filterResult = sanitizeFilter(parsedFilter);
  if (!filterResult.valid) {
    return res.status(400).json({
      success: false,
      error: `Invalid filter: ${filterResult.error}`,
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

  if (req.session.readOnly && parsedFilter === undefined) {
    return res.status(403).json({
      success: false,
      error: 'Read-only mode: filter is required for queries',
    });
  }

  try {
    const db = client.db(database);
    const col = db.collection(collection);

    const [documents, totalCount] = await Promise.all([
      col
        .find(filterResult.filter)
        .sort(parsedSort || {})
        .skip(parsedSkip)
        .limit(parsedLimit)
        .project(parsedProjection || {})
        .toArray(),
      col.countDocuments(filterResult.filter),
    ]);

    return res.json({
      success: true,
      data: {
        documents,
        totalCount,
        hasMore: parsedSkip + documents.length < totalCount,
        limit: parsedLimit,
        skip: parsedSkip,
      },
    });
  } catch (error) {
    console.error('[documents] error:', error instanceof Error ? error.message : 'Unknown error');

    if (error instanceof Error && (error.message.includes('not authorized') || error.message.includes('auth failed'))) {
      return res.json({
        success: true,
        data: {
          documents: [],
          totalCount: 0,
          hasMore: false,
          limit: parsedLimit,
          skip: parsedSkip,
          message: 'Access restricted: Documents not visible',
        },
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Failed to fetch documents',
    });
  }
});

/**
 * guess schema from data
 */
router.get('/documents/template', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
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

    // grab latest
    const [latestDoc] = await col.find({}).sort({ _id: -1 }).limit(1).toArray();

    if (!latestDoc) {
      return res.json({
        success: true,
        data: {}, // Collection is empty
      });
    }

    // strip values, keep keys
    const createTemplate = (obj: any): any => {
      if (Array.isArray(obj)) {
        return []; // empty
      }
      if (obj && typeof obj === 'object' && !(obj instanceof ObjectId) && !(obj instanceof Date)) {
        const template: any = {};
        for (const key in obj) {
          if (key === '_id') continue; // skip id
          template[key] = createTemplate(obj[key]);
        }
        return template;
      }
      if (typeof obj === 'string') return '';
      if (typeof obj === 'number') return 0;
      if (typeof obj === 'boolean') return false;
      return null;
    };

    const template = createTemplate(latestDoc);

    return res.json({
      success: true,
      data: template,
    });
  } catch (error) {
    console.error('[template] error:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(500).json({
      success: false,
      error: 'Failed to generate template',
    });
  }
});

router.post('/documents', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { database, collection, document } = req.body;

  if (!database || !collection || !document) {
    return res.status(400).json({
      success: false,
      error: 'Database, collection, and document are required',
    });
  }

  if (req.session?.readOnly) {
    return res.status(403).json({
      success: false,
      error: 'Read-only mode: cannot insert documents',
    });
  }

  const docResult = sanitizeFilter(document);
  if (!docResult.valid) {
    return res.status(400).json({
      success: false,
      error: `Invalid document: ${docResult.error}`,
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

    const result = await col.insertOne(docResult.filter);

    return res.json({
      success: true,
      data: {
        insertedId: result.insertedId.toString(),
        acknowledged: result.acknowledged,
      },
    });
  } catch (error) {
    console.error('[insert] error:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(500).json({
      success: false,
      error: 'Failed to insert document',
    });
  }
});

router.put('/documents/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { database, collection, update } = req.body;
  const { id } = req.params;

  if (!database || !collection || !update) {
    return res.status(400).json({
      success: false,
      error: 'Database, collection, and update are required',
    });
  }

  if (!isValidObjectId(id)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid document ID format',
    });
  }

  if (req.session?.readOnly) {
    return res.status(403).json({
      success: false,
      error: 'Read-only mode: cannot update documents',
    });
  }

  const updateResult = sanitizeUpdate(update);
  if (!updateResult.valid) {
    return res.status(400).json({
      success: false,
      error: `Invalid update: ${updateResult.error}`,
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

    const result = await col.updateOne(
      { _id: new ObjectId(id) },
      updateResult.update
    );

    return res.json({
      success: true,
      data: {
        modifiedCount: result.modifiedCount,
        upsertedCount: result.upsertedCount,
        acknowledged: result.acknowledged,
      },
    });
  } catch (error) {
    console.error('[update] error:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(500).json({
      success: false,
      error: 'Failed to update document',
    });
  }
});

router.delete('/documents/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { database, collection } = req.query;

  if (!database || !collection || typeof database !== 'string' || typeof collection !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Database and collection names are required',
    });
  }

  const { id } = req.params;

  if (!isValidObjectId(id)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid document ID format',
    });
  }

  if (req.session?.readOnly) {
    return res.status(403).json({
      success: false,
      error: 'Read-only mode: cannot delete documents',
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

    const result = await col.deleteOne({ _id: new ObjectId(id) });

    return res.json({
      success: true,
      data: {
        deletedCount: result.deletedCount,
        acknowledged: result.acknowledged,
      },
    });
  } catch (error) {
    console.error('[delete] error:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(500).json({
      success: false,
      error: 'Failed to delete document',
    });
  }
});

router.post('/documents/bulk', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { database, collection, documents, operation } = req.body;

  if (!database || !collection || !documents) {
    return res.status(400).json({
      success: false,
      error: 'Database, collection, and documents are required',
    });
  }

  if (req.session?.readOnly) {
    return res.status(403).json({
      success: false,
      error: 'Read-only mode: cannot perform bulk operations',
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

    if (operation === 'delete') {
      const ids = documents
        .filter((doc: { _id: string }) => isValidObjectId(doc._id))
        .map((doc: { _id: string }) => new ObjectId(doc._id));
      const deleteResult = await col.deleteMany({ _id: { $in: ids } });
      return res.json({
        success: true,
        data: {
          deletedCount: deleteResult.deletedCount,
          acknowledged: deleteResult.acknowledged,
        },
      });
    } else {
      const insertResult = await col.insertMany(documents);
      return res.json({
        success: true,
        data: {
          insertedCount: insertResult.insertedCount,
          acknowledged: insertResult.acknowledged,
        },
      });
    }
  } catch (error) {
    console.error('[bulk] error:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(500).json({
      success: false,
      error: 'Failed to perform bulk operation',
    });
  }
});

export default router;
