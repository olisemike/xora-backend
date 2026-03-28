// ============================================
// SMS SERVICE - Twilio Integration
// ============================================

import { generateId, now, generateCode } from '../utils/helpers.js';

export class SMSService {
  constructor(env) {
    this.env = env;
    this.accountSid = env.TWILIO_ACCOUNT_SID; // Set in wrangler.toml
    this.authToken = env.TWILIO_AUTH_TOKEN;   // Set in wrangler.toml
    this.fromNumber = env.TWILIO_PHONE_NUMBER; // Your Twilio phone number
  }

  /**
   * Send SMS via Twilio API
   */
  async sendSMS(to, message) {
    try {
      if (!this.accountSid || !this.authToken || !this.fromNumber) {
        console.warn('Twilio credentials not configured - SMS not sent');
        return { success: false, message: 'SMS service not configured' };
      }

      // Twilio API endpoint
      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;

      // Prepare form data
      const params = new URLSearchParams();
      params.append('To', to);
      params.append('From', this.fromNumber);
      params.append('Body', message);

      // Make request with Basic Auth
      const credentials = btoa(`${this.accountSid}:${this.authToken}`);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(`Twilio API error: ${data.message || response.statusText}`);
      }

      return {
        success: true,
        messageSid: data.sid,
        status: data.status,
        data
      };
    } catch (error) {
      console.error('Send SMS error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send verification code via SMS
   */
  async sendVerificationCode(phoneNumber, code) {
    const message = `Your Xora Social verification code is: ${code}\n\nThis code expires in 15 minutes.\n\nIf you didn't request this, please ignore this message.`;
    
    return await this.sendSMS(phoneNumber, message);
  }

  /**
   * Send 2FA code via SMS
   */
  async send2FACode(phoneNumber, code) {
    const message = `Your Xora Social 2FA code is: ${code}\n\nThis code expires in 5 minutes.\n\nDo not share this code with anyone.`;
    
    return await this.sendSMS(phoneNumber, message);
  }

  /**
   * Send login alert
   */
  async sendLoginAlert(phoneNumber, location, device) {
    const message = `New login to your Xora Social account:\n\nLocation: ${location}\nDevice: ${device}\nTime: ${new Date().toLocaleString()}\n\nIf this wasn't you, secure your account immediately.`;
    
    return await this.sendSMS(phoneNumber, message);
  }

  /**
   * Send password reset code via SMS
   */
  async sendPasswordResetCode(phoneNumber, code) {
    const message = `Your Xora Social password reset code is: ${code}\n\nThis code expires in 1 hour.\n\nIf you didn't request this, please ignore this message.`;
    
    return await this.sendSMS(phoneNumber, message);
  }

  /**
   * Verify phone number (send code and store)
   */
  async initiatePhoneVerification(userId, phoneNumber) {
    try {
      // Generate 6-digit code using crypto-secure helper
      const code = generateCode(6);
      const expiresAt = now() + (15 * 60); // 15 minutes

      // Store verification code in database
      await this.env.DB.prepare(`
        INSERT OR REPLACE INTO phone_verifications (id, user_id, phone_number, code, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        generateId('pv'),
        userId,
        phoneNumber,
        code,
        expiresAt,
        now()
      ).run();

      // Send SMS
      const result = await this.sendVerificationCode(phoneNumber, code);

      return { 
        success: result.success,
        message: result.success ? 'Verification code sent' : 'Failed to send SMS',
        expiresAt 
      };
    } catch (error) {
      console.error('Initiate phone verification error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Verify phone code
   */
  async verifyPhoneCode(userId, code) {
    try {
      const verification = await this.env.DB.prepare(`
        SELECT * FROM phone_verifications 
        WHERE user_id = ? AND code = ? AND expires_at > ?
        ORDER BY created_at DESC
        LIMIT 1
      `).bind(userId, code, now()).first();

      if (!verification) {
        return { success: false, message: 'Invalid or expired code' };
      }

      // Mark phone as verified
      await this.env.DB.prepare(`
        UPDATE users SET phone_verified = 1, phone_number = ? WHERE id = ?
      `).bind(verification.phone_number, userId).run();

      // Delete verification record
      await this.env.DB.prepare(`
        DELETE FROM phone_verifications WHERE id = ?
      `).bind(verification.id).run();

      return { success: true, message: 'Phone number verified' };
    } catch (error) {
      console.error('Verify phone code error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send test SMS
   */
  async sendTestSMS(to) {
    const message = `Test SMS from Xora Social\n\nTimestamp: ${new Date().toISOString()}\n\nIf you received this, SMS integration is working correctly!`;
    
    return await this.sendSMS(to, message);
  }

  /**
   * Get SMS delivery status
   */
  async getSMSStatus(messageSid) {
    try {
      if (!this.accountSid || !this.authToken) {
        return { success: false, message: 'SMS service not configured' };
      }

      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages/${messageSid}.json`;
      const credentials = btoa(`${this.accountSid}:${this.authToken}`);
      
      const response = await fetch(url, {
        headers: {
          'Authorization': `Basic ${credentials}`
        }
      });

      const data = await response.json();

      return { 
        success: true,
        status: data.status,
        errorCode: data.error_code,
        errorMessage: data.error_message,
        data
      };
    } catch (error) {
      console.error('Get SMS status error:', error);
      return { success: false, error: error.message };
    }
  }
}
