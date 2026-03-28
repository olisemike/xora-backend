/**
 * Security Service
 * Handles advanced security features:
 * - Failed login tracking
 * - reCAPTCHA verification (signup only)
 * - Admin rate limiting
 * - Device verification for admins
 * - Disposable email domain blocking
 */

import { now } from '../utils/helpers.js';

/**
 * List of known disposable/temporary email domains
 * These are blocked during signup to prevent spam accounts
 */
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  // Popular disposable email services
  '10minutemail.com', '10minutemail.net', '10minmail.com',
  'guerrillamail.com', 'guerrillamail.org', 'guerrillamail.net', 'guerrillamail.biz',
  'mailinator.com', 'mailinater.com', 'mailinator2.com',
  'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempail.com',
  'throwaway.email', 'throwawaymail.com',
  'fakeinbox.com', 'fakemailgenerator.com',
  'getnada.com', 'nada.email',
  'mohmal.com', 'mohmal.im',
  'dispostable.com', 'disposablemail.com',
  'yopmail.com', 'yopmail.fr', 'yopmail.net',
  'mailnesia.com', 'mailnesia.net',
  'trashmail.com', 'trashmail.net', 'trashmail.org', 'trashmail.me',
  'sharklasers.com', 'guerrillamailblock.com',
  'spam4.me', 'spamgourmet.com',
  'discard.email', 'discardmail.com',
  'maildrop.cc', 'mailsac.com',
  'getairmail.com', 'airmail.cc',
  'emailondeck.com', 'anonymbox.com',
  'tempinbox.com', 'tempr.email',
  'mytemp.email', 'tmpmail.org', 'tmpmail.net',
  'emailfake.com', 'crazymailing.com',
  'mintemail.com', 'boun.cr', 'bouncr.com',
  'spambox.us', 'spamfree24.org',
  'tempmailaddress.com', 'tempmailer.com',
  'throwam.com', 'trbvm.com',
  'wegwerfmail.de', 'wegwerfmail.net', 'wegwerfmail.org',
  'mailcatch.com', 'mailexpire.com',
  'mailnull.com', 'meltmail.com',
  'myspamless.com', 'mytempemail.com',
  'neverbox.com', 'no-spam.ws',
  'nobulk.com', 'noclickemail.com',
  'nomail2me.com', 'nomorespamemails.com',
  'notmailinator.com', 'nowmymail.com',
  'spambob.com', 'spambob.net', 'spambob.org',
  'spambox.info', 'spamcannon.com', 'spamcannon.net',
  'spamcon.org', 'spamcowboy.com', 'spamcowboy.net',
  'spamex.com', 'spamfree.eu', 'spamfree24.com',
  'spamgoes.in', 'spaml.com', 'spaml.de',
  'spammotel.com', 'spamobox.com', 'spamoff.de',
  'spamspot.com', 'spamstack.net', 'spamtroll.net',
  'superrito.com', 'suremail.info',
  'teleworm.com', 'teleworm.us',
  'tempail.com', 'tempalias.com',
  'tempemail.biz', 'tempemail.com', 'tempemail.net',
  'tempinbox.co.uk', 'tempmail.co',
  'tempomail.fr', 'temporarily.de',
  'temporaryemail.net', 'temporaryemail.us',
  'temporaryinbox.com', 'temporarymailaddress.com',
  'thanksnospam.info', 'thisisnotmyrealemail.com',
  'throwawayemailaddress.com', 'tmail.ws', 'tmailinator.com',
  'trash2009.com', 'trash-mail.com', 'trash-mail.de',
  'trashbox.eu', 'trashcanmail.com', 'trashdevil.com',
  'trashemail.de', 'trashmail.at', 'trashmail.ws',
  'trashmailer.com', 'trashymail.com', 'trashymail.net',
  'mailforspam.com', 'mailscrap.com', 'mailshell.com',
  'mailzilla.com', 'mailzilla.org',
  'sneakemail.com', 'sneakmail.de', 'snkmail.com',
  'sofort-mail.de', 'spam.la', 'spam.su',
  'privacy.net', 'privy-mail.de', 'privymail.de',
  'proxymail.eu', 'putthisinyourspamdatabase.com',
  'quickinbox.com', 'rejectmail.com',
  'rhyta.com', 'rklips.com', 'rmqkr.net',
  'safe-mail.net', 'safersignup.de', 'safetymail.info',
  'saynotospams.com', 'selfdestructingmail.com',
  'shieldemail.com', 'shiftmail.com', 'shitmail.me',
  'shortmail.net', 'shut.name', 'shuttlemail.com',
  'sinnlos-mail.de', 'slaskpost.se', 'slopsbox.com',
  'sogetthis.com', 'soodonims.com',
  'speed.1s.fr', 'spoofmail.de', 'squizzy.de',
  'stop-my-spam.com', 'streetwisemail.com', 'stuffmail.de',
  'supergreatmail.com', 'supermailer.jp'
]);

export class SecurityService {
  constructor(env, cache) {
    this.env = env;
    this.cache = cache;
  }

  /**
   * Record failed login attempt
   * @param {string} emailOrUsername - User email or username
   * @param {string} clientIP - Client IP address
   * @returns {Promise<number>} - Number of failed attempts
   */
  async recordFailedLogin(emailOrUsername, clientIP) {
    try {
      if (!this.cache) {
        console.warn('Cache not available, skipping login attempt recording');
        return 0;
      }

      const key = `login_attempts:${emailOrUsername}:${clientIP}`;
      const current = await this.cache.get(key);
      const attempts = current ? parseInt(current, 10) + 1 : 1;

      // Store for 15 minutes
      await this.cache.put(key, attempts.toString(), { expirationTtl: 900 });

      return attempts;
    } catch (error) {
      console.error('Failed to record login attempt:', error);
      return 0;
    }
  }

  /**
   * Clear failed login attempts
   * @param {string} emailOrUsername - User email or username
   * @param {string} clientIP - Client IP address
   */
  async clearFailedLogins(emailOrUsername, clientIP) {
    try {
      if (!this.cache) return;

      const key = `login_attempts:${emailOrUsername}:${clientIP}`;
      await this.cache.delete(key);
    } catch (error) {
      console.error('Failed to clear login attempts:', error);
    }
  }

  /**
   * Check admin rate limit
   * Lighter rate limit for admin endpoints: 100 requests per minute
   * @param {string} adminId - Admin user ID
   * @param {string} endpoint - API endpoint
   * @returns {Promise<{allowed: boolean, remaining: number, resetAt: number}>}
   */
  async checkAdminRateLimit(adminId, endpoint) {
    try {
      if (!this.cache) {
        console.warn('Cache not available, skipping admin rate limit');
        return { allowed: true, remaining: 100, resetAt: now() + 60 };
      }

      const key = `admin_rate:${adminId}:${endpoint}`;
      const current = await this.cache.get(key);
      const requests = current ? parseInt(current, 10) + 1 : 1;

      const allowed = requests <= 100; // 100 requests per minute
      const resetAt = now() + 60;

      if (allowed) {
        // Store for 60 seconds
        await this.cache.put(key, requests.toString(), { expirationTtl: 60 });
      }

      return {
        allowed,
        remaining: Math.max(0, 100 - requests),
        resetAt
      };
    } catch (error) {
      console.error('Admin rate limit check error:', error);
      return { allowed: true, remaining: 100, resetAt: now() + 60 }; // Fail open
    }
  }

  /**
   * Require device verification for admin login
   * Admins must verify new devices with email code
   * @param {object} db - Database instance
   * @param {string} userId - User ID
   * @param {string} email - User email
   * @param {string} clientIP - Client IP
   * @param {string} userAgent - User agent string
   * @returns {Promise<boolean>} - true if device verification required
   */
  async requiresAdminDeviceVerification(db, userId, clientIP, userAgent) {
    try {
      // Check if device is already verified
      const verified = await db.prepare(`
        SELECT id FROM verified_devices
        WHERE user_id = ? AND ip_address = ? AND user_agent = ?
        AND last_used > datetime('now', '-30 days')
      `).bind(userId, clientIP, userAgent).first();

      // Device not verified or not used in last 30 days
      return !verified;
    } catch (error) {
      console.error('Device verification check error:', error);
      return true; // Require verification on error (safer)
    }
  }

  /**
   * Get client IP from request
   * Handles proxies and cloud environments
   * @param {Request} request - HTTP request
   * @returns {string} - Client IP address
   */
  getClientIP(request) {
    // Check Cloudflare headers first (production)
    const cfConnectingIP = request.headers.get('CF-Connecting-IP');
    if (cfConnectingIP) return cfConnectingIP;

    // Check X-Forwarded-For (can be comma-separated)
    const forwarded = request.headers.get('X-Forwarded-For');
    if (forwarded) return forwarded.split(',')[0].trim();

    // Check X-Real-IP
    const realIP = request.headers.get('X-Real-IP');
    if (realIP) return realIP;

    // Fallback for local development
    return '127.0.0.1';
  }

  /**
   * Get user agent from request
   * @param {Request} request - HTTP request
   * @returns {string} - User agent string
   */
  getUserAgent(request) {
    return request.headers.get('User-Agent') || 'unknown';
  }

  /**
   * Check if email domain is a disposable/temporary email service
   * @param {string} email - Email address to check
   * @returns {boolean} - true if disposable email domain
   */
  isDisposableEmail(email) {
    if (!email || typeof email !== 'string') return false;

    const [, domain] = email.toLowerCase().split('@');
    if (!domain) return false;

    return DISPOSABLE_EMAIL_DOMAINS.has(domain);
  }

}

/**
 * Create security service instance
 */
export function createSecurityService(env, cache) {
  return new SecurityService(env, cache);
}
