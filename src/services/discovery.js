import { config } from '../config.js';
import { coll } from '../db.js';
import { log } from '../lib/logger.js';
import { metrics } from '../lib/metrics.js';
import { normalizeTokenAddress } from '../normalize.js';
import { scrapeQueue } from '../queues.js';

const SOCIAL_HOSTS = /(twitter\.com|x\.com|t\.me|telegram\.(me|org)|discord\.(gg|com)|medium\.com|github\.com|youtube\.com|instagram\.com|tiktok\.com|reddit\.com)/i;

const safeHttp = (u) => { try { const url = new URL(String(u)); return /^https?:$/.test(url.protocol) ? url.href : null; } catch { return null; } };

/**
 * FAST PATH. Deterministic, no LLM.
 * normalize → dedupe → has website? → backpressure → enqueue scrape job.
 */
export async function handleTokenEvent(raw) {
  metrics.inc('eventsReceived');

  const chainId = String(raw.chainId || '').toLowerCase().trim();
  const tokenAddress = normalizeTokenAddress(chainId, raw.tokenAddress);
  if (!chainId || !tokenAddress) return;

  const links = [];
  let websiteUrl = null;
  for (const l of Array.isArray(raw.links) ? raw.links : []) {
    const url = safeHttp(l.url);
    if (!url) continue;
    const label = String(l.label || l.type || '').toLowerCase();
    links.push({ label, url });
    if (!websiteUrl && /website|\bweb\b|\bsite\b/.test(label) && !SOCIAL_HOSTS.test(new URL(url).hostname)) {
      websiteUrl = url;
    }
  }
  // Fallback: unlabeled non-social link (e.g. custom domain with sloppy labeling).
  // Known trade-off: occasionally picks odd docs (e.g. an SEC filing). Strict mode:
  // delete the next line to only ever scrape explicit `label: Website` links.
  if (!websiteUrl) {
    websiteUrl = links.map((l) => l.url).find((u) => !SOCIAL_HOSTS.test(new URL(u).hostname)) || null;
  }

  if (!websiteUrl) { metrics.inc('noWebsite'); return; }

  const now = new Date();
  const dexUrl = raw.url || `https://dexscreener.com/${chainId}/${tokenAddress}`;
  const description = raw.description || '';
  const filter = { chainId, tokenAddress };

  // Atomic claim: only set scrapeQueuedAt if the token doesn't already have one
  // (or if rescan is due). This prevents concurrent events from both queuing a scrape.
  const cutoff = config.rescanAfterHours > 0 ? new Date(now.getTime() - config.rescanAfterHours * 3600e3) : null;
  const claimFilter = {
    ...filter,
    $or: [
      { scrapeQueuedAt: null },
      { scrapeQueuedAt: { $exists: false } },
      ...(cutoff ? [{ scrapeQueuedAt: { $lte: cutoff } }] : []),
    ],
  };

  let claimed;
  try {
    claimed = await coll.tokens.findOneAndUpdate(
      claimFilter,
      {
        $set: {
          scrapeQueuedAt: now, websiteUrl, description, links, dexUrl, lastSeenAt: now,
          lastScrapeStatus: 'pending',
        },
        $setOnInsert: { firstSeenAt: now, status: 'new' },
      },
      { upsert: true, returnDocument: 'after' }
    );
  } catch (err) {
    if (err.code === 11000) { metrics.inc('duplicates'); return; }
    throw err;
  }
  if (!claimed) { metrics.inc('duplicates'); return; }

  // Don't re-queue if already a candidate (prevents re-processing matched tokens)
  if (claimed.value?.status === 'candidate') { metrics.inc('duplicates'); return; }

  const counts = await scrapeQueue.getJobCounts('waiting', 'delayed');
  if (counts.waiting + counts.delayed >= config.scrape.maxQueueSize) {
    metrics.inc('droppedBackpressure');
    log.warn(`[discovery] queue full (${counts.waiting + counts.delayed} >= ${config.scrape.maxQueueSize}), dropping ${chainId}:${tokenAddress}`);
    return;
  }

  // NOTE: '__' separator — BullMQ forbids ':' in custom job IDs
  const jobId = `${chainId}__${tokenAddress}`;
  const priority = description ? 5 : 10;
  await scrapeQueue.add('scrape', { chainId, tokenAddress, websiteUrl, dexUrl }, { priority, jobId });
  metrics.inc('queued');

  await coll.scrapeJobs.updateOne(
    { jobId },
    {
      $set: { jobId, chainId, tokenAddress, url: websiteUrl, status: 'pending', priority, error: null },
      $setOnInsert: { createdAt: now, attempts: 0 },
    },
    { upsert: true }
  );
  log.info(`[discovery] queued ${jobId} → ${websiteUrl}`);
}
