import { coll } from '../db.js';

// One outcome function over ANY ascending [{t, p}] series — live samples or GT candles.
export function outcomeFromSeries(points) {
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

export async function computeOutcome(chainId, tokenAddress) {
  const pts = await coll.samples.find({ chainId, tokenAddress }).sort({ t: 1 }).project({ t: 1, p: 1 }).toArray();
  return outcomeFromSeries(pts);
}