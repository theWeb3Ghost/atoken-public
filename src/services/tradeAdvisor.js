// Self-learning trading advisor that digests dashboard data, finds
// most probable runners, learns from misses, and feeds signals to a bot.
import { coll } from '../db.js';
import { log } from '../lib/logger.js';
import { loadModel, bucketOf, scoreFeatures } from './score.js';
import { computeBucketPerformance, getFastPeakCandidates } from './bucketModel.js';
import { getRunnerScatterRows, getDeadZoneTokensForScatter } from './deadzone.js';
import { adjustPatternWeights } from './runnerPredictor.js';

/**
 * Trading Advisor — Self-Learning Runner Predictor
 *
 * Core loop:
 *   1. Digest current data from main dashboard + dash endpoints
 *   2. Score all unmonitored candidates using ML model + dead-zone awareness
 *   3. Apply fast-peak prediction (tokens that peak before deadlineMin)
 *   4. Select top N candidates with highest combined probability
 *   5. Track outcomes — when a candidate peaks (runner or dead zone), record it
 *   6. Update miss-rate model: misses / gains ratio drives threshold adjustment
 *
 * Miss rate formula:
 *   missRate = missedOpportunities / capturedRunners
 *   If missRate > target (e.g. 2.0 = 1 missed per capture), the model
 *   lowers the score threshold to be more aggressive.
 *   If missRate < target, the model tightens (higher threshold).
 */

const ADVISOR_CONFIG_DEFAULTS = {
  // minimum score to consider for trading (adjusted dynamically)
  minScore: 0.4,
  // deadline for "fast peak" in minutes
  deadlineMin: 200,
  // number of candidates to recommend per cycle
  topN: 20,
  // target miss-to-gain ratio (missed/gained). Lower = more aggressive
  targetMissRatio: 1.0,
  // how many past recommendations to keep for learning
  historyLimit: 1000,
  // minimum samples for a bucket to be considered "proven"
  minBucketSamples: 5,
};

/**
 * Get current advisor state from config collection, creating defaults if absent.
 */
async function getAdvisorState() {
  const cfg = await coll.config.findOne({ _id: 'trade_advisor' });
  if (!cfg) {
    // Return defaults WITHOUT writing to DB — let writers persist
    return {
      ...ADVISOR_CONFIG_DEFAULTS,
      adjustmentCount: 0,
      lastRunAt: null,
      gainCount: 0,
      falsePositiveCount: 0,
      missedCount: 0,
      missRatio: 0,
      lastMissAdjustment: null,
      recommendationHistory: [],
      activeRecommendations: [],
      lastPaperTradeCheck: null,
      resolvedTokens: [],
      countedMissedRunners: [],
    };
  }

  // merge defaults for any missing fields, normalize legacy fields
  return {
    ...ADVISOR_CONFIG_DEFAULTS,
    missCount: 0,
    falsePositiveCount: 0,
    missedCount: 0,
    gainCount: 0,
    missRatio: 0,
    adjustmentCount: 0,
    lastMissAdjustment: null,
    recommendationHistory: [],
    activeRecommendations: [],
    lastPaperTradeCheck: null,
    resolvedTokens: [],
    countedMissedRunners: [],
    ...cfg, // overwrite with actual DB values
    // Migrate legacy missCount to falsePositiveCount
    falsePositiveCount: cfg.falsePositiveCount ?? (cfg.missCount || 0),
  };
}

/**
 * Save advisor state to config collection.
 */
async function saveAdvisorState(state) {
  await coll.config.updateOne(
    { _id: 'trade_advisor' },
    { $set: state },
    { upsert: true }
  );
}

/**
 * Reset advisor state to defaults — clears all learning metrics.
 */
export async function resetAdvisorState() {
  const fresh = {
    ...ADVISOR_CONFIG_DEFAULTS,
    gainCount: 0,
    falsePositiveCount: 0,
    missedCount: 0,
    missRatio: 0,
    adjustmentCount: 0,
    lastMissAdjustment: null,
    recommendationHistory: [],
    activeRecommendations: [],
    lastPaperTradeCheck: null,
    resolvedTokens: [],
    countedMissedRunners: [],
  };
  await coll.config.deleteOne({ _id: 'trade_advisor' });
  await coll.config.insertOne({ _id: 'trade_advisor', ...fresh });
  log.info('[tradeAdvisor] state reset to defaults');
  return fresh;
}

/**
 * Digest current market data from all sources:
 * - ML model scores (from scoreFeatures)
 * - Bucket performance (from computeBucketPerformance)
 * - Fast-peak predictions (from getFastPeakCandidates)
 * - Dead-zone tokens (from getDeadZoneTokensForScatter)
 * - Runner data (from getRunnerScatterRows)
 *
 * @returns {Promise<{candidates:Array, buckets:object, deadzoneStats:object, runners:Array}>}
 */
async function digestData() {
  // Fetch all data sources in parallel, each with its own fallback
  const [
    bucketPerf,
    fastPeak,
    deadZoneTokens,
    runners,
    bucketMonitor,
  ] = await Promise.all([
    computeBucketPerformance(5).catch(() => ({ buckets: [], highBuckets: [], baseRate: 0, totalScored: 0, totalRunners: 0 })),
    getFastPeakCandidates(null, ADVISOR_CONFIG_DEFAULTS.deadlineMin, 200).catch(() => ({ items: [], total: 0 })),
    getDeadZoneTokensForScatter().catch(() => []),
    getRunnerScatterRows(1000).catch(() => []),
    coll.config.findOne({ _id: 'bucket_monitor' }).catch(() => null),
  ]);

  // build a quick lookup of known runners by address
  const runnerMap = new Map((runners || []).map((r) => [`${r.chainId}:${r.tokenAddress}`, r]));

  // build dead-zone lookup (fast check)
  const deadZoneSet = new Set(
    (deadZoneTokens || []).map((d) => `${d.chainId}:${d.tokenAddress}`)
  );

  // get all candidates that aren't dead zone and aren't already runners
  const cands = await coll.candidates.find({
    status: { $ne: 'ignored' },
    score: { $exists: true },
  }, {
    projection: {
      chainId: 1, tokenAddress: 1, score: 1, scoreBucket: 1,
      adjustedScore: 1, adjustedBucket: 1, inDeadZone: 1,
      matchedSignals: 1, features: 1, createdAt: 1, websiteUrl: 1,
    },
  }).sort({ score: -1 }).toArray();

  return {
    bucketPerf,
    fastPeak,
    deadZoneTokens,
    runners: runnerMap,
    deadZoneSet,
    cands,
    deadzoneStats: bucketMonitor?.deadzone || { total: 0, deadZone: 0, pct: 0 },
    buckets: bucketPerf.buckets || [],
  };
}

/**
 * Score a single candidate using composite model:
 *   combinedScore = rawScore * (1 - deadzonePenalty) * fastPeakBoost
 *
 * Where:
 *   - rawScore: ML model probability
 *   - deadzonePenalty: 0 if not dead zone, up to 0.9 if high confidence
 *   - fastPeakBoost: 1.0 if in fast-peak list, decays for non-fast-peak
 *
 * @param {object} cand - candidate document
 * @param {object} data - digested data from digestData()
 * @returns {object|null}
 */
function scoreCandidateComposite(cand, data) {
  const key = `${cand.chainId}:${cand.tokenAddress}`;

  // Skip if known runner (already peaked)
  if (data.runners.has(key)) {
    const r = data.runners.get(key);
    return {
      chainId: cand.chainId,
      tokenAddress: cand.tokenAddress,
      websiteUrl: cand.websiteUrl,
      createdAt: cand.createdAt,
      baseScore: cand.score,
      combinedScore: 0,
      bucket: cand.scoreBucket,
      inDeadZone: true,
      fastPeakProb: 0,
      reason: `ALREADY_RANNER (${r.peakMultiple}x)`,
      signals: cand.matchedSignals || [],
    };
  }

  // Skip if dead zone
  if (data.deadZoneSet.has(key) || cand.inDeadZone) {
    return {
      chainId: cand.chainId,
      tokenAddress: cand.tokenAddress,
      websiteUrl: cand.websiteUrl,
      createdAt: cand.createdAt,
      baseScore: cand.score,
      combinedScore: 0,
      bucket: cand.scoreBucket,
      inDeadZone: true,
      fastPeakProb: 0,
      reason: 'DEAD_ZONE',
      signals: cand.matchedSignals || [],
    };
  }

  const rawScore = cand.adjustedScore ?? cand.score ?? 0;

  // Find fast-peak probability
  const fastPeakItem = (data.fastPeak?.items || []).find((f) =>
    f.chainId === cand.chainId && f.tokenAddress === cand.tokenAddress
  );

  const fastPeakProb = fastPeakItem?.fastPeakProb ?? 0.1; // default low for non-fast-peak-list items

  // Dead-zone confidence adjustment
  const deadzoneConfidence = cand.deadzoneConfidence ?? 0;
  const deadzonePenalty = deadzoneConfidence > 0.3 ? deadzoneConfidence * 0.9 : 0;

  // Combined score: raw score * (1 - deadzone penalty) * fast-peak factor
  // Fast-peak boost: tokens with high fastPeakProb get a multiplier
  const fastPeakBoost = 1 + (fastPeakProb * 0.5); // up to 1.5x for highest fast-peak prob

  const combinedScore = rawScore * (1 - deadzonePenalty) * fastPeakBoost;

  // Determine reason
  let reason = '';
  const bucketPerf = data.buckets.find((b) => b.bucket === cand.scoreBucket);
  if (bucketPerf) {
    reason = `bucket_rate_${bucketPerf.runnerRatePct}pct`;
  }
  if (fastPeakProb >= 0.7) reason += ' + fast_peak';
  if (fastPeakItem) reason += ' + in_fast_list';

  // Apply bucket-level confidence: if bucket has proven runner rate, boost
  // Clamp multiplier to [0.5, 1.5] to prevent runaway scores > 1.0
  const bucketMultiplier = bucketPerf && bucketPerf.runnerRate > 0
    ? 1 + Math.min(0.5, bucketPerf.runnerRate) // cap boost at 50%
    : 1;

  const finalScore = Math.min(1.0, combinedScore * bucketMultiplier);

  return {
    chainId: cand.chainId,
    tokenAddress: cand.tokenAddress,
    websiteUrl: cand.websiteUrl,
    createdAt: cand.createdAt,
    baseScore: +rawScore.toFixed(4),
    combinedScore: +finalScore.toFixed(4),
    bucket: cand.scoreBucket,
    inDeadZone: false,
    fastPeakProb,
    reason,
    signals: cand.matchedSignals || [],
  };
}

/**
 * Core: Generate trade recommendations for the next cycle.
 *
 * 1. Digests all current data
 * 2. Scores every candidate with composite model
 * 3. Filters by configurable minScore
 * 4. Sorts by combinedScore
 * 5. Takes top N
 * 6. Updates advisor state with recommendations
 *
 * @param {object} [opts] - optional overrides
 * @returns {Promise<{recommendations:Array, stats:object, state:object}>}
 */
export async function generateTradeRecommendations(opts = {}) {
  const state = await getAdvisorState();
  const data = await digestData();

  // Score all candidates
  const scored = data.cands
    .map((c) => scoreCandidateComposite(c, data))
    .filter((s) => s !== null)
    .filter((s) => !s.inDeadZone) // exclude dead zone tokens
    .filter((s) => s.combinedScore >= (opts.minScore ?? state.minScore));

  // Sort by combined score descending, then by fast-peak prob
  scored.sort((a, b) => {
    if (b.combinedScore !== a.combinedScore) return b.combinedScore - a.combinedScore;
    return b.fastPeakProb - a.fastPeakProb;
  });

  const recommendations = scored.slice(0, opts.topN ?? state.topN);

  // Only add NEW recommendations (not duplicates of pending ones)
  const existingPendingKeys = new Set(
    (state.activeRecommendations || [])
      .filter((r) => r.outcome === 'pending')
      .map((r) => `${r.chainId}:${r.tokenAddress}`)
  );
  const existingHistoryKeys = new Set(
    (state.recommendationHistory || [])
      .map((r) => `${r.chainId}:${r.tokenAddress}`)
  );

  const newRecs = recommendations
    .filter((r) => !existingPendingKeys.has(`${r.chainId}:${r.tokenAddress}`))
    .map((r) => ({
      chainId: r.chainId,
      tokenAddress: r.tokenAddress,
      websiteUrl: r.websiteUrl,
      combinedScore: r.combinedScore,
      baseScore: r.baseScore,
      bucket: r.bucket,
      fastPeakProb: r.fastPeakProb,
      reason: r.reason,
      signals: r.signals || [],
      recommendedAt: new Date().toISOString(),
      outcome: 'pending',
    }));

  // Merge: keep existing pending recs that aren't being replaced, add new ones
  const existingPending = (state.activeRecommendations || [])
    .filter((r) => r.outcome === 'pending')
    .filter((r) => !recommendations.some((n) =>
      n.chainId === r.chainId && n.tokenAddress === r.tokenAddress
    ));

  state.activeRecommendations = [...newRecs, ...existingPending];

  // Only add to history if not already there
  const newHistoryItems = newRecs.filter(
    (r) => !existingHistoryKeys.has(`${r.chainId}:${r.tokenAddress}`)
  );
  state.recommendationHistory = [
    ...newHistoryItems,
    ...(state.recommendationHistory || []),
  ].slice(0, state.historyLimit);

  state.lastRunAt = new Date();

  // Only persist to DB when explicitly requested (default: true for cron/maintenance)
  if (opts.persist !== false) {
    await saveAdvisorState(state);
  }

  const stats = {
    totalCands: data.cands.length,
    scoredCount: scored.length,
    deadZoneSkipped: data.cands.length - scored.length,
    deadZonePct: data.deadzoneStats?.pct || 0,
    runnerRate: data.bucketPerf?.baseRate || 0,
    bucketCount: (data.buckets || []).length,
    activeBucket: data.buckets?.find((b) => b.bucket === data.bucketPerf?.highBuckets?.[0]?.bucket)?.bucket || null,
  };

  log.info(`[tradeAdvisor] generated ${recommendations.length} recommendations (missRate=${state.missRatio.toFixed(2)})`);

  return { recommendations, stats, state };
}

/**
 * Record the outcome of a previously recommended token.
 * Called when a token either peaks (runner) or gets confirmed dead-zone.
 *
 * @param {string} chainId
 * @param {string} tokenAddress
 * @param {string} outcome - 'runner', 'miss_runner', 'dead_zone', 'flat'
 * @param {number} [peakMultiple] - if runner, the peak multiple achieved
 */
export async function recordOutcome(chainId, tokenAddress, outcome, peakMultiple = null) {
  const state = await getAdvisorState();
  const key = `${chainId}:${tokenAddress}`;

  // Prevent double-counting: track resolved tokens
  const resolvedSet = new Set(state.resolvedTokens || []);
  if (resolvedSet.has(key)) {
    // Already recorded an outcome for this token — skip
    return state;
  }
  resolvedSet.add(key);
  state.resolvedTokens = Array.from(resolvedSet);

  // Find in active recommendations
  const recIdx = state.activeRecommendations.findIndex(
    (r) => `${r.chainId}:${r.tokenAddress}` === key
  );

  if (recIdx >= 0) {
    state.activeRecommendations[recIdx].outcome = outcome;
    state.activeRecommendations[recIdx].peakMultiple = peakMultiple;

    // Move to history
    state.recommendationHistory = [
      state.activeRecommendations[recIdx],
      ...(state.recommendationHistory || []),
    ].slice(0, state.historyLimit);

    // Remove from active
    state.activeRecommendations.splice(recIdx, 1);
  } else {
    // Check if it's in history but still pending
    const histIdx = state.recommendationHistory.findIndex(
      (r) => `${r.chainId}:${r.tokenAddress}` === key && r.outcome === 'pending'
    );
    if (histIdx >= 0) {
      state.recommendationHistory[histIdx].outcome = outcome;
      state.recommendationHistory[histIdx].peakMultiple = peakMultiple;
      state.recommendationHistory[histIdx].resolvedAt = new Date();
    }
  }

  // Handle 'monitoring' outcome — add token to active recommendations for tracking
  if (outcome === 'monitoring') {
    const existingIdx = state.activeRecommendations?.findIndex(
      (r) => `${r.chainId}:${r.tokenAddress}` === key
    );
    if (existingIdx >= 0) {
      // Already monitoring this token
      return state;
    }
    state.activeRecommendations = state.activeRecommendations || [];
    state.activeRecommendations.unshift({
      chainId,
      tokenAddress,
      combinedScore: 0.5,
      baseScore: 0.5,
      bucket: null,
      fastPeakProb: 0.1,
      reason: 'manual_entry',
      recommendedAt: new Date(),
      outcome: 'pending',
    });
    await saveAdvisorState(state);
    return state;
  }

  // Update counters based on outcome
  if (outcome === 'runner') {
    // Token was recommended AND became a runner → true positive (gain)
    state.gainCount = (state.gainCount || 0) + 1;
  } else if (outcome === 'miss_runner') {
    // Token was recommended but did NOT run → false positive
    state.falsePositiveCount = (state.falsePositiveCount || 0) + 1;
  } else if (outcome === 'dead_zone') {
    // Token was recommended but turned out to be dead zone
    state.falsePositiveCount = (state.falsePositiveCount || 0) + 1;
  }

  // IMPORTANT: missed opportunities (false negatives) are detected
  // in resolvePendingRecommendations() — when a token becomes a runner
  // but was NOT in active recommendations, we count it as a miss.
  // This is the key metric: missedRunners / totalRunners

  // Adjust pattern weights based on outcome (reinforce/penalize signals)
  try {
    const isCorrect = outcome === 'runner';
    const tok = await coll.tokens.findOne(
      { chainId, tokenAddress },
      { projection: { matchedSignals: 1, peakMultiple: 1 } }
    );
    if (tok) {
      adjustPatternWeights(
        { signals: tok.matchedSignals || [] },
        isCorrect,
        peakMultiple || 0
      );
    }
  } catch (adjErr) {
    log.warn('[tradeAdvisor] weight adjustment failed:', adjErr.message);
  }

  // Recompute miss ratio
  // missRatio = missedRunners / gainCount (opportunity cost)
  // Higher = more runners we failed to catch
  state.missRatio = state.gainCount > 0
    ? (state.missedCount || 0) / state.gainCount
    : (state.missedCount || 0);

  // Aggressive self-adjust based on miss ratio
  const targetRatio = state.targetMissRatio || 1.0;
  const prevMissRatio = state.prevMissRatio || 0;

  if (state.missRatio > targetRatio) {
    const factor = state.missRatio > targetRatio * 2 ? 0.6 : 0.8;
    const oldMinScore = state.minScore || 0.4;
    state.minScore = Math.max(0.1, oldMinScore * factor);
    state.lastMissAdjustment = {
      direction: 'loosen',
      reason: `missRatio ${state.missRatio.toFixed(2)} > target ${targetRatio} — aggressive`,
      oldMinScore: oldMinScore,
      newMinScore: state.minScore,
      at: new Date(),
    };
    state.adjustmentCount = (state.adjustmentCount || 0) + 1;
    log.warn(`[tradeAdvisor] AGGRESSIVE MISS RATIO (${state.missRatio.toFixed(2)} > ${targetRatio}), lowering threshold to ${state.minScore}`);
  } else if (state.missRatio < targetRatio * 0.5 && prevMissRatio >= targetRatio * 0.5) {
    state.minScore = Math.min(0.9, (state.minScore || 0.4) * 1.2);
    state.lastMissAdjustment = {
      direction: 'tighten',
      reason: `missRatio ${state.missRatio.toFixed(2)} < target ${targetRatio}`,
      oldMinScore: (state.minScore || 0.4) / 1.2,
      newMinScore: state.minScore,
      at: new Date(),
    };
    state.adjustmentCount = (state.adjustmentCount || 0) + 1;
    log.info(`[tradeAdvisor] MISS RATIO LOW (${state.missRatio.toFixed(2)}), tightening threshold to ${state.minScore}`);
  }

  state.prevMissRatio = state.missRatio;

  await saveAdvisorState(state);

  return state;
}

/**
 * Auto-resolve pending recommendations AND detect missed opportunities.
 *
 * Two passes:
 * 1. Check active recommendations — resolve outcomes (gains, false positives, dead zones)
 * 2. Scan ALL runners in the dataset — if a runner was NOT recommended in this
 *    cycle, count it as a "missed opportunity" (false negative)
 *
 * @returns {Promise<{resolved:number, gains:number, missedOpportunities:number}>}
 */
export async function resolvePendingRecommendations() {
  const state = await getAdvisorState();

  // === Pass 1: Resolve active recommendations ===
  let resolved = 0;
  let gains = 0;
  let falsePos = 0;

  if (state.activeRecommendations?.length) {
    // Fetch token data for all active recommendations
    const toResolve = state.activeRecommendations
      .filter((r) => r.outcome === 'pending')
      .map((r) => ({ chainId: r.chainId, tokenAddress: r.tokenAddress }));

    if (toResolve.length > 0) {
      const keys = toResolve.map((t) => ({ chainId: t.chainId, tokenAddress: t.tokenAddress }));
      const toks = await coll.tokens.find({ $or: keys })
        .project({
          chainId: 1, tokenAddress: 1, runner: 1, peakMultiple: 1,
          timeToPeakMin: 1, becameRunnerAt: 1, lastSampleAt: 1,
        }).toArray();
      const tokMap = new Map(toks.map((t) => [`${t.chainId}:${t.tokenAddress}`, t]));

      for (const rec of state.activeRecommendations) {
        if (rec.outcome !== 'pending') continue;

        const key = `${rec.chainId}:${rec.tokenAddress}`;
        const tok = tokMap.get(key);
        if (!tok) continue; // still being tracked

        const peakMult = tok.peakMultiple ?? 1;
        const isRunner = tok.runner === true;

        if (isRunner) {
          await recordOutcome(rec.chainId, rec.tokenAddress, 'runner', peakMult);
          gains++;
          resolved++;
        } else if (peakMult > 1.2) {
          await recordOutcome(rec.chainId, rec.tokenAddress, 'runner', peakMult);
          gains++;
          resolved++;
        } else if (peakMult <= 1.05 && tok.lastSampleAt) {
          await recordOutcome(rec.chainId, rec.tokenAddress, 'dead_zone', null);
          resolved++;
        }
      }
    }
  }

  // === Pass 2: Detect missed opportunities ===
  // Find runners that were NOT recommended — only count each runner ONCE
  // to avoid inflating miss ratio on repeated resolve calls
  const countedMissed = new Set(state.countedMissedRunners || []);

  // Check recent recommendation history for tokens that became runners
  const recentHistory = (state.recommendationHistory || []).slice(0, 50);
  const recentlyRecommendedKeys = new Set(
    recentHistory.map((r) => `${r.chainId}:${r.tokenAddress}`)
  );

  const { getRunnerScatterRows } = await import('./deadzone.js');
  const allRunners = await getRunnerScatterRows(1000);

  // Get the timestamp of the LAST recommendation cycle — only count runners
  // that became runners AFTER this timestamp but weren't recommended
  const currentRun = state.lastRunAt ? new Date(state.lastRunAt) : new Date(Date.now() - 30 * 60e3);

  let missedOpportunities = 0;
  for (const runner of allRunners) {
    const key = `${runner.chainId}:${runner.tokenAddress}`;
    // Skip if already counted as missed in a previous resolve call
    if (countedMissed.has(key)) continue;
    // Skip if this runner was recently recommended
    if (recentlyRecommendedKeys.has(key)) continue;

    // Only count runners that BECAME runners AFTER the last recommendation cycle
    const tok = await coll.tokens.findOne(
      { chainId: runner.chainId, tokenAddress: runner.tokenAddress },
      { projection: { becameRunnerAt: 1, score: 1 } }
    );
    if (!tok || !tok.becameRunnerAt) continue;

    const becameRunner = new Date(tok.becameRunnerAt);
    if (becameRunner < currentRun) continue;

    // Token was eligible: has score high enough, became runner since last cycle, but wasn't recommended
    const cand = await coll.candidates.findOne(
      { chainId: runner.chainId, tokenAddress: runner.tokenAddress },
      { projection: { adjustedScore: 1 } }
    );
    if (!cand) continue;

    const score = cand.adjustedScore ?? cand.score ?? 0;
    if (score >= (state.minScore || 0.4)) {
      missedOpportunities++;
      countedMissed.add(key);
    }
  }

  // Persist the set of counted missed runners so we don't double-count
  state.countedMissedRunners = Array.from(countedMissed);
  state.missedCount = missedOpportunities > 0
    ? (state.missedCount || 0) + missedOpportunities
    : (state.missedCount || 0);

  // Recompute miss ratio: missed opportunities / gains
  state.missRatio = state.gainCount > 0
    ? (state.missedCount || 0) / state.gainCount
    : (state.missedCount || 0);

  // Aggressive self-adjust based on miss ratio
  // When miss ratio exceeds 1 (more misses than gains), lower threshold aggressively
  const targetRatio = state.targetMissRatio || 1.0;
  const prevMissRatio = state.prevMissRatio || 0;

  if (state.missRatio > targetRatio) {
    // More misses than target — aggressive loosening
    const factor = state.missRatio > targetRatio * 2 ? 0.6 : 0.8; // extra aggressive if 2x target
    const oldMinScore = state.minScore || 0.4;
    state.minScore = Math.max(0.1, oldMinScore * factor);
    state.lastMissAdjustment = {
      direction: 'loosen',
      reason: `missRatio ${state.missRatio.toFixed(2)} > target ${targetRatio} — aggressive`,
      oldMinScore: oldMinScore,
      newMinScore: state.minScore,
      at: new Date(),
    };
    state.adjustmentCount = (state.adjustmentCount || 0) + 1;
    log.warn(`[tradeAdvisor] AGGRESSIVE MISS RATIO (${state.missRatio.toFixed(2)} > ${targetRatio}), lowering threshold to ${state.minScore}`);
  } else if (state.missRatio < targetRatio * 0.5 && prevMissRatio >= targetRatio * 0.5) {
    state.minScore = Math.min(0.9, (state.minScore || 0.4) * 1.2);
    state.lastMissAdjustment = {
      direction: 'tighten',
      reason: `missRatio ${state.missRatio.toFixed(2)} < target ${targetRatio}`,
      oldMinScore: (state.minScore || 0.4) / 1.2,
      newMinScore: state.minScore,
      at: new Date(),
    };
    state.adjustmentCount = (state.adjustmentCount || 0) + 1;
    log.info(`[tradeAdvisor] MISS RATIO LOW (${state.missRatio.toFixed(2)}), tightening threshold to ${state.minScore}`);
  }

  state.prevMissRatio = state.missRatio;

  if (resolved > 0 || missedOpportunities > 0) {
    state.lastRunAt = new Date();
  }

  await saveAdvisorState(state);

  log.info(`[tradeAdvisor] resolved ${resolved} (${gains} gains), missed ${missedOpportunities} opportunities (missRatio=${state.missRatio.toFixed(2)})`);

  return { resolved, gains, falsePositives: falsePos, missedOpportunities };
}

/**
 * Get the full advisor dashboard data — digestible by the bot.
 * Combines recommendations with learning metrics.
 *
 * @returns {Promise<object>}
 */
export async function getAdvisorDashboard() {
  const state = await getAdvisorState();

  // Use persisted active recommendations instead of regenerating fresh ones
  // This ensures the dashboard shows consistent, stable recommendations
  // that don't change on every refresh
  const stats = {
    totalCands: state.activeRecommendations?.length || 0,
    scoredCount: state.activeRecommendations?.filter((r) => r.outcome === 'pending').length || 0,
    deadZoneSkipped: 0,
    deadZonePct: 0,
    runnerRate: 0,
    bucketCount: 0,
    activeBucket: null,
  };

  // Enrich recommendations with candidate signal data where missing
  const activeRecs = state.activeRecommendations || [];
  const missingSignals = activeRecs
    .filter((r) => !r.signals || r.signals.length === 0)
    .map((r) => ({ chainId: r.chainId, tokenAddress: r.tokenAddress }));
  const candMap = missingSignals.length > 0
    ? new Map(
        (await coll.candidates.find({ $or: missingSignals })
          .project({ chainId: 1, tokenAddress: 1, matchedSignals: 1 })
          .toArray())
          .map((c) => [`${c.chainId}:${c.tokenAddress}`, c.matchedSignals || []])
      )
    : new Map();

  return {
    config: {
      minScore: state.minScore,
      deadlineMin: state.deadlineMin,
      topN: state.topN,
      targetMissRatio: state.targetMissRatio,
    },
    learning: {
      missCount: state.missedCount || 0,
      gainCount: state.gainCount || 0,
      missRatio: state.missRatio,
      adjustmentCount: state.adjustmentCount || 0,
      lastMissAdjustment: state.lastMissAdjustment || null,
    },
    stats,
    activeRecommendations: activeRecs.map((r) => ({
      chainId: r.chainId,
      tokenAddress: r.tokenAddress,
      websiteUrl: r.websiteUrl,
      combinedScore: r.combinedScore,
      baseScore: r.baseScore,
      bucket: r.bucket,
      fastPeakProb: r.fastPeakProb,
      reason: r.reason,
      signals: r.signals?.length ? r.signals : (candMap.get(`${r.chainId}:${r.tokenAddress}`) || []),
      recommendedAt: r.recommendedAt,
      createdAt: r.createdAt || r.recommendedAt,
      outcome: r.outcome || 'pending',
    })),
    // Export format for bot consumption
    tradeSignals: (state.activeRecommendations || []).map((r) => ({
      symbol: `${r.chainId}:${r.tokenAddress.slice(0, 8)}`,
      chainId: r.chainId,
      tokenAddress: r.tokenAddress,
      score: r.combinedScore,
      action: 'ENTER',
      deadline: r.fastPeakProb >= 0.7 ? 'fast_peak' : 'normal',
      reason: r.reason,
      recommendedAt: r.recommendedAt,
    })),
  };
}

/**
 * Export advisor state for external consumption (bot integration).
 * Returns compact format optimized for trading bot.
 *
 * @returns {Promise<object>} Bot-ready trading signals
 */
export async function getBotSignals() {
  // Generate recommendations WITH persistence (bot consumes live signals)
  const { recommendations, stats, state } = await generateTradeRecommendations({ persist: true });

  return {
    timestamp: new Date().toISOString(),
    config: {
      minScore: state.minScore,
      deadlineMin: state.deadlineMin,
      topN: state.topN,
      targetMissRatio: state.targetMissRatio,
    },
    learning: {
      missCount: state.missedCount || 0,
      gainCount: state.gainCount || 0,
      missRatio: state.missRatio,
      adjustmentCount: state.adjustmentCount || 0,
    },
    signals: recommendations.map((r) => ({
      symbol: `${r.chainId}:${r.tokenAddress.slice(0, 8)}`,
      chainId: r.chainId,
      tokenAddress: r.tokenAddress,
      score: r.combinedScore,
      action: 'ENTER',
      deadline: r.fastPeakProb >= 0.7 ? 'fast_peak' : 'normal',
      reason: r.reason,
      recommendedAt: r.recommendedAt,
    })),
    stats,
    recommendations: recommendations.map((r) => ({
      chainId: r.chainId,
      tokenAddress: r.tokenAddress,
      combinedScore: r.combinedScore,
      baseScore: r.baseScore,
      bucket: r.bucket,
      fastPeakProb: r.fastPeakProb,
      reason: r.reason,
      signals: r.signals,
      recommendedAt: r.recommendedAt,
      outcome: 'pending',
    })),
  };
}

/**
 * Periodic paper-trade check — scans active recommendations against current
 * price data and records success/threshold crossings.
 *
 * Two threshold levels:
 *   - 1.5x: "momentum_crossed" (token is moving, not necessarily a full runner)
 *   - 2.0x: "successful_entry" (strong runner — counts as gain)
 *
 * Also detects dead-zone confirmation (peak stuck at ~1x for extended period)
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] - check all, even if recently checked
 * @returns {Promise<{checked:number, successes:number, deadZones:number, thresholdCrossings:{1.5:number,2.0:number}}>}
 */
export async function periodicPaperTradeCheck(opts = {}) {
  const state = await getAdvisorState();

  // Don't check too frequently unless forced
  const lastCheck = state.lastPaperTradeCheck ? new Date(state.lastPaperTradeCheck) : null;
  if (!opts.force && lastCheck && Date.now() - lastCheck.getTime() < 5 * 60e3) {
    return { checked: 0, skipped: true };
  }

  const recs = (state.activeRecommendations || [])
    .filter((r) => !r.outcome || r.outcome === 'pending');

  if (!recs.length) return { checked: 0, skipped: false };

  // Fetch all relevant token data in bulk
  const keys = recs.map((r) => ({ chainId: r.chainId, tokenAddress: r.tokenAddress }));
  const toks = await coll.tokens.find({ $or: keys })
    .project({
      chainId: 1, tokenAddress: 1, runner: 1, peakMultiple: 1,
      baselineUsd: 1, highWaterUsd: 1, lastPriceUsd: 1,
      lastSampleAt: 1, firstSampleAt: 1, becameRunnerAt: 1,
    }).toArray();
  const tokMap = new Map(toks.map((t) => [`${t.chainId}:${t.tokenAddress}`, t]));

  // Fetch current sample data for live price checking
  const sampleKeys = recs.map((r) => ({ chainId: r.chainId, tokenAddress: r.tokenAddress }));
  const cutoff = new Date(Date.now() - 2 * 3600e3);
  const samples = await coll.samples.find({
    $or: sampleKeys,
    t: { $gte: cutoff },
  }).sort({ chainId: 1, tokenAddress: 1, t: -1 }).toArray();

  // Group latest samples by token
  const latestSampleMap = new Map();
  for (const s of samples) {
    const key = `${s.chainId}:${s.tokenAddress}`;
    if (!latestSampleMap.has(key)) {
      latestSampleMap.set(key, s);
    }
  }

  let checked = 0;
  let successes = 0;
  let deadZones = 0;
  const crossings = { '1.5': 0, '2.0': 0 };

  let staleRecs = [];

  for (const rec of recs) {
    const key = `${rec.chainId}:${rec.tokenAddress}`;
    const tok = tokMap.get(key);
    if (!tok) continue;

    checked++;
    const baseline = tok.baselineUsd || 0;
    const peak = tok.highWaterUsd || baseline;
    const currentPrice = latestSampleMap.get(key)?.p || tok.lastPriceUsd || baseline;
    const currentMult = baseline > 0 ? currentPrice / baseline : 1;

    if (currentMult >= 2.0) {
      // SUCCESS: crossed 2x — record as gain with current peak multiple
      await recordOutcome(rec.chainId, rec.tokenAddress, 'runner', currentMult);
      crossings['2.0']++;
      successes++;
    } else if (currentMult >= 1.5) {
      // Crossed 1.5x — momentum crossing, mark for monitoring but not full gain
      crossings['1.5']++;
      // Track for stale-update at the end
      staleRecs.push({ rec, currentMult });
    } else if (tok.peakMultiple <= 1.05 && tok.lastSampleAt) {
      // Confirmed dead zone via periodic check
      const ageH = (Date.now() - new Date(tok.lastSampleAt).getTime()) / 3600e3;
      if (ageH > 2) {
        await recordOutcome(rec.chainId, rec.tokenAddress, 'dead_zone', null);
        deadZones++;
      }
    }
  }

  // Re-read state (since recordOutcome may have modified it), update stale recs + lastPaperTradeCheck
  const finalState = await getAdvisorState();
  for (const { rec, currentMult } of staleRecs) {
    const recIdx = finalState.activeRecommendations?.findIndex(
      (r) => `${r.chainId}:${r.tokenAddress}` === `${rec.chainId}:${rec.tokenAddress}`
    );
    if (recIdx >= 0) {
      finalState.activeRecommendations[recIdx].currentMult = currentMult;
      finalState.activeRecommendations[recIdx].lastChecked = new Date();
    }
  }
  finalState.lastPaperTradeCheck = new Date();
  await saveAdvisorState(finalState);

  log.info(`[tradeAdvisor] paper-check: ${checked} checked, ${successes} 2x+, ${crossings['1.5']} 1.5x+, ${deadZones} dead-zoned`);

  return { checked, successes, deadZones, thresholdCrossings: crossings };
}

/**
 * Get paper-trade performance summary — tracks how the model performed
 * across threshold crossings without bot intervention.
 *
 * @returns {Promise<object>}
 */
export async function getPaperTradeSummary() {
  const state = await getAdvisorState();

  // Count from recommendation history
  const history = state.recommendationHistory || [];
  const outcomes = {};
  let total2x = 0;
  let total1p5x = 0;
  let totalDeadZone = 0;

  for (const h of history) {
    if (h.outcome === 'runner' && h.peakMultiple >= 2.0) {
      total2x++;
    }
    if (h.outcome === 'runner' && h.peakMultiple >= 1.5) {
      total1p5x++;
    }
    if (h.outcome === 'dead_zone') {
      totalDeadZone++;
    }
  }

  // Also check token docs for threshold crossing data
  const allToks = await coll.tokens.find({
    runner: true,
    peakMultiple: { $gte: 1.5 },
    'becameRunnerAt': { $exists: true, $ne: null },
  }).project({
    chainId: 1, tokenAddress: 1, peakMultiple: 1, timeToPeakMin: 1,
    becameRunnerAt: 1, createdAt: 1, scoreBucket: 1,
  }).toArray();

  // Count how many crossed each threshold
  const crossed2x = allToks.filter((t) => (t.peakMultiple || 0) >= 2.0).length;
  const crossed1p5x = allToks.filter((t) => (t.peakMultiple || 0) >= 1.5).length;

  // Calculate avg achieved multiple for recommended tokens that became runners
  // Use recommendation history where outcome === 'runner' and peakMultiple is set
  const runnerHistories = history.filter((h) => h.outcome === 'runner' && h.peakMultiple);
  const avgAchieved = runnerHistories.length > 0
    ? +((runnerHistories.reduce((s, h) => s + (h.peakMultiple || 1), 0) / runnerHistories.length)).toFixed(3)
    : null;

  return {
    period: 'all-time',
    paperTraded: total2x,
    crossed2x: crossed2x,
    crossed1p5x: crossed1p5x,
    deadZoneAvoided: totalDeadZone,
    recommendationHistory: history.length,
    lastPaperTradeCheck: state.lastPaperTradeCheck,
    missRatio: state.missRatio,
    gainCount: state.gainCount || 0,
    avgAchieved: avgAchieved,
    missedCount: state.missedCount || 0,
    falsePositiveCount: state.falsePositiveCount || 0,
    minScore: state.minScore,
  };
}

// Default export for convenience
export default {
  generateTradeRecommendations,
  recordOutcome,
  resolvePendingRecommendations,
  getAdvisorDashboard,
  getBotSignals,
  getAdvisorState,
  saveAdvisorState,
  periodicPaperTradeCheck,
  getPaperTradeSummary,
};