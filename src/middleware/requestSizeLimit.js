// ============================================
// REQUEST SIZE LIMIT MIDDLEWARE
// Global body size validation
// ============================================

import { errorResponse } from '../utils/helpers.js';

/**
 * Default request size limits by content type
 */
export const REQUEST_SIZE_LIMITS = {
  // JSON payloads
  'application/json': 50 * 1024 * 1024,   // 50 MB (increased from 10MB to handle large media arrays)
  
  // Form data
  'application/x-www-form-urlencoded': 5 * 1024 * 1024,  // 5 MB
  'multipart/form-data': 100 * 1024 * 1024,  // 100 MB (file uploads)
  
  // Text
  'text/plain': 5 * 1024 * 1024,  // 5 MB
  'text/html': 5 * 1024 * 1024,   // 5 MB
  
  // Default for unknown types
  'default': 50 * 1024 * 1024  // 50 MB (increased from 10MB)
};

/**
 * Stricter limits for sensitive endpoints
 */
export const SENSITIVE_ENDPOINT_SIZE_LIMITS = {
  '/admin/import/all': 50 * 1024 * 1024,    // 50 MB for database imports
  '/admin/export/all': 100 * 1024 * 1024,   // 100 MB for export results
  '/webhooks/email/incoming': 5 * 1024 * 1024,  // 5 MB for email
};

/**
 * Request size limit middleware
 * Validates Content-Length header before processing
 * 
 * Usage:
 *   const sizeError = checkRequestSize(req, endpoint);
 *   if (sizeError) return sizeError;
 * 
 * @param {Request} request - HTTP request
 * @param {string} endpoint - API endpoint (for sensitive limit checks)
 * @returns {null|Response} - Returns error if size exceeds limit
 */
export function checkRequestSize(request, endpoint) {
  const method = request.method.toUpperCase();
  
  // Only check POST, PUT, PATCH requests
  if (!['POST', 'PUT', 'PATCH'].includes(method)) {
    return null; // GET, DELETE, HEAD don't have bodies
  }

  const contentLengthHeader = request.headers.get('Content-Length');
  if (!contentLengthHeader) {
    // No Content-Length header - could be chunked encoding
    // We'll allow it but warn
    console.warn(`[RequestSize] No Content-Length header for ${method} ${endpoint}`);
    return null;
  }

  const contentLength = parseInt(contentLengthHeader, 10);
  const contentType = request.headers.get('Content-Type') || 'application/json';

  // Extract base content type (e.g., 'application/json' from 'application/json; charset=utf-8')
  const baseContentType = contentType.split(';')[0].trim();

  // Check sensitive endpoint limits first
  if (SENSITIVE_ENDPOINT_SIZE_LIMITS[endpoint]) {
    const limit = SENSITIVE_ENDPOINT_SIZE_LIMITS[endpoint];
    if (contentLength > limit) {
      console.warn(`[RequestSize] Sensitive endpoint size exceeded: ${contentLength} > ${limit} for ${endpoint}`);
      return errorResponse(
        `Request body too large. Maximum size: ${formatBytes(limit)}`,
        413,
        {
          contentLength,
          limit,
          endpoint,
          message: 'Payload Too Large'
        }
      );
    }
    return null;
  }

  // Check general content-type limits
  const limit = REQUEST_SIZE_LIMITS[baseContentType] || REQUEST_SIZE_LIMITS.default;

  if (contentLength > limit) {
    console.warn(
      `[RequestSize] Size exceeded: ${contentLength} > ${limit} bytes ` +
      `for content-type ${baseContentType} on ${method} ${endpoint}`
    );

    return errorResponse(
      `Request body too large for ${baseContentType}. Maximum size: ${formatBytes(limit)}`,
      413,
      {
        contentLength,
        limit,
        contentType: baseContentType,
        message: 'Payload Too Large'
      }
    );
  }

  return null; // Request size is acceptable
}

/**
 * Middleware factory for request size validation
 * Returns middleware function that can be used in route handlers
 * 
 * Usage:
 *   router.post('/upload', requestSizeLimit(), async (req) => { ... });
 * 
 * @param {object} options - Override options
 * @returns {Function} - Middleware function
 */
export function requestSizeLimit(options = {}) {
  const { limits = REQUEST_SIZE_LIMITS, sensitiveEndpoints = SENSITIVE_ENDPOINT_SIZE_LIMITS } = options;

  return function middleware(request, endpoint) {
    const contentLengthHeader = request.headers.get('Content-Length');
    if (!contentLengthHeader) {
      return null;
    }

    const contentLength = parseInt(contentLengthHeader, 10);
    const contentType = request.headers.get('Content-Type') || 'application/json';
    const baseContentType = contentType.split(';')[0].trim();

    // Check sensitive endpoints first
    if (sensitiveEndpoints[endpoint]) {
      const limit = sensitiveEndpoints[endpoint];
      if (contentLength > limit) {
        return errorResponse(`Request too large (${formatBytes(contentLength)} > ${formatBytes(limit)})`, 413);
      }
      return null;
    }

    // Check general limits
    const limit = limits[baseContentType] || limits.default;
    if (contentLength > limit) {
      return errorResponse(`Request too large (${formatBytes(contentLength)} > ${formatBytes(limit)})`, 413);
    }

    return null;
  };
}

/**
 * Helper to format bytes to human-readable format
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Validate JSON body doesn't exceed size AND parse limit
 * @param {Request} request
 * @param {number} maxJsonSize - Maximum parsed JSON object size
 * @returns {null|Response}
 */
export async function validateJsonBody(request, maxJsonSize = 1000000) {
  const contentLengthHeader = request.headers.get('Content-Length');
  if (!contentLengthHeader) return null;

  const contentLength = parseInt(contentLengthHeader, 10);
  const limit = REQUEST_SIZE_LIMITS['application/json'];
  
  if (contentLength > limit) {
    return errorResponse(`JSON body too large (${formatBytes(contentLength)} > ${formatBytes(limit)})`, 413);
  }

  return null;
}
