import { config } from '../config.js';
import { coll } from '../db.js';
import { GT_NETWORKS } from './chains.js';

// Rebuilds price history from GeckoTerminal 5m candles into `samples` so labels
// survive downtime. Ratio-based labels only need a consistent series.
export async function backfillLabels({ chainId, tokenAddress, createdAt, horizonMs }) {
  const net = GT_NETWORKS[chainId];
  if (!net) return { ok: false, reason: 'network-unsupported' };

  const pr = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
    { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
  const pairs = (await pr.json().catch(() => ({}))).pairs || [];
  let best = null;
  for (const p of pairs) {
    if (String(p.chainId).toLowerCase() !== String(chainId).toLowerCase()) continue;
    if (String(p.baseToken?.address || '').toLowerCase() !== String(tokenAddress).toLowerCase()) continue;
    if (!best || (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) best = p;
  }
  if (!best?.pairAddress) return { ok: false, reason: 'no-pair' };

  const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/pools/${best.pairAddress}/ohlcv/minute?aggregate=5&limit=1000`,
    { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } });
  if (!r.ok) return { ok: false, reason: `gt-http-${r.status}` };
  const list = (await r.json().catch(() => null))?.data?.attributes?.ohlcv_list || [];

  const startMs = new Date(createdAt).getTime() - 5 * 60e3;
  const endMs = new Date(createdAt).getTime() + horizonMs;
  const have = new Set((await coll.samples.find({ chainId, tokenAddress }, { projection: { t: 1 } }).toArray())
    .map((s) => new Date(s.t).getTime()));
  const docs = [];
  for (const row of list) {
    const t = new Date(Number(row[0]) * 1000);
    if (t.getTime() < startMs || t.getTime() > endMs || have.has(t.getTime())) continue;
    const p = Number(row[4]);
    if (!isFinite(p) || p <= 0) continue;
    docs.push({ chainId, tokenAddress, pairAddress: best.pairAddress, t, p,
      b5: 0, s5: 0, b1: 0, s1: 0, v24: null, lq: best.liquidity?.usd ?? 0, mc: null, pc24: null, source: 'gt' });
  }
  if (docs.length) await coll.samples.insertMany(docs, { ordered: false });
  return { ok: true, inserted: docs.length };
}