// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================

import { verifyToken } from '../services/jwt.js';
import { errorResponse } from '../utils/helpers.js';
import { safeJsonParse } from '../utils/validation.js';

// Cache TTL for user auth data (5 minutes - reduce KV writes on free tier)
// Note: If user is banned or token invalidated, there may be up to 5 min delay
const AUTH_CACHE_TTL = 300;

/**
 * Get cached user auth data from KV (token_version, is_banned, banned_until)
 * Returns null if not cached or expired
 */
async function getCachedUserAuth(env, userId) {
  if (!env.CACHE) return null;
  try {
    const cached = await env.CACHE.get(`auth:user:${userId}`);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch {
    // Ignore cache errors, fall back to DB
  }
  return null;
}

/**
 * Cache user auth data in KV
 */
async function setCachedUserAuth(env, userId, data) {
  if (!env.CACHE) return;
  try {
    await env.CACHE.put(`auth:user:${userId}`, JSON.stringify(data), {
      expirationTtl: AUTH_CACHE_TTL
    });
  } catch {
    // Ignore cache errors
  }
}

/**
 * Extract access token from request (cookie first, then Authorization header)
 * @param {Request} request
 * @returns {string|null}
 */
function getAccessToken(request) {
  // Try httpOnly cookie first (web clients)
  const cookies = request.headers.get('Cookie') || '';
  const cookieToken = cookies.match(/xora_access_token=(?<token>[^;]+)/)?.groups?.token;
  if (cookieToken) {
    return cookieToken;
  }

  // Fall back to Authorization header (mobile clients)
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  return null;
}

/**
 * Verify JWT token and attach user to request
 * Supports both httpOnly cookies (web) and Authorization header (mobile)
 */
export async function authMiddleware(request, env) {
  const token = getAccessToken(request);

  if (!token) {
    return {
      error: errorResponse('Authentication required', 401)
    };
  }
  const payload = await verifyToken(token);

  if (!payload || payload.type !== 'access') {
    return {
      error: errorResponse('Invalid or expired token', 401)
    };
  }

  // If token carries a tokenVersion, ensure it matches the user's current token_version
  // Also check if user is banned - use KV cache to reduce DB hits
  try {
    // Try cache first
    let user = await getCachedUserAuth(env, payload.userId);

    if (!user) {
      // Cache miss - query DB
      user = await env.DB.prepare(`
        SELECT token_version, is_banned, banned_until FROM users WHERE id = ?
      `).bind(payload.userId).first();

      if (!user) {
        return {
          error: errorResponse('Invalid or expired token', 401)
        };
      }

      // Cache the result for future requests
      await setCachedUserAuth(env, payload.userId, user);
    }

    // Check if user is banned
    if (user.is_banned) {
      const currentTime = Math.floor(Date.now() / 1000);
      // If banned_until is null, it's a permanent ban
      // If banned_until is in the future, user is still banned
      if (!user.banned_until || user.banned_until > currentTime) {
        return {
          error: errorResponse('Your account has been suspended', 403)
        };
      }
    }

    // Validate token version if present
    if (typeof payload.tokenVersion !== 'undefined' && payload.tokenVersion !== user.token_version) {
      return {
        error: errorResponse('Invalid or expired token', 401)
      };
    }
  } catch (err) {
    console.error('authMiddleware user check failed:', err);
    return {
      error: errorResponse('Invalid or expired token', 401)
    };
  }

  // Attach user info to request
  return {
    userId: payload.userId,
    email: payload.email
  };
}

/**
 * Optional auth - don't fail if no token
 * Supports both httpOnly cookies (web) and Authorization header (mobile)
 */
export async function optionalAuthMiddleware(request, env) {
  const token = getAccessToken(request);

  if (!token) {
    return { userId: null };
  }

  const payload = await verifyToken(token);

  if (!payload || payload.type !== 'access') {
    return { userId: null };
  }

  // Check token version and ban status - use KV cache
  try {
    // Try cache first
    let user = await getCachedUserAuth(env, payload.userId);

    if (!user) {
      // Cache miss - query DB
      user = await env.DB.prepare(`
        SELECT token_version, is_banned, banned_until FROM users WHERE id = ?
      `).bind(payload.userId).first();

      if (!user) {
        return { userId: null };
      }

      // Cache the result
      await setCachedUserAuth(env, payload.userId, user);
    }

    // Check if user is banned - treat as unauthenticated for optional auth
    if (user.is_banned) {
      const currentTime = Math.floor(Date.now() / 1000);
      if (!user.banned_until || user.banned_until > currentTime) {
        return { userId: null };
      }
    }

    // Validate token version if present
    if (typeof payload.tokenVersion !== 'undefined' && payload.tokenVersion !== user.token_version) {
      return { userId: null };
    }
  } catch (err) {
    console.error('optionalAuthMiddleware user check failed:', err);
    return { userId: null };
  }

  return {
    userId: payload.userId,
    email: payload.email
  };
}

/**
 * Admin middleware - check if user is admin
 */
export async function adminMiddleware(request, env, userId) {
  const db = env.DB;

  const admin = await db.prepare(`
    SELECT * FROM admin_users WHERE user_id = ?
  `).bind(userId).first();

  if (!admin) {
    return {
      error: errorResponse('Admin access required', 403)
    };
  }

  // Safely parse permissions with fallback
  const permissions = safeJsonParse(admin.permissions, []);

  // Ensure permissions is always an array
  const validPermissions = Array.isArray(permissions) ? permissions : [];

  return {
    adminId: admin.id,
    userId: userId,  // The actual user ID for foreign key references
    role: admin.role || 'moderator', // Fallback role
    permissions: validPermissions,
    // Helper method to check permissions safely
    hasPermission: (permission) => {
      return validPermissions.includes('all') || validPermissions.includes(permission);
    }
  };
}
