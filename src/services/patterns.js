import { config } from '../config.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { CircuitBreaker } from '../lib/util.js';

const limiter = new RateLimiter(config.llm.rpm, 60_000, 'llm-patterns');
const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 120000, timeoutMs: config.llm.timeoutMs });

export async function runPatternNarrative(summary) {
  const compact = {
    window_hours: summary.windowHours, candidates: summary.candidates, tracked: summary.tracked, runners: summary.runners,
    runner_rate_pct: summary.runnerRatePct,
    time_to_peak_minutes_median: summary.timeToPeakMin.median,
    peak_multiple_median: summary.peakMultiple.median, peak_multiple_max: summary.peakMultiple.max,
    first_seen_by_utc_hour: summary.seenByHourUTC.map((h, i) => `${i}h: ${h.seen} seen / ${h.runners} runners`),
    peak_by_utc_hour: summary.peakByHourUTC.map((n, i) => `${i}h: ${n}`),
    signal_correlation: summary.signals,
    chains: summary.chains,
  };
  await limiter.take();
  return cb.fire(async () => {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({
        model: config.llm.model, temperature: 0.3,
        messages: [
          { role: 'system', content: 'You are a crypto market data analyst. You receive aggregate statistics about candidate tokens tracked over time, some of which became "runners" (2x+ from baseline). Describe the patterns: what runners have in common, timing patterns (UTC hours), signal correlations, chain effects. Cite specific numbers. Keep under 350 words. Distinguish correlation from causation, and flag small sample sizes honestly. Plain text, no JSON.' },
          { role: 'user', content: JSON.stringify(compact) },
        ],
      }),
      signal: AbortSignal.timeout(config.llm.timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`LLM http ${res.status}`);
    return data.choices?.[0]?.message?.content || '';
  });
}
