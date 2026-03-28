// ============================================
// MEDIA CONTROLLER
// Handles Cloudflare Images and Stream uploads
// ============================================

const buildConfigErrorResponse = (error, details) => new Response(JSON.stringify({
  success: false,
  error,
  details,
}), { status: 500, headers: { 'Content-Type': 'application/json' } });

const parseMaxDurationSeconds = async (request) => {
  try {
    const body = await request.json();
    const raw = body?.maxDurationSeconds;
    if (raw === null || raw === undefined) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export class MediaController {
  constructor(env) {
    this.env = env;
  }

  /**
   * Generate direct upload URL for Cloudflare Images
   */
  async createImageUploadURL(request) {
    try {
      // Authenticate user
      const authResult = await this.authenticateUser(request);
      if (authResult.error) return authResult.error;

      // Check for required environment variables
      if (!this.env.CF_API_TOKEN) {
        console.error('CF_API_TOKEN is not configured');
        return new Response(JSON.stringify({
          success: false,
          error: 'Media upload is not configured. Please contact support.',
          details: 'Missing CF_API_TOKEN'
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }

      if (!this.env.CF_ACCOUNT_ID) {
        console.error('CF_ACCOUNT_ID is not configured');
        return new Response(JSON.stringify({
          success: false,
          error: 'Media upload is not configured. Please contact support.',
          details: 'Missing CF_ACCOUNT_ID'
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }

      const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${this.env.CF_ACCOUNT_ID}/images/v2/direct_upload`;
      console.log(`[Media] Fetching Cloudflare Images upload URL: ${uploadUrl}`);
      console.log(`[Media] Token prefix: ${this.env.CF_API_TOKEN.substring(0, 10)}...`);

      const res = await fetch(
        uploadUrl,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.CF_API_TOKEN}`,
          },
        }
      );

      const data = await res.json();

      if (!data.success) {
        console.error(`[Media] Cloudflare Images API error (${res.status}):`, JSON.stringify(data));
        console.error(`[Media] Response headers:`, Object.fromEntries(res.headers.entries()));
        return new Response(JSON.stringify({
          success: false,
          error: 'Failed to generate upload URL',
          details: data.errors || data.messages || 'Unknown error'
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }

      const deliveryBase = this.env.CLOUDFLARE_IMAGES_DELIVERY_URL
        || (this.env.CLOUDFLARE_IMAGES_HASH
          ? `https://imagedelivery.net/${this.env.CLOUDFLARE_IMAGES_HASH}`
          : null);

      const deliveryUrl = deliveryBase
        ? `${deliveryBase}/${data.result.id}/public`
        : null;

      return Response.json({
        success: true,
        data: {
          uploadURL: data.result.uploadURL,
          id: data.result.id,
          deliveryUrl,
        }
      });
    } catch (error) {
      console.error('Error creating image upload URL:', error.message, error.stack);
      return new Response(JSON.stringify({
        success: false,
        error: 'Internal server error',
        details: error.message
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  /**
   * Generate direct upload URL for Cloudflare Stream
   */
  async createVideoUploadURL(request) {
    try {
      // Authenticate user
      const authResult = await this.authenticateUser(request);
      if (authResult.error) return authResult.error;

      // Check for required environment variables
      if (!this.env.CF_API_TOKEN) {
        console.error('CF_API_TOKEN is not configured');
        return buildConfigErrorResponse(
          'Video upload is not configured. Please contact support.',
          'Missing CF_API_TOKEN'
        );
      }

      if (!this.env.CF_ACCOUNT_ID) {
        console.error('CF_ACCOUNT_ID is not configured');
        return buildConfigErrorResponse(
          'Video upload is not configured. Please contact support.',
          'Missing CF_ACCOUNT_ID'
        );
      }

      const requestedMaxDuration = await parseMaxDurationSeconds(request);

      const maxDurationSeconds = Number.isFinite(requestedMaxDuration)
        ? Math.min(Math.max(requestedMaxDuration, 60), 3600)
        : 3600; // 1 hour default

      // Cloudflare Stream 2026: Use strict JSON body format with expiry
      const requestBody = {
        maxDurationSeconds,
        // Expiry in 15 minutes (recommended by Cloudflare)
        expiry: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      };

      console.log('[Media] Video upload request body:', JSON.stringify(requestBody));

      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${this.env.CF_ACCOUNT_ID}/stream/direct_upload`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.env.CF_API_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(requestBody)
        }
      );

      const data = await res.json();

      console.log('[Media] Video upload response:', JSON.stringify(data));

      if (!data.success) {
        console.error('[Media] Cloudflare Stream API error:', data.errors?.[0]?.message || 'Unknown error');
        return new Response(JSON.stringify({
          success: false,
          error: 'Failed to generate upload URL',
          details: data.errors || data.messages || 'Unknown error'
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }

      if (!data.result?.uploadURL) {
        console.error('[Media] Missing uploadURL in response:', data.result);
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid response from Cloudflare',
          details: 'Missing uploadURL'
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }

      const streamSubdomain = this.env.CLOUDFLARE_STREAM_SUBDOMAIN || null;
      const playbackUrl = streamSubdomain && data.result.uid
        ? `https://${streamSubdomain}/${data.result.uid}/manifest/video.m3u8`
        : null;

      return Response.json({
        success: true,
        data: {
          uploadURL: data.result.uploadURL,
          id: data.result.uid,
          playbackUrl,
          streamSubdomain,
        }
      });
    } catch (error) {
      console.error('[Media] Error creating video upload URL:', error.message, error.stack);
      return new Response(JSON.stringify({
        success: false,
        error: 'Internal server error',
        details: error.message
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  /**
   * Authenticate user using auth middleware
   */
  async authenticateUser(request) {
    const { authMiddleware } = await import('../middleware/auth.js');
    return await authMiddleware(request, this.env);
  }
}