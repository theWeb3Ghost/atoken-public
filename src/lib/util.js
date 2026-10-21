export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Simple in-memory circuit breaker.
 * Opens after `failureThreshold` consecutive failures,
 * stays open for `resetTimeoutMs`, then goes half-open.
 */
export class CircuitBreaker {
  constructor({ failureThreshold = 5, resetTimeoutMs = 30000, timeoutMs = 15000 }) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.timeoutMs = timeoutMs;
    this.state = 'closed'; // closed | open | half-open
    this.failures = 0;
    this.nextAttempt = 0;
  }

  async fire(fn) {
    const now = Date.now();
    if (this.state === 'open') {
      if (now < this.nextAttempt) {
        throw new Error('circuit breaker: open');
      }
      this.state = 'half-open';
    }

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error('timeout')), this.timeoutMs);
      const result = await fn(ctrl.signal);
      clearTimeout(timer);
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  onSuccess() {
    this.failures = 0;
    this.state = 'closed';
  }

  onFailure() {
    this.failures++;
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.nextAttempt = Date.now() + this.resetTimeoutMs;
    }
  }
}
