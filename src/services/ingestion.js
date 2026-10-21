import WebSocket from 'ws';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

const UA = 'Mozilla/5.0 (compatible; TokenRadar/0.2)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollOnce(onEvent) {
  const res = await fetch(config.dexscreener.profilesUrl, {
    headers: { accept: 'application/json', 'user-agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`dexscreener http ${res.status}`);
  const data = await res.json();
  const items = Array.isArray(data) ? data : data?.data || [];
  for (const item of items) await onEvent(item);
  return items.length;
}

function startPolling(onEvent) {
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const n = await pollOnce(onEvent);
        log.debug(`[ingest:poll] ${n} profiles`);
      } catch (err) {
        log.warn('[ingest:poll] failed:', err.message);
      }
      await sleep(config.dexscreener.pollIntervalMs);
    }
  })();
  return () => { stopped = true; };
}

function startWebSocket(onEvent) {
  let ws, stopped = false, attempts = 0, staleTimer = null;

  const touch = () => {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      log.warn('[ingest:ws] no messages for a while, reconnecting');
      try { ws?.terminate(); } catch {}
    }, config.dexscreener.wsStaleMs);
  };

  const extract = (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }
    const items = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [data];
    for (const item of items) {
      if (item?.baseToken?.address) {
        onEvent({ chainId: item.chainId, tokenAddress: item.baseToken.address, url: item.url });
      } else if (item?.tokenAddress && item?.chainId) {
        onEvent(item);
      }
    }
  };

  const connect = () => {
    if (stopped || !config.dexscreener.wsUrl) return;
    attempts++;
    const backoff = Math.min(30000, 1000 * 2 ** Math.min(attempts, 5));
    try {
      ws = new WebSocket(config.dexscreener.wsUrl, { headers: { 'user-agent': UA } });
    } catch (err) {
      log.error('[ingest:ws] connect error:', err.message);
      return setTimeout(connect, backoff);
    }
    ws.on('open', () => { attempts = 0; log.info('[ingest:ws] connected:', config.dexscreener.wsUrl); touch(); });
    ws.on('message', (m) => { touch(); extract(m.toString()); });
    ws.on('error', (err) => log.warn('[ingest:ws] error:', err.message));
    ws.on('close', () => { if (!stopped) setTimeout(connect, backoff); });
  };

  connect();
  return () => { stopped = true; clearTimeout(staleTimer); try { ws?.terminate(); } catch {} };
}

export function startIngestion(onEvent) {
  if (config.dexscreener.transport === 'ws' && config.dexscreener.wsUrl) {
    return startWebSocket(onEvent);
  }
  log.info(`[ingest] polling ${config.dexscreener.profilesUrl} every ${config.dexscreener.pollIntervalMs}ms`);
  return startPolling(onEvent);
}