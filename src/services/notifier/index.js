import { config } from '../../config.js';
import { coll } from '../../db.js';
import { log } from '../../lib/logger.js';
import { metrics } from '../../lib/metrics.js';
import { RateLimiter } from '../../lib/rateLimiter.js';
import { notifyQueue } from '../../queues.js';
import { TelegramProvider } from './telegram.js';

const providers = { telegram: TelegramProvider };
const limiter = new RateLimiter(config.telegram.sendPerMin, 60_000, 'notify-telegram');

export async function enqueueNotification({ dedupeKey, kind, chainId, tokenAddress, text, keyboard, replyTo }) {
  // Store original dedupeKey in MongoDB (allows colons), but sanitize for BullMQ job ID
  const jobId = dedupeKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  try {
    await coll.notifications.insertOne({ dedupeKey, kind, status: 'pending', attempts: 0, createdAt: new Date() });
  } catch (err) {
    if (err.code === 11000) return { skipped: true };
    throw err;
  }
  await notifyQueue.add('notify', { dedupeKey, kind, chainId, tokenAddress, text, keyboard, replyTo }, { jobId });
  return { skipped: false };
}

export async function deliverNotification(jobData) {
  const provider = providers[config.notification.provider] || providers.telegram;
  await limiter.take();
  const sent = await provider.send(jobData);
  await coll.notifications.updateOne(
    { dedupeKey: jobData.dedupeKey },
    { $set: { status: 'sent', sentAt: new Date() }, $inc: { attempts: 1 } }
  );
  if (jobData.kind === 'candidate' && sent?.message_id) {
    await coll.candidates.updateOne(
      { chainId: jobData.chainId, tokenAddress: jobData.tokenAddress },
      { $set: { notified: true, notifyMeta: { chatId: sent.chat?.id, messageId: sent.message_id } } }
    );
  }
  metrics.inc('notified');
  log.info(`[notify] sent ${jobData.dedupeKey}`);
}
