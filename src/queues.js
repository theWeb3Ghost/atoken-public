import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config.js';

export function createConnection() {
  return new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
}

let shared;
export function queueConnection() {
  if (!shared) shared = createConnection();
  return shared;
}

const defaults = (attempts, delayMs) => ({
  attempts,
  backoff: { type: 'fixed', delay: delayMs },
  removeOnComplete: { age: 24 * 3600, count: 2000 },
  removeOnFail: { age: 7 * 24 * 3600 },
});

export const scrapeQueue = new Queue('scrape', { connection: queueConnection(), defaultJobOptions: defaults(config.scrape.retries, config.scrape.retryDelayMs) });
export const notifyQueue = new Queue('notify', { connection: queueConnection(), defaultJobOptions: defaults(5, 3000) });
export const analyzeQueue = new Queue('analyze', { connection: queueConnection(), defaultJobOptions: defaults(2, 15000) });
export const sampleQueue = new Queue('sample', { connection: queueConnection(), defaultJobOptions: defaults(2, 10000) });
export const llmFeatQueue = new Queue('llmfeat', { connection: queueConnection(), defaultJobOptions: defaults(2, 20000) });
export const trainQueue = new Queue('train', { connection: queueConnection(), defaultJobOptions: defaults(1, 60000) });

export async function closeQueues() {
  await Promise.allSettled([
    scrapeQueue.close(), notifyQueue.close(), analyzeQueue.close(),
    sampleQueue.close(), llmFeatQueue.close(), trainQueue.close(),
  ]);
  if (shared) { try { await shared.quit(); } catch {} }
}