import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';
import { pool } from '../persistence/db.js';
import { webhookRoutes } from './routes/webhook.js';

async function buildServer() {
  const app = Fastify({ loggerInstance: logger, disableRequestLogging: false });

  await app.register(sensible);
  await app.register(cors, { origin: true });

  app.get('/health', async () => {
    const dbOk = await pool
      .query('SELECT 1')
      .then(() => true)
      .catch(() => false);
    return { ok: true, db: dbOk, ts: new Date().toISOString() };
  });

  await app.register(webhookRoutes, { prefix: '/webhook' });
  // Admin/dashboard routes registered in a later phase.

  return app;
}

async function start() {
  const app = await buildServer();
  try {
    await app.listen({ port: config.AGENT_HTTP_PORT, host: '0.0.0.0' });
    logger.info({ port: config.AGENT_HTTP_PORT }, 'agent server listening');
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
