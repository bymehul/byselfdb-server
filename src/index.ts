import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config/index.js';
import connectionRoutes from './routes/connection.js';
import databaseRoutes from './routes/database.js';
import collectionRoutes from './routes/collection.js';
import analyticsRoutes from './routes/analytics.js';
import { closeAllConnections } from './lib/mongodb.js';
import { destroyAllSessions, stopCleanup } from './lib/sessionStore.js';
import { connectRateLimiter, apiRateLimiter, mutationRateLimiter } from './middleware/rateLimit.js';

const app = express();

// trust proxy for rate limits
if (config.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// explicitly block wildcards in prod
if (config.NODE_ENV === 'production') {
  const origins = Array.isArray(config.CORS_ORIGIN) ? config.CORS_ORIGIN : [config.CORS_ORIGIN];
  if (origins.includes('*')) {
    console.error('[security] CORS_ORIGIN cannot be "*" in production!');
    process.exit(1);
  }
}

app.use(cors({
  origin: config.CORS_ORIGIN,
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// global rate limit
app.use('/api', apiRateLimiter);

app.get('/', (req, res) => {
  res.json({
    message: 'byselfdb api is running',
    docs: 'https://byselfdb.cyou',
    version: '1.0.0'
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// strict limit for connection attempts
app.use('/api/connect', connectRateLimiter);

// limit writes
app.use('/api/documents', mutationRateLimiter);

app.use('/api', connectionRoutes);
app.use('/api', databaseRoutes);
app.use('/api', collectionRoutes);
app.use('/api', analyticsRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
  });
});

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[error]', err.message);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error',
  });
});

const server = app.listen(config.PORT, () => {
  console.log(`[byselfdb] running on port ${config.PORT}`);
  console.log(`[byselfdb] environment: ${config.NODE_ENV}`);
  console.log(`[byselfdb] cors origin: ${config.CORS_ORIGIN}`);
});

process.on('SIGTERM', async () => {
  console.log('[byselfdb] received SIGTERM, shutting down gracefully...');
  stopCleanup();
  server.close(async () => {
    await closeAllConnections();
    destroyAllSessions();
    console.log('[byselfdb] server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('[byselfdb] received SIGINT, shutting down gracefully...');
  stopCleanup();
  server.close(async () => {
    await closeAllConnections();
    destroyAllSessions();
    console.log('[byselfdb] server closed');
    process.exit(0);
  });
});

export default app;
