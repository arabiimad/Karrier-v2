// Simple in-memory rate limiter for serverless functions
const rateMap = new Map();

function rateLimit(options) {
  const { windowMs = 60000, max = 30, keyFn } = options || {};

  return function checkRate(req) {
    const key = keyFn ? keyFn(req) : (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown');
    const now = Date.now();

    if (!rateMap.has(key)) {
      rateMap.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: max - 1 };
    }

    const entry = rateMap.get(key);

    if (now > entry.resetAt) {
      entry.count = 1;
      entry.resetAt = now + windowMs;
      return { allowed: true, remaining: max - 1 };
    }

    entry.count++;
    if (entry.count > max) {
      return { allowed: false, remaining: 0, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    }

    return { allowed: true, remaining: max - entry.count };
  };
}

// Cleanup old entries every 5 minutes
setInterval(function() {
  const now = Date.now();
  for (const [key, entry] of rateMap) {
    if (now > entry.resetAt + 60000) rateMap.delete(key);
  }
}, 300000);

module.exports = rateLimit;
