// ============================================
// SHARES CONTROLLER
// Share posts with optional comment (quote sharing)
// ============================================

import { DatabaseService } from '../services/database.js';
import { DbRouter } from '../services/dbRouter.js';
import { FeedAlgorithmService } from '../services/feedAlgorithm.js';
import { PushNotificationService } from '../services/pushNotifications.js';
import { ActionBroadcaster } from '../utils/actionBroadcaster.js';
import { createNotification } from '../services/notifications.js';
import {
  generateId,
  errorResponse,
  successResponse,
  sanitizeText,
  now,
  parseCursor,
  createCursor
, safeParseInt } from '../utils/helpers.js';

export class SharesController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
    this.broadcaster = new ActionBroadcaster(env);
    this.dbRouter = this.db.router || DbRouter.fromEnv(env);
    const primaryDb = this.dbRouter.getPrimaryDb();
    this.feedAlgo = new FeedAlgorithmService(primaryDb, env.CACHE);
    this.pushService = new PushNotificationService(primaryDb, env);
  }

  /**
   * POST /shares
   * Share a post (with optional comment - "quote share")
   */
  async create(request, userId, ctx = null) {
    try {
      const body = await request.json();
      const { actorType, actorId, postId, comment, language } = body;
      const resolvedActorType = actorType || 'user';
      const resolvedActorId = actorId || (resolvedActorType === 'user' ? userId : null);

      // Verify actor ownership
      if (resolvedActorType === 'user' && resolvedActorId !== userId) {
        return errorResponse('Cannot share as this user', 403);
      }

      if (resolvedActorType === 'page') {
        if (!resolvedActorId) {
          return errorResponse('Page ID required to share as a page', 400);
        }
        const isOwner = await this.db.isPageOwner(resolvedActorId, userId);
        if (!isOwner) {
          return errorResponse('You do not own this page', 403);
        }
      }

      if (!postId) {
        return errorResponse('Post ID required', 400);
      }

      // Get original post
      const originalPost = await this.db.getPostById(postId);
      if (!originalPost) {
        return errorResponse('Original post not found', 404);
      }

      // Check if blocked
      const blocked = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM blocks
        WHERE (blocker_type = 'user' AND blocker_id = ? AND blocked_type = ? AND blocked_id = ?)
           OR (blocker_type = ? AND blocker_id = ? AND blocked_type = 'user' AND blocked_id = ?)
      `).bind(userId, originalPost.actor_type, originalPost.actor_id, originalPost.actor_type, originalPost.actor_id, userId).first();

      if ((blocked?.count ?? 0) > 0) {
        return errorResponse('Cannot share this post', 403);
      }

      // Create share
      const shareId = generateId('share');
      const timestamp = now();

      // NOTE: D1 schema uses original_post_id (no language/updated_at columns)
      await this.env.DB.prepare(`
        INSERT INTO shares (
          id, actor_type, actor_id, original_post_id, comment, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        shareId,
        resolvedActorType,
        resolvedActorId,
        postId,
        comment ? sanitizeText(comment, 500) : null,
        timestamp
      ).run();

      // Increment original post share count
      await this.db.incrementPostShares(postId, 1);

      // Get complete share with embedded post
      const share = await this.getShareWithPost(shareId);

      const runSideEffects = async () => {
        // Broadcast share action to post owner
        try {
          await this.broadcaster.broadcastShareAction('shared', {
            id: shareId,
            postId,
            actorType: resolvedActorType,
            actorId: resolvedActorId,
            comment,
            created_at: now()
          }, originalPost.actor_id);

          // Broadcast engagement update to ALL connected clients for real-time feed updates
          const counts = await this.db.getPostEngagementCounts([postId]);
          const key = String(postId);
          await this.broadcaster.broadcastEngagementUpdate(postId, 'share', {
            likesCount: counts.likes.get(key) ?? 0,
            commentsCount: counts.comments.get(key) ?? 0,
            sharesCount: counts.shares.get(key) ?? 0
          });
        } catch (e) {
          console.error('Failed to broadcast share:', e);
        }

        // Create persistent notification and notify the owner when someone else shares their user post
        try {
          if (
            originalPost.actor_type === 'user' &&
            originalPost.actor_id !== userId
          ) {
            // Create persistent notification in database
            await createNotification(
              this.env.DB,
              originalPost.actor_id,
              'share',
              'shared your post',
              resolvedActorType,
              resolvedActorId,
              'post',
              originalPost.id
            );

            // Send push notification
            if (this.pushService) {
              await this.pushService.triggerNotification('share', {
                postOwnerId: originalPost.actor_id,
                sharerName: share.actor_name || share.username || 'Someone',
                sharerAvatar: share.avatar_url || null,
                sharerId: resolvedActorId,
                postId: originalPost.id,
                shareId,
              });
            }
          }
        } catch (notifyError) {
          console.error('Share notification error:', notifyError);
        }

        // Initialize feed distribution for quote shares
        if (comment && comment.trim().length > 0) {
          try {
            await this.feedAlgo.initializePostDistribution(
              shareId,
              resolvedActorType,
              resolvedActorId,
              language || 'en'
            );
          } catch (error) {
            console.error('Failed to initialize share distribution:', error);
          }
        }

        // Invalidate sharer's feed cache so they see updated counts on refresh
        if (this.env.CACHE && resolvedActorType === 'user') {
          try {
            await this.env.CACHE.delete(`feed:home:${resolvedActorId}:20:start:all`);
          } catch { /* ignore cache errors */ }
        }
      };

      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(runSideEffects());
      } else {
        await runSideEffects();
      }

      return successResponse(share, 'Post shared successfully');
    } catch (error) {
      console.error('Create share error:', error);
      return errorResponse('Failed to share post', 500);
    }
  }

  /**
   * GET /shares/:id
   * Get single share
   */
  async get(request, userId, shareId) {
    try {
      const share = await this.getShareWithPost(shareId);
      
      if (!share) {
        return errorResponse('Share not found', 404);
      }

      return successResponse(share);
    } catch (error) {
      console.error('Get share error:', error);
      return errorResponse('Failed to get share', 500);
    }
  }

  /**
   * DELETE /shares/:id
   * Delete share
   */
  async delete(request, userId, shareId) {
    try {
      const share = await this.env.DB.prepare(`
        SELECT * FROM shares WHERE id = ?
      `).bind(shareId).first();

      if (!share) {
        return errorResponse('Share not found', 404);
      }

      // Check ownership
      if (share.actor_type === 'user' && share.actor_id !== userId) {
        return errorResponse('You do not own this share', 403);
      }

      if (share.actor_type === 'page') {
        const isOwner = await this.db.isPageOwner(share.actor_id, userId);
        if (!isOwner) {
          return errorResponse('You do not own this page', 403);
        }
      }

      // Decrement original post share count
      await this.db.incrementPostShares(share.original_post_id, -1);

      // Delete share
      await this.env.DB.prepare(`
        DELETE FROM shares WHERE id = ?
      `).bind(shareId).run();

      // Broadcast engagement update to ALL connected clients for real-time feed updates
      try {
        const counts = await this.db.getPostEngagementCounts([share.original_post_id]);
        const key = String(share.original_post_id);
        await this.broadcaster.broadcastEngagementUpdate(share.original_post_id, 'share_deleted', {
          likesCount: counts.likes.get(key) ?? 0,
          commentsCount: counts.comments.get(key) ?? 0,
          sharesCount: counts.shares.get(key) ?? 0
        });
      } catch (e) {
        console.error('Failed to broadcast share deletion:', e);
      }

      // Invalidate user's feed cache so they see updated counts on refresh
      if (this.env.CACHE) {
        try {
          await this.env.CACHE.delete(`feed:home:${userId}:20:start:all`);
        } catch { /* ignore cache errors */ }
      }

      return successResponse(null, 'Share deleted successfully');
    } catch (error) {
      console.error('Delete share error:', error);
      return errorResponse('Failed to delete share', 500);
    }
  }

  /**
   * GET /shares/mine
   * Get all shares created by the authenticated user (for their own feed)
   */
  async listMine(request, userId) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 50, 1, 100);
      const cursor = url.searchParams.get('cursor');

      let baseQuery = `
        SELECT id, created_at
        FROM shares
        WHERE actor_type = 'user' AND actor_id = ?
      `;

      const params = [userId];

      if (cursor) {
        const cursorData = parseCursor(cursor);
        if (cursorData?.created_at) {
          baseQuery += ` AND created_at < ?`;
          params.push(cursorData.created_at);
        }
      }

      baseQuery += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit + 1);

      const baseResult = await this.env.DB.prepare(baseQuery).bind(...params).all();

      const baseRows = baseResult.results || [];

      const hasMore = baseRows.length > limit;
      if (hasMore) baseRows.pop();

      // Get full share details in parallel
      const sharePromises = baseRows.map(row => this.getShareWithPost(row.id));
      const shareResults = await Promise.all(sharePromises);
      const sharesWithPosts = shareResults.filter(full => full);

      const nextCursor = hasMore && baseRows.length > 0
        ? createCursor({ created_at: baseRows[baseRows.length - 1].created_at })
        : null;

      return successResponse({
        shares: sharesWithPosts,
        pagination: { hasMore, nextCursor }
      });
    } catch (error) {
      console.error('Get my shares error:', error);
      return errorResponse('Failed to get shares', 500);
    }
  }

  /**
   * GET /posts/:id/shares
   * Get all shares of a post
   */
  async getPostShares(request, userId, postId) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');

      // Verify post exists
      const post = await this.db.getPostById(postId);
      if (!post) {
        return errorResponse('Post not found', 404);
      }

      let query = `
        SELECT s.*,
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
          END as verified
        FROM shares s
        LEFT JOIN users u ON s.actor_type = 'user' AND s.actor_id = u.id
        LEFT JOIN pages p ON s.actor_type = 'page' AND s.actor_id = p.id
        WHERE s.original_post_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
            WHERE b.blocker_type = 'user' AND b.blocker_id = ? AND b.blocked_type = s.actor_type AND b.blocked_id = s.actor_id
          )
      `;

      const params = [postId, userId];

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
      const shares = result.results || [];

      const hasMore = shares.length > limit;
      if (hasMore) shares.pop();

      const nextCursor = hasMore && shares.length > 0
        ? createCursor({ created_at: shares[shares.length - 1].created_at })
        : null;

      return successResponse({ shares, pagination: { hasMore, nextCursor } });
    } catch (error) {
      console.error('Get post shares error:', error);
      return errorResponse('Failed to get shares', 500);
    }
  }

  /**
   * POST /stories/share
   * Share post to story
   */
  async shareToStory(request, userId) {
    try {
      const body = await request.json();
      const { actorType, actorId, postId, mediaUrl } = body;

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

      // Get original post
      const post = await this.db.getPostById(postId);
      if (!post) {
        return errorResponse('Post not found', 404);
      }

      // Create story with post reference
      // Note: The schema doesn't support shared_post_id or duration fields
      // Using media_url from the post for the story
      const storyId = generateId('story');
      const timestamp = now();
      const expiresAt = timestamp + (24 * 3600); // 24 hours

      await this.env.DB.prepare(`
        INSERT INTO stories (
          id, actor_type, actor_id, media_type, media_url,
          expires_at, created_at
        ) VALUES (?, ?, ?, 'image', ?, ?, ?)
      `).bind(
        storyId,
        actorType,
        actorId,
        mediaUrl,
        expiresAt,
        timestamp
      ).run();

      // Increment post share count
      await this.db.incrementPostShares(postId, 1);

      const story = await this.env.DB.prepare(`
        SELECT * FROM stories WHERE id = ?
      `).bind(storyId).first();

      return successResponse(story, 'Post shared to story');
    } catch (error) {
      console.error('Share to story error:', error);
      return errorResponse('Failed to share to story', 500);
    }
  }

  /**
   * Helper: Get share with embedded original post
   */
  async getShareWithPost(shareId) {
    try {
      const share = await this.env.DB.prepare(`
        SELECT s.*,
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
          END as avatar_url
        FROM shares s
        LEFT JOIN users u ON s.actor_type = 'user' AND s.actor_id = u.id
        LEFT JOIN pages p ON s.actor_type = 'page' AND s.actor_id = p.id
        WHERE s.id = ?
      `).bind(shareId).first();

      if (!share) {
        return null;
      }

      // Get original post (D1 schema uses original_post_id)
      const originalPost = await this.env.DB.prepare(`
        SELECT p.*,
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
          END as avatar_url
        FROM posts p
        LEFT JOIN users u ON p.actor_type = 'user' AND p.actor_id = u.id
        LEFT JOIN pages pg ON p.actor_type = 'page' AND p.actor_id = pg.id
        WHERE p.id = ?
      `).bind(share.original_post_id).first();

      if (originalPost) {
        if (originalPost.media_urls) {
          originalPost.media_urls = JSON.parse(originalPost.media_urls);
        }
        const [withCounts] = await this.db.attachEngagementCounts([originalPost]);
        originalPost.likes_count = withCounts?.likes_count ?? originalPost.likes_count;
        originalPost.comments_count = withCounts?.comments_count ?? originalPost.comments_count;
        originalPost.shares_count = withCounts?.shares_count ?? originalPost.shares_count;
      }

      return {
        ...share,
        originalPost
      };
    } catch (error) {
      console.error('Get share with post error:', error);
      return null;
    }
  }
}
