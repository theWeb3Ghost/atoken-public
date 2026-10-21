import { Worker } from 'bullmq';
import { config } from '../config.js';
import { coll } from '../db.js';
import { log } from '../lib/logger.js';
import { createConnection } from '../queues.js';
import { fetchLlmFeatures } from '../services/llmFeatures.js';
import { scoreFeatures } from '../services/score.js';

export function startLlmFeatWorker() {
  const worker = new Worker('llmfeat', async (job) => {
    if (!config.llmFeats.enabled || !config.llm.apiKey) return { skipped: true };
    const { chainId, tokenAddress } = job.data;
    const c = await coll.candidates.findOne({ chainId, tokenAddress });
    if (!c || c.features?.llm_done) return { skipped: true };
    const feats = await fetchLlmFeatures({ title: c.title, description: c.description, websiteText: c.websiteText });
    const set = {};
    for (const [k, v] of Object.entries(feats)) set[`features.${k}`] = v;
    const s = scoreFeatures({ ...c.features, ...feats });
    if (s) { set.score = s.p; set.scoreBucket = s.bucket; set.scoredAt = new Date(); }
    await coll.candidates.updateOne({ _id: c._id }, { $set: set });
    return feats;
  }, { connection: createConnection(), concurrency: 2, limiter: { max: 30, duration: 60000 } });
  worker.on('error', (e) => log.error('[llmfeat worker]', e.message));
  log.info('[llmfeat worker] started');
  return { worker, stop: async () => worker.close() };
}