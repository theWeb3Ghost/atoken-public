// Self-adjusting ML monitor for bucket performance tracking
import { coll } from '../db.js';
import { log } from '../lib/logger.js';
import { computeBucketPerformance, findBestBucket, getCandidatesInBucket } from './bucketModel.js';
import { computeDeadZoneStats } from './deadzone.js';
import { loadModel, bucketOf } from './score.js';

const ADJUSTMENT_INTERVAL_H = 6; // align with maintenance cycle

/**
 * Run one cycle of bucket monitoring:
 * 1. Recompute bucket performance from fresh data
 * 2. Identify the best-performing bucket (>= 1/3 runner rate)
 * 3. Store the active bucket + adjustment count in config collection
 * 4. Update adjusted scores on candidates
 *
 * @returns {Promise<{adjustedCount:number, activeBucket:string|null, bestBucket:object|null, deadzone:object}>}
 */
export async function bucketMonitorCycle() {
  // 1. compute bucket performance
  const perf = await computeBucketPerformance(5); // lower min for active bucket
  const best = await findBestBucket(5);
  const deadzone = await computeDeadZoneStats();

  // 2. determine active bucket (best bucket that meets threshold, or best available)
  let activeBucket = best.bestBucket;
  if (!best.meetsThreshold) {
    // no bucket meets the threshold — use the best available and note it
    activeBucket = best.bestBucket;
  }

  // 3. fetch existing config state to increment adjustment counter
  const cfg = await coll.config.findOne({ _id: 'bucket_monitor' });
  const adjustmentCount = (cfg?.adjustmentCount ?? 0) + 1;

  // 4. store the updated state
  await coll.config.updateOne(
    { _id: 'bucket_monitor' },
    {
      $set: {
        activeBucket: activeBucket,
        thresholdMet: best.meetsThreshold,
        runnerRate: best.runnerRate,
        runnerRatePct: best.runnerRatePct,
        adjustmentCount,
        lastRunAt: new Date(),
        buckets: perf.buckets,
        baseRate: perf.baseRate,
        deadzone: {
          total: deadzone.total,
          deadZone: deadzone.deadZone,
          pct: deadzone.pct,
        },
      },
    },
    { upsert: true }
  );

  log.info(`[bucketMonitor] cycle ${adjustmentCount}: activeBucket=${activeBucket || 'none'} rate=${best.runnerRatePct || 0}% thresholdMet=${best.meetsThreshold}`);

  // 5. re-score candidates with adjustments
  const m = loadModel(true);
  if (!m) {
    log.info('[bucketMonitor] no model available, skipping rescoring');
    return { adjustedCount: 0, activeBucket, bestBucket: best, deadzone };
  }

  // fetch all scored candidates and update adjusted scores
  const cands = await coll.candidates.find({
    score: { $exists: true },
    status: { $ne: 'ignored' },
  }).toArray();

  // Batch-fetch token docs to avoid N+1 query pattern
  const keys = cands.map((c) => ({ chainId: c.chainId, tokenAddress: c.tokenAddress }));
  const toks = keys.length
    ? await coll.tokens.find({ $or: keys })
      .project({ chainId: 1, tokenAddress: 1, runner: 1, peakMultiple: 1, firstSampleAt: 1, lastSampleAt: 1, lastPriceUsd: 1, baselineUsd: 1 })
      .toArray()
    : [];
  const tokMap = new Map(toks.map((t) => [`${t.chainId}:${t.tokenAddress}`, t]));

  let adjustedCount = 0;
  for (const c of cands) {
    const tok = tokMap.get(`${c.chainId}:${c.tokenAddress}`);

    const rawScore = c.score || 0;
    const rawBucket = c.scoreBucket || bucketOf(rawScore);

    // dead zone check
    const isDeadZone = tok && tok.runner === false && (tok.peakMultiple ?? 1) <= 1.05;
    let deadzoneConfidence = 0;
    if (isDeadZone && tok && tok.lastPriceUsd != null && tok.baselineUsd != null) {
      // confidence based on time tracked and price flatness
      if (tok.firstSampleAt && tok.lastSampleAt) {
        const trackedH = (new Date(tok.lastSampleAt).getTime() - new Date(tok.firstSampleAt).getTime()) / 3600e3;
        deadzoneConfidence = Math.min(1, trackedH / 12);
      }
    }

    // adjusted score: dead zone override
    let adjustedScore = rawScore;
    if (isDeadZone && deadzoneConfidence > 0.3) {
      adjustedScore = Math.min(rawScore, rawScore * (1 - deadzoneConfidence * 0.8));
    }

    const update = {
      adjustedScore: +adjustedScore.toFixed(4),
      adjustedBucket: bucketOf(adjustedScore),
      inDeadZone: isDeadZone && deadzoneConfidence > 0.3,
      deadzoneConfidence: +deadzoneConfidence.toFixed(3),
    };

    // if active bucket matches this token's bucket, mark as "monitored"
    if (activeBucket && rawBucket === activeBucket) {
      update.monitored = true;
      update.monitoringBucket = activeBucket;
    } else {
      update.monitored = false;
    }

    await coll.candidates.updateOne(
      { _id: c._id },
      { $set: update }
    );
    adjustedCount++;
  }

  log.info(`[bucketMonitor] adjusted ${adjustedCount} candidate scores`);

  return { adjustedCount, activeBucket, bestBucket: best, deadzone };
}

/**
 * Get the current monitoring state from config.
 *
 * @returns {Promise<{activeBucket:string|null, adjustmentCount:number, thresholdMet:boolean, runnerRatePct:number|null, lastRunAt:Date|null, buckets:Array, baseRate:number, deadzone:object|null}>}
 */
export async function getBucketMonitorState() {
  const cfg = await coll.config.findOne({ _id: 'bucket_monitor' });
  if (!cfg) {
    return { activeBucket: null, adjustmentCount: 0, thresholdMet: false, runnerRatePct: null, lastRunAt: null, buckets: [], baseRate: 0, deadzone: null };
  }
  return { ...cfg };
}

/**
 * Get candidates currently in the monitored bucket.
 *
 * @param {number} [limit=100]
 * @returns {Promise<{bucket:string|null, items:Array, runnerRate:number}>}
 */
export async function getMonitoredCandidates(limit = 100) {
  const state = await getBucketMonitorState();
  if (!state.activeBucket) {
    return { bucket: null, items: [], runnerRate: 0 };
  }
  return getCandidatesInBucket(state.activeBucket, limit);
}
