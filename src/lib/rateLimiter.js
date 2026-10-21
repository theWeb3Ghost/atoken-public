import IORedis from 'ioredis';
import { config } from '../config.js';

// In-memory fallback rate limiter for single-process mode
class MemoryRateLimiter {
  constructor(max, perMS) {
    this.max = max;
    this.perMS = perMS;
    this.hits = [];
  }
  async take() {
    for (;;) {
      const now = Date.now();
      this.hits = this.hits.filter((t) => now - t < this.perMS);
      if (this.hits.length < this.max) { this.hits.push(now); return; }
      await new Promise((r) => setTimeout(r, Math.max(this.hits[0] + this.perMS - now, 10)));
    }
  }
  async clear() {}
}

// Redis-backed rate limiter using sliding window
// Uses a Redis sorted set: score=timestamp, member=timestamp+random
class RedisRateLimiter {
  constructor(redis, key, max, perMS) {
    this.redis = redis;
    this.key = key;
    this.max = max;
    this.perMS = perMS;
  }

  async take() {
    const now = Date.now();
    const windowStart = now - this.perMS;
    // Remove entries outside the window
    await this.redis.zremrangebyscore(this.key, 0, windowStart);
    // Count entries in window
    const count = await this.redis.zcard(this.key);
    if (count >= this.max) {
      // Find the oldest entry to calculate wait time
      const oldest = await this.redis.zrange(this.key, 0, 0, 'WITHSCORES');
      const waitMs = oldest.length ? Math.max(Number(oldest[1]) + this.perMS - now + 10, 10) : 1000;
      await new Promise((r) => setTimeout(r, waitMs));
      return this.take(); // retry
    }
    // Add current timestamp
    const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
    await this.redis.zadd(this.key, now, member);
    // Expire the key to prevent unbounded growth
    await this.redis.pexpire(this.key, this.perMS);
  }

  async clear() {
    await this.redis.del(this.key);
  }
}

let sharedRedis = null;

function getRedis() {
  if (!sharedRedis) {
    sharedRedis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  }
  return sharedRedis;
}

/**
 * Create a rate limiter. Uses Redis if KEY provided, falls back to memory otherwise.
 * @param {number} max - max operations per window
 * @param {number} perMS - window in milliseconds
 * @param {string} [key] - unique key for this rate limiter (enables Redis mode)
 */
export class RateLimiter {
  constructor(max, perMS, key = null) {
    this.max = max;
    this.perMS = perMS;
    if (key) {
      const redis = getRedis();
      this.backend = new RedisRateLimiter(redis, `ratelimit:${key}`, max, perMS);
    } else {
      this.backend = new MemoryRateLimiter(max, perMS);
    }
  }

  async take() {
    await this.backend.take();
  }

  async clear() {
    await this.backend.clear();
  }
}
