// ============================================
// CSRF PROTECTION MIDDLEWARE
// Double Submit Cookie Pattern
// ============================================

import { errorResponse } from '../utils/helpers.js';

/**
 * CSRF Protection using Double Submit Cookie pattern
 * - Generates CSRF tokens tied to user session
 * - Validates tokens on state-changing operations (POST, PUT, DELETE, PATCH)
 * - Uses httpOnly cookie + request header validation
 */
export class CSRFProtection {
  constructor(env) {
    this.TOKEN_HEADER = 'X-CSRF-Token';
    this.TOKEN_COOKIE = 'csrf_token';
    this.TOKEN_LENGTH = 32;
    this.env = env;
  }

  /**
   * Generate a cryptographically secure CSRF token
   */
  generateToken() {
    const array = new Uint8Array(this.TOKEN_LENGTH);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Issue a CSRF token (called on login or session creation)
   * Returns the token and Set-Cookie header
   */
  issueToken() {
    const token = this.generateToken();

    // Detect if we're in a secure environment (HTTPS/production)
    const isSecureEnv = this.env?.CF_WORKER === '1' || 
                       this.env?.CF_PAGES === '1' ||
                       this.env?.VERCEL === '1' ||
                       this.env?.NODE_ENV === 'production' ||
                       this.env?.ENVIRONMENT === 'production';
    
    let cookieOptions = 'Path=/; HttpOnly; Max-Age=86400';
    
    if (isSecureEnv) {
      // Production: Allow cross-domain with HTTPS
      cookieOptions += '; Secure; SameSite=None';
    } else {
      // Development/local: Allow cross-origin without Secure flag
      cookieOptions += '; SameSite=Lax';
    }

    const cookieHeader = `${this.TOKEN_COOKIE}=${token}; ${cookieOptions}`;

    return {
      token,
      cookieHeader
    };
  }

  /**
   * Validate CSRF token for state-changing requests
   * @param {Request} request - The incoming request
   * @returns {boolean} - Whether the token is valid
   */
  validateToken(request) {
    // Extract token from cookie
    const cookieHeader = request.headers.get('Cookie') || '';
    const cookies = this.parseCookies(cookieHeader);
    const cookieToken = cookies[this.TOKEN_COOKIE];

    // Extract token from header
    const headerToken = request.headers.get(this.TOKEN_HEADER);

    // Both must exist and match
    if (!cookieToken || !headerToken) {
      console.warn('[CSRF] Missing token - cookie:', Boolean(cookieToken), 'header:', Boolean(headerToken));
      return false;
    }

    if (cookieToken !== headerToken) {
      console.warn('[CSRF] Token mismatch');
      return false;
    }

    return true;
  }

  /**
   * Middleware function for protecting routes
   * @param {Request} request - The incoming request
   * @returns {Response|null} - Returns error response if validation fails, null if passes
   */
  protect(request) {
    const method = request.method.toUpperCase();

    // Only protect state-changing methods
    const protectedMethods = ['POST', 'PUT', 'DELETE', 'PATCH'];
    if (!protectedMethods.includes(method)) {
      return null; // Allow safe methods (GET, HEAD, OPTIONS)
    }

    // Skip CSRF validation for Bearer token authentication (mobile apps)
    const authHeader = request.headers.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return null; // Bearer tokens are not vulnerable to CSRF
    }

    // For cross-domain requests, allow header-only validation
    // This handles cases where frontend and backend are on different domains
    const origin = request.headers.get('Origin') || request.headers.get('Referer') || '';
    const requestUrl = new URL(request.url);

    // Check if origin and request URL are on different hosts (cross-domain)
    let isCrossDomainRequest = false;
    if (origin) {
      try {
        const originUrl = new URL(origin);
        // Different hosts = cross-domain (includes localhost:3000 -> 127.0.0.1:8787)
        isCrossDomainRequest = originUrl.host !== requestUrl.host;
      } catch {
        // Invalid origin URL, treat as cross-domain for safety
        isCrossDomainRequest = true;
      }
    }

    if (isCrossDomainRequest) {
      // For cross-domain requests, only validate header token
      const headerToken = request.headers.get(this.TOKEN_HEADER);
      if (!headerToken) {
        console.warn('[CSRF] Cross-domain request missing header token');
        return errorResponse('CSRF token required', 403);
      }
      // Accept header-only validation for cross-domain
      return null;
    }

    // For same-domain requests, use full Double Submit Cookie validation
    if (!this.validateToken(request)) {
      return errorResponse('CSRF token validation failed', 403);
    }

    return null; // Validation passed
  }

  /**
   * Parse cookies from Cookie header
   */
  parseCookies(cookieHeader) {
    const cookies = {};

    if (!cookieHeader) return cookies;

    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      if (name && value) {
        cookies[name] = value;
      }
    });

    return cookies;
  }

  /**
   * Get CSRF token from request (for sending to client)
   */
  getTokenFromRequest(request) {
    const cookieHeader = request.headers.get('Cookie') || '';
    const cookies = this.parseCookies(cookieHeader);
    return cookies[this.TOKEN_COOKIE] || null;
  }
}

/**
 * Singleton instance - will be initialized with env when first used
 */
let csrfProtectionInstance = null;

export function getCsrfProtection(env) {
  if (!csrfProtectionInstance) {
    csrfProtectionInstance = new CSRFProtection(env);
  }
  return csrfProtectionInstance;
}

/**
 * Legacy export - throws helpful error if accidentally used
 * All usages have been updated to use getCsrfProtection(env)
 */
export const csrfProtection = {
  issueToken() {
    throw new Error('csrfProtection.issueToken() called without environment. Use getCsrfProtection(env).issueToken() instead.');
  },
  protect() {
    throw new Error('csrfProtection.protect() called without environment. Use getCsrfProtection(env).protect() instead.');
  }
};
