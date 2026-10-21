import { coll } from '../db.js';
import { metrics } from '../lib/metrics.js';
import { extractFeatures } from './features.js';
import { scoreFeatures } from './score.js';
import { llmFeatQueue } from '../queues.js';

export async function createCandidateFromScan({ chainId, tokenAddress, websiteUrl, dexUrl, description, scan, match, sec = null }) {
  const doc = {
    chainId, tokenAddress, websiteUrl, dexUrl, description: description || '',
    matchedSignals: [...new Set(match.matches.map((m) => m.signal))],
    matchedLinks: match.matches.filter((m) => m.type === 'link' && m.url).map((m) => m.url),
    matches: match.matches, title: scan.title, websiteText: scan.bodyText,
    scrapedAt: scan.scrapedAt,
    scan: { url: scan.url, finalUrl: scan.finalUrl, status: scan.status, responseTimeMs: scan.responseTimeMs },
  };
  // features frozen at creation (no lookahead); LLM features arrive async via llmfeat worker
  const features = extractFeatures({
    chainId, tokenAddress, websiteUrl, description,
    matchedSignals: doc.matchedSignals, matchedLinks: doc.matchedLinks,
    websiteText: scan.bodyText, createdAt: new Date(), sec,
  });
  const s = scoreFeatures(features);

  // Upsert: create if new, update key fields if rescanned
  const set = {
    websiteUrl, dexUrl, description: description || '',
    matchedSignals: doc.matchedSignals,
    matchedLinks: doc.matchedLinks,
    matches: match.matches,
    title: scan.title,
    websiteText: scan.bodyText,
    scrapedAt: scan.scrapedAt,
    scan: { url: scan.url, finalUrl: scan.finalUrl, status: scan.status, responseTimeMs: scan.responseTimeMs },
  };
  for (const [k, v] of Object.entries(features)) set[`features.${k}`] = v;
  if (s) { set.score = s.p; set.scoreBucket = s.bucket; set.scoredAt = new Date(); }

  const update = {
    $set: set,
    $setOnInsert: {
      notificationStatus: false,
      analysisStatus: 'not_analyzed',
      status: 'candidate',
      createdAt: new Date(),
    },
  };

  await coll.candidates.updateOne({ chainId, tokenAddress }, update, { upsert: true });
  await coll.tokens.updateOne({ chainId, tokenAddress }, { $set: { status: 'candidate' } });
  metrics.inc('matched');
  llmFeatQueue.add('llmfeat', { chainId, tokenAddress }, { jobId: `llmf__${chainId}__${tokenAddress}` }).catch(() => {});
  return doc;
}
