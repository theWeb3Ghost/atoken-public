import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { CircuitBreaker } from '../lib/util.js';
import { GOPLUS_NETWORKS } from './chains.js';

const goplusCb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60000 });
const rugcheckCb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60000 });

// GoPlus for EVM, RugCheck for Solana. Unsupported chain → honest sec_unknown=1
// ("unknown" must stay its own category in training — never faked as safe).
export async function fetchSecurity(chainId, tokenAddress) {
  const out = { sec_unknown: 1, honeypot: 0, mintable: 0, open_source: 0, owner_pct01: 0, lp_top_pct01: 0, rc_score01: 0, rc_danger: 0 };
  try {
    if (GOPLUS_NETWORKS[chainId]) {
      try {
        const s = await goplusCb.fire(async () => {
          const r = await fetch(`https://api.gopluslabs.io/api/v1/security/${GOPLUS_NETWORKS[chainId]}/${tokenAddress}`,
            { signal: AbortSignal.timeout(config.sec.timeoutMs) });
          const data = (await r.json().catch(() => ({})))?.result;
          if (!r.ok) throw new Error(`goplus http ${r.status}`);
          return data;
        });
        if (s && typeof s === 'object') {
          out.sec_unknown = 0;
          out.honeypot = s.is_honeypot === '1' ? 1 : 0;
          out.mintable = s.is_mintable === '1' ? 1 : 0;
          out.open_source = s.is_open_source === '1' ? 1 : 0;
          out.owner_pct01 = Math.min(1, (Number(s.owner_percentage) || 0) / 100);
          const lp = Array.isArray(s.lp_holders) && s.lp_holders.length ? Number(s.lp_holders[0].percentage) || 0 : 0;
          out.lp_top_pct01 = Math.min(1, lp / 100);
        }
      } catch (e) {
        if (e.message === 'circuit breaker: open') return out; // keep sec_unknown
        throw e;
      }
    } else if (chainId === 'solana') {
      try {
        const d = await rugcheckCb.fire(async () => {
          const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report/summary`,
            { signal: AbortSignal.timeout(config.sec.timeoutMs) });
          if (!r.ok) throw new Error(`rugcheck http ${r.status}`);
          return await r.json().catch(() => ({}));
        });
        if (d && typeof d === 'object') {
          out.sec_unknown = 0;
          out.rc_score01 = Math.max(0, Math.min(1, (Number(d.score_normalised ?? d.score) || 0) / 100));
          out.rc_danger = Array.isArray(d.risks) ? d.risks.filter((x) => String(x.level || '').toLowerCase() === 'danger').length : 0;
        }
      } catch (e) {
        if (e.message === 'circuit breaker: open') return out;
        throw e;
      }
    }
  } catch (e) {
    if (e.message === 'circuit breaker: open') {
      log.info(`[sec] circuit breaker open for ${GOPLUS_NETWORKS[chainId] ? 'goplus' : 'rugcheck'}, returning unknown`);
    } else {
      log.warn(`[sec] ${chainId}:${String(tokenAddress).slice(0, 10)} ${e.message}`);
    }
  }
  return out;
}
