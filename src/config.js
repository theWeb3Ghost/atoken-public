import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : v !== 'false');

export const config = {
  port: num(process.env.PORT, 8080),
  workerMode: process.env.WORKER_MODE || 'all',
  apiToken: process.env.API_TOKEN || '',
  vps: process.env.VPS_MODE === 'true',

  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/token_radar',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  dexscreener: {
    transport: (process.env.DEXSCREENER_TRANSPORT || 'poll').toLowerCase(),
    wsUrl: process.env.DEXSCREENER_WS_URL || '',
    profilesUrl: 'https://api.dexscreener.com/token-profiles/latest/v1',
    pollIntervalMs: num(process.env.POLL_INTERVAL_MS, 10000),
    wsStaleMs: num(process.env.DEXSCREENER_WS_STALE_MS, 90000),
  },

  scrape: {
    provider: (process.env.SCRAPER_PROVIDER || 'direct').toLowerCase(),
    apiKey: process.env.SCRAPER_API_KEY || process.env.SCRAPINGBEE_API_KEY || '',
    timeoutMs: num(process.env.SCRAPE_TIMEOUT_MS, 12000),
    concurrency: num(process.env.MAX_CONCURRENT_SCRAPES, 5),
    rpm: num(process.env.SCRAPER_RPM, 30),
    retries: num(process.env.MAX_RETRIES, 3),
    retryDelayMs: num(process.env.RETRY_DELAY_MS, 5000),
    maxQueueSize: num(process.env.MAX_QUEUE_SIZE, 5000),
    maxHtmlChars: num(process.env.MAX_HTML_CHARS, 1_500_000),
    maxTextChars: num(process.env.MAX_TEXT_CHARS, 60_000),
  },

  rescanAfterHours: num(process.env.RESCAN_AFTER_HOURS, 0),

  notification: { provider: process.env.NOTIFICATION_PROVIDER || 'telegram' },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    sendPerMin: num(process.env.TELEGRAM_SEND_RATE_PER_MIN, 20),
  },

  llm: {
    baseUrl: (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
    maxTextChars: num(process.env.LLM_MAX_TEXT_CHARS, 12000),
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 120000),
    rpm: num(process.env.LLM_RPM, 10),
  },
  analysis: { concurrency: num(process.env.ANALYSIS_CONCURRENCY, 1) },

  sample: {
    enabled: bool(process.env.SAMPLE_ENABLED, true),
    intervalMs: num(process.env.SAMPLE_INTERVAL_MS, 600_000),
    rpm: num(process.env.SAMPLE_RPM, 60),
    maxTracked: num(process.env.MAX_TRACKED_TOKENS, 1500),
    windowHours: num(process.env.TRACK_WINDOW_HOURS, 72),
    minLiquidity: num(process.env.TRACK_MIN_LIQUIDITY, 1000),
    runnerMultiple: num(process.env.RUNNER_MULTIPLE, 2),
    ttlDays: num(process.env.SAMPLE_TTL_DAYS, 30),
  },

  sec: { enabled: bool(process.env.SEC_ENABLED, true), timeoutMs: num(process.env.SEC_TIMEOUT_MS, 8000) },
  gt: { enabled: bool(process.env.GT_ENABLED, true) },
  llmFeats: { enabled: bool(process.env.LLM_FEATS_ENABLED, true) },

  paper: {
    minScore: num(process.env.PAPER_MIN_SCORE, 0.5),
    stopPct: num(process.env.PAPER_STOP_PCT, 0.30),
    horizonHours: num(process.env.PAPER_HORIZON_H, 72),
  },

  maintenance: {
    enabled: bool(process.env.MAINTENANCE_ENABLED, true),
    intervalMs: num(process.env.MAINT_INTERVAL_MS, 6 * 3600e3),
    autoTrain: bool(process.env.AUTO_TRAIN, true),
    backfillPerRun: num(process.env.BACKFILL_PER_RUN, 40),
  },
  digest: process.env.DIGEST_ENABLED == null || process.env.DIGEST_ENABLED === ''
    ? null : process.env.DIGEST_ENABLED !== 'false',
};