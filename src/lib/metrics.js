export const metrics = {
  eventsReceived: 0, duplicates: 0, noWebsite: 0, queued: 0, droppedBackpressure: 0,
  scraped: 0, scrapeFailed: 0, scrapeDead: 0, matched: 0, notMatched: 0,
  notified: 0, notifyFailed: 0, analysesStarted: 0, analysesCompleted: 0, analysesFailed: 0,
  inc(k) { if (typeof this[k] === 'number') this[k]++; },
  snapshot() {
    const o = {};
    for (const [k, v] of Object.entries(this)) if (typeof v === 'number') o[k] = v;
    return o;
  },
};