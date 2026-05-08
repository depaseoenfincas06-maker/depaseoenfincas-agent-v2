import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';
import { pool } from '../persistence/db.js';
import { webhookRoutes } from './routes/webhook.js';
import { chatwootWebhookRoutes } from './routes/chatwoot-webhook.js';
import { adminRoutes } from './routes/admin.js';

async function buildServer() {
  const app = Fastify({ loggerInstance: logger, disableRequestLogging: false });

  await app.register(sensible);
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max for audio uploads

  app.get('/health', async () => {
    const dbOk = await pool
      .query('SELECT 1')
      .then(() => true)
      .catch(() => false);
    return { ok: true, db: dbOk, ts: new Date().toISOString() };
  });

  await app.register(webhookRoutes, { prefix: '/webhook' });
  await app.register(chatwootWebhookRoutes, { prefix: '/webhook' });
  await app.register(adminRoutes, { prefix: '/api' });

  return app;
}

async function start() {
  const app = await buildServer();
  // Render / Heroku / Fly inject $PORT — bind to it when present so the
  // platform's load balancer can reach us. Falls back to AGENT_HTTP_PORT
  // for local development.
  const port = config.PORT ?? config.AGENT_HTTP_PORT;
  try {
    await app.listen({ port, host: '0.0.0.0' });
    logger.info({ port }, 'agent server listening');
  } catch (err) {
    logger.error({ err }, 'failed to start server');
    process.exit(1);
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      logger.info({ sig }, 'shutting down');
      await app.close();
      await pool.end();
      process.exit(0);
    });
  }
}

start();
