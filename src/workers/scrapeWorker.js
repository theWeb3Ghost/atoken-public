import { Worker, QueueEvents, UnrecoverableError } from 'bullmq';
import { config } from '../config.js';
import { coll } from '../db.js';
import { log } from '../lib/logger.js';
import { metrics } from '../lib/metrics.js';
import { createConnection } from '../queues.js';
import { scrapeUrl } from '../services/scraper/index.js';
import { parseWebsite } from '../services/parser.js';
import { getSignalConfig, matchSignals } from '../services/signals.js';
import { fetchSecurity } from '../services/security.js';
import { createCandidateFromScan } from '../services/candidates.js';
import { enqueueNotification } from '../services/notifier/index.js';
import { candidateKeyboard, candidateMessage } from '../services/notifier/format.js';

export function startScrapeWorker() {
  const worker = new Worker('scrape', async (job) => {
    const { chainId, tokenAddress, websiteUrl } = job.data;
    await coll.scrapeJobs.updateOne(
      { jobId: job.id },
      { $set: { status: 'processing', startedAt: new Date() }, $inc: { attempts: 1 } }
    );

    let result;
    try {
      result = await scrapeUrl(websiteUrl);
    } catch (err) {
      await coll.scrapeJobs.updateOne(
        { jobId: job.id },
        { $set: { status: 'retrying', error: String(err.message).slice(0, 500) } }
      );
      if (err.retryable === false) throw new UnrecoverableError(err.message);
      throw err;
    }

    const parsed = parseWebsite(result);
    const cfg = await getSignalConfig();
    const match = matchSignals(parsed, cfg);

    const scanDoc = {
      chainId, tokenAddress,
      url: websiteUrl, finalUrl: result.finalUrl, status: result.status,
      title: parsed.title, metaDescription: parsed.metaDescription,
      matched: match.matched, matches: match.matches,
      bodyText: match.matched ? parsed.bodyText : parsed.bodyText.slice(0, 2000),
      responseTimeMs: result.responseTimeMs, scrapedAt: new Date(),
    };
    await coll.scans.insertOne(scanDoc);
    await coll.scrapeJobs.updateOne({ jobId: job.id }, { $set: { status: 'completed', completedAt: new Date(), error: null } });
    await coll.tokens.updateOne(
      { chainId, tokenAddress },
      { $set: { lastScrapeStatus: match.matched ? 'matched' : 'no_match', lastScrapedAt: scanDoc.scrapedAt } }
    );

    if (match.matched) {
      const token = (await coll.tokens.findOne({ chainId, tokenAddress })) || {};
      const sec = config.sec.enabled ? await fetchSecurity(chainId, tokenAddress) : null;
      const cand = await createCandidateFromScan({
        chainId, tokenAddress, websiteUrl,
        dexUrl: token.dexUrl, description: token.description,
        scan: scanDoc, match, sec,
      });
      // Notification disabled — only momentum entry & runner alerts are sent
      // await enqueueNotification({
      //   dedupeKey: `candidate__${chainId}__${tokenAddress}`,
      //   kind: 'candidate',
      //   chainId, tokenAddress,
      //   text: candidateMessage(cand),
      //   keyboard: candidateKeyboard(cand),
      // });
    } else {
      metrics.inc('notMatched');
    }
    return { matched: match.matched };
  }, {
    connection: createConnection(),
    concurrency: config.scrape.concurrency,
    limiter: { max: config.scrape.rpm, duration: 60_000 },
  });

  const events = new QueueEvents('scrape', { connection: createConnection() });
  events.on('failed', async ({ jobId, failedReason, prev }) => {
    if (prev !== 'active') return;
    metrics.inc('scrapeDead');
    const jobDoc = await coll.scrapeJobs.findOneAndUpdate(
      { jobId },
      { $set: { status: 'dead', error: String(failedReason).slice(500), completedAt: new Date() } },
      { returnDocument: 'before' }
    );
    // Log failure reason for DLQ analysis
    await coll.systemMetrics.insertOne({
      at: new Date(),
      kind: 'scrape_dead_letter',
      chainId: jobDoc?.value?.chainId,
      tokenAddress: jobDoc?.value?.tokenAddress,
      url: jobDoc?.value?.url,
      error: String(failedReason).slice(500),
      attempts: jobDoc?.value?.attempts || 0,
    }).catch(() => {});
    log.warn(`[scrape] dead job ${jobId}: ${failedReason}`);
  });
  worker.on('error', (err) => log.error('[scrape worker]', err.message));
  log.info(`[scrape worker] started (concurrency=${config.scrape.concurrency}, rpm=${config.scrape.rpm})`);
  return { worker, events };
}
