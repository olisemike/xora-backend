// ============================================
// REELS CONTROLLER
// Short-form vertical video with algorithm
// ============================================

import { DatabaseService } from '../services/database.js';
import { DbRouter } from '../services/dbRouter.js';
import { SensitiveContentHandler } from '../services/sensitiveContent.js';
import { EngagementTracker } from '../services/feedAlgorithmDecay.js';
import { AdService } from '../services/adService.js';
import {
  generateId,
  errorResponse,
  successResponse,
  now,
  parseCursor,
  createCursor
, safeParseInt } from '../utils/helpers.js';

export class ReelsController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
    this.dbRouter = this.db.router || DbRouter.fromEnv(env);
    const primaryDb = this.dbRouter.getPrimaryDb();
    this.sensitiveHandler = new SensitiveContentHandler(primaryDb, env.CACHE);
    this.engagementTracker = new EngagementTracker(primaryDb);
    this.adService = new AdService(primaryDb, env.CACHE);
  }

  /**
   * POST /reels
   * Create new reel
   */
  async create(request, userId) {
    try {
      const body = await request.json();
      const { 
        actorType, 
        actorId, 
        videoUrl, 
        thumbnailUrl,
        caption, 
        duration,
        language,
        isSensitive 
      } = body;

      // Verify actor ownership
      if (actorType === 'user' && actorId !== userId) {
        return errorResponse('Cannot create reel as this user', 403);
      }

      if (actorType === 'page') {
        const isOwner = await this.db.isPageOwner(actorId, userId);
        if (!isOwner) {
          return errorResponse('You do not own this page', 403);
        }
      }

      if (!videoUrl) {
        return errorResponse('Video URL required', 400);
      }

      if (duration && duration > 180) {
        return errorResponse('Reel duration cannot exceed 180 seconds (3 minutes)', 400);
      }

      // Create reel
      const reelId = generateId('reel');
      const timestamp = now();

      await this.env.DB.prepare(`
        INSERT INTO reels (
          id, actor_type, actor_id, video_url, thumbnail_url,
          caption, duration, language, is_sensitive, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        reelId,
        actorType,
        actorId,
        videoUrl,
        thumbnailUrl || null,
        caption || '',
        duration || 30,
        language || 'en',
        isSensitive ? 1 : 0,
        timestamp,
        timestamp
      ).run();

      const reel = await this.env.DB.prepare(`
        SELECT * FROM reels WHERE id = ?
      `).bind(reelId).first();

      return successResponse(reel, 'Reel created successfully');
    } catch (error) {
      console.error('Create reel error:', error);
      return errorResponse('Failed to create reel', 500);
    }
  }

  /**
   * GET /reels/feed
   * Get personalized reels feed - queries VIDEO POSTS from posts table
   * Prioritizes: followed users, matching interests, language, and location
   */
  async getFeed(request, userId) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');
      const lang = url.searchParams.get('lang');
      const forceNonSensitive = url.searchParams.get('force_non_sensitive') === '1';

      // Check if user is in sensitive-only mode
      const isInSensitiveMode = await this.sensitiveHandler.isInSensitiveMode(userId);

      // Fetch user profile for personalization (interests, language, location)
      // Try to get interests from user_behavior_profiles, fall back gracefully
      const userProfile = await this.env.DB.prepare(`
        SELECT u.preferred_language as language, u.location,
               COALESCE(ubp.interests, '[]') as interests
        FROM users u
        LEFT JOIN user_behavior_profiles ubp ON u.id = ubp.user_id
        WHERE u.id = ?
      `).bind(userId).first();

      const userInterests = userProfile?.interests ? JSON.parse(userProfile.interests || '[]') : [];
      const userLanguage = userProfile?.language || null;
      const userLocation = userProfile?.location || null;

      // Fetch user's follows
      const followsResult = await this.env.DB.prepare(`
        SELECT followee_id FROM follows 
        WHERE follower_type = 'user' AND follower_id = ? AND followee_type = 'user'
      `).bind(userId).all();

      const followedIds = followsResult?.results?.map(f => f.followee_id) || [];

      // Handle empty followedIds - use -1 as placeholder to avoid empty IN () syntax
      const followIdsPlaceholders = followedIds.length > 0 ? followedIds.map(() => '?').join(',') : '?';
      const followIdsForParams = followedIds.length > 0 ? followedIds : [-1];

      // Query video posts from posts table with personalization scoring
      let query = `
        SELECT
          p.id as post_id,
          p.id,
          p.actor_type,
          p.actor_id,
          p.content as caption,
          p.media_urls,
          p.media_type,
          p.language,
          p.is_sensitive,
          p.likes_count,
          p.comments_count,
          p.shares_count,
          p.created_at,
          p.updated_at,
          CASE
            WHEN p.actor_type = 'user' THEN u.username
            ELSE NULL
          END as username,
          CASE
            WHEN p.actor_type = 'user' THEN u.name
            WHEN p.actor_type = 'page' THEN pg.name
          END as actor_name,
          CASE
            WHEN p.actor_type = 'user' THEN u.avatar_url
            WHEN p.actor_type = 'page' THEN pg.avatar_url
          END as avatar_url,
          CASE
            WHEN p.actor_type = 'user' THEN u.verified
            WHEN p.actor_type = 'page' THEN pg.verified
          END as verified,
          (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id AND actor_type = 'user' AND actor_id = ?) as liked_by_me,
          -- Personalization scoring
          CASE WHEN p.actor_type = 'user' AND p.actor_id IN (${followIdsPlaceholders}) THEN 1000 ELSE 0 END as is_from_follow,
          CASE WHEN p.language = ? THEN 500 ELSE 0 END as language_match_score,
          CASE WHEN ? IS NOT NULL AND p.actor_type = 'user' AND u.location = ? THEN 300 ELSE 0 END as location_match_score
        FROM posts p
        LEFT JOIN users u ON p.actor_type = 'user' AND p.actor_id = u.id
        LEFT JOIN pages pg ON p.actor_type = 'page' AND p.actor_id = pg.id
        WHERE (p.media_type = 'video' OR p.media_type = 'mixed')
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
          WHERE (b.blocker_type = 'user' AND b.blocker_id = ? AND b.blocked_type = p.actor_type AND b.blocked_id = p.actor_id)
             OR (b.blocker_type = p.actor_type AND b.blocker_id = p.actor_id AND b.blocked_type = 'user' AND b.blocked_id = ?)
        )
        AND (
          p.actor_type != 'user'
          OR NOT EXISTS (
            SELECT 1 FROM user_settings s
            WHERE s.user_id = p.actor_id
              AND s.private_account = 1
              AND p.actor_id != ?
              AND NOT EXISTS (
                SELECT 1 FROM follows f
                WHERE f.follower_type = 'user' AND f.follower_id = ?
                  AND f.followee_type = 'user' AND f.followee_id = p.actor_id
              )
          )
        )
      `;

      const params = [userId, ...followIdsForParams, userLanguage, userLocation, userLocation, userId, userId, userId, userId];

      // Sensitive mode filtering
      if (isInSensitiveMode && !forceNonSensitive) {
        query += ` AND p.is_sensitive = 1`;
      } else {
        const canViewSensitive = await this.sensitiveHandler.canViewSensitive(userId);
        const allowsSuggestions = await this.sensitiveHandler.allowsSensitiveSuggestions(userId);

        if (!canViewSensitive || !allowsSuggestions || forceNonSensitive) {
          query += ` AND p.is_sensitive = 0`;
        }
      }

      if (lang) {
        query += ` AND p.language = ?`;
        params.push(lang);
      }

      if (cursor) {
        const cursorData = parseCursor(cursor);
        if (cursorData?.created_at) {
          query += ` AND p.created_at < ?`;
          params.push(cursorData.created_at);
        }
      }

      // Order by: personalization boost + engagement + recency
      query += ` ORDER BY (is_from_follow + language_match_score + location_match_score + p.likes_count + p.comments_count * 2) DESC, p.created_at DESC LIMIT ?`;
      params.push(limit + 1);

      const result = await this.env.DB.prepare(query).bind(...params).all();
      let reels = result.results || [];

      const hasMore = reels.length > limit;
      if (hasMore) reels.pop();

      // Transform posts to reel format, extracting ALL videos from media_urls
      reels = reels.map(post => {
        const videos = []; // Array to hold all videos from this post

        try {
          const mediaUrls = JSON.parse(post.media_urls || '[]');
          
          // Ensure mediaUrls is an array
          const urlsArray = Array.isArray(mediaUrls) ? mediaUrls : [mediaUrls];
          
          // Extract ALL video objects - maintain order from upload
          urlsArray.forEach(item => {
            let isVideo = false;
            let videoUrl = null;
            let thumbnailUrl = null;
            let videoId = null;

            // Check if this is a video
            if (typeof item === 'object' && item !== null) {
              const urlStr = item.url || '';
              isVideo = item.type === 'video' || 
                        urlStr.includes('.mp4') || urlStr.includes('.mov') || 
                        urlStr.includes('.webm') || urlStr.includes('cloudflarestream') || 
                        urlStr.includes('/video/');
              
              if (isVideo) {
                videoUrl = item.url;
                thumbnailUrl = item.thumbnail || null;
                videoId = item.videoId || null;
              }
            } else if (typeof item === 'string') {
              isVideo = item.includes('.mp4') || item.includes('.mov') || item.includes('.webm') ||
                        item.includes('cloudflarestream') || item.includes('/video/');
              if (isVideo) {
                videoUrl = item;
              }
            }

            // If we found a video, add it to videos array
            if (isVideo && videoUrl) {
              // Generate thumbnail from video URL if possible (Cloudflare Stream format)
              if (!thumbnailUrl && videoUrl && typeof videoUrl === 'string' && videoUrl.includes('cloudflarestream')) {
                thumbnailUrl = videoUrl.replace('/manifest/video.m3u8', '/thumbnails/thumbnail.jpg');
              }

              videos.push({
                url: videoUrl,
                thumbnail: thumbnailUrl,
                videoId: videoId
              });
            }
          });

          if (videos.length === 0) {
            console.warn('Post has no videos despite video media type:', post.id);
          }
        } catch (e) {
          console.error('Failed to parse media_urls for post', post.id, ':', e.message);
          console.error('Raw media_urls:', post.media_urls);
        }

        return {
          id: post.id,
          postId: post.post_id || post.id, // Use camelCase (will be passed through toCamelCase)
          actorType: post.actor_type, // Already camelCase compatible
          actorId: post.actor_id, // Already camelCase compatible
          videos: videos, // Return ALL videos from this post (already camelCase objects)
          caption: post.caption,
          duration: null, // Posts don't track duration
          language: post.language,
          isSensitive: post.is_sensitive, // Consistent with other endpoints
          likesCount: post.likes_count, // Consistent with other endpoints
          commentsCount: post.comments_count, // Consistent with other endpoints
          sharesCount: post.shares_count, // Consistent with other endpoints
          viewsCount: 0, // Consistent with other endpoints
          createdAt: post.created_at, // Consistent with other endpoints
          updatedAt: post.updated_at, // Consistent with other endpoints
          username: post.username,
          actorName: post.actor_name, // Consistent with other endpoints
          avatarUrl: post.avatar_url, // Consistent with other endpoints
          verified: post.verified,
          likedByMe: post.liked_by_me // Consistent with other endpoints
        };
      });

      reels = await this.db.attachEngagementCounts(reels);

      const nextCursor = hasMore && reels.length > 0
        ? createCursor({ created_at: reels[reels.length - 1].created_at })
        : null;

      // Inject advertisements into reels feed
      const ads = await this.adService.selectAdsForUser(userId, 'reel', 2, { language: lang });
      const reelsWithAds = this.adService.injectAdsIntoFeed(reels, ads, 5);

      return successResponse({
        reels: reelsWithAds,
        pagination: { hasMore, nextCursor },
        sensitiveMode: isInSensitiveMode
      });
    } catch (error) {
      console.error('Get reels feed error:', error.message || error);
      return errorResponse(error.message || 'Failed to get reels', 500);
    }
  }

  /**
   * GET /reels/:id
   * Get single reel (video post)
   */
  async get(request, userId, reelId) {
    try {
      const post = await this.env.DB.prepare(`
        SELECT
          p.id as post_id,
          p.id,
          p.actor_type,
          p.actor_id,
          p.content as caption,
          p.media_urls,
          p.media_type,
          p.language,
          p.is_sensitive,
          p.likes_count,
          p.comments_count,
          p.shares_count,
          p.created_at,
          p.updated_at,
          CASE
            WHEN p.actor_type = 'user' THEN u.username
            ELSE NULL
          END as username,
          CASE
            WHEN p.actor_type = 'user' THEN u.name
            WHEN p.actor_type = 'page' THEN pg.name
          END as actor_name,
          CASE
            WHEN p.actor_type = 'user' THEN u.avatar_url
            WHEN p.actor_type = 'page' THEN pg.avatar_url
          END as avatar_url,
          CASE
            WHEN p.actor_type = 'user' THEN u.verified
            WHEN p.actor_type = 'page' THEN pg.verified
          END as verified,
          (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id AND actor_type = 'user' AND actor_id = ?) as liked_by_me
        FROM posts p
        LEFT JOIN users u ON p.actor_type = 'user' AND p.actor_id = u.id
        LEFT JOIN pages pg ON p.actor_type = 'page' AND p.actor_id = pg.id
        WHERE p.id = ? AND (p.media_type = 'video' OR p.media_type = 'mixed')
      `).bind(userId, reelId).first();

      if (!post) {
        return errorResponse('Reel not found', 404);
      }

      // Check if sensitive and user can view
      if (post.is_sensitive) {
        const canView = await this.sensitiveHandler.canViewSensitive(userId);
        if (!canView) {
          return errorResponse('You cannot view sensitive content. Update settings.', 403);
        }
      }

      // Transform to reel format
      let videoUrl = null;
      let thumbnailUrl = null;
      let videoId = null;
      try {
        const mediaUrls = JSON.parse(post.media_urls || '[]');
        const urlsArray = Array.isArray(mediaUrls) ? mediaUrls : [mediaUrls];
        
        // Find first valid video URL - handle both string URLs and media objects
        videoUrl = urlsArray.find(item => {
          // If item is an object (new format with {type, url, thumbnail, videoId})
          if (typeof item === 'object' && item !== null) {
            const urlStr = item.url || '';
            return item.type === 'video' || 
                   urlStr.includes('.mp4') || urlStr.includes('.mov') || 
                   urlStr.includes('.webm') || urlStr.includes('cloudflarestream') || 
                   urlStr.includes('/video/');
          }
          // If item is a string (old format)
          if (typeof item === 'string') {
            return item.includes('.mp4') || item.includes('.mov') || item.includes('.webm') ||
                   item.includes('cloudflarestream') || item.includes('/video/');
          }
          return false;
        });

        // Extract the actual URL if we have an object
        let actualUrl = videoUrl;
        if (typeof videoUrl === 'object' && videoUrl !== null) {
          if (!videoUrl.url) {
            console.warn('Video object missing URL field:', videoUrl);
          }
          actualUrl = videoUrl.url;
          thumbnailUrl = videoUrl.thumbnail || null;
        } else if (typeof videoUrl === 'string') {
          actualUrl = videoUrl;
        }
        videoUrl = actualUrl;

        // Generate thumbnail from video URL if possible (Cloudflare Stream format) - only if not already set
        if (!thumbnailUrl && videoUrl && typeof videoUrl === 'string' && videoUrl.includes('cloudflarestream')) {
          thumbnailUrl = videoUrl.replace('/manifest/video.m3u8', '/thumbnails/thumbnail.jpg');
        }

        // Fallback to first valid URL if no video found
        if (!videoUrl && urlsArray.length > 0) {
          for (const url of urlsArray) {
            const validUrl = typeof url === 'object' ? url.url : url;
            if (validUrl) {
              videoUrl = validUrl;
              break;
            }
          }
        }

        // Validate and sanitize videoUrl
        if (videoUrl && typeof videoUrl !== 'string') {
          console.error('Invalid videoUrl type:', typeof videoUrl, videoUrl);
          videoUrl = null;
        }
      } catch (e) {
        console.error('Failed to parse media_urls for post', post.id, ':', e.message);
        console.error('Raw media_urls:', post.media_urls);
      }

      const reel = {
        id: post.id,
        postId: post.post_id || post.id,
        actorType: post.actor_type,
        actorId: post.actor_id,
        videoUrl: videoUrl,
        thumbnailUrl: thumbnailUrl,
        caption: post.caption,
        language: post.language,
        isSensitive: post.is_sensitive,
        likesCount: post.likes_count,
        commentsCount: post.comments_count,
        sharesCount: post.shares_count,
        viewsCount: 0,
        createdAt: post.created_at,
        updatedAt: post.updated_at,
        username: post.username,
        actorName: post.actor_name,
        avatarUrl: post.avatar_url,
        verified: post.verified,
        likedByMe: post.liked_by_me
      };

      return successResponse(reel);
    } catch (error) {
      console.error('Get reel error:', error);
      return errorResponse('Failed to get reel', 500);
    }
  }

  /**
   * POST /reels/:id/view
   * Increment view count for video post
   */
  async view(request, userId, reelId) {
    try {
      // Check if post exists and has video content (handles single video, multiple videos, mixed media)
      const post = await this.env.DB.prepare(`
        SELECT id, media_type, media_urls FROM posts WHERE id = ?
      `).bind(reelId).first();

      if (!post) {
        // Not a valid post, also check if it's an actual reel
        const reel = await this.env.DB.prepare(`
          SELECT id FROM reels WHERE id = ?
        `).bind(reelId).first();

        if (!reel) {
          return errorResponse('Post or reel not found', 404);
        }
      }

      // Verify this has video content (media_type: video or mixed)
      // For video posts, track views in reel_views table (reel_id now accepts post_id)
      if (post && post.media_type !== 'video' && post.media_type !== 'mixed') {
        // Not a video post, skip tracking
        return successResponse(null, 'Not a video post');
      }

      // Check if already viewed - reel_views now supports both actual reels and video posts
      const existing = await this.env.DB.prepare(`
        SELECT * FROM reel_views WHERE reel_id = ? AND viewer_type = 'user' AND viewer_id = ?
      `).bind(reelId, userId).first();

      if (existing) {
        return successResponse(null, 'Already viewed');
      }

      // Record view (reel_id can be post_id for video posts, or actual reel_id)
      await this.env.DB.prepare(`
        INSERT INTO reel_views (id, reel_id, viewer_type, viewer_id, viewed_at)
        VALUES (?, ?, 'user', ?, ?)
      `).bind(generateId('rv'), reelId, userId, now()).run();

      // Note: Posts table doesn't have views_count column by default
      // Views are tracked in reel_views table and can be counted via query

      // Activate sensitive mode if post is sensitive
      if (post.is_sensitive) {
        await this.sensitiveHandler.activateSensitiveMode(userId, reelId);
      }

      return successResponse(null, 'View recorded');
    } catch (error) {
      console.error('View reel error:', error);
      return errorResponse('Failed to record view', 500);
    }
  }

  /**
   * POST /reels/:id/like
   * Like video post (reel)
   */
  async like(request, userId, reelId) {
    try {
      const body = await request.json();
      const { actorType, actorId } = body;

      // Verify this is a video post (or mixed media post with video)
      const post = await this.env.DB.prepare(`
        SELECT id FROM posts WHERE id = ? AND (media_type = 'video' OR media_type = 'mixed')
      `).bind(reelId).first();

      if (!post) {
        return errorResponse('Reel not found', 404);
      }

      const existing = await this.env.DB.prepare(`
        SELECT * FROM likes WHERE actor_type = ? AND actor_id = ? AND target_type = 'post' AND target_id = ?
      `).bind(actorType, actorId, reelId).first();

      if (existing) {
        return errorResponse('Already liked', 400);
      }

      await this.env.DB.prepare(`
        INSERT INTO likes (id, actor_type, actor_id, target_type, target_id, created_at)
        VALUES (?, ?, ?, 'post', ?, ?)
      `).bind(generateId('like'), actorType, actorId, reelId, now()).run();

      // Increment like count on posts table
      await this.env.DB.prepare(`
        UPDATE posts SET likes_count = likes_count + 1 WHERE id = ?
      `).bind(reelId).run();

      return successResponse(null, 'Reel liked');
    } catch (error) {
      console.error('Like reel error:', error);
      return errorResponse('Failed to like reel', 500);
    }
  }

  /**
   * DELETE /reels/:id/like
   * Unlike video post (reel)
   */
  async unlike(request, userId, reelId) {
    try {
      const body = await request.json();
      const { actorType, actorId } = body;

      const deleted = await this.env.DB.prepare(`
        DELETE FROM likes WHERE actor_type = ? AND actor_id = ? AND target_type = 'post' AND target_id = ?
      `).bind(actorType, actorId, reelId).run();

      if (deleted.changes === 0) {
        return errorResponse('Not liked', 400);
      }

      // Decrement like count on posts table
      await this.env.DB.prepare(`
        UPDATE posts SET likes_count = likes_count - 1 WHERE id = ?
      `).bind(reelId).run();

      return successResponse(null, 'Reel unliked');
    } catch (error) {
      console.error('Unlike reel error:', error);
      return errorResponse('Failed to unlike reel', 500);
    }
  }

  /**
   * DELETE /reels/:id
   * Delete video post (reel)
   * Note: This deletes the entire post, not just the video
   */
  async delete(request, userId, reelId) {
    try {
      const post = await this.env.DB.prepare(`
        SELECT * FROM posts WHERE id = ? AND (media_type = 'video' OR media_type = 'mixed')
      `).bind(reelId).first();

      if (!post) {
        return errorResponse('Reel not found', 404);
      }

      // Check ownership
      if (post.actor_type === 'user' && post.actor_id !== userId) {
        return errorResponse('You do not own this reel', 403);
      }

      if (post.actor_type === 'page') {
        const isOwner = await this.db.isPageOwner(post.actor_id, userId);
        if (!isOwner) {
          return errorResponse('You do not own this page', 403);
        }
      }

      // Delete the video post
      await this.env.DB.prepare(`
        DELETE FROM posts WHERE id = ?
      `).bind(reelId).run();

      return successResponse(null, 'Reel deleted successfully');
    } catch (error) {
      console.error('Delete reel error:', error);
      return errorResponse('Failed to delete reel', 500);
    }
  }

  /**
   * POST /reels/exit-sensitive-mode
   * Exit sensitive-only mode
   */
  async exitSensitiveMode(request, userId) {
    try {
      await this.sensitiveHandler.deactivateSensitiveMode(userId);
      return successResponse(null, 'Exited sensitive mode');
    } catch (error) {
      console.error('Exit sensitive mode error:', error);
      return errorResponse('Failed to exit sensitive mode', 500);
    }
  }

  /**
   * GET /reels/user/:username
   * Get user's video posts (reels)
   */
  async getUserReels(request, userId, username) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');

      const user = await this.db.getUserByUsername(username);
      if (!user) {
        return errorResponse('User not found', 404);
      }

      let query = `
        SELECT
          p.id as post_id,
          p.id,
          p.actor_type,
          p.actor_id,
          p.content as caption,
          p.media_urls,
          p.media_type,
          p.language,
          p.is_sensitive,
          p.likes_count,
          p.comments_count,
          p.shares_count,
          p.created_at,
          p.updated_at,
          (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id AND actor_type = 'user' AND actor_id = ?) as liked_by_me
        FROM posts p
        WHERE p.actor_type = 'user' AND p.actor_id = ? AND (p.media_type = 'video' OR p.media_type = 'mixed')
      `;

      const params = [userId, user.id];

      if (cursor) {
        const cursorData = parseCursor(cursor);
        if (cursorData?.created_at) {
          query += ` AND p.created_at < ?`;
          params.push(cursorData.created_at);
        }
      }

      query += ` ORDER BY p.created_at DESC LIMIT ?`;
      params.push(limit + 1);

      const result = await this.env.DB.prepare(query).bind(...params).all();
      let reels = result.results || [];

      const hasMore = reels.length > limit;
      if (hasMore) reels.pop();

      // Transform posts to reel format
      reels = reels.map(post => {
        let videoUrl = null;
        let thumbnailUrl = null;
        let videoId = null;
        try {
          const mediaUrls = JSON.parse(post.media_urls || '[]');
          const urlsArray = Array.isArray(mediaUrls) ? mediaUrls : [mediaUrls];
          
          // Find first valid video URL - handle both string URLs and media objects
          videoUrl = urlsArray.find(item => {
            // If item is an object (new format with {type, url, thumbnail, videoId})
            if (typeof item === 'object' && item !== null) {
              const urlStr = item.url || '';
              return item.type === 'video' || 
                     urlStr.includes('.mp4') || urlStr.includes('.mov') || 
                     urlStr.includes('.webm') || urlStr.includes('cloudflarestream') || 
                     urlStr.includes('/video/');
            }
            // If item is a string (old format)
            if (typeof item === 'string') {
              return item.includes('.mp4') || item.includes('.mov') || item.includes('.webm') ||
                     item.includes('cloudflarestream') || item.includes('/video/');
            }
            return false;
          });

          // Extract the actual URL if we have an object
          let actualUrl = videoUrl;
          if (typeof videoUrl === 'object' && videoUrl !== null) {
            if (!videoUrl.url) {
              console.warn('Video object missing URL field:', videoUrl);
            }
            actualUrl = videoUrl.url;
            thumbnailUrl = videoUrl.thumbnail || null;
          } else if (typeof videoUrl === 'string') {
            actualUrl = videoUrl;
          }
          videoUrl = actualUrl;

          // Generate thumbnail from video URL if possible (Cloudflare Stream format) - only if not already set
          if (!thumbnailUrl && videoUrl && typeof videoUrl === 'string' && videoUrl.includes('cloudflarestream')) {
            thumbnailUrl = videoUrl.replace('/manifest/video.m3u8', '/thumbnails/thumbnail.jpg');
          }

          // Fallback to first valid URL if no video found
          if (!videoUrl && urlsArray.length > 0) {
            for (const url of urlsArray) {
              const validUrl = typeof url === 'object' ? url.url : url;
              if (validUrl) {
                videoUrl = validUrl;
                break;
              }
            }
          }

          // Validate and sanitize videoUrl
          if (videoUrl && typeof videoUrl !== 'string') {
            console.error('Invalid videoUrl type:', typeof videoUrl, videoUrl);
            videoUrl = null;
          }
        } catch (e) {
          console.error('Failed to parse media_urls for post', post.id, ':', e.message);
          console.error('Raw media_urls:', post.media_urls);
        }

        return {
          id: post.id,
          postId: post.post_id || post.id,
          actorType: post.actor_type,
          actorId: post.actor_id,
          videoUrl: videoUrl,
          thumbnailUrl: thumbnailUrl,
          caption: post.caption,
          language: post.language,
          isSensitive: post.is_sensitive,
          likesCount: post.likes_count,
          commentsCount: post.comments_count,
          sharesCount: post.shares_count,
          viewsCount: 0,
          createdAt: post.created_at,
          updatedAt: post.updated_at,
          likedByMe: post.liked_by_me
        };
      });

      const nextCursor = hasMore && reels.length > 0
        ? createCursor({ created_at: reels[reels.length - 1].created_at })
        : null;

      return successResponse({
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          avatarUrl: user.avatar_url,
          verified: user.verified
        },
        reels,
        pagination: { hasMore, nextCursor }
      });
    } catch (error) {
      console.error('Get user reels error:', error);
      return errorResponse('Failed to get reels', 500);
    }
  }

  /**
   * GET /reels/:id/comments
   * Get comments for a video post (reel)
   * Uses the standard comments table with target_type='post'
   */
  async getComments(request, userId, reelId) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');

      // Verify video post exists
      const post = await this.env.DB.prepare(`
        SELECT id FROM posts WHERE id = ? AND (media_type = 'video' OR media_type = 'mixed')
      `).bind(reelId).first();

      if (!post) {
        return errorResponse('Reel not found', 404);
      }

      // Query from standard comments table for posts
      let query = `
        SELECT c.*,
          CASE
            WHEN c.actor_type = 'user' THEN u.username
            ELSE NULL
          END as username,
          CASE
            WHEN c.actor_type = 'user' THEN u.name
            WHEN c.actor_type = 'page' THEN p.name
          END as name,
          CASE
            WHEN c.actor_type = 'user' THEN u.avatar_url
            WHEN c.actor_type = 'page' THEN p.avatar_url
          END as avatar_url
        FROM comments c
        LEFT JOIN users u ON c.actor_type = 'user' AND c.actor_id = u.id
        LEFT JOIN pages p ON c.actor_type = 'page' AND c.actor_id = p.id
        WHERE c.target_type = 'post' AND c.target_id = ? AND c.parent_id IS NULL
      `;

      const params = [reelId];

      if (cursor) {
        const cursorData = parseCursor(cursor);
        if (cursorData?.created_at) {
          query += ` AND c.created_at < ?`;
          params.push(cursorData.created_at);
        }
      }

      query += ` ORDER BY c.created_at DESC LIMIT ?`;
      params.push(limit + 1);

      const result = await this.env.DB.prepare(query).bind(...params).all();
      const comments = result.results || [];

      const hasMore = comments.length > limit;
      if (hasMore) comments.pop();

      const nextCursor = hasMore && comments.length > 0
        ? createCursor({ created_at: comments[comments.length - 1].created_at })
        : null;

      return successResponse({
        comments,
        post_id: reelId,  // Include post_id for client reference
        pagination: { hasMore, nextCursor }
      });
    } catch (error) {
      console.error('Get reel comments error:', error);
      return errorResponse('Failed to get comments', 500);
    }
  }

  /**
   * POST /reels/:id/comments
   * Create a comment on a video post (reel)
   * Uses the standard comments table with target_type='post'
   */
  async createComment(request, userId, reelId) {
    try {
      const body = await request.json();
      const { actorType, actorId, content, parentId } = body;

      if (!content || !content.trim()) {
        return errorResponse('Comment content is required', 400);
      }

      // Validate actorType
      if (!actorType || !['user', 'page'].includes(actorType)) {
        return errorResponse('Actor type must be "user" or "page"', 400);
      }

      if (actorType === 'user' && actorId !== userId) {
        return errorResponse('Cannot comment as this user', 403);
      }

      if (actorType === 'page') {
        const isOwner = await this.db.isPageOwner(actorId, userId);
        if (!isOwner) {
          return errorResponse('You do not own this page', 403);
        }
      }

      // Verify video post exists
      const post = await this.env.DB.prepare(`
        SELECT id, actor_type, actor_id FROM posts WHERE id = ? AND (media_type = 'video' OR media_type = 'mixed')
      `).bind(reelId).first();

      if (!post) {
        return errorResponse('Reel not found', 404);
      }

      // Check if commenter is blocked by post owner
      const blocked = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM blocks
        WHERE (blocker_type = ? AND blocker_id = ? AND blocked_type = ? AND blocked_id = ?)
           OR (blocker_type = ? AND blocker_id = ? AND blocked_type = ? AND blocked_id = ?)
      `).bind(post.actor_type, post.actor_id, actorType, actorId, actorType, actorId, post.actor_type, post.actor_id).first();

      if ((blocked?.count ?? 0) > 0) {
        return errorResponse('Cannot comment on this reel', 403);
      }

      // Validate parent comment if provided
      if (parentId) {
        const parentComment = await this.env.DB.prepare(`
          SELECT id FROM comments WHERE id = ? AND target_type = 'post' AND target_id = ?
        `).bind(parentId, reelId).first();
        if (!parentComment) {
          return errorResponse('Parent comment not found', 404);
        }
      }

      const commentId = generateId('cmt');
      const timestamp = now();

      await this.env.DB.prepare(`
        INSERT INTO comments (
          id, target_type, target_id, actor_type, actor_id, content, parent_id, created_at, updated_at
        ) VALUES (?, 'post', ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        commentId,
        reelId,
        actorType,
        actorId,
        content.trim(),
        parentId || null,
        timestamp,
        timestamp
      ).run();

      // Increment comment count on post
      await this.env.DB.prepare(`
        UPDATE posts SET comments_count = comments_count + 1 WHERE id = ?
      `).bind(reelId).run();

      const comment = await this.env.DB.prepare(`
        SELECT c.*,
          CASE WHEN c.actor_type = 'user' THEN u.username ELSE NULL END as username,
          CASE WHEN c.actor_type = 'user' THEN u.name WHEN c.actor_type = 'page' THEN p.name END as name,
          CASE WHEN c.actor_type = 'user' THEN u.avatar_url WHEN c.actor_type = 'page' THEN p.avatar_url END as avatar_url
        FROM comments c
        LEFT JOIN users u ON c.actor_type = 'user' AND c.actor_id = u.id
        LEFT JOIN pages p ON c.actor_type = 'page' AND c.actor_id = p.id
        WHERE c.id = ?
      `).bind(commentId).first();

      return successResponse(comment, 'Comment added');
    } catch (error) {
      console.error('Create reel comment error:', error);
      return errorResponse('Failed to add comment', 500);
    }
  }

  /**
   * DELETE /reels/:id/comments/:commentId
   * Delete a comment from a video post (reel)
   */
  async deleteComment(request, userId, reelId, commentId) {
    try {
      const comment = await this.env.DB.prepare(`
        SELECT * FROM comments WHERE id = ? AND target_type = 'post' AND target_id = ?
      `).bind(commentId, reelId).first();

      if (!comment) {
        return errorResponse('Comment not found', 404);
      }

      // Check ownership
      if (comment.actor_type === 'user' && comment.actor_id !== userId) {
        // Check if user owns the post
        const post = await this.env.DB.prepare(`
          SELECT actor_type, actor_id FROM posts WHERE id = ?
        `).bind(reelId).first();

        if (!post || post.actor_type !== 'user' || post.actor_id !== userId) {
          return errorResponse('You cannot delete this comment', 403);
        }
      }

      if (comment.actor_type === 'page') {
        const isOwner = await this.db.isPageOwner(comment.actor_id, userId);
        if (!isOwner) {
          return errorResponse('You do not own this page', 403);
        }
      }

      // Clean up Cloudflare media before deletion
      try {
        const { CloudflareMediaCleaner } = await import('../utils/cloudflare-media.js');
        const cleaner = new CloudflareMediaCleaner(this.env);

        if (comment.cloudflare_image_ids) {
          await cleaner.deleteImages(comment.cloudflare_image_ids);
        }
        if (comment.cloudflare_video_ids) {
          await cleaner.deleteVideos(comment.cloudflare_video_ids);
        }
      } catch (cleanupErr) {
        // Log but don't fail the deletion
        console.error('Failed to clean up comment media:', cleanupErr);
      }

      await this.env.DB.prepare(`
        DELETE FROM comments WHERE id = ?
      `).bind(commentId).run();

      // Decrement comment count on post
      await this.env.DB.prepare(`
        UPDATE posts SET comments_count = comments_count - 1 WHERE id = ?
      `).bind(reelId).run();

      return successResponse(null, 'Comment deleted');
    } catch (error) {
      console.error('Delete reel comment error:', error);
      return errorResponse('Failed to delete comment', 500);
    }
  }
}
