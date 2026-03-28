// Rate Limiter for Ad Tracking and other endpoints
import { now, safeJsonParse } from './helpers.js';

export class RateLimiter {
  constructor(db, cache) {
    this.db = db;
    this.cache = cache;
  }

  /**
   * Check if request is rate limited
   * @param {string} key - Unique identifier (e.g., "ad_impression:userId:adId")
   * @param {number} maxRequests - Maximum requests allowed
   * @param {number} windowSeconds - Time window in seconds
   * @returns {Promise<{allowed: boolean, resetAt?: number}>}
   */
  async checkRateLimit(key, maxRequests, windowSeconds) {
    try {
      const timestamp = now();
      const windowStart = timestamp - windowSeconds;

      // Try to use cache if available for better performance
      if (this.cache) {
        const cached = await this.cache.get(`ratelimit:${key}`);
        if (cached) {
          const data = safeJsonParse(cached);
          if (data && data.count >= maxRequests && data.windowStart > windowStart) {
            return {
              allowed: false,
              resetAt: data.windowStart + windowSeconds
            };
          }
        }
      }

      // Check database for rate limit records
      const record = await this.db.prepare(`
        SELECT COUNT(*) as count
        FROM rate_limit_tracking
        WHERE key = ? AND timestamp > ?
      `).bind(key, windowStart).first();

      if (record && record.count >= maxRequests) {
        // Update cache
        if (this.cache) {
          await this.cache.put(`ratelimit:${key}`, JSON.stringify({
            count: record.count,
            windowStart: timestamp
          }), { expirationTtl: windowSeconds });
        }

        return {
          allowed: false,
          resetAt: timestamp + windowSeconds
        };
      }

      // Record this request
      await this.db.prepare(`
        INSERT INTO rate_limit_tracking (key, timestamp)
        VALUES (?, ?)
      `).bind(key, timestamp).run();

      // Clean up old records (older than window)
      await this.db.prepare(`
        DELETE FROM rate_limit_tracking
        WHERE key = ? AND timestamp <= ?
      `).bind(key, windowStart).run();

      return { allowed: true };
    } catch (error) {
      console.error('Rate limit check error:', error);
      // On error, allow the request (fail open)
      return { allowed: true };
    }
  }

  /**
   * Clean up old rate limit records
   * Should be called periodically (e.g., via cron job or on each request)
   * @param {number} olderThanSeconds - Remove records older than this (default: 1 hour)
   */
  async cleanup(olderThanSeconds = 3600) {
    try {
      const cutoffTime = now() - olderThanSeconds;

      const result = await this.db.prepare(`
        DELETE FROM rate_limit_tracking
        WHERE timestamp < ?
      `).bind(cutoffTime).run();

      return {
        success: true,
        deletedCount: result.changes || 0
      };
    } catch (error) {
      console.error('Rate limit cleanup error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Clean up specific key's old records
   * More efficient than global cleanup
   */
  async cleanupKey(key, olderThanSeconds = 3600) {
    try {
      const cutoffTime = now() - olderThanSeconds;

      await this.db.prepare(`
        DELETE FROM rate_limit_tracking
        WHERE key = ? AND timestamp < ?
      `).bind(key, cutoffTime).run();

      return { success: true };
    } catch (error) {
      console.error('Rate limit key cleanup error:', error);
      return { success: false };
    }
  }

  /**
   * Check rate limit for ad impressions
   * @param {string} userId - User ID
   * @param {string} adId - Ad ID
   * @returns {Promise<{allowed: boolean, resetAt?: number}>}
   */
  async checkAdImpressionLimit(userId, adId) {
    // Allow max 10 impressions per user per ad per minute
    return await this.checkRateLimit(
      `ad_impression:${userId}:${adId}`,
      10,
      60 // 1 minute window
    );
  }

  /**
   * Check rate limit for ad clicks
   * @param {string} userId - User ID
   * @param {string} adId - Ad ID
   * @returns {Promise<{allowed: boolean, resetAt?: number}>}
   */
  async checkAdClickLimit(userId, adId) {
    // Allow max 3 clicks per user per ad per minute
    return await this.checkRateLimit(
      `ad_click:${userId}:${adId}`,
      3,
      60 // 1 minute window
    );
  }

  /**
   * Check rate limit for global ad tracking (per IP)
   * @param {string} ipAddress - IP address
   * @returns {Promise<{allowed: boolean, resetAt?: number}>}
   */
  async checkGlobalAdTrackingLimit(ipAddress) {
    // Allow max 100 ad tracking requests per IP per minute
    return await this.checkRateLimit(
      `ad_tracking_ip:${ipAddress}`,
      100,
      60 // 1 minute window
    );
  }
}
