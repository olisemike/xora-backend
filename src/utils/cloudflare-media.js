/**
 * Cloudflare Media Cleanup Utility
 * Handles deletion of media files from Cloudflare
 */

export class CloudflareMediaCleaner {
  constructor(env) {
    this.env = env;
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}`;
  }

  /**
   * Parse JSON safely (for image IDs stored as JSON arrays)
   */
  safeParseJson(str) {
    if (!str) return [];
    try {
      return Array.isArray(str) ? str : JSON.parse(str);
    } catch {
      return [];
    }
  }

  /**
   * Delete an image from Cloudflare by ID
   */
  async deleteImage(imageId) {
    if (!imageId || !this.env.CF_API_TOKEN) {
      return { success: false, reason: 'Missing imageId or CF_API_TOKEN' };
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/images/v1/${imageId}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${this.env.CF_API_TOKEN}`,
          },
        }
      );

      if (!response.ok) {
        const data = await response.json();
        // eslint-disable-next-line no-console
        console.warn(`[Cloudflare] Failed to delete image ${imageId}:`, data);
        return { success: false, reason: data.errors?.[0]?.message || 'Unknown error' };
      }

      // eslint-disable-next-line no-console
      console.log(`[Cloudflare] Successfully deleted image: ${imageId}`);
      return { success: true };
    } catch (error) {
      console.error(`[Cloudflare] Error deleting image ${imageId}:`, error);
      return { success: false, reason: error.message };
    }
  }

  /**
   * Delete multiple images
   */
  async deleteImages(imageIds) {
    const validIds = this.safeParseJson(imageIds).filter(id => id && typeof id === 'string');
    
    const results = await Promise.allSettled(
      validIds.map(id => this.deleteImage(id))
    );

    const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    // eslint-disable-next-line no-console
    console.log(`[Cloudflare] Deleted ${successful}/${validIds.length} images`);
    
    return results;
  }

  /**
   * Delete a video from Cloudflare Stream by ID
   */
  async deleteVideo(videoId) {
    if (!videoId || !this.env.CF_API_TOKEN) {
      return { success: false, reason: 'Missing videoId or CF_API_TOKEN' };
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/stream/${videoId}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${this.env.CF_API_TOKEN}`,
          },
        }
      );

      if (!response.ok) {
        const data = await response.json();
        // eslint-disable-next-line no-console
        console.warn(`[Cloudflare Stream] Failed to delete video ${videoId}:`, data);
        return { success: false, reason: data.errors?.[0]?.message || 'Unknown error' };
      }

      // eslint-disable-next-line no-console
      console.log(`[Cloudflare Stream] Successfully deleted video: ${videoId}`);
      return { success: true };
    } catch (error) {
      console.error(`[Cloudflare Stream] Error deleting video ${videoId}:`, error);
      return { success: false, reason: error.message };
    }
  }

  /**
   * Delete multiple videos
   */
  async deleteVideos(videoIds) {
    const validIds = this.safeParseJson(videoIds).filter(id => id && typeof id === 'string');
    
    const results = await Promise.allSettled(
      validIds.map(id => this.deleteVideo(id))
    );

    const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    // eslint-disable-next-line no-console
    console.log(`[Cloudflare Stream] Deleted ${successful}/${validIds.length} videos`);
    
    return results;
  }

  /**
   * Extract image ID from different URL formats
   * Supports: https://imagedelivery.net/{hash}/{id}/public
   */
  static extractImageIdFromUrl(url) {
    if (!url) return null;
    
    try {
      const urlObj = new URL(url);
      // Handle imagedelivery.net URLs: /hash/id/public
      const parts = urlObj.pathname.split('/').filter(p => p);
      if (parts.length >= 2 && urlObj.hostname.includes('imagedelivery.net')) {
        return parts[1]; // Second part is the ID
      }
    } catch {
      // Invalid URL
    }
    
    return null;
  }
}

export default CloudflareMediaCleaner;
