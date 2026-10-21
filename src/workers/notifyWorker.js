import { Worker, QueueEvents } from 'bullmq';
import { coll } from '../db.js';
import { log } from '../lib/logger.js';
import { metrics } from '../lib/metrics.js';
import { createConnection } from '../queues.js';
import { deliverNotification } from '../services/notifier/index.js';

export function startNotifyWorker() {
  const worker = new Worker('notify', async (job) => {
    await deliverNotification(job.data);
  }, { connection: createConnection(), concurrency: 2 });

  const events = new QueueEvents('notify', { connection: createConnection() });
  events.on('failed', async ({ jobId, failedReason, prev }) => {
    if (prev !== 'active') return;
    metrics.inc('notifyFailed');
    await coll.notifications.updateOne(
      { dedupeKey: jobId },
      { $set: { status: 'failed', error: String(failedReason).slice(0, 300) } }
    );
    log.warn(`[notify] failed permanently ${jobId}: ${failedReason}`);
  });
  worker.on('error', (err) => log.error('[notify worker]', err.message));
  log.info('[notify worker] started');
  return { worker, events };
}