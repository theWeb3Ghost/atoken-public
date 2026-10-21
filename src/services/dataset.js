import fs from 'node:fs';
import path from 'node:path';
import { coll } from '../db.js';
import { FEATURE_NAMES } from './features.js';

export async function buildDataset() {
  const cands = await coll.candidates.find({ status: { $ne: 'ignored' }, features: { $exists: true } })
    .project({ chainId: 1, tokenAddress: 1, createdAt: 1, features: 1 }).toArray();

  // Batch-fetch all samples for all candidates in one query
  const keys = cands.map((c) => ({ chainId: c.chainId, tokenAddress: c.tokenAddress }));
  const allSamples = keys.length
    ? await coll.samples.find({ $or: keys }, { projection: { chainId: 1, tokenAddress: 1, t: 1, p: 1 } })
      .sort({ chainId: 1, tokenAddress: 1, t: 1 }).toArray()
    : [];

  // Group samples by token
  const byToken = new Map();
  for (const s of allSamples) {
    const k = `${s.chainId}:${s.tokenAddress}`;
    if (!byToken.has(k)) byToken.set(k, []);
    byToken.get(k).push({ t: s.t, p: s.p });
  }

  // Compute outcomes in parallel batches
  const BATCH_SIZE = 50;
  const rows = [];
  for (let i = 0; i < cands.length; i += BATCH_SIZE) {
    const batch = cands.slice(i, i + BATCH_SIZE);
    const batchRows = await Promise.all(batch.map(async (c) => {
      const k = `${c.chainId}:${c.tokenAddress}`;
      const points = byToken.get(k) || [];
      const outcome = computeOutcomeFromPoints(points);
      return {
        chainId: c.chainId, tokenAddress: c.tokenAddress,
        createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : String(c.createdAt),
        features: c.features,
        outcome,
      };
    }));
    rows.push(...batchRows);
  }

  const dataset = { exportedAt: new Date().toISOString(), featureNames: FEATURE_NAMES, rows };
  fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'data', 'dataset.json'), JSON.stringify(dataset));
  return {
    exported: true, rows: rows.length,
    labeled: rows.filter((r) => r.outcome.label_known).length,
    runners: rows.filter((r) => r.outcome.ran_2x).length,
  };
}

// Local copy of outcome logic — no DB query needed since samples are pre-fetched
function computeOutcomeFromPoints(points) {
  if (!points.length) return { label_known: 0 };
  const p0 = points[0].p;
  if (!(p0 > 0)) return { label_known: 0 };
  let peak = p0, peakAt = points[0].t, peak6 = p0, runPeak = 0, rugged = 0, rugAt = null;
  const t0 = new Date(points[0].t).getTime();
  const sixH = t0 + 6 * 3600e3;
  for (const pt of points) {
    if (pt.p > peak) { peak = pt.p; peakAt = pt.t; }
    if (new Date(pt.t).getTime() <= sixH && pt.p > peak6) peak6 = pt.p;
    if (pt.p > runPeak) runPeak = pt.p;
    else if (runPeak / p0 >= 2 && pt.p < 0.35 * runPeak && !rugged) { rugged = 1; rugAt = pt.t; }
  }
  const last = points[points.length - 1];
  return {
    label_known: points.length >= 3 ? 1 : 0,
    ran_2x: peak / p0 >= 2 ? 1 : 0,
    ran_5x: peak / p0 >= 5 ? 1 : 0,
    peak_multiple: +(peak / p0).toFixed(3),
    peak_6h_multiple: +(peak6 / p0).toFixed(3),
    time_to_peak_min: Math.round((new Date(peakAt).getTime() - t0) / 60000),
    rugged,
    rug_speed_min: rugged && rugAt ? Math.round((new Date(rugAt).getTime() - t0) / 60000) : null,
    final_multiple: +(last.p / p0).toFixed(3),
    dead_72: (Date.now() - t0 > 48 * 3600e3 && last.p / p0 < 0.5) ? 1 : 0,
    n_points: points.length,
  };
}
