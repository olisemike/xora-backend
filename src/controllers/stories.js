// ============================================
// STORIES CONTROLLER
// 24-hour ephemeral content
// ============================================

import { DatabaseService } from '../services/database.js';
import { DbRouter } from '../services/dbRouter.js';
import { AdService } from '../services/adService.js';
import { SensitiveContentHandler } from '../services/sensitiveContent.js';
import {
  generateId,
  errorResponse,
  successResponse,
  now,
  hoursFromNow,
  safeParseInt,
  parseCursor,
  createCursor,
  __DEV__
} from '../utils/helpers.js';

export class StoriesController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
    this.dbRouter = this.db.router || DbRouter.fromEnv(env);
    const primaryDb = this.dbRouter.getPrimaryDb();
    this.adService = new AdService(primaryDb, env.CACHE);
    this.sensitiveHandler = new SensitiveContentHandler(primaryDb, env.CACHE);
  }

  /**
   * POST /stories
   * Create new story
   */
  async create(request, userId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { actorType, actorId, mediaType, mediaUrl, duration, isSensitive } = body;

      // Verify actor ownership
      if (actorType === 'user' && actorId !== userId) {
        return errorResponse('Cannot create story as this user', 403);
      }

      if (actorType === 'page') {
        const isOwner = await this.db.isPageOwner(actorId, userId);
        if (!isOwner) {
          return errorResponse('You do not own this page', 403);
        }
      }

      if (!mediaUrl) {
        return errorResponse('Media URL required', 400);
      }

      if (!['image', 'video'].includes(mediaType)) {
        return errorResponse('Media type must be image or video', 400);
      }

      // Create story
      const storyId = generateId('story');
      const timestamp = now();
      const expiresAt = hoursFromNow(24); // 24-hour expiry

      await this.env.DB.prepare(`
        INSERT INTO stories (
          id, actor_type, actor_id, media_type, media_url,
          duration, is_sensitive, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        storyId,
        actorType,
        actorId,
        mediaType,
        mediaUrl,
        duration || (mediaType === 'image' ? 5 : 15), // Default durations
        isSensitive ? 1 : 0,
        expiresAt,
        timestamp,
        timestamp
      ).run();

      const story = await this.env.DB.prepare(`
        SELECT * FROM stories WHERE id = ?
      `).bind(storyId).first();

      return successResponse(story, 'Story created successfully');
    } catch (error) {
      if (__DEV__) console.error('Create story error:', error);
      return errorResponse('Failed to create story', 500);
    }
  }

  /**
   * Clean up expired stories (internal task)
   */
  async cleanupExpiredStories() {
    try {
      const currentTime = now(); // Unix timestamp in seconds (matching how stories are stored)

      // Get expired stories for cleanup
      // Note: cloudflare_video_id column may not exist in older databases
      let expiredStories;
      try {
        expiredStories = await this.env.DB.prepare(`
          SELECT id, media_type, media_url, cloudflare_video_id FROM stories
          WHERE expires_at <= ? AND expires_at IS NOT NULL
          LIMIT 100
        `).bind(currentTime).all();
      } catch (columnErr) {
        // Fallback: cloudflare_video_id column doesn't exist yet
        if (__DEV__) console.warn('cloudflare_video_id column not found, using fallback query:', columnErr.message);
        expiredStories = await this.env.DB.prepare(`
          SELECT id, media_type, media_url FROM stories
          WHERE expires_at <= ? AND expires_at IS NOT NULL
          LIMIT 100
        `).bind(currentTime).all();
      }

      if (!expiredStories.results?.length) {
        return { success: true, deleted: 0 };
      }

      // Clean up video media if present
      try {
        const { CloudflareMediaCleaner } = await import('../utils/cloudflare-media.js');
        const cleaner = new CloudflareMediaCleaner(this.env);

        for (const story of expiredStories.results || []) {
          if (story.media_type === 'video' && story.media_url) {
            const videoId = story.cloudflare_video_id || story.media_url.split('/').pop();
            if (videoId) {
              await cleaner.deleteVideo(videoId);
            }
          }
        }
      } catch (cleanupErr) {
        if (__DEV__) console.warn('Video cleanup during story expiration failed:', cleanupErr);
      }

      // Delete expired stories
      await this.env.DB.prepare(`
        DELETE FROM stories WHERE expires_at <= ? AND expires_at IS NOT NULL
      `).bind(currentTime).run();

      return { success: true, deleted: expiredStories.results?.length || 0 };
    } catch (error) {
      if (__DEV__) console.error('Story cleanup error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * GET /stories/feed
   * Get stories from followed accounts
   */
  async getFeed(request, userId) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');

      const currentTime = now();

      // Get stories from followed accounts + user's own stories (not expired)
      let query = `
        SELECT DISTINCT s.*,
          CASE 
            WHEN s.actor_type = 'user' THEN u.username
            ELSE NULL
          END as username,
          CASE 
            WHEN s.actor_type = 'user' THEN u.name
            WHEN s.actor_type = 'page' THEN p.name
          END as actor_name,
          CASE 
            WHEN s.actor_type = 'user' THEN u.avatar_url
            WHEN s.actor_type = 'page' THEN p.avatar_url
          END as avatar_url,
          CASE 
            WHEN s.actor_type = 'user' THEN u.verified
            WHEN s.actor_type = 'page' THEN p.verified
          END as verified,
          (SELECT COUNT(*) FROM story_views WHERE story_id = s.id) as view_count,
          (SELECT COUNT(*) FROM story_views WHERE story_id = s.id AND viewer_type = 'user' AND viewer_id = ?) as viewed_by_me
        FROM stories s
        LEFT JOIN follows f ON (
          s.actor_type = f.followee_type AND s.actor_id = f.followee_id 
          AND f.follower_type = 'user' AND f.follower_id = ?
        )
        LEFT JOIN users u ON s.actor_type = 'user' AND s.actor_id = u.id
        LEFT JOIN pages p ON s.actor_type = 'page' AND s.actor_id = p.id
        WHERE s.expires_at > ?
          AND (
            (f.id IS NOT NULL)
            OR (s.actor_type = 'user' AND s.actor_id = ?)
          )
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
            WHERE (b.blocker_type = 'user' AND b.blocker_id = ? AND b.blocked_type = s.actor_type AND b.blocked_id = s.actor_id)
               OR (b.blocker_type = s.actor_type AND b.blocker_id = s.actor_id AND b.blocked_type = 'user' AND b.blocked_id = ?)
          )
      `;

      const params = [userId, userId, currentTime, userId, userId, userId];

      if (cursor) {
        const cursorData = parseCursor(cursor);
        if (cursorData?.created_at) {
          query += ` AND s.created_at < ?`;
          params.push(cursorData.created_at);
        }
      }

      query += ` ORDER BY s.created_at DESC LIMIT ?`;
      params.push(limit + 1);

      const result = await this.env.DB.prepare(query).bind(...params).all();

      const rawStories = result.results || [];
      const hasMore = rawStories.length > limit;
      if (hasMore) rawStories.pop();

      let stories = rawStories;

      const canViewSensitive = userId
        ? await this.sensitiveHandler.canViewSensitive(userId)
        : false;

      if (!canViewSensitive) {
        stories = stories.filter((story) => !story.is_sensitive);
      }

      // Group stories by actor
      const groupedStories = {};
      for (const story of stories) {
        const actorKey = `${story.actor_type}_${story.actor_id}`;
        if (!groupedStories[actorKey]) {
          groupedStories[actorKey] = {
            actorType: story.actor_type,
            actorId: story.actor_id,
            username: story.username,
            actorName: story.actor_name,
            avatarUrl: story.avatar_url,
            verified: story.verified,
            stories: []
          };
        }
        groupedStories[actorKey].stories.push({
          id: story.id,
          mediaType: story.media_type,
          mediaUrl: story.media_url,
          duration: story.duration,
          isSensitive: story.is_sensitive,
          viewCount: story.view_count,
          viewedByMe: story.viewed_by_me > 0,
          expiresAt: story.expires_at,
          createdAt: story.created_at
        });
      }

      // Convert to array
      const groupedArray = Object.values(groupedStories);

      // Inject advertisement stories
      const ads = await this.adService.selectAdsForUser(userId, 'story', 1);
      if (ads.length > 0) {
        // Create ad story group
        const adGroup = {
          actorType: 'ad',
          actorId: 'sponsored',
          username: null,
          actorName: 'Sponsored',
          avatarUrl: null,
          verified: false,
          isAd: true,
          stories: ads.map(ad => ({
            id: ad.id,
            mediaType: ad.adType,
            mediaUrl: ad.contentUrl,
            scriptContent: ad.scriptContent,
            duration: 5,
            isSensitive: false,
            viewCount: 0,
            viewedByMe: false,
            expiresAt: null,
            createdAt: now(),
            ctaText: ad.ctaText,
            ctaUrl: ad.ctaUrl,
            isAd: true
          }))
        };

        // Insert ad at beginning or random position
        const insertPosition = Math.min(2, groupedArray.length);
        groupedArray.splice(insertPosition, 0, adGroup);
      }

      const nextCursor = hasMore && rawStories.length > 0
        ? createCursor({ created_at: rawStories[rawStories.length - 1].created_at })
        : null;

      return successResponse({
        storyGroups: groupedArray,
        pagination: {
          hasMore,
          nextCursor
        }
      });
    } catch (error) {
      if (__DEV__) console.error('Get stories feed error:', error);
      return errorResponse('Failed to get stories', 500);
    }
  }

  /**
   * GET /stories/:username
   * Get specific user's stories
   */
  async getUserStories(request, userId, username) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');
      const currentTime = now();

      // Get user
      const user = await this.db.getUserByUsername(username);
      if (!user) {
        return errorResponse('User not found', 404);
      }

      // Check privacy
      const settings = await this.db.getUserSettings(user.id);
      if (settings.private_account && userId !== user.id) {
        const isFollowing = await this.env.DB.prepare(`
          SELECT COUNT(*) as count FROM follows
          WHERE follower_type = 'user' AND follower_id = ?
            AND followee_type = 'user' AND followee_id = ?
        `).bind(userId, user.id).first();

        if ((isFollowing?.count ?? 0) === 0) {
          return errorResponse('This account is private', 403);
        }
      }

      // Get stories
      let query = `
        SELECT s.*,
          (SELECT COUNT(*) FROM story_views WHERE story_id = s.id) as view_count,
          (SELECT COUNT(*) FROM story_views WHERE story_id = s.id AND viewer_id = ?) as viewed_by_me
        FROM stories s
        WHERE s.actor_type = 'user' AND s.actor_id = ?
          AND s.expires_at > ?
      `;

      const params = [userId, user.id, currentTime];

      if (cursor) {
        const cursorData = parseCursor(cursor);
        if (cursorData?.created_at) {
          query += ` AND s.created_at < ?`;
          params.push(cursorData.created_at);
        }
      }

      query += ` ORDER BY s.created_at DESC LIMIT ?`;
      params.push(limit + 1);

      const result = await this.env.DB.prepare(query).bind(...params).all();

      const rawStories = result.results || [];
      const hasMore = rawStories.length > limit;
      if (hasMore) rawStories.pop();

      let stories = rawStories;

      const canViewSensitive = userId
        ? await this.sensitiveHandler.canViewSensitive(userId)
        : false;

      if (!canViewSensitive) {
        stories = stories.filter((story) => !story.is_sensitive);
      }

      const nextCursor = hasMore && rawStories.length > 0
        ? createCursor({ created_at: rawStories[rawStories.length - 1].created_at })
        : null;

      return successResponse({
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          avatarUrl: user.avatar_url,
          verified: user.verified
        },
        stories,
        pagination: {
          hasMore,
          nextCursor
        }
      });
    } catch (error) {
      if (__DEV__) console.error('Get user stories error:', error);
      return errorResponse('Failed to get stories', 500);
    }
  }

  /**
   * POST /stories/:id/view
   * Mark story as viewed
   */
  async markViewed(request, userId, storyId) {
    try {
      // Check if story exists and not expired
      const story = await this.env.DB.prepare(`
        SELECT * FROM stories WHERE id = ? AND expires_at > ?
      `).bind(storyId, now()).first();

      if (!story) {
        return errorResponse('Story not found or expired', 404);
      }

      // Check if already viewed
      const existing = await this.env.DB.prepare(`
        SELECT * FROM story_views WHERE story_id = ? AND viewer_id = ?
      `).bind(storyId, userId).first();

      if (existing) {
        return successResponse(null, 'Already viewed');
      }

      // Record view
      await this.env.DB.prepare(`
        INSERT INTO story_views (id, story_id, viewer_type, viewer_id, viewed_at)
        VALUES (?, ?, 'user', ?, ?)
      `).bind(generateId('sv'), storyId, userId, now()).run();

      // Increment view count
      await this.env.DB.prepare(`
        UPDATE stories SET views_count = views_count + 1 WHERE id = ?
      `).bind(storyId).run();

      return successResponse(null, 'Story viewed');
    } catch (error) {
      if (__DEV__) console.error('Mark story viewed error:', error);
      return errorResponse('Failed to mark story viewed', 500);
    }
  }

  /**
   * DELETE /stories/:id
   * Delete story
   */
  async delete(request, userId, storyId) {
    try {
      const story = await this.env.DB.prepare(`
        SELECT * FROM stories WHERE id = ?
      `).bind(storyId).first();

      if (!story) {
        return errorResponse('Story not found', 404);
      }

      // Check ownership
      if (story.actor_type === 'user' && story.actor_id !== userId) {
        return errorResponse('You do not own this story', 403);
      }

      if (story.actor_type === 'page') {
        const isOwner = await this.db.isPageOwner(story.actor_id, userId);
        if (!isOwner) {
          return errorResponse('You do not own this page', 403);
        }
      }

      // Clean up Cloudflare media before deleting story
      try {
        const { CloudflareMediaCleaner } = await import('../utils/cloudflare-media.js');
        const cleaner = new CloudflareMediaCleaner(this.env);
        
        // Delete video if present
        if (story.media_type === 'video' && story.media_url) {
          // Extract video ID from URL (last part of URL or stored ID)
          const videoId = story.cloudflare_video_id || story.media_url.split('/').pop();
          if (videoId) {
            await cleaner.deleteVideo(videoId);
          }
        }
      } catch (cleanupError) {
        if (__DEV__) console.warn('Cloudflare cleanup for story deletion failed:', cleanupError);
        // Don't fail deletion if cleanup fails
      }

      // Delete story (cascades to views)
      await this.env.DB.prepare(`
        DELETE FROM stories WHERE id = ?
      `).bind(storyId).run();

      return successResponse(null, 'Story deleted successfully');
    } catch (error) {
      if (__DEV__) console.error('Delete story error:', error);
      return errorResponse('Failed to delete story', 500);
    }
  }

  /**
   * GET /stories/:id/viewers
   * Get list of users who viewed the story
   */
  async getViewers(request, userId, storyId) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 50, 1, 200);
      const cursor = url.searchParams.get('cursor');

      const story = await this.env.DB.prepare(`
        SELECT * FROM stories WHERE id = ?
      `).bind(storyId).first();

      if (!story) {
        return errorResponse('Story not found', 404);
      }

      // Check ownership
      if (story.actor_type === 'user' && story.actor_id !== userId) {
        return errorResponse('You can only see viewers of your own stories', 403);
      }

      if (story.actor_type === 'page') {
        const isOwner = await this.db.isPageOwner(story.actor_id, userId);
        if (!isOwner) {
          return errorResponse('You do not own this page', 403);
        }
      }

      // Get viewers
      let query = `
        SELECT u.id, u.username, u.name, u.avatar_url, u.verified, sv.viewed_at
        FROM story_views sv
        JOIN users u ON sv.viewer_id = u.id
        WHERE sv.story_id = ?
      `;

      const params = [storyId];

      if (cursor) {
        const cursorData = parseCursor(cursor);
        if (cursorData?.viewed_at) {
          query += ` AND sv.viewed_at < ?`;
          params.push(cursorData.viewed_at);
        }
      }

      query += ` ORDER BY sv.viewed_at DESC LIMIT ?`;
      params.push(limit + 1);

      const result = await this.env.DB.prepare(query).bind(...params).all();

      const rawViewers = result.results || [];
      const hasMore = rawViewers.length > limit;
      if (hasMore) rawViewers.pop();

      const nextCursor = hasMore && rawViewers.length > 0
        ? createCursor({ viewed_at: rawViewers[rawViewers.length - 1].viewed_at })
        : null;

      return successResponse({
        viewers: rawViewers,
        count: rawViewers.length,
        pagination: { hasMore, nextCursor }
      });
    } catch (error) {
      if (__DEV__) console.error('Get story viewers error:', error);
      return errorResponse('Failed to get viewers', 500);
    }
  }
}
