// ============================================
// AUTH CONTROLLER EXTENSIONS
// New endpoints for session management
// ============================================

import { generateTokenPair, hashToken } from '../services/jwt.js';
import { getCsrfProtection } from '../middleware/csrfProtection.js';
import {
  generateDeviceFingerprint,
  recordLoginAttempt,
  isDeviceVerified,
  createDeviceVerification,
  verifyDeviceCode,
  updateDeviceLastUsed,
  getLoginHistory,
  getVerifiedDevices
} from '../services/deviceTracking.js';
import {
  sendLoginNotification,
  sendDeviceVerificationEmail
} from '../services/notifications.js';
import {
  generateId,
  now,
  hoursFromNow,
  generateToken,
  errorResponse,
  successResponse,
  getNoCacheHeaders
} from '../utils/helpers.js';

/**
 * Helper to create httpOnly token cookies
 * @param {string} accessToken - JWT access token
 * @param {string} refreshToken - JWT refresh token
 * @param {Object} env - Environment variables
 * @returns {string[]} Array of Set-Cookie headers
 */
function createTokenCookies(accessToken, refreshToken, env) {
  const isProduction = env.ENVIRONMENT === 'production';
  // Use COOKIE_DOMAIN if set, otherwise derive from environment
  const domain = env.COOKIE_DOMAIN || (isProduction ? '.xorasocial.com' : undefined);

  const baseOptions = [
    'HttpOnly',
    isProduction ? 'SameSite=none' : 'SameSite=Lax',
    isProduction ? 'Secure' : '',
    domain ? `Domain=${domain}` : '',
    'Path=/'
  ].filter(Boolean).join('; ');

  const cookies = [];

  if (accessToken) {
    cookies.push(`xora_access_token=${accessToken}; ${baseOptions}; Max-Age=900`);
  }

  if (refreshToken) {
    cookies.push(`xora_refresh_token=${refreshToken}; ${baseOptions}; Max-Age=2592000`);
  }

  return cookies;
}

/**
 * POST /auth/logout-all-devices
 * Invalidate all tokens by incrementing token_version, generating new tokens, and setting cookies
 */
export async function logoutAllDevices(db, env, userId, _request) {
  try {
    // Increment token_version to invalidate all existing tokens
    await db.prepare(`
      UPDATE users SET token_version = token_version + 1
      WHERE id = ?
    `).bind(userId).run();

    // Delete all refresh tokens for this user
    await db.prepare(`
      DELETE FROM refresh_tokens WHERE user_id = ?
    `).bind(userId).run();

    // Get updated user with new token_version
    const user = await db.prepare(`
      SELECT id, email, token_version FROM users WHERE id = ?
    `).bind(userId).first();

    if (!user) {
      return errorResponse('User not found', 404);
    }

    // Generate new tokens with new version
    const { accessToken, refreshToken } = await generateTokenPair(
      user.id,
      user.email,
      user.token_version
    );

    // Store new refresh token
    const tokenHash = await hashToken(refreshToken);
    await db.prepare(`
      INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      generateId('rt'),
      user.id,
      tokenHash,
      hoursFromNow(720), // 30 days
      now()
    ).run();

    // Create httpOnly token cookies for web/admin clients
    const tokenCookies = createTokenCookies(accessToken, refreshToken, env);

    // Get CSRF protection instance and issue new CSRF token
    const csrfProtection = await getCsrfProtection(env);
    const { token: csrfToken, cookieHeader: csrfCookie } = csrfProtection.issueToken();

    const responseData = successResponse({
      tokens: {
        accessToken,
        refreshToken
      },
      csrfToken
    }, 'All devices logged out successfully. New tokens issued.');

    const headers = new Headers({
      'Content-Type': 'application/json',
      ...getNoCacheHeaders()
    });

    headers.append('Set-Cookie', csrfCookie);
    tokenCookies.forEach(cookie => headers.append('Set-Cookie', cookie));

    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers
    });

  } catch (error) {
    console.error('Logout all devices error:', error);
    return errorResponse('Failed to logout all devices', 500);
  }
}

/**
 * POST /auth/verify-device
 * Verify device with email code using a temporary verification token
 * (no authentication required)
 */
export async function verifyDevice(db, env, request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }

    const { verificationCode, tempToken } = body || {};

    if (!verificationCode) {
      return errorResponse('Verification code is required', 400);
    }

    if (!tempToken) {
      return errorResponse('Verification session is missing or expired', 400);
    }

    const cacheKey = `device_verify:${tempToken}`;
    const sessionJson = await env.CACHE.get(cacheKey);

    if (!sessionJson) {
      return errorResponse('Invalid or expired verification session', 400);
    }

    let session;
    try {
      session = JSON.parse(sessionJson);
    } catch {
      return errorResponse('Invalid verification session data', 400);
    }

    const { userId } = session;
    if (!userId) {
      return errorResponse('Invalid verification session', 400);
    }

    // Simple rate limiting to prevent brute-force verification attempts
    const ipAddress =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for') ||
      'unknown';

    const rateLimitKey = `device_verify_attempts:${userId}:${session.deviceFingerprint || 'unknown'}:${ipAddress}`;
    let attempts = 0;

    try {
      const existing = await env.CACHE.get(rateLimitKey);
      if (existing) {
        const { attempts: existingAttempts } = JSON.parse(existing);
        if (typeof existingAttempts === 'number') {
          attempts = existingAttempts;
        }
      }
    } catch (rateErr) {
      console.error('Failed to read device verification rate limit state:', rateErr);
      return errorResponse('Service temporarily unavailable. Please try again later.', 503);
    }

    const MAX_ATTEMPTS = 5;
    if (attempts >= MAX_ATTEMPTS) {
      return errorResponse(
        'Too many verification attempts. Please log in again to request a new code.',
        429
      );
    }

    attempts += 1;
    try {
      await env.CACHE.put(
        rateLimitKey,
        JSON.stringify({ attempts, lastAttemptAt: now() }),
        { expirationTtl: 600 }
      );
    } catch (rateErr) {
      console.error('Failed to update device verification rate limit state:', rateErr);
      return errorResponse('Service temporarily unavailable. Please try again later.', 503);
    }

    const result = await verifyDeviceCode(db, userId, verificationCode);

    if (!result.success) {
      return errorResponse(result.error, 400);
    }

    // Get user data for token generation
    const user = await db.prepare(`
      SELECT id, email, username, name, avatar_url, bio, token_version, created_at
      FROM users WHERE id = ?
    `).bind(userId).first();

    if (!user) {
      return errorResponse('User not found', 404);
    }

    // Generate tokens with current token_version
    const tokenVersion = typeof user.token_version === 'number' ? user.token_version : 0;
    const { accessToken, refreshToken } = await generateTokenPair(
      user.id,
      user.email,
      tokenVersion
    );

    // Store refresh token
    const tokenHash = await hashToken(refreshToken);
    await db.prepare(`
      INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      generateId('rt'),
      user.id,
      tokenHash,
      hoursFromNow(720), // 30 days
      now()
    ).run();

    // Update login history status from pending_verification to success
    // D1/SQLite doesn't support LIMIT on UPDATE, so use a subquery
    await db.prepare(`
      UPDATE login_history
      SET status = 'success'
      WHERE id = (
        SELECT id FROM login_history
        WHERE user_id = ? AND status = 'pending_verification'
        ORDER BY logged_in_at DESC
        LIMIT 1
      )
    `).bind(userId).run();

    // Best-effort cleanup of the temp session and rate limit state
    try {
      await env.CACHE.delete(cacheKey);
    } catch (cleanupError) {
      console.error('Failed to delete device verification session:', cleanupError);
    }

    try {
      await env.CACHE.delete(rateLimitKey);
    } catch (rateErr) {
      console.error('Failed to clear device verification rate limit state:', rateErr);
    }

    // Send login notification (async, don't wait)
    sendLoginNotification(db, env, user, null, null).catch(err =>
      console.error('Failed to send login notification:', err)
    );

    // Get user settings
    const settings = await db.prepare(`
      SELECT * FROM user_settings WHERE user_id = ?
    `).bind(userId).first() || {};

    // Remove sensitive data
    delete user.password_hash;
    delete user.two_factor_secret;

    // Generate CSRF token
    const csrfProtection = getCsrfProtection(env);
    const { token: csrfToken, cookieHeader: csrfCookie } = csrfProtection.issueToken();

    // Create httpOnly token cookies
    const tokenCookies = createTokenCookies(accessToken, refreshToken, env);

    const userData = {
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      avatar_url: user.avatar_url,
      bio: user.bio,
      created_at: user.created_at,
      settings
    };

    const responseData = successResponse({
      user: userData,
      // Include tokens in response body for mobile/admin apps (they can't use httpOnly cookies)
      // Web apps should use the httpOnly cookies set in response headers for better security
      tokens: {
        accessToken,
        refreshToken
      },
      csrfToken
    }, 'Device verified and logged in successfully');

    // Create Response with all cookies (CSRF + auth tokens)
    const headers = new Headers({
      'Content-Type': 'application/json',
      ...getNoCacheHeaders()
    });

    headers.append('Set-Cookie', csrfCookie);
    tokenCookies.forEach(cookie => headers.append('Set-Cookie', cookie));

    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers
    });

  } catch (error) {
    console.error('Verify device error:', error);
    return errorResponse('Device verification failed', 500);
  }
}

/**
 * GET /auth/login-history
 * Get user's login history
 */
export async function getUserLoginHistory(db, env, userId) {
  try {
    const history = await getLoginHistory(db, userId, 10);

    return successResponse({
      history: history.map(h => ({
        id: h.id,
        platform: h.platform,
        deviceInfo: JSON.parse(h.device_info || '{}'),
        ipAddress: h.ip_address,
        status: h.status,
        timestamp: h.logged_in_at
      }))
    });

  } catch (error) {
    console.error('Get login history error:', error);
    return errorResponse('Failed to get login history', 500);
  }
}

/**
 * GET /auth/verified-devices
 * Get user's verified devices
 */
export async function getUserVerifiedDevices(db, env, userId) {
  try {
    const devices = await getVerifiedDevices(db, userId);

    return successResponse({
      devices: devices.map(d => ({
        id: d.id,
        platform: d.platform,
        deviceInfo: JSON.parse(d.device_info || '{}'),
        firstVerified: d.first_verified_at,
        lastUsed: d.last_used_at
      }))
    });

  } catch (error) {
    console.error('Get verified devices error:', error);
    return errorResponse('Failed to get verified devices', 500);
  }
}

/**
 * Helper: Process login with device tracking
 * This should be called from the main login endpoint
 */
export async function processLoginWithDeviceTracking(db, env, user, request, deviceInfo) {
  try {
    // Extract request info
    const ipAddress = request.headers.get('cf-connecting-ip') ||
                     request.headers.get('x-forwarded-for') ||
                     'unknown';
    const userAgent = request.headers.get('user-agent') || 'unknown';

    // Generate device fingerprint (combines user agent, platform, and client-provided fingerprint)
    const deviceFingerprint = generateDeviceFingerprint(
      userAgent,
      deviceInfo?.platform,
      deviceInfo?.fingerprint,
      deviceInfo || null
    );

    // Check if device is already verified
    const isVerified = await isDeviceVerified(db, user.id, deviceFingerprint);

    if (!isVerified) {
      // Create device verification request
      const verification = await createDeviceVerification(
        db,
        user.id,
        deviceInfo,
        ipAddress,
        deviceFingerprint
      );

      // Send verification email
      try {
        await sendDeviceVerificationEmail(env, user, verification.verificationCode, deviceInfo);
      } catch (emailError) {
        console.error('Failed to send verification email:', emailError);
        // Continue anyway - user can request new code
      }

      // Record login attempt as pending verification
      await recordLoginAttempt(db, user.id, deviceInfo, ipAddress, userAgent, 'pending_verification');

      // Create a temporary verification session so the client can verify without being logged in
      const tempToken = generateToken();
      try {
        await env.CACHE.put(
          `device_verify:${tempToken}`,
          JSON.stringify({
            userId: user.id,
            deviceFingerprint,
            createdAt: now(),
          }),
          { expirationTtl: 600 } // 10 minutes
        );
      } catch (cacheError) {
        console.error('Failed to store device verification session:', cacheError);
        // User can still request a new code later; don't fail login solely because of cache issues
      }

      return {
        requiresDeviceVerification: true,
        tempToken,
        message: `A verification code has been sent to ${user.email}. Please check your email.`
      };
    }

    // Device is verified - proceed with login
    // Update last used timestamp
    await updateDeviceLastUsed(db, user.id, deviceFingerprint);

    // Record successful login
    await recordLoginAttempt(db, user.id, deviceInfo, ipAddress, userAgent, 'success');

    // Send login notification (async, don't wait)
    sendLoginNotification(db, env, user, deviceInfo, ipAddress).catch(err =>
      console.error('Failed to send login notification:', err)
    );

    // Get user's current token version
    const tokenVersion = user.token_version || 0;

    // Generate tokens with IP pinning
    const { accessToken, refreshToken } = await generateTokenPair(
      user.id,
      user.email,
      tokenVersion
    );

    // Store refresh token
    const tokenHash = await hashToken(refreshToken);
    await db.prepare(`
      INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      generateId('rt'),
      user.id,
      tokenHash,
      hoursFromNow(720), // 30 days
      now()
    ).run();

    return {
      requiresDeviceVerification: false,
      tokens: {
        accessToken,
        refreshToken
      }
    };

  } catch (error) {
    console.error('Device tracking error:', error);
    throw error;
  }
}
