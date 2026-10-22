import { shortCa } from '../../normalize.js';

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function secBadge(f) {
  if (!f) return '';
  if (f.sec_unknown) return ' · sec: n/a';
  if (f.honeypot) return ' · 🚩 <b>HONEYPOT</b>';
  return f.mintable ? ' · ⚠️ mintable' : ' · sec ✓';
}
function scoreBadge(c) {
  return c.score != null ? `\n<b>ML score:</b> ${Math.round(c.score * 100)}% (${esc(c.scoreBucket || '')})` : '';
}

export function candidateMessage(c) {
  const lines = [
    '🚨 <b>NEW TOKEN CANDIDATE</b>', '',
    `<b>Chain:</b> ${esc(c.chainId)}`,
    `<b>CA:</b> <code>${esc(c.tokenAddress)}</code>`,
    `<b>Website:</b> ${esc(c.websiteUrl)}`,
  ];
  if (c.description) lines.push(`<b>Description:</b> ${esc(String(c.description).slice(0, 300))}`);
  lines.push(`<b>Matched signals:</b> ${(c.matchedSignals || []).map((s) => `✓ ${esc(s)}`).join(', ')}`);
  lines.push(scoreBadge(c) + secBadge(c.features));
  const linkMatches = (c.matches || []).filter((m) => m.type === 'link' && m.url).slice(0, 5);
  if (linkMatches.length) { lines.push('<b>Detected links:</b>'); for (const m of linkMatches) lines.push(`• ${esc(m.signal)}: ${esc(m.url)}`); }
  lines.push(`<b>Found:</b> ${new Date(c.createdAt || Date.now()).toISOString().slice(11, 19)} UTC`, '<b>Status:</b> UNANALYZED');
  return lines.join('\n');
}

export function candidateKeyboard(c) {
  return [
    [{ text: `🔍 ${shortCa(c.tokenAddress)} ANALYZE`, callback_data: `analyze:${c.chainId}:${c.tokenAddress}` }],
    [
      { text: '🌐 Website', url: c.websiteUrl },
      { text: '📈 DexScreener', url: c.dexUrl || `https://dexscreener.com/${c.chainId}/${c.tokenAddress}` },
    ],
    [{ text: '❌ Ignore', callback_data: `ignore:${c.chainId}:${c.tokenAddress}` }],
  ];
}

export function analysisMessage(a, c, tok = {}) {
  const r = a.result || {};
  const bullets = (arr, max = 5) => (Array.isArray(arr) ? arr.slice(0, max) : []).map((x) => `• ${esc(String(x).slice(0, 220))}`);
  const lines = [
    '🔬 <b>CA ANALYSIS COMPLETE</b>', '',
    `<b>CA:</b> <code>${esc(c.tokenAddress)}</code> (${esc(c.chainId)})`,
    `<b>Website:</b> ${esc(c.websiteUrl)}`,
    scoreBadge(c) + secBadge(c.features),
    tok.peakMultiple != null ? `<b>Tracking:</b> peak ${Number(tok.peakMultiple).toFixed(2)}x${tok.runner ? ' · 🏃 RAN' : ''}` : '',
    '', `<b>Quality:</b> ${esc(r.website_quality || '?')} · <b>Matches description:</b> ${r.website_matches_description ? 'yes ✅' : 'no ❌'} · <b>Confidence:</b> ${Math.round((Number(r.confidence) || 0) * 100)}%`,
    '', `<b>Summary:</b> ${esc(String(r.project_summary || '').slice(0, 700))}`,
  ];
  const section = (title, items) => { const b = bullets(items); if (b.length) lines.push('', `<b>${title}</b>`, ...b); };
  section('✅ Positive', r.positive_signals);
  section('⚠️ Negative', r.negative_signals);
  section('🧩 Cheap-generation indicators', r.cheap_generation_indicators);
  section('❗ Contradictions', r.contradictions);
  section('🛠 Technical evidence', r.technical_evidence);
  section('🧭 What to check next', r.what_to_check_next);
  if (r.overall_assessment) lines.push('', `<b>Overall:</b> ${esc(String(r.overall_assessment).slice(0, 800))}`);
  return lines.filter((l) => l !== '').join('\n');
}

export function runnerMessage(c) {
  return [
    '🏃 <b>RUNNER ALERT</b>', '',
    `<b>CA:</b> <code>${esc(c.tokenAddress)}</code> (${esc(c.chainId)})`,
    `<b>Website:</b> ${esc(c.websiteUrl || '—')}`,
    `<b>Peak:</b> ${Number(c.peakMultiple || 1).toFixed(1)}x from baseline`,
    scoreBadge(c),
    `<b>Signals:</b> ${(c.matchedSignals || []).map(esc).join(', ') || '—'}`,
  ].join('\n');
}

export function runnerKeyboard(c) {
  const dexUrl = c.dexUrl || `https://dexscreener.com/${c.chainId}/${c.tokenAddress}`;
  return [
    [{ text: `🔍 ${shortCa(c.tokenAddress)} ANALYZE`, callback_data: `analyze:${c.chainId}:${c.tokenAddress}` }],
    [
      { text: '🌐 Website', url: c.websiteUrl || `https://dexscreener.com/${c.chainId}/${c.tokenAddress}` },
      { text: '📈 DexScreener', url: dexUrl },
    ],
    [{ text: '❌ Ignore', callback_data: `ignore:${c.chainId}:${c.tokenAddress}` }],
  ];
}

/**
 * Momentum Entry Monitor alert — fired when a token in the 40-100 bucket
 * crosses the momentum threshold (default 1.3x current multiple).
 */
export function momentumEntryMessage(r, multThreshold) {
  const currentMult = Number(r.current_multiple || r.currentMult || 1);
  const peakMult = Number(r.peak_multiple || r.peakMult || currentMult);
  const prob = r.probability || r.combinedScore || r.baseScore || 0;
  return [
    '🎯 <b>MOMENTUM ENTRY SIGNAL</b>', '',
    `<b>CA:</b> <code>${esc(r.tokenAddress)}</code> (${esc(r.chainId)})`,
    `<b>Website:</b> ${esc(r.websiteUrl || '—')}`,
    `<b>Probability:</b> ${(prob * 100).toFixed(1)}%`,
    `<b>Current:</b> ${currentMult.toFixed(2)}x · <b>Peak:</b> ${peakMult.toFixed(2)}x`,
    `<b>Threshold:</b> ${multThreshold.toFixed(1)}x crossed`,
    `<b>Signals:</b> ${(r.signals || r.matchedSignals || []).map(esc).join(', ') || '—'}`,
    '', `<b>Bucket:</b> ${esc(r.scoreBucket || r.bucket || '?')} · <b>Score:</b> ${(r.score || 0).toFixed(3)}`, '',
    `📊 <b>Action:</b> Token in 40-100 bucket crossed ${multThreshold.toFixed(1)}x multiple threshold`,
  ].join('\n');
}

export function momentumEntryKeyboard(r) {
  const dexUrl = `https://dexscreener.com/${r.chainId}/${r.tokenAddress}`;
  return [
    [{ text: `🔍 ${shortCa(r.tokenAddress)} ANALYZE`, callback_data: `analyze:${r.chainId}:${r.tokenAddress}` }],
    [
      { text: '🌐 Website', url: r.websiteUrl || dexUrl },
      { text: '📈 DexScreener', url: dexUrl },
    ],
    [{ text: '❌ Ignore', callback_data: `ignore:${r.chainId}:${r.tokenAddress}` }],
  ];
}