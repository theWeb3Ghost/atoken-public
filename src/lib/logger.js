const ts = () => new Date().toISOString();
const isProd = process.env.NODE_ENV === 'production';

const safe = (v) => {
  try { return typeof v === 'string' ? v : JSON.stringify(v); }
  catch { return String(v); }
};

export const log = {
  info: (...a) => {
    if (isProd) console.log(JSON.stringify({ level: 'info', ts: ts(), msg: safe(a) }));
    else console.log(ts(), '[info]', ...a);
  },
  warn: (...a) => {
    if (isProd) console.warn(JSON.stringify({ level: 'warn', ts: ts(), msg: safe(a) }));
    else console.warn(ts(), '[warn]', ...a);
  },
  error: (...a) => {
    if (isProd) console.error(JSON.stringify({ level: 'error', ts: ts(), msg: safe(a) }));
    else console.error(ts(), '[error]', ...a);
  },
  debug: (...a) => {
    if (process.env.DEBUG) {
      if (isProd) console.log(JSON.stringify({ level: 'debug', ts: ts(), msg: safe(a) }));
      else console.log(ts(), '[debug]', ...a);
    }
  },
};
