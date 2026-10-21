import { coll } from '../db.js';
import { loadModel } from './score.js';
import { esc, candidateKeyboard } from './notifier/format.js';
import { shortCa } from '../normalize.js';

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const mult = (x) => (x == null ? '—' : `${Number(x).toFixed(2)}x`);
const ago = (d) => { if (!d) return '—'; const m = Math.round((Date.now() - new Date(d).getTime()) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

function secLine(f) {
  if (!f) return 'not recorded';
  if (f.sec_unknown) return 'unknown chain (not checked)';
  if (f.honeypot) return '🚩 <b>HONEYPOT</b>';
  const bits = [];
  if (f.mintable) bits.push('⚠️ mintable');
  if (f.open_source) bits.push('opensource ✓');
  if (f.owner_pct01 > 0.05) bits.push(`owner ${pct(f.owner_pct01)}`);
  if (f.lp_top_pct01 > 0) bits.push(`LP top ${pct(f.lp_top_pct01)}`);
  if (f.rc_danger > 0) bits.push(`🚩 ${f.rc_danger} rugcheck dangers`);
  if (f.rc_score01 > 0) bits.push(`rc score ${Math.round(f.rc_score01 * 100)}`);
  return bits.length ? bits.join(' · ') : 'clean ✓';
}
function llmLine(f) {
  if (!f?.llm_done) return 'pending/none';
  return `templated ${Math.round(f.llm_templated01 * 10)}/10 · product ${Math.round(f.llm_product01 * 10)}/10 · specificity ${Math.round(f.llm_specificity01 * 10)}/10 · contradictions ${Math.round(f.llm_contra01 * 10)}/10`;
}
function scoreLine(c) {
  const m = loadModel();
  if (c.score != null) return `<b>${pct(c.score)}</b> (bucket ${esc(c.scoreBucket)})${m ? ` · model AUC ${Number(m.meta.walk_forward_auc).toFixed(2)}` : ''}`;
  return m ? 'not scored' : 'no model yet (gates not passed)';
}

export async function fullReport(chainId, tokenAddress) {
  const cand = await coll.candidates.findOne({ chainId, tokenAddress });
  if (!cand) return { ok: false, text: '❌ Not tracked. Only candidates that passed the discovery pipeline have reports.' };
  const tok = (await coll.tokens.findOne({ chainId, tokenAddress })) || {};
  const paper = await coll.paperTrades.findOne({ chainId, tokenAddress });
  const analysis = await coll.analyses.findOne({ chainId, tokenAddress, status: 'done' }, { sort: { requestedAt: -1 } });
  const nSamples = await coll.samples.countDocuments({ chainId, tokenAddress });

  const L = [
    '🎯 <b>TOKEN REPORT</b>', '',
    `<b>CA:</b> <code>${esc(tokenAddress)}</code>`,
    `<b>Chain:</b> ${esc(chainId)} · <b>Found:</b> ${ago(cand.createdAt)} (${new Date(cand.createdAt).toISOString().slice(0, 16)} UTC)`,
    `<b>Website:</b> ${esc(cand.websiteUrl)}`,
    `<b>Signals:</b> ${(cand.matchedSignals || []).map(esc).join(', ') || '—'}`,
    cand.matches?.length ? `<b>Trigger:</b> ${esc(cand.matches[0].type)}: "${esc(String(cand.matches[0].text).slice(0, 60))}"` : '',
    '', `<b>ML score:</b> ${scoreLine(cand)}`,
    `<b>Security:</b> ${secLine(cand.features)}`,
    `<b>Content LLM:</b> ${llmLine(cand.features)}`,
    '', '📈 <b>Tracking</b>',
    `Baseline ${tok.baselineUsd ?? '—'} · Last ${tok.lastPriceUsd ?? '—'} (${ago(tok.lastSampleAt)})`,
    `Peak <b>${mult(tok.peakMultiple)}</b>${tok.peakAt ? ` at ${ago(tok.peakAt)}` : ''} · Time-to-peak ${tok.timeToPeakMin != null ? tok.timeToPeakMin + 'm' : '—'}`,
    `Samples: ${nSamples} points ${nSamples < 3 ? '· ⚠️ thin (backfill will fill)' : '✓'}`,
    tok.runner ? '🏃 <b>RAN (2x+)</b>' : '',
    paper ? `📒 Paper: ${paper.status} · peak ${mult(paper.peakMult)}${paper.achievedMult ? ` · exit ${mult(paper.achievedMult)} (${paper.exitReason})` : ''}` : '📒 Paper: not opened',
  ];
  if (analysis) {
    L.push('', '🔬 <b>LLM analysis</b>',
      `Quality ${esc(analysis.result?.website_quality || '?')} · matches desc: ${analysis.result?.website_matches_description ? '✅' : '❌'} · conf ${pct(analysis.result?.confidence)}`,
      esc(String(analysis.result?.project_summary || '').slice(0, 400)));
  } else {
    L.push('', `<b>Analysis:</b> ${cand.analysisStatus}`);
  }
  return { ok: true, text: L.filter((x) => x !== '').join('\n'), keyboard: candidateKeyboard(cand) };
}

export async function buildTopRows(limit = 25) {
  const cands = await coll.candidates.find({ score: { $exists: true }, status: { $ne: 'ignored' } })
    .sort({ score: -1 }).limit(limit * 3).toArray();

 if (!cands.length) return [];  

  // Batch-fetch tokens and paper trades in parallel
  const keys = cands.map((c) => ({ chainId: c.chainId, tokenAddress: c.tokenAddress }));
const [toks, papers] = keys.length ? await Promise.all([
  coll.tokens.find({ $or: keys }, { projection: { chainId: 1, tokenAddress: 1, peakMultiple: 1, runner: 1 } }).toArray(),
  coll.paperTrades.find({ $or: keys }, { projection: { chainId: 1, tokenAddress: 1, achievedMult: 1, status: 1 } }).toArray(),
]) : [[], []];
  const tokMap = new Map(toks.map((t) => [`${t.chainId}:${t.tokenAddress}`, t]));
  const paperMap = new Map(papers.map((p) => [`${p.chainId}:${p.tokenAddress}`, p]));

  const rows = [];
  for (const c of cands) {
    if (rows.length >= limit) break;
    const k = `${c.chainId}:${c.tokenAddress}`;
    const tok = tokMap.get(k) || {};
    const paper = paperMap.get(k);
    rows.push({ ...c, peakMultiple: tok.peakMultiple ?? null, runner: !!tok.runner, paperExit: paper?.achievedMult ?? null });
  }
  return rows;
}

export async function topTokensText() {
  const rows = await buildTopRows(10);
  if (!rows.length) return '🏆 No scored candidates yet — model + scores still warming up.';
  return ['🏆 <b>TOP MODEL PICKS</b>', '',
    ...rows.map((r, i) =>
      `${i + 1}. <b>${pct(r.score)}</b> ${esc(shortCa(r.tokenAddress))} (${esc(r.chainId)}) · peak ${mult(r.peakMultiple)}${r.runner ? ' 🏃' : ''}${r.paperExit ? ` · paper ${mult(r.paperExit)}` : ''}`)].join('\n');
}

export async function systemStatusText(queueCounts) {
  const [cands, samples24, runners, paperOpen] = await Promise.all([
    coll.candidates.countDocuments({}),
    coll.samples.countDocuments({ t: { $gte: new Date(Date.now() - 864e5) } }),
    coll.tokens.countDocuments({ runner: true }),
    coll.paperTrades.countDocuments({ status: 'open' }),
  ]);
  const m = loadModel();
  const mt = await coll.config.findOne({ _id: 'maintenance' });
  return [
    '📊 <b>SYSTEM STATUS</b>', '',
    `Candidates: ${cands} · samples/24h: ${samples24} · runners: ${runners} · paper open: ${paperOpen}`,
    `Scrape queue: wait ${queueCounts?.scrape?.waiting ?? 0} · active ${queueCounts?.scrape?.active ?? 0} · dead ${queueCounts?.scrape?.failed ?? 0}`,
    `Model: ${m ? `✓ AUC ${Number(m.meta.walk_forward_auc).toFixed(3)}, ${m.meta.rows} rows, trained ${String(m.meta.trained_at).slice(0, 10)}` : 'not yet (gates: 200 rows / 20 runners)'}`,
    `Maintenance: last run ${ago(mt?.lastRunAt)}${mt?.lastResult ? ` · backfilled ${mt.lastResult.tokensBackfilled || 0}, rescored ${mt.lastResult.rescored || 0}` : ''}`,
  ].join('\n');
}