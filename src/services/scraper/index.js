import { config } from '../../config.js';
import { metrics } from '../../lib/metrics.js';
import { CircuitBreaker } from '../../lib/util.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const directCB = new CircuitBreaker({ failureThreshold: 10, resetTimeoutMs: 30000 });

class ScrapeError extends Error {
  constructor(message, { status = null, retryable = true } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

async function fetchWithTimeout(url, { timeoutMs, headers, signal: externalSignal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('client timeout')), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: externalSignal || ctrl.signal,
      redirect: 'follow',
      headers,
    });
    const html = await res.text();
    return { res, html, responseTimeMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function assertHtml(res) {
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype && !/(text\/html|application\/xhtml|text\/plain)/.test(ctype)) {
    throw new ScrapeError(`non-html content-type: ${ctype}`, { status: res.status, retryable: false });
  }
}

const providers = {
  // Direct fetch — no external service. Works well for most token websites.
  // If your VPS IP gets blocked, use a scraper service instead.
  async direct(url, { signal } = {}) {
    const { res, html, responseTimeMs } = await fetchWithTimeout(url, {
      timeoutMs: config.scrape.timeoutMs,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' },
      signal,
    });
    assertHtml(res);
    return { status: res.status, finalUrl: res.url || url, html: html.slice(0, config.scrape.maxHtmlChars), responseTimeMs };
  },

  // Cloudflare Worker proxy — free (run your own worker at workertech.pages.dev)
  // Set SCRAPER_API_KEY to your worker URL with /proxy?url= endpoint
  async cloudflare(url, { signal } = {}) {
    const endpoint = `${config.scrape.apiKey}/proxy?url=${encodeURIComponent(url)}&timeout=${config.scrape.timeoutMs}`;
    const { res, html, responseTimeMs } = await fetchWithTimeout(endpoint, {
      timeoutMs: config.scrape.timeoutMs + 5000,
      headers: { 'user-agent': UA },
      signal,
    });
    if (!res.ok) throw new ScrapeError(`cloudflare proxy http ${res.status}: ${html.slice(0, 200)}`, { status: res.status, retryable: !(res.status === 401 || res.status === 403) });
    return { status: 200, finalUrl: url, html: html.slice(0, config.scrape.maxHtmlChars), responseTimeMs };
  },

  // ScraperAPI — paid service, free tier available
  async scraperapi(url) {
    const endpoint = `https://api.scraperapi.com/?api_key=${encodeURIComponent(config.scrape.apiKey)}&country_code=us&timeout=${Math.max(5, Math.floor(config.scrape.timeoutMs / 1000) - 5)}&url=${encodeURIComponent(url)}`;
    const { res, html, responseTimeMs } = await fetchWithTimeout(endpoint, { timeoutMs: config.scrape.timeoutMs + 15000 });
    if (!res.ok) throw new ScrapeError(`scraperapi http ${res.status}: ${html.slice(0, 200)}`, { status: res.status, retryable: !(res.status === 401 || res.status === 403) });
    return { status: 200, finalUrl: url, html: html.slice(0, config.scrape.maxHtmlChars), responseTimeMs };
  },

  // ScrapingBee — paid service, free tier available
  async scrapingbee(url) {
    const endpoint = `https://app.scrapingbee.com/api/v1/?api_key=${encodeURIComponent(config.scrape.apiKey)}&render=false&timeout=${Math.floor(config.scrape.timeoutMs / 1000)}&url=${encodeURIComponent(url)}`;
    const { res, html, responseTimeMs } = await fetchWithTimeout(endpoint, { timeoutMs: config.scrape.timeoutMs + 15000 });
    if (!res.ok) throw new ScrapeError(`scrapingbee http ${res.status}: ${html.slice(0, 200)}`, { status: res.status, retryable: !(res.status === 401 || res.status === 403) });
    return { status: 200, finalUrl: url, html: html.slice(0, config.scrape.maxHtmlChars), responseTimeMs };
  },

  // WebScrapingAPI — free tier: 100 req/day, good for low-volume use
  async webscrapingapi(url) {
    const endpoint = `https://api.webscrapingapi.com/1.1?api_key=${encodeURIComponent(config.scrape.apiKey)}&url=${encodeURIComponent(url)}&render_js=false&timeout=${config.scrape.timeoutMs}`;
    const { res, html, responseTimeMs } = await fetchWithTimeout(endpoint, { timeoutMs: config.scrape.timeoutMs + 10000 });
    if (!res.ok) throw new ScrapeError(`webscrapingapi http ${res.status}: ${html.slice(0, 200)}`, { status: res.status, retryable: !(res.status === 401 || res.status === 403) });
    return { status: 200, finalUrl: url, html: html.slice(0, config.scrape.maxHtmlChars), responseTimeMs };
  },
};

export function getScraperProvider() {
  const p = providers[config.scrape.provider];
  if (!p) throw new Error(`unknown SCRAPER_PROVIDER: ${config.scrape.provider}`);
  return p;
}

export async function scrapeUrl(url) {
  const providerName = config.scrape.provider;
  const provider = getScraperProvider();

  // Direct scraper uses circuit breaker; third-party providers handle their own rate limits
  const doScrape = providerName === 'direct'
    ? () => directCB.fire(async (signal) => {
        const result = await provider(url, { signal });
        return result;
      })
    : () => provider(url);

  const started = Date.now();
  try {
    const result = await doScrape();
    metrics.inc('scraped');
    return { ...result, ok: true, url, provider: providerName, totalMs: Date.now() - started, error: null };
  } catch (err) {
    metrics.inc('scrapeFailed');
    if (err.message === 'circuit breaker: open') {
      const e = new Error(`direct scraper circuit breaker open: ${url}`);
      e.retryable = true;
      throw e;
    }
    if (err.name === 'AbortError' || /timeout/i.test(String(err.message))) {
      const e = new Error(`scrape timeout after ${config.scrape.timeoutMs}ms: ${url}`);
      e.retryable = true;
      throw e;
    }
    throw err;
  }
}
