// ============================================
// INTEGRATIONS CONTROLLER
// Email, SMS, Images, Stream endpoints
// ============================================

import { EmailService } from '../services/email.js';
import { SMSService } from '../services/sms.js';
import { CloudflareImagesService } from '../services/cloudflareImages.js';
import { CloudflareStreamService } from '../services/cloudflareStream.js';
import { errorResponse, successResponse, safeParseInt, __DEV__ } from '../utils/helpers.js';

export class IntegrationsController {
  constructor(env) {
    this.email = new EmailService(env);
    this.sms = new SMSService(env);
    this.images = new CloudflareImagesService(env);
    this.stream = new CloudflareStreamService(env);
    this.env = env;
  }

  // ============================================
  // EMAIL ENDPOINTS
  // ============================================

  async sendTestEmail(request, _userId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { email } = body;

      if (!email) {
        return errorResponse('Email address required', 400);
      }

      const result = await this.email.sendTestEmail(email);
      
      return successResponse(result, result.success ? 'Test email sent' : 'Failed to send email');
    } catch (error) {
      if (__DEV__) console.error('Send test email error:', error);
      return errorResponse('Failed to send test email', 500);
    }
  }

  // ============================================
  // SMS ENDPOINTS
  // ============================================

  async sendTestSMS(request, _userId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { phoneNumber } = body;

      if (!phoneNumber) {
        return errorResponse('Phone number required', 400);
      }

      const result = await this.sms.sendTestSMS(phoneNumber);
      
      return successResponse(result, result.success ? 'Test SMS sent' : 'Failed to send SMS');
    } catch (error) {
      if (__DEV__) console.error('Send test SMS error:', error);
      return errorResponse('Failed to send test SMS', 500);
    }
  }

  async initiatePhoneVerification(request, userId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { phoneNumber } = body;

      if (!phoneNumber) {
        return errorResponse('Phone number required', 400);
      }

      const result = await this.sms.initiatePhoneVerification(userId, phoneNumber);
      
      return successResponse(result, result.success ? 'Verification code sent' : 'Failed to send code');
    } catch (error) {
      if (__DEV__) console.error('Initiate phone verification error:', error);
      return errorResponse('Failed to initiate verification', 500);
    }
  }

  async verifyPhone(request, userId) {
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

      const result = await this.sms.verifyPhoneCode(userId, code);
      
      return successResponse(result, result.message);
    } catch (error) {
      if (__DEV__) console.error('Verify phone error:', error);
      return errorResponse('Failed to verify phone', 500);
    }
  }

  // ============================================
  // IMAGE UPLOAD ENDPOINTS
  // ============================================

  async getImageUploadUrl(request, _userId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { expiryMinutes } = body;

      const result = await this.images.getDirectUploadUrl(expiryMinutes || 30);
      
      return successResponse(result, result.success ? 'Upload URL generated' : 'Failed to generate URL');
    } catch (error) {
      if (__DEV__) console.error('Get image upload URL error:', error);
      return errorResponse('Failed to get upload URL', 500);
    }
  }

  async listImages(request, _userId) {
    try {
      const url = new URL(request.url);
      const page = safeParseInt(url.searchParams.get('page'), 1, 1, 1000);
      const perPage = safeParseInt(url.searchParams.get('perPage'), 100, 1, 1000);

      const result = await this.images.listImages(page, perPage);
      
      return successResponse(result);
    } catch (error) {
      if (__DEV__) console.error('List images error:', error);
      return errorResponse('Failed to list images', 500);
    }
  }

  async deleteImage(request, userId, imageId) {
    try {
      const result = await this.images.deleteImage(imageId);
      
      return successResponse(result, result.success ? 'Image deleted' : 'Failed to delete image');
    } catch (error) {
      if (__DEV__) console.error('Delete image error:', error);
      return errorResponse('Failed to delete image', 500);
    }
  }

  // ============================================
  // VIDEO UPLOAD ENDPOINTS
  // ============================================

  async getVideoUploadUrl(request, _userId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { maxDurationSeconds, metadata } = body;

      const result = await this.stream.getDirectUploadUrl(maxDurationSeconds || 3600, metadata || {});
      
      if (!result.success) {
        if (__DEV__) console.error('[Media] Video upload URL generation failed:', result);
        return errorResponse(result.error || 'Failed to generate upload URL', 500);
      }

      // Get Cloudflare Stream subdomain for thumbnail generation on client
      const streamSubdomain = this.env.CLOUDFLARE_STREAM_SUBDOMAIN || null;
      
      // Return in consistent format for mobile app
      return successResponse({
        uploadURL: result.uploadURL,
        id: result.uid,
        playbackUrl: result.playbackUrl,
        streamSubdomain
      }, 'Upload URL generated');
    } catch (error) {
      if (__DEV__) console.error('Get video upload URL error:', error);
      return errorResponse('Failed to get upload URL', 500);
    }
  }

  async getVideoDetails(request, userId, videoId) {
    try {
      const result = await this.stream.getVideoDetails(videoId);
      
      return successResponse(result);
    } catch (error) {
      if (__DEV__) console.error('Get video details error:', error);
      return errorResponse('Failed to get video details', 500);
    }
  }

  async listVideos(request, _userId) {
    try {
      const url = new URL(request.url);
      const options = {
        search: url.searchParams.get('search'),
        limit: url.searchParams.get('limit'),
        status: url.searchParams.get('status')
      };

      const result = await this.stream.listVideos(options);
      
      return successResponse(result);
    } catch (error) {
      if (__DEV__) console.error('List videos error:', error);
      return errorResponse('Failed to list videos', 500);
    }
  }

  async deleteVideo(request, userId, videoId) {
    try {
      const result = await this.stream.deleteVideo(videoId);
      
      return successResponse(result, result.success ? 'Video deleted' : 'Failed to delete video');
    } catch (error) {
      if (__DEV__) console.error('Delete video error:', error);
      return errorResponse('Failed to delete video', 500);
    }
  }

  async createLiveStream(request, _userId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { name } = body;

      const result = await this.stream.createLiveInput(name || 'Live Stream');
      
      return successResponse(result, result.success ? 'Live stream created' : 'Failed to create stream');
    } catch (error) {
      if (__DEV__) console.error('Create live stream error:', error);
      return errorResponse('Failed to create live stream', 500);
    }
  }
}
