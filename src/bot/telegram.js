import { config } from '../config.js';
import { coll } from '../db.js';
import { log } from '../lib/logger.js';
import { sleep } from '../lib/util.js';
import { normalizeTokenAddress } from '../normalize.js';
import { TelegramProvider } from '../services/notifier/telegram.js';
import { requestAnalysis } from '../services/analysis.js';
import { fullReport, topTokensText, systemStatusText } from '../services/report.js';
import { scrapeQueue } from '../queues.js';

async function safeAnswer(id, text, alert = false) {
  try { await TelegramProvider.answerCallback(id, text, alert); }
  catch (e) { if (!/query is too old/i.test(e.message)) throw e; }
}

async function loadOffset() {
  const doc = await coll.config.findOne({ _id: 'bot_offset' });
  return doc ? Number(doc.offset) : 0;
}

async function saveOffset(offset) {
  await coll.config.updateOne({ _id: 'bot_offset' }, { $set: { offset } }, { upsert: true });
}

export function startBot() {
  if (!config.telegram.token) { log.warn('[bot] TELEGRAM_BOT_TOKEN not set — bot disabled'); return () => {}; }
  log.info('[bot] long-polling started');
  let stopped = false;

  (async () => {
    let offset = await loadOffset();
    while (!stopped) {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${config.telegram.token}/getUpdates?timeout=25&offset=${offset}` +
          `&allowed_updates=${encodeURIComponent(JSON.stringify(['message', 'callback_query']))}`,
          { signal: AbortSignal.timeout(35000) });
        const data = await res.json().catch(() => ({}));
        if (!data.ok) { if (/conflict/i.test(data.description || '')) log.warn('[bot] 409: duplicate consumer'); await sleep(5000); continue; }
        for (const u of data.result || []) {
          offset = u.update_id + 1;
          handleUpdate(u).catch((e) => log.error('[bot]', e.message));
        }
        if (data.result?.length) await saveOffset(offset);
      } catch (err) { log.warn('[bot] poll error:', err.message); await sleep(3000); }
    }
  })();

  return () => { stopped = true; };
}

async function handleUpdate(u) {
  if (u.callback_query) {
    const cq = u.callback_query;
    const [action, chainId, tokenAddress] = String(cq.data || '').split(':');
    if (action === 'analyze') {
      try {
        const r = await requestAnalysis(chainId, tokenAddress);
        await safeAnswer(cq.id, r.status === 'queued' ? '🔎 Analysis queued' : `Analysis ${r.status}`);
      } catch (err) { await safeAnswer(cq.id, `⚠️ ${err.message}`.slice(0, 190), true); }
    } else if (action === 'ignore') {
      await coll.candidates.updateOne({ chainId, tokenAddress }, { $set: { status: 'ignored' } });
      await safeAnswer(cq.id, 'Ignored');
    }
    return;
  }

  const text = String(u.message?.text || '').trim();
  const chatId = u.message?.chat?.id;
  if (!chatId || !text.startsWith('/')) return;
  const [cmd, ...args] = text.split(/\s+/);

  if (cmd === '/start') {
    await TelegramProvider.send({ chatId, text:
      '🤖 <b>Token Radar online.</b>\n\nCandidates arrive here with 🔍 ANALYZE buttons.\n\n<b>Commands:</b>\n/info &lt;CA&gt; [chain] — full report on any tracked token\n/top — top model picks with outcomes\n/predictions — live runner probability ladder\n/momentum — momentum entry signals (40-100 bucket)\n/status — system health + model state' });
  } else if (cmd === '/info') {
    if (!args.length) { await TelegramProvider.send({ chatId, text: 'Usage: /info 0xabc…  (optionally: /info solana 5nSWB…)' }); return; }
    let chainId = null, addr = args[0];
    if (args.length >= 2) { chainId = args[0].toLowerCase(); addr = args[1]; }
    addr = normalizeTokenAddress(chainId || 'evm', addr);
    const q = { tokenAddress: addr, ...(chainId ? { chainId } : {}) };
    const cand = await coll.candidates.findOne(q, { sort: { createdAt: -1 } });
    if (!cand) { await TelegramProvider.send({ chatId, text: '❌ Not found in tracked candidates.' }); return; }
    const r = await fullReport(cand.chainId, cand.tokenAddress);
    await TelegramProvider.send({ chatId, text: r.text, keyboard: r.keyboard });
  } else if (cmd === '/top') {
    await TelegramProvider.send({ chatId, text: await topTokensText() });
  } else if (cmd === '/status') {
    const qc = await scrapeQueue.getJobCounts('waiting', 'active', 'failed');
    await TelegramProvider.send({ chatId, text: await systemStatusText({ scrape: qc }) });
  } else if (cmd === '/predictions') {
    // Show top runner predictions from the live ladder
    try {
      const data = await fetch(`${config.apiUrl || 'http://localhost:8080'}/api/predictions/live?limit=20`)
        .then(r => r.json());
      if (!data.rankings || !data.rankings.length) {
        await TelegramProvider.send({ chatId, text: '📭 No active predictions in the ladder right now.' });
        return;
      }
      const lines = ['🔮 <b>TOP RUNNER PREDICTIONS</b>', ''];
      data.rankings.slice(0, 15).forEach((r, i) => {
        const probPct = Math.round(r.probability * 100);
        const mult = r.current_multiple ? r.current_multiple.toFixed(2) + 'x' : '—';
        const sigs = (r.signals || []).join(', ') || '—';
        lines.push(`${i + 1}. <b>${r.chainId}:${r.tokenAddress.slice(0, 8)}…</b> — ${probPct}% | ${mult} | ${sigs}`);
      });
      lines.push('', `<b>Model accuracy:</b> ${(data.stats?.accuracy * 100 || 0).toFixed(0)}%`);
      await TelegramProvider.send({ chatId, text: lines.join('\n') });
    } catch (err) {
      await TelegramProvider.send({ chatId, text: `⚠️ Failed to fetch predictions: ${err.message}` });
    }
  } else if (cmd === '/momentum') {
    // Show Momentum Entry Monitor signals — tokens in 40-100 bucket crossing 1.3x threshold
    try {
      const multThreshold = 1.3;
      const buckets = ['40-60', '60-80', '80-100'];
      let allItems = [];
      for (const bucket of buckets) {
        const resp = await fetch(`${config.apiUrl || 'http://localhost:8080'}/api/bucket-candidates/${bucket}?limit=50`)
          .then(r => r.json());
        if (resp.items) allItems = allItems.concat(resp.items);
      }
      // Filter: non-runner tokens that crossed the mult threshold
      const signals = allItems.filter(r => {
        if (r.runner === true) return false;
        const currentMult = r.baselineUsd > 0 ? r.peakUsd / r.baselineUsd : 0;
        return currentMult >= multThreshold;
      }).sort((a, b) => (b.probability || 0) - (a.probability || 0)).slice(0, 10);

      if (!signals.length) {
        await TelegramProvider.send({ chatId, text: '📭 No momentum entry signals in 40-100 bucket right now.' });
        return;
      }
      const lines = ['🎯 <b>MOMENTUM ENTRY MONITOR (40-100)</b>', ''];
      signals.forEach((r, i) => {
        const prob = r.probability ? Math.round(r.probability * 100) + '%' : '—';
        const currentMult = r.baselineUsd > 0 ? (r.peakUsd / r.baselineUsd).toFixed(2) + 'x' : '—';
        const peakMult = r.peakMultiple ? r.peakMultiple.toFixed(2) + 'x' : '—';
        const sigs = (r.signals || []).join(', ') || '—';
        lines.push(`${i + 1}. <b>${r.chainId}:${r.tokenAddress.slice(0, 8)}…</b> — ${prob} | Current: ${currentMult} | Peak: ${peakMult} | ${sigs}`);
      });
      lines.push('', `<b>Threshold:</b> ${multThreshold.toFixed(1)}x | <b>Buckets:</b> ${buckets.join(', ')}`);
      await TelegramProvider.send({ chatId, text: lines.join('\n') });
    } catch (err) {
      await TelegramProvider.send({ chatId, text: `⚠️ Failed to fetch momentum: ${err.message}` });
    }
  }
}
