// ============================================
// AUTH CONTROLLER
// ============================================

import { DatabaseService } from '../services/database.js';
import { generateTokenPair, verifyToken, hashToken, initJWT } from '../services/jwt.js';
import { createSecurityService } from '../services/securityService.js';
import { getCsrfProtection } from '../middleware/csrfProtection.js';
import {
  generateTOTPSecret,
  generateTOTPUri,
  verifyTOTP,
  generateBackupCodes,
  hashBackupCodes,
  verifyBackupCode
} from '../services/totp.js';
import {
  hashPassword,
  verifyPassword,
  generateId,
  now,
  hoursFromNow,
  isValidEmail,
  isValidUsername,
  generateCode,
  generateToken,
  errorResponse,
  successResponse,
  getNoCacheHeaders
} from '../utils/helpers.js';
import { processLoginWithDeviceTracking } from './authExtensions.js';
import { getCachedDB } from '../services/cachedQuery.js';

/**
 * Helper to create httpOnly cookie headers for tokens
 * @param {string} accessToken - JWT access token
 * @param {string} refreshToken - JWT refresh token
 * @param {Object} env - Environment variables
 * @returns {string[]} Array of Set-Cookie headers
 */
function createTokenCookies(accessToken, refreshToken, env) {
  const isProduction = env.ENVIRONMENT === 'production';
  // Use COOKIE_DOMAIN if set, otherwise derive from environment
  const domain = env.COOKIE_DOMAIN || (isProduction ? '.xorasocial.com' : undefined);

  // Cookie options for security
  // Use SameSite=Lax in development to work with Vite proxy, Strict in production
  const baseOptions = [
    'HttpOnly',
    isProduction ? 'SameSite=none' : 'SameSite=Lax',
    isProduction ? 'Secure' : '',
    domain ? `Domain=${domain}` : '',
    'Path=/'
  ].filter(Boolean).join('; ');

  const cookies = [];

  // Access token cookie - 15 minutes (900 seconds)
  if (accessToken) {
    cookies.push(`xora_access_token=${accessToken}; ${baseOptions}; Max-Age=900`);
  }

  // Refresh token cookie - 30 days (2592000 seconds, matches JWT_REFRESH_EXPIRY in wrangler.toml)
  if (refreshToken) {
    cookies.push(`xora_refresh_token=${refreshToken}; ${baseOptions}; Max-Age=2592000`);
  }

  return cookies;
}

/**
 * Helper to create cookie headers that clear auth tokens (for logout)
 * @param {Object} env - Environment variables
 * @returns {string[]} Array of Set-Cookie headers
 */
function clearTokenCookies(env) {
  const isProduction = env.ENVIRONMENT === 'production';
  // Use COOKIE_DOMAIN if set, otherwise derive from environment
  const domain = env.COOKIE_DOMAIN || (isProduction ? '.xorasocial.com' : undefined);

  const baseOptions = [
    'HttpOnly',
    isProduction ? 'SameSite=none' : 'SameSite=Lax',
    isProduction ? 'Secure' : '',
    domain ? `Domain=${domain}` : '',
    'Path=/',
    'Max-Age=0'
  ].filter(Boolean).join('; ');

  return [
    `xora_access_token=; ${baseOptions}`,
    `xora_refresh_token=; ${baseOptions}`
  ];
}

export class AuthController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
    this.cached = getCachedDB(this.db.db);
    // Initialize JWT with environment
    initJWT(env);
    // Initialize security service for rate limiting, etc
    this.security = createSecurityService(env, env.CACHE);
    // Initialize CSRF protection with environment
    this.csrfProtection = getCsrfProtection(env);
  }

  /**
   * POST /auth/signup
   * Register new user with email verification requirement
   * User must verify email before they can fully use the account
   */
  async signup(request) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { name, email, username, password } = body;

      // Validation
      if (name && email && username && password) {
        // All fields are present, continue
      } else {
        return errorResponse('All fields are required', 400, {
          name: name ? null : 'Name is required',
          email: email ? null : 'Email is required',
          username: username ? null : 'Username is required',
          password: password ? null : 'Password is required'
        });
      }

      if (!isValidEmail(email)) {
        return errorResponse('Invalid email format', 400, {
          email: 'Please enter a valid email address'
        });
      }

      // Block disposable/temporary email domains
      if (this.security.isDisposableEmail(email)) {
        return errorResponse('Disposable email addresses are not allowed', 400, {
          email: 'Please use a permanent email address. Temporary/disposable emails are not accepted.'
        });
      }

      if (!isValidUsername(username)) {
        return errorResponse('Invalid username', 400, {
          username: 'Username must be 3-30 characters, alphanumeric and underscores only'
        });
      }

      if (password.length < 8 || !/[0-9]/.test(password)) {
        return errorResponse('Password too weak', 400, {
          password: 'Password must be at least 8 characters and include at least one number'
        });
      }

      // Check if email exists
      const existingEmail = await this.db.getUserByEmail(email);
      if (existingEmail) {
        return errorResponse('Email already taken', 400, {
          email: 'This email is already registered'
        });
      }

      // Check if username exists
      const existingUsername = await this.db.getUserByUsername(username);
      if (existingUsername) {
        return errorResponse('Username already taken', 400, {
          username: 'This username is already taken'
        });
      }

      // Hash password
      const passwordHash = await hashPassword(password);

      // Create user (email_verified defaults to 0/false)
      const user = await this.db.createUser({
        name,
        email,
        username,
        passwordHash
      });

      // Generate email verification code and send it
      const verificationCode = generateCode(6);
      await this.env.DB.prepare(`
        INSERT INTO email_verification_codes (id, email, code, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        generateId('evc'),
        user.email,
        verificationCode,
        hoursFromNow(24), // 24 hours to verify
        now()
      ).run();

      // Send verification email
      const fromEmail = this.env.EMAIL_FROM || this.env.FROM_EMAIL;
      if (fromEmail && this.env.RESEND_API_KEY) {
        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.env.RESEND_API_KEY}`,
            },
            body: JSON.stringify({
              from: fromEmail,
              to: user.email,
              subject: 'Verify your Xora Social email',
              html: `
                <h2>Welcome to Xora Social!</h2>
                <p>Your verification code is: <strong>${verificationCode}</strong></p>
                <p>This code expires in 24 hours.</p>
                <p>If you didn't create an account, please ignore this email.</p>
              `,
              text: `Welcome to Xora Social! Your verification code is ${verificationCode}. This code expires in 24 hours.`,
            }),
          });
        } catch (e) {
          console.error('Failed to send verification email via Resend:', e);
        }
      } else if (this.env.ENVIRONMENT !== 'production') {
        // eslint-disable-next-line no-console
        console.log(`[DEV] Email verification code for ${user.email}: ${verificationCode}`);
      }

      // Generate temporary token for email verification flow
      // User cannot fully login until email is verified
      const tempToken = generateToken();
      try {
        await this.env.CACHE.put(
          `signup_pending:${tempToken}`,
          JSON.stringify({ userId: user.id, email: user.email }),
          { expirationTtl: 86400 } // 24 hours
        );
      } catch (cacheError) {
        console.error('Failed to cache signup pending data:', cacheError);
        // Continue anyway - user can still verify via email if sent
      }

      // Return response indicating email verification is required
      // Do NOT issue auth tokens yet - user must verify email first
      return successResponse({
        requiresEmailVerification: true,
        tempToken,
        email: user.email,
        message: `A verification code has been sent to ${user.email}. Please verify your email to complete registration.`
      }, 'Account created. Please verify your email to continue.');

    } catch (error) {
      console.error('Signup error:', error);
      return errorResponse('Signup failed', 500);
    }
  }

  /**
   * POST /auth/complete-signup
   * Complete signup after email verification
   */
  async completeSignup(request) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { tempToken, code } = body;

      if (!tempToken || !code) {
        return errorResponse('Verification token and code are required', 400);
      }

      // Get pending signup data
      const pendingData = await this.env.CACHE.get(`signup_pending:${tempToken}`);
      if (!pendingData) {
        return errorResponse('Invalid or expired verification session', 401);
      }

      let email; let 
userId;
      try {
        ({ userId, email } = JSON.parse(pendingData));
      } catch {
        return errorResponse('Invalid verification session data', 400);
      }

      // Verify the code
      const verification = await this.env.DB.prepare(`
        SELECT * FROM email_verification_codes
        WHERE email = ? AND code = ? AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1
      `).bind(email, code, now()).first();

      if (!verification) {
        return errorResponse('Invalid or expired verification code', 401);
      }

      // Mark email as verified
      await this.env.DB.prepare(`
        UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?
      `).bind(now(), userId).run();

      // Delete used code
      await this.env.DB.prepare(`
        DELETE FROM email_verification_codes WHERE id = ?
      `).bind(verification.id).run();

      // Delete pending signup token
      await this.env.CACHE.delete(`signup_pending:${tempToken}`);

      // Get user data
      const user = await this.db.getUserById(userId);
      if (!user) {
        return errorResponse('User not found', 404);
      }

      // Email verified successfully!
      // Store email + credentials in cache so user can proceed to device verification without re-entering password
      const signupVerificationToken = generateToken();
      try {
        await this.env.CACHE.put(
          `signup_verified:${signupVerificationToken}`,
          JSON.stringify({ userId: user.id, email: user.email }),
          { expirationTtl: 3600 } // 1 hour to complete sign-in
        );
      } catch (cacheError) {
        console.error('Failed to cache signup verified data:', cacheError);
      }

      // Return success response with redirect instruction
      // Frontend should route to /signin with this token
      return successResponse({
        emailVerified: true,
        userId: user.id,
        email: user.email,
        signupVerificationToken,
        message: 'Email verified successfully! Please sign in to complete device verification.'
      }, 'Email verified! Completing registration...');

    } catch (error) {
      console.error('Complete signup error:', error);
      return errorResponse('Failed to complete signup', 500);
    }
  }

  /**
   * POST /auth/resend-signup-verification
   * Resend verification code for pending signup
   */
  async resendSignupVerification(request) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { tempToken } = body;

      if (!tempToken) {
        return errorResponse('Verification token is required', 400);
      }

      // Get pending signup data
      const pendingData = await this.env.CACHE.get(`signup_pending:${tempToken}`);
      if (!pendingData) {
        return errorResponse('Invalid or expired verification session', 401);
      }

      let email; let 
userId;
      try {
        ({ userId, email } = JSON.parse(pendingData));
      } catch {
        return errorResponse('Invalid verification session data', 400);
      }

      // Check user still exists and is not already verified
      const user = await this.db.getUserById(userId);
      if (!user) {
        return errorResponse('User not found', 404);
      }
      if (user.email_verified) {
        return errorResponse('Email already verified', 400);
      }

      // Delete old verification codes for this email
      await this.env.DB.prepare(`
        DELETE FROM email_verification_codes WHERE email = ?
      `).bind(email).run();

      // Generate new verification code
      const verificationCode = generateCode(6);
      await this.env.DB.prepare(`
        INSERT INTO email_verification_codes (id, email, code, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        generateId('evc'),
        email,
        verificationCode,
        hoursFromNow(24),
        now()
      ).run();

      // Send verification email
      const fromEmail = this.env.EMAIL_FROM || this.env.FROM_EMAIL;
      if (fromEmail && this.env.RESEND_API_KEY) {
        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.env.RESEND_API_KEY}`,
            },
            body: JSON.stringify({
              from: fromEmail,
              to: email,
              subject: 'Verify your Xora Social email',
              html: `
                <h2>Xora Social Email Verification</h2>
                <p>Your new verification code is: <strong>${verificationCode}</strong></p>
                <p>This code expires in 24 hours.</p>
              `,
              text: `Your new Xora Social verification code is ${verificationCode}. This code expires in 24 hours.`,
            }),
          });
        } catch (e) {
          console.error('Failed to send verification email via Resend:', e);
        }
      } else if (this.env.ENVIRONMENT !== 'production') {
        // eslint-disable-next-line no-console
        console.log(`[DEV] Email verification code for ${email}: ${verificationCode}`);
      }

      return successResponse({
        message: `A new verification code has been sent to ${email}`
      }, 'Verification code sent');

    } catch (error) {
      console.error('Resend signup verification error:', error);
      return errorResponse('Failed to resend verification', 500);
    }
  }

  /**
   * POST /auth/login
   * User login with IP pinning
   */
  async login(request) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { identifier, password } = body;

      if (!identifier || !password) {
        return errorResponse('Email/username and password are required', 400);
      }

      // Get client IP for rate limiting
      const clientIP = this.security.getClientIP(request);

      // Find user by email or username
      let user;
      if (isValidEmail(identifier)) {
        user = await this.cached.getUserByEmail(identifier);
      } else {
        user = await this.cached.getUserByUsername(identifier);
      }

      if (!user) {
        // Record failed attempt
        await this.security.recordFailedLogin(identifier, clientIP);
        return errorResponse('Invalid credentials', 401);
      }

      // Check if password_hash exists (user must have set a password)
      if (!user.password_hash) {
        console.error(`[Auth] User ${user.id} (${identifier}) has no password_hash set - account may not have been properly created`);
        // Record failed attempt
        await this.security.recordFailedLogin(identifier, clientIP);
        return errorResponse('Invalid credentials', 401);
      }

      // Verify password
      const isValid = await verifyPassword(password, user.password_hash);
      if (!isValid) {
        // Record failed attempt
        await this.security.recordFailedLogin(identifier, clientIP);
        return errorResponse('Invalid credentials', 401);
      }

      // Password correct - clear failed attempts
      await this.security.clearFailedLogins(identifier, clientIP);

      // Check if 2FA is enabled
      if (user.two_factor_enabled) {
        // Return temporary token for 2FA verification
        const tempToken = generateToken();
        
        await this.env.CACHE.put(
          `2fa_pending:${tempToken}`,
          user.id,
          { expirationTtl: 600 } // 10 minutes
        );

        return successResponse({
          requires2FA: true,
          tempToken
        }, 'Please enter your 2FA code');
      }

      // Prepare device info if provided by client
      const deviceInfo = body.deviceInfo || body.device || null;

      // Handle login with device tracking and session management
      const loginResult = await processLoginWithDeviceTracking(
        this.env.DB,
        this.env,
        user,
        request,
        deviceInfo
      );

      if (loginResult.requiresDeviceVerification) {
        const message =
          loginResult.message ||
          `A verification code has been sent to ${user.email}. Please check your email to verify this device.`;

        // Device verification response prepared

        // Do not issue tokens yet; user must verify this device first
        return successResponse(
          {
            requiresDeviceVerification: true,
            tempToken: loginResult.tempToken,
            message,
          },
          message
        );
      }

      // Device is verified; proceed with normal login response
      // Get settings
      const settings = await this.cached.getUserSettings(user.id);

      // Remove sensitive data
      delete user.password_hash;
      delete user.two_factor_secret;

      // Generate CSRF token
      const { token: csrfToken, cookieHeader: csrfCookie } = this.csrfProtection.issueToken();

      // Create httpOnly token cookies
      const tokenCookies = createTokenCookies(
        loginResult.tokens.accessToken,
        loginResult.tokens.refreshToken,
        this.env
      );

      const responseData = successResponse(
        {
          user: {
            ...user,
            settings,
          },
          // Include tokens in response body for mobile/admin apps (they can't use httpOnly cookies)
          // Web apps should use the httpOnly cookies set in response headers for better security
          tokens: {
            accessToken: loginResult.tokens.accessToken,
            refreshToken: loginResult.tokens.refreshToken,
          },
          csrfToken
        },
        'Login successful'
      );

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
      console.error('Login error:', error);
      return errorResponse('Login failed', 500);
    }
  }

  /**
   * POST /auth/logout
   * Logout user (invalidate refresh token and clear cookies)
   */
  async logout(request, userId) {
    try {
      // Try to get refresh token from cookie first, then body
      const cookies = request.headers.get('Cookie') || '';
      const refreshTokenFromCookie = cookies.match(/xora_refresh_token=(?<token>[^;]+)/)?.groups?.token;

      let refreshToken = refreshTokenFromCookie;

      // Fallback to body for mobile apps
      if (!refreshToken) {
        try {
          const body = await request.json();
          ({ refreshToken } = body);
        } catch {
          // No body, that's OK
        }
      }

      if (refreshToken) {
        const tokenHash = await hashToken(refreshToken);

        // Delete refresh token
        await this.env.DB.prepare(`
          DELETE FROM refresh_tokens
          WHERE user_id = ? AND token_hash = ?
        `).bind(userId, tokenHash).run();
      }

      // Clear auth cookies
      const clearCookies = clearTokenCookies(this.env);

      const responseData = successResponse(null, 'Logged out successfully');

      const headers = new Headers({
        'Content-Type': 'application/json',
        ...getNoCacheHeaders()
      });

      clearCookies.forEach(cookie => headers.append('Set-Cookie', cookie));

      return new Response(JSON.stringify(responseData), {
        status: 200,
        headers
      });

    } catch (error) {
      console.error('Logout error:', error);
      return errorResponse('Logout failed', 500);
    }
  }

  /**
   * POST /auth/refresh
   * Refresh access token with IP pinning and token rotation
   * Reads refresh token from httpOnly cookie (web) or body (mobile)
   */
  async refresh(request) {
    try {
      // Try to get refresh token from cookie first (web), then body (mobile)
      const cookies = request.headers.get('Cookie') || '';
      const refreshTokenFromCookie = cookies.match(/xora_refresh_token=(?<token>[^;]+)/)?.groups?.token;

      let refreshToken = refreshTokenFromCookie;

      // Fallback to body for mobile apps
      if (!refreshToken) {
        try {
          const body = await request.json();
          refreshToken = body.refreshToken;
        } catch {
          // No body
        }
      }

      if (!refreshToken) {
        return errorResponse('Refresh token required', 400);
      }

      // Get client IP for IP pinning validation
      const clientIP = this.security.getClientIP(request);

      // Verify refresh token with IP pinning
      const payload = await verifyToken(refreshToken, clientIP);
      if (!payload || payload.type !== 'refresh') {
        return errorResponse('Invalid refresh token', 401);
      }

      // Check if token exists in database
      const tokenHash = await hashToken(refreshToken);
      const storedToken = await this.env.DB.prepare(`
        SELECT * FROM refresh_tokens 
        WHERE user_id = ? AND token_hash = ?
      `).bind(payload.userId, tokenHash).first();

      if (!storedToken) {
        return errorResponse('Invalid refresh token', 401);
      }

      // Check if expired
      if (storedToken.expires_at < now()) {
        // Delete expired token
        await this.env.DB.prepare(`
          DELETE FROM refresh_tokens WHERE id = ?
        `).bind(storedToken.id).run();

        return errorResponse('Refresh token expired', 401);
      }

      // Load current user token version
      const user = await this.env.DB.prepare(`
        SELECT id, email, token_version
        FROM users
        WHERE id = ?
      `).bind(payload.userId).first();

      if (!user) {
        return errorResponse('User not found', 404);
      }

      // Reject tokens that were invalidated by token_version bump
      if (
        typeof payload.tokenVersion !== 'undefined' &&
        payload.tokenVersion !== user.token_version
      ) {
        // Clean up this stale refresh token
        await this.env.DB.prepare(`
          DELETE FROM refresh_tokens WHERE id = ?
        `).bind(storedToken.id).run();

        return errorResponse('Invalid refresh token', 401);
      }

      // TOKEN ROTATION: Generate new refresh token and invalidate old one
      const newRefreshTokenId = generateId('rt');
      const { accessToken, refreshToken: newRefreshToken } = await generateTokenPair(
        user.id,
        user.email,
        user.token_version || 0,
        newRefreshTokenId // Include refresh token ID for tracking
      );

      // Store new refresh token FIRST to prevent race condition
      // If this fails, user still has their old token
      const newTokenHash = await hashToken(newRefreshToken);
      await this.env.DB.prepare(`
        INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        newRefreshTokenId,
        user.id,
        newTokenHash,
        hoursFromNow(720), // 30 days
        now()
      ).run();

      // Delete old refresh token AFTER new one is safely stored
      await this.env.DB.prepare(`
        DELETE FROM refresh_tokens WHERE id = ?
      `).bind(storedToken.id).run();

      // Create httpOnly token cookies for web clients
      const tokenCookies = createTokenCookies(accessToken, newRefreshToken, this.env);

      const { token: csrfToken, cookieHeader: csrfCookie } = this.csrfProtection.issueToken();

      const responseData = successResponse(
        {
          // For mobile apps that may still use body-based tokens
          accessToken,
          refreshToken: newRefreshToken,
          csrfToken
        },
        'Token refreshed and rotated'
      );

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
      console.error('Refresh error:', error);
      return errorResponse('Token refresh failed', 500);
    }
  }

  /**
   * GET /auth/me
   * Get current user profile
   */
  async me(request, userId) {
    try {
      const user = await this.db.getUserById(userId);
      
      if (!user) {
        return errorResponse('User not found', 404);
      }

      // Get settings
      const settings = await this.db.getUserSettings(userId);

      // Remove sensitive data
      delete user.password_hash;
      delete user.two_factor_secret;

      return successResponse({
        ...user,
        settings
      });

    } catch (error) {
      console.error('Get me error:', error);
      return errorResponse('Failed to get user', 500);
    }
  }

  /**
   * POST /auth/change-password
   * Change password
   */
  async changePassword(request, userId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { currentPassword, newPassword } = body;

      if (!currentPassword || !newPassword) {
        return errorResponse('Current and new password required', 400);
      }

      if (newPassword.length < 8 || !/[0-9]/.test(newPassword)) {
        return errorResponse('New password must be at least 8 characters and include at least one number', 400);
      }

      // Get user
      const user = await this.db.getUserById(userId);

      if (!user) {
        return errorResponse('User not found', 404);
      }

      // Check if password_hash exists
      if (!user.password_hash) {
        console.error(`[Auth] User ${userId} has no password_hash - cannot verify current password`);
        return errorResponse('Password not set for this account', 400);
      }

      // Verify current password
      const isValid = await verifyPassword(currentPassword, user.password_hash);
      if (!isValid) {
        return errorResponse('Current password is incorrect', 401);
      }

      // Hash new password
      const passwordHash = await hashPassword(newPassword);

      // Update password and increment token_version to invalidate all existing tokens
      await this.env.DB.prepare(`
        UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?
      `).bind(passwordHash, now(), userId).run();

      // Invalidate all refresh tokens
      await this.env.DB.prepare(`
        DELETE FROM refresh_tokens WHERE user_id = ?
      `).bind(userId).run();

      return successResponse(null, 'Password changed successfully. Please login again.');

    } catch (error) {
      console.error('Change password error:', error);
      return errorResponse('Failed to change password', 500);
    }
  }

  /**
   * POST /auth/forgot-password
   * Request password reset
   */
  async forgotPassword(request) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { email } = body;

      if (!email || !isValidEmail(email)) {
        return errorResponse('Valid email required', 400);
      }

      const user = await this.db.getUserByEmail(email);

      // Always return success (don't reveal if email exists)
      if (!user) {
        return successResponse(null, 'If the email exists, a reset code has been sent');
      }

      // Generate reset code
      const code = generateCode(6);
      const tokenHash = await hashToken(code);

      // Store reset token
      await this.env.DB.prepare(`
        INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        generateId('prt'),
        user.id,
        tokenHash,
        hoursFromNow(1), // 1 hour
        now()
      ).run();

      // Send email with code if email service is configured; otherwise log in non-production
      const fromEmail = this.env.EMAIL_FROM || this.env.FROM_EMAIL;
      if (fromEmail && this.env.RESEND_API_KEY) {
        try {
          const payload = {
            from: fromEmail,
            to: email,
            subject: 'Xora Social password reset',
            text: `Your Xora Social password reset code is ${code}. It expires in 1 hour.`,
          };
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.env.RESEND_API_KEY}`,
            },
            body: JSON.stringify(payload),
          });
        } catch (e) {
          console.error('Failed to send password reset email via Resend:', e);
        }
      } else if (this.env.ENVIRONMENT !== 'production') {
        // Password reset code sent
      }

      return successResponse(null, 'If the email exists, a reset code has been sent');

    } catch (error) {
      console.error('Forgot password error:', error);
      return errorResponse('Failed to process request', 500);
    }
  }

  /**
   * POST /auth/reset-password
   * Reset password with code
   */
  async resetPassword(request) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { email, code, newPassword } = body;

      if (!email || !code || !newPassword) {
        return errorResponse('Email, code, and new password required', 400);
      }

      if (newPassword.length < 8 || !/[0-9]/.test(newPassword)) {
        return errorResponse('Password must be at least 8 characters and include at least one number', 400);
      }

      const user = await this.db.getUserByEmail(email);
      if (!user) {
        return errorResponse('Invalid reset code', 401);
      }

      // Verify reset code
      const tokenHash = await hashToken(code);
      const resetToken = await this.env.DB.prepare(`
        SELECT * FROM password_reset_tokens
        WHERE user_id = ? AND token_hash = ? AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1
      `).bind(user.id, tokenHash, now()).first();

      if (!resetToken) {
        return errorResponse('Invalid or expired reset code', 401);
      }

      // Hash new password
      const passwordHash = await hashPassword(newPassword);

      // Update password and increment token_version to invalidate all existing tokens
      await this.env.DB.prepare(`
        UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?
      `).bind(passwordHash, now(), user.id).run();

      // Delete used reset token
      await this.env.DB.prepare(`
        DELETE FROM password_reset_tokens WHERE id = ?
      `).bind(resetToken.id).run();

      // Invalidate all refresh tokens
      await this.env.DB.prepare(`
        DELETE FROM refresh_tokens WHERE user_id = ?
      `).bind(user.id).run();

      return successResponse(null, 'Password reset successfully. Please login.');

    } catch (error) {
      console.error('Reset password error:', error);
      return errorResponse('Failed to reset password', 500);
    }
  }

  /**
   * POST /auth/send-verification
   * Send email verification code
   */
  async sendVerification(request, userId) {
    try {
      const user = await this.db.getUserById(userId);

      if (!user) {
        return errorResponse('User not found', 404);
      }

      if (user.email_verified) {
        return errorResponse('Email already verified', 400);
      }

      // Generate verification code
      const code = generateCode(6);

      // Store code
      await this.env.DB.prepare(`
        INSERT INTO email_verification_codes (id, email, code, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        generateId('evc'),
        user.email,
        code,
        hoursFromNow(1), // 1 hour
        now()
      ).run();

      // Send verification email if service is configured; otherwise log in non-production
      const fromEmail = this.env.EMAIL_FROM || this.env.FROM_EMAIL;
      if (fromEmail && this.env.RESEND_API_KEY) {
        try {
          const payload = {
            from: fromEmail,
            to: user.email,
            subject: 'Verify your Xora Social email',
            text: `Your Xora Social verification code is ${code}. It expires in 1 hour.`,
          };
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.env.RESEND_API_KEY}`,
            },
            body: JSON.stringify(payload),
          });
        } catch (e) {
          console.error('Failed to send verification email via Resend:', e);
        }
      } else if (this.env.ENVIRONMENT !== 'production') {
        // Verification code sent
      }

      return successResponse(null, 'Verification code sent to your email');

    } catch (error) {
      console.error('Send verification error:', error);
      return errorResponse('Failed to send verification', 500);
    }
  }

  /**
   * POST /auth/verify-email
   * Verify email with code
   */
  async verifyEmail(request, userId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { code } = body;

      if (!code) {
        return errorResponse('Verification code required', 400);
      }

      const user = await this.db.getUserById(userId);

      if (!user) {
        return errorResponse('User not found', 404);
      }

      // Check code
      const verification = await this.env.DB.prepare(`
        SELECT * FROM email_verification_codes
        WHERE email = ? AND code = ? AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1
      `).bind(user.email, code, now()).first();

      if (!verification) {
        return errorResponse('Invalid or expired code', 401);
      }

      // Mark email as verified
      await this.env.DB.prepare(`
        UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?
      `).bind(now(), userId).run();

      // Delete used code
      await this.env.DB.prepare(`
        DELETE FROM email_verification_codes WHERE id = ?
      `).bind(verification.id).run();

      return successResponse(null, 'Email verified successfully');

    } catch (error) {
      console.error('Verify email error:', error);
      return errorResponse('Verification failed', 500);
    }
  }

  /**
   * POST /auth/enable-2fa
   * Enable two-factor authentication
   */
  async enable2FA(request, userId) {
    try {
      const user = await this.db.getUserById(userId);

      if (!user) {
        return errorResponse('User not found', 404);
      }

      if (user.two_factor_enabled) {
        return errorResponse('2FA is already enabled', 400);
      }

      // Generate TOTP secret (base32 encoded)
      const secret = generateTOTPSecret();

      // Generate backup codes
      const backupCodes = generateBackupCodes(10);
      const hashedBackupCodes = await hashBackupCodes(backupCodes);

      // Store secret and backup codes temporarily (user needs to verify setup)
      await this.env.CACHE.put(
        `2fa_setup:${userId}`,
        JSON.stringify({ 
          secret, 
          backupCodes: hashedBackupCodes 
        }),
        { expirationTtl: 600 } // 10 minutes
      );

      // Generate QR code URI
      const qrCodeUri = generateTOTPUri(secret, user.email, 'XoraSocial');
      
      // Response fields are shaped to work with web and mobile clients:
      // - otpauthUrl / qrCodeUri for QR
      // - secret (base32) for manual entry
      // - backupCodes shown once on setup screen
      return successResponse({
        secret,
        otpauthUrl: qrCodeUri,
        qrCodeUri,
        backupCodes,
        message: 'Scan QR code with your authenticator app (Google Authenticator, Authy, etc.)'
      }, 'Scan QR code and enter the code to verify');

    } catch (error) {
      console.error('Enable 2FA error:', error);
      return errorResponse('Failed to enable 2FA', 500);
    }
  }

  /**
   * POST /auth/verify-2fa-setup
   * Verify and finalize 2FA setup
   */
  async verify2FASetup(request, userId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { code } = body;

      if (!code) {
        return errorResponse('2FA code required', 400);
      }

      // Get temporary secret and backup codes
      const setupData = await this.env.CACHE.get(`2fa_setup:${userId}`);
      if (!setupData) {
        return errorResponse('2FA setup expired. Please try again.', 400);
      }

      let backupCodes;
      let secret;
      try {
        ({ secret, backupCodes } = JSON.parse(setupData));
      } catch (error) {
        return errorResponse('Invalid 2FA setup data', 400);
      }

      // Verify TOTP code
      const isValid = await verifyTOTP(code, secret);
      if (!isValid) {
        return errorResponse('Invalid 2FA code. Please try again.', 401);
      }

      // Encrypt secret before storing (using simple encryption with env secret)
      const encryptedSecret = await this.encryptSecret(secret);

      // Save secret and enable 2FA
      await this.env.DB.prepare(`
        UPDATE users 
        SET two_factor_enabled = 1, two_factor_secret = ?, updated_at = ?
        WHERE id = ?
      `).bind(encryptedSecret, now(), userId).run();

      // Store hashed backup codes
      await this.env.DB.prepare(`
        DELETE FROM two_factor_backup_codes WHERE user_id = ?
      `).bind(userId).run();

      // Insert backup codes sequentially (small number, order doesn't matter)
      for (const hashedCode of backupCodes) {
        // eslint-disable-next-line no-await-in-loop
        await this.env.DB.prepare(`
          INSERT INTO two_factor_backup_codes (id, user_id, code_hash, used, created_at)
          VALUES (?, ?, ?, 0, ?)
        `).bind(generateId('2fa_backup'), userId, hashedCode, now()).run();
      }

      // Delete temporary setup data
      await this.env.CACHE.delete(`2fa_setup:${userId}`);

      return successResponse({
        enabled: true
      }, '2FA enabled successfully. Keep your backup codes safe!');

    } catch (error) {
      console.error('Verify 2FA setup error:', error);
      return errorResponse('Failed to verify 2FA', 500);
    }
  }

  /**
   * POST /auth/disable-2fa
   * Disable two-factor authentication
   */
  async disable2FA(request, userId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { password, code } = body;

      if (!password) {
        return errorResponse('Password required', 400);
      }

      if (!code) {
        return errorResponse('2FA code required to disable 2FA', 400);
      }

      const user = await this.db.getUserById(userId);

      if (!user) {
        return errorResponse('User not found', 404);
      }

      if (!user.two_factor_enabled) {
        return errorResponse('2FA is not enabled', 400);
      }

      // Check if password_hash exists
      if (!user.password_hash) {
        console.error(`[Auth] User ${userId} has no password_hash for 2FA disable`);
        return errorResponse('Password not set for this account', 400);
      }

      // Verify password
      const isPasswordValid = await verifyPassword(password, user.password_hash);
      if (!isPasswordValid) {
        return errorResponse('Invalid password', 401);
      }

      // Decrypt and verify TOTP code
      const secret = await this.decryptSecret(user.two_factor_secret);
      const isCodeValid = await verifyTOTP(code, secret);
      if (!isCodeValid) {
        return errorResponse('Invalid 2FA code', 401);
      }

      // Disable 2FA
      await this.env.DB.prepare(`
        UPDATE users 
        SET two_factor_enabled = 0, two_factor_secret = NULL, updated_at = ?
        WHERE id = ?
      `).bind(now(), userId).run();

      // Delete backup codes
      await this.env.DB.prepare(`
        DELETE FROM two_factor_backup_codes WHERE user_id = ?
      `).bind(userId).run();

      return successResponse(null, '2FA disabled successfully');

    } catch (error) {
      console.error('Disable 2FA error:', error);
      return errorResponse('Failed to disable 2FA', 500);
    }
  }

  /**
   * POST /auth/verify-2fa-login
   * Verify 2FA code during login
   */
  async verify2FALogin(request) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { tempToken, code, isBackupCode } = body;

      if (!tempToken || !code) {
        return errorResponse('Temp token and 2FA code required', 400);
      }

      // Get user ID from temp token
      const userId = await this.env.CACHE.get(`2fa_pending:${tempToken}`);
      if (!userId) {
        return errorResponse('Invalid or expired temp token', 401);
      }

      const user = await this.db.getUserById(userId);

      if (!user) {
        return errorResponse('User not found', 404);
      }

      let isValid = false;

      if (isBackupCode) {
        // Verify backup code
        const backupCodesResult = await this.env.DB.prepare(`
          SELECT * FROM two_factor_backup_codes 
          WHERE user_id = ? AND used = 0
        `).bind(userId).all();

        const hashedCodes = (backupCodesResult.results || []).map(r => r.code_hash);
        const verifyResult = await verifyBackupCode(code, hashedCodes);
        
        if (verifyResult.valid) {
          isValid = true;
          // Mark backup code as used
          const usedCode = (backupCodesResult.results || [])[verifyResult.index];
          if (usedCode && usedCode.id) {
            await this.env.DB.prepare(`
              UPDATE two_factor_backup_codes SET used = 1, used_at = ? WHERE id = ?
            `).bind(now(), usedCode.id).run();
          }
        }
      } else {
        // Verify TOTP code
        const secret = await this.decryptSecret(user.two_factor_secret);
        isValid = await verifyTOTP(code, secret);
      }

      if (!isValid) {
        return errorResponse('Invalid 2FA code', 401);
      }

      // Generate tokens with token version
      const tokenVersion = typeof user.token_version === 'number' ? user.token_version : 0;
      const { accessToken, refreshToken } = await generateTokenPair(user.id, user.email, tokenVersion);

      // Store refresh token
      const tokenHash = await hashToken(refreshToken);
      await this.env.DB.prepare(`
        INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        generateId('rt'),
        user.id,
        tokenHash,
        hoursFromNow(720), // 30 days
        now()
      ).run();

      // Delete temp token
      await this.env.CACHE.delete(`2fa_pending:${tempToken}`);

      // Get settings
      const settings = await this.db.getUserSettings(userId);

      // Remove sensitive data
      delete user.password_hash;
      delete user.two_factor_secret;

      // Create httpOnly token cookies
      const tokenCookies = createTokenCookies(accessToken, refreshToken, this.env);

      const responseData = successResponse({
        user: {
          ...user,
          settings
        },
        // Include tokens in response body for mobile/admin apps
        tokens: {
          accessToken,
          refreshToken,
        },
        csrfToken: this.csrfProtection.issueToken().token
      }, 'Login successful');

      const headers = new Headers({
        'Content-Type': 'application/json',
        ...getNoCacheHeaders()
      });

      tokenCookies.forEach(cookie => headers.append('Set-Cookie', cookie));

      return new Response(JSON.stringify(responseData), {
        status: 200,
        headers
      });

    } catch (error) {
      console.error('Verify 2FA login error:', error);
      return errorResponse('2FA verification failed', 500);
    }
  }

  /**
   * GET /auth/2fa/backup-codes
   * Get remaining backup codes count
   */
  async getBackupCodesCount(request, userId) {
    try {
      const result = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM two_factor_backup_codes 
        WHERE user_id = ? AND used = 0
      `).bind(userId).first();
      
      // Web/mobile expect at least a remaining count; expose both "remaining" and "remainingCodes"
      return successResponse({
        remaining: result ? result.count : 0,
        remainingCodes: result ? result.count : 0
      });

    } catch (error) {
      console.error('Get backup codes count error:', error);
      return errorResponse('Failed to get backup codes count', 500);
    }
  }

  /**
   * POST /auth/2fa/regenerate-backup-codes
   * Regenerate backup codes (requires password + 2FA)
   */
  async regenerateBackupCodes(request, userId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { password, code } = body;

      if (!password || !code) {
        return errorResponse('Password and 2FA code required', 400);
      }

      const user = await this.db.getUserById(userId);

      if (!user) {
        return errorResponse('User not found', 404);
      }

      if (!user.two_factor_enabled) {
        return errorResponse('2FA is not enabled', 400);
      }

      // Check if password_hash exists
      if (!user.password_hash) {
        console.error(`[Auth] User ${userId} has no password_hash for backup codes regeneration`);
        return errorResponse('Password not set for this account', 400);
      }

      // Verify password
      const isPasswordValid = await verifyPassword(password, user.password_hash);
      if (!isPasswordValid) {
        return errorResponse('Invalid password', 401);
      }

      // Verify TOTP code
      const secret = await this.decryptSecret(user.two_factor_secret);
      const isCodeValid = await verifyTOTP(code, secret);
      if (!isCodeValid) {
        return errorResponse('Invalid 2FA code', 401);
      }

      // Generate new backup codes
      const backupCodes = generateBackupCodes(10);
      const hashedBackupCodes = await hashBackupCodes(backupCodes);

      // Delete old and insert new backup codes
      await this.env.DB.prepare(`
        DELETE FROM two_factor_backup_codes WHERE user_id = ?
      `).bind(userId).run();

      // Insert new backup codes sequentially
      for (const hashedCode of hashedBackupCodes) {
        // eslint-disable-next-line no-await-in-loop
        await this.env.DB.prepare(`
          INSERT INTO two_factor_backup_codes (id, user_id, code_hash, used, created_at)
          VALUES (?, ?, ?, 0, ?)
        `).bind(generateId('2fa_backup'), userId, hashedCode, now()).run();
      }

      return successResponse({
        backupCodes
      }, 'New backup codes generated. Save these securely!');

    } catch (error) {
      console.error('Regenerate backup codes error:', error);
      return errorResponse('Failed to regenerate backup codes', 500);
    }
  }

  /**
   * Encrypt TOTP secret for storage
   */
  async encryptSecret(secret) {
    // Use AES-GCM encryption with environment secret
    const encryptionKey = this.env.ENCRYPTION_KEY || this.env.JWT_SECRET;
    if (!encryptionKey) {
      throw new Error('ENCRYPTION_KEY or JWT_SECRET not configured');
    }

    const encoder = new TextEncoder();
    const keyData = encoder.encode(encryptionKey.padEnd(32, '0').slice(0, 32));
    
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(secret)
    );

    // Combine IV + encrypted data
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);

    return btoa(String.fromCharCode(...combined));
  }

  /**
   * Decrypt TOTP secret from storage
   */
  async decryptSecret(encryptedSecret) {
    const encryptionKey = this.env.ENCRYPTION_KEY || this.env.JWT_SECRET;
    if (!encryptionKey) {
      throw new Error('ENCRYPTION_KEY or JWT_SECRET not configured');
    }

    const encoder = new TextEncoder();
    const keyData = encoder.encode(encryptionKey.padEnd(32, '0').slice(0, 32));
    
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    const combined = Uint8Array.from(atob(encryptedSecret), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const encrypted = combined.slice(12);

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      encrypted
    );

    return new TextDecoder().decode(decrypted);
  }
}
