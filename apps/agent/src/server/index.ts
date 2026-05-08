import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';
import { pool } from '../persistence/db.js';
import { up as runMigrations } from '../persistence/migrate.js';
import { webhookRoutes } from './routes/webhook.js';
import { chatwootWebhookRoutes } from './routes/chatwoot-webhook.js';
import { adminRoutes } from './routes/admin.js';
import { reservationPdfRoutes } from './routes/reservation-pdf.js';

async function buildServer() {
  const app = Fastify({ loggerInstance: logger, disableRequestLogging: false });

  await app.register(sensible);
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max for audio uploads

  /**
   * Capture the raw request body for application/json POSTs so that
   * HMAC verification (Chatwoot's x-chatwoot-signature header) can hash
   * the EXACT bytes Chatwoot sent. Without this, a re-stringified
   * payload would produce a different HMAC and signature checks would
   * always fail. Other routes can ignore req.rawBody.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      try {
        const rawBody = body as string;
        (req as unknown as { rawBody: string }).rawBody = rawBody;
        const json = rawBody.length > 0 ? JSON.parse(rawBody) : {};
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

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
  // Public, HMAC-signed reservation confirmation page. Mounted at /api so
  // the existing CORS / route hierarchy handles it.
  await app.register(reservationPdfRoutes, { prefix: '/api' });

  return app;
}

async function start() {
  // Auto-apply pending migrations on boot so a fresh deploy picks up new
  // schema without a manual run. Idempotent — applied migrations are
  // tracked in the _migrations table. If a migration fails the server
  // refuses to start (we'd rather take downtime than serve traffic with a
  // mismatched schema).
  if (process.env.AUTO_MIGRATE_ON_BOOT !== 'false') {
    try {
      const result = await runMigrations();
      logger.info(result, 'boot migrations complete');
    } catch (err) {
      logger.error({ err }, 'boot migrations failed — refusing to start');
      process.exit(1);
    }
  }

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
