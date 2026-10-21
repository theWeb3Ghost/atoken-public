import { Worker } from 'bullmq';
import { config } from '../config.js';
import { coll } from '../db.js';
import { log } from '../lib/logger.js';
import { createConnection } from '../queues.js';
import { processBatch, scheduleCycle } from '../services/sampler.js';
import { backfillLabels } from '../services/backfill.js';
import { openPaperTrades, gradePaperTrades } from '../services/paper.js';
import { enqueueNotification } from '../services/notifier/index.js';
import { runnerMessage } from '../services/notifier/format.js';

export function startSampleWorker() {
  const worker = new Worker('sample', async (job) => {
    if (job.name === 'gtBackfill') return backfillLabels(job.data);

    const r = await processBatch(job.data);
    for (const f of r.flips || []) {
      const cand = await coll.candidates.findOne({ chainId: f.chainId, tokenAddress: f.tokenAddress });
      await enqueueNotification({
        dedupeKey: `runner__${f.chainId}__${f.tokenAddress}`,
        kind: 'runner', chainId: f.chainId, tokenAddress: f.tokenAddress,
        text: runnerMessage({ ...cand, peakMultiple: f.multiple }),
        keyboard: [[{ text: '📈 DexScreener', url: `https://dexscreener.com/${f.chainId}/${f.tokenAddress}` }]],
      });
    }
    return r;
  }, { connection: createConnection(), concurrency: 2, limiter: { max: config.sample.rpm, duration: 60000 } });

  worker.on('error', (e) => log.error('[sample worker]', e.message));

  let stopped = false;
  const tick = async () => {
    if (stopped || !config.sample.enabled) return;
    try { await scheduleCycle(); } catch (e) { log.warn('[sample] cycle failed:', e.message); }
    try { await openPaperTrades(); await gradePaperTrades(); } catch (e) { log.warn('[paper] sync failed:', e.message); }
  };
  const timer = setInterval(tick, config.sample.intervalMs);
  const boot = setTimeout(tick, 20000);
  log.info(`[sample worker] started (every ${config.sample.intervalMs / 1000}s, incl. paper sync)`);
  return { worker, stop: async () => { stopped = true; clearInterval(timer); clearTimeout(boot); await worker.close(); } };
}