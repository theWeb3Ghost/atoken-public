import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { coll } from '../db.js';
import { log } from '../lib/logger.js';
import { metrics } from '../lib/metrics.js';
import { scrapeQueue, sampleQueue } from '../queues.js';
import * as predictor from '../services/runnerPredictor.js';
import { requestAnalysis } from '../services/analysis.js';
import { getSignalConfig, saveSignalConfig } from '../services/signals.js';
import { buildDataset } from '../services/dataset.js';
import { rescoreAll, loadModel } from '../services/score.js';
import { getAnalyticsSummary, getRunnerRows } from '../services/analytics.js';
import { runPatternNarrative } from '../services/patterns.js';
import { runnerClusters } from '../services/similarity.js';
import { openPaperTrades, gradePaperTrades } from '../services/paper.js';
import { fullReport, buildTopRows, systemStatusText } from '../services/report.js';
import { computeDeadZoneStats, getDeadZoneTokensForScatter, getRunnerScatterRows } from '../services/deadzone.js';
import { computeBucketPerformance, findBestBucket, getCandidatesInBucket, scoreWithAdjustment, getFastPeakCandidates, THRESHOLD_PRESETS, DEFAULT_THRESHOLD } from '../services/bucketModel.js';
import { isMaintenanceEnabled, isDigestEnabled, runMaintenance } from '../services/maintenance.js';

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function startApi() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    if (config.apiToken && req.method !== 'GET' && req.path.startsWith('/api/') && req.headers['x-api-token'] !== config.apiToken) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });

  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')));

  app.get('/health', ah(async (_req, res) => {
    const [scrape, notify, analyze, sample] = await Promise.all([
      scrapeQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      (await import('../queues.js')).notifyQueue.getJobCounts('waiting', 'active', 'failed'),
      (await import('../queues.js')).analyzeQueue.getJobCounts('waiting', 'active', 'completed', 'failed'),
      sampleQueue.getJobCounts('waiting', 'active', 'failed'),
    ]);
    let oldestPendingMs = null;
    const first = await scrapeQueue.getWaiting(0, 0);
    if (first.length) oldestPendingMs = Date.now() - first[0].timestamp;

    // Dependency checks
    const deps = {};
    try {
      const { getDb } = await import('../db.js');
      const db = getDb();
      await db.command({ ping: 1 });
      deps.mongo = true;
    } catch (e) { deps.mongo = false; }

    try {
      const { createConnection } = await import('../queues.js');
      const conn = createConnection();
      await conn.ping();
      await conn.quit();
      deps.redis = true;
    } catch (e) { deps.redis = false; }

    try {
      if (!config.llm.apiKey) { deps.llm = false; } else {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(`${config.llm.baseUrl}/models`, {
          headers: { authorization: `Bearer ${config.llm.apiKey}` },
          signal: ctrl.signal,
        });
        clearTimeout(t);
        deps.llm = r.ok;
      }
    } catch { deps.llm = false; }

    const allOk = deps.mongo && deps.redis;
    res.status(allOk ? 200 : 503).json({
      ok: allOk,
      uptimeSec: Math.floor(process.uptime()),
      queues: { scrape, notify, analyze, sample },
      oldestPendingMs,
      metrics: metrics.snapshot(),
      deps,
    });
  }));

  // ---- candidates ----
  app.get('/api/candidates', ah(async (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const q = {};
    if (req.query.includeIgnored !== 'true') q.status = { $ne: 'ignored' };
    if (req.query.analysis) q.analysisStatus = req.query.analysis;
    const items = await coll.candidates
      .find(q, { projection: { websiteText: 0, matches: 0 } })
      .sort({ createdAt: -1 }).limit(limit).toArray();
    res.json({ items });
  }));

  app.get('/api/candidates/:chainId/:tokenAddress', ah(async (req, res) => {
    const c = await coll.candidates.findOne({
      chainId: req.params.chainId.toLowerCase(),
      tokenAddress: req.params.tokenAddress.toLowerCase(),
    });
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json(c);
  }));

  app.post('/api/analyze', ah(async (req, res) => {
    const { chainId, tokenAddress } = req.body || {};
    if (!chainId || !tokenAddress) return res.status(400).json({ error: 'chainId and tokenAddress required' });
    // Validate tokenAddress format — support EVM (42 hex chars) and Solana (32-44 base58 chars)
    const addr = String(tokenAddress);
    const cleanAddr = addr.startsWith('0x') ? addr.slice(2) : addr;
    const isEvm = /^0x[0-9a-fA-F]{40}$/.test(addr);
    const isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
    if (!isEvm && !isSolana) {
      return res.status(400).json({ error: 'invalid tokenAddress format (expected EVM 0x… or Solana base58 address)' });
    }
    res.json(await requestAnalysis(chainId, tokenAddress));
  }));

  app.get('/api/analyses/:chainId/:tokenAddress/latest', ah(async (req, res) => {
    const a = await coll.analyses.findOne(
      { chainId: req.params.chainId.toLowerCase(), tokenAddress: req.params.tokenAddress.toLowerCase(), status: 'done' },
      { sort: { requestedAt: -1 } }
    );
    if (!a) return res.status(404).json({ error: 'no completed analysis' });
    res.json(a);
  }));

  app.post('/api/ignore', ah(async (req, res) => {
    const { chainId, tokenAddress } = req.body || {};
    await coll.candidates.updateOne(
      { chainId: String(chainId).toLowerCase(), tokenAddress: String(tokenAddress).toLowerCase() },
      { $set: { status: 'ignored' } }
    );
    res.json({ ok: true });
  }));

  // ---- signals config ----
  app.get('/api/config/signals', ah(async (_req, res) => {
    const cfg = await getSignalConfig(true);
    res.json({ signals: cfg.signals, version: cfg.version });
  }));
  app.put('/api/config/signals', ah(async (req, res) => {
    if (!Array.isArray(req.body?.signals)) return res.status(400).json({ error: 'signals array required' });
    await saveSignalConfig(req.body.signals);
    const cfg = await getSignalConfig(true);
    res.json({ signals: cfg.signals, version: cfg.version });
  }));

  // ---- analytics ----
  app.get('/api/analytics/summary', ah(async (_req, res) => res.json(await getAnalyticsSummary())));
  app.get('/api/analytics/runners.csv', ah(async (_req, res) => {
    const rows = await getRunnerRows();
    const cols = ['chainId', 'tokenAddress', 'websiteUrl', 'firstSeenAt', 'becameRunnerAt', 'peakAt', 'timeToPeakMin', 'baselineUsd', 'peakUsd', 'peakMultiple', 'signals'];
    const csv = [cols.join(',')]
      .concat(rows.map((r) => cols.map((c) => JSON.stringify(r[c] ?? '')).join(','))).join('\n');
    res.setHeader('content-type', 'text/csv');
    res.setHeader('content-disposition', 'attachment; filename="runners.csv"');
    res.send(csv);
  }));
  app.post('/api/analytics/llm', ah(async (_req, res) => {
    const summary = await getAnalyticsSummary();
    if (summary.runners < 3) return res.status(400).json({ error: `need at least 3 runners, have ${summary.runners}` });
    res.json({ narrative: await runPatternNarrative(summary) });
  }));

  app.get('/api/analytics/runner-dna', ah(async (_req, res) => res.json(await runnerClusters())));

  // ---- ML ----
  app.get('/api/ml/status', ah(async (_req, res) => {
    const m = loadModel(true);
    const withFeat = await coll.candidates.countDocuments({ features: { $exists: true } });
    const runners = await coll.tokens.countDocuments({ runner: true });
    res.json({ model: m?.meta || null, candidatesWithFeatures: withFeat, runnersSoFar: runners,
      gates: { minRows: 200, minRunners: 20 } });
  }));
  app.post('/api/ml/export', ah(async (_req, res) => res.json(await buildDataset())));
  app.post('/api/ml/rescore', ah(async (_req, res) => res.json({ rescored: await rescoreAll() })));
  app.get('/api/ml/calibration', ah(async (_req, res) => {
    const cands = await coll.candidates.find({ score: { $exists: true } })
      .project({ chainId: 1, tokenAddress: 1, score: 1, scoreBucket: 1 }).toArray();
    const toks = cands.length ? await coll.tokens.find(
...(cands.length ? [{ $or: cands.map((c) => ({ chainId: c.chainId, tokenAddress: c.tokenAddress })) }] : []),
      { projection: { chainId: 1, tokenAddress: 1, runner: 1 } }).toArray() : [];
    const ran = new Set(toks.filter((t) => t.runner).map((t) => `${t.chainId}:${t.tokenAddress}`));
    const buckets = {};
    for (const c of cands) {
      buckets[c.scoreBucket] ??= { bucket: c.scoreBucket, n: 0, ran: 0, avgScore: 0 };
      const b = buckets[c.scoreBucket];
      b.n++; b.avgScore += c.score;
      if (ran.has(`${c.chainId}:${c.tokenAddress}`)) b.ran++;
    }
    const items = Object.values(buckets).map((b) => ({ ...b, avgScore: +(b.avgScore / b.n).toFixed(3),
      hitRatePct: Math.round((b.ran / b.n) * 100) })).sort((a, b2) => a.bucket.localeCompare(b2.bucket));
    res.json({ items });
  }));
  app.post('/api/ml/backfill', ah(async (req, res) => {
    const maxN = Math.min(200, Number(req.query.max) || 60);
    const cands = await coll.candidates.find({ status: { $ne: 'ignored' } })
      .sort({ createdAt: -1 }).limit(config.sample.maxTracked).toArray();
    let queued = 0;
    for (const c of cands) {
      if (await coll.samples.countDocuments({ chainId: c.chainId, tokenAddress: c.tokenAddress }) >= 3) continue;
      if (Date.now() - new Date(c.createdAt).getTime() < 6 * 3600e3) continue;
      await sampleQueue.add('gtBackfill',
        { chainId: c.chainId, tokenAddress: c.tokenAddress, createdAt: c.createdAt, horizonMs: config.sample.windowHours * 3600e3 },
        { jobId: `gtbf__${c.chainId}__${c.tokenAddress}` });
      if (++queued >= maxN) break;
    }
    res.json({ queued });
  }));

  // ---- paper ----
  app.post('/api/paper/sync', ah(async (_req, res) => res.json({ opened: await openPaperTrades(), ...(await gradePaperTrades()) })));
  app.get('/api/paper/summary', ah(async (_req, res) => {
    const all = await coll.paperTrades.find({}).toArray();
    const closed = all.filter((t) => t.status === 'closed');
    const avg = (a) => (a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(3) : null);
    res.json({
      open: all.length - closed.length, closed: closed.length,
      avgAchieved: avg(closed.map((t) => t.achievedMult || 1)),
      medianPeak: avg(closed.map((t) => t.peakMult || 1)),
      winRatePct: closed.length ? Math.round(closed.filter((t) => (t.achievedMult || 1) > 1).length / closed.length * 100) : null,
    });
  }));

  // ---- reports / top / runtime ----
  app.get('/api/tokens/:chainId/:tokenAddress/full', ah(async (req, res) => {
    const chainId = req.params.chainId.toLowerCase();
    const tokenAddress = req.params.tokenAddress.toLowerCase();
    const r = await fullReport(chainId, tokenAddress);
    if (!r.ok) return res.status(404).json({ error: 'not tracked' });
    const [cand, tok, paper, analysis] = await Promise.all([
      coll.candidates.findOne({ chainId, tokenAddress }),
      coll.tokens.findOne({ chainId, tokenAddress }),
      coll.paperTrades.findOne({ chainId, tokenAddress }),
      coll.analyses.findOne({ chainId, tokenAddress, status: 'done' }, { sort: { requestedAt: -1 } }),
    ]);
    res.json({ report: r.text, candidate: cand, token: tok, paper, analysis });
  }));

  app.get('/api/top', ah(async (_req, res) => {
    const rows = await buildTopRows(25);
    res.json({ items: rows.map((r) => ({
      chainId: r.chainId, tokenAddress: r.tokenAddress, websiteUrl: r.websiteUrl,
      score: r.score, scoreBucket: r.scoreBucket, signals: r.matchedSignals,
      createdAt: r.createdAt, peakMultiple: r.peakMultiple, runner: r.runner,
      paperExit: r.paperExit, inTraining: (r.features?.llm_done ?? 0) === 1,
      analysisStatus: r.analysisStatus,
    })) });
  }));

  app.get('/api/config/runtime', ah(async (_req, res) => {
    const mt = await coll.config.findOne({ _id: 'maintenance' });
    res.json({ vpsMode: config.vps, maintenance: await isMaintenanceEnabled(), digest: await isDigestEnabled(), lastMaintenance: mt?.lastRunAt || null, lastResult: mt?.lastResult || null });
  }));
  app.put('/api/config/runtime', ah(async (req, res) => {
    const set = {};
    if (typeof req.body?.maintenance === 'boolean') set.maintenance = req.body.maintenance;
    if (typeof req.body?.digest === 'boolean') set.digest = req.body.digest;
    if (Object.keys(set).length) await coll.config.updateOne({ _id: 'runtime' }, { $set: set }, { upsert: true });
    res.json({ vpsMode: config.vps, maintenance: await isMaintenanceEnabled(), digest: await isDigestEnabled() });
  }));
  app.post('/api/maintenance/run-now', ah(async (_req, res) => res.json(await runMaintenance())));

  // ---- dead zone analysis ----
  app.get('/api/deadzone/stats', ah(async (_req, res) => res.json(await computeDeadZoneStats())));

  app.get('/api/runners/scatter', ah(async (req, res) => {
    const limit = Math.min(1000, Number(req.query.limit) || 500);
    const [runners, deadZone] = await Promise.all([
      getRunnerScatterRows(limit),
      getDeadZoneTokensForScatter(limit),
    ]);
    const deadzoneStats = await computeDeadZoneStats();
    res.json({
      runners,
      deadZone,
      deadzoneStats,
      totalRunners: runners.length,
      totalDeadZone: deadZone.length,
    });
  }));

  // ---- bucket performance model ----
  app.get('/api/bucket-performance', ah(async (req, res) => {
    const minSamples = Number(req.query.minSamples) || 10;
    const threshold = Number(req.query.threshold);
    const resolvedThreshold = threshold || DEFAULT_THRESHOLD;
    const perf = await computeBucketPerformance(minSamples, resolvedThreshold);
    const best = perf.highBuckets.length ? perf.highBuckets[0] : (perf.buckets.length ? perf.buckets[0] : null);
    const bestBucket = await findBestBucket(minSamples, resolvedThreshold);
    // pull active bucket from bucket monitor config
    const { getBucketMonitorState } = await import('../services/bucketMonitor.js');
    const monitorState = await getBucketMonitorState();
    res.json({ ...perf, bestBucket, activeBucket: monitorState.activeBucket, thresholdPresets: THRESHOLD_PRESETS });
  }));

  app.get('/api/bucket-candidates/:bucket', ah(async (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const result = await getCandidatesInBucket(req.params.bucket, limit);
    res.json(result);
  }));

  app.get('/api/bucket-faster', ah(async (req, res) => {
    const bucket = req.query.bucket || null;
    const deadlineMin = Number(req.query.deadlineMin) || 200;
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const result = await getFastPeakCandidates(bucket, deadlineMin, limit);
    res.json(result);
  }));

  app.get('/api/bucket-monitor/state', ah(async (_req, res) => {
    const { getBucketMonitorState } = await import('../services/bucketMonitor.js');
    const state = await getBucketMonitorState();
    res.json(state);
  }));

  // ---- price sample time series ----
  app.get('/api/samples/:chainId/:tokenAddress', ah(async (req, res) => {
    const chainId = String(req.params.chainId).toLowerCase();
    const tokenAddress = String(req.params.tokenAddress).toLowerCase();
    const hours = Number(req.query.hours) || 72;
    const cutoff = new Date(Date.now() - hours * 3600e3);
    const samples = await coll.samples.find(
      { chainId, tokenAddress, t: { $gte: cutoff } },
      { projection: { t: 1, p: 1, lq: 1, v24: 1, mc: 1, pc24: 1, source: 1 } }
    ).sort({ t: 1 }).toArray();
    const tok = await coll.tokens.findOne(
      { chainId, tokenAddress },
      { projection: { baselineUsd: 1, highWaterUsd: 1, peakMultiple: 1, peakAt: 1, runner: 1, firstSampleAt: 1, lastSampleAt: 1 } }
    );
    res.json({ samples, token: tok || null });
  }));

  // ---- trade advisor (self-learning runner predictor) ----
  app.get('/api/tokens/batch', ah(async (req, res) => {
    const keysParam = req.query.keys || '';
    const keys = keysParam.split(',').map(k => k.trim()).filter(k => k.includes(':'));
    const orQueries = keys.map(k => {
      const [chainId, tokenAddress] = k.split(':');
      return { chainId: chainId.toLowerCase(), tokenAddress: tokenAddress.toLowerCase() };
    });
    if (!orQueries.length) return res.json({ tokens: [] });
    const tokens = await coll.tokens.find({ $or: orQueries })
      .project({
        chainId: 1, tokenAddress: 1, runner: 1, peakMultiple: 1,
        baselineUsd: 1, highWaterUsd: 1, lastPriceUsd: 1,
        firstSampleAt: 1, lastSampleAt: 1, becameRunnerAt: 1, timeToPeakMin: 1,
        peakAt: 1, last24hChange: 1, volume24h: 1
      }).toArray();
    res.json({ tokens });
  }));

  app.get('/api/trade-advisor', ah(async (req, res) => {
    const { getAdvisorDashboard } = await import('../services/tradeAdvisor.js');
    const opts = {};
    if (req.query.minScore) opts.minScore = Number(req.query.minScore);
    if (req.query.topN) opts.topN = Number(req.query.limit) || Number(req.query.topN);
    if (req.query.deadlineMin) opts.deadlineMin = Number(req.query.deadlineMin);
    const result = await getAdvisorDashboard(opts);
    res.json(result);
  }));

  app.get('/api/trade-advisor/signals', ah(async (req, res) => {
    const { getBotSignals } = await import('../services/tradeAdvisor.js');
    const signals = await getBotSignals();
    res.json(signals);
  }));

  app.post('/api/trade-advisor/record', ah(async (req, res) => {
    const { chainId, tokenAddress, outcome, peakMultiple } = req.body || {};
    if (!chainId || !tokenAddress || !outcome) {
      return res.status(400).json({ error: 'chainId, tokenAddress, outcome required' });
    }
    const { recordOutcome } = await import('../services/tradeAdvisor.js');
    const state = await recordOutcome(chainId, tokenAddress, outcome, peakMultiple);
    res.json({ ok: true, missRatio: state.missRatio, adjustmentCount: state.adjustmentCount });
  }));

  app.post('/api/trade-advisor/resolve', ah(async (_req, res) => {
    const { resolvePendingRecommendations } = await import('../services/tradeAdvisor.js');
    const result = await resolvePendingRecommendations();
    res.json(result);
  }));

  app.post('/api/trade-advisor/reset', ah(async (_req, res) => {
    const { resetAdvisorState } = await import('../services/tradeAdvisor.js');
    await resetAdvisorState();
    res.json({ ok: true, message: 'Advisor state reset to defaults' });
  }));

  app.post('/api/trade-advisor/paper-check', ah(async (req, res) => {
    const { periodicPaperTradeCheck } = await import('../services/tradeAdvisor.js');
    const opts = { force: req.body?.force || false };
    const result = await periodicPaperTradeCheck(opts);
    res.json(result);
  }));

  app.get('/api/trade-advisor/paper-summary', ah(async (_req, res) => {
    const { getPaperTradeSummary } = await import('../services/tradeAdvisor.js');
    const summary = await getPaperTradeSummary();
    res.json(summary);
  }));

  // ---- Dynamic Runner Predictor endpoints ----
  app.get('/api/predictions/live', ah(async (req, res) => {
    const { getLiveRankings, getAllRankings, getBroadcastPayload } = predictor;
    const limit = Number(req.query.limit) || 50;
    const includeRunners = req.query.includeRunners === 'true';
    const rankings = includeRunners ? getAllRankings(limit) : getLiveRankings(limit);
    res.json({ rankings, stats: getBroadcastPayload().stats });
  }));

  app.get('/api/predictions/stats', ah(async (_req, res) => {
    const { getBroadcastPayload } = predictor;
    res.json(getBroadcastPayload().stats);
  }));

  app.post('/api/predictions/record', ah(async (req, res) => {
    const { recordPrediction } = predictor;
    const { tokenId, predictedProb, becameRunner, peakMult } = req.body || {};
    if (!tokenId) return res.status(400).json({ error: 'tokenId required' });
    recordPrediction(tokenId, predictedProb, becameRunner, peakMult);
    res.json({ ok: true });
  }));

  app.get('/api/predictions/monitoring', ah(async (req, res) => {
    const limit = Number(req.query.limit) || 50;
    const monitored = await coll.monitoring.find({})
      .sort({ probability: -1 })
      .limit(limit)
      .toArray();

    // Batch enrich with token data for live peak/current tracking
    const keys = monitored.map((m) => ({ chainId: m.chainId, tokenAddress: m.tokenAddress }));
    const toks = keys.length
      ? await coll.tokens.find({ $or: keys })
        .project({
          chainId: 1, tokenAddress: 1, runner: 1, peakMultiple: 1,
          baselineUsd: 1, highWaterUsd: 1, lastPriceUsd: 1, lastSampleAt: 1,
          firstSampleAt: 1, peakAt: 1,
        })
        .toArray()
      : [];
    const tokMap = new Map(toks.map((t) => [`${t.chainId}:${t.tokenAddress}`, t]));

    const items = monitored.map((m) => {
      const tok = tokMap.get(`${m.chainId}:${m.tokenAddress}`) || {};
      const baseline = tok.baselineUsd || m.baselineUsd || 0;
      const currentMult = baseline > 0 && tok.lastPriceUsd ? tok.lastPriceUsd / baseline : (m.current_multiple || 0);
      const peakMult = tok.peakMultiple || m.peak_multiple || currentMult;
      const isRunner = tok.runner === true;
      let status = m.status || 'monitoring';
      if (isRunner && status === 'monitoring') status = 'runner';

      // Compute monitoring duration and peak delta
      const now = Date.now();
      const enteredAt = m.enteredAt ? new Date(m.enteredAt).getTime() : null;
      const durationMin = enteredAt ? Math.round((now - enteredAt) / 60e3) : 0;
      const multAtEntry = m.multAtEntry || currentMult;
      const peakDelta = peakMult - currentMult;

      return {
        ...m,
        current_multiple: currentMult,
        peak_multiple: peakMult,
        baselineUsd: baseline,
        peakUsd: tok.highWaterUsd,
        lastPriceUsd: tok.lastPriceUsd,
        status: status,
        is_runner: isRunner,
        durationMin,
        multAtEntry: multAtEntry,
        peakDelta: peakDelta,
        lastSampleAt: tok.lastSampleAt,
      };
    });

    // Only include momentum entry signals: tokens that crossed 1.3x threshold
    // or are actively being tracked as momentum entries
    const threshold = 1.3;
    const filtered = items.filter((item) => {
      const currentMult = item.current_multiple || 0;
      const entryMult = item.multAtEntry || 0;
      // Include if currently above threshold, or entered above threshold, or is runner
      return currentMult >= threshold || entryMult >= threshold || item.is_runner || item.status === 'momentum_entry';
    });

    res.json({ items: filtered });
  }));

  app.use((err, _req, res, _next) => {
    log.error('[api]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  });

  const server = app.listen(config.port, () => log.info(`[api] listening on :${config.port}`));

  // ---- WebSocket: live prediction stream ----
  const wss = new WebSocketServer({ noServer: true });
  let wsClients = new Set();
  const { getBroadcastPayload } = predictor;

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    log.info('[ws] client connected, total:', wsClients.size);

    // Send initial payload immediately
    ws.send(JSON.stringify(getBroadcastPayload()));

    ws.on('close', () => {
      wsClients.delete(ws);
      log.info('[ws] client disconnected, total:', wsClients.size);
    });
  });

  // Broadcast to all connected clients on each scoring cycle
  let wsBroadcastTimer = null;
  const startWsBroadcast = async () => {
    const { startPredictionLoop, checkAndCopyTopTokens } = predictor;

    // Start the 30-second prediction loop
    const loop = startPredictionLoop();

    // Broadcast every 30 seconds (aligned with scoring cycle)
    wsBroadcastTimer = setInterval(() => {
      const payload = getBroadcastPayload();
      const msg = JSON.stringify(payload);
      for (const ws of wsClients) {
        if (ws.readyState === ws.OPEN) {
          ws.send(msg);
        }
      }
    }, 30_000);

    // Also check+copy top tokens every cycle
    setInterval(() => {
      checkAndCopyTopTokens().catch((e) => log.warn('[predictor] copy check failed:', e.message));
    }, 30_000);

    log.info('[ws] prediction loop + broadcast started');
    return loop;
  };

  startWsBroadcast().catch((e) => log.error('[predictor] startup failed:', e.message));

  // Upgrade HTTP server to handle WebSocket
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/api/predictions/stream') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });
}