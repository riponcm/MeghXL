'use strict';

// ---------------------------------------------------------------------------
// Rate limits. MeghXL has no accounts, so every device on the network is
// anonymous — these keep one of them from flooding the board, the host's CPU
// or its disk. Limits are per IP and generous enough that a person never meets
// them; a script hammering the hub does.
// ---------------------------------------------------------------------------

/**
 * A token bucket per key: `burst` requests at once, refilled at `perMinute`.
 * Idle buckets are forgotten, so memory stays bounded by recent activity.
 */
function createBucket({ burst, perMinute }) {
  const buckets = new Map();
  const rate = perMinute / 60000; // tokens per ms

  function take(key, cost = 1) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: burst, at: now };
      buckets.set(key, b);
    } else {
      b.tokens = Math.min(burst, b.tokens + (now - b.at) * rate);
      b.at = now;
    }
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  const sweep = setInterval(() => {
    const cutoff = Date.now() - (burst / rate);
    for (const [k, b] of buckets) if (b.at < cutoff) buckets.delete(k);
  }, 60000);
  if (sweep.unref) sweep.unref();

  return { take };
}

/** Express middleware: 429 once `keyOf(req)` has used up its bucket. */
function rateLimit({ burst, perMinute, keyOf, message }) {
  const bucket = createBucket({ burst, perMinute });
  return (req, res, next) => {
    if (bucket.take(keyOf(req))) return next();
    res.setHeader('Retry-After', '10');
    res.status(429).json({ error: message || 'Too many requests — slow down and try again in a moment.' });
  };
}

/** Counts things in flight per key (uploads, sockets) against a ceiling. */
function createCounter(max) {
  const counts = new Map();
  return {
    tryAcquire(key) {
      const n = counts.get(key) || 0;
      if (n >= max) return false;
      counts.set(key, n + 1);
      return true;
    },
    release(key) {
      const n = (counts.get(key) || 0) - 1;
      if (n > 0) counts.set(key, n);
      else counts.delete(key);
    },
  };
}

module.exports = { createBucket, rateLimit, createCounter };
