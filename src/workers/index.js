import { startScrapeWorker } from './scrapeWorker.js';
import { startNotifyWorker } from './notifyWorker.js';
import { startAnalyzeWorker } from './analyzeWorker.js';
import { startSampleWorker } from './sampleWorker.js';
import { startLlmFeatWorker } from './llmFeatWorker.js';
import { startTrainWorker } from './trainWorker.js';
import { startMaintenance } from '../services/maintenance.js';

export function startWorkers() {
  const s = startScrapeWorker();
  const n = startNotifyWorker();
  const a = startAnalyzeWorker();
  const sp = startSampleWorker();
  const lf = startLlmFeatWorker();
  const tr = startTrainWorker();
  const mt = startMaintenance();
  return {
    stop: async () => {
      await Promise.allSettled([
        s.worker.close(), s.events.close(),
        n.worker.close(), n.events.close(),
        a.worker.close(), a.events.close(),
        sp.stop(), lf.stop(), tr.worker.close(), mt.stop(),
      ]);
    },
  };
}
