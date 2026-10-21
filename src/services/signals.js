import { coll } from '../db.js';

const DEFAULT_SIGNALS = [
  { name: 'docs', enabled: true, aliases: ['docs', 'documentation', 'developer docs', 'technical documentation', 'whitepaper'] },
  { name: 'privacy', enabled: true, aliases: ['privacy', 'privacy policy'] },
  { name: 'terms', enabled: true, aliases: ['terms', 'terms of service', 'terms and conditions'] },
  { name: 'connect_wallet', enabled: false, aliases: ['connect wallet', 'connectwallet', 'connect web3 wallet', 'connect your wallet'] },
];

let cache = { at: 0, version: -1, signals: [], compiled: [] };
const CACHE_MS = 5000;

export async function seedSignalConfig() {
  await coll.config.updateOne(
    { _id: 'signal_config' },
    { $setOnInsert: { signals: DEFAULT_SIGNALS, updatedAt: new Date() } },
    { upsert: true }
  );
}

export async function getSignalConfig(force = false) {
  const now = Date.now();
  if (!force && now - cache.at < CACHE_MS && cache.version >= 0) return cache;
  const doc = await coll.config.findOne({ _id: 'signal_config' });
  const signals = (doc?.signals || []).map((s) => ({
    name: String(s.name || '').toLowerCase().trim(),
    enabled: s.enabled !== false,
    aliases: (s.aliases || []).map((a) => String(a).toLowerCase().trim()).filter(Boolean),
  })).filter((s) => s.name);
  const version = doc ? new Date(doc.updatedAt || 0).getTime() : 0;
  if (version !== cache.version) cache = { at: now, version, signals, compiled: compile(signals) };
  else cache.at = now;
  return cache;
}

export async function saveSignalConfig(signals) {
  const clean = (Array.isArray(signals) ? signals : []).map((s) => ({
    name: String(s.name || '').toLowerCase().trim(),
    enabled: s.enabled !== false,
    aliases: (Array.isArray(s.aliases) ? s.aliases : String(s.aliases || '').split(','))
      .map((a) => String(a).toLowerCase().trim()).filter(Boolean),
  })).filter((s) => s.name && s.aliases.length);

  // Validate: test that aliases produce valid regexes
  for (const s of clean) {
    for (const alias of s.aliases) {
      try {
        new RegExp(`(?:^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?:[^a-z0-9]|$)`, 'i');
      } catch {
        throw new Error(`invalid alias in signal "${s.name}": "${alias}"`);
      }
    }
  }

  await coll.config.updateOne({ _id: 'signal_config' }, { $set: { signals: clean, updatedAt: new Date() } });
  return clean;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const textRegex = (alias) =>
  new RegExp(`(?:^|[^a-z0-9])${escapeRe(alias).replace(/\s+/g, '\\s+')}(?:[^a-z0-9]|$)`, 'i');
const hrefRegex = (alias) =>
  new RegExp(`(?:^|\\s)${escapeRe(alias).replace(/\s+/g, '[\\s\\-_]*')}(?:\\s|$)`, 'i');

function compile(signals) {
  return signals.filter((s) => s.enabled && s.aliases.length).map((s) => ({
    name: s.name,
    textRes: s.aliases.map(textRegex),
    hrefRes: s.aliases.map(hrefRegex),
  }));
}

export function normalizeForHref(u) {
  let s = String(u || '').toLowerCase();
  try { const url = new URL(u); s = `${url.pathname} ${url.search} ${url.hostname}`; } catch {}
  return s.replace(/[^a-z0-9]+/g, ' ').trim();
}

// ANY configured signal matched → PASS. Scripts/styles are removed by the parser
// BEFORE this runs, so JS/CSS content never counts.
export function matchSignals(parsed, cfgCache) {
  const matches = [];
  const seen = new Set();
  const perSignal = new Map();
  const CAP_TOTAL = 20, CAP_PER_SIGNAL = 3;

  const push = (signal, type, text, url) => {
    const key = `${signal}|${type}|${(text || '').toLowerCase().slice(0, 80)}|${url || ''}`;
    if (seen.has(key)) return;
    const n = perSignal.get(signal) || 0;
    if (n >= CAP_PER_SIGNAL || matches.length >= CAP_TOTAL) return;
    perSignal.set(signal, n + 1);
    seen.add(key);
    matches.push({ signal, type, text: String(text || '').slice(0, 160), ...(url ? { url } : {}) });
  };

  for (const rule of cfgCache.compiled) {
    for (const b of parsed.buttons) {
      if (rule.textRes.some((re) => re.test(b))) { push(rule.name, 'text', b); break; }
    }
    for (const l of parsed.links) {
      const hay = `${l.text} ${l.ariaLabel || ''} ${l.title || ''}`;
      if (hay.trim() && rule.textRes.some((re) => re.test(hay))) {
        push(rule.name, 'link', l.text || l.ariaLabel || l.title, l.href);
        continue;
      }
      const hn = normalizeForHref(l.href);
      if (hn && rule.hrefRes.some((re) => re.test(hn))) {
        push(rule.name, 'link', l.text || l.href, l.href);
      }
    }
    for (const t of [parsed.title, parsed.metaDescription, parsed.bodyText]) {
      if (t && rule.textRes.some((re) => re.test(t))) { push(rule.name, 'text', t.slice(0, 160)); break; }
    }
  }
  return { matched: matches.length > 0, matches };
}