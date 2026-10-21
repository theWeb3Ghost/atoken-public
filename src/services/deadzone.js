import { coll } from '../db.js';

/**
 * Determine whether a token qualifies as a "dead zone" token — its price
 * never exceeded baseline × 1.01 (tolerance) across the observed samples.
 *
 * Two strategies are used:
 *  1. If the token document carries `peakMultiple === 1.0` (no appreciation
 *     recorded), the token is treated as dead-zone provided it has enough
 *     samples.
 *  2. Otherwise the samples array is inspected directly: max(p) must be
 *     <= baseline × 1.01 and the sample count must meet `minSamples`.
 *
 * @param {object|null} tok   - Token document from coll.tokens.
 * @param {Array<{t:*,p:number}>} samples - Price samples [{t, p}, ...].
 * @param {number} [minSamples=5] - Minimum sample count required to confirm.
 * @returns {boolean}
 */
export function isDeadZoneToken(tok, samples, minSamples = 5) {
  if (!tok) return false;
  const pts = Array.isArray(samples) ? samples : [];
  if (pts.length < minSamples) return false;

  // Token doc already flagged as no-appreciation (peakMultiple ≈ 1.0)
  if (tok.peakMultiple != null && Math.abs(tok.peakMultiple - 1.0) < 1e-9) return true;

  // Already confirmed as a runner / appreciator
  if (tok.peakMultiple != null && tok.peakMultiple > 1.01) return false;

  // Derive baseline from token doc, fall back to first sample price
  const baseline = tok.baselineUsd || pts[0]?.p || 0;
  if (baseline <= 0) return false;

  const maxPrice = pts.reduce((mx, s) => Math.max(mx, s.p || 0), 0);
  return maxPrice <= baseline * 1.01;
}

/**
 * Aggregate dead-zone statistics across the full token population.
 *
 * "Tracked" tokens are those that have been sampled (lastSampleAt exists),
 * are not runners, and have peakMultiple <= 1.01. A token is counted as a
 * confirmed dead-zone token when it also has >= minSamples samples.
 *
 * @param {number} [minSamples=5] - Minimum samples to confirm a dead-zone token.
 * @returns {Promise<{total:number, deadZone:number, pct:number, byChain:object, byAge:{fresh:number,warming:number,confirmed:number}}>}
 */
export async function computeDeadZoneStats(minSamples = 5) {
  const now = Date.now();

  // Tracked dead-zone candidates: sampled, not a runner, no meaningful appreciation
  const tokens = await coll.tokens.find({
    lastSampleAt: { $exists: true },
    runner: { $ne: true },
    peakMultiple: { $lte: 1.01 },
  }).project({
    chainId: 1, tokenAddress: 1, peakMultiple: 1, baselineUsd: 1,
    firstSampleAt: 1, lastSampleAt: 1,
  }).toArray();

  const total = tokens.length;
  if (total === 0) {
    return { total: 0, deadZone: 0, pct: 0, byChain: {}, byAge: { fresh: 0, warming: 0, confirmed: 0 } };
  }

  // Count samples per token via aggregation
  const keys = tokens.map((t) => ({ chainId: t.chainId, tokenAddress: t.tokenAddress }));
  const sampleAgg = keys.length
    ? await coll.samples.aggregate([
        { $match: { $or: keys } },
        { $group: { _id: { chainId: '$chainId', tokenAddress: '$tokenAddress' }, count: { $sum: 1 } } },
      ]).toArray()
    : [];
  const sampleCountMap = new Map(
    sampleAgg.map((s) => [`${s._id.chainId}:${s._id.tokenAddress}`, s.count])
  );

  const byChain = {};
  const byAge = { fresh: 0, warming: 0, confirmed: 0 };
  let deadZone = 0;

  for (const tok of tokens) {
    const key = `${tok.chainId}:${tok.tokenAddress}`;
    const nSamples = sampleCountMap.get(key) || 0;
    const isDead = nSamples >= minSamples;

    byChain[tok.chainId] ??= { total: 0, deadZone: 0 };
    byChain[tok.chainId].total++;

    if (isDead) {
      deadZone++;
      byChain[tok.chainId].deadZone++;

      // Age buckets based on time since first sample
      const ageSrc = tok.firstSampleAt || tok.lastSampleAt;
      const ageHrs = ageSrc ? (now - new Date(ageSrc).getTime()) / 3600e3 : 0;
      if (ageHrs < 24) byAge.fresh++;
      else if (ageHrs < 72) byAge.warming++;
      else byAge.confirmed++;
    }
  }

  return {
    total,
    deadZone,
    pct: total ? Math.round((deadZone / total) * 100) : 0,
    byChain,
    byAge,
  };
}

/**
 * Fetch dead-zone tokens enriched with candidate features and outcome data
 * for scatter plotting.
 *
 * Tokens are considered dead-zone when they are tracked (have been sampled),
 * are not runners, and have peakMultiple <= 1.01.
 *
 * Each returned object contains:
 *  - chainId, tokenAddress: composite key
 *  - timeToPeakMin: null (dead-zone tokens never peaked)
 *  - peakMultiple: 1.0
 *  - score / scoreBucket: ML scoring from candidate doc
 *  - features: full feature vector
 *  - signals: matched signal names
 *  - createdAt: candidate creation timestamp
 *
 * @returns {Promise<Array<object>>}
 */
export async function getDeadZoneTokensForScatter() {
  // Fetch candidates (feature / score source)
  const cands = await coll.candidates.find({ status: { $ne: 'ignored' } })
    .project({
      chainId: 1, tokenAddress: 1, features: 1, score: 1, scoreBucket: 1,
      matchedSignals: 1, createdAt: 1,
    }).toArray();

  if (!cands.length) return [];

  const keys = cands.map((c) => ({ chainId: c.chainId, tokenAddress: c.tokenAddress }));

  // Join with tokens filtered to dead-zone criteria
  const toks = await coll.tokens.find({
    $or: keys,
    runner: { $ne: true },
    peakMultiple: { $lte: 1.01 },
    lastSampleAt: { $exists: true },
  }).project({
    chainId: 1, tokenAddress: 1,
  }).toArray();

  const tokMap = new Map(toks.map((t) => [`${t.chainId}:${t.tokenAddress}`, t]));

  return cands
    .filter((c) => tokMap.has(`${c.chainId}:${c.tokenAddress}`))
    .map((c) => ({
      chainId: c.chainId,
      tokenAddress: c.tokenAddress,
      // Dead-zone tokens never peaked, so time-to-peak is not applicable
      timeToPeakMin: null,
      peakMultiple: 1.0,
      score: c.score ?? null,
      scoreBucket: c.scoreBucket ?? null,
      features: c.features || {},
      signals: c.matchedSignals || [],
      createdAt: c.createdAt || null,
    }));
}

/**
 * Fetch runner tokens (runner: true) with full feature/score data for scatter
 * plotting. Each row is enriched with peakMultiple, timeToPeakMin, score,
 * scoreBucket, signals, and website URL — matching what the dashboard's
 * scatter renderer expects.
 *
 * @param {number} [limit=500] - Cap on number of runner rows returned.
 * @returns {Promise<Array<object>>}
 */
export async function getRunnerScatterRows(limit = 500) {
  // Fetch candidates with their features and score
  const cands = await coll.candidates.find({
    status: { $ne: 'ignored' },
  }, {
    projection: {
      chainId: 1, tokenAddress: 1, score: 1, scoreBucket: 1,
      matchedSignals: 1, websiteUrl: 1, createdAt: 1, features: 1,
    },
  }).sort({ score: -1, createdAt: -1 }).limit(limit).toArray();

  if (!cands.length) return [];

  // Batch-fetch token documents for peak/runner data
  const keys = cands.map((c) => ({ chainId: c.chainId, tokenAddress: c.tokenAddress }));
  const toks = await coll.tokens.find({ $or: keys })
    .project({
      chainId: 1, tokenAddress: 1, runner: 1, peakMultiple: 1,
      timeToPeakMin: 1, baselineUsd: 1, highWaterUsd: 1,
      lastPriceUsd: 1, lastSampleAt: 1,
    })
    .toArray();

  const tokMap = new Map(toks.map((t) => [`${t.chainId}:${t.tokenAddress}`, t]));

  // Only return tokens that are confirmed runners for the scatter plot
  return cands
    .filter((c) => {
      const tok = tokMap.get(`${c.chainId}:${c.tokenAddress}`);
      return tok && tok.runner === true;
    })
    .map((c) => {
      const tok = tokMap.get(`${c.chainId}:${c.tokenAddress}`) || {};
      return {
        chainId: c.chainId,
        tokenAddress: c.tokenAddress,
        websiteUrl: c.websiteUrl || null,
        createdAt: c.createdAt || null,
        features: c.features || {},
        score: c.score ?? null,
        scoreBucket: c.scoreBucket ?? null,
        signals: c.matchedSignals || [],
        // Token-level outcome data for scatter positioning
        runner: true,
        peakMultiple: tok.peakMultiple ?? null,
        timeToPeakMin: tok.timeToPeakMin ?? null,
        baselineUsd: tok.baselineUsd ?? null,
        peakUsd: tok.highWaterUsd ?? null,
        lastPriceUsd: tok.lastPriceUsd ?? null,
        lastSampleAt: tok.lastSampleAt ?? null,
      };
  });
}

/**
 * Bucket dead-zone tokens into confidence tiers based on their observation window.
 *
 * Uses `n_points` (from dataset export or token outcome) when available to
 * determine how many samples have been collected. Falls back to age computed
 * from `createdAt` when n_points is absent.
 *
 * Tiers:
 *  - fresh:     < 24h age or < 10 samples  (low confidence — could still pump)
 *  - warming:   24h–72h age or 10–49 samples (medium confidence)
 *  - confirmed: > 72h age or >= 50 samples (high confidence — truly dead zone)
 *
 * @param {Array<object>} deadZoneTokens - Tokens from getDeadZoneTokensForScatter
 *   or dataset rows with optional `n_points` / `outcome.n_points` / `sampleCount`.
 * @returns {{fresh:number, warming:number, confirmed:number}}
 */
export function deadZoneTemporalPattern(deadZoneTokens) {
  const result = { fresh: 0, warming: 0, confirmed: 0 };
  const now = Date.now();

  for (const t of deadZoneTokens || []) {
    // Primary: sample-count based confidence (from dataset export or pre-counted)
    const nPoints = t?.n_points ?? t?.outcome?.n_points ?? t?.sampleCount ?? 0;
    const ageHrs = t?.createdAt
      ? (now - new Date(t.createdAt).getTime()) / 3600e3
      : 0;

    if (nPoints > 0) {
      if (nPoints < 10) result.fresh++;
      else if (nPoints < 50) result.warming++;
      else result.confirmed++;
    } else if (ageHrs > 0) {
      // Fallback: age based
      if (ageHrs < 24) result.fresh++;
      else if (ageHrs < 72) result.warming++;
      else result.confirmed++;
    } else {
      // No data available — assume fresh (lowest confidence)
      result.fresh++;
    }
  }

  return result;
}
