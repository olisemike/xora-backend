// ============================================
// ADMIN OPERATION RATE LIMITING
// Special rate limits for expensive admin operations
// ============================================

import { errorResponse, now, generateId } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

/**
 * Rate limits for admin operations
 * Stricter than normal limits to prevent abuse
 */
export const ADMIN_RATE_LIMITS = {
  // User management
  'ban_users': { requests: 20, windowSeconds: 3600 },       // 20 per hour
  'verify_users': { requests: 100, windowSeconds: 3600 },   // 100 per hour
  
  // Content deletion (expensive)
  'delete_posts': { requests: 50, windowSeconds: 3600 },    // 50 per hour
  'delete_content': { requests: 100, windowSeconds: 3600 }, // 100 per hour
  
  // Report handling (can be spammed)
  'resolve_reports': { requests: 100, windowSeconds: 3600 },  // 100 per hour
  'view_reports': { requests: 200, windowSeconds: 3600 },     // 200 per hour
  
  // Analytics (expensive DB queries)
  'view_analytics': { requests: 30, windowSeconds: 3600 },      // 30 per hour
  'view_system_analytics': { requests: 50, windowSeconds: 3600 }, // 50 per hour
  'export_analytics': { requests: 10, windowSeconds: 3600 },     // 10 per hour
  
  // Data import/export (very expensive)
  'export_data': { requests: 5, windowSeconds: 3600 },        // 5 per hour
  'import_data': { requests: 2, windowSeconds: 3600 },        // 2 per hour (extremely restrictive)
  
  // Admin management (super admin only, highly restricted)
  'create_admin': { requests: 5, windowSeconds: 86400 },      // 5 per day
  'delete_admin': { requests: 3, windowSeconds: 86400 },      // 3 per day
  'modify_admin': { requests: 10, windowSeconds: 3600 },      // 10 per hour
  
  // Audit actions
  'view_audit_logs': { requests: 100, windowSeconds: 3600 },     // 100 per hour
  'system_settings': { requests: 20, windowSeconds: 3600 },      // 20 per hour
};

/**
 * Admin operation rate limiting middle
 * Called in addition to normal rate limiting
 * 
 * Usage:
 *   const adminRateLimitResult = await adminOperationRateLimit(req, env, userId, 'ban_users');
 *   if (!adminRateLimitResult.allowed) return adminRateLimitResult.error;
 * 
 * @param {Request} request - HTTP request
 * @param {object} env - Environment variables
 * @param {string} userId - Admin user ID
 * @param {string} operation - Operation name (ban_users, delete_posts, etc.)
 * @returns {Promise<object>} - {allowed, error, remaining, resetAt, retryAfter}
 */
export async function adminOperationRateLimit(request, env, userId, operation) {
  if (!operation || !ADMIN_RATE_LIMITS[operation]) {
    console.warn(`[AdminRateLimit] Unknown operation: ${operation}`);
    return { allowed: true }; // Unknown operations pass through (fail open)
  }

  const config = ADMIN_RATE_LIMITS[operation];
  const key = `admin_rate_limit:${userId}:${operation}`;
  const currentTime = now();
  const windowStart = currentTime - config.windowSeconds;

  try {
    // Try to get existing rate limit entry
    let existing = await env.DB.prepare(`
      SELECT count, window_start FROM admin_rate_limits
      WHERE admin_id = ? AND operation = ?
    `).bind(userId, operation).first();

    if (existing) {
      // Check if window has expired
      if (existing.window_start < windowStart) {
        // Reset window - first request in new window
        await env.DB.prepare(`
          UPDATE admin_rate_limits
          SET count = 1, window_start = ?
          WHERE admin_id = ? AND operation = ?
        `).bind(currentTime, userId, operation).run();

        return {
          allowed: true,
          remaining: config.requests - 1,
          resetAt: currentTime + config.windowSeconds
        };
      }

      // Check if limit exceeded
      if (existing.count >= config.requests) {
        const retryAfter = existing.window_start + config.windowSeconds - currentTime;
        
        console.warn(
          `[AdminRateLimit] Rate limit exceeded for ${userId} on ${operation} ` +
          `(${existing.count}/${config.requests} in window)`
        );

        return {
          allowed: false,
          error: errorResponse(
            `Rate limit exceeded for ${operation}. Maximum: ${config.requests} per hour`,
            429,
            {
              operation,
              limit: config.requests,
              windowSeconds: config.windowSeconds,
              retryAfter,
              message: 'Admin operation rate limit exceeded'
            }
          ),
          retryAfter,
          remaining: 0,
          resetAt: existing.window_start + config.windowSeconds
        };
      }

      // Increment counter
      await env.DB.prepare(`
        UPDATE admin_rate_limits SET count = count + 1
        WHERE admin_id = ? AND operation = ?
      `).bind(userId, operation).run();

      return {
        allowed: true,
        remaining: config.requests - (existing.count + 1),
        resetAt: existing.window_start + config.windowSeconds
      };
    }

    // Create new entry
    const id = generateId('arl');
    await env.DB.prepare(`
      INSERT INTO admin_rate_limits (id, admin_id, operation, count, window_start)
      VALUES (?, ?, ?, 1, ?)
    `).bind(id, userId, operation, currentTime).run();

    return {
      allowed: true,
      remaining: config.requests - 1,
      resetAt: currentTime + config.windowSeconds
    };

  } catch (error) {
    console.error(`[AdminRateLimit] Error checking rate limit for ${operation}:`, error);
    // On error, allow but log (fail open)
    return { allowed: true };
  }
}

/**
 * Check if an operation is rate limited
 * (lightweight check without DB write)
 */
export async function checkAdminOperationLimit(env, userId, operation) {
  if (!operation || !ADMIN_RATE_LIMITS[operation]) {
    return { allowed: true };
  }

  try {
    const config = ADMIN_RATE_LIMITS[operation];
    const windowStart = now() - config.windowSeconds;

    const entry = await env.DB.prepare(`
      SELECT count, window_start FROM admin_rate_limits
      WHERE admin_id = ? AND operation = ? AND window_start >= ?
    `).bind(userId, operation, windowStart).first();

    if (!entry) {
      return { allowed: true, remaining: config.requests };
    }

    const isExceeded = entry.count >= config.requests;
    return {
      allowed: !isExceeded,
      remaining: Math.max(0, config.requests - entry.count),
      resetAt: entry.window_start + config.windowSeconds
    };

  } catch (error) {
    console.error(`[AdminRateLimit] Check error for ${operation}:`, error);
    return { allowed: true };
  }
}

/**
 * Record an admin operation for auditing
 * Call this whenever an admin performs a state-changing operation
 */
export async function logAdminOperation(env, userId, operation, targetId = null, details = {}) {
  try {
    const id = generateId('audit');
    const timestamp = now();
    const clientIp = details.clientIp || 'unknown';
    const userAgent = details.userAgent || 'unknown';

    await env.DB.prepare(`
      INSERT INTO admin_audit_log (id, admin_id, operation, target_id, timestamp, client_ip, user_agent, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      userId,
      operation,
      targetId,
      timestamp,
      clientIp,
      userAgent,
      JSON.stringify(details)
    ).run();

    console.log(`[AdminAudit] ${operation} by admin ${userId} on target ${targetId}`);
  } catch (error) {
    console.error(`[AdminAudit] Failed to log operation:`, error);
    // Don't throw - logging failure shouldn't block the operation
  }
}

/**
 * Get admin's recent operations
 * @param {object} env - Environment
 * @param {string} userId - Admin user ID
 * @param {number} limit - Number of recent operations to fetch
 */
export async function getAdminOperationHistory(env, userId, limit = 50) {
  try {
    const history = await env.DB.prepare(`
      SELECT operation, target_id, timestamp, client_ip, details
      FROM admin_audit_log
      WHERE admin_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).bind(userId, limit).all();

    return history.results || [];
  } catch (error) {
    console.error('Failed to fetch admin operation history:', error);
    return [];
  }
}

/**
 * Cleanup old admin audit logs (call from scheduled job)
 * @param {object} env - Environment
 * @param {number} retentionDays - Days to retain (default 90)
 */
export async function cleanupAdminAuditLogs(env, retentionDays = 90) {
  try {
    const cutoffTime = now() - (retentionDays * 86400);
    
    const result = await env.DB.prepare(`
      DELETE FROM admin_audit_log WHERE timestamp < ?
    `).bind(cutoffTime).run();

    logger.info(`🧹 Cleaned up ${result.changes || 0} admin audit logs older than ${retentionDays} days`);
    return result.changes || 0;

  } catch (error) {
    logger.error('Admin audit log cleanup error:', error);
    return 0;
  }
}

/**
 * Get rate limit status for all admin operations
 * @param {object} env - Environment
 * @param {string} userId - Admin user ID
 */
export async function getAdminRateLimitStatus(env, userId) {
  const status = {};
  const currentTime = now();

  for (const [operation, config] of Object.entries(ADMIN_RATE_LIMITS)) {
    try {
      const windowStart = currentTime - config.windowSeconds;
      const entry = await env.DB.prepare(`
        SELECT count, window_start FROM admin_rate_limits
        WHERE admin_id = ? AND operation = ? AND window_start >= ?
      `).bind(userId, operation, windowStart).first();

      if (entry) {
        status[operation] = {
          count: entry.count,
          limit: config.requests,
          windowSeconds: config.windowSeconds,
          resetAt: entry.window_start + config.windowSeconds,
          remaining: Math.max(0, config.requests - entry.count)
        };
      } else {
        status[operation] = {
          count: 0,
          limit: config.requests,
          windowSeconds: config.windowSeconds,
          resetAt: currentTime + config.windowSeconds,
          remaining: config.requests
        };
      }
    } catch (error) {
      console.error(`[AdminRateLimit] Error getting status for ${operation}:`, error);
      status[operation] = { error: 'Failed to fetch status' };
    }
  }

  return status;
}
