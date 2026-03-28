// Input Validation Helpers
// Comprehensive validation to prevent XSS, injection attacks, and crashes

/**
 * SECURITY: Whitelist of allowed table names for SQL operations
 * Prevents SQL injection through table name parameters
 */
export const ALLOWED_TABLES = new Set([
  // Core user tables
  'users',
  'user_settings',
  'user_preferences',

  // Content tables
  'posts',
  'comments',
  'reels',
  'stories',
  'pages',

  // Engagement tables
  'likes',
  'shares',
  'bookmarks',
  'follows',
  'blocks',

  // Messaging tables
  'messages',
  'conversations',
  'conversation_participants',

  // Notification tables
  'notifications',
  'push_subscriptions',

  // Media tables
  'media',
  'media_uploads',

  // Hashtags and trends
  'hashtags',
  'post_hashtags',
  'trending_posts',

  // Algorithm tables
  'post_exposures',
  'post_suggestion_batches',

  // Admin tables
  'admin_users',
  'admin_audit_logs',
  'reports',

  // Advertisement tables
  'advertisements',
  'ad_impressions',
  'ad_analytics_daily',
  'user_ad_frequency',

  // Integration tables
  'social_media_imports',

  // Session tables
  'refresh_tokens'
]);

/**
 * Validate table name against whitelist (SQL injection prevention)
 * @param {string} tableName - The table name to validate
 * @returns {boolean} - True if valid, false otherwise
 */
export function isValidTableName(tableName) {
  if (!tableName || typeof tableName !== 'string') return false;

  // Must be alphanumeric with underscores only (additional safety check)
  const validPattern = /^[a-z_][a-z0-9_]*$/i;
  if (!validPattern.test(tableName)) return false;

  // Must be in whitelist
  return ALLOWED_TABLES.has(tableName.toLowerCase());
}

/**
 * Get validated table name or throw error
 * @param {string} tableName - The table name to validate
 * @returns {string} - The validated table name (lowercase)
 * @throws {Error} - If table name is invalid
 */
export function validateTableName(tableName) {
  if (!isValidTableName(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }
  return tableName.toLowerCase();
}

/**
 * Validate URL format
 */
export function isValidUrl(url, allowedProtocols = ['http:', 'https:']) {
  if (!url || typeof url !== 'string') return false;

  try {
    const parsed = new URL(url);
    return allowedProtocols.includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Validate email format
 */
export function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 254;
}

/**
 * Validate string length
 */
export function isValidLength(str, min, max) {
  if (typeof str !== 'string') return false;
  return str.length >= min && str.length <= max;
}

/**
 * Validate numeric range
 */
export function isInRange(num, min, max) {
  if (typeof num !== 'number' || isNaN(num)) return false;
  return num >= min && num <= max;
}

/**
 * Validate integer
 */
export function isInteger(value) {
  return Number.isInteger(value);
}

/**
 * Validate positive integer
 */
export function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * Validate non-negative integer
 */
export function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Sanitize HTML/Script content to prevent XSS
 * Removes dangerous tags and attributes
 */
export function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') return '';

  // Remove script tags and their content
  let sanitized = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

  // Remove event handlers (onclick, onerror, etc.)
  sanitized = sanitized.replace(/on\w+\s*=\s*["'][^"']*["']/gi, '');
  sanitized = sanitized.replace(/on\w+\s*=\s*[^\s>]*/gi, '');

  // Remove javascript: protocol
  sanitized = sanitized.replace(/javascript:/gi, '');

  // Remove data: protocol (can be used for XSS)
  sanitized = sanitized.replace(/data:text\/html/gi, '');

  return sanitized;
}

/**
 * Validate advertisement data
 */
export function validateAdvertisement(data) {
  const errors = [];

  // Required fields
  if (!data.title || !isValidLength(data.title, 1, 200)) {
    errors.push('Title must be between 1 and 200 characters');
  }

  if (data.description && !isValidLength(data.description, 0, 1000)) {
    errors.push('Description must not exceed 1000 characters');
  }

  // Ad type validation
  const validAdTypes = ['image', 'video', 'script', 'sdk'];
  if (!validAdTypes.includes(data.adType)) {
    errors.push('Ad type must be one of: image, video, script, sdk');
  }

  // Content URL validation
  if (data.contentUrl && !isValidUrl(data.contentUrl)) {
    errors.push('Invalid content URL');
  }

  // Script content validation (for script ads)
  if (data.adType === 'script') {
    if (!data.scriptContent || !isValidLength(data.scriptContent, 1, 10000)) {
      errors.push('Script content must be between 1 and 10000 characters');
    }
    // Sanitize script content
    if (data.scriptContent) {
      // eslint-disable-next-line no-param-reassign
      data.scriptContent = sanitizeHtml(data.scriptContent);
    }
  }

  // SDK validation (for SDK ads)
  if (data.adType === 'sdk') {
    if (!data.sdkProvider || !isValidLength(data.sdkProvider, 1, 50)) {
      errors.push('SDK provider must be between 1 and 50 characters');
    }
    if (!data.sdkAdUnitId || !isValidLength(data.sdkAdUnitId, 1, 100)) {
      errors.push('SDK ad unit ID must be between 1 and 100 characters');
    }
    if (data.sdkConfig) {
      try {
        JSON.parse(data.sdkConfig);
      } catch {
        errors.push('SDK config must be valid JSON');
      }
    }
  }

  // CTA validation
  if (data.ctaText && !isValidLength(data.ctaText, 0, 50)) {
    errors.push('CTA text must not exceed 50 characters');
  }

  if (data.ctaUrl && !isValidUrl(data.ctaUrl)) {
    errors.push('Invalid CTA URL');
  }

  // Numeric validations
  if (data.priority !== undefined && !isInRange(data.priority, 0, 100)) {
    errors.push('Priority must be between 0 and 100');
  }

  if (data.weight !== undefined && !isInRange(data.weight, 0.1, 100)) {
    errors.push('Weight must be between 0.1 and 100');
  }

  if (data.maxImpressionsPerUser !== undefined && !isPositiveInteger(data.maxImpressionsPerUser)) {
    errors.push('Max impressions per user must be a positive integer');
  }

  if (data.maxClicksPerUser !== undefined && !isPositiveInteger(data.maxClicksPerUser)) {
    errors.push('Max clicks per user must be a positive integer');
  }

  if (data.totalBudget !== undefined && data.totalBudget !== null) {
    if (!isInRange(data.totalBudget, 0, 1000000000)) {
      errors.push('Total budget must be between 0 and 1,000,000,000');
    }
  }

  if (data.costPerImpression !== undefined && data.costPerImpression !== null) {
    if (!isInRange(data.costPerImpression, 0, 1000)) {
      errors.push('Cost per impression must be between 0 and 1000');
    }
  }

  if (data.costPerClick !== undefined && data.costPerClick !== null) {
    if (!isInRange(data.costPerClick, 0, 1000)) {
      errors.push('Cost per click must be between 0 and 1000');
    }
  }

  // Placement validation
  if (!data.placementFeeds && !data.placementReels && !data.placementStories && !data.placementSearch) {
    errors.push('At least one placement (feeds, reels, stories, or search) must be selected');
  }

  // Reel position validation
  if (data.reelPosition) {
    const validPositions = ['before', 'after', 'both'];
    if (!validPositions.includes(data.reelPosition)) {
      errors.push('Reel position must be one of: before, after, both');
    }
  }

  // Frequency type validation
  const validFrequencyTypes = ['manual', 'impressions', 'time'];
  if (data.frequencyType && !validFrequencyTypes.includes(data.frequencyType)) {
    errors.push('Frequency type must be one of: manual, impressions, time');
  }

  // Array validations
  if (data.targetRegions && !Array.isArray(data.targetRegions)) {
    errors.push('Target regions must be an array');
  }

  if (data.targetLanguages && !Array.isArray(data.targetLanguages)) {
    errors.push('Target languages must be an array');
  }

  if (data.targetInterests && !Array.isArray(data.targetInterests)) {
    errors.push('Target interests must be an array');
  }

  // Demographics validation
  if (data.targetDemographics) {
    if (typeof data.targetDemographics !== 'object') {
      errors.push('Target demographics must be an object');
    } else {
      if (data.targetDemographics.age_min !== undefined) {
        if (isInRange(data.targetDemographics.age_min, 13, 120)) {
          // Age min is valid
        } else {
          errors.push('Minimum age must be between 13 and 120');
        }
      }
      if (data.targetDemographics.age_max) {
        if (isInRange(data.targetDemographics.age_max, 13, 120)) {
          // Age max is valid
        } else {
          errors.push('Maximum age must be between 13 and 120');
        }
      }
      if (data.targetDemographics.age_min && data.targetDemographics.age_max) {
        if (data.targetDemographics.age_min > data.targetDemographics.age_max) {
          errors.push('Minimum age cannot be greater than maximum age');
        }
      }
      if (data.targetDemographics.gender) {
        const validGenders = ['male', 'female', 'other', 'all'];
        if (validGenders.includes(data.targetDemographics.gender)) {
          // Gender is valid
        } else {
          errors.push('Gender must be one of: male, female, other, all');
        }
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Validate user ban data
 */
export function validateBanUser(data, targetUser, _adminInfo) {
  const errors = [];

  // Check if user exists
  if (!targetUser) {
    errors.push('User not found');
  }

  // Check if target is an admin
  if (targetUser && targetUser.is_admin) {
    errors.push('Cannot ban admin users');
  }

  // Validate reason
  if (!data.reason || !isValidLength(data.reason, 3, 500)) {
    errors.push('Ban reason must be between 3 and 500 characters');
  }

  // Validate duration
  if (data.duration !== undefined && !data.permanent) {
    if (!isPositiveInteger(data.duration)) {
      errors.push('Ban duration must be a positive integer (hours)');
    }
    if (!isInRange(data.duration, 1, 87600)) { // Max 10 years
      errors.push('Ban duration must be between 1 hour and 10 years');
    }
  }

  // Check if user is already banned
  if (targetUser && targetUser.is_banned) {
    const now = Math.floor(Date.now() / 1000);
    if (!targetUser.banned_until || targetUser.banned_until > now) {
      errors.push('User is already banned');
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Validate admin permissions
 */
export function validateAdminPermissions(permissions) {
  const VALID_PERMISSIONS = new Set([
    // Super admin - full access (granted only to super_admin role)
    'all',
    
    // Advertisement Management (granular)
    'create_ads',
    'edit_ads',
    'delete_ads',
    'approve_ads',
    'pause_ads',
    'moderate_ads',
    'view_ad_analytics',
    
    // Content Moderation (granular)
    'moderate_content',
    'delete_posts',
    'delete_comments',
    'flag_content_review',
    'view_moderation_queue',
    
    // User Management (granular)
    'ban_users',
    'unban_users',
    'suspend_users',
    'verify_users',
    'manage_user_appeals',
    'view_user_analytics',
    'export_user_data',
    
    // Admin Management (super admin only)
    'manage_admins',
    'create_admin',
    'delete_admin',
    'modify_admin_permissions',
    
    // Reports & Audit
    'manage_reports',
    'view_audit_logs',
    'export_audit_logs',
    'view_system_logs',
    
    // Analytics & Insights
    'view_analytics',
    'view_platform_health',
    'export_platform_analytics',
    
    // System Configuration
    'manage_settings',
    'configure_rate_limits',
    'manage_integrations',
    'import_social_media',
    'manage_webhooks'
  ]);

  if (!Array.isArray(permissions)) {
    return {
      isValid: false,
      errors: ['Permissions must be an array']
    };
  }

  const errors = [];
  for (const permission of permissions) {
    if (!VALID_PERMISSIONS.has(permission)) {
      errors.push(`Invalid permission: ${permission}`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Safe JSON parse with error handling
 */
export function safeJsonParse(jsonString, defaultValue = null) {
  if (!jsonString) return defaultValue;

  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.error('JSON parse error:', error);
    return defaultValue;
  }
}

/**
 * Validate pagination parameters
 */
export function validatePagination(limit, offset) {
  const errors = [];

  if (limit !== undefined) {
    if (!isPositiveInteger(limit)) {
      errors.push('Limit must be a positive integer');
    } else if (!isInRange(limit, 1, 100)) {
      errors.push('Limit must be between 1 and 100');
    }
  }

  if (offset !== undefined) {
    if (!isNonNegativeInteger(offset)) {
      errors.push('Offset must be a non-negative integer');
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Validate timestamp range
 */
export function validateTimeRange(startTime, endTime) {
  const errors = [];

  if (startTime !== undefined && !isPositiveInteger(startTime)) {
    errors.push('Start time must be a positive integer (Unix timestamp)');
  }

  if (endTime !== undefined && !isPositiveInteger(endTime)) {
    errors.push('End time must be a positive integer (Unix timestamp)');
  }

  if (startTime && endTime && startTime > endTime) {
    errors.push('Start time cannot be after end time');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Check if admin has a specific permission
 * Super admins have all permissions automatically
 */
export function hasAdminPermission(adminInfo, requiredPermission) {
  if (!adminInfo || !requiredPermission) {
    return false;
  }

  // Super admins have all permissions
  if (adminInfo.role === 'super_admin') {
    return true;
  }

  // Check if 'all' permission is granted
  if (Array.isArray(adminInfo.permissions) && adminInfo.permissions.includes('all')) {
    return true;
  }

  // Check for specific permission
  return Array.isArray(adminInfo.permissions) && adminInfo.permissions.includes(requiredPermission);
}

/**
 * Check if admin has ANY of the required permissions
 */
export function hasAnyAdminPermission(adminInfo, requiredPermissions = []) {
  if (!adminInfo || !Array.isArray(requiredPermissions) || requiredPermissions.length === 0) {
    return false;
  }

  // Super admins have all permissions
  if (adminInfo.role === 'super_admin') {
    return true;
  }

  // Check if 'all' permission is granted
  if (Array.isArray(adminInfo.permissions) && adminInfo.permissions.includes('all')) {
    return true;
  }

  // Check for any permission match
  return requiredPermissions.some(perm => 
    Array.isArray(adminInfo.permissions) && adminInfo.permissions.includes(perm)
  );
}

/**
 * Check if admin has ALL of the required permissions
 */
export function hasAllAdminPermissions(adminInfo, requiredPermissions = []) {
  if (!adminInfo || !Array.isArray(requiredPermissions) || requiredPermissions.length === 0) {
    return false;
  }

  // Super admins have all permissions
  if (adminInfo.role === 'super_admin') {
    return true;
  }

  // Check if 'all' permission is granted
  if (Array.isArray(adminInfo.permissions) && adminInfo.permissions.includes('all')) {
    return true;
  }

  // Check that all permissions are present
  return requiredPermissions.every(perm => 
    Array.isArray(adminInfo.permissions) && adminInfo.permissions.includes(perm)
  );
}

