import { config } from '../config.js';
import { coll } from '../db.js';
import { log } from '../lib/logger.js';
import { sampleQueue } from '../queues.js';

const PAIR_URL = 'https://api.dexscreener.com/latest/dex/tokens/';
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// Map internal chain IDs to DexScreener chain IDs.
// Note: 'robinhood' is kept as its own chain (not mapped to 'base') for consistency
// with runnerPredictor.js chain multipliers. DexScreener may use 'base' for
// robinhood pairs, but we preserve the internal chain ID for multiplier lookups.
const CHAIN_MAP = {
  'robinhood': 'base',
  'ink': 'ink',
  'hyperevm': 'hyperevm',
  'solana': 'solana',
  'ethereum': 'ethereum',
  'base': 'base',
  'bsc': 'bsc',
  'starknet': 'starknet',
  'cronos': 'cronos',
  'arc': 'arc',
};
const mapChain = (chainId) => {
  const lower = String(chainId).toLowerCase();
  return CHAIN_MAP[lower] || lower;
};

export async function getTrackedCandidates() {
  const cutoff = new Date(Date.now() - config.sample.windowHours * 3600e3);
  const q = { status: { $ne: 'ignored' }, createdAt: { $gte: cutoff } };
  return coll.candidates.find(q, { projection: { chainId: 1, tokenAddress: 1 } })
    .sort({ createdAt: -1 }).limit(config.sample.maxTracked).toArray();
}

export async function scheduleCycle() {
  const counts = await sampleQueue.getJobCounts('waiting', 'active');
  if (counts.waiting + counts.active > 0) { log.warn('[sample] previous cycle still running — skipping (backpressure)'); return { skipped: true }; }
  const items = await getTrackedCandidates();
  if (!items.length) return { queued: 0 };
  const cycle = Date.now();
  const groups = chunk(items, 30);
  for (let i = 0; i < groups.length; i++) {
    await sampleQueue.add('sampleBatch',
      { cycle, items: groups[i].map((x) => ({ chainId: x.chainId, tokenAddress: x.tokenAddress })) },
      { jobId: `smp__${cycle}__${i}` });
  }
  log.info(`[sample] cycle → ${groups.length} batches / ${items.length} tokens`);
  return { queued: groups.length };
}

export function bestPair(pairs, chainId, tokenAddress) {
  const a = String(tokenAddress).toLowerCase();
  let best = null;
  for (const p of pairs || []) {
    if (!p?.baseToken?.address) continue;
    if (p.baseToken.address.toLowerCase() !== a) continue;
    // DexScreener uses different chain names (e.g. robinhood → base)
    if (String(p.chainId).toLowerCase() !== mapChain(chainId)) continue;
    if (!best || (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) best = p;
  }
  return best;
}

async function updateTokenStats(d) {
  const tok = await coll.tokens.findOne(
    { chainId: d.chainId, tokenAddress: d.tokenAddress },
    { projection: { baselineUsd: 1, highWaterUsd: 1, runner: 1, firstSeenAt: 1, firstSampleAt: 1 } });
  if (!tok) return null;

  const now = d.t instanceof Date ? d.t : new Date(d.t);
  const upd = { $set: { lastPriceUsd: d.p, lastSampleAt: now, lastLiquidityUsd: d.lq } };
  let baseline = tok.baselineUsd;
  if (!baseline) { baseline = d.p; upd.$set.baselineUsd = baseline; }
  if (!tok.firstSampleAt) upd.$set.firstSampleAt = now;

  if (d.p > (tok.highWaterUsd || 0)) {
    upd.$set.highWaterUsd = d.p;
    upd.$set.peakAt = now;
    upd.$set.peakMultiple = d.p / baseline;
  }

  const high = Math.max(tok.highWaterUsd || 0, d.p);
  let flip = null;
  if (!tok.runner && baseline > 0 && high >= baseline * config.sample.runnerMultiple && d.lq >= config.sample.minLiquidity) {
    upd.$set.runner = true;
    upd.$set.becameRunnerAt = now;
    upd.$set.timeToPeakMin = Math.round((now - (tok.firstSeenAt || tok.firstSampleAt || now)) / 60000);
    flip = { chainId: d.chainId, tokenAddress: d.tokenAddress, multiple: high / baseline };
  }
  await coll.tokens.updateOne({ _id: tok._id }, upd);
  return flip;
}

export async function processBatch({ items }) {
  const url = PAIR_URL + items.map((i) => i.tokenAddress).join(',');
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`dexscreener pairs http ${res.status}`);
  const data = await res.json();
  const pairs = data.pairs || [];

  const docs = [];
  const flips = [];
  for (const it of items) {
    const pair = bestPair(pairs, it.chainId, it.tokenAddress);
    if (!pair) continue;
    const p = Number(pair.priceUsd);
    if (!isFinite(p) || p <= 0) continue;
    docs.push({
      chainId: it.chainId, tokenAddress: it.tokenAddress, pairAddress: pair.pairAddress || null,
      t: new Date(), p,
      b5: pair.txns?.m5?.buys ?? 0, s5: pair.txns?.m5?.sells ?? 0,
      b1: pair.txns?.h1?.buys ?? 0, s1: pair.txns?.h1?.sells ?? 0,
      v24: pair.volume?.h24 ?? 0, lq: pair.liquidity?.usd ?? 0,
      mc: pair.marketCap ?? pair.fdv ?? null, pc24: pair.priceChange?.h24 ?? null, source: 'live',
    });
  }
  if (docs.length) await coll.samples.insertMany(docs, { ordered: false });
  for (const d of docs) { const f = await updateTokenStats(d); if (f) flips.push(f); }
  return { points: docs.length, flips };
}