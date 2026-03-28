// Social Media Import Controller - CURATOR/TRENDING MODEL (Admin Only)
// Admins curate trending content, NOT import from their personal feeds
// FIXED: Uses singleton pattern to initialize service once at startup
import { SocialMediaImportService } from '../services/socialMediaImport.js';
import { errorResponse, successResponse, safeParseInt } from '../utils/helpers.js';

// Singleton instance - initialized once at app startup
let socialMediaImportService = null;

/**
 * Initialize the social media import service (call this ONCE at app startup)
 */
export function initializeSocialMediaImportService(db, env) {
  if (!socialMediaImportService) {
    socialMediaImportService = new SocialMediaImportService(db, env);
  }
  return socialMediaImportService;
}

/**
 * Get the initialized service (throws if not initialized)
 */
export function getSocialMediaImportService() {
  if (!socialMediaImportService) {
    throw new Error('SocialMediaImportService not initialized. Call initializeSocialMediaImportService at startup.');
  }
  return socialMediaImportService;
}

export class SocialMediaImportController {
  constructor(env) {
    // Ensure service is initialized
    if (!socialMediaImportService) {
      socialMediaImportService = new SocialMediaImportService(env.DB, env);
    }
    this.importService = socialMediaImportService;
    this.env = env;
  }

  /**
   * Search TRENDING content by location/hashtag (Multi-platform)
   * POST /admin/social-media/search/trending
   *
   * Body: {
   *   platform: "twitter" | "instagram" | "tiktok" | "facebook" | "youtube",
   *   query: "#bitcoin" or "AI news",
   *   location: "US" | "UK" | "global" | etc,
   *   limit: 100,
   *   language: "en",
   *   minEngagement: 50
   * }
   */
  async searchTrending(request, adminInfo) {
    try {
      if (!adminInfo.hasPermission('import_social_media') && !adminInfo.hasPermission('all')) {
        return errorResponse('You do not have permission to search social media', 403);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }

      const { platform = 'twitter', query, location, limit, language, minEngagement } = body;

      // Use platform-specific defaults for minEngagement
      // YouTube videos might not have public like counts, so use lower threshold
      const engagementThreshold = minEngagement !== undefined 
        ? minEngagement 
        : (platform === 'youtube' ? 0 : 50);

      // Use singleton service, not instance method
      const result = await this.importService.searchTrendingTweets(adminInfo.adminId, {
        platform: platform || 'twitter',
        query,
        location: location || 'global',
        limit: limit || 100,
        language,
        minEngagement: engagementThreshold
      });

      if (!result.success) {
        return errorResponse(result.error, 500);
      }

      return successResponse({
        jobId: result.jobId,
        tweets: result.tweets,
        total: result.total,
        platform: result.platform,
        location: location || 'global',
        query
      }, `Found ${result.total} trending posts`);
    } catch (error) {
      console.error('Search trending error:', error);
      return errorResponse('Failed to search trending content', 500);
    }
  }

  /**
   * Get posts from ANY public user (Multi-platform)
   * POST /admin/social-media/search/user/:username
   *
   * Body: {
   *   platform: "twitter" | "instagram" | "tiktok" | "facebook" | "youtube",
   *   limit: 100,
   *   startDate: timestamp,
   *   endDate: timestamp
   * }
   */
  async searchPublicUser(request, adminInfo, username) {
    try {
      if (!adminInfo.hasPermission('import_social_media') && !adminInfo.hasPermission('all')) {
        return errorResponse('You do not have permission to search users', 403);
      }

      if (!username) {
        return errorResponse('Username is required', 400);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        body = {};
      }

      const { platform, limit, startDate, endDate } = body;

      const result = await this.importService.importPublicUserContent(
        adminInfo.adminId,
        username,
        {
          platform: platform || 'twitter',
          limit: limit || 100,
          startDate,
          endDate
        }
      );

      if (!result.success) {
        return errorResponse(result.error, 500);
      }

      return successResponse({
        jobId: result.jobId,
        platform: result.platform,
        username: result.username,
        posts: result.posts,
        total: result.total
      }, `Found ${result.total} posts from @${username}`);
    } catch (error) {
      console.error('Search public user error:', error);
      return errorResponse('Failed to fetch user posts', 500);
    }
  }

  /**
   * Import SELECTED posts to Xora database
   * After admin curates from search results
   * POST /admin/social-media/import/selected
   *
   * Body: {
   *   platform: "twitter" | "instagram" | "tiktok" | "facebook" | "youtube" | "reddit",
   *   posts: [{
   *     externalId: "post_id",
   *     text: "content",
   *     url: "https://...",
   *     author: "username",
   *     media: [{url: "...", type: "..."}],
   *     createdAt: timestamp,
   *     nsfw: false
   *   }]
   * }
   */
  async importSelected(request, adminInfo) {
    try {
      if (!adminInfo.hasPermission('import_social_media') && !adminInfo.hasPermission('all')) {
        return errorResponse('You do not have permission to import posts', 403);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }

      const { platform, posts } = body;

      if (!platform || !posts || !Array.isArray(posts) || posts.length === 0) {
        return errorResponse('Platform and posts array required', 400);
      }

      const validPlatforms = ['twitter', 'instagram', 'tiktok', 'facebook', 'youtube', 'reddit'];
      if (!validPlatforms.includes(platform)) {
        return errorResponse(`Invalid platform. Must be one of: ${validPlatforms.join(', ')}`, 400);
      }

      const result = await this.importService.importSelectedPosts(
        adminInfo.adminId,
        posts,
        platform
      );

      if (!result.success) {
        return errorResponse(result.error, 500);
      }

      return successResponse({
        jobId: result.jobId,
        platform: result.platform,
        total: result.total,
        imported: result.imported,
        failed: result.failed,
        skipped: result.skipped || 0
      }, `Imported ${result.imported}/${result.total} posts successfully (${result.skipped || 0} duplicates skipped)`);
    } catch (error) {
      console.error('Import selected error:', error);
      return errorResponse('Failed to import selected posts', 500);
    }
  }

  /**
   * Get TRENDING hashtags by location
   * GET /admin/social-media/trending/hashtags?location=US&limit=50
   */
  async getTrendingHashtags(request, adminInfo) {
    try {
      if (!adminInfo.hasPermission('import_social_media') && !adminInfo.hasPermission('all')) {
        return errorResponse('You do not have permission to view trending hashtags', 403);
      }

      const url = new URL(request.url);
      const location = url.searchParams.get('location') || 'global';
      const limit = safeParseInt(url.searchParams.get('limit'), 50, 1, 100);
      const offset = safeParseInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

      const result = await this.importService.getTrendingHashtags(location, limit, offset);

      if (!result.success) {
        return errorResponse(result.error, 500);
      }

      return successResponse({
        location: result.location,
        hashtags: result.hashtags,
        total: result.total,
        limit,
        offset
      });
    } catch (error) {
      console.error('Get trending hashtags error:', error);
      return errorResponse('Failed to fetch trending hashtags', 500);
    }
  }

  /**
   * Get supported platforms and their capabilities
   * GET /admin/social-media/platforms
   */
  getSupportedPlatforms(_request, adminInfo) {
    try {
      if (!adminInfo.hasPermission('import_social_media') && !adminInfo.hasPermission('all')) {
        return errorResponse('You do not have permission to view platforms', 403);
      }

      const platforms = this.importService.getSupportedPlatforms();

      return successResponse({
        platforms,
        total: platforms.length
      });
    } catch (error) {
      console.error('Get platforms error:', error);
      return errorResponse('Failed to get platforms', 500);
    }
  }

  /**
   * Get supported geographic locations
   * GET /admin/social-media/locations
   */
  getSupportedLocations(_request, adminInfo) {
    try {
      if (!adminInfo.hasPermission('import_social_media') && !adminInfo.hasPermission('all')) {
        return errorResponse('You do not have permission to view locations', 403);
      }

      const locations = this.importService.getSupportedLocations();

      return successResponse({
        locations,
        total: locations.length
      });
    } catch (error) {
      console.error('Get locations error:', error);
      return errorResponse('Failed to get locations', 500);
    }
  }

  /**
   * Get import/search history
   * GET /admin/social-media/jobs?limit=50&offset=0
   */
  async getJobs(request, adminInfo) {
    try {
      if (!adminInfo.hasPermission('import_social_media') && !adminInfo.hasPermission('all')) {
        return errorResponse('You do not have permission to view job history', 403);
      }

      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 50, 1, 100);
      const offset = safeParseInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

      // Calculate beforeCreatedAt for pagination
      const beforeCreatedAt = offset > 0 ? Date.now() - offset * 1000 : null;

      const result = await this.importService.getImportJobs(adminInfo.adminId, limit, beforeCreatedAt);

      if (!result.success) {
        return errorResponse(result.error, 500);
      }

      return successResponse({
        jobs: result.jobs,
        total: result.jobs.length,
        limit,
        offset
      });
    } catch (error) {
      console.error('Get jobs error:', error);
      return errorResponse('Failed to get job history', 500);
    }
  }
}