import { MongoClient } from 'mongodb';
import { config } from './config.js';
import { log } from './lib/logger.js';

let client, db;

const RETRY_DELAYS = [1000, 3000, 5000, 10000, 15000]; // escalating retries

export async function connectDb(retries = RETRY_DELAYS.length) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      client = new MongoClient(config.mongoUri, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        maxPoolSize: 50,
      });
      await client.connect();
      db = client.db();
      await ensureIndexes();
      log.info('[db] connected');
      return db;
    } catch (err) {
      lastErr = err;
      log.warn(`[db] connect attempt ${attempt + 1}/${retries} failed: ${err.message}`);
      if (attempt < retries - 1) {
        const delay = RETRY_DELAYS[attempt];
        log.info(`[db] retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  log.error('[db] all connection attempts failed');
  throw lastErr;
}

export function getDb() {
  if (!db) throw new Error('db not connected');
  return db;
}

export async function closeDb() {
  if (client) {
    try { await client.close(); } catch (e) { /* ignore */ }
  }
}

export const coll = {
  get tokens() { return db.collection('tokens'); },
  get scrapeJobs() { return db.collection('scrape_jobs'); },
  get scans() { return db.collection('scans'); },
  get candidates() { return db.collection('candidates'); },
  get analyses() { return db.collection('analyses'); },
  get notifications() { return db.collection('notifications'); },
  get config() { return db.collection('config'); },
  get systemMetrics() { return db.collection('system_metrics'); },
  get samples() { return db.collection('samples'); },
  get paperTrades() { return db.collection('paper_trades'); },
  get monitoring() { return db.collection('monitoring'); },
};

async function ensureIndexes() {
  await coll.tokens.createIndex({ chainId: 1, tokenAddress: 1 }, { unique: true });
  await coll.tokens.createIndex({ runner: 1, becameRunnerAt: -1 });
  await coll.tokens.createIndex({ lastSampleAt: -1 });
  await coll.tokens.createIndex({ scrapeQueuedAt: 1 });
  await coll.scrapeJobs.createIndex({ jobId: 1 }, { unique: true });
  await coll.scrapeJobs.createIndex({ status: 1, createdAt: -1 });
  await coll.scans.createIndex({ chainId: 1, tokenAddress: 1, scrapedAt: -1 });
  await coll.scans.createIndex({ scrapedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 14 });
  await coll.candidates.createIndex({ chainId: 1, tokenAddress: 1 }, { unique: true });
  await coll.candidates.createIndex({ createdAt: -1 });
  await coll.candidates.createIndex({ analysisStatus: 1 });
  await coll.candidates.createIndex({ score: -1 });
  await coll.candidates.createIndex({ status: 1, score: -1 });
  await coll.analyses.createIndex({ chainId: 1, tokenAddress: 1, requestedAt: -1 });
  await coll.notifications.createIndex({ dedupeKey: 1 }, { unique: true });
  await coll.notifications.createIndex({ status: 1, createdAt: -1 });
  await coll.samples.createIndex({ chainId: 1, tokenAddress: 1, t: 1 });
  await coll.samples.createIndex({ t: 1 }, { expireAfterSeconds: config.sample.ttlDays * 86400 });
  await coll.paperTrades.createIndex({ chainId: 1, tokenAddress: 1 }, { unique: true });
  await coll.paperTrades.createIndex({ status: 1, openedAt: -1 });
  await coll.monitoring.createIndex({ tokenId: 1 }, { unique: true });
  await coll.monitoring.createIndex({ probability: -1 });
}
