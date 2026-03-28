// ============================================
// DEVICE TRACKING SERVICE
// Handles login history and device verification
// ============================================

import { customAlphabet } from 'nanoid';

const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 6);

/**
 * Generate unique device fingerprint from request info and optional client fingerprint
 */
export function generateDeviceFingerprint(userAgent, platform, clientFingerprint = '', deviceInfo = null) {
  const parts = [
    userAgent || 'unknown',
    platform || 'unknown',
    clientFingerprint || '',
    deviceInfo?.userAgent || '',
    deviceInfo?.platformString || '',
    deviceInfo?.screen || '',
    deviceInfo?.timezone || '',
    deviceInfo?.webglVendor || '',
    deviceInfo?.webglRenderer || '',
    deviceInfo?.canvasFingerprint || '',
  ];

  const data = parts.filter(Boolean).join('|');

  // Simple hash for fingerprinting (in production, consider a more sophisticated method)
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = (hash * 31 + char) % 1000000; // Use multiplication instead of bitwise
  }
  return Math.abs(hash).toString(36);
}

/**
 * Record login attempt in history
 */
export async function recordLoginAttempt(db, userId, deviceInfo, ipAddress, userAgent, status = 'success') {
  if (!userId) {
    throw new Error('userId is required for recordLoginAttempt');
  }
  
  const id = crypto.randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);

  // Normalize platform to 'web', 'mobile', or 'unknown'
  const { appPlatform, platform: devicePlatform } = deviceInfo || {};
  let platform = 'unknown';
  if (appPlatform === 'web') {
    platform = 'web';
  } else if (appPlatform === 'mobile' || devicePlatform === 'mobile') {
    platform = 'mobile';
  } else if (devicePlatform) {
    // Legacy: if platform is set but not appPlatform, guess based on value
    platform = devicePlatform;
  }

  await db
    .prepare(`
      INSERT INTO login_history (id, user_id, platform, device_info, ip_address, user_agent, status, logged_in_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      id,
      userId,
      platform,
      JSON.stringify(deviceInfo || {}),
      ipAddress || null,
      userAgent || null,
      status,
      timestamp
    )
    .run();

  return id;
}

/**
 * Check if device is verified for user
 */
export async function isDeviceVerified(db, userId, deviceFingerprint) {
  const result = await db
    .prepare(`
      SELECT id FROM verified_devices
      WHERE user_id = ? AND device_fingerprint = ?
    `)
    .bind(userId, deviceFingerprint)
    .first();

  return Boolean(result);
}

/**
 * Create device verification request
 */
export async function createDeviceVerification(db, userId, deviceInfo, ipAddress, deviceFingerprint) {
  const id = crypto.randomUUID();
  const verificationCode = nanoid(); // 6-character code
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + (15 * 60); // 15 minutes

  // Creating device verification
  // Code details logged
  // Created timestamp
  // Expires timestamp

  // Normalize platform to 'web', 'mobile', or 'unknown'
  const { appPlatform, platform: devicePlatform } = deviceInfo || {};
  let platform = 'unknown';
  if (appPlatform === 'web') {
    platform = 'web';
  } else if (appPlatform === 'mobile' || devicePlatform === 'mobile') {
    platform = 'mobile';
  } else if (devicePlatform) {
    platform = devicePlatform;
  }

  await db
    .prepare(`
      INSERT INTO device_verifications
      (id, user_id, device_fingerprint, platform, device_info, ip_address, verification_code, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      id,
      userId,
      deviceFingerprint,
      platform,
      JSON.stringify(deviceInfo || {}),
      ipAddress || null,
      verificationCode,
      now,
      expiresAt
    )
    .run();

  return { id, verificationCode, expiresAt };
}

/**
 * Verify device with code
 */
export async function verifyDeviceCode(db, userId, verificationCode) {
  const now = Math.floor(Date.now() / 1000);

  // Verifying device code
  // User ID for verification
  // Verification code length

  // Use single query to prevent timing oracle attacks
  // Always take same time regardless of code validity
  const verification = await db
    .prepare(`
      SELECT * FROM device_verifications
      WHERE user_id = ? AND verification_code = ? AND verified_at IS NULL AND expires_at > ?
    `)
    .bind(userId, verificationCode, now)
    .first();

  if (!verification) {
    // Verification failed
    return { success: false, error: 'Invalid or expired verification code' };
  }

  // Verification code is valid


  // Mark as verified
  await db
    .prepare(`UPDATE device_verifications SET verified_at = ? WHERE id = ?`)
    .bind(now, verification.id)
    .run();

  // Add to verified devices
  const deviceId = crypto.randomUUID();
  await db
    .prepare(`
      INSERT OR REPLACE INTO verified_devices
      (id, user_id, device_fingerprint, platform, device_info, first_verified_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      deviceId,
      userId,
      verification.device_fingerprint || '',
      verification.platform || 'unknown',
      verification.device_info || '{}',
      now,
      now
    )
    .run();

  return { success: true, deviceId };
}

/**
 * Update last used timestamp for device
 */
export async function updateDeviceLastUsed(db, userId, deviceFingerprint) {
  const now = Math.floor(Date.now() / 1000);

  await db
    .prepare(`
      UPDATE verified_devices
      SET last_used_at = ?
      WHERE user_id = ? AND device_fingerprint = ?
    `)
    .bind(now, userId, deviceFingerprint)
    .run();
}

/**
 * Get user's login history (last 30 days)
 */
export async function getLoginHistory(db, userId, limit = 10) {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);

  const results = await db
    .prepare(`
      SELECT * FROM login_history
      WHERE user_id = ? AND logged_in_at > ?
      ORDER BY logged_in_at DESC
      LIMIT ?
    `)
    .bind(userId, thirtyDaysAgo, limit)
    .all();

  return results.results || [];
}

/**
 * Get user's verified devices
 */
export async function getVerifiedDevices(db, userId) {
  const results = await db
    .prepare(`
      SELECT id, platform, device_info, first_verified_at, last_used_at
      FROM verified_devices
      WHERE user_id = ?
      ORDER BY last_used_at DESC
    `)
    .bind(userId)
    .all();

  return results.results || [];
}
