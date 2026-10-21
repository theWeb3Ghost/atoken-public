import { config } from '../config.js';
import { coll } from '../db.js';
import { log } from '../lib/logger.js';

export async function openPaperTrades(limit = 50) {
  const cands = await coll.candidates.find({ score: { $gte: config.paper.minScore }, status: { $ne: 'ignored' } })
    .sort({ scoredAt: -1 }).limit(limit).toArray();
  let n = 0;
  for (const c of cands) {
    if (await coll.paperTrades.findOne({ chainId: c.chainId, tokenAddress: c.tokenAddress })) continue;
    const tok = await coll.tokens.findOne({ chainId: c.chainId, tokenAddress: c.tokenAddress }, { projection: { lastPriceUsd: 1, lastSampleAt: 1 } });
    if (!(tok?.lastPriceUsd > 0)) continue;
    await coll.paperTrades.insertOne({
      chainId: c.chainId, tokenAddress: c.tokenAddress, score: c.score,
      entry: tok.lastPriceUsd, entryAt: tok.lastSampleAt || new Date(),
      peakMult: 1, status: 'open', openedAt: new Date(),
    });
    n++;
  }
  if (n) log.info(`[paper] opened ${n} trades`);
  return n;
}

export async function gradePaperTrades() {
  const open = await coll.paperTrades.find({ status: 'open' }).limit(500).toArray();
  let closed = 0;
  const stop = 1 - config.paper.stopPct;
  for (const tr of open) {
    const pts = await coll.samples.find({ chainId: tr.chainId, tokenAddress: tr.tokenAddress, t: { $gte: new Date(tr.entryAt) } })
      .sort({ t: 1 }).project({ t: 1, p: 1 }).toArray();
    if (!pts.length) continue;
    let peak = 1, stopped = false;
    for (const pt of pts) {
      const m = pt.p / tr.entry;
      if (m > peak) peak = m;
      if (m <= stop) { stopped = true; break; }
    }
    const ageH = (Date.now() - new Date(tr.entryAt).getTime()) / 3600e3;
    if (stopped || ageH >= config.paper.horizonHours) {
      const finalMult = pts[pts.length - 1].p / tr.entry;
      await coll.paperTrades.updateOne({ _id: tr._id }, { $set: {
        status: 'closed', closedAt: new Date(), peakMult: +peak.toFixed(3),
        achievedMult: +(stopped ? stop : finalMult).toFixed(3), exitReason: stopped ? 'stop' : 'horizon',
      } });
      closed++;
    } else {
      await coll.paperTrades.updateOne({ _id: tr._id }, { $set: { peakMult: +peak.toFixed(3) } });
    }
  }
  return { open: open.length, closed };
}