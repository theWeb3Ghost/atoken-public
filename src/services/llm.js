import { config } from '../config.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { CircuitBreaker } from '../lib/util.js';

const limiter = new RateLimiter(config.llm.rpm, 60_000, 'llm-analysis');
const cb = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 60000, timeoutMs: config.llm.timeoutMs });

const SYSTEM_PROMPT = `You are a meticulous crypto token/project research analyst.
You receive structured evidence about a token: its DexScreener description, website title and meta description, the signals that triggered, detected links, and the visible text of its homepage.

Investigate:
1. Does the website actually explain what the token/project claims to be?
2. Does the website content match the DexScreener description?
3. Does the website appear cheaply generated or templated?
4. Are there quirks, contradictions, placeholders, broken sections, copied text, or unusual claims?
5. Is there meaningful project information, technical/product information, or documentation?
6. Is there evidence someone actually built a product?
7. Any suspicious or inconsistent information?
8. Signs of a low-effort launch vs. signs of a serious project?
9. What claims are verifiable from the supplied evidence alone?
10. What remains unknown?

Hard rules:
- A polished website does NOT imply a legitimate project, and a simple website does NOT imply fraud. Report evidence, not vibes.
- Separate direct evidence from speculation. Never invent facts not present in the evidence.
- Respond with ONLY a valid JSON object (no markdown fences) with exactly these keys:
{"project_summary": string, "website_matches_description": boolean, "website_quality": "low"|"medium"|"high", "positive_signals": string[], "negative_signals": string[], "cheap_generation_indicators": string[], "quirks": string[], "contradictions": string[], "technical_evidence": string[], "confidence": number, "overall_assessment": string, "what_to_check_next": string[]}
- "confidence" is 0..1, your confidence in the assessment given the evidence.`;

const clip = (s, n) => {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n)} …[truncated ${s.length - n} chars]` : s;
};

export function buildEvidencePrompt(cand) {
  const parts = [];
  parts.push(`TOKEN\nChain: ${cand.chainId}\nContract address: ${cand.tokenAddress}`);
  parts.push(`DEXSCREENER DESCRIPTION:\n${clip(cand.description || '(none)', 2000)}`);
  parts.push(`WEBSITE URL: ${cand.websiteUrl}\nPAGE TITLE: ${cand.title || '(none)'}`);
  parts.push(`DETECTED SIGNALS: ${(cand.matchedSignals || []).join(', ') || '(none)'}`);
  parts.push(`DETECTED LINKS:\n${(cand.matchedLinks || []).slice(0, 20).map((u) => `- ${u}`).join('\n') || '(none)'}`);
  parts.push(`SIGNAL MATCHES:\n${(cand.matches || []).slice(0, 20).map((m) => `[${m.type}] ${m.signal}: ${m.text}${m.url ? ' → ' + m.url : ''}`).join('\n')}`);
  parts.push(`WEBSITE VISIBLE TEXT (may be truncated):\n"""\n${clip(cand.websiteText || '(empty)', config.llm.maxTextChars)}\n"""`);
  return parts.join('\n\n');
}

function parseJsonLoose(s) {
  s = String(s).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error('LLM returned non-JSON output');
}

export async function runLlmAnalysis(cand) {
  if (!config.llm.apiKey) throw new Error('LLM_API_KEY not configured');
  await limiter.take();

  return cb.fire(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.llm.timeoutMs);
    try {
      const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.llm.apiKey}` },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: config.llm.model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildEvidencePrompt(cand) },
          ],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`LLM http ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
      const content = data.choices?.[0]?.message?.content || '';
      return parseJsonLoose(content);
    } finally {
      clearTimeout(timer);
    }
  });
}