import { config } from '../config.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { CircuitBreaker } from '../lib/util.js';

const limiter = new RateLimiter(config.llm.rpm, 60_000, 'llm-feats');
const cb = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 60000, timeoutMs: 60000 });
const SYS = `You assess crypto token websites from title/description/visible text. Return ONLY JSON:
{"templatedness":0-10,"product_evidence":0-10,"specificity":0-10,"contradictions":0-10}
templatedness: how template-made/generic (10 = obvious clone). product_evidence: signs of an actual product (10 = concrete working product). specificity: unique concrete details vs vague buzzwords. contradictions: placeholders, inconsistencies, broken claims.`;

export async function fetchLlmFeatures({ title, description, websiteText }) {
  await limiter.take();
  return cb.fire(async () => {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({
        model: config.llm.model, temperature: 0, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYS },
          { role: 'user', content: `TITLE: ${title || ''}\nDESCRIPTION: ${String(description || '').slice(0, 500)}\nTEXT:\n${String(websiteText || '').slice(0, config.llm.maxTextChars / 2)}` },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`LLM http ${res.status}`);
    const raw = JSON.parse(String(d.choices?.[0]?.message?.content || '{}').replace(/^```json|```$/g, '').trim());
    const c = (v) => Math.max(0, Math.min(10, Number(v) || 0)) / 10;
    return { llm_done: 1, llm_templated01: c(raw.templatedness), llm_product01: c(raw.product_evidence), llm_specificity01: c(raw.specificity), llm_contra01: c(raw.contradictions) };
  });
}