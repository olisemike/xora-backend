// ============================================
// CLOUDFLARE IMAGES SERVICE
// Image upload, optimization & delivery
// ============================================


export class CloudflareImagesService {
  constructor(env) {
    this.env = env;
    this.accountId = env.CF_ACCOUNT_ID; // Set in wrangler.toml
    this.apiToken = env.CF_API_TOKEN;   // Set in wrangler.toml
    this.accountHash = env.CLOUDFLARE_IMAGES_HASH; // Your delivery hash
  }

  /**
   * Upload image to Cloudflare Images
   */
  async uploadImage(file, metadata = {}) {
    try {
      if (!this.accountId || !this.apiToken) {
        console.warn('Cloudflare Images not configured');
        return { success: false, message: 'Image service not configured' };
      }

      const formData = new FormData();
      formData.append('file', file);
      
      // Add metadata
      if (metadata.id) formData.append('id', metadata.id);
      if (metadata.requireSignedURLs) formData.append('requireSignedURLs', 'true');
      if (metadata.metadata) formData.append('metadata', JSON.stringify(metadata.metadata));

      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/images/v1`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`
        },
        body: formData
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(`Cloudflare Images API error: ${data.errors?.[0]?.message || 'Upload failed'}`);
      }

      const imageData = data.result;

      return {
        success: true,
        imageId: imageData.id,
        url: `https://imagedelivery.net/${this.accountHash}/${imageData.id}/public`,
        variants: imageData.variants,
        uploaded: imageData.uploaded,
        data: imageData
      };
    } catch (error) {
      console.error('Upload image error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Upload image from URL
   */
  async uploadImageFromUrl(imageUrl, metadata = {}) {
    try {
      if (!this.accountId || !this.apiToken) {
        return { success: false, message: 'Image service not configured' };
      }

      const body = {
        url: imageUrl,
        ...metadata
      };

      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/images/v1`;

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
        throw new Error(`Cloudflare Images API error: ${data.errors?.[0]?.message || 'Upload failed'}`);
      }

      const imageData = data.result;

      return {
        success: true,
        imageId: imageData.id,
        url: `https://imagedelivery.net/${this.accountHash}/${imageData.id}/public`,
        variants: imageData.variants,
        data: imageData
      };
    } catch (error) {
      console.error('Upload image from URL error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get image URL with variant
   */
  getImageUrl(imageId, variant = 'public') {
    if (!this.accountHash) {
      return null;
    }
    return `https://imagedelivery.net/${this.accountHash}/${imageId}/${variant}`;
  }

  /**
   * Get multiple variant URLs
   */
  getImageVariants(imageId) {
    const variants = {
      thumbnail: this.getImageUrl(imageId, 'thumbnail'),    // 200x200
      small: this.getImageUrl(imageId, 'small'),            // 400x400
      medium: this.getImageUrl(imageId, 'medium'),          // 800x800
      large: this.getImageUrl(imageId, 'large'),            // 1200x1200
      public: this.getImageUrl(imageId, 'public'),          // Original
    };

    return variants;
  }

  /**
   * Delete image
   */
  async deleteImage(imageId) {
    try {
      if (!this.accountId || !this.apiToken) {
        return { success: false, message: 'Image service not configured' };
      }

      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/images/v1/${imageId}`;

      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`
        }
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(`Failed to delete image: ${data.errors?.[0]?.message}`);
      }

      return { success: true };
    } catch (error) {
      console.error('Delete image error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get image details
   */
  async getImageDetails(imageId) {
    try {
      if (!this.accountId || !this.apiToken) {
        return { success: false, message: 'Image service not configured' };
      }

      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/images/v1/${imageId}`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`
        }
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(`Failed to get image: ${data.errors?.[0]?.message}`);
      }

      return {
        success: true,
        data: data.result
      };
    } catch (error) {
      console.error('Get image details error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * List all images (paginated)
   */
  async listImages(page = 1, perPage = 100) {
    try {
      if (!this.accountId || !this.apiToken) {
        return { success: false, message: 'Image service not configured' };
      }

      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/images/v1?page=${page}&per_page=${perPage}`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`
        }
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(`Failed to list images: ${data.errors?.[0]?.message}`);
      }

      return {
        success: true,
        images: data.result.images,
        pagination: {
          page: data.result_info.page,
          perPage: data.result_info.per_page,
          totalCount: data.result_info.count,
          totalPages: data.result_info.total_pages
        }
      };
    } catch (error) {
      console.error('List images error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update image metadata
   */
  async updateImage(imageId, metadata) {
    try {
      if (!this.accountId || !this.apiToken) {
        return { success: false, message: 'Image service not configured' };
      }

      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/images/v1/${imageId}`;

      const response = await fetch(url, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ metadata })
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(`Failed to update image: ${data.errors?.[0]?.message}`);
      }

      return {
        success: true,
        data: data.result
      };
    } catch (error) {
      console.error('Update image error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create custom variant
   */
  async createVariant(name, options) {
    try {
      if (!this.accountId || !this.apiToken) {
        return { success: false, message: 'Image service not configured' };
      }

      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/images/v1/variants`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          id: name,
          options
        })
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(`Failed to create variant: ${data.errors?.[0]?.message}`);
      }

      return {
        success: true,
        variant: data.result
      };
    } catch (error) {
      console.error('Create variant error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate direct upload URL
   */
  async getDirectUploadUrl(expiryMinutes = 30) {
    try {
      if (!this.accountId || !this.apiToken) {
        return { success: false, message: 'Image service not configured' };
      }

      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/images/v2/direct_upload`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          expiry: new Date(Date.now() + expiryMinutes * 60000).toISOString()
        })
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(`Failed to get upload URL: ${data.errors?.[0]?.message}`);
      }

      return {
        success: true,
        uploadURL: data.result.uploadURL,
        id: data.result.id
      };
    } catch (error) {
      console.error('Get direct upload URL error:', error);
      return { success: false, error: error.message };
    }
  }
}
