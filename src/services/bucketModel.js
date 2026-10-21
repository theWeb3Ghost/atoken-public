// Bucket-based runner prediction model with dead-zone awareness
import { coll } from '../db.js';
import { loadModel, bucketOf } from './score.js';
import { computeDeadZoneStats, getDeadZoneTokensForScatter } from './deadzone.js';

// runner rate threshold for "high probability" bucket
export const DEFAULT_THRESHOLD = 1 / 3; // user wants at least 1/3 runner rate

// Configurable via environment or query param
export const THRESHOLD_PRESETS = {
  '1/2': 0.5,
  '1/3': 1 / 3,   // ~0.333
  '1/4': 0.25,
  '1/5': 0.2,
  '1/10': 0.1,
};

/**
 * Compute bucket performance: for each score bucket, calculate the actual
 * runner rate from MongoDB data. This combines the model's raw probability
 * buckets with ground-truth runner status to find buckets where runners
 * concentrate.
 *
 * @param {number} [minSamples=10] - minimum tokens per bucket to consider
 * @returns {Promise<{buckets:Array, baseRate:number, highBuckets:Array, totalScored:number, totalRunners:number}>}
 */
export async function computeBucketPerformance(minSamples = 10, threshold = DEFAULT_THRESHOLD) {
  // fetch scored candidates with their token runner status (limited to recent for performance)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600e3);
  const cands = await coll.candidates.find({
    score: { $exists: true },
    status: { $ne: 'ignored' },
    createdAt: { $gte: sevenDaysAgo },
  }, {
    projection: { chainId: 1, tokenAddress: 1, score: 1, scoreBucket: 1, createdAt: 1 },
  }).toArray();

  if (!cands.length) {
    return { buckets: [], baseRate: 0, highBuckets: [], totalScored: 0, totalRunners: 0, threshold };
  }

  // batch-fetch token docs to check runner status
  const keys = cands.map((c) => ({ chainId: c.chainId, tokenAddress: c.tokenAddress }));
  const toks = keys.length
    ? await coll.tokens.find({ $or: keys })
      .project({ chainId: 1, tokenAddress: 1, runner: 1, peakMultiple: 1 })
      .toArray()
    : [];

  const tokMap = new Map(toks.map((t) => [`${t.chainId}:${t.tokenAddress}`, t]));

  // group by bucket
  const buckets = {};
  let totalRunners = 0;

  for (const c of cands) {
    const tok = tokMap.get(`${c.chainId}:${c.tokenAddress}`);
    const isRunner = tok?.runner === true;
    if (isRunner) totalRunners++;

    const bucket = c.scoreBucket || bucketOf(c.score || 0);
    if (!buckets[bucket]) buckets[bucket] = { bucket, n: 0, runners: 0 };
    buckets[bucket].n++;
    if (isRunner) buckets[bucket].runners++;
  }

  const bucketList = Object.values(buckets).map((b) => ({
    bucket: b.bucket,
    n: b.n,
    runners: b.runners,
    runnerRate: b.n > 0 ? b.runners / b.n : 0,
    runnerRatePct: b.n > 0 ? Math.round((b.runners / b.n) * 100) : 0,
    meetsThreshold: b.n >= minSamples && (b.runners / b.n) >= threshold,
  })).sort((a, b) => a.bucket.localeCompare(b.bucket));

  const baseRate = cands.length ? totalRunners / cands.length : 0;

  // high buckets: where runner rate >= threshold AND enough samples
  const highBuckets = bucketList.filter((b) => b.meetsThreshold);

  return {
    buckets: bucketList,
    baseRate: Math.round(baseRate * 10000) / 10000,
    highBuckets,
    totalScored: cands.length,
    totalRunners,
    threshold,
  };
}

/**
 * Find the single best-performing bucket (highest runner rate among those
 * with enough samples). This is the "active bucket" for monitoring.
 *
 * @param {number} [minSamples=10]
 * @param {number} [threshold=1/3]
 * @returns {Promise<{bestBucket:string|null, runnerRate:number, n:number, meetsThreshold:boolean}>}
 */
export async function findBestBucket(minSamples = 10, threshold = DEFAULT_THRESHOLD) {
  const perf = await computeBucketPerformance(minSamples, threshold);

  // find the bucket with highest runner rate that meets the threshold
  const sorted = [...perf.buckets]
    .filter((b) => b.n >= minSamples)
    .sort((a, b) => b.runnerRate - a.runnerRate);

  if (!sorted.length) {
    return { bestBucket: null, runnerRate: 0, n: 0, meetsThreshold: false };
  }

  const best = sorted[0];
  return {
    bestBucket: best.bucket,
    runnerRate: best.runnerRate,
    runnerRatePct: best.runnerRatePct,
    n: best.n,
    meetsThreshold: best.runnerRate >= threshold,
  };
}

/**
 * Find the best default bucket when active bucket is not set.
 * Prefers 40-60 (the lowest of the 40-100 range) for broader coverage.
 * @returns {Promise<string>}
 */
async function findDefaultBucket() {
  try {
    const { getBucketMonitorState } = await import('./bucketMonitor.js');
    const state = await getBucketMonitorState();
    if (state?.activeBucket) return state.activeBucket;
  } catch (e) {
    // ignore
  }
  return '40-60';
}

/**
 * Enhanced scoring that combines the ML model with dead-zone awareness
 * and bucket-level adjustments.
 *
 * @param {object} features - feature vector from extractFeatures()
 * @param {object|null} [tok] - token document (for dead-zone check)
 * @param {Array|null} [samples] - optional sample points for dead-zone verification
 * @returns {{rawScore:number, bucket:string, adjustedScore:number|null, adjustedBucket:string|null, inDeadZone:boolean, deadzoneConfidence:number, runnerProb:number}}
 */
export function scoreWithAdjustment(features, tok, samples) {
  const m = loadModel();
  const baseResult = {
    rawScore: null,
    bucket: null,
    adjustedScore: null,
    adjustedBucket: null,
    inDeadZone: false,
    deadzoneConfidence: 0,
    runnerProb: 0,
  };

  if (!m) {
    // no model — return defaults
    const score = features?.score ?? 0;
    return {
      ...baseResult,
      rawScore: score,
      bucket: bucketOf(score),
      runnerProb: 0,
    };
  }

  // compute raw model score (same as scoreFeatures)
  let z = m.bias;
  m.feature_names.forEach((f, i) => { z += m.weights[i] * (features?.[f] ?? 0); });
  let p = 1 / (1 + Math.exp(-z));

  // apply calibration
  const bin = m.calibration.find((c) => p >= c.lo && p < c.hi);
  if (bin && bin.observed != null) p = bin.observed;

  const rawScore = p;
  const rawBucket = bucketOf(rawScore);

  // check dead zone
  const isDeadZone = tok ? (tok.runner === false && (tok.peakMultiple ?? 1) <= 1.05) : false;
  let deadzoneConfidence = 0;

  if (isDeadZone && tok) {
    // confidence increases with time tracked
    if (tok.firstSampleAt && tok.lastSampleAt) {
      const trackedH = (new Date(tok.lastSampleAt).getTime() - new Date(tok.firstSampleAt).getTime()) / 3600e3;
      deadzoneConfidence = Math.min(1, trackedH / 12);
    } else if (tok.lastSampleAt) {
      const ageH = (Date.now() - new Date(tok.lastSampleAt).getTime()) / 3600e3;
      deadzoneConfidence = Math.min(1, ageH / 12);
    }
  }

  // adjusted score: dead zone override reduces score sharply
  let adjustedScore = rawScore;
  if (isDeadZone && deadzoneConfidence > 0.3) {
    adjustedScore = Math.min(rawScore, rawScore * (1 - deadzoneConfidence * 0.8));
  }

  // apply bucket-level adjustment (if bucket performance data is available)
  // this is computed at runtime via computeBucketPerformance, but we can
  // apply a smoothing toward observed rates
  // For now, keep adjusted = raw unless bucket is severely miscalibrated

  return {
    rawScore: +rawScore.toFixed(4),
    bucket: rawBucket,
    adjustedScore: +adjustedScore.toFixed(4),
    adjustedBucket: bucketOf(adjustedScore),
    inDeadZone: isDeadZone && deadzoneConfidence > 0.3,
    deadzoneConfidence: +deadzoneConfidence.toFixed(3),
    runnerProb: +rawScore.toFixed(4),
  };
}

/**
 * Predict which tokens in a bucket are most likely to peak BEFORE a deadline
 * (e.g. 200 minutes). Uses the `timeToPeakMin` field from the tokens collection
 * to learn the distribution of peak times for each score bucket.
 *
 * For each candidate in the bucket, computes a fast-peak probability:
 *   - If runner and timeToPeakMin known: fastPeakProb = 1 if < deadline else low
 *   - If runner and timeToPeakMin null (still climbing): estimate based on bucket average
 *   - If not runner: probability based on how recently created (young tokens still climbing)
 *
 * @param {string} [bucket] - score bucket to analyze (defaults to active bucket)
 * @param {number} [deadlineMin=200] - peak deadline in minutes
 * @param {number} [limit=50]
 * @returns {Promise<{bucket:string, deadlineMin:number, items:Array<{chainId:string,tokenAddress:string,score:number,scoreBucket:string,peakMultiple:number,timeToPeakMin:number|null,fastPeakProb:number,signals:Array,websiteUrl:string,createdAt:Date}>}>}
 */
export async function getFastPeakCandidates(bucket = null, deadlineMin = 200, limit = 50) {
  if (!bucket) {
    const { getBucketMonitorState } = await import('./bucketMonitor.js');
    const state = await getBucketMonitorState();
    bucket = state.activeBucket;
    if (!bucket) bucket = await findDefaultBucket(); // fallback to best available
  }

  // fetch candidates in the bucket
  const cands = await coll.candidates.find({
    scoreBucket: bucket,
    status: { $ne: 'ignored' },
  }, {
    projection: {
      chainId: 1, tokenAddress: 1, score: 1, scoreBucket: 1,
      matchedSignals: 1, websiteUrl: 1, createdAt: 1,
    },
  }).sort({ score: -1 }).limit(limit * 2).toArray(); // fetch extra to filter

  if (!cands.length) {
    return { bucket, deadlineMin, items: [] };
  }

  // join with tokens for peak data
  const keys = cands.map((c) => ({ chainId: c.chainId, tokenAddress: c.tokenAddress }));
  const toks = await coll.tokens.find({ $or: keys })
    .project({
      chainId: 1, tokenAddress: 1, runner: 1, peakMultiple: 1,
      timeToPeakMin: 1, baselineUsd: 1, highWaterUsd: 1, lastSampleAt: 1,
    }).toArray();
  const tokMap = new Map(toks.map((t) => [`${t.chainId}:${t.tokenAddress}`, t]));

  // compute average timeToPeakMin for runners in this bucket (for estimation)
  const peakTimes = toks
    .filter((t) => t.runner && t.timeToPeakMin != null && t.timeToPeakMin > 0)
    .map((t) => t.timeToPeakMin);
  const avgPeakTime = peakTimes.length ? peakTimes.reduce((a, b) => a + b, 0) / peakTimes.length : null;
  const fastPeakFrac = peakTimes.length
    ? peakTimes.filter((t) => t <= deadlineMin).length / peakTimes.length
    : 0;

  const items = [];
  for (const c of cands) {
    const t = tokMap.get(`${c.chainId}:${c.tokenAddress}`) || {};
    const isRunner = t.runner === true;
    const ttp = t.timeToPeakMin ?? null;
    const peakMult = t.peakMultiple ?? 1;
    const baseline = t.baselineUsd ?? 0;
    const peak = t.highWaterUsd ?? baseline;
    const lastSample = t.lastSampleAt ? new Date(t.lastSampleAt).getTime() : null;
    const createdAt = c.createdAt ? new Date(c.createdAt).getTime() : null;

    let fastPeakProb;

    if (isRunner && ttp != null) {
      // runner with known peak time
      fastPeakProb = ttp <= deadlineMin ? 1.0 : 0.1;
    } else if (isRunner && ttp == null) {
      // runner but still climbing — estimate using bucket average
      fastPeakProb = avgPeakTime
        ? Math.max(0.7, 1 - Math.abs(avgPeakTime - deadlineMin) / (deadlineMin * 2))
        : 0.5;
    } else if (!isRunner) {
      // not yet a runner — check how much it's moved
      const mult = baseline > 0 ? peak / baseline : 1;
      if (mult > 1.5) {
        // already moving 50%+ — likely to peak fast if it becomes runner
        fastPeakProb = fastPeakFrac;
      } else if (lastSample && createdAt) {
        // young token that's still flat — low prob but not dead
        const ageMin = (lastSample - createdAt) / 60e3;
        fastPeakProb = ageMin > 120 ? 0.05 : 0.3; // give young tokens benefit of doubt
      } else {
        fastPeakProb = 0.05;
      }
    } else {
      fastPeakProb = 0;
    }

    items.push({
      chainId: c.chainId,
      tokenAddress: c.tokenAddress,
      websiteUrl: c.websiteUrl,
      createdAt: c.createdAt,
      score: c.score,
      scoreBucket: c.scoreBucket,
      peakMultiple: +peakMult.toFixed(3),
      timeToPeakMin: ttp,
      baselineUsd: baseline,
      peakUsd: peak,
      signals: c.matchedSignals || [],
      fastPeakProb: +fastPeakProb.toFixed(3),
    });
  }

  // sort by fast-peak probability descending
  items.sort((a, b) => {
    if (b.fastPeakProb !== a.fastPeakProb) return b.fastPeakProb - a.fastPeakProb;
    return b.score - a.score;
  });

  return {
    bucket,
    deadlineMin,
    avgPeakTime: avgPeakTime ? +avgPeakTime.toFixed(1) : null,
    fastPeakFrac: +fastPeakFrac.toFixed(3),
    items: items.slice(0, limit),
  };
}

/**
 * Get all candidates in a specific bucket, enriched with token data.
 * Used for the monitored bucket tracker on the dashboard.
 *
 * @param {string|null} [bucket] - if null, uses the best bucket from findBestBucket()
 * @param {number} [limit=100]
 * @returns {Promise<{bucket:string, items:Array, runnerRate:number}>}
 */
export async function getCandidatesInBucket(bucket = null, limit = 100) {
  if (!bucket) {
    const best = await findBestBucket(5); // lower min for active bucket
    bucket = best.bestBucket;
    if (!bucket) {
      return { bucket: null, items: [], runnerRate: 0 };
    }
  }

  const cands = await coll.candidates.find({
    scoreBucket: bucket,
    status: { $ne: 'ignored' },
  }, {
    projection: {
      chainId: 1, tokenAddress: 1, score: 1, scoreBucket: 1,
      adjustedScore: 1, adjustedBucket: 1, inDeadZone: 1, deadzoneConfidence: 1,
      matchedSignals: 1, websiteUrl: 1, createdAt: 1, features: 1,
    },
  }).sort({ adjustedScore: -1, score: -1 }).limit(limit).toArray();

  const keys = cands.map((c) => ({ chainId: c.chainId, tokenAddress: c.tokenAddress }));
  const toks = keys.length
    ? await coll.tokens.find({ $or: keys })
      .project({
        chainId: 1, tokenAddress: 1, runner: 1, peakMultiple: 1,
        baselineUsd: 1, highWaterUsd: 1, becameRunnerAt: 1,
        timeToPeakMin: 1, lastPriceUsd: 1, lastSampleAt: 1,
      })
      .toArray()
    : [];

  const tokMap = new Map(toks.map((t) => [`${t.chainId}:${t.tokenAddress}`, t]));

  let runners = 0;
  const items = cands.map((c) => {
    const t = tokMap.get(`${c.chainId}:${c.tokenAddress}`) || {};
    const isRunner = t.runner === true;
    if (isRunner) runners++;
    return {
      chainId: c.chainId,
      tokenAddress: c.tokenAddress,
      websiteUrl: c.websiteUrl,
      createdAt: c.createdAt,
      score: c.score,
      scoreBucket: c.scoreBucket,
      adjustedScore: c.adjustedScore ?? null,
      adjustedBucket: c.adjustedBucket ?? null,
      inDeadZone: c.inDeadZone ?? false,
      deadzoneConfidence: c.deadzoneConfidence ?? 0,
      probability: c.adjustedScore ?? c.score ?? null,
      signals: c.matchedSignals || [],
      runner: isRunner,
      peakMultiple: t.peakMultiple ?? null,
      timeToPeakMin: t.timeToPeakMin ?? null,
      baselineUsd: t.baselineUsd ?? null,
      peakUsd: t.highWaterUsd ?? null,
      becameRunnerAt: t.becameRunnerAt ?? null,
      lastPriceUsd: t.lastPriceUsd ?? null,
      lastSampleAt: t.lastSampleAt ?? null,
    };
  });

  return {
    bucket,
    items,
    runnerRate: items.length ? runners / items.length : 0,
    runnerRatePct: items.length ? Math.round((runners / items.length) * 100) : 0,
    total: items.length,
  };
}
