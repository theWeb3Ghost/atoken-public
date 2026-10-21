import fs from 'node:fs';
import path from 'node:path';
import { coll } from '../db.js';
import { log } from '../lib/logger.js';

const MODEL_PATH = path.join(process.cwd(), 'data', 'model.json');
let model = null;

export function loadModel(force = false) {
  if (model && !force) return model;
  try {
    model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
    log.info(`[ml] model loaded: ${model.meta.rows} rows, wf-AUC ${Number(model.meta.walk_forward_auc).toFixed(3)}, trained ${model.meta.trained_at}`);
  } catch { model = null; }
  return model;
}

export const bucketOf = (p) => (p < .2 ? '0-20' : p < .4 ? '20-40' : p < .6 ? '40-60' : p < .8 ? '60-80' : '80-100');

export function scoreFeatures(features) {
  const m = loadModel();
  if (!m) return null;
  let z = m.bias;
  m.feature_names.forEach((f, i) => { z += m.weights[i] * (features?.[f] ?? 0); });
  let p = 1 / (1 + Math.exp(-z));
  const bin = m.calibration.find((c) => p >= c.lo && p < c.hi);
  if (bin && bin.observed != null) p = bin.observed;
  return { p: +p.toFixed(4), bucket: bucketOf(p) };
}

export async function scoreCandidate(cand) {
  const s = scoreFeatures(cand.features);
  if (!s) return null;
  await coll.candidates.updateOne({ _id: cand._id },
    { $set: { score: s.p, scoreBucket: s.bucket, scoredAt: new Date() } });
  return s;
}

export async function rescoreAll() {
  if (!loadModel(true)) return 0;
  const cands = await coll.candidates.find({ features: { $exists: true } }).toArray();
  let n = 0;
  for (const c of cands) if (await scoreCandidate(c)) n++;
  log.info(`[ml] rescored ${n} candidates`);
  return n;
}

/**
 * Enhanced candidate scoring that applies dead-zone and bucket adjustments.
 * Returns enriched score info including adjusted scores.
 */
export async function scoreCandidateWithAdjustment(cand) {
  const s = scoreFeatures(cand.features);
  if (!s) return null;

  // fetch token doc for dead-zone check
  const tok = await coll.tokens.findOne(
    { chainId: cand.chainId, tokenAddress: cand.tokenAddress },
    { projection: { runner: 1, peakMultiple: 1, baselineUsd: 1, highWaterUsd: 1, firstSampleAt: 1, lastSampleAt: 1 } }
  );

  // check dead zone
  const isDeadZone = tok && tok.runner === false && (tok.peakMultiple ?? 1) <= 1.05;
  let deadzoneConfidence = 0;
  if (isDeadZone && tok) {
    if (tok.firstSampleAt && tok.lastSampleAt) {
      const trackedH = (new Date(tok.lastSampleAt).getTime() - new Date(tok.firstSampleAt).getTime()) / 3600e3;
      deadzoneConfidence = Math.min(1, trackedH / 12);
    } else if (tok.lastSampleAt) {
      const ageH = (Date.now() - new Date(tok.lastSampleAt).getTime()) / 3600e3;
      deadzoneConfidence = Math.min(1, ageH / 12);
    }
  }

  let adjustedScore = s.p;
  if (isDeadZone && deadzoneConfidence > 0.3) {
    adjustedScore = Math.min(s.p, s.p * (1 - deadzoneConfidence * 0.8));
  }

  const result = {
    rawScore: s.p,
    bucket: s.bucket,
    adjustedScore: +adjustedScore.toFixed(4),
    adjustedBucket: bucketOf(adjustedScore),
    inDeadZone: isDeadZone && deadzoneConfidence > 0.3,
    deadzoneConfidence: +deadzoneConfidence.toFixed(3),
  };

  await coll.candidates.updateOne(
    { _id: cand._id },
    { $set: {
      score: s.p, scoreBucket: s.bucket,
      adjustedScore: result.adjustedScore,
      adjustedBucket: result.adjustedBucket,
      inDeadZone: result.inDeadZone,
      deadzoneConfidence: result.deadzoneConfidence,
      scoredAt: new Date(),
    } }
  );
  return result;
}