// ============================================
// RATE LIMITING MIDDLEWARE
// Industry-standard rate limits for social APIs
// ============================================

import { errorResponse, now, generateId } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/dbRetry.js';
import { getWriteCircuitBreaker } from '../services/circuitBreaker.js';

const RATE_LIMIT_RETRY_OPTIONS = { maxRetries: 2, initialDelay: 50, maxDelay: 300, timeoutMs: 1500 };
const RATE_LIMIT_WRITE_RETRY_OPTIONS = { maxRetries: 2, initialDelay: 50, maxDelay: 300, timeoutMs: 2000 };
const getLimiterUnavailableResult = () => ({
  allowed: false,
  error: errorResponse('Rate limiter temporarily unavailable', 429, { retryAfter: 1, code: 'RATE_LIMIT_UNAVAILABLE' }),
  retryAfter: 1
});
const runRateLimitRead = (operation) => retryOperation(operation, RATE_LIMIT_RETRY_OPTIONS);

async function runRateLimitWrite(operation) {
  const writeBreaker = getWriteCircuitBreaker();
  if (!writeBreaker.canRequest()) {
    throw new Error('RATE_LIMIT_WRITE_BREAKER_OPEN');
  }

  try {
    const result = await retryOperation(operation, RATE_LIMIT_WRITE_RETRY_OPTIONS);
    writeBreaker.recordSuccess();
    return result;
  } catch (error) {
    writeBreaker.recordFailure();
    throw error;
  }
}

function hashKey(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

async function checkRateLimitWithDurableObject(env, key, config, currentTime) {
  if (!env.RATE_LIMITER) return null;

  const shard = hashKey(key) % 64;
  const id = env.RATE_LIMITER.idFromName(`rl-${shard}`);
  const stub = env.RATE_LIMITER.get(id);

  const response = await stub.fetch('https://rate-limiter/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key,
      limit: config.requests,
      windowSeconds: config.windowSeconds,
      now: currentTime
    })
  });

  if (!response.ok) return null;
  return response.json();
}

/**
 * Rate limit configurations by endpoint category
 * Based on industry standards (Twitter, Instagram, etc.)
 */
export const RATE_LIMITS = {
  // Authentication - strict to prevent brute force
  auth: {
    login: { requests: 15, windowSeconds: 300 },         // 15 per 5 min
    signup: { requests: 5, windowSeconds: 3600 },        // 5 per hour
    passwordReset: { requests: 5, windowSeconds: 3600 }, // 5 per hour
    verify2FA: { requests: 10, windowSeconds: 300 },     // 10 per 5 min
  },
  
  // Content creation - moderate limits
  write: {
    posts: { requests: 30, windowSeconds: 3600 },        // 30 posts per hour
    comments: { requests: 60, windowSeconds: 3600 },     // 60 comments per hour
    messages: { requests: 100, windowSeconds: 3600 },    // 100 messages per hour
    stories: { requests: 20, windowSeconds: 3600 },      // 20 stories per hour
    reels: { requests: 10, windowSeconds: 3600 },        // 10 reels per hour
  },
  
  // Engagement actions
  engagement: {
    likes: { requests: 200, windowSeconds: 3600 },       // 200 likes per hour
    follows: { requests: 100, windowSeconds: 3600 },     // 100 follows per hour
    shares: { requests: 50, windowSeconds: 3600 },       // 50 shares per hour
  },
  
  // Read operations - generous limits
  read: {
    feed: { requests: 300, windowSeconds: 3600 },        // 300 feed requests per hour
    search: { requests: 100, windowSeconds: 3600 },      // 100 searches per hour
    profile: { requests: 500, windowSeconds: 3600 },     // 500 profile views per hour
  },
  
  // Global fallback
  default: { requests: 500, windowSeconds: 60 }          // 500 per minute
};

/**
 * Parse rate limit string like "5/15m" or "3/hour" into {requests, windowSeconds}
 */
function parseRateLimit(limitStr) {
  if (!limitStr) return { requests: 500, windowSeconds: 60 }; // default fallback
  
  const match = limitStr.match(/^(?<requests>\d+)\/(?<timeValue>\d+)(?<unit>[smhd]?)$/);
  if (!match) return { requests: 500, windowSeconds: 60 };
  
  const { groups: { requests, timeValue, unit = 'h' } } = match;
  let windowSeconds = parseInt(timeValue, 10);
  
  // Convert time units to seconds
  switch (unit) {
    case 's': windowSeconds = parseInt(timeValue, 10); break;
    case 'm': windowSeconds = parseInt(timeValue, 10) * 60; break;
    case 'h': windowSeconds = parseInt(timeValue, 10) * 3600; break;
    case 'd': windowSeconds = parseInt(timeValue, 10) * 86400; break;
    default: windowSeconds = parseInt(timeValue, 10) * 3600; break; // default to hours
  }
  
  return { requests: parseInt(requests, 10), windowSeconds };
}

/**
 * Get rate limit config for an endpoint from environment variables
 */
function getRateLimitConfig(env, method, path) {
  // Auth endpoints
  if (path.startsWith('/auth/login')) {
    return parseRateLimit(env.RATE_LIMIT_LOGIN || '15/5m');
  }
  if (path.startsWith('/auth/signup')) {
    return parseRateLimit(env.RATE_LIMIT_SIGNUP || '5/1h');
  }
  if (path.startsWith('/auth/forgot-password')) {
    return parseRateLimit(env.RATE_LIMIT_PASSWORD_RESET || env.RATE_LIMIT_SIGNUP || '5/1h');
  }
  if (path.startsWith('/auth/reset-password')) {
    return parseRateLimit(env.RATE_LIMIT_PASSWORD_RESET || env.RATE_LIMIT_SIGNUP || '5/1h');
  }
  if (path.startsWith('/auth/verify-2fa')) {
    // Use strict 2FA rate limit: 5 attempts per 5 minutes (prevent brute force)
    // Environment variable can override: RATE_LIMIT_2FA=5/5m
    return parseRateLimit(env.RATE_LIMIT_2FA || '10/5m');
  }
  
  // Write endpoints (POST/PUT/PATCH)
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    if (path.startsWith('/posts')) return parseRateLimit(env.RATE_LIMIT_POST || '30/1h');
    if (path.includes('/comments')) return parseRateLimit(env.RATE_LIMIT_COMMENT || '60/1h');
    if (path.startsWith('/conversations') || path.includes('/messages')) return parseRateLimit(env.RATE_LIMIT_MESSAGE || '100/1h');
    if (path.includes('/likes')) return parseRateLimit(env.RATE_LIMIT_LIKE || '200/1h');
    if (path.startsWith('/follows')) return parseRateLimit(env.RATE_LIMIT_FOLLOW || '100/1h');
  }
  
  // Default API limit
  return parseRateLimit(env.RATE_LIMIT_API || '500/60s');
}

/**
 * Generate rate limit key
 */
function getRateLimitKey(request, userId) {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // Use IP for unauthenticated requests, userId for authenticated
  const identifier = userId || request.headers.get('CF-Connecting-IP') || 'unknown';
  
  // Normalize path for rate limiting (remove IDs)
  const normalizedPath = path
    .replace(/\/[a-zA-Z0-9_-]{10,}(?:\/|$)/g, '/:id$1')
    .replace(/\/:id:id/g, '/:id');
  
  return `ratelimit:${identifier}:${request.method}:${normalizedPath}`;
}

/**
 * Rate limiting middleware using D1 for persistence
 */
export async function rateLimitMiddleware(request, env, userId = null) {
  const { pathname: path } = new URL(request.url);
  const { method } = request;
  
  // Skip rate limiting for OPTIONS (CORS preflight)
  if (method === 'OPTIONS') {
    return { allowed: true };
  }

  // In local development, do not rate-limit feed reads to avoid blocking testing
  const envMode = env.ENVIRONMENT || env.environment || 'production';
  if (envMode === 'development' && method === 'GET' && path.startsWith('/feed')) {
    return { allowed: true };
  }
  
  const config = getRateLimitConfig(env, method, path);
  const key = getRateLimitKey(request, userId);
  const currentTime = now();
  const windowStart = currentTime - config.windowSeconds;

  // Prefer durable object rate limiting when configured
  try {
    const durableResult = await checkRateLimitWithDurableObject(env, key, config, currentTime);
    if (durableResult && typeof durableResult.allowed === 'boolean') {
      return durableResult;
    }
  } catch (error) {
    console.error('Durable rate limiter error:', error);
  }

  // Simple in-memory cache to avoid D1 writes on hot keys.
  // This reduces latency under normal traffic and acts as a safe fallback.
  // Note: In-memory cache is per-worker and not globally consistent —
  // use Durable Objects / Redis for global counters in production.
  if (!globalThis.__rateLimitCache) globalThis.__rateLimitCache = new Map();
  const memCache = globalThis.__rateLimitCache;
  const cached = memCache.get(key);
  if (cached && cached.expiresAt > currentTime) {
    // Within window
    if (cached.count >= config.requests) {
      const retryAfter = cached.windowStart + config.windowSeconds - currentTime;
      return {
        allowed: false,
        error: errorResponse('Rate limit exceeded', 429, {
          retryAfter,
          limit: config.requests,
          windowSeconds: config.windowSeconds
        }),
        retryAfter
      };
    }

    // Increment in-memory counter and return
    cached.count += 1;
    memCache.set(key, cached);
    return {
      allowed: true,
      remaining: config.requests - cached.count,
      resetAt: cached.windowStart + config.windowSeconds
    };
  }
  
  try {
    // Get current rate limit state from D1 (if not present in in-memory cache)
    const existing = await runRateLimitRead(() => env.DB.prepare(`
      SELECT * FROM rate_limits 
      WHERE key = ? AND endpoint = ?
    `).bind(key, path).first());
    
    if (existing) {
      // Check if window has expired
      if (existing.window_start < windowStart) {
        // Reset window
        await runRateLimitWrite(() => env.DB.prepare(`
          UPDATE rate_limits 
          SET count = 1, window_start = ?, expires_at = ?
          WHERE key = ? AND endpoint = ?
        `).bind(currentTime, currentTime + config.windowSeconds, key, path).run());

        // seed in-memory cache
        memCache.set(key, { count: 1, windowStart: currentTime, expiresAt: currentTime + config.windowSeconds });
        
        return {
          allowed: true,
          remaining: config.requests - 1,
          resetAt: currentTime + config.windowSeconds
        };
      }
      
      // Check if limit exceeded
      if (existing.count >= config.requests) {
        const retryAfter = existing.window_start + config.windowSeconds - currentTime;
        
        return {
          allowed: false,
          error: errorResponse('Rate limit exceeded', 429, {
            retryAfter,
            limit: config.requests,
            windowSeconds: config.windowSeconds
          }),
          retryAfter
        };
      }
      
      // Increment counter
      // increment DB counter
      await runRateLimitWrite(() => env.DB.prepare(`
        UPDATE rate_limits SET count = count + 1 WHERE key = ? AND endpoint = ?
      `).bind(key, path).run());

      // also seed/update in-memory cache to reduce subsequent D1 writes
      const newCount = existing.count + 1;
      memCache.set(key, { count: newCount, windowStart: existing.window_start, expiresAt: existing.window_start + config.windowSeconds });

      return {
        allowed: true,
        remaining: config.requests - newCount,
        resetAt: existing.window_start + config.windowSeconds
      };

    }
    // Create new rate limit entry with crypto-strong ID
    const id = generateId('rl');

    await runRateLimitWrite(() => env.DB.prepare(`
      INSERT INTO rate_limits (id, key, endpoint, count, window_start, expires_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `).bind(id, key, path, currentTime, currentTime + config.windowSeconds).run());

    // seed in-memory cache as well
    memCache.set(key, { count: 1, windowStart: currentTime, expiresAt: currentTime + config.windowSeconds });

    return {
      allowed: true,
      remaining: config.requests - 1,
      resetAt: currentTime + config.windowSeconds
    };
    
  } catch (error) {
    console.error('Rate limit check error:', error);
    return getLimiterUnavailableResult();
  }
}

/**
 * Add rate limit headers to response
 */
export function addRateLimitHeaders(response, rateLimitResult) {
  if (!rateLimitResult) return response;

  // WebSocket upgrade responses (101) must be returned as-is.
  // Re-wrapping them drops upgrade semantics and breaks real-time connections.
  if (response?.webSocket) {
    return response;
  }

  // Create new headers and properly preserve Set-Cookie headers
  const headers = new Headers();

  // Copy all headers from original response, preserving multiple Set-Cookie headers
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === 'set-cookie') {
      headers.append(key, value);
    } else {
      headers.set(key, value);
    }
  }

  // Add rate limit headers
  if (rateLimitResult.remaining !== undefined) {
    headers.set('X-RateLimit-Remaining', rateLimitResult.remaining.toString());
  }
  if (rateLimitResult.resetAt !== undefined) {
    headers.set('X-RateLimit-Reset', rateLimitResult.resetAt.toString());
  }
  if (rateLimitResult.retryAfter !== undefined) {
    headers.set('Retry-After', rateLimitResult.retryAfter.toString());
  }

  // Ensure status is always between 200 and 599 (inclusive)
  let status = Number(response.status);
  if (isNaN(status) || status < 200 || status > 599) {
    status = 200;
  }
  return new Response(response.body, {
    status,
    statusText: response.statusText,
    headers
  });
}

/**
 * Cleanup expired rate limit entries (call from scheduled job)
 */
export async function cleanupExpiredRateLimits(env) {
  const currentTime = now();
  
  try {
    const result = await env.DB.prepare(`
      DELETE FROM rate_limits WHERE expires_at < ?
    `).bind(currentTime).run();
    
    logger.info(`🧹 Cleaned up ${result.changes || 0} expired rate limit entries`);
    return result.changes || 0;
    
  } catch (error) {
    logger.error('Rate limit cleanup error:', error);
    return 0;
  }
}
