// Dynamic Runner Predictor — JS orchestration layer
// Bridges MongoDB candidate token data to the Rust prediction engine logic
// Runs a 30-second scoring cycle and 30-minute learning cycle

import { coll } from '../db.js';
import { log } from '../lib/logger.js';
import { getAnalyticsSummary } from './analytics.js';

const PREDICT_INTERVAL_MS = 30_000;   // every 30 seconds
const LEARN_INTERVAL_MS = 30 * 60_000; // every 30 minutes
const LIVE_LADDER_LIMIT = 100;        // top candidates in ladder

// --- Shared state for WebSocket consumers ---
// This is exported so server.js can broadcast over WS
export const liveRankings = new Map();       // tokenId -> PredictionRecord
export const predictionAccuracy = new Map(); // tokenId -> { predicted, actual, correct }
export const momentumAlerted = new Set();    // tokenId -> already alerted for momentum entry

// --- Dynamic weights — computed from analytics every learning cycle ---
// Initial values are conservative; will be overwritten by computeLearnedWeights()
export let patternWeights = {
  docs: 0.12,
  about: 0.08,
  connect_wallet: 0.10,
  privacy: 0.06,
  terms: 0.04,
  whitepaper: 0.10,
  play: 0.05,
  website: 0.08,
  audit: 0.10,
  renounced: 0.08,
};

export let chainMultipliers = {
  solana: 1.4,
  robinhood: 1.1,
  hyperevm: 1.0,
  ethereum: 0.9,
  bsc: 0.7,
  base: 0.9,
  arbitrum: 1.0,
  polygon: 0.8,
  optimism: 0.9,
  blast: 1.1,
  abstract: 1.2,
};

export const learningConfig = {
  freshness_boost_hours: 12,
  freshness_decay_per_hour: 0.04,
  learning_rate: 0.02,
  score_thresholds: {
    watch: 0.3,    // probability >= 0.3
    signal: 0.5,   // probability >= 0.5
    strong: 0.7,   // probability >= 0.7
    critical: 0.85, // probability >= 0.85
  },
};

// --- Core scoring functions (mirrors Rust lib.rs) ---

/**
 * Calculate runner probability for a token based on its features
 * @param {object} token - Token data from MongoDB
 * @param {number} now - Current timestamp
 * @returns {{probability: number, confidence: number, reasons: string[], level: string, signals_matched: string[]}}
 */
export function calculateRunnerProbability(token, now = Date.now()) {
  if (!token) {
    return { probability: 0, confidence: 0, reasons: [], level: 'watch', signals_matched: [] };
  }

  const reasons = [];
  let raw_score = 0.0;

  // Already a runner
  if (token.is_runner || token.runner === true) {
    return {
      probability: 1.0,
      confidence: 0.95,
      reasons: ['already_runner'],
      level: 'critical',
      signals_matched: token.signals || [],
    };
  }

  const nowS = now / 1000;

  // --- Dead-zone check (penalty for tokens with no price appreciation) ---
  let deadzonePenalty = 0;
  if (token.peakMultiple != null && !token.is_runner && token.runner !== true) {
    if (token.peakMultiple <= 1.01) {
      // Token has minimal price movement — apply dead-zone penalty
      deadzonePenalty = 0.8; // 80% score reduction
      if (token.peakMultiple > 1.0) {
        deadzonePenalty = 0.8 * (1 - (token.peakMultiple - 1.0) / 0.01);
        deadzonePenalty = Math.max(0, Math.min(0.8, deadzonePenalty));
      }
    }
  }

  // 1. Base ML score (0-1 scale → 0-40 points)
  const ml_score = (token.score || token.ml_score || 0);
  const ml_component = ml_score * 40.0 * (1 - deadzonePenalty);
  raw_score += ml_component;
  if (ml_component > 0.1) {
    reasons.push(`ml_${ml_score.toFixed(3)}`);
  }

  // 2. Signal weights (0-100 points) — each signal contributes proportionally
  // but we cap total signal contribution to prevent saturation
  const signals = token.signals || token.matchedSignals || [];
  let signal_score = 0.0;
  for (const sig of signals) {
    const weight = patternWeights[sig.toLowerCase()] || patternWeights[sig] || 0;
    if (weight > 0) {
      signal_score += weight * 100.0;
      if (weight > 0.05) {
        reasons.push(`sig_${sig}`);
      }
    }
  }
  signal_score = Math.min(signal_score, 100); // cap signal contribution at 100 (matches README)
  raw_score += signal_score;

  // 3. Chain multiplier
  const chain = (token.chainId || token.chain_id || '').toLowerCase();
  const chain_mult = chainMultipliers[chain] || 1.0;
  const chain_boost = (chain_mult - 1.0) * 20.0; // ±20 points
  raw_score += chain_boost;
  if (chain_boost > 0.1) {
    reasons.push(`chain_${chain}_x${chain_mult.toFixed(1)}`);
  }

  // 4. Price movement (momentum) — guard against division by zero / underflow
  let current_mult = token.current_multiple || 1.0;
  if (!token.current_multiple && token.lastPriceUsd && token.baselineUsd
      && token.baselineUsd > 1e-15) {
    current_mult = token.lastPriceUsd / token.baselineUsd;
  }
  // Cap to prevent runaway scores from tiny baseline values
  current_mult = Math.min(current_mult, 100);

  const peak_mult = Math.min(token.peak_multiple || token.peakMultiple || current_mult, 100);

  if (current_mult >= 2.0) {
    raw_score += Math.min((current_mult - 1.0) * 5.0, 20);  // cap at 20
    reasons.push('price_2x');
  } else if (current_mult >= 1.5) {
    raw_score += Math.min((current_mult - 1.5) * 30.0, 15);  // cap at 15
    reasons.push('price_1.5x');
  } else if (current_mult >= 1.3) {
    raw_score += Math.min((current_mult - 1.3) * 15.0, 8);   // cap at 8
    reasons.push('price_1.3x');
  } else if (current_mult >= 1.2) {
    raw_score += Math.min((current_mult - 1.2) * 10.0, 5);   // cap at 5
    reasons.push('price_1.2x');
  }

  // 5. Freshness boost (reduced — cap at 10 points max)
  const first_seen = token.first_seen_at || token.firstSeenAt
    ? new Date(token.first_seen_at || token.firstSeenAt).getTime() / 1000
    : (token.createdAt ? new Date(token.createdAt).getTime() / 1000 : nowS);
  const age_hours = (nowS - first_seen) / 3600.0;
  if (age_hours < learningConfig.freshness_boost_hours) {
    const freshness_mult = 1.0 + (learningConfig.freshness_boost_hours - age_hours) / learningConfig.freshness_boost_hours;
    const freshness_boost = Math.min((freshness_mult - 1.0) * 10.0, 10);
    raw_score += freshness_boost;
    if (freshness_boost > 0.5) {
      reasons.push(`fresh_${age_hours.toFixed(0)}h`);
    }
  }

  // 6. Liquidity and volume
  const liq = token.liquidity_usd || token.liquidityUsd || 0;
  const vol = token.volume_24h || token.volume24h || 0;
  if (liq > 10000.0) raw_score += 5.0;
  if (vol > 50000.0) raw_score += 5.0;

  // Clamp to 0-100
  const clamped = Math.max(0.0, Math.min(100.0, raw_score));

  // Sigmoid to probability — centered at 40, divisor 12 (per README)
  // At raw_score=40, probability=0.5; steeper curve for better differentiation
  const z = (clamped - 40.0) / 12.0;
  const probability = 1.0 / (1.0 + Math.exp(-z));

  // Confidence
  let confidence = 0.5;
  confidence += Math.min(5.0, signals.length) * 0.05;
  if (predictionAccuracy.size > 0) {
    let correct = 0, total = 0;
    for (const v of predictionAccuracy.values()) {
      if (v.correct !== undefined) { correct += v.correct ? 1 : 0; total += 1; }
    }
    if (total > 0) {
      const historical = correct / total;
      confidence = Math.max(confidence * 0.5 + historical * 0.5, 0.1);
    }
  }
  const prob_confidence = Math.abs(probability - 0.5) * 2.0;
  confidence = Math.min(confidence * 0.7 + prob_confidence * 0.3, 0.95);

  // Determine level
  const thresholds = learningConfig.score_thresholds;
  const level = probability >= thresholds.critical ? 'critical'
    : probability >= thresholds.strong ? 'strong'
    : probability >= thresholds.signal ? 'signal'
    : 'watch';

  return {
    probability: Math.round(probability * 1000) / 1000,
    confidence: Math.round(confidence * 1000) / 1000,
    reasons,
    level,
    signals_matched: signals,
  };
}

/**
 * Record a prediction outcome for learning
 * @param {string} tokenId - `${chainId}:${tokenAddress}`
 * @param {number} predictedProb - The probability we predicted
 * @param {boolean} becameRunner - Whether it actually became a 2x+ runner
 * @param {number} peakMult - Actual peak multiple achieved
 */
export function recordPrediction(tokenId, predictedProb, becameRunner, peakMult) {
  predictionAccuracy.set(tokenId, {
    predicted: predictedProb,
    becameRunner,
    correct: becameRunner && peakMult >= 2.0,
    peakMult,
    timestamp: Date.now(),
  });
}

/**
 * Record the outcome of a prediction (alias for recordPrediction).
 * Called when we know whether a token became a runner.
 * @param {string} tokenId - `${chainId}:${tokenAddress}`
 * @param {boolean} becameRunner - Whether it actually became a 2x+ runner
 * @param {number} peakMult - Actual peak multiple achieved
 * @param {number} predictedProb - The probability we had predicted (optional)
 */
export function recordOutcome(tokenId, becameRunner, peakMult, predictedProb = 0) {
  const existing = predictionAccuracy.get(tokenId);
  recordPrediction(tokenId, predictedProb || (existing?.predicted || 0), becameRunner, peakMult);
}

/**
 * Adjust pattern weights based on prediction accuracy
 * Uses gradient-free optimization: reinforce correct predictions, penalize misses
 * @param {object} token - The token data with signals
 * @param {boolean} correct - Whether prediction was correct
 * @param {number} peakMult - Peak multiple achieved
 */
export function adjustPatternWeights(token, correct, peakMult) {
  const lr = learningConfig.learning_rate;
  const signals = token.signals || token.matchedSignals || [];

  if (correct && peakMult >= 2.0) {
    // Reinforce signal weights
    for (const sig of signals) {
      const key = sig.toLowerCase();
      if (patternWeights[key] !== undefined) {
        patternWeights[key] = Math.min(1.0, patternWeights[key] + lr);
      }
    }
    log.info(`[predictor] Reinforced signals: ${signals.join(', ')}`);
  } else if (!correct) {
    // Penalize false positives
    const reduction = lr * 2.0;
    for (const sig of signals) {
      const key = sig.toLowerCase();
      if (patternWeights[key] !== undefined) {
        patternWeights[key] = Math.max(0.0, patternWeights[key] - reduction);
      }
    }
    log.info(`[predictor] Penalized signals: ${signals.join(', ')}`);
  }
}

// --- Data fetching ---

/**
 * Fetch candidate tokens from MongoDB with enriched token data
 * Filters to fresh (non-dead-zone) tokens only
 */
async function fetchCandidateTokens() {
  const cands = await coll.candidates.find({
    status: { $ne: 'ignored' },
  }).sort({ createdAt: -1 }).limit(200).toArray();

  if (!cands.length) return [];

  // Batch fetch token docs for current price/peak data
  const keys = cands.map((c) => ({
    chainId: c.chainId,
    tokenAddress: c.tokenAddress,
  }));

  const toks = await coll.tokens.find({
    $or: keys,
    lastSampleAt: { $exists: true },  // exclude dead zone (no price data)
  }).project({
    chainId: 1, tokenAddress: 1, runner: 1, peakMultiple: 1,
    baselineUsd: 1, highWaterUsd: 1, lastPriceUsd: 1,
    firstSampleAt: 1, lastSampleAt: 1, becameRunnerAt: 1,
    timeToPeakMin: 1, volume24h: 1, liquidityUsd: 1, v24: 1, lastLiquidityUsd: 1,
  }).toArray();

  const tokMap = new Map(
    toks.map((t) => [`${t.chainId}:${t.tokenAddress}`, t])
  );

  // Merge candidate features with token data
  return cands
    .filter((c) => tokMap.has(`${c.chainId}:${c.tokenAddress}`))
    .map((c) => {
      const tok = tokMap.get(`${c.chainId}:${c.tokenAddress}`);
      const current_mult = tok.lastPriceUsd && tok.baselineUsd && tok.baselineUsd > 1e-15
        ? tok.lastPriceUsd / tok.baselineUsd
        : 1.0;
      return {
        ...c,
        is_runner: tok.runner === true,
        peakMultiple: tok.peakMultiple,
        peak_multiple: tok.peakMultiple,
        current_multiple: Math.min(current_mult, 100),
        signals: c.matchedSignals || c.signals || [],
        baselineUsd: tok.baselineUsd,
        lastPriceUsd: tok.lastPriceUsd,
        liquidityUsd: tok.liquidityUsd || tok.lastLiquidityUsd || 0,
        volume24h: tok.volume24h || tok.v24 || 0,
        firstSeenAt: tok.firstSampleAt || c.createdAt,
      };
    });
}

// --- Scoring cycle ---

/**
 * Run one scoring cycle — scores all candidate tokens and updates liveRankings
 */
async function runScoringCycle() {
  const start = Date.now();
  const now = Date.now();

  try {
    const candidates = await fetchCandidateTokens();
    const scored = [];

    for (const token of candidates) {
      const result = calculateRunnerProbability(token, now);
      const tokenId = `${token.chainId}:${token.tokenAddress}`;

      // Update live rankings — sanitize values to avoid corruption
      const safeCurrentMult = Math.min(token.current_multiple || 1.0, 100);
      const safePeakMult = Math.min(token.peakMultiple || safeCurrentMult, 100);
      liveRankings.set(tokenId, {
        ...result,
        tokenId,
        chainId: token.chainId,
        tokenAddress: token.tokenAddress,
        websiteUrl: token.websiteUrl,
        score: token.score || 0,
        current_multiple: safeCurrentMult,
        peak_multiple: safePeakMult,
        age_hours: (now - new Date(token.firstSeenAt || token.createdAt).getTime()) / 3.6e6,
        is_runner: token.is_runner,
        signals: token.signals || [],
      });

      // Record prediction for learning (only first time we see this token)
      if (!predictionAccuracy.has(tokenId)) {
        recordPrediction(tokenId, result.probability, false, 0);
      }

      scored.push({
        tokenId,
        probability: result.probability,
        confidence: result.confidence,
        level: result.level,
      });
    }

    // Sort by probability descending
    scored.sort((a, b) => b.probability - a.probability);

    // Keep only top N in live rankings (the rest stay but are lower priority)
    // Actually keep ALL — the frontend shows top 50

    // Check for momentum entry signals (40-100 bucket tokens crossing 1.3x threshold)
    try {
      const momentumResults = await checkMomentumEntrySignals(1.3, 30);
      if (momentumResults.some((r) => r.messaged)) {
        log.info('[predictor] Momentum alerts sent:', momentumResults.filter(r => r.messaged).length);
      }
    } catch (momentumErr) {
      log.warn('[predictor] Momentum monitor error:', momentumErr.message);
    }

    log.info(`[predictor] Scoring cycle: ${scored.length} tokens scored in ${Date.now() - start}ms`);

    return {
      scored: scored.length,
      top50: scored.slice(0, 50),
      cycleTimeMs: Date.now() - start,
    };
  } catch (err) {
    log.warn('[predictor] Scoring cycle error:', err.message);
    return { error: err.message };
  }
}

// --- Learning cycle ---

/**
 * Compute signal weights from lift data fetched from the analytics API.
 * NO HARDCODING — weights are derived directly from observed lift ratios.
 *
 * Conversion: lift is the ratio of a signal's occurrence in runners vs non-runners.
 * lift > 1.0 means the signal is associated with runners (positive).
 * lift < 1.0 means the signal is associated with non-runners (negative).
 *
 * weight = lift * 0.10, then clamped to [0.01, 0.35]
 * Signals with lift < 1.0 get weight * 0.2 (drastically reduced)
 *
 * @param {Array<{name: string, lift: number}>} signals - signal lift data from analytics
 * @returns {object} signal name -> weight
 */
function computeWeightsFromLifts(signals) {
  const BASE_WEIGHT = 0.10;
  const MAX_WEIGHT = 0.35;
  const MIN_WEIGHT = 0.01;

  const newWeights = { ...patternWeights };

  for (const sig of signals) {
    const lift = sig.lift;
    if (lift === null || lift === undefined || typeof lift !== 'number') continue;

    let weight = lift * BASE_WEIGHT;

    if (lift < 1.0) {
      // Negative correlation — drastically reduce weight
      weight = Math.max(MIN_WEIGHT, lift * BASE_WEIGHT * 0.2);
    }

    weight = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, weight));
    newWeights[sig.name.toLowerCase()] = parseFloat(weight.toFixed(4));
  }

  return newWeights;
}

/**
 * Compute chain multipliers from runner rates fetched from analytics.
 * multiplier = runnerRate / baseRate, where baseRate is the median across all chains.
 *
 * @param {object} chains - chainId -> {total, runners, runnerRate}
 * @returns {object} chain name -> multiplier
 */
function computeMultipliersFromRates(chains) {
  if (!chains || Object.keys(chains) === 0) return { ...chainMultipliers };

  // Compute base rate (median across chains with sufficient samples)
  const rates = Object.entries(chains)
    .filter(([, stats]) => {
      const total = stats?.total || 0;
      const rate = typeof stats?.runnerRate === 'number' ? stats.runnerRate : 0;
      return total > 0 && total >= 10 && rate > 0;
    })
    .map(([, stats]) => stats.runnerRate);

  if (rates.length === 0) return { ...chainMultipliers };

  rates.sort((a, b) => a - b);
  const midIdx = Math.floor(rates.length / 2);
  const baseRate = rates.length % 2
    ? rates[midIdx]
    : (rates[midIdx - 1] + rates[midIdx]) / 2;

  if (baseRate <= 0 || isNaN(baseRate)) return { ...chainMultipliers };

  const newMultipliers = { ...chainMultipliers };

  for (const [chain, stats] of Object.entries(chains)) {
    const total = stats?.total || 0;
    if (total === 0) continue;

    // Compute runner rate if not provided
    let rate = typeof stats.runnerRate === 'number' ? stats.runnerRate : 0;
    if (rate === 0 && total > 0 && typeof stats.runners === 'number') {
      rate = stats.runners / total;
    }

    if (isNaN(rate) || rate === 0) {
      // No runners observed — lowest multiplier
      newMultipliers[chain.toLowerCase()] = 0.5;
      continue;
    }

    if (isNaN(rate / baseRate)) {
      newMultipliers[chain.toLowerCase()] = 1.0;
      continue;
    }

    // Multiplier: rate / baseRate, clamped to [0.5, 2.5]
    let mult = rate / baseRate;
    // Small-sample adjustment: boost chains with few samples to be more exploratory
    const sampleBoost = total < 50 ? 1.2 : 1.0;
    mult = Math.min(2.5, Math.max(0.5, mult * sampleBoost));
    if (isNaN(mult)) mult = 1.0;
    newMultipliers[chain.toLowerCase()] = parseFloat(mult.toFixed(3));
  }

  return newMultipliers;
}

/**
 * Fetch signal lift data directly from the analytics API endpoint.
 * The runner-dna endpoint returns lift ratios per signal feature.
 * @returns {Promise<Array<{name: string, lift: number}>>}
 */
async function fetchSignalLiftsFromAPI() {
  // Primary: fetch from the analytics API endpoint
  try {
    // Try multiple possible endpoints for runner DNA data
    const endpoints = [
      '/api/analytics/runner-dna',
      '/api/analytics/dna',
      '/api/runner-dna',
    ];

    for (const endpoint of endpoints) {
      // Use relative or localhost URL since this runs on the same server
      const baseUrl = process.env.BACKEND_URL || 'http://localhost:8080';
      const res = await fetch(`${baseUrl}${endpoint}`, {
        headers: { 'x-api-token': process.env.API_TOKEN || '' },
      });
      if (!res.ok) continue;

      const data = await res.json();

      // Parse lift data from the response
      // The runner-dna endpoint returns { similaritySets: [{ features: [{ feature, lift }] }] }
      const lifts = [];
      const dna = data.similaritySets || data.runnerDNA || data.runner_dna || [];

      for (const set of Array.isArray(dna) ? dna : [dna]) {
        const features = set.features || (Array.isArray(set) ? set : []);
        for (const feat of features) {
          if (feat.feature && typeof feat.lift === 'number') {
            lifts.push({ name: feat.feature, lift: feat.lift });
          }
        }
      }

      // Also check for direct lift arrays in the response
      if (data.signals && Array.isArray(data.signals)) {
        for (const sig of data.signals) {
          if (sig.name && typeof sig.lift === 'number') {
            lifts.push({ name: sig.name, lift: sig.lift });
          }
        }
      }

      if (lifts.length > 0) return lifts;
    }
  } catch (err) {
    log.warn('[predictor] Failed to fetch signal lifts from API:', err.message);
  }

  return [];
}

/**
 * Fetch chain-level runner rates from the analytics API.
 * The scatter endpoint returns per-chain runner/deadzone data.
 * @returns {Promise<object>} chainId -> {total, runners, runnerRate}
 */
async function fetchChainRatesFromAPI() {
  const endpoints = [
    '/api/analytics/summary',
    '/api/runners/scatter',
    '/api/analytics/buckets',
  ];

  for (const endpoint of endpoints) {
    try {
      const baseUrl = process.env.BACKEND_URL || 'http://localhost:8080';
      const res = await fetch(`${baseUrl}${endpoint}`, {
        headers: { 'x-api-token': process.env.API_TOKEN || '' },
      });
      if (!res.ok) continue;

      const data = await res.json();

      // Parse chain data
      // summary endpoint: { chains: { chainId: { total, runners, runnerRate } } }
      if (data.chains) {
        return data.chains;
      }

      // scatter endpoint: { runners: [...], deadZone: [...] }
      if (data.runners && Array.isArray(data.runners)) {
        const chains = {};
        for (const runner of data.runners) {
          const cid = runner.chainId;
          if (!chains[cid]) chains[cid] = { total: 0, runners: 0, runnerRate: 0 };
          chains[cid].runners++;
          chains[cid].total++;
        }
        // Add dead zone tokens to total count
        if (data.deadZone && Array.isArray(data.deadZone)) {
          for (const dz of data.deadZone) {
            const cid = dz.chainId;
            if (!chains[cid]) chains[cid] = { total: 0, runners: 0, runnerRate: 0 };
            chains[cid].total++;
          }
        }
        // Compute rates
        for (const [cid, stats] of Object.entries(chains)) {
          if (stats.total > 0) {
            stats.runnerRate = stats.runners / stats.total;
          }
        }
        if (Object.keys(chains).length > 0) return chains;
      }

      // buckets endpoint may have chain info
      if (data.chainRunnerRates) {
        return data.chainRunnerRates;
      }

    } catch (err) {
      log.warn(`[predictor] Failed to fetch chain data from ${endpoint}:`, err.message);
    }
  }

  return {};
}

/**
 * Compute learned weights by dynamically fetching data from the analytics API
 * and the analytics service. NO hardcoding — everything is derived from data.
 */
async function computeLearnedWeights() {
  // 1. Fetch signal lift data from API
  const apiLifts = await fetchSignalLiftsFromAPI();

  // 2. Also compute lifts from local MongoDB via analytics service
  // This is the ground truth from the actual data
  let localSignals = [];
  try {
    const summary = await getAnalyticsSummary();
    if (summary && summary.signals) {
      localSignals = summary.signals;
    }
  } catch (err) {
    log.warn('[predictor] Failed to fetch local analytics summary:', err.message);
  }

  // 3. Merge: prefer API lifts, supplement with local
  const allLiftsMap = new Map();

  for (const sig of apiLifts) {
    allLiftsMap.set(sig.name.toLowerCase(), sig.lift);
  }
  for (const sig of localSignals) {
    if (!allLiftsMap.has(sig.name.toLowerCase())) {
      allLiftsMap.set(sig.name.toLowerCase(), sig.lift);
    }
  }

  // Use initial default weights as fallback only when no live data is available
  // (ensures all signals have a baseline weight even with no training data yet)
  for (const [name, weight] of Object.entries(patternWeights)) {
    if (!allLiftsMap.has(name)) {
      // Convert initial weight back to a lift-equivalent (weight = lift * 0.10)
      allLiftsMap.set(name, weight / 0.10);
    }
  }

  // Convert to array for computeWeightsFromLifts
  const signalsArray = Array.from(allLiftsMap.entries()).map(([name, lift]) => ({ name, lift }));

  if (signalsArray.length > 0) {
    patternWeights = computeWeightsFromLifts(signalsArray);
    log.info('[predictor] Updated pattern weights from lift data:',
      Object.entries(patternWeights)
        .map(([k, v]) => `${k}:${v.toFixed(4)}`)
        .join(', '));
  }

  // 4. Compute chain multipliers
  const apiChains = await fetchChainRatesFromAPI();

  let localChains = {};
  try {
    const summary = await getAnalyticsSummary();
    if (summary && summary.chains) {
      localChains = summary.chains;
    }
  } catch (err) {
    log.warn('[predictor] Failed to fetch local chain data:', err.message);
  }

  // Merge: prefer API, supplement with local
  const mergedChains = { ...localChains };
  for (const [chain, stats] of Object.entries(apiChains)) {
    mergedChains[chain.toLowerCase()] = stats;
  }

  if (Object.keys(mergedChains).length > 0) {
    chainMultipliers = computeMultipliersFromRates(mergedChains);
    log.info('[predictor] Updated chain multipliers from runner rates:',
      Object.entries(chainMultipliers)
        .map(([k, v]) => `${k}:${v.toFixed(3)}`)
        .join(', '));
  }

  // 5. Persist to MongoDB for cross-instance sync
  try {
    await coll.config.updateOne(
      { _id: 'predictor_weights' },
      {
        $set: {
          patternWeights: { ...patternWeights },
          chainMultipliers: { ...chainMultipliers },
          learningConfig: { ...learningConfig },
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (persistErr) {
    log.warn('[predictor] Failed to persist weights:', persistErr.message);
  }

  return {
    signalCount: signalsArray.length,
    chainCount: Object.keys(mergedChains).length,
    weights: { ...patternWeights },
    multipliers: { ...chainMultipliers },
  };
}

/**
 * Run one learning cycle — recompute weights from analytics data
 */
async function runLearningCycle() {
  const start = Date.now();

  try {
    // 1. Dynamically compute learned weights from fetched data
    const computeResult = await computeLearnedWeights();

    // 2. Track recent prediction accuracy for feedback
    const misses = Array.from(predictionAccuracy.values()).filter((v) => v && !v.correct);
    const hits = Array.from(predictionAccuracy.values()).filter((v) => v && v.correct);
    const miss_ratio = hits.length > 0 ? misses.length / hits.length : 0;

    // 3. Aggressive threshold adjustment if miss ratio is too high
    if (miss_ratio > 3.0 && misses.length > 10) {
      log.warn(`[predictor] CRITICAL miss ratio: ${miss_ratio.toFixed(2)} — adjusting thresholds`);
      learningConfig.score_thresholds.signal = 0.3;
      learningConfig.score_thresholds.strong = 0.5;
      learningConfig.score_thresholds.critical = 0.75;
    } else if (miss_ratio > 1.5 && misses.length > 5) {
      log.warn(`[predictor] High miss ratio: ${miss_ratio.toFixed(2)} — adjusting thresholds`);
      learningConfig.score_thresholds.signal = 0.35;
      learningConfig.score_thresholds.strong = 0.55;
    }

    log.info(`[predictor] Learning cycle: ${computeResult.signalCount} signal lifts, ${computeResult.chainCount} chains, miss ratio ${miss_ratio.toFixed(3)} in ${Date.now() - start}ms`);

    return {
      signalLifts: computeResult.signalCount,
      chainRates: computeResult.chainCount,
      missRatio: miss_ratio,
      totalPredictions: predictionAccuracy.size,
      accuracy: hits.length + misses.length > 0
        ? hits.length / (hits.length + misses.length)
        : 0,
      cycleTimeMs: Date.now() - start,
      weights: { ...patternWeights },
      multipliers: { ...chainMultipliers },
    };
  } catch (err) {
    log.warn('[predictor] Learning cycle error:', err.message);
    return { error: err.message };
  }
}

/**
 * Load persisted weights from MongoDB (if available)
 */
export async function loadPersistedWeights() {
  try {
    const doc = await coll.config.findOne({ _id: 'predictor_weights' });
    if (doc) {
      if (doc.patternWeights) {
        Object.assign(patternWeights, doc.patternWeights);
      }
      if (doc.chainMultipliers) {
        Object.assign(chainMultipliers, doc.chainMultipliers);
      }
      if (doc.learningConfig) {
        Object.assign(learningConfig, doc.learningConfig);
      }
      log.info('[predictor] Loaded persisted weights from MongoDB');
      return true;
    }
  } catch (err) {
    log.warn('[predictor] Failed to load persisted weights:', err.message);
  }
  return false;
}

// --- Public API ---

let scoringTimer = null;
let learningTimer = null;

export function startPredictionLoop() {
  if (scoringTimer) clearInterval(scoringTimer);
  if (learningTimer) clearInterval(learningTimer);

  log.info('[predictor] Starting prediction loop (30s cycle)');

  // Compute learned weights immediately on startup, then run scoring
  computeLearnedWeights().then(() => runScoringCycle());
  scoringTimer = setInterval(runScoringCycle, PREDICT_INTERVAL_MS);

  // Learning every 30 min — each cycle re-computes weights from fetched data
  learningTimer = setInterval(runLearningCycle, LEARN_INTERVAL_MS);

  return {
    stop: () => {
      clearInterval(scoringTimer);
      clearInterval(learningTimer);
      scoringTimer = null;
      learningTimer = null;
      log.info('[predictor] Prediction loop stopped');
    },
  };
}

/**
 * Get current live rankings (top N by probability)
 * @param {number} [limit=50]
 * @returns {Array}
 */
export function getLiveRankings(limit = 50) {
  return Array.from(liveRankings.values())
    .filter((r) => !r.is_runner)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, limit);
}

/**
 * Get all rankings including runners
 * @param {number} [limit=100]
 * @returns {Array}
 */
export function getAllRankings(limit = 100) {
  return Array.from(liveRankings.values())
    .sort((a, b) => b.probability - a.probability)
    .slice(0, limit);
}

/**
 * Copy a token to the monitoring bucket (for price tracking)
 * This is called when a token enters the top 10s of the ladder
 */
export async function copyToMonitoringBucket(tokenId) {
  const record = liveRankings.get(tokenId);
  if (!record || record.is_runner) return null;

  // Upsert into the monitoring collection for price tracking
  await coll.monitoring.updateOne(
    { tokenId },
    {
      $set: {
        tokenId: record.tokenId,
        chainId: record.chainId,
        tokenAddress: record.tokenAddress,
        probability: record.probability,
        confidence: record.confidence,
        current_multiple: record.current_multiple,
        peak_multiple: record.peak_multiple,
        status: 'monitoring',
        signals: record.signals,
      },
      $setOnInsert: {
        firstSeenAt: new Date(),
        enteredAt: new Date(),
        multAtEntry: record.current_multiple || 1.0,
      },
    },
    { upsert: true }
  );

  log.info(`[predictor] Copied ${tokenId} to monitoring bucket (prob: ${record.probability.toFixed(3)})`);
  return record;
}

/**
 * Check top 10 tokens — if any entered top 10, copy to monitoring bucket
 */
export async function checkAndCopyTopTokens() {
  const top10 = getLiveRankings(10);
  const copied = [];

  for (const record of top10) {
    const existing = await coll.monitoring.findOne({ tokenId: record.tokenId });
    if (!existing) {
      const result = await copyToMonitoringBucket(record.tokenId);
      if (result) copied.push(record.tokenId);
    }
  }

  return copied;
}

/**
 * Momentum Entry Monitor — check tokens in the 40-100 score bucket for
 * momentum threshold crossings (default 1.3x current multiple).
 * Fires Telegram alerts for new entries.
 *
 * @param {number} [multThreshold=1.3] - minimum current_multiple to trigger alert
 * @param {number} [limit=30] - max tokens to check
 * @returns {Promise<Array<{tokenId:string,messaged:boolean}>>}
 */
export async function checkMomentumEntrySignals(multThreshold = 1.3, limit = 30) {
  const results = [];

  // Get all non-runner tokens with their current multiples from live rankings
  const candidates = Array.from(liveRankings.values())
    .filter((r) => !r.is_runner && (r.current_multiple || 1) >= multThreshold)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, limit);

  if (!candidates.length) return results;

  // Batch fetch token docs to verify signal status and get token data
  const keys = candidates.map((r) => ({ chainId: r.chainId, tokenAddress: r.tokenAddress }));
  const toks = keys.length
    ? await coll.tokens.find({ $or: keys })
      .project({
        chainId: 1, tokenAddress: 1, runner: 1, peakMultiple: 1,
        baselineUsd: 1, highWaterUsd: 1, lastPriceUsd: 1,
      }).toArray()
    : [];
  const tokMap = new Map(toks.map((t) => [`${t.chainId}:${t.tokenAddress}`, t]));

  // Also fetch candidate docs for score bucket info
  const cands = await coll.candidates.find(
    { $or: keys }
  ).project({ chainId: 1, tokenAddress: 1, scoreBucket: 1, matchedSignals: 1 }).toArray();
  const candMap = new Map(cands.map((c) => [`${c.chainId}:${c.tokenAddress}`, c]));

  const { enqueueNotification } = await import('./notifier/index.js');
  const { momentumEntryMessage } = await import('./notifier/format.js');

  for (const record of candidates) {
    const tokenId = record.tokenId;
    if (momentumAlerted.has(tokenId)) continue; // already alerted

    const tok = tokMap.get(tokenId);
    if (!tok || tok.runner === true) continue; // became runner since last cycle

    const cand = candMap.get(tokenId);
    const currentMult = tok.lastPriceUsd && tok.baselineUsd && tok.baselineUsd > 1e-15
      ? tok.lastPriceUsd / tok.baselineUsd
      : 1.0;

    if (currentMult < multThreshold) continue;

    // This token crossed the threshold — send alert + copy to monitoring bucket
    const signal = {
      ...record,
      tokenId,
      chainId: record.chainId,
      tokenAddress: record.tokenAddress,
      current_multiple: currentMult,
      peak_multiple: tok.peakMultiple || currentMult,
      websiteUrl: cand?.websiteUrl || record.websiteUrl || '',
      signals: cand?.matchedSignals || record.signals || [],
      scoreBucket: cand?.scoreBucket || '80-100',
    };

    try {
      // Sanitize tokenId for dedupeKey (BullMQ job IDs can't contain colons)
      const safeKey = tokenId.replace(/:/g, '_');
      await enqueueNotification({
        dedupeKey: `momentum_${safeKey}`,
        kind: 'momentum_entry',
        chainId: signal.chainId,
        tokenAddress: signal.tokenAddress,
        text: momentumEntryMessage(signal, multThreshold),
      });

      // Copy to monitoring bucket for ongoing tracking
      await coll.monitoring.updateOne(
        { tokenId },
        {
          $set: {
            tokenId,
            chainId: record.chainId,
            tokenAddress: record.tokenAddress,
            probability: record.probability || 0,
            confidence: record.confidence || 0,
            status: 'monitoring',
            current_multiple: currentMult,
            peak_multiple: tok.peakMultiple || currentMult,
            scoreBucket: cand?.scoreBucket || '80-100',
            score: record.score || 0,
            signals: signal.signals,
            websiteUrl: signal.websiteUrl,
          },
          $setOnInsert: {
            firstSeenAt: new Date(),
            enteredAt: new Date(),
            multAtEntry: currentMult,
          },
        },
        { upsert: true }
      );

      momentumAlerted.add(tokenId);
      results.push({ tokenId, messaged: true });
      log.info(`[predictor] Momentum entry alert sent for ${tokenId} (${currentMult.toFixed(2)}x)`);
    } catch (err) {
      log.warn(`[predictor] Failed to send momentum alert for ${tokenId}:`, err.message);
      results.push({ tokenId, messaged: false });
    }
  }

  return results;
}

// --- WebSocket broadcast payload ---

/**
 * Get the data payload to broadcast via WebSocket
 */
export function getBroadcastPayload() {
  return {
    rankings: getLiveRankings(50),
    stats: {
      total_tracked: liveRankings.size,
      accuracy: (() => {
        const hits = Array.from(predictionAccuracy.values()).filter((v) => v && v.correct);
        const total = Array.from(predictionAccuracy.values()).filter((v) => v && v.correct !== undefined);
        return total.length > 0 ? hits.length / total.length : 0;
      })(),
      weights: { ...patternWeights },
      chains: { ...chainMultipliers },
    },
    timestamp: Date.now(),
  };
}

export { runScoringCycle, runLearningCycle, computeLearnedWeights };
