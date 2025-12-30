import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { getConnectionFromSession } from '../lib/mongodb.js';
import { sanitizeFilter } from '../utils/sanitize.js';

const router = Router();

// get server stats (memory, connections, ops)
router.get('/server-stats', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
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
        const serverStatus = await adminDb.command({ serverStatus: 1 });

        // on free tier, stats might be missing or be all zeros
        const isRestricted =
            !serverStatus.mem ||
            !serverStatus.connections ||
            (serverStatus.mem.resident === 0 && serverStatus.mem.virtual === 0);

        return res.json({
            success: true,
            data: {
                host: serverStatus.host,
                version: serverStatus.version,
                uptime: serverStatus.uptime,
                uptimeMillis: serverStatus.uptimeMillis,
                connections: {
                    current: serverStatus.connections?.current || 0,
                    available: serverStatus.connections?.available || 0,
                    totalCreated: serverStatus.connections?.totalCreated || 0,
                },
                memory: {
                    resident: serverStatus.mem?.resident || 0,
                    virtual: serverStatus.mem?.virtual || 0,
                    mapped: serverStatus.mem?.mapped || 0,
                },
                network: {
                    bytesIn: serverStatus.network?.bytesIn || 0,
                    bytesOut: serverStatus.network?.bytesOut || 0,
                    numRequests: serverStatus.network?.numRequests || 0,
                },
                opcounters: {
                    insert: serverStatus.opcounters?.insert || 0,
                    query: serverStatus.opcounters?.query || 0,
                    update: serverStatus.opcounters?.update || 0,
                    delete: serverStatus.opcounters?.delete || 0,
                    getmore: serverStatus.opcounters?.getmore || 0,
                    command: serverStatus.opcounters?.command || 0,
                },
                restricted: isRestricted,
                message: isRestricted ? 'Memory usage metrics are not available on the Free Tier (Shared Cluster).' : undefined
            },
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[server-stats] error:', errMsg);

        // Handle Free Tier / Shared Cluster restrictions
        if (errMsg.includes('not authorized') || errMsg.includes('command not found') || errMsg.includes('CMD_NOT_ALLOWED')) {
            return res.json({
                success: true,
                data: {
                    host: 'Shared Cluster',
                    version: 'Free Tier',
                    uptime: 0,
                    uptimeMillis: 0,
                    connections: { current: 0, available: 0, totalCreated: 0 },
                    memory: { resident: 0, virtual: 0, mapped: 0 },
                    network: { bytesIn: 0, bytesOut: 0, numRequests: 0 },
                    opcounters: { insert: 0, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
                    restricted: true,
                    message: 'Server stats are not available on the Free Tier (Shared Cluster). Upgrade to a dedicated cluster to view these metrics.'
                },
            });
        }

        return res.status(500).json({
            success: false,
            error: 'Failed to get server stats. You may be on a Free Tier cluster which restricts this access.',
        });
    }
});

// schema analysis - grab sample docs and guess types
router.get('/schema', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
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

        // sample up to 100 docs so we don't scan everything
        const sampleDocs = await col.aggregate([{ $sample: { size: 100 } }]).toArray();
        const totalCount = await col.countDocuments();

        if (sampleDocs.length === 0) {
            return res.json({
                success: true,
                data: {
                    fields: [],
                    sampleSize: 0,
                    totalDocuments: 0,
                },
            });
        }

        // analyze field types and frequency
        const fieldAnalysis: Record<string, {
            types: Record<string, number>;
            count: number;
            examples: unknown[];
        }> = {};

        function analyzeValue(key: string, value: unknown, prefix = '') {
            const fullKey = prefix ? `${prefix}.${key}` : key;

            if (!fieldAnalysis[fullKey]) {
                fieldAnalysis[fullKey] = { types: {}, count: 0, examples: [] };
            }

            fieldAnalysis[fullKey].count++;

            let type = 'null';
            if (value === null) {
                type = 'null';
            } else if (Array.isArray(value)) {
                type = 'array';
            } else if (value instanceof Date) {
                type = 'date';
            } else if (typeof value === 'object' && value.constructor.name === 'ObjectId') {
                type = 'ObjectId';
            } else if (typeof value === 'object') {
                type = 'object';
                // Recurse into nested objects
                Object.entries(value as Record<string, unknown>).forEach(([k, v]) => {
                    analyzeValue(k, v, fullKey);
                });
            } else {
                type = typeof value;
            }

            fieldAnalysis[fullKey].types[type] = (fieldAnalysis[fullKey].types[type] || 0) + 1;

            // Store up to 3 examples
            if (fieldAnalysis[fullKey].examples.length < 3 && value !== null && value !== undefined) {
                const example = typeof value === 'object' ? '[Object]' : value;
                if (!fieldAnalysis[fullKey].examples.includes(example)) {
                    fieldAnalysis[fullKey].examples.push(example);
                }
            }
        }

        sampleDocs.forEach(doc => {
            Object.entries(doc).forEach(([key, value]) => {
                analyzeValue(key, value);
            });
        });

        // Convert to array and calculate percentages
        const fields = Object.entries(fieldAnalysis).map(([field, analysis]) => ({
            field,
            types: Object.entries(analysis.types).map(([type, count]) => ({
                type,
                count,
                percentage: Math.round((count / sampleDocs.length) * 100),
            })),
            presence: Math.round((analysis.count / sampleDocs.length) * 100),
            examples: analysis.examples,
        })).sort((a, b) => b.presence - a.presence);

        return res.json({
            success: true,
            data: {
                fields,
                sampleSize: sampleDocs.length,
                totalDocuments: totalCount,
            },
        });
    } catch (error) {
        console.error('[schema] error:', error instanceof Error ? error.message : 'Unknown error');
        return res.status(500).json({
            success: false,
            error: 'Failed to analyze schema',
        });
    }
});

// Export collection data
router.get('/export', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { database, collection, format = 'json', limit = '1000' } = req.query;

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

        const maxLimit = Math.min(parseInt(limit as string) || 1000, 10000);
        const documents = await col.find({}).limit(maxLimit).toArray();

        if (format === 'csv') {
            // Convert to CSV
            if (documents.length === 0) {
                return res.json({ success: true, data: { csv: '', count: 0 } });
            }

            // Get all unique keys
            const allKeys = new Set<string>();
            documents.forEach(doc => {
                Object.keys(doc).forEach(key => allKeys.add(key));
            });
            const headers = Array.from(allKeys);

            const csvRows = [
                headers.join(','),
                ...documents.map(doc =>
                    headers.map(header => {
                        const value = doc[header];
                        if (value === null || value === undefined) return '';
                        if (typeof value === 'object') return JSON.stringify(value).replace(/"/g, '""');
                        return String(value).includes(',') ? `"${value}"` : String(value);
                    }).join(',')
                )
            ];

            return res.json({
                success: true,
                data: {
                    csv: csvRows.join('\n'),
                    count: documents.length,
                },
            });
        }

        return res.json({
            success: true,
            data: {
                documents,
                count: documents.length,
            },
        });
    } catch (error) {
        console.error('[export] error:', error instanceof Error ? error.message : 'Unknown error');
        return res.status(500).json({
            success: false,
            error: 'Failed to export data',
        });
    }
});

// Index management - list indexes
router.get('/indexes', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
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

        const indexes = await col.indexes();
        const stats = await db.command({ collStats: collection });

        return res.json({
            success: true,
            data: {
                indexes: indexes.map(idx => ({
                    name: idx.name,
                    key: idx.key,
                    unique: idx.unique || false,
                    sparse: idx.sparse || false,
                    background: idx.background || false,
                })),
                totalIndexSize: stats.totalIndexSize || 0,
                indexSizes: stats.indexSizes || {},
            },
        });
    } catch (error) {
        console.error('[indexes] error:', error instanceof Error ? error.message : 'Unknown error');
        return res.status(500).json({
            success: false,
            error: 'Failed to get indexes',
        });
    }
});

// Create index
router.post('/indexes', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { database, collection, keys, options = {} } = req.body;

    if (!database || !collection || !keys) {
        return res.status(400).json({
            success: false,
            error: 'Database, collection, and keys are required',
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

        const result = await col.createIndex(keys, {
            unique: options.unique || false,
            sparse: options.sparse || false,
            background: true,
            name: options.name,
        });

        return res.json({
            success: true,
            data: {
                indexName: result,
            },
        });
    } catch (error) {
        console.error('[create-index] error:', error instanceof Error ? error.message : 'Unknown error');
        return res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to create index',
        });
    }
});

// Drop index
router.delete('/indexes/:indexName', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { database, collection } = req.query;
    const { indexName } = req.params;

    if (!database || !collection || typeof database !== 'string' || typeof collection !== 'string') {
        return res.status(400).json({
            success: false,
            error: 'Database and collection names are required',
        });
    }

    // can't drop the default index, mongo will cry
    if (indexName === '_id_') {
        return res.status(400).json({
            success: false,
            error: 'Cannot drop the default _id index',
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

        await col.dropIndex(indexName);

        return res.json({
            success: true,
            data: {
                dropped: indexName,
            },
        });
    } catch (error) {
        console.error('[drop-index] error:', error instanceof Error ? error.message : 'Unknown error');
        return res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to drop index',
        });
    }
});

// ============================================================
// AGGREGATION PIPELINE - run custom pipelines
// ============================================================
router.post('/aggregate', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { database, collection, pipeline } = req.body;

    if (!database || !collection || !pipeline) {
        return res.status(400).json({
            success: false,
            error: 'Database, collection, and pipeline are required',
        });
    }

    // basic sanity check - pipeline must be an array
    if (!Array.isArray(pipeline)) {
        return res.status(400).json({
            success: false,
            error: 'Pipeline must be an array of stages',
        });
    }

    // security check: no writing data allowed here
    const blockedStages = ['$out', '$merge'];
    const hasBlockedStage = pipeline.some(stage =>
        Object.keys(stage).some(key => blockedStages.includes(key))
    );

    if (hasBlockedStage) {
        return res.status(400).json({
            success: false,
            error: 'Analytics pipelines cannot write data ($out, $merge are blocked)',
        });
    }

    if (!req.session) {
        return res.status(401).json({ success: false, error: 'Session required' });
    }

    const client = await getConnectionFromSession(req.session);
    if (!client) {
        return res.status(401).json({ success: false, error: 'Not connected' });
    }

    try {
        const db = client.db(database);
        const col = db.collection(collection);

        // limit results to 100 to avoid memory issues
        const results = await col.aggregate(pipeline).limit(100).toArray();

        return res.json({
            success: true,
            data: {
                results,
                count: results.length,
            },
        });
    } catch (error) {
        // aggregation errors are usually user mistakes, be helpful
        console.error('[aggregate] error:', error instanceof Error ? error.message : 'Unknown error');
        return res.status(400).json({
            success: false,
            error: error instanceof Error ? error.message : 'Aggregation failed',
        });
    }
});

// ============================================================
// DATA IMPORT - insert documents from uploaded JSON/CSV
// ============================================================
router.post('/import', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { database, collection, documents, mode = 'insert' } = req.body;

    if (!database || !collection || !documents) {
        return res.status(400).json({
            success: false,
            error: 'Database, collection, and documents are required',
        });
    }

    // gotta have something to import
    if (!Array.isArray(documents) || documents.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'Documents must be a non-empty array',
        });
    }

    // safety limit - don't bomb the db
    if (documents.length > 1000) {
        return res.status(400).json({
            success: false,
            error: 'Maximum 1000 documents per import',
        });
    }

    if (!req.session) {
        return res.status(401).json({ success: false, error: 'Session required' });
    }

    const client = await getConnectionFromSession(req.session);
    if (!client) {
        return res.status(401).json({ success: false, error: 'Not connected' });
    }

    try {
        const db = client.db(database);
        const col = db.collection(collection);

        // clean up _id fields if they're strings (common mistake)
        const cleanDocs = [];
        for (const doc of documents) {
            // Security check: Match pattern used in document creation
            const sanitized = sanitizeFilter(doc);
            if (!sanitized.valid) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid document pattern: ${sanitized.error}`,
                });
            }

            const cleaned = { ...sanitized.filter };
            if (cleaned._id && typeof cleaned._id === 'string') {
                delete cleaned._id; // let mongo generate new ones
            }
            cleanDocs.push(cleaned);
        }

        const result = await col.insertMany(cleanDocs, { ordered: false });

        return res.json({
            success: true,
            data: {
                insertedCount: result.insertedCount,
                insertedIds: Object.values(result.insertedIds),
            },
        });
    } catch (error) {
        console.error('[import] error:', error instanceof Error ? error.message : 'Unknown error');
        return res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Import failed',
        });
    }
});

// ============================================================
// JSON SCHEMA VALIDATION - get/set collection validators
// ============================================================
router.get('/validation', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { database, collection } = req.query;

    if (!database || !collection || typeof database !== 'string' || typeof collection !== 'string') {
        return res.status(400).json({
            success: false,
            error: 'Database and collection names are required',
        });
    }

    if (!req.session) {
        return res.status(401).json({ success: false, error: 'Session required' });
    }

    const client = await getConnectionFromSession(req.session);
    if (!client) {
        return res.status(401).json({ success: false, error: 'Not connected' });
    }

    try {
        const db = client.db(database);

        // get collection info which includes validation rules
        const collections = await db.listCollections({ name: collection }).toArray();

        if (collections.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Collection not found',
            });
        }

        // collInfo type doesn't include options, but mongo returns it
        const collInfo = collections[0] as any;

        return res.json({
            success: true,
            data: {
                validator: collInfo.options?.validator || null,
                validationLevel: collInfo.options?.validationLevel || 'off',
                validationAction: collInfo.options?.validationAction || 'error',
            },
        });
    } catch (error) {
        console.error('[validation-get] error:', error instanceof Error ? error.message : 'Unknown error');
        return res.status(500).json({
            success: false,
            error: 'Failed to get validation rules',
        });
    }
});

// set validation schema
router.put('/validation', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { database, collection, validator, validationLevel = 'moderate', validationAction = 'error' } = req.body;

    if (!database || !collection) {
        return res.status(400).json({
            success: false,
            error: 'Database and collection names are required',
        });
    }

    if (!req.session) {
        return res.status(401).json({ success: false, error: 'Session required' });
    }

    const client = await getConnectionFromSession(req.session);
    if (!client) {
        return res.status(401).json({ success: false, error: 'Not connected' });
    }

    try {
        const db = client.db(database);

        // collMod command to update validation rules
        await db.command({
            collMod: collection,
            validator: validator || {},
            validationLevel,
            validationAction,
        });

        return res.json({
            success: true,
            data: { message: 'Validation updated successfully' },
        });
    } catch (error) {
        console.error('[validation-set] error:', error instanceof Error ? error.message : 'Unknown error');
        return res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update validation',
        });
    }
});

// ============================================================
// SLOW QUERY PROFILER - get slow operations from system.profile
// ============================================================
router.get('/slow-queries', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { database, minMs = '100' } = req.query;

    if (!database || typeof database !== 'string') {
        return res.status(400).json({
            success: false,
            error: 'Database name is required',
        });
    }

    if (!req.session) {
        return res.status(401).json({ success: false, error: 'Session required' });
    }

    const client = await getConnectionFromSession(req.session);
    if (!client) {
        return res.status(401).json({ success: false, error: 'Not connected' });
    }

    try {
        const db = client.db(database);

        // check if profiling is enabled
        const profileStatus = await db.command({ profile: -1 });

        // if profiling is off, suggest turning it on
        if (profileStatus.was === 0) {
            return res.json({
                success: true,
                data: {
                    profilingEnabled: false,
                    queries: [],
                    message: 'Profiling is disabled. Enable it with db.setProfilingLevel(1, { slowms: 100 })',
                },
            });
        }

        // get slow queries from system.profile
        const minMillis = parseInt(minMs as string) || 100;
        const queries = await db.collection('system.profile')
            .find({ millis: { $gte: minMillis } })
            .sort({ ts: -1 })
            .limit(50)
            .toArray();

        return res.json({
            success: true,
            data: {
                profilingEnabled: true,
                profilingLevel: profileStatus.was,
                slowMs: profileStatus.slowms,
                queries: queries.map(q => ({
                    op: q.op,
                    ns: q.ns,
                    millis: q.millis,
                    timestamp: q.ts,
                    query: q.command || q.query,
                    planSummary: q.planSummary,
                })),
            },
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[slow-queries] error:', errMsg);

        // shared clusters (Atlas M0/M2/M5) don't allow profiling
        if (errMsg.includes('CMD_NOT_ALLOWED') || errMsg.includes('not allowed')) {
            return res.json({
                success: true,
                data: {
                    profilingEnabled: false,
                    queries: [],
                    message: 'Restricted: You cannot access Profiling on Free Tier (Shared Cluster).',
                    restricted: true,
                },
            });
        }

        return res.status(500).json({
            success: false,
            error: 'Failed to get slow queries. Profiling may not be enabled.',
        });
    }
});

// enable/disable profiling
router.post('/profiling', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { database, level = 1, slowMs = 100 } = req.body;

    if (!database) {
        return res.status(400).json({
            success: false,
            error: 'Database name is required',
        });
    }

    if (!req.session) {
        return res.status(401).json({ success: false, error: 'Session required' });
    }

    const client = await getConnectionFromSession(req.session);
    if (!client) {
        return res.status(401).json({ success: false, error: 'Not connected' });
    }

    try {
        const db = client.db(database);

        // level: 0=off, 1=slow ops only, 2=all ops
        await db.command({
            profile: level,
            slowms: slowMs,
        });

        return res.json({
            success: true,
            data: {
                level,
                slowMs,
                message: level === 0 ? 'Profiling disabled' : `Profiling enabled (level ${level}, slowMs: ${slowMs})`,
            },
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[profiling] error:', errMsg);

        // shared clusters don't allow profiling
        if (errMsg.includes('CMD_NOT_ALLOWED') || errMsg.includes('not allowed')) {
            return res.json({
                success: false,
                error: 'Restricted: You cannot access Profiling on Free Tier (Shared Cluster).',
            });
        }

        return res.status(500).json({
            success: false,
            error: 'Failed to set profiling level',
        });
    }
});

// ============================================================
// LIVE OPCOUNTERS - for real-time charts
// ============================================================
// has bugs and will be fixed later
router.get('/opcounters', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.session) {
        return res.status(401).json({ success: false, error: 'Session required' });
    }

    const client = await getConnectionFromSession(req.session);
    if (!client) {
        return res.status(401).json({ success: false, error: 'Not connected' });
    }

    try {
        const adminDb = client.db('admin');
        const serverStatus = await adminDb.command({ serverStatus: 1 });

        // just return the counters, client will diff them
        return res.json({
            success: true,
            data: {
                timestamp: Date.now(),
                opcounters: serverStatus.opcounters,
                connections: serverStatus.connections?.current || 0,
                memory: serverStatus.mem?.resident || 0,
            },
        });
    } catch (error) {
        console.error('[opcounters] error:', error instanceof Error ? error.message : 'Unknown error');
        return res.status(500).json({
            success: false,
            error: 'Failed to get opcounters',
        });
    }
});

export default router;

