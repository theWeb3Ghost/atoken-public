import { config } from './config.js';
import { connectDb, coll, closeDb } from './db.js';
import { log } from './lib/logger.js';
import { metrics } from './lib/metrics.js';
import { seedSignalConfig } from './services/signals.js';
import { startIngestion } from './services/ingestion.js';
import { handleTokenEvent } from './services/discovery.js';
import { startWorkers } from './workers/index.js';
import { startApi } from './api/server.js';
import { startBot } from './bot/telegram.js';
import { closeQueues } from './queues.js';

process.on('unhandledRejection', (e) => log.error('[unhandledRejection]', e?.stack || String(e)));

const modes = new Set(String(config.workerMode).split(',').map((s) => s.trim().toLowerCase()));
const has = (m) => modes.has('all') || modes.has(m);
const shutdowns = [];

async function main() {
  await connectDb();
  await seedSignalConfig();

  if (has('ingestion')) shutdowns.push(startIngestion(handleTokenEvent));
  if (has('workers')) {
  const workers = startWorkers();
  shutdowns.push(() => workers.stop());
}
  if (has('api')) {
    startApi();
    shutdowns.push(startBot());
  }

  const metricsTimer = setInterval(async () => {
    try { await coll.systemMetrics.insertOne({ at: new Date(), mode: config.workerMode, vps: config.vps, ...metrics.snapshot() }); } catch {}
  }, 60_000);
  shutdowns.push(() => clearInterval(metricsTimer));

  log.info(`[main] token-radar started (mode=${config.workerMode}, vps=${config.vps})`);
}

main().catch((err) => { log.error('fatal:', err); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log.info(`[main] ${sig} received, shutting down…`);
    for (const fn of shutdowns.splice(0)) { try { await fn(); } catch {} }
    try { await closeDb(); } catch {}
    try { await closeQueues(); } catch {}
    process.exit(0);
  });
}
