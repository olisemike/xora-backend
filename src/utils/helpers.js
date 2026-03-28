// ============================================
// DEVELOPMENT ENVIRONMENT FLAG
// ============================================
export const __DEV__ = process.env.NODE_ENV !== 'production';

/**
 * Convert snake_case keys to camelCase recursively
 */
export function toCamelCase(obj) {
  if (Array.isArray(obj)) {
    return obj.map(toCamelCase);
  }
  if (obj && typeof obj === 'object' && obj.constructor === Object) {
    const result = {};
    for (const key in obj) {
      if (!Object.hasOwn(obj, key)) continue;
      const camelKey = key.replace(/_(?:[a-z])/g, (match) => match[1].toUpperCase());
      result[camelKey] = toCamelCase(obj[key]);
    }
    return result;
  }
  return obj;
}
// ============================================
// CONSTANTS & CONFIGURATION
// ============================================

export const SUPPORTED_LANGUAGES = ['en', 'es', 'fr', 'ar', 'zh', 'pt', 'hi', 'de', 'ja', 'ru'];

export const FEED_BATCH_SIZES = [100, 500, 1000, 10000, 100000];

export const ENGAGEMENT_THRESHOLD = 10; // 10%
export const RECOVERY_THRESHOLD = 20; // 20%
export const DECAY_PERIOD_HOURS = 72;

export const WINDOW_INTEGRITY_HOURS = 1;
export const WINDOW_PRIMARY_HOURS = 2;
export const WINDOW_STABILITY_HOURS = 60;

export const NOTIFICATION_TYPES = {
  LIKE: 'like',
  COMMENT: 'comment',
  FOLLOW: 'follow',
  MENTION: 'mention',
  MESSAGE: 'message',
  SHARE: 'share',
  STORY_VIEW: 'story_view',
  LIVE_START: 'live_start'
};

export const REPORT_CATEGORIES = {
  SPAM: 'spam',
  ABUSE: 'abuse',
  NSFW: 'nsfw',
  VIOLENCE: 'violence',
  IMPERSONATION: 'impersonation',
  HARASSMENT: 'harassment',
  MISINFORMATION: 'misinformation',
  OTHER: 'other'
};

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Generate unique ID (ULID-like) with cryptographically secure random
 */
export function generateId(prefix = '') {
  const timestamp = Date.now().toString(36);
  // Use crypto.getRandomValues for secure random generation
  const array = new Uint8Array(10);
  crypto.getRandomValues(array);
  const randomStr = Array.from(array, b => b.toString(36)).join('').substring(0, 13);
  return prefix ? `${prefix}_${timestamp}${randomStr}` : `${timestamp}${randomStr}`;
}

/**
 * Get current timestamp in seconds
 */
export function now() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Safe parseInt with validation and bounds
 * @param {string} value - Value to parse
 * @param {number} defaultValue - Default if invalid
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 */
export function safeParseInt(value, defaultValue = 20, min = 1, max = 100) {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < min || parsed > max) {
    return defaultValue;
  }
  return parsed;
}

/**
 * Add hours to current time
 */
export function hoursFromNow(hours) {
  return now() + (hours * 3600);
}

/**
 * Check if timestamp is expired
 */
export function isExpired(timestamp) {
  return timestamp < now();
}

/**
 * Validate email format
 */
export function isValidEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

/**
 * Validate username (alphanumeric, underscore, hyphen, 3-30 chars)
 * Must start with alphanumeric character (not underscore or hyphen)
 */
export function isValidUsername(username) {
  const regex = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,29}$/;
  return regex.test(username);
}

/**
 * Sanitize text input
 */
export function sanitizeText(text, maxLength = 5000) {
  if (!text) return '';
  const trimmed = text.trim().substring(0, maxLength);
  const controlCharsRegex = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
  return trimmed.replace(controlCharsRegex, ''); // Remove control characters
}

/**
 * Extract hashtags from text
 */
export function extractHashtags(text) {
  if (!text) return [];
  const regex = /#(?<hashtag>[a-zA-Z0-9_]+)/g;
  const matches = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match.groups.hashtag.toLowerCase());
  }
  return matches;
}

/**
 * Extract mentions from text
 */
export function extractMentions(text) {
  if (!text) return [];
  const regex = /@(?<mention>[a-zA-Z0-9_]+)/g;
  const matches = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match.groups.mention.toLowerCase());
  }
  return matches;
}

/**
 * Format error response
 */
export function errorResponse(message, code = 400, details = null) {
  return {
    success: false,
    error: {
      message,
      code,
      details
    }
  };
}

/**
 * Get cache-control headers for non-cacheable responses (auth, user data, etc)
 * Prevents Cloudflare and browsers from caching sensitive data
 */
export function getNoCacheHeaders() {
  return {
    'Cache-Control': 'no-cache, no-store, must-revalidate, private, max-age=0, s-maxage=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    // Cloudflare-specific: prevent caching at edge
    'Surrogate-Control': 'no-cache, no-store, max-age=0',
    // Additional security headers
    'CDN-Cache-Control': 'no-cache, no-store, max-age=0',
    'X-Cache-Status': 'PRIVATE'
  };
}

/**
 * Format success response
 */
export function successResponse(data, message = null) {
  return {
    success: true,
    data: toCamelCase(data),
    ...(message && { message })
  };
}

/**
 * Parse cursor for pagination
 */
export function parseCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = atob(cursor);
    const data = JSON.parse(decoded);

    // Validate cursor data structure
    if (typeof data !== 'object' || data === null) return null;

    // Validate created_at is a number if present
    if (data.created_at !== undefined && typeof data.created_at !== 'number') {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * Create cursor for pagination
 */
export function createCursor(data) {
  return btoa(JSON.stringify(data));
}

/**
 * Validate language code
 */
export function isValidLanguage(lang) {
  return SUPPORTED_LANGUAGES.includes(lang);
}

/**
 * Get default language
 */
export function getDefaultLanguage(lang) {
  return isValidLanguage(lang) ? lang : 'en';
}

/**
 * Check if actor has permission
 */
export function canActAs(userId, actorType, actorId, pages) {
  if (actorType === 'user') {
    return actorId === userId;
  }
  if (actorType === 'page') {
    return pages.some(page => page.id === actorId && page.owner_id === userId);
  }
  return false;
}

/**
 * Check if two actors are blocked
 */
export async function areBlocked(db, actor1Type, actor1Id, actor2Type, actor2Id) {
  const result = await db.prepare(`
    SELECT COUNT(*) as count FROM blocks 
    WHERE (blocker_type = ? AND blocker_id = ? AND blocked_type = ? AND blocked_id = ?)
       OR (blocker_type = ? AND blocker_id = ? AND blocked_type = ? AND blocked_id = ?)
  `).bind(
    actor1Type, actor1Id, actor2Type, actor2Id,
    actor2Type, actor2Id, actor1Type, actor1Id
  ).first();
  
  return result.count > 0;
}

/**
 * Format user/page for response (hide sensitive data)
 */
export function formatActor(actor, type) {
  if (type === 'user') {
    return {
      id: actor.id,
      username: actor.username,
      name: actor.name,
      avatar_url: actor.avatar_url,
      verified: actor.verified,
      type: 'user'
    };
  }
  return {
    id: actor.id,
    name: actor.name,
    avatar_url: actor.avatar_url,
    verified: actor.verified,
    type: 'page'
    // NEVER include owner_id
  };
}

/**
 * Calculate engagement rate
 */
export function calculateEngagementRate(impressions, engagements) {
  if (impressions === 0) return 0;
  return (engagements / impressions) * 100;
}

/**
 * Get next batch size
 */
export function getNextBatchSize(currentSize, shouldPromote) {
  const currentIndex = FEED_BATCH_SIZES.indexOf(currentSize);
  
  if (shouldPromote) {
    // Promote to next higher batch
    if (currentIndex < FEED_BATCH_SIZES.length - 1) {
      return FEED_BATCH_SIZES[currentIndex + 1];
    }
    return currentSize; // Already at max
  }
  // Demote to previous batch
  if (currentIndex > 0) {
    return FEED_BATCH_SIZES[currentIndex - 1];
  }
  return currentSize; // Already at min
}

/**
 * Check if post qualifies for trending
 */
export function isTrending(batchSize, engagementRate, windowType) {
  return (
    batchSize === FEED_BATCH_SIZES[FEED_BATCH_SIZES.length - 1] && // Max batch size
    engagementRate >= ENGAGEMENT_THRESHOLD &&
    windowType === 'stability'
  );
}

/**
 * Hash password using bcrypt
 */
export async function hashPassword(password) {
  const bcrypt = await import('bcryptjs');
  const saltRounds = 12; // Industry standard: 10-12 rounds
  return await bcrypt.hash(password, saltRounds);
}

/**
 * Verify password against bcrypt hash
 */
export async function verifyPassword(password, hash) {
  const bcrypt = await import('bcryptjs');
  return await bcrypt.compare(password, hash);
}

/**
 * Generate random code (for email verification)
 * Uses crypto.getRandomValues for secure randomness
 */
export function generateCode(length = 6) {
  const chars = '0123456789';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[array[i] % chars.length];
  }
  return code;
}

/**
 * Generate random token
 */
export function generateToken(length = 32) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Sleep/delay function
 */
// eslint-disable-next-line promise/avoid-new
export function sleep(ms) {
  // eslint-disable-next-line promise/avoid-new
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Safe JSON parse with fallback
 * Prevents crashes from malformed JSON data
 * @param {string} jsonString - JSON string to parse
 * @param {*} fallback - Fallback value if parsing fails (default: null)
 * @returns {*} Parsed JSON or fallback value
 */
export function safeJsonParse(jsonString, fallback = null) {
  if (!jsonString || typeof jsonString !== 'string') {
    return fallback;
  }
  try {
    return JSON.parse(jsonString);
  } catch {
    return fallback;
  }
}

/**
 * Safe JSON parse for arrays (returns empty array on failure)
 * @param {string} jsonString - JSON string to parse
 * @returns {Array} Parsed array or empty array
 */
export function safeJsonParseArray(jsonString) {
  const result = safeJsonParse(jsonString, []);
  return Array.isArray(result) ? result : [];
}
