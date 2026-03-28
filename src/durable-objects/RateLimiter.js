// Durable Object rate limiter for cross-instance consistency
export class RateLimiter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.cache = new Map();
  }

  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    const key = body?.key;
    const limit = Number(body?.limit);
    const windowSeconds = Number(body?.windowSeconds);
    const now = Number(body?.now);

    if (!key || !Number.isFinite(limit) || !Number.isFinite(windowSeconds)) {
      return new Response('Bad request', { status: 400 });
    }

    const currentTime = Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
    const windowStart = currentTime - windowSeconds;

    let record = this.cache.get(key) || await this.state.storage.get(key);

    if (record && record.expiresAt <= currentTime) {
      await this.state.storage.delete(key);
      this.cache.delete(key);
      record = null;
    }

    if (!record || record.windowStart < windowStart) {
      record = {
        count: 0,
        windowStart: currentTime,
        expiresAt: currentTime + windowSeconds
      };
    }

    if (record.count >= limit) {
      const retryAfter = record.windowStart + windowSeconds - currentTime;
      return Response.json({
        allowed: false,
        remaining: 0,
        resetAt: record.windowStart + windowSeconds,
        retryAfter
      });
    }

    record.count += 1;
    record.expiresAt = record.windowStart + windowSeconds;
    this.cache.set(key, record);
    await this.state.storage.put(key, record);

    return Response.json({
      allowed: true,
      remaining: Math.max(0, limit - record.count),
      resetAt: record.windowStart + windowSeconds
    });
  }
}
