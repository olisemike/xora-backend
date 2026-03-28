// ============================================
// TOTP SERVICE
// Time-based One-Time Password (RFC 6238)
// ============================================

/**
 * Generate a random base32 secret for TOTP
 * @param {number} length - Length of secret (default 20 bytes = 32 base32 chars)
 */
export function generateTOTPSecret(length = 20) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return base32Encode(array);
}

/**
 * Generate TOTP code for a given secret and time
 * @param {string} secret - Base32 encoded secret
 * @param {number} timeStep - Time step in seconds (default 30)
 * @param {number} digits - Number of digits (default 6)
 * @param {number} timestamp - Unix timestamp in ms (default: now)
 */
export async function generateTOTP(secret, timeStep = 30, digits = 6, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 1000 / timeStep);
  return await generateHOTP(secret, counter, digits);
}

/**
 * Verify TOTP code
 * @param {string} token - The TOTP code to verify
 * @param {string} secret - Base32 encoded secret
 * @param {number} window - Number of time steps to check before/after (default 1)
 * @param {number} timeStep - Time step in seconds (default 30)
 * @param {number} digits - Number of digits (default 6)
 */
export async function verifyTOTP(token, secret, window = 1, timeStep = 30, digits = 6) {
  if (!token || !secret) {
    return false;
  }
  
  // Normalize token
  const normalizedToken = token.replace(/\s/g, '');
  
  if (normalizedToken.length !== digits) {
    return false;
  }
  
  const timestamp = Date.now();
  const counter = Math.floor(timestamp / 1000 / timeStep);
  
  // Check current and adjacent time windows
  // Process sequentially for security (timing attack protection)
  for (let i = -window; i <= window; i++) {
    // eslint-disable-next-line no-await-in-loop
    const expectedToken = await generateHOTP(secret, counter + i, digits);
    if (timingSafeEqual(normalizedToken, expectedToken)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Generate HOTP code (HMAC-based One-Time Password)
 * @param {string} secret - Base32 encoded secret
 * @param {number} counter - Counter value
 * @param {number} digits - Number of digits
 */
async function generateHOTP(secret, counter, digits = 6) {
  // Decode base32 secret
  const keyData = base32Decode(secret);
  
  // Convert counter to 8-byte buffer (big-endian)
  const counterBuffer = new ArrayBuffer(8);
  const counterView = new DataView(counterBuffer);
  counterView.setBigUint64(0, BigInt(counter), false);
  
  // Import key for HMAC
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  
  // Generate HMAC
  const signature = await crypto.subtle.sign('HMAC', key, counterBuffer);
  const hmac = new Uint8Array(signature);
  
  // Dynamic truncation (RFC 4226)
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = 
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  
  // Generate OTP
  const otp = binary % Math.pow(10, digits);
  return otp.toString().padStart(digits, '0');
}

/**
 * Generate otpauth URI for QR codes
 * @param {string} secret - Base32 encoded secret
 * @param {string} accountName - User's account name (usually email)
 * @param {string} issuer - App name
 */
export function generateTOTPUri(secret, accountName, issuer = 'XoraSocial') {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedAccount = encodeURIComponent(accountName);
  return `otpauth://totp/${encodedIssuer}:${encodedAccount}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
}

/**
 * Generate backup codes for account recovery
 * @param {number} count - Number of backup codes to generate
 */
export function generateBackupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const array = new Uint8Array(4);
    crypto.getRandomValues(array);
    const code = Array.from(array)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    // Format as XXXX-XXXX
    codes.push(`${code.slice(0, 4)}-${code.slice(4, 8)}`);
  }
  return codes;
}

/**
 * Hash backup codes for secure storage
 */
export async function hashBackupCodes(codes) {
  // Hash all codes in parallel
  const hashPromises = codes.map(async (code) => {
    const normalized = code.replace(/-/g, '').toUpperCase();
    const encoder = new TextEncoder();
    const data = encoder.encode(normalized);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  });

  return await Promise.all(hashPromises);
}

/**
 * Verify a backup code
 */
export async function verifyBackupCode(code, hashedCodes) {
  const normalized = code.replace(/-/g, '').toUpperCase();
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hashHex = Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  const index = hashedCodes.indexOf(hashHex);
  return { valid: index !== -1, index };
}

// ============================================
// BASE32 ENCODING/DECODING (RFC 4648)
// ============================================

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  const bytes = new Uint8Array(buffer);
  let result = '';
  let bits = 0;
  let value = 0;
  
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    
    while (bits >= 5) {
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  
  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  
  return result;
}

function base32Decode(str) {
  // Remove padding and spaces, convert to uppercase
  const normalized = str.replace(/[\s=]/g, '').toUpperCase();
  
  const result = [];
  let bits = 0;
  let value = 0;
  
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base32 character: ${char}`);
    }
    
    value = (value << 5) | index;
    bits += 5;
    
    if (bits >= 8) {
      result.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  
  return new Uint8Array(result);
}

// ============================================
// TIMING-SAFE COMPARISON
// ============================================

function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  
  return result === 0;
}
