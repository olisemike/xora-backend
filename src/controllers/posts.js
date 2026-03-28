// ============================================
// POSTS CONTROLLER
// ============================================

import { DatabaseService } from '../services/database.js';
import { FeedAlgorithmService } from '../services/feedAlgorithm.js';
import { EngagementTracker } from '../services/feedAlgorithmDecay.js';
import { ActionBroadcaster } from '../utils/actionBroadcaster.js';
import { RealTimeNotificationService } from '../services/realTimeNotifications.js';
import { PushNotificationService } from '../services/pushNotifications.js';
import { generateId, errorResponse, successResponse, extractHashtags, extractMentions, now } from '../utils/helpers.js';
import { createNotification } from '../services/notifications.js';
import { logger } from '../utils/logger.js';

export class PostsController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
    this.broadcaster = new ActionBroadcaster(env);
    this.realTimeNotifications = new RealTimeNotificationService(env);
    const primaryDb = this.db.router?.getPrimaryDb?.() || env.DB;
    this.pushService = new PushNotificationService(primaryDb, env);
    this.feedAlgo = new FeedAlgorithmService(primaryDb, env.CACHE);
    this.engagementTracker = new EngagementTracker(primaryDb);
  }

  async create(request, userId, ctx = null) {
    try {
      const body = await request.json();
      const { actorType, actorId, content, mediaType, mediaUrls, cloudflareImageIds, cloudflareVideoIds, language, isSensitive, sensitive } = body;
      const isSensitiveFlag = typeof isSensitive === 'boolean' ? isSensitive : Boolean(sensitive);

      if (!actorType || !actorId) {
        return errorResponse('Actor type and ID required', 400);
      }

      // Verify user can act as this actor
      if (actorType === 'user' && actorId !== userId) {
        return errorResponse('Cannot post as this user', 403);
      }

      if (actorType === 'page') {
        const isOwner = await this.db.isPageOwner(actorId, userId);
        if (!isOwner) {
          return errorResponse('You do not own this page', 403);
        }
      }

      if (!content && !mediaUrls) {
        return errorResponse('Post must have content or media', 400);
      }

      // Validate mediaType if provided
      if (mediaType && !['image', 'video', 'gif', 'audio', 'mixed'].includes(mediaType)) {
        return errorResponse('Invalid media type. Must be image, video, gif, audio, or mixed', 400);
      }

      const post = await this.db.createPost({
        actorType,
        actorId,
        content,
        mediaType,
        mediaUrls,
        cloudflareImageIds,
        cloudflareVideoIds,
        language: language || 'en',
        isSensitive: isSensitiveFlag
      });

      // Extract and save hashtags
      if (content) {
        const hashtags = extractHashtags(content);
        // Process hashtags (sequential due to database dependencies)
        /* eslint-disable no-await-in-loop */
        for (const tag of hashtags) {
          // Get or create hashtag
          let hashtag = await this.env.DB.prepare(`
            SELECT * FROM hashtags WHERE tag = ?
          `).bind(tag).first();

          if (hashtag) {
            await this.env.DB.prepare(`
              UPDATE hashtags SET post_count = post_count + 1 WHERE id = ?
            `).bind(hashtag.id).run();
          } else {
            const hashtagId = generateId('tag');
            await this.env.DB.prepare(`
              INSERT INTO hashtags (id, tag, post_count, created_at)
              VALUES (?, ?, 1, ?)
            `).bind(hashtagId, tag, now()).run();
            hashtag = { id: hashtagId };
          }

          // Link to post
          await this.env.DB.prepare(`
            INSERT INTO post_hashtags (id, post_id, hashtag_id, created_at)
            VALUES (?, ?, ?, ?)
          `).bind(generateId('ph'), post.id, hashtag.id, now()).run();
        }
        /* eslint-enable no-await-in-loop */
      }

      // Extract and process mentions
      if (content) {
        const mentions = extractMentions(content);
        if (mentions.length > 0) {
          // Get mentioned users
          const placeholders = mentions.map(() => '?').join(',');
          const mentionedUsers = await this.env.DB.prepare(`
            SELECT id, username FROM users WHERE username IN (${placeholders})
          `).bind(...mentions).all();

          const mentionedUserIds = mentionedUsers.results?.map(u => u.id) || [];

          // Create notifications for mentioned users in parallel (exclude self)
          const notificationPromises = mentionedUserIds
            .filter(mentionedUserId => mentionedUserId !== userId)
            .map(async (mentionedUserId) => {
              try {
                await createNotification(
                  this.env.DB,
                  mentionedUserId,
                  'mention',
                  'You were mentioned in a post',
                  actorType,
                  actorId,
                  'post',
                  post.id
                );
                // Send real-time notification
                await this.realTimeNotifications.notifyUser(mentionedUserId, {
                  title: 'Mention',
                  body: 'You were mentioned in a post',
                  data: { postId: post.id, type: 'mention' },
                  action: 'view_post'
                });

                await this.pushService.triggerNotification('mention', {
                  mentionedUserId,
                  mentionerName: actorType === 'user' ? 'Someone' : 'Page',
                  mentionerAvatar: null,
                  mentionerId: actorId,
                  postId: post.id,
                });
              } catch (error) {
                console.error('Failed to notify user:', mentionedUserId, error);
              }
            });

          await Promise.all(notificationPromises);
        }
      }

      // Initialize feed algorithm distribution (non-sensitive posts only)
      if (!isSensitiveFlag) {
        try {
          await this.feedAlgo.initializePostDistribution(
            post.id,
            actorType,
            actorId,
            language || 'en'
          );
          logger.info('Feed distribution initialized', { postId: post.id });
        } catch (error) {
          console.error('Failed to initialize distribution:', error);
          // Don't fail post creation if distribution fails
        }
      }

      // Fetch actor info to include in response
      let actor;
      if (actorType === 'user') {
        actor = await this.env.DB.prepare(`
          SELECT id, username, name, avatar_url, verified FROM users WHERE id = ?
        `).bind(actorId).first();
      } else {
        actor = await this.env.DB.prepare(`
          SELECT id, name, avatar_url, verified FROM pages WHERE id = ?
        `).bind(actorId).first();
      }

      const response = successResponse({
        ...post,
        actor_name: actor?.name || 'Unknown',
        username: actor?.username || (actorType === 'page' ? actor?.name?.toLowerCase() : 'unknown'),
        avatar_url: actor?.avatar_url || null,
        actor
      }, 'Post created successfully');

      // Broadcast post creation to followers and invalidate their feed caches
      const runSideEffects = async () => {
        if (actorType === 'user') {
          try {
            const followers = await this.env.DB.prepare(`
              SELECT follower_id FROM follows WHERE followee_type = 'user' AND followee_id = ?
            `).bind(actorId).all();
            const followerIds = followers.results?.map(f => f.follower_id) || [];

            await this.broadcaster.broadcastPostAction('created', {
              id: post.id,
              content: post.content,
              actor_id: actorId,
              actor_type: actorType,
              actor_name: actor?.name || 'Unknown',
              username: actor?.username || (actorType === 'page' ? actor?.name?.toLowerCase() : 'unknown'),
              avatar_url: actor?.avatar_url || null,
              verified: actor?.verified || 0,
              created_at: post.created_at,
              media_urls: post.media_urls
            }, followerIds);

            // Invalidate feed caches for followers so they see new post immediately
            // Process in batches to avoid overwhelming KV
            if (this.env.CACHE && followerIds.length > 0) {
              const batchSize = 50;
              // Process batches sequentially to avoid overwhelming cache
              for (let i = 0; i < Math.min(followerIds.length, 500); i += batchSize) {
                const batch = followerIds.slice(i, i + batchSize);
                // eslint-disable-next-line no-await-in-loop
                await Promise.all(batch.map(fid =>
                  this.env.CACHE.delete(`feed:home:${fid}:20:start:all`).catch(() => {})
                ));
              }
            }
          } catch (e) {
            console.error('Failed to broadcast post creation:', e);
          }
        }
      };

      // Wrap side-effects in waitUntil to prevent data loss
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(runSideEffects());
      } else {
        await runSideEffects();
      }

      return response;
    } catch (error) {
      console.error('Create post error:', error);
      return errorResponse('Failed to create post', 500);
    }
  }

  async get(request, userId, postId) {
    try {
      const url = new URL(request.url);
      const actorTypeParam = url.searchParams.get('actorType');
      const actorIdParam = url.searchParams.get('actorId');

      let resolvedActorType = 'user';
      let resolvedActorId = userId;

      if (actorTypeParam === 'page' && actorIdParam && userId) {
        const isOwner = await this.db.isPageOwner(actorIdParam, userId);
        if (isOwner) {
          resolvedActorType = 'page';
          resolvedActorId = actorIdParam;
        }
      }

      const post = await this.db.getPostById(postId);
      
      if (!post) {
        return errorResponse('Post not found', 404);
      }

      // Get actor info
      let actor;
      if (post.actor_type === 'user') {
        actor = await this.env.DB.prepare(`
          SELECT id, username, name, avatar_url, verified FROM users WHERE id = ?
        `).bind(post.actor_id).first();
      } else {
        actor = await this.env.DB.prepare(`
          SELECT id, name, avatar_url, verified FROM pages WHERE id = ?
        `).bind(post.actor_id).first();
      }

      // Check if liked/bookmarked by current actor
      let isLiked = false;
      let isBookmarked = false;

      if (userId) {
        const [liked, bookmarked] = await Promise.all([
          this.env.DB.prepare(`
            SELECT COUNT(*) as count FROM likes
            WHERE actor_type = ? AND actor_id = ?
              AND target_type = 'post' AND target_id = ?
          `).bind(resolvedActorType, resolvedActorId, postId).first(),
          
          this.env.DB.prepare(`
            SELECT COUNT(*) as count FROM bookmarks
            WHERE user_id = ? AND post_id = ?
          `).bind(userId, postId).first()
        ]);

        isLiked = (liked?.count ?? 0) > 0;
        isBookmarked = (bookmarked?.count ?? 0) > 0;
      }

      return successResponse({
        ...post,
        actor,
        isLiked,
        isBookmarked
      });
    } catch (error) {
      console.error('Get post error:', error);
      return errorResponse('Failed to get post', 500);
    }
  }

  async update(request, userId, postId) {
    try {
      const existing = await this.db.getPostById(postId);

      if (!existing) {
        return errorResponse('Post not found', 404);
      }

      // Check ownership (same rules as delete)
      if (existing.actor_type === 'user' && existing.actor_id !== userId) {
        return errorResponse('You do not own this post', 403);
      }

      if (existing.actor_type === 'page') {
        const isOwner = await this.db.isPageOwner(existing.actor_id, userId);
        if (!isOwner) {
          return errorResponse('You do not own this page', 403);
        }
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }

      const { content, mediaType, mediaUrls, language, isSensitive, sensitive } = body;
      let isSensitiveFlag;
      if (typeof isSensitive === 'boolean') {
        isSensitiveFlag = isSensitive;
      } else if (typeof sensitive === 'boolean') {
        isSensitiveFlag = sensitive;
      } else {
        isSensitiveFlag = undefined;
      }

      const updates = {};
      if (content !== undefined) updates.content = content;
      if (mediaType !== undefined) updates.mediaType = mediaType;
      if (mediaUrls !== undefined) updates.mediaUrls = mediaUrls;
      if (language !== undefined) updates.language = language;
      if (isSensitiveFlag !== undefined) updates.isSensitive = isSensitiveFlag;

      // updatePost() now reads directly from primary DB after write (not multi-DB routing)
      const updatedPost = await this.db.updatePost(postId, updates);

      if (!updatedPost) {
        return errorResponse('Post not found after update', 404);
      }

      // Get actor info
      let actor;
      if (updatedPost.actor_type === 'user') {
        actor = await this.env.DB.prepare(`
          SELECT id, username, name, avatar_url, verified FROM users WHERE id = ?
        `).bind(updatedPost.actor_id).first();
      } else {
        actor = await this.env.DB.prepare(`
          SELECT id, name, avatar_url, verified FROM pages WHERE id = ?
        `).bind(updatedPost.actor_id).first();
      }

      // Check if liked/bookmarked by current user
      let isLiked = false;
      let isBookmarked = false;

      const url = new URL(request.url);
      const actorTypeParam = url.searchParams.get('actorType');
      const actorIdParam = url.searchParams.get('actorId');

      let resolvedActorType = 'user';
      let resolvedActorId = userId;

      if (actorTypeParam === 'page' && actorIdParam && userId) {
        const isOwner = await this.db.isPageOwner(actorIdParam, userId);
        if (isOwner) {
          resolvedActorType = 'page';
          resolvedActorId = actorIdParam;
        }
      }

      if (userId) {
        const [liked, bookmarked] = await Promise.all([
          this.env.DB.prepare(`
            SELECT COUNT(*) as count FROM likes
            WHERE actor_type = ? AND actor_id = ?
              AND target_type = 'post' AND target_id = ?
          `).bind(resolvedActorType, resolvedActorId, postId).first(),
          
          this.env.DB.prepare(`
            SELECT COUNT(*) as count FROM bookmarks
            WHERE user_id = ? AND post_id = ?
          `).bind(userId, postId).first()
        ]);

        isLiked = (liked?.count ?? 0) > 0;
        isBookmarked = (bookmarked?.count ?? 0) > 0;
      }

      return successResponse({
        ...updatedPost,
        actor,
        isLiked,
        isBookmarked
      });
    } catch (error) {
      console.error('Update post error:', error);
      return errorResponse('Failed to update post', 500);
    }
  }

  /**
   * Extract and delete videos from media_urls array
   */
  async deletePostVideosCleanup(mediaUrls, cleaner) {
    if (!mediaUrls) return;

    try {
      const mediaArray = typeof mediaUrls === 'string' 
        ? JSON.parse(mediaUrls) 
        : mediaUrls;
      
      if (!Array.isArray(mediaArray)) return;

      // Extract video IDs: support both cloudflareId (old) and videoId (new) fields
      const videoIds = mediaArray
        .filter(m => m.type === 'video' && (m.cloudflareId || m.videoId))
        .map(m => m.cloudflareId || m.videoId);
      
      if (videoIds.length > 0) {
        await cleaner.deleteVideos(videoIds);
      }
    } catch (parseErr) {
      console.warn('Could not parse video IDs from media_urls');
    }
  }

  async delete(request, userId, postId, ctx = null) {
    try {
      const post = await this.db.getPostById(postId);

      if (!post) {
        return errorResponse('Post not found', 404);
      }

      // Check ownership
      if (post.actor_type === 'user' && post.actor_id !== userId) {
        return errorResponse('You do not own this post', 403);
      }

      if (post.actor_type === 'page') {
        const isOwner = await this.db.isPageOwner(post.actor_id, userId);
        if (!isOwner) {
          return errorResponse('You do not own this page', 403);
        }
      }

      // Clean up Cloudflare media before deleting post
      try {
        const { CloudflareMediaCleaner } = await import('../utils/cloudflare-media.js');
        const cleaner = new CloudflareMediaCleaner(this.env);
        
        // Delete images
        if (post.cloudflare_image_ids) {
          await cleaner.deleteImages(post.cloudflare_image_ids);
        }
        
        // Delete videos from dedicated cloudflare_video_ids column
        if (post.cloudflare_video_ids) {
          const videoIds = cleaner.safeParseJson(post.cloudflare_video_ids);
          for (const videoId of videoIds) {
            if (videoId) {
              await cleaner.deleteVideo(videoId);
            }
          }
        } else {
          // Fallback: extract from media_urls for backwards compatibility
          await this.deletePostVideosCleanup(post.media_urls, cleaner);
        }
      } catch (cleanupError) {
        console.error('Cloudflare cleanup error for post deletion:', cleanupError);
        // Don't fail the deletion if cleanup fails
      }

      await this.db.deletePost(postId);

      // Broadcast post deletion to followers and all connected clients
      const runSideEffects = async () => {
        try {
          // Get followers to notify
          const followers = await this.env.DB.prepare(`
            SELECT follower_id FROM follows WHERE followee_type = ? AND followee_id = ?
          `).bind(post.actor_type, post.actor_id).all();
          const followerIds = followers.results?.map(f => f.follower_id) || [];

          // Broadcast to followers
          await this.broadcaster.broadcastPostAction('deleted', {
            id: postId,
            actor_id: post.actor_id,
            actor_type: post.actor_type
          }, followerIds);

          // Also broadcast globally to update feeds in real-time
          await this.broadcaster.broadcastEngagementUpdate(postId, 'deleted', {
            likesCount: 0,
            commentsCount: 0,
            sharesCount: 0
          });
        } catch (e) {
          console.error('Failed to broadcast post deletion:', e);
        }
      };

      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(runSideEffects());
      } else {
        await runSideEffects();
      }

      return successResponse(null, 'Post deleted successfully');
    } catch (error) {
      console.error('Delete post error:', error);
      return errorResponse('Failed to delete post', 500);
    }
  }
}
