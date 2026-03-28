// ============================================
// EMAIL SERVICE - Resend Integration
// ============================================

import { generateId, now } from '../utils/helpers.js';

export class EmailService {
  constructor(env) {
    this.env = env;
    this.apiKey = env.RESEND_API_KEY; // Set in wrangler.toml
    this.fromEmail = env.FROM_EMAIL || 'noreply@xora.social';
  }

  /**
   * Send email via Resend API
   */
  async sendEmail(to, subject, html, text = null) {
    try {
      if (!this.apiKey) {
        console.warn('RESEND_API_KEY not configured - email not sent');
        return { success: false, message: 'Email service not configured' };
      }

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: Array.isArray(to) ? to : [to],
          subject,
          html,
          text: text || this.stripHtml(html)
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(`Resend API error: ${data.message || response.statusText}`);
      }

      return {
        success: true,
        messageId: data.id,
        data
      };
    } catch (error) {
      console.error('Send email error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send verification email
   */
  async sendVerificationEmail(user, code) {
    const subject = 'Verify Your Email - Xora Social';
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
            .code { background: white; border: 2px dashed #667eea; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; margin: 20px 0; border-radius: 5px; }
            .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
            .button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Welcome to Xora Social!</h1>
            </div>
            <div class="content">
              <h2>Hi ${user.name || user.username}!</h2>
              <p>Thanks for signing up! Please verify your email address to get started.</p>
              
              <p>Your verification code is:</p>
              <div class="code">${code}</div>
              
              <p>This code will expire in 15 minutes.</p>
              
              <p>If you didn't create an account on Xora Social, please ignore this email.</p>
            </div>
            <div class="footer">
              <p>&copy; ${new Date().getFullYear()} Xora Social. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    return await this.sendEmail(user.email, subject, html);
  }

  /**
   * Send password reset email
   */
  async sendPasswordResetEmail(user, resetCode) {
    const subject = 'Reset Your Password - Xora Social';
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
            .code { background: white; border: 2px dashed #667eea; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; margin: 20px 0; border-radius: 5px; }
            .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 5px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Password Reset Request</h1>
            </div>
            <div class="content">
              <h2>Hi ${user.name || user.username}!</h2>
              <p>We received a request to reset your password.</p>
              
              <p>Your password reset code is:</p>
              <div class="code">${resetCode}</div>
              
              <p>This code will expire in 1 hour.</p>
              
              <div class="warning">
                <strong>⚠️ Security Notice:</strong> If you didn't request this password reset, please ignore this email and consider changing your password.
              </div>
            </div>
            <div class="footer">
              <p>&copy; ${new Date().getFullYear()} Xora Social. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    return await this.sendEmail(user.email, subject, html);
  }

  /**
   * Send welcome email
   */
  async sendWelcomeEmail(user) {
    const subject = 'Welcome to Xora Social!';
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
            .feature { background: white; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #667eea; }
            .button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🎉 Welcome to Xora Social!</h1>
            </div>
            <div class="content">
              <h2>Hi ${user.name || user.username}!</h2>
              <p>Your account is all set up and ready to go. Here's what you can do:</p>
              
              <div class="feature">
                <strong>📝 Share Your Thoughts</strong><br>
                Create posts with text, images, and videos
              </div>
              
              <div class="feature">
                <strong>📖 Share Stories</strong><br>
                Post 24-hour ephemeral content
              </div>
              
              <div class="feature">
                <strong>🎬 Create Reels</strong><br>
                Share short-form vertical videos
              </div>
              
              <div class="feature">
                <strong>💬 Real-time Chat</strong><br>
                Message friends instantly
              </div>
              
              <div class="feature">
                <strong>🔥 Discover Trending</strong><br>
                Explore what's popular now
              </div>
              
              <p style="text-align: center;">
                <a href="https://xora.social" class="button">Get Started</a>
              </p>
            </div>
            <div class="footer">
              <p>&copy; ${new Date().getFullYear()} Xora Social. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    return await this.sendEmail(user.email, subject, html);
  }

  /**
   * Send notification email digest
   */
  async sendNotificationDigest(user, notifications) {
    const subject = `You have ${notifications.length} new notifications`;
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
            .notification { background: white; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #667eea; }
            .button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🔔 New Notifications</h1>
            </div>
            <div class="content">
              <h2>Hi ${user.name || user.username}!</h2>
              <p>You have ${notifications.length} new notifications:</p>
              
              ${notifications.map(n => `
                <div class="notification">
                  <strong>${n.title}</strong><br>
                  ${n.message}
                </div>
              `).join('')}
              
              <p style="text-align: center;">
                <a href="https://xora.social/notifications" class="button">View All Notifications</a>
              </p>
            </div>
            <div class="footer">
              <p>You're receiving this because you enabled email notifications.</p>
              <p>&copy; ${new Date().getFullYear()} Xora Social. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    return await this.sendEmail(user.email, subject, html);
  }

  /**
   * Process incoming email from Cloudflare Email Routing
   */
  async processIncomingEmail(emailData) {
    try {
      const { from, to, subject, text, html } = emailData;

      // Store incoming email in database
      const emailId = generateId('email');
      const timestamp = now();

      // You can customize this to match your email schema
      await this.env.DB.prepare(`
        INSERT INTO incoming_emails (
          id, from_address, to_address, subject, text_body, html_body,
          received_at, processed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        emailId,
        from,
        to,
        subject,
        text,
        html,
        timestamp,
        timestamp
      ).run();

      return { success: true, emailId };
    } catch (error) {
      console.error('Process incoming email error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Strip HTML tags from string
   */
  stripHtml(html) {
    return html.replace(/<[^>]*>/g, '').trim();
  }

  /**
   * Send test email
   */
  async sendTestEmail(to) {
    const subject = 'Test Email from Xora Social';
    const html = `
      <h1>Test Email</h1>
      <p>This is a test email from Xora Social email service.</p>
      <p>If you received this, email integration is working correctly!</p>
      <p>Timestamp: ${new Date().toISOString()}</p>
    `;

    return await this.sendEmail(to, subject, html);
  }
}
