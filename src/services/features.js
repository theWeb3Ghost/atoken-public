// FEATURE SNAPSHOT — everything knowable AT DISCOVERY TIME (no lookahead).
export const FEATURE_NAMES = [
  'chain_solana', 'chain_ethereum', 'chain_robinhood', 'chain_bsc', 'chain_base', 'chain_other',
  'sig_docs', 'sig_privacy', 'sig_terms', 'n_signals',
  'has_desc', 'desc_len_log',
  'tld_xyz', 'tld_fun', 'tld_lol', 'tld_com', 'tld_other',
  'n_links', 'text_len_log', 'h_sin', 'h_cos',
  'sec_unknown', 'honeypot', 'mintable', 'open_source', 'owner_pct01', 'lp_top_pct01', 'rc_score01', 'rc_danger',
  'llm_done', 'llm_templated01', 'llm_product01', 'llm_specificity01', 'llm_contra01',
];

const KNOWN_CHAINS = ['solana', 'ethereum', 'robinhood', 'bsc', 'base'];
const TLDS = { tld_xyz: ['xyz'], tld_fun: ['fun'], tld_lol: ['lol'], tld_com: ['com', 'io', 'app', 'dev', 'ai', 'net', 'org'] };
const log10 = (n) => +Math.log10(1 + n).toFixed(4);

const SEC_DEFAULTS = { sec_unknown: 1, honeypot: 0, mintable: 0, open_source: 0, owner_pct01: 0, lp_top_pct01: 0, rc_score01: 0, rc_danger: 0 };
const LLM_DEFAULTS = { llm_done: 0, llm_templated01: 0, llm_product01: 0, llm_specificity01: 0, llm_contra01: 0 };

export function extractFeatures(cand) {
  const f = {};
  const chainF = {};
  for (const c of KNOWN_CHAINS) chainF[`chain_${c}`] = cand.chainId === c ? 1 : 0;
  chainF.chain_other = Object.values(chainF).some((v) => v === 1) ? 0 : 1;
  Object.assign(f, chainF);

  const sigs = cand.matchedSignals || [];
  for (const s of ['docs', 'privacy', 'terms']) f[`sig_${s}`] = sigs.includes(s) ? 1 : 0;
  f.n_signals = sigs.length;

  const desc = cand.description || '';
  f.has_desc = desc ? 1 : 0;
  f.desc_len_log = log10(desc.length);

  let tld = '';
  try { tld = new URL(cand.websiteUrl).hostname.split('.').pop().toLowerCase(); } catch {}
  const tldF = {};
  for (const [k, list] of Object.entries(TLDS)) tldF[k] = list.includes(tld) ? 1 : 0;
  tldF.tld_other = Object.values(tldF).some((v) => v === 1) ? 0 : 1;
  Object.assign(f, tldF);

  f.n_links = (cand.matchedLinks || []).length;
  f.text_len_log = log10((cand.websiteText || '').length);

  const h = new Date(cand.createdAt || Date.now()).getUTCHours();
  f.h_sin = +Math.sin((2 * Math.PI * h) / 24).toFixed(4);
  f.h_cos = +Math.cos((2 * Math.PI * h) / 24).toFixed(4);

  Object.assign(f, SEC_DEFAULTS, cand.sec || {});
  Object.assign(f, LLM_DEFAULTS, cand.llm || {});
  return f;
}