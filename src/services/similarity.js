import { coll } from '../db.js';
import { FEATURE_NAMES } from './features.js';

// --- augmented feature extraction (beyond ML features) ---

const TEMPLATE_PHRASES = /lorem ipsum|coming soon|under construction|building in public|launching soon|whitepaper coming|audited by|powered by/i;
const SOCIAL_HOSTS = { twitter: /x\.com|twitter\.com/, tiktok: /tiktok\.com/, telegram: /t\.me|telegram\.(me|org)/, discord: /discord\.(gg|com)/, github: /github\.com/, medium: /medium\.com/, reddit: /reddit\.com/, youtube: /youtube\.com|youtu\.be/, instagram: /instagram\.com/ };

function safeNum(v, d = 0) { return Number(v) || d; }

export function extractRunnerFeatures(cand, tok = null) {
  const f = {};
  const feats = cand.features || {};
  // copy existing ML features
  for (const name of FEATURE_NAMES) f[name] = feats?.[name] ?? 0;

  const desc = String(cand.description || '');
  f.desc_len = desc.length;
  f.desc_words = desc.split(/\s+/).filter(Boolean).length;
  f.desc_caps_ratio = desc.length > 0 ? (desc.match(/[A-Z]/g) || []).length / desc.length : 0;
  f.desc_has_emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(desc) ? 1 : 0;

  const wt = String(cand.websiteText || '');
  f.website_text_len = wt.length;
  f.website_words = wt.split(/\s+/).filter(Boolean).length;
  f.website_has_template = TEMPLATE_PHRASES.test(wt) ? 1 : 0;

  // name/symbol from metadata or description heuristics
  const meta = cand.metadata || {};
  const name = String(meta.name || '');
  f.name_len = name.length;
  f.name_has_number = /\d/.test(name) ? 1 : 0;
  f.name_has_emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(name) ? 1 : 0;
  const sym = String(meta.symbol || '');
  f.symbol_len = sym.length;
  f.symbol_all_caps = /^[A-Z]{2,10}$/.test(sym) ? 1 : 0;

  // link analysis
  const links = cand.matchedLinks || [];
  f.n_links = links.length;
  f.n_social_links = links.filter((u) => Object.values(SOCIAL_HOSTS).some((r) => r.test(u))).length;
  f.has_github = links.some((u) => SOCIAL_HOSTS.github.test(u)) ? 1 : 0;
  f.has_docs_link = links.some((u) => /gitbook|docs\./i.test(u)) ? 1 : 0;
  f.has_telegram = links.some((u) => SOCIAL_HOSTS.telegram.test(u)) ? 1 : 0;

  // url analysis
  try {
    const u = new URL(cand.websiteUrl);
    f.url_domain_len = u.hostname.length;
    f.url_has_subdomain = u.hostname.split('.').length > 2 ? 1 : 0;
  } catch {
    f.url_domain_len = 0;
    f.url_has_subdomain = 0;
  }

  // timing
  const d = new Date(cand.createdAt || Date.now());
  f.utc_hour = d.getUTCHours();
  f.utc_dow = d.getUTCDay();

  // price trajectory (from token doc)
  f.peak_multiple = safeNum(tok?.peakMultiple);
  f.ttp_min = safeNum(tok?.timeToPeakMin);

  return f;
}

// --- binary feature discretization for coverage analysis ---

function discretizeFeature(name, value) {
  // known numeric features → turn into binary presence flags
  if (['peak_multiple', 'ttp_min', 'url_domain_len'].includes(name)) {
    if (name === 'peak_multiple') return { key: `${name}>2`, val: value > 2 ? 1 : 0 };
    if (name === 'ttp_min') return { key: `${name}$<30`, val: value < 30 ? 1 : 0 };
    if (name === 'url_domain_len') return { key: `${name}>15`, val: value > 15 ? 1 : 0 };
  }
  if (['desc_len', 'desc_words', 'website_text_len', 'website_words', 'name_len', 'symbol_len', 'n_links', 'n_social_links'].includes(name)) {
    return { key: `${name}>med`, val: value > (name === 'name_len' ? 8 : name === 'symbol_len' ? 4 : name === 'n_links' ? 3 : name === 'n_social_links' ? 1 : 0) ? 1 : 0, raw: value };
  }
  // threshold features already binary or categorical
  return { key: name, val: value > 0 ? 1 : 0, raw: value };
}

// --- corpus building ---

export async function buildRunnerCorpus({ minRunners = 10, maxComparators = 500 } = {}) {
  // 1. fetch all runners
  const runnerTokens = await coll.tokens.find({ runner: true, becameRunnerAt: { $exists: true } })
    .project({ chainId: 1, tokenAddress: 1, peakMultiple: 1, timeToPeakMin: 1, baselineUsd: 1, becameRunnerAt: 1 }).toArray();
  if (runnerTokens.length < minRunners) {
    return { ok: false, reason: `only ${runnerTokens.length} runners (need >= ${minRunners})`, runners: runnerTokens.length };
  }

  const keys = runnerTokens.map((t) => ({ chainId: t.chainId, tokenAddress: t.tokenAddress }));
  const tokMap = new Map(runnerTokens.map((t) => [`${t.chainId}:${t.tokenAddress}`, t]));

  // 2. fetch candidates for these runners
  const runnerCands = await coll.candidates.find({ $or: keys })
    .project({ chainId: 1, tokenAddress: 1, description: 1, websiteUrl: 1, matchedLinks: 1, matchedSignals: 1, websiteText: 1, createdAt: 1, features: 1, metadata: 1 }).toArray();

  // 3. build feature vectors (compute even if features doc is sparse, since extractRunnerFeatures augments from raw fields)
  const vectors = runnerCands
    .map((c) => extractRunnerFeatures(c, tokMap.get(`${c.chainId}:${c.tokenAddress}`)));

  if (!vectors.length) return { ok: false, reason: 'no runners with features', runners: 0 };

  // 4. fetch non-runner candidates (exclude known runners via tokens collection)
  const comparatorCount = Math.min(maxComparators, Math.max(vectors.length * 3, 200));
  const runnerCAs = new Set(runnerTokens.map((t) => `${t.chainId}:${t.tokenAddress}`));

  let nonRunners;
  const hasScore = await coll.candidates.findOne({ score: { $exists: true } }, { projection: { _id: 1 } });
  if (hasScore) {
    // Use scored non-runners for proper comparison
    const scored = await coll.candidates.find({ score: { $exists: true } })
      .sort({ score: -1 }).limit(comparatorCount * 2)
      .project({ description: 1, websiteUrl: 1, matchedLinks: 1, matchedSignals: 1, websiteText: 1, createdAt: 1, features: 1, metadata: 1 }).toArray();
    nonRunners = scored.filter((c) => !runnerCAs.has(`${c.chainId}:${c.tokenAddress}`));
  } else {
    // Fall back to recent non-runner candidates when model untrained
    const recent = await coll.candidates.find({ matchedSignals: { $exists: true } })
      .sort({ createdAt: -1 }).limit(comparatorCount * 2)
      .project({ description: 1, websiteUrl: 1, matchedLinks: 1, matchedSignals: 1, websiteText: 1, createdAt: 1, features: 1, metadata: 1 }).toArray();
    nonRunners = recent.filter((c) => !runnerCAs.has(`${c.chainId}:${c.tokenAddress}`));
  }
  nonRunners = nonRunners.slice(0, comparatorCount);

  const nonVectors = nonRunners.map((c) => extractRunnerFeatures(c, null));

  // 5. compute coverage + lift per feature
  // Exclude self-referential features (being a runner IS having peak>2x)
  const EXCLUDE_FEATURES = ['peak_multiple', 'peak_multiple>2', 'ttp_min', 'ttp_min$<30', 'n_signals'];
  const featureNames = Array.from(new Set([...vectors.map((v) => Object.keys(v)), ...nonVectors.map((v) => Object.keys(v))].flat()))
    .filter((n) => !EXCLUDE_FEATURES.includes(n));
  const nRun = vectors.length, nNon = nonVectors.length;

  const feats = [];
  for (const name of featureNames) {
    // gather values
    const runVals = vectors.map((v) => v[name]);
    const nonVals = nonVectors.map((v) => v[name]);

    // discretize into binary presence
    const runBin = runVals.map((v) => discretizeFeature(name, v));
    const nonBin = nonVals.map((v) => discretizeFeature(name, v));

    const binaryNames = [...new Set([...runBin.map((b) => b.key), ...nonBin.map((b) => b.key)])];
    for (const bn of binaryNames) {
      const rPos = runBin.filter((b) => b.key === bn && b.val === 1).length;
      const nPos = nonBin.filter((b) => b.key === bn && b.val === 1).length;
      const runCov = nRun ? rPos / nRun : 0;
      const nonCov = nNon ? nPos / nNon : 0;
      const lift = nonCov > 0 ? runCov / nonCov : runCov > 0 ? 999 : 0;
      // simple directional label
      let direction = 'neutral';
      if (lift > 1.5) direction = 'runner-favored';
      else if (lift < 0.5) direction = 'non-runner-favored';

      if (rPos > 0) {
        feats.push({
          feature: bn,
          runners_pct: Math.round(runCov * 100),
          non_runners_pct: Math.round(nonCov * 100),
          lift: Math.round(lift * 100) / 100,
          direction,
          n_runners: rPos,
          n_total: nRun,
        });
      }
    }
  }

  // sort by coverage descending, then lift descending
  feats.sort((a, b) => b.runners_pct - a.runners_pct || b.lift - a.lift);

  return {
    ok: true,
    runners: nRun,
    non_runners: nNon,
    features: feats,
    generatedAt: new Date().toISOString(),
  };
}

// --- greedy set-cover clustering ---

export async function runnerClusters() {
  const corpus = await buildRunnerCorpus();
  if (!corpus.ok) return corpus;

  const { features, runners } = corpus;
  // take top features for cluster building, weighted by lift × coverage
  // filter: lift > 1.0, present in runners, not near-universal in non-runners (avoids trivial features)
  const topFeats = features.filter((f) => f.lift > 1.0 && f.runners_pct > 0 && f.non_runners_pct < 95)
    .slice(0, 50)
    .sort((a, b) => Math.log(b.lift) * b.runners_pct - Math.log(a.lift) * a.runners_pct);

  // greedy set cover: find minimal trait set covering each pct threshold
  const thresholds = [50, 60, 70, 80, 90];
  const clusters = [];

  // fetch a sample of runner CAs for examples
  const runnerTokens = await coll.tokens.find({ runner: true, becameRunnerAt: { $exists: true } })
    .project({ chainId: 1, tokenAddress: 1 }).limit(100).toArray();

  for (const pct of thresholds) {
    const targetRunners = Math.ceil(runners * pct / 100);
    const chosen = [];
    let estCovered = 0;
    // greedy: pick features sorted by log(lift) × runners_pct, accumulate estimated coverage
    for (const f of [...topFeats].sort((a, b) => Math.log(b.lift) * b.runners_pct - Math.log(a.lift) * a.runners_pct)) {
      if (estCovered >= targetRunners) break;
      const featRunners = Math.ceil(f.runners_pct * runners / 100);
      chosen.push({ feature: f.feature, runners_pct: f.runners_pct, lift: f.lift });
      // approximate marginal coverage: each feature covers featRunners runners,
      // but with overlap. Assume 30% overlap (features are partially correlated)
      const marginal = Math.ceil(featRunners * 0.7);
      estCovered = Math.min(estCovered + marginal, runners);
    }
    clusters.push({
      pct,
      traits: chosen,
      coverage_pct: Math.min(Math.round((estCovered / runners) * 100), 100),
      examples: runnerTokens.slice(0, 3).map((t) => `${t.chainId}:${String(t.tokenAddress).slice(0, 8)}`),
    });
  }

  return { ok: true, corpus, clusters };
}
