// ============================================
// CORS MIDDLEWARE
// ============================================

import { getNoCacheHeaders } from '../utils/helpers.js';

// Default local origins for development (fallback if env not provided)
const DEFAULT_DEV_ORIGINS = [
  'http://localhost:3000',    // Web app
  'http://localhost:5173',    // Admin dashboard
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8080',
];

// Default production origins (common patterns)
const DEFAULT_PROD_ORIGINS = [
  // Main domains
  'https://xora.social',
  'https://www.xora.social',
  'https://app.xora.social',
  // Alternative domain (Cloudflare Pages)
  'https://xorasocial.com',
  'https://www.xorasocial.com',
  // Cloudflare Workers/Pages subdomains
  'https://xorasocial.pages.dev',
  'https://xorasocial.workers.dev',
  'https://xora-workers-api-production.xorasocial.workers.dev',
];

// Parse a comma-separated env var into a clean array of origins
function parseAllowedOrigins(env) {
  const raw = env?.ALLOWED_ORIGINS;
  if (!raw || typeof raw !== 'string') {
    // Return appropriate defaults based on environment
    const isProduction = env?.NODE_ENV === 'production' || 
                        env?.ENVIRONMENT === 'production' ||
                        env?.CF_WORKER === '1' ||
                        env?.CF_PAGES === '1';
    return isProduction ? DEFAULT_PROD_ORIGINS : DEFAULT_DEV_ORIGINS;
  }
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Get CORS headers with origin validation
 * @param {string} requestOrigin - Origin from request headers
 * @param {string} env - Environment (production/development)
 */
export function corsHeaders(requestOrigin, envType = 'development', envObj) {
  const allowedOrigins = parseAllowedOrigins(envObj);

  // SECURITY FIX: Validate origin even in development
  // Only allow explicitly whitelisted origins, even in dev mode
  const isAllowedOrigin = allowedOrigins.includes(requestOrigin);

  if (envType === 'development') {
    // In development, reflect the request origin if present to avoid CORS blocks
    const allowedOrigin = requestOrigin || allowedOrigins[0] || 'http://localhost:5173';

    return {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
      // Security headers
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'X-XSS-Protection': '1; mode=block',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
      'Strict-Transport-Security': envType === 'production' ? 'max-age=31536000; includeSubDomains' : 'max-age=0',
    };
  }

  // In production, validate origin against whitelist
  const allowedOrigin = allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : allowedOrigins[0]; // Fallback to first allowed origin (browser will still block mismatched origins)

  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    // Security headers
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Strict-Transport-Security': envType === 'production' ? 'max-age=31536000; includeSubDomains' : 'max-age=0',
  };
}

export function handleCors(request, env) {
  if (request.method === 'OPTIONS') {
    const origin = request.headers.get('origin');
    const environment = env?.ENVIRONMENT || 'development';
    return new Response(null, {
      status: 204,
      headers: corsHeaders(origin, environment, env)
    });
  }
  return null;
}

export function addCorsHeaders(response, request, env) {
  // Skip CORS processing for WebSocket upgrade responses
  if (response.webSocket) {
    return response;
  }

  // Ensure we have a valid Response object
  if (!response || typeof response.status !== 'number' || response.status < 200 || response.status > 599) {
    console.error('Invalid response object in addCorsHeaders:', response);
    return new Response('Internal Server Error', { status: 500 });
  }

  const origin = request?.headers?.get('origin');
  const environment = env?.ENVIRONMENT || 'development';
  const url = new URL(request.url);

  // Create new headers with CORS headers first
  const headers = new Headers();

  // Add CORS headers
  Object.entries(corsHeaders(origin, environment, env)).forEach(([key, value]) => {
    headers.set(key, value);
  });

  // Add no-cache headers for sensitive endpoints
  const isAuthEndpoint = url.pathname.startsWith('/auth/') || 
                         url.pathname.startsWith('/settings') ||
                         url.pathname.startsWith('/users/') && request.method !== 'GET';  // Don't cache user PUTs/POSTs
  
  if (isAuthEndpoint && !response.headers.has('Cache-Control')) {
    const noCacheHeaders = getNoCacheHeaders();
    Object.entries(noCacheHeaders).forEach(([key, value]) => {
      headers.set(key, value);
    });
  }

  // Copy all headers from original response, preserving multiple Set-Cookie headers
  // Using for...of on entries() to properly iterate all headers including duplicates
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === 'set-cookie') {
      // Append Set-Cookie headers (don't overwrite)
      headers.append(key, value);
    } else if (!headers.has(key)) {
      // Only set other headers if not already set by CORS
      headers.set(key, value);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
