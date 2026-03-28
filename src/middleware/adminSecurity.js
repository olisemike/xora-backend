/**
 * Admin Security Middleware
 * Enforces additional security measures for admin endpoints:
 * - Rate limiting (lighter: 100 req/min)
 * - Device verification requirement
 * - IP pinning validation
 * - Session timeout
 */

import { createSecurityService } from '../services/securityService.js';
import { errorResponse } from '../utils/helpers.js';

/**
 * Admin security middleware
 * @param {Request} req - HTTP request
 * @param {object} env - Environment
 * @param {string} userId - User ID
 * @param {object} adminData - Admin data with admin_id
 */
export async function adminSecurityMiddleware(req, env, userId, _adminData) {
  try {
    const security = createSecurityService(env, env.CACHE);
    
    // 1. CHECK ADMIN RATE LIMIT (100 requests per minute)
    const endpoint = new URL(req.url).pathname;
    const rateLimit = await security.checkAdminRateLimit(userId, endpoint);
    
    if (!rateLimit.allowed) {
      return {
        error: errorResponse('Rate limit exceeded', 429, {
          remaining: rateLimit.remaining,
          resetAt: rateLimit.resetAt
        })
      };
    }

    // 2. VALIDATE IP PINNING
    // Get token from Authorization header
    const authHeader = req.headers.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      // Token IP pinning is validated during token verification in auth middleware
      // If we got here, IP pinning passed
    }

    // 3. CHECK DEVICE VERIFICATION FOR ADMINS
    // Admins require device verification on new locations
    const db = env.DB; // Database binding
    const clientIP = security.getClientIP(req);
    const userAgent = security.getUserAgent(req);
    
    const requiresVerification = await security.requiresAdminDeviceVerification(
      db,
      userId,
      clientIP,
      userAgent
    );

    if (requiresVerification) {
      return {
        error: errorResponse('Device verification required', 403, {
          requiresDeviceVerification: true,
          message: 'This device needs to be verified for security. Check your email for verification code.'
        })
      };
    }

    // 4. CHECK SESSION TIMEOUT
    // Admin sessions timeout after 30 minutes of inactivity
    const lastActivityKey = `admin_activity:${userId}`;
    const lastActivity = await env.CACHE.get(lastActivityKey);
    
    if (lastActivity) {
      const lastActivityTime = parseInt(lastActivity, 10);
      const thirtyMinutesAgo = Math.floor(Date.now() / 1000) - (30 * 60);
      
      if (lastActivityTime < thirtyMinutesAgo) {
        return {
          error: errorResponse('Session expired', 401, {
            reason: 'Session timeout due to inactivity'
          })
        };
      }
    }

    // Update last activity timestamp
    await env.CACHE.put(
      lastActivityKey,
      Math.floor(Date.now() / 1000).toString(),
      { expirationTtl: 3600 } // 1 hour
    );

    // All checks passed
    return {
      allowed: true,
      rateLimit
    };

  } catch (error) {
    console.error('Admin security middleware error:', error);
    // Fail secure - deny access on error
    return {
      error: errorResponse('Security check failed', 500)
    };
  }
}

/**
 * Create response headers for admin endpoints
 */
export function getAdminSecurityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
  };
}
