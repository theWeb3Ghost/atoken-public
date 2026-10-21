import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { coll } from '../db.js';
import { log } from '../lib/logger.js';
import { backfillLabels } from './backfill.js';
import { buildDataset } from './dataset.js';
import { rescoreAll, loadModel } from './score.js';
import { enqueueNotification } from './notifier/index.js';
import { sampleQueue, trainQueue } from '../queues.js';
import { bucketMonitorCycle } from './bucketMonitor.js';
import { periodicPaperTradeCheck } from './tradeAdvisor.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runtimeDoc = () => coll.config.findOne({ _id: 'runtime' });

export async function isMaintenanceEnabled() {
  const r = await runtimeDoc();
  return r?.maintenance ?? config.maintenance.enabled;
}
export async function isDigestEnabled() {
  const r = await runtimeDoc();
  return r?.digest ?? (config.digest ?? config.vps);
}

export async function runMaintenance() {
  if (!(await isMaintenanceEnabled())) return { skipped: true };
  const started = Date.now();
  const res = { backfilled: 0, tokensBackfilled: 0, exportedRows: 0, train: null, rescored: 0 };
  try {
    // 1) fill missing sample gaps via GeckoTerminal candles
    const cands = await coll.candidates.find({ status: { $ne: 'ignored' } })
      .sort({ createdAt: -1 }).limit(config.sample.maxTracked)
      .project({ chainId: 1, tokenAddress: 1, createdAt: 1 }).toArray();
    let done = 0;
    for (const c of cands) {
      if (done >= config.maintenance.backfillPerRun) break;
      if (Date.now() - new Date(c.createdAt).getTime() < 6 * 3600e3) continue;
      if (await coll.samples.countDocuments({ chainId: c.chainId, tokenAddress: c.tokenAddress }) >= 3) continue;
      const r = await backfillLabels({ chainId: c.chainId, tokenAddress: c.tokenAddress, createdAt: c.createdAt, horizonMs: config.sample.windowHours * 3600e3 }).catch(() => ({ ok: false }));
      if (r.ok) { res.backfilled += r.inserted || 0; res.tokensBackfilled++; done++; await sleep(2000); }
    }

    // 2) export dataset (training queued as background job)
    const ex = await buildDataset();
    res.exportedRows = ex.rows;

    // 3) bucket performance monitoring + adjusted scoring
    try {
      const bm = await bucketMonitorCycle();
      res.bucketAdjusted = bm.adjustedCount;
      res.activeBucket = bm.activeBucket;
      res.runnerRate = bm.bestBucket?.runnerRatePct || null;
    } catch (e) { log.warn('[maint] bucket monitor failed:', e.message); }

    // 3.5) periodic paper-trade check — auto-resolve threshold crossings
    try {
      const pt = await periodicPaperTradeCheck({ force: false });
      res.paperTraded = pt.successes;
      res.deadZoned = pt.deadZones;
    } catch (e) { log.warn('[maint] paper trade check failed:', e.message); }
    if (config.maintenance.autoTrain) {
      // Enqueue training as a background job instead of blocking
      await trainQueue.add('train', { exportedAt: new Date().toISOString() }, {
        jobId: `train__${Date.now()}`,
        removeOnComplete: { age: 24 * 3600 },
        removeOnFail: { age: 7 * 24 * 3600 },
      });
      res.train = { status: 'queued', message: 'training job enqueued' };
    }

    await coll.config.updateOne({ _id: 'maintenance' },
      { $set: { lastRunAt: new Date(), lastResult: res, durationMs: Date.now() - started } }, { upsert: true });
    log.info(`[maint] ok: backfill +${res.tokensBackfilled} tokens, export ${res.exportedRows} rows, train ${res.train ? 'queued' : 'off'}, rescored ${res.rescored}`);
  } catch (e) { log.warn('[maint] failed:', e.message); }
  return res;
}

async function sendDigest() {
  if (!(await isDigestEnabled())) return;
  const today = new Date().toISOString().slice(0, 10);
  const last = await coll.config.findOne({ _id: 'digest' });
  if (last?.lastAt?.toISOString?.().slice(0, 10) === today) return;
  const since = new Date(Date.now() - 864e5);
  const [newCands, newRunners] = await Promise.all([
    coll.candidates.countDocuments({ createdAt: { $gte: since } }),
    coll.tokens.countDocuments({ runner: true, becameRunnerAt: { $gte: since } }),
  ]);
  const closed = await coll.paperTrades.find({ status: 'closed', closedAt: { $gte: since } }).toArray();
  const avg = closed.length ? (closed.reduce((s, t) => s + (t.achievedMult || 1), 0) / closed.length).toFixed(2) : null;
  const q = await sampleQueue.count();
  const m = loadModel();
  await enqueueNotification({
    dedupeKey: `digest__${today}`, kind: 'digest',
    text: ['🌗 <b>DAILY DIGEST</b>', '',
      `New candidates: ${newCands} · runners: ${newRunners}`,
      `Paper closed today: ${closed.length}${avg ? ` · avg exit ${avg}x` : ''}`,
      `Samples pending: ${q}`,
      `Model: ${m ? `AUC ${Number(m.meta.walk_forward_auc).toFixed(3)} (${m.meta.rows} rows)` : 'collecting — gates not passed'}`].join('\n'),
  });
  await coll.config.updateOne({ _id: 'digest' }, { $set: { lastAt: new Date() } }, { upsert: true });
}

export function startMaintenance() {
  let stopped = false;
  const boot = setTimeout(() => { if (!stopped) runMaintenance(); }, 3 * 60e3);
  const loop = setInterval(() => { if (!stopped) runMaintenance(); }, config.maintenance.intervalMs);
  const digest = setInterval(() => { if (!stopped) sendDigest().catch((e) => log.warn('[digest]', e.message)); }, 3600e3);
  log.info(`[maint] autopilot on (every ${config.maintenance.intervalMs / 3600e3}h, autoTrain=${config.maintenance.autoTrain}, vps=${config.vps})`);
  return { stop: async () => { stopped = true; clearTimeout(boot); clearInterval(loop); clearInterval(digest); } };
}
