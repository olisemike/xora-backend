// ============================================
// NOTIFICATION SERVICE
// Handles in-app and email notifications
// ============================================

import { EmailService } from './email.js';

/**
 * Create in-app notification
 * Schema: id, user_id, type, actor_type, actor_id, target_type, target_id, content, read, created_at
 */
export async function createNotification(db, userId, type, content, actorType = null, actorId = null, targetType = null, targetId = null) {
  const id = crypto.randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);

  await db
    .prepare(`
      INSERT INTO notifications (id, user_id, type, actor_type, actor_id, target_type, target_id, content, created_at, read)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(id, userId, type, actorType, actorId, targetType, targetId, content, timestamp, 0)
    .run();

  return id;
}

/**
 * Send login notification (in-app + email)
 */
export async function sendLoginNotification(db, env, user, deviceInfo, ipAddress) {
  try {
    // Extract device details
    const platform = deviceInfo?.platform || 'unknown';
    const deviceName = deviceInfo?.deviceName || deviceInfo?.browser || 'Unknown device';
    const location = ipAddress || 'Unknown location';
    const timestamp = new Date().toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short'
    });

    // Create in-app notification
    const content = `New login from ${platform} device (${deviceName}) at ${timestamp}`;
    await createNotification(
      db,
      user.id,
      'new_login',
      content,
      null, // actor_type
      null, // actor_id
      'device', // target_type
      deviceName // target_id
    );

    // Send email notification via Resend (if configured)
    if (user.email) {
      try {
        await sendLoginEmail(env, user, {
          platform,
          deviceName,
          location,
          timestamp
        });
      } catch (emailError) {
        // Log but do not fail the overall login notification
        console.error('Failed to send login email notification:', emailError);
      }
    }
  } catch (error) {
    console.error('Failed to send login notification:', error);
    // Don't throw - notifications are best-effort
  }
}

/**
 * Send device verification email (via Resend)
 */
export async function sendDeviceVerificationEmail(env, user, verificationCode, deviceInfo) {
  if (!user.email) {
    console.warn('No user email on record, skipping device verification email');
    return;
  }

  const platform = deviceInfo?.platform || 'unknown';
  const deviceName = deviceInfo?.deviceName || deviceInfo?.browser || 'Unknown device';

  const emailBody = `
    <h2>New Device Login - Verification Required</h2>
    <p>Hi ${user.name || user.username},</p>
    <p>We detected a login from a new ${platform} device (${deviceName}).</p>
    <p><strong>Verification Code: ${verificationCode}</strong></p>
    <p>This code will expire in 15 minutes.</p>
    <p>If you did not attempt to log in, please secure your account immediately by changing your password.</p>
    <p>Thanks,<br>The Xora Team</p>
  `;

  // Log verification code sent (without exposing the actual code)
  // Device verification code sent header
  // User ID for notification
  // Verification code length
  // Expires in 15 minutes
  // Device verification code sent footer

  try {
    const emailService = new EmailService(env);
    const result = await emailService.sendEmail(
      user.email,
      `Xora - New Device Verification Code: ${verificationCode}`,
      emailBody
    );

    if (!result.success) {
      throw new Error(result.error || 'Failed to send device verification email');
    }
  } catch (error) {
    console.error('Failed to send verification email:', error);
    // Continue anyway - code is logged above for development
    console.warn('⚠️  Email failed but verification code is logged above');
  }
}

/**
 * Send login email notification via Resend
 */
async function sendLoginEmail(env, user, loginDetails) {
  const { platform, deviceName, location, timestamp } = loginDetails;

  const emailBody = `
    <h2>New Login Detected</h2>
    <p>Hi ${user.name || user.username},</p>
    <p>We detected a new login to your Xora account:</p>
    <ul>
      <li><strong>Platform:</strong> ${platform}</li>
      <li><strong>Device:</strong> ${deviceName}</li>
      <li><strong>Time:</strong> ${timestamp}</li>
      <li><strong>Location:</strong> ${location}</li>
    </ul>
    <p>If this wasn't you, please secure your account immediately by:</p>
    <ol>
      <li>Changing your password</li>
      <li>Logging out all devices from Settings</li>
      <li>Reviewing your recent activity</li>
    </ol>
    <p>Thanks,<br>The Xora Team</p>
  `;

  try {
    const emailService = new EmailService(env);
    const result = await emailService.sendEmail(
      user.email,
      'Xora - New Login to Your Account',
      emailBody
    );

    if (!result.success) {
      throw new Error(result.error || 'Failed to send login email');
    }
  } catch (error) {
    console.error('Failed to send login email:', error);
    // Don't throw - this is best-effort
  }
}
