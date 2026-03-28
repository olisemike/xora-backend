// ============================================
// CLOUDFLARE STREAM SERVICE
// Video upload, encoding & streaming
// ============================================

import { __DEV__ } from '../utils/helpers.js';

export class CloudflareStreamService {
  constructor(env) {
    this.env = env;
    this.accountId = env.CF_ACCOUNT_ID;
    this.apiToken = env.CF_API_TOKEN;
    this.customerSubdomain = env.CLOUDFLARE_STREAM_SUBDOMAIN; // e.g., 'customer-xyz123'
  }

  /**
   * Upload video to Cloudflare Stream
   */
  async uploadVideo(file, metadata = {}) {
    try {
      if (!this.accountId || !this.apiToken) {
        if (__DEV__) console.warn('Cloudflare Stream not configured');
        return { success: false, message: 'Video service not configured' };
      }

      const formData = new FormData();
      formData.append('file', file);
      
      // Add metadata
      if (metadata.name) formData.append('meta[name]', metadata.name);
      if (metadata.requireSignedURLs) formData.append('requireSignedURLs', 'true');
      if (metadata.allowedOrigins) formData.append('allowedOrigins', metadata.allowedOrigins.join(','));
      if (metadata.thumbnailTimestampPct) formData.append('thumbnailTimestampPct', metadata.thumbnailTimestampPct);
      if (metadata.watermark) formData.append('watermark', metadata.watermark);

      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/stream`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`
        },
        body: formData
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(`Cloudflare Stream API error: ${data.errors?.[0]?.message || 'Upload failed'}`);
      }

      const videoData = data.result;

      return {
        success: true,
        videoId: videoData.uid,
        playbackUrl: `https://${this.customerSubdomain}.cloudflarestream.com/${videoData.uid}/manifest/video.m3u8`,
        thumbnailUrl: `https://${this.customerSubdomain}.cloudflarestream.com/${videoData.uid}/thumbnails/thumbnail.jpg`,
        embedUrl: `https://${this.customerSubdomain}.cloudflarestream.com/${videoData.uid}/iframe`,
        duration: videoData.duration,
        status: videoData.status,
        data: videoData
      };
    } catch (error) {
      if (__DEV__) console.error('Upload video error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Upload video from URL
   */
  async uploadVideoFromUrl(videoUrl, metadata = {}) {
    try {
      if (!this.accountId || !this.apiToken) {
        return { success: false, message: 'Video service not configured' };
      }

      const body = {
        url: videoUrl,
        ...metadata
      };

      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/stream/copy`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(`Cloudflare Stream API error: ${data.errors?.[0]?.message || 'Upload failed'}`);
      }

      const videoData = data.result;

      return {
        success: true,
        videoId: videoData.uid,
        playbackUrl: `https://${this.customerSubdomain}.cloudflarestream.com/${videoData.uid}/manifest/video.m3u8`,
        thumbnailUrl: `https://${this.customerSubdomain}.cloudflarestream.com/${videoData.uid}/thumbnails/thumbnail.jpg`,
        data: videoData
      };
    } catch (error) {
      if (__DEV__) console.error('Upload video from URL error:', error);
      return { success: false, error: error.message };
    }
  }
  /**
   * Get video playback URLs
   */
  getVideoUrls(videoId) {
    if (!this.customerSubdomain) {
      return null;
    }

    return {
      hls: `https://${this.customerSubdomain}.cloudflarestream.com/${videoId}/manifest/video.m3u8`,
      dash: `https://${this.customerSubdomain}.cloudflarestream.com/${videoId}/manifest/video.mpd`,
      thumbnail: `https://${this.customerSubdomain}.cloudflarestream.com/${videoId}/thumbnails/thumbnail.jpg`,
      thumbnailGif: `https://${this.customerSubdomain}.cloudflarestream.com/${videoId}/thumbnails/thumbnail.gif`,
      embed: `https://${this.customerSubdomain}.cloudflarestream.com/${videoId}/iframe`,
      preview: `https://${this.customerSubdomain}.cloudflarestream.com/${videoId}/watch`
    };
  }
  /**
   * Get video details
   */
  async getVideoDetails(videoId) {
    try {
      if (!this.accountId || !this.apiToken) {
        return { success: false, message: 'Video service not configured' };
      }

      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/stream/${videoId}`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`
        }
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(`Failed to get video: ${data.errors?.[0]?.message}`);
      }

      return {
        success: true,
        data: data.result
      };
    } catch (error) {
      if (__DEV__) console.error('Get video details error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete video
   */
  async deleteVideo(videoId) {
    try {
      if (!this.accountId || !this.apiToken) {
        return { success: false, message: 'Video service not configured' };
      }

      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/stream/${videoId}`;

      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`
        }
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(`Failed to delete video: ${data.errors?.[0]?.message}`);
      }

      return { success: true };
    } catch (error) {
      if (__DEV__) console.error('Delete video error:', error);
      return { success: false, error: error.message };
    }
  }
  /**
   * List videos (paginated)
   */
  async listVideos(options = {}) {
    try {
      if (!this.accountId || !this.apiToken) {
        return { success: false, message: 'Video service not configured' };
      }

      const params = new URLSearchParams();
      if (options.search) params.append('search', options.search);
      if (options.limit) params.append('limit', options.limit);
      if (options.before) params.append('before', options.before);
      if (options.after) params.append('after', options.after);
      if (options.status) params.append('status', options.status);

      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/stream?${params.toString()}`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`
        }
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(`Failed to list videos: ${data.errors?.[0]?.message}`);
      }

      return {
        success: true,
        videos: data.result,
        total: data.result_info?.total || 0
      };
    } catch (error) {
      if (__DEV__) console.error('List videos error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate direct upload URL (TUS protocol)
   * Note: maxDurationSeconds is a Cloudflare Stream parameter for TUS protocol
   */
  async getDirectUploadUrl(maxDurationSeconds = 3600, metadata = {}) {
    try {
      if (!this.accountId || !this.apiToken) {
        return { success: false, message: 'Video service not configured' };
      }

      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/stream/direct_upload`;

      // Cloudflare Stream 2026: Use strict minimal body format
      // Only include: maxDurationSeconds, expiry
      const requestBody = {
        maxDurationSeconds: maxDurationSeconds || 3600,
        // Expiry in 15 minutes (recommended by Cloudflare)
        expiry: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      };

      // Add optional metadata fields if provided (these are strictly validated by Cloudflare)
      if (metadata?.requireSignedURLs) {
        requestBody.requireSignedURLs = metadata.requireSignedURLs;
      }
      if (metadata?.allowedOrigins && Array.isArray(metadata.allowedOrigins)) {
        requestBody.allowedOrigins = metadata.allowedOrigins;
      }
      if (metadata?.watermark) {
        requestBody.watermark = metadata.watermark;
      }
      if (metadata?.thumbnail) {
        requestBody.thumbnail = metadata.thumbnail;
      }

      if (__DEV__) console.log('[Stream] Direct upload request:', JSON.stringify(requestBody));

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      const data = await response.json();

      if (__DEV__) console.log('[Stream] Direct upload response:', JSON.stringify(data));

      if (!data.success) {
        if (__DEV__) console.error('[Stream] Cloudflare Stream API error:', data.errors?.[0]?.message || 'Unknown error');
        throw new Error(`Failed to get upload URL: ${data.errors?.[0]?.message || 'Unknown error'}`);
      }

      if (!data.result?.uploadURL) {
        if (__DEV__) console.error('[Stream] Missing uploadURL in response:', data.result);
        throw new Error('Invalid response: missing uploadURL');
      }

      return {
        success: true,
        uploadURL: data.result.uploadURL,
        uid: data.result.uid,
        playbackUrl: `https://${this.customerSubdomain}.cloudflarestream.com/${data.result.uid}/manifest/video.m3u8`
      };
    } catch (error) {
      if (__DEV__) console.error('[Stream] Get direct upload URL error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create live stream input
   */
  async createLiveInput(name = 'Live Stream') {
    try {
      if (!this.accountId || !this.apiToken) {
        return { success: false, message: 'Video service not configured' };
      }

      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/stream/live_inputs`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          meta: { name }
        })
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(`Failed to create live input: ${data.errors?.[0]?.message}`);
      }

      const liveInput = data.result;

      return {
        success: true,
        uid: liveInput.uid,
        rtmps: {
          url: liveInput.rtmps.url,
          streamKey: liveInput.rtmps.streamKey
        },
        playbackUrl: `https://${this.customerSubdomain}.cloudflarestream.com/${liveInput.uid}/manifest/video.m3u8`,
        data: liveInput
      };
    } catch (error) {
      if (__DEV__) console.error('Create live input error:', error);
      return { success: false, error: error.message };
    }
  }
  /**
   * Get video analytics
   */
  async getVideoAnalytics(videoId) {
    try {
      if (!this.accountId || !this.apiToken) {
        return { success: false, message: 'Video service not configured' };
      }

      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/stream/analytics/views?videoUID=${videoId}`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`
        }
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(`Failed to get analytics: ${data.errors?.[0]?.message}`);
      }

      return {
        success: true,
        analytics: data.result
      };
    } catch (error) {
      if (__DEV__) console.error('Get video analytics error:', error);
      return { success: false, error: error.message };
    }
  }
  /**
   * Create signed URL token for private videos
   */
  async createSignedToken(videoId, expiresIn = 3600, downloadable = false) {
    try {
      if (!this.accountId || !this.apiToken) {
        return { success: false, message: 'Video service not configured' };
      }

      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/stream/${videoId}/token`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          id: videoId,
          exp: Math.floor(Date.now() / 1000) + expiresIn,
          nbf: Math.floor(Date.now() / 1000),
          downloadable
        })
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(`Failed to create token: ${data.errors?.[0]?.message}`);
      }

      return {
        success: true,
        token: data.result.token,
        signedUrl: `https://${this.customerSubdomain}.cloudflarestream.com/${videoId}/manifest/video.m3u8?token=${data.result.token}`
      };
    } catch (error) {
      if (__DEV__) console.error('Create signed token error:', error);
      return { success: false, error: error.message };
    }
  }
}
