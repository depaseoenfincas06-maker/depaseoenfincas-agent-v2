import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null, // BullMQ requires this
  enableReadyCheck: true,
});

redis.on('error', (err: Error) => {
  logger.error({ err }, 'redis error');
});

redis.on('ready', () => {
  logger.info('redis connected');
});
