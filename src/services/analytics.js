import { config } from '../config.js';
import { coll } from '../db.js';

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export async function getWindowData() {
  const cutoff = new Date(Date.now() - config.sample.windowHours * 3600e3);
  const cands = await coll.candidates.find({ status: { $ne: 'ignored' }, createdAt: { $gte: cutoff } },
    { projection: { chainId: 1, tokenAddress: 1, matchedSignals: 1, createdAt: 1, websiteUrl: 1 } }).toArray();
  const keys = cands.map((c) => ({ chainId: c.chainId, tokenAddress: c.tokenAddress }));
  const toks = keys.length ? await coll.tokens.find({ $or: keys },
    { projection: { chainId: 1, tokenAddress: 1, runner: 1, timeToPeakMin: 1, peakMultiple: 1, becameRunnerAt: 1, peakAt: 1, baselineUsd: 1, highWaterUsd: 1, firstSeenAt: 1 } }).toArray() : [];
  const tmap = new Map(toks.map((t) => [`${t.chainId}:${t.tokenAddress}`, t]));
  return cands.map((c) => ({ ...c, tok: tmap.get(`${c.chainId}:${c.tokenAddress}`) || null }));
}

export async function getRunnerRows() {
  const rows = (await getWindowData()).filter((r) => r.tok?.runner);
  return rows.map((r) => ({
    chainId: r.chainId, tokenAddress: r.tokenAddress, websiteUrl: r.websiteUrl,
    firstSeenAt: r.createdAt, becameRunnerAt: r.tok.becameRunnerAt, peakAt: r.tok.peakAt,
    timeToPeakMin: r.tok.timeToPeakMin ?? null,
    baselineUsd: r.tok.baselineUsd ?? null, peakUsd: r.tok.highWaterUsd ?? null,
    peakMultiple: r.tok.peakMultiple ?? null, signals: r.matchedSignals || [],
  }));
}

export async function getAnalyticsSummary() {
  const rows = await getWindowData();
  const tracked = rows.filter((r) => r.tok?.lastSampleAt);
  const runners = rows.filter((r) => r.tok?.runner);

  const ttp = runners.map((r) => r.tok.timeToPeakMin).filter((v) => v != null);
  const mults = runners.map((r) => r.tok.peakMultiple).filter((v) => v != null);

  const seenHour = Array.from({ length: 24 }, () => ({ seen: 0, runners: 0 }));
  const peakHour = Array.from({ length: 24 }, () => 0);
  for (const r of rows) {
    const h = new Date(r.createdAt).getUTCHours();
    seenHour[h].seen++;
    if (r.tok?.runner) { seenHour[h].runners++; if (r.tok.peakAt) peakHour[new Date(r.tok.peakAt).getUTCHours()]++; }
  }

  const sig = {};
  for (const r of rows) {
    const isRun = !!r.tok?.runner;
    for (const s of r.matchedSignals || []) {
      sig[s] ??= { run: 0, non: 0 };
      isRun ? sig[s].run++ : sig[s].non++;
    }
  }
  const nRun = runners.length, nNon = rows.length - nRun;
  const signals = Object.entries(sig).map(([name, v]) => {
    const inRunners = nRun ? v.run / nRun : 0;
    const inNon = nNon ? v.non / nNon : 0;
    return { name, runnersPct: Math.round(inRunners * 100), nonRunnersPct: Math.round(inNon * 100), lift: inNon ? +(inRunners / inNon).toFixed(2) : null };
  }).sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0));

  const chains = {};
  for (const r of rows) { chains[r.chainId] ??= { total: 0, runners: 0 }; chains[r.chainId].total++; if (r.tok?.runner) chains[r.chainId].runners++; }

  const medT = median(ttp);
  return {
    windowHours: config.sample.windowHours,
    candidates: rows.length, tracked: tracked.length, runners: nRun,
    runnerRatePct: rows.length ? Math.round((nRun / rows.length) * 100) : 0,
    timeToPeakMin: { median: medT, p25: median(ttp.filter((v) => v <= medT)), p75: median(ttp.filter((v) => v >= medT)) },
    peakMultiple: { median: median(mults), max: mults.length ? Math.max(...mults) : null },
    seenByHourUTC: seenHour, peakByHourUTC: peakHour, signals, chains,
  };
}