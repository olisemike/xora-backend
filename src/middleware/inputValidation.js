// ============================================
// INPUT VALIDATION MIDDLEWARE
// Validates and sanitizes user input
// ============================================

import { errorResponse } from '../utils/helpers.js';

/**
 * Input validation utilities
 */
export class InputValidator {
  /**
   * Validate email format
   */
  static isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email) && email.length <= 255;
  }

  /**
   * Validate username format
   * - 3-30 characters
   * - Alphanumeric, underscore, hyphen only
   * - Must start with letter or number
   */
  static isValidUsername(username) {
    if (!username || typeof username !== 'string') return false;
    const usernameRegex = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,29}$/;
    return usernameRegex.test(username);
  }

  /**
   * Validate password strength
   * - Minimum 8 characters
   * - At least one number
   * - Block common weak patterns
   */
  static isValidPassword(password) {
    if (!password || typeof password !== 'string') return false;
    if (password.length < 8 || password.length > 128) return false;

    // Block common weak patterns
    const commonPatterns = [
      /^password/i, /^admin/i, /^welcome/i, /^qwerty/i,
      /123456/, /^(.)\1{2,}/,  // repeated chars like 'aaa'
    ];
    if (commonPatterns.some(p => p.test(password))) return false;

    const hasNumber = /[0-9]/.test(password);
    return hasNumber;
  }

  /**
   * Validate name (display name)
   * - 1-100 characters
   * - Letters, numbers, spaces, common punctuation
   */
  static isValidName(name) {
    if (!name || typeof name !== 'string') return false;
    if (name.length < 1 || name.length > 100) return false;

    // Allow letters (including Unicode), numbers, spaces, and common punctuation
    const nameRegex = /^[\p{L}\p{N}\s.'"-]+$/u;
    return nameRegex.test(name.trim());
  }

  /**
   * Validate bio/description
   * - 0-500 characters
   */
  static isValidBio(bio) {
    if (!bio) return true; // Bio is optional
    if (typeof bio !== 'string') return false;
    return bio.length <= 500;
  }

  /**
   * Validate URL
   */
  static isValidURL(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const parsed = new URL(url);
      return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  }

  /**
   * Validate post content
   * - 1-10000 characters
   */
  static isValidPostContent(content) {
    if (!content || typeof content !== 'string') return false;
    const trimmed = content.trim();
    return trimmed.length >= 1 && trimmed.length <= 10000;
  }

  /**
   * Validate comment content
   * - 1-2000 characters
   */
  static isValidCommentContent(content) {
    if (!content || typeof content !== 'string') return false;
    const trimmed = content.trim();
    return trimmed.length >= 1 && trimmed.length <= 2000;
  }

  /**
   * Validate hashtag
   * - 1-50 characters
   * - Alphanumeric and underscore only
   */
  static isValidHashtag(tag) {
    if (!tag || typeof tag !== 'string') return false;
    const tagRegex = /^[a-zA-Z0-9_]{1,50}$/;
    return tagRegex.test(tag);
  }

  /**
   * Sanitize string input (remove null bytes, control characters)
   */
  static sanitizeString(input) {
    if (typeof input !== 'string') return input;

    // Remove null bytes and control characters (except newlines and tabs)
    const withoutNulls = input.replace(/\x00/g, '');
    // Explicitly match control characters by hexadecimal range to satisfy linting
    const controlCharsRegex = /[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g;
    return withoutNulls.replace(controlCharsRegex, '').trim();
  }

  /**
   * Validate integer within range
   */
  static isValidInteger(value, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
    const num = parseInt(value, 10);
    return Number.isInteger(num) && num >= min && num <= max;
  }

  /**
   * Validate UUID format
   */
  static isValidUUID(uuid) {
    if (!uuid || typeof uuid !== 'string') return false;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }

  /**
   * Validate enum value
   */
  static isValidEnum(value, allowedValues) {
    return allowedValues.includes(value);
  }
}

/**
 * Validation middleware factory
 * Creates middleware for validating request body fields
 */
export function validateRequest(schema) {
  return async (request) => {
    try {
      const contentType = request.headers.get('Content-Type') || '';

      // Only validate JSON requests
      if (!contentType.includes('application/json')) {
        return null; // Skip validation for non-JSON requests
      }

      let body;
      try {
        body = await request.clone().json();
      } catch {
        return errorResponse('Invalid JSON in request body', 400);
      }

      // Validate each field in schema
      const errors = [];

      for (const [field, rules] of Object.entries(schema)) {
        const value = body[field];

        // Check required fields
        if (rules.required && (value === undefined || value === null || value === '')) {
          errors.push(`${field} is required`);
          continue;
        }

        // Skip validation if optional and not provided
        if (!rules.required && (value === undefined || value === null || value === '')) {
          continue;
        }

        // Apply validation rules
        if (rules.type === 'email' && !InputValidator.isValidEmail(value)) {
          errors.push(`${field} must be a valid email address`);
        }

        if (rules.type === 'username' && !InputValidator.isValidUsername(value)) {
          errors.push(`${field} must be a valid username (3-30 characters, alphanumeric, underscore, hyphen)`);
        }

        if (rules.type === 'password' && !InputValidator.isValidPassword(value)) {
          errors.push(`${field} must be at least 8 characters and include at least one number`);
        }

        if (rules.type === 'name' && !InputValidator.isValidName(value)) {
          errors.push(`${field} must be 1-100 characters`);
        }

        if (rules.type === 'bio' && !InputValidator.isValidBio(value)) {
          errors.push(`${field} must be at most 500 characters`);
        }

        if (rules.type === 'url' && !InputValidator.isValidURL(value)) {
          errors.push(`${field} must be a valid URL`);
        }

        if (rules.type === 'postContent' && !InputValidator.isValidPostContent(value)) {
          errors.push(`${field} must be 1-10000 characters`);
        }

        if (rules.type === 'commentContent' && !InputValidator.isValidCommentContent(value)) {
          errors.push(`${field} must be 1-2000 characters`);
        }

        if (rules.type === 'hashtag' && !InputValidator.isValidHashtag(value)) {
          errors.push(`${field} must be a valid hashtag (1-50 alphanumeric characters)`);
        }

        if (rules.type === 'uuid' && !InputValidator.isValidUUID(value)) {
          errors.push(`${field} must be a valid UUID`);
        }

        if (rules.type === 'integer') {
          const min = rules.min !== undefined ? rules.min : Number.MIN_SAFE_INTEGER;
          const max = rules.max !== undefined ? rules.max : Number.MAX_SAFE_INTEGER;
          if (!InputValidator.isValidInteger(value, min, max)) {
            errors.push(`${field} must be an integer between ${min} and ${max}`);
          }
        }

        if (rules.type === 'enum' && !InputValidator.isValidEnum(value, rules.values)) {
          errors.push(`${field} must be one of: ${rules.values.join(', ')}`);
        }

        if (rules.type === 'string') {
          if (typeof value !== 'string') {
            errors.push(`${field} must be a string`);
          } else {
            const sanitized = InputValidator.sanitizeString(value);
            if (rules.minLength && sanitized.length < rules.minLength) {
              errors.push(`${field} must be at least ${rules.minLength} characters`);
            }
            if (rules.maxLength && sanitized.length > rules.maxLength) {
              errors.push(`${field} must be at most ${rules.maxLength} characters`);
            }
          }
        }

        if (rules.type === 'boolean' && typeof value !== 'boolean') {
          errors.push(`${field} must be a boolean`);
        }

        if (rules.type === 'array') {
          if (!Array.isArray(value)) {
            errors.push(`${field} must be an array`);
          } else {
            if (rules.minLength && value.length < rules.minLength) {
              errors.push(`${field} must have at least ${rules.minLength} items`);
            }
            if (rules.maxLength && value.length > rules.maxLength) {
              errors.push(`${field} must have at most ${rules.maxLength} items`);
            }
          }
        }

        // Custom validator function
        if (rules.custom && typeof rules.custom === 'function') {
          const customError = rules.custom(value);
          if (customError) {
            errors.push(customError);
          }
        }
      }

      if (errors.length > 0) {
        return errorResponse(`Validation failed: ${errors.join(', ')}`, 400);
      }

      return null; // Validation passed
    } catch (error) {
      console.error('Validation middleware error:', error);
      return errorResponse('Validation error', 500);
    }
  };
}

/**
 * Common validation schemas
 */
export const ValidationSchemas = {
  // User registration
  register: {
    email: { required: true, type: 'email' },
    username: { required: true, type: 'username' },
    password: { required: true, type: 'password' },
    name: { required: true, type: 'name' }
  },

  // User login
  login: {
    identifier: { required: true, type: 'string', minLength: 3 },
    password: { required: true, type: 'string', minLength: 1 },
    deviceInfo: { required: false, type: 'object' } // Optional device fingerprinting
  },

  // Create post (aligned with posts.js controller)
  createPost: {
    content: { required: false, type: 'postContent' },  // Optional - can have media without content
    mediaUrls: { required: false, type: 'array', maxLength: 10 },  // Changed from media_urls to match controller
    mediaType: { required: false, type: 'string' },
    actorType: { required: true, type: 'enum', values: ['user', 'page'] },
    actorId: { required: true, type: 'string', minLength: 1 },
    language: { required: false, type: 'string', maxLength: 10 },
    isSensitive: { required: false, type: 'boolean' },
    sensitive: { required: false, type: 'boolean' }  // Alias for isSensitive
  },

  // Create story (aligned with stories.js controller)
  createStory: {
    mediaUrl: { required: true, type: 'string', minLength: 1 },
    mediaType: { required: true, type: 'enum', values: ['image', 'video'] },
    actorType: { required: true, type: 'enum', values: ['user', 'page'] },
    actorId: { required: true, type: 'string', minLength: 1 },
    duration: { required: false, type: 'number' },
    isSensitive: { required: false, type: 'boolean' },
    sensitive: { required: false, type: 'boolean' }  // Alias for isSensitive
  },

  // Create comment (aligned with comments.js controller)
  createComment: {
    content: { required: false, type: 'commentContent' },  // Optional - can have media without content
    mediaUrls: { required: false, type: 'array', maxLength: 10 },  // Optional media attachments
    actorType: { required: false, type: 'enum', values: ['user', 'page'] },
    actorId: { required: false, type: 'string', minLength: 1 },
    parentId: { required: false, type: 'string', minLength: 1 }  // For nested comments
  },

  // Update profile
  updateProfile: {
    name: { required: false, type: 'name' },
    bio: { required: false, type: 'bio' },
    website: { required: false, type: 'url' },
    location: { required: false, type: 'string', maxLength: 100 }
  },

  // Auth endpoints
  refresh: {
    refreshToken: { required: false, type: 'string', minLength: 1 } // Can come from cookie or body
  },

  forgotPassword: {
    email: { required: true, type: 'email' }
  },

  resetPassword: {
    email: { required: true, type: 'email' },
    code: { required: true, type: 'string', minLength: 1 },
    newPassword: { required: true, type: 'password' }
  },

  changePassword: {
    currentPassword: { required: true, type: 'string', minLength: 1 },
    newPassword: { required: true, type: 'password' }
  },

  sendVerification: {
    email: { required: true, type: 'email' }
  },

  verifyEmail: {
    token: { required: true, type: 'string', minLength: 1 }
  },

  enable2FA: {
    // No password required to initiate 2FA setup - user is already authenticated
    // Password is only required when disabling 2FA for security
  },

  verify2FASetup: {
    code: { required: true, type: 'string', minLength: 6, maxLength: 6 }
  },

  disable2FA: {
    password: { required: true, type: 'string', minLength: 1 },
    code: { required: true, type: 'string', minLength: 6, maxLength: 6 }
  },

  regenerateBackupCodes: {
    password: { required: true, type: 'string', minLength: 1 }
  },

  verifyDevice: {
    tempToken: { required: true, type: 'string', minLength: 1 },
    verificationCode: { required: true, type: 'string', minLength: 1 }
  },

  // Admin endpoints
  resolveReport: {
    resolution: { required: true, type: 'string', minLength: 1, maxLength: 1000 }
  },

  banUser: {
    reason: { required: true, type: 'string', minLength: 1, maxLength: 500 },
    duration: { required: false, type: 'number', min: 1, max: 525600 }, // minutes (1 year max)
    permanent: { required: false, type: 'boolean' }
  },

  moderateAd: {
    action: { required: true, type: 'enum', values: ['approve', 'reject'] },
    moderationNotes: { required: false, type: 'string', maxLength: 1000 },
    rejectionReason: { required: false, type: 'string', maxLength: 1000 }
  },

  toggleAd: {
    status: { required: true, type: 'enum', values: ['active', 'paused', 'inactive'] }
  }
};
