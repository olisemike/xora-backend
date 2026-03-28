// ============================================
// JWT SERVICE
// Uses environment variables for secret
// ============================================

import { SignJWT, jwtVerify } from 'jose';

// Store env reference for the module
let env = null;

/**
 * Initialize JWT service with environment
 * Must be called before using JWT functions
 */
export function initJWT(envParam) {
  env = envParam;
}

/**
 * Generate JWT secret key from environment variable
 */
function getSecretKey() {
  if (!env?.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is not configured. Add it to wrangler.toml or .dev.vars');
  }
  return new TextEncoder().encode(env.JWT_SECRET);
}

/**
 * Generate access token (short-lived for security)
 * @param {string} userId - User ID
 * @param {string} email - User email
 * @param {number} tokenVersion - Token version for invalidation
 * @param {string} customExpiry - Optional custom expiry (e.g., '10s' for initial login)
 */
export async function generateAccessToken(userId, email, tokenVersion = 0, customExpiry = null) {
  const secretKey = getSecretKey();

  const payload = {
    userId,
    email,
    type: 'access',
    tokenVersion
  };

  // Use custom expiry if provided, otherwise use configured expiry (default 15m)
  const expiry = customExpiry || env?.JWT_ACCESS_EXPIRY || '15m';
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiry)
    .setSubject(userId)
    .sign(secretKey);

  return token;
}

/**
 * Generate refresh token (longer-lived for "remember me" functionality)
 * @param {string} userId - User ID
 * @param {string} email - User email
 * @param {number} tokenVersion - Token version for invalidation
 * @param {string} refreshTokenId - Unique refresh token ID for rotation tracking
 */
export async function generateRefreshToken(userId, email, tokenVersion = 0, refreshTokenId = null) {
  const secretKey = getSecretKey();

  const payload = {
    userId,
    email,
    type: 'refresh',
    tokenVersion
  };

  // Track refresh token for rotation
  if (refreshTokenId) {
    payload.refreshTokenId = refreshTokenId;
  }

  // Use configured expiry (default 7d - longer-lived for session persistence)
  const expiry = env?.JWT_REFRESH_EXPIRY || '30d';
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiry)
    .setSubject(userId)
    .sign(secretKey);

  return token;
}

/**
 * Verify JWT token
 * @param {string} token - JWT token
 */
export async function verifyToken(token) {
  try {
    const secretKey = getSecretKey();
    const { payload } = await jwtVerify(token, secretKey, {
      clockTolerance: 300
    });
    return payload;
  } catch (error) {
    console.error('Token verification failed:', error.message);
    return null;
  }
}

/**
 * Generate both access and refresh tokens
 * All tokens are 15 minutes (httpOnly cookies for web, response body for mobile)
 * @param {string} userId - User ID
 * @param {string} email - User email
 * @param {number} tokenVersion - Token version for invalidation
 * @param {string} refreshTokenId - Unique refresh token ID for rotation (optional)
 */
export async function generateTokenPair(userId, email, tokenVersion = 0, refreshTokenId = null) {
  // All tokens are 15 minutes - set via httpOnly cookies or returned in response
  const accessExpiry = null; // null = use default 15m from JWT_ACCESS_EXPIRY
  const [accessToken, refreshToken] = await Promise.all([
    generateAccessToken(userId, email, tokenVersion, accessExpiry),
    generateRefreshToken(userId, email, tokenVersion, refreshTokenId)
  ]);

  return { accessToken, refreshToken };
}

/**
 * Hash refresh token for storage
 */
export async function hashToken(token) {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
