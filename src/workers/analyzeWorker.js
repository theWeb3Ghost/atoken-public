import { Worker, QueueEvents } from 'bullmq';
import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { coll } from '../db.js';
import { log } from '../lib/logger.js';
import { metrics } from '../lib/metrics.js';
import { createConnection } from '../queues.js';
import { runLlmAnalysis } from '../services/llm.js';
import { enqueueNotification } from '../services/notifier/index.js';
import { analysisMessage } from '../services/notifier/format.js';

export function startAnalyzeWorker() {
  const worker = new Worker('analyze', async (job) => {
    const { analysisId } = job.data;
    metrics.inc('analysesStarted');
    const _id = new ObjectId(analysisId);
    await coll.analyses.updateOne({ _id }, { $set: { status: 'running', startedAt: new Date() } });

    const analysis = await coll.analyses.findOne({ _id });
    if (!analysis) throw new Error(`analysis ${analysisId} missing`);
    const cand = await coll.candidates.findOne({ chainId: analysis.chainId, tokenAddress: analysis.tokenAddress });
    if (!cand) throw new Error('candidate missing');

    let result;
    try {
      result = await runLlmAnalysis(cand);
    } catch (err) {
      await coll.analyses.updateOne(
        { _id },
        { $set: { status: 'failed', error: String(err.message).slice(0, 1000), finishedAt: new Date() } }
      );
      await coll.candidates.updateOne({ _id: cand._id }, { $set: { analysisStatus: 'failed' } });
      metrics.inc('analysesFailed');
      throw err; // retried per queue defaults; remains manually re-runnable after
    }

    await coll.analyses.updateOne(
      { _id },
      { $set: { status: 'done', result, model: config.llm.model, finishedAt: new Date() } }
    );
    await coll.candidates.updateOne({ _id: cand._id }, { $set: { analysisStatus: 'done' } });
    metrics.inc('analysesCompleted');

    // Notification disabled — only momentum entry & runner alerts are sent
    // await enqueueNotification({
    //   dedupeKey: `analysis__${analysisId}`,
    //   kind: 'analysis',
    //   text: analysisMessage({ ...analysis, result }, cand),
    //   keyboard: [[{ text: '🌐 Website', url: cand.websiteUrl }]],
    //   replyTo: cand.notifyMeta?.messageId || null,
    // });
    return { done: true };
  }, { connection: createConnection(), concurrency: config.analysis.concurrency });

  const events = new QueueEvents('analyze', { connection: createConnection() });
  events.on('failed', ({ jobId, failedReason }) => log.warn(`[analyze] job ${jobId} failed: ${failedReason}`));
  worker.on('error', (err) => log.error('[analyze worker]', err.message));
  log.info(`[analyze worker] started (concurrency=${config.analysis.concurrency})`);
  return { worker, events };
}