// Comments, Likes, Bookmarks, Follows, Blocks Controllers
import { DatabaseService } from '../services/database.js';
import { EngagementTracker } from '../services/feedAlgorithmDecay.js';
import { ActionBroadcaster } from '../utils/actionBroadcaster.js';
import { RealTimeNotificationService } from '../services/realTimeNotifications.js';
import { PushNotificationService } from '../services/pushNotifications.js';
import { generateId, errorResponse, successResponse, sanitizeText, now, parseCursor, createCursor, safeParseInt, extractMentions } from '../utils/helpers.js';
import { createNotification } from '../services/notifications.js';

export class CommentsController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
    this.broadcaster = new ActionBroadcaster(env);
    this.realTimeNotifications = new RealTimeNotificationService(env);
    const primaryDb = this.db.router?.getPrimaryDb?.() || env.DB;
    this.pushService = new PushNotificationService(primaryDb, env);
  }

  async list(request, userId, postId) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');

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
        WHERE c.post_id = ? AND c.parent_id IS NULL
      `;

      const params = [postId];

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

      // Parse media_urls JSON
      const processedComments = comments.map(comment => {
        const processedComment = { ...comment };
        if (processedComment.media_urls) {
          processedComment.media_urls = JSON.parse(processedComment.media_urls);
        }
        return processedComment;
      });

      return successResponse({ comments: processedComments, pagination: { hasMore, nextCursor } });
    } catch (error) {
      console.error('List comments error:', error);
      return errorResponse('Failed to get comments', 500);
    }
  }

  async create(request, userId, postId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { actorType, actorId, content, parentId, mediaUrls, cloudflareImageIds, cloudflareVideoIds } = body;
      const resolvedActorType = actorType || 'user';
      const resolvedActorId = actorId || (resolvedActorType === 'user' ? userId : null);

      if (!content && !mediaUrls) {
        return errorResponse('Comment must have content or media', 400);
      }

      // Validate actorType
      if (!resolvedActorType || !['user', 'page'].includes(resolvedActorType)) {
        return errorResponse('Actor type must be "user" or "page"', 400);
      }

      if (resolvedActorType === 'user' && resolvedActorId !== userId) {
        return errorResponse('Cannot comment as this user', 403);
      }

      if (resolvedActorType === 'page') {
        if (!resolvedActorId) {
          return errorResponse('Page ID required to comment as a page', 400);
        }
        const isOwner = await this.db.isPageOwner(resolvedActorId, userId);
        if (!isOwner) {
          return errorResponse('You do not own this page', 403);
        }
      }

      // Get post to check owner and enforce comment settings
      const post = await this.env.DB.prepare(`
        SELECT actor_type, actor_id FROM posts WHERE id = ?
      `).bind(postId).first();

      if (!post) {
        return errorResponse('Post not found', 404);
      }

      // Check if commenter is blocked by post owner
      const blocked = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM blocks
        WHERE (blocker_type = ? AND blocker_id = ? AND blocked_type = ? AND blocked_id = ?)
           OR (blocker_type = ? AND blocker_id = ? AND blocked_type = ? AND blocked_id = ?)
      `).bind(post.actor_type, post.actor_id, resolvedActorType, resolvedActorId, resolvedActorType, resolvedActorId, post.actor_type, post.actor_id).first();

      if ((blocked?.count ?? 0) > 0) {
        return errorResponse('Cannot comment on this post', 403);
      }

      // Enforce who_can_comment setting (only for user posts, not pages)
      if (post.actor_type === 'user') {
        const settings = await this.env.DB.prepare(`
          SELECT who_can_comment FROM user_settings WHERE user_id = ?
        `).bind(post.actor_id).first();

        if (settings && settings.who_can_comment) {
          // Check permission based on setting
          if (settings.who_can_comment === 'none') {
            // Only post owner can comment
            if (resolvedActorType !== 'user' || resolvedActorId !== post.actor_id) {
              return errorResponse('Comments are disabled on this post', 403);
            }
          } else if (settings.who_can_comment === 'followers') {
            // Only followers can comment (or post owner)
            if (resolvedActorType === 'user' && resolvedActorId !== post.actor_id) {
              const isFollower = await this.env.DB.prepare(`
                SELECT COUNT(*) as count FROM follows
                WHERE follower_type = 'user' AND follower_id = ?
                  AND followee_type = 'user' AND followee_id = ?
              `).bind(resolvedActorId, post.actor_id).first();

              if ((isFollower?.count ?? 0) === 0) {
                return errorResponse('Only followers can comment on this post', 403);
              }
            } else if (resolvedActorType === 'page') {
              // Pages cannot comment on follower-only posts unless they own it
              return errorResponse('Only followers can comment on this post', 403);
            }
          }
          // 'everyone' - no restriction
        }
      }

      const commentId = generateId('cmt');
      const timestamp = now();

      await this.env.DB.prepare(`
        INSERT INTO comments (id, post_id, actor_type, actor_id, content, parent_id, media_urls, cloudflare_image_ids, cloudflare_video_ids, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(commentId, postId, resolvedActorType, resolvedActorId, content ? sanitizeText(content, 500) : '', parentId || null, mediaUrls ? JSON.stringify(mediaUrls) : null, cloudflareImageIds ? JSON.stringify(cloudflareImageIds) : null, cloudflareVideoIds ? JSON.stringify(cloudflareVideoIds) : null, timestamp, timestamp).run();

      // Increment post comment count
      await this.db.incrementPostComments(postId, 1);

      // If reply, increment parent replies count
      if (parentId) {
        await this.env.DB.prepare(`
          UPDATE comments SET replies_count = replies_count + 1 WHERE id = ?
        `).bind(parentId).run();
      }

      // Extract and process mentions in comment content
      if (content) {
        const mentions = extractMentions(content);
        if (mentions.length > 0) {
          // Get mentioned users
          const placeholders = mentions.map(() => '?').join(',');
          const mentionedUsers = await this.env.DB.prepare(`
            SELECT id, username FROM users WHERE username IN (${placeholders})
          `).bind(...mentions).all();

          const mentionedUserIds = mentionedUsers.results?.map(u => u.id) || [];

          // Create notifications for mentioned users (exclude self)
          const notificationPromises = mentionedUserIds
            .filter(mentionedUserId => mentionedUserId !== userId)
            .map(async (mentionedUserId) => {
              await createNotification(
                this.env.DB,
                mentionedUserId,
                'mention',
                'mentioned you in a comment',
                resolvedActorType,
                resolvedActorId,
                'comment',
                commentId
              );
              // Send real-time notification
              await this.realTimeNotifications.notifyUser(mentionedUserId, {
                title: 'Mention',
                body: 'You were mentioned in a comment',
                data: { commentId, postId, type: 'mention' },
                action: 'view_comment'
              });
            });

          await Promise.all(notificationPromises);
        }
      }

      // Create notification for the post owner when someone else comments
      try {
        // Reuse post object already fetched above (line 102)
        if (post && post.actor_type === 'user' && post.actor_id && post.actor_id !== resolvedActorId) {
          await createNotification(
            this.env.DB,
            post.actor_id,
            'comment',
            'commented on your post',
            resolvedActorType,
            resolvedActorId,
            'post',
            postId
          );
        }
      } catch (notifyError) {
        console.error('Failed to create comment notification:', notifyError);
      }

      // Broadcast engagement update to ALL connected clients for real-time feed updates
      try {
        const counts = await this.db.getPostEngagementCounts([postId]);
        const key = String(postId);
        await this.broadcaster.broadcastEngagementUpdate(postId, 'comment', {
          likesCount: counts.likes.get(key) ?? 0,
          commentsCount: counts.comments.get(key) ?? 0,
          sharesCount: counts.shares.get(key) ?? 0
        });
      } catch (e) {
        console.error('Failed to broadcast comment engagement:', e);
      }

      // Invalidate commenter's feed cache so they see updated counts on refresh
      if (this.env.CACHE && resolvedActorType === 'user') {
        try {
          await this.env.CACHE.delete(`feed:home:${resolvedActorId}:20:start:all`);
        } catch { /* ignore cache errors */ }
      }

      // Fetch comment with actor info for proper display on mobile
      const comment = await this.env.DB.prepare(`
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
        WHERE c.id = ?
      `).bind(commentId).first();

      // Parse media_urls if present
      if (comment && comment.media_urls) {
        comment.media_urls = JSON.parse(comment.media_urls);
      }

      // Send background push for post owner comment notification
      try {
        if (post && post.actor_type === 'user' && post.actor_id && post.actor_id !== resolvedActorId) {
          await this.pushService.triggerNotification('comment', {
            postOwnerId: post.actor_id,
            commenterName: comment?.name || comment?.username || 'Someone',
            commenterAvatar: comment?.avatar_url || null,
            commenterId: resolvedActorId,
            postId,
            commentId,
            commentText: sanitizeText(content || 'commented on your post', 160),
          });
        }
      } catch (pushError) {
        console.error('Failed to send comment push notification:', pushError);
      }

      return successResponse(comment, 'Comment added');
    } catch (error) {
      console.error('Create comment error:', error);
      return errorResponse('Failed to create comment', 500);
    }
  }

  async delete(request, userId, commentId) {
    try {
      const comment = await this.env.DB.prepare(`SELECT * FROM comments WHERE id = ?`).bind(commentId).first();
      
      if (!comment) {
        return errorResponse('Comment not found', 404);
      }

      if (comment.actor_type === 'user' && comment.actor_id !== userId) {
        return errorResponse('You do not own this comment', 403);
      }

      if (comment.actor_type === 'page') {
        const isOwner = await this.db.isPageOwner(comment.actor_id, userId);
        if (!isOwner) {
          return errorResponse('You do not own this page', 403);
        }
      }

      // Clean up Cloudflare media before deleting comment
      try {
        const { CloudflareMediaCleaner } = await import('../utils/cloudflare-media.js');
        const cleaner = new CloudflareMediaCleaner(this.env);
        
        // Delete images
        if (comment.cloudflare_image_ids) {
          await cleaner.deleteImages(comment.cloudflare_image_ids);
        }
        
        // Delete videos
        if (comment.cloudflare_video_ids) {
          const videoIds = cleaner.safeParseJson(comment.cloudflare_video_ids);
          for (const videoId of videoIds) {
            if (videoId) {
              await cleaner.deleteVideo(videoId);
            }
          }
        }
      } catch (cleanupError) {
        console.error('Cloudflare cleanup error for comment deletion:', cleanupError);
        // Don't fail the deletion if cleanup fails
      }

      await this.env.DB.prepare(`DELETE FROM comments WHERE id = ?`).bind(commentId).run();

      // Decrement post comment count
      await this.db.incrementPostComments(comment.post_id, -1);

      // Broadcast engagement update to ALL connected clients for real-time feed updates
      try {
        const counts = await this.db.getPostEngagementCounts([comment.post_id]);
        const key = String(comment.post_id);
        await this.broadcaster.broadcastEngagementUpdate(comment.post_id, 'comment_deleted', {
          likesCount: counts.likes.get(key) ?? 0,
          commentsCount: counts.comments.get(key) ?? 0,
          sharesCount: counts.shares.get(key) ?? 0
        });
      } catch (e) {
        console.error('Failed to broadcast comment deletion:', e);
      }

      // Invalidate user's feed cache so they see updated counts on refresh
      if (this.env.CACHE) {
        try {
          await this.env.CACHE.delete(`feed:home:${userId}:20:start:all`);
        } catch { /* ignore cache errors */ }
      }

      return successResponse(null, 'Comment deleted');
    } catch (error) {
      console.error('Delete comment error:', error);
      return errorResponse('Failed to delete comment', 500);
    }
  }
}

export class LikesController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
    this.broadcaster = new ActionBroadcaster(env);
    const primaryDb = this.db.router?.getPrimaryDb?.() || env.DB;
    this.engagementTracker = new EngagementTracker(primaryDb);
    this.pushService = new PushNotificationService(primaryDb, env);
  }

  async likePost(request, userId, postId) {
    try {
      let body = {};
      try {
        body = await request.json();
      } catch {
        body = {};
      }
      const { actorType, actorId } = body;
      const resolvedActorType = actorType || 'user';
      const resolvedActorId = actorId || (resolvedActorType === 'user' ? userId : null);

      if (!['user', 'page'].includes(resolvedActorType)) {
        return errorResponse('Actor type must be "user" or "page"', 400);
      }

      if (resolvedActorType === 'user' && resolvedActorId !== userId) {
        return errorResponse('Cannot like as this user', 403);
      }

      if (resolvedActorType === 'page') {
        if (!resolvedActorId) {
          return errorResponse('Page ID required to like as a page', 400);
        }
        const isOwner = await this.db.isPageOwner(resolvedActorId, userId);
        if (!isOwner) {
          return errorResponse('You do not own this page', 403);
        }
      }

      const existing = await this.env.DB.prepare(`
        SELECT * FROM likes WHERE actor_type = ? AND actor_id = ? AND target_type = 'post' AND target_id = ?
      `).bind(resolvedActorType, resolvedActorId, postId).first();

      if (existing) {
        return successResponse(null, 'Already liked');
      }

      await this.env.DB.prepare(`
        INSERT INTO likes (id, actor_type, actor_id, target_type, target_id, created_at)
        VALUES (?, ?, ?, 'post', ?, ?)
      `).bind(generateId('like'), resolvedActorType, resolvedActorId, postId, now()).run();

      await this.db.incrementPostLikes(postId, 1);

      // Track engagement for feed algorithm
      if (resolvedActorType === 'user') {
        try {
          await this.engagementTracker.recordEngagement(postId, resolvedActorId, 'like');
        } catch (error) {
          console.error('Failed to track engagement:', error);
        }

        // Get post with updated counts for broadcasts
        const post = await this.env.DB.prepare(`
          SELECT actor_type, actor_id FROM posts WHERE id = ?
        `).bind(postId).first();

        const counts = await this.db.getPostEngagementCounts([postId]);
        const key = String(postId);

        // Broadcast like action to post owner
        try {
          if (post) {
            await this.broadcaster.broadcastLikeAction('liked', {
              id: generateId('like'),
              postId,
              userId: resolvedActorId,
              actorType: resolvedActorType,
              actorId: resolvedActorId
            }, post.actor_id);

            // Broadcast engagement update to ALL connected clients for real-time feed updates
            await this.broadcaster.broadcastEngagementUpdate(postId, 'like', {
              likesCount: counts.likes.get(key) ?? 0,
              commentsCount: counts.comments.get(key) ?? 0,
              sharesCount: counts.shares.get(key) ?? 0
            });
          }
        } catch (e) {
          console.error('Failed to broadcast like:', e);
        }

        // Create persistent notification and send real-time notification to post author
        try {

          if (post && post.actor_type === 'user' && post.actor_id && post.actor_id !== resolvedActorId) {
            // Create persistent notification in database
            await createNotification(
              this.env.DB,
              post.actor_id,
              'like',
              'liked your post',
              resolvedActorType,
              resolvedActorId,
              'post',
              postId
            );

            // Send real-time notification via WebSocket (sharded for scale)
            const liker = await this.env.DB.prepare(`
              SELECT name, avatar_url FROM users WHERE id = ?
            `).bind(resolvedActorId).first();

            if (liker && this.env.NOTIFICATION_HUB) {
              // Use sharded NotificationHub for scale to 100k+ users
              const postOwnerId = post.actor_id;
              const ownerIdHash = Array.from(postOwnerId).reduce((h, c) => ((h << 5) - h) + c.charCodeAt(0), 0);
              const shardId = Math.abs(ownerIdHash) % 16; // 16 shards
              const hubId = this.env.NOTIFICATION_HUB.idFromName(`notify-${shardId}`);
              const hub = this.env.NOTIFICATION_HUB.get(hubId);

              await hub.fetch('http://internal/notify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  userId: post.actor_id,
                  notification: {
                    title: '👍 New Like',
                    body: `${liker.name} liked your post`,
                    action: 'like',
                    data: {
                      postId,
                      likerId: resolvedActorId,
                      likerName: liker.name,
                      type: 'like'
                    }
                  }
                })
              }).catch(err => console.error('Failed to send like notification:', err));

              // Send background push notification
              await this.pushService.triggerNotification('like', {
                postOwnerId: post.actor_id,
                likerName: liker.name || 'Someone',
                likerAvatar: liker.avatar_url || null,
                likerId: resolvedActorId,
                postId,
              });
            }
          }
        } catch (error) {
          console.error('Failed to create like notification:', error);
        }

        // Invalidate liker's feed cache so they see updated counts on refresh
        if (this.env.CACHE) {
          try {
            await this.env.CACHE.delete(`feed:home:${resolvedActorId}:20:start:all`);
          } catch { /* ignore cache errors */ }
        }
      }

      return successResponse(null, 'Post liked');
    } catch (error) {
      console.error('Like post error:', error);
      return errorResponse('Failed to like post', 500);
    }
  }

  async unlikePost(request, userId, postId) {
    try {
      let body = {};
      try {
        body = await request.json();
      } catch {
        body = {};
      }
      const { actorType, actorId } = body;
      const resolvedActorType = actorType || 'user';
      const resolvedActorId = actorId || (resolvedActorType === 'user' ? userId : null);

      if (!['user', 'page'].includes(resolvedActorType)) {
        return errorResponse('Actor type must be "user" or "page"', 400);
      }

      if (resolvedActorType === 'user' && resolvedActorId !== userId) {
        return errorResponse('Cannot unlike as this user', 403);
      }

      if (resolvedActorType === 'page') {
        if (!resolvedActorId) {
          return errorResponse('Page ID required to unlike as a page', 400);
        }
        const isOwner = await this.db.isPageOwner(resolvedActorId, userId);
        if (!isOwner) {
          return errorResponse('You do not own this page', 403);
        }
      }

      const deleted = await this.env.DB.prepare(`
        DELETE FROM likes WHERE actor_type = ? AND actor_id = ? AND target_type = 'post' AND target_id = ?
      `).bind(resolvedActorType, resolvedActorId, postId).run();

      if (deleted.changes === 0) {
        return successResponse(null, 'Not liked');
      }

      await this.db.incrementPostLikes(postId, -1);

      // Get post with updated counts for broadcasts
      const post = await this.env.DB.prepare(`
        SELECT actor_id FROM posts WHERE id = ?
      `).bind(postId).first();

      const counts = await this.db.getPostEngagementCounts([postId]);
      const key = String(postId);

      // Broadcast unlike action (async)
      try {
        if (post) {
          await this.broadcaster.broadcastLikeAction('unliked', {
            id: generateId('like'),
            postId,
            userId: resolvedActorId,
            actorType: resolvedActorType,
            actorId: resolvedActorId
          }, post.actor_id);

          // Broadcast engagement update to ALL connected clients for real-time feed updates
          await this.broadcaster.broadcastEngagementUpdate(postId, 'unlike', {
            likesCount: counts.likes.get(key) ?? 0,
            commentsCount: counts.comments.get(key) ?? 0,
            sharesCount: counts.shares.get(key) ?? 0
          });
        }
      } catch (e) {
        console.error('Failed to broadcast unlike:', e);
      }

      // Invalidate user's feed cache so they see updated counts on refresh
      if (this.env.CACHE && resolvedActorType === 'user') {
        try {
          await this.env.CACHE.delete(`feed:home:${resolvedActorId}:20:start:all`);
        } catch { /* ignore cache errors */ }
      }

      return successResponse(null, 'Post unliked');
    } catch (error) {
      console.error('Unlike post error:', error);
      return errorResponse('Failed to unlike post', 500);
    }
  }
}

export class BookmarksController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
  }

  async add(request, userId, postId) {
    try {
      const existing = await this.env.DB.prepare(`
        SELECT * FROM bookmarks WHERE user_id = ? AND post_id = ?
      `).bind(userId, postId).first();

      if (existing) {
        return errorResponse('Already bookmarked', 400);
      }

      await this.env.DB.prepare(`
        INSERT INTO bookmarks (id, user_id, post_id, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(generateId('bm'), userId, postId, now()).run();

      await this.db.incrementPostBookmarks(postId, 1);

      // Notify post owner when someone bookmarks their post
      try {
        const post = await this.env.DB.prepare(`
          SELECT actor_type, actor_id
          FROM posts
          WHERE id = ?
        `).bind(postId).first();

        if (post && post.actor_type === 'user' && post.actor_id && post.actor_id !== userId) {
          await createNotification(
            this.env.DB,
            post.actor_id,
            'bookmark',
            'bookmarked your post',
            'user',
            userId,
            'post',
            postId
          );
        }
      } catch (notifyError) {
        console.error('Failed to create bookmark notification:', notifyError);
      }

      return successResponse(null, 'Post bookmarked');
    } catch (error) {
      console.error('Bookmark error:', error);
      return errorResponse('Failed to bookmark', 500);
    }
  }

  async remove(request, userId, postId) {
    try {
      const deleted = await this.env.DB.prepare(`
        DELETE FROM bookmarks WHERE user_id = ? AND post_id = ?
      `).bind(userId, postId).run();

      if (deleted.changes === 0) {
        return errorResponse('Not bookmarked', 400);
      }

      await this.db.incrementPostBookmarks(postId, -1);

      return successResponse(null, 'Bookmark removed');
    } catch (error) {
      console.error('Remove bookmark error:', error);
      return errorResponse('Failed to remove bookmark', 500);
    }
  }

  async list(request, userId) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');

      let query = `
        SELECT p.*, b.created_at as bookmarked_at,
          CASE WHEN s.id IS NOT NULL THEN s.original_post_id ELSE p.id END as postId,
          CASE WHEN p.actor_type = 'user' THEN u.username ELSE pg.name END as username,
          CASE WHEN p.actor_type = 'user' THEN u.name ELSE pg.name END as actor_name,
          CASE WHEN p.actor_type = 'user' THEN u.avatar_url ELSE pg.avatar_url END as avatar_url,
          CASE WHEN p.actor_type = 'user' THEN u.verified ELSE pg.verified END as verified
        FROM bookmarks b
        JOIN posts p ON b.post_id = p.id
        LEFT JOIN shares s ON p.id = s.id
        LEFT JOIN users u ON p.actor_type = 'user' AND p.actor_id = u.id
        LEFT JOIN pages pg ON p.actor_type = 'page' AND p.actor_id = pg.id
        WHERE b.user_id = ?
      `;

      const params = [userId];

      if (cursor) {
        const cursorData = parseCursor(cursor);
        if (cursorData?.created_at) {
          query += ` AND b.created_at < ?`;
          params.push(cursorData.created_at);
        }
      }

      query += ` ORDER BY b.created_at DESC LIMIT ?`;
      params.push(limit + 1);

      const result = await this.env.DB.prepare(query).bind(...params).all();
      const bookmarks = result.results || [];

      const hasMore = bookmarks.length > limit;
      if (hasMore) bookmarks.pop();

      const nextCursor = hasMore && bookmarks.length > 0
        ? createCursor({ created_at: bookmarks[bookmarks.length - 1].bookmarked_at })
        : null;

      const processedBookmarks = bookmarks.map(post => {
        const processedPost = { ...post };
        if (processedPost.media_urls) processedPost.media_urls = JSON.parse(processedPost.media_urls);
        return processedPost;
      });

      return successResponse({ bookmarks: processedBookmarks, pagination: { hasMore, nextCursor } });
    } catch (error) {
      console.error('List bookmarks error:', error);
      return errorResponse('Failed to get bookmarks', 500);
    }
  }
}

export class FollowsController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
    const primaryDb = this.db.router?.getPrimaryDb?.() || env.DB;
    this.pushService = new PushNotificationService(primaryDb, env);
  }

  async follow(request, userId) {
    try {
      const body = await request.json();
      const { followerType, followerId, followeeType, followeeId, targetType, targetId } = body;

      // Support both old format (followerType/followerId/followeeType/followeeId)
      // and new format (targetType/targetId)
      const actualFolloweeType = followeeType || targetType;
      const actualFolloweeId = followeeId || targetId;
      const actualFollowerType = followerType || 'user';
      const actualFollowerId = followerId || userId;

      if (actualFollowerType === 'user' && actualFollowerId !== userId) {
        return errorResponse('Cannot follow as this user', 403);
      }

      if (!actualFolloweeType || !actualFolloweeId) {
        return errorResponse('Target type and ID required', 400);
      }

      const existing = await this.env.DB.prepare(`
        SELECT * FROM follows
        WHERE follower_type = ? AND follower_id = ? AND followee_type = ? AND followee_id = ?
      `).bind(actualFollowerType, actualFollowerId, actualFolloweeType, actualFolloweeId).first();

      if (existing) {
        return errorResponse('Already following', 400);
      }

      await this.env.DB.prepare(`
        INSERT INTO follows (id, follower_type, follower_id, followee_type, followee_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(generateId('follow'), actualFollowerType, actualFollowerId, actualFolloweeType, actualFolloweeId, now()).run();

      // Invalidate follow cache for feed optimization
      if (this.env.CACHE && actualFollowerType === 'user') {
        try {
          await this.env.CACHE.delete(`follows:${actualFollowerId}`);
        } catch { /* ignore cache errors */ }
      }

      // Notify followed user when someone starts following them
      try {
        if (actualFolloweeType === 'user' && actualFolloweeId && actualFolloweeId !== actualFollowerId) {
          await createNotification(
            this.env.DB,
            actualFolloweeId,
            'follow',
            'started following you',
            actualFollowerType,
            actualFollowerId,
            'user',
            actualFollowerId
          );

          // Send real-time notification
          try {
            const follower = await this.env.DB.prepare(`
              SELECT name, username, avatar_url FROM users WHERE id = ?
            `).bind(actualFollowerId).first();

            if (follower && this.env.NOTIFICATION_HUB) {
              // Route to sharded hub based on followee ID
              let hash = 0;
              for (let i = 0; i < actualFolloweeId.length; i += 1) {
                hash = ((hash << 5) - hash) + actualFolloweeId.charCodeAt(i);
                hash |= 0;
              }
              const shard = Math.abs(hash) % 16;
              const hubId = this.env.NOTIFICATION_HUB.idFromName(`notify-${shard}`);
              const hub = this.env.NOTIFICATION_HUB.get(hubId);
              
              await hub.fetch('http://internal/notify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  userId: actualFolloweeId,
                  notification: {
                    title: '👤 New Follower',
                    body: `${follower.name} started following you`,
                    action: 'follow',
                    data: {
                      followerId: actualFollowerId,
                      followerName: follower.name,
                      type: 'follow'
                    }
                  }
                })
              }).catch(err => console.error('Failed to send follow notification:', err));

              // Send background push notification
              await this.pushService.triggerNotification('follow', {
                followedUserId: actualFolloweeId,
                followerId: actualFollowerId,
                followerName: follower.name || 'Someone',
                followerUsername: follower.username || null,
                followerAvatar: follower.avatar_url || null,
              });
            }
          } catch (rtError) {
            console.error('Failed to send real-time follow notification:', rtError);
          }
        }
      } catch (notifyError) {
        console.error('Failed to create follow notification:', notifyError);
      }

      return successResponse(null, 'Now following');
    } catch (error) {
      console.error('Follow error:', error);
      return errorResponse('Failed to follow', 500);
    }
  }

  async unfollow(request, userId) {
    try {
      const body = await request.json();
      const { followerType, followerId, followeeType, followeeId, targetType, targetId } = body;

      // Support both old format and new format
      const actualFolloweeType = followeeType || targetType;
      const actualFolloweeId = followeeId || targetId;
      const actualFollowerType = followerType || 'user';
      const actualFollowerId = followerId || userId;

      if (actualFollowerType === 'user' && actualFollowerId !== userId) {
        return errorResponse('Cannot unfollow as this user', 403);
      }

      if (!actualFolloweeType || !actualFolloweeId) {
        return errorResponse('Target type and ID required', 400);
      }

      const deleted = await this.env.DB.prepare(`
        DELETE FROM follows
        WHERE follower_type = ? AND follower_id = ? AND followee_type = ? AND followee_id = ?
      `).bind(actualFollowerType, actualFollowerId, actualFolloweeType, actualFolloweeId).run();

      if (deleted.changes === 0) {
        return errorResponse('Not following', 400);
      }

      // Invalidate follow cache for feed optimization
      if (this.env.CACHE && actualFollowerType === 'user') {
        try {
          await this.env.CACHE.delete(`follows:${actualFollowerId}`);
        } catch { /* ignore cache errors */ }
      }

      return successResponse(null, 'Unfollowed');
    } catch (error) {
      console.error('Unfollow error:', error);
      return errorResponse('Failed to unfollow', 500);
    }
  }
}

export class BlocksController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
  }

  async block(request, userId) {
    try {
      const body = await request.json();
      const { blockerType, blockerId, blockedType, blockedId, type, id } = body;

      // Support both formats
      const actualBlockedType = blockedType || type;
      const actualBlockedId = blockedId || id;
      const actualBlockerType = blockerType || 'user';
      const actualBlockerId = blockerId || userId;

      if (!actualBlockedType || !actualBlockedId) {
        return errorResponse('Blocked entity type and ID required', 400);
      }

      if (actualBlockerType === 'user' && actualBlockerId !== userId) {
        return errorResponse('Cannot block as this user', 403);
      }

      const existing = await this.env.DB.prepare(`
        SELECT * FROM blocks
        WHERE blocker_type = ? AND blocker_id = ? AND blocked_type = ? AND blocked_id = ?
      `).bind(actualBlockerType, actualBlockerId, actualBlockedType, actualBlockedId).first();

      if (existing) {
        return errorResponse('Already blocked', 400);
      }

      await this.env.DB.prepare(`
        INSERT INTO blocks (id, blocker_type, blocker_id, blocked_type, blocked_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(generateId('block'), actualBlockerType, actualBlockerId, actualBlockedType, actualBlockedId, now()).run();

      // Remove follow if exists
      await this.env.DB.prepare(`
        DELETE FROM follows
        WHERE (follower_type = ? AND follower_id = ? AND followee_type = ? AND followee_id = ?)
           OR (follower_type = ? AND follower_id = ? AND followee_type = ? AND followee_id = ?)
      `).bind(
        actualBlockerType, actualBlockerId, actualBlockedType, actualBlockedId,
        actualBlockedType, actualBlockedId, actualBlockerType, actualBlockerId
      ).run();

      // Invalidate block and follow caches for feed optimization
      if (this.env.CACHE && actualBlockerType === 'user') {
        try {
          await Promise.all([
            this.env.CACHE.delete(`blocks:${actualBlockerId}`),
            this.env.CACHE.delete(`follows:${actualBlockerId}`)
          ]);
        } catch { /* ignore cache errors */ }
      }

      return successResponse(null, 'Blocked');
    } catch (error) {
      console.error('Block error:', error);
      return errorResponse('Failed to block', 500);
    }
  }

  async unblock(request, userId) {
    try {
      const body = await request.json();
      const { blockerType, blockerId, blockedType, blockedId, type, id } = body;

      // Support both formats
      const actualBlockedType = blockedType || type;
      const actualBlockedId = blockedId || id;
      const actualBlockerType = blockerType || 'user';
      const actualBlockerId = blockerId || userId;

      if (!actualBlockedType || !actualBlockedId) {
        return errorResponse('Blocked entity type and ID required', 400);
      }

      if (actualBlockerType === 'user' && actualBlockerId !== userId) {
        return errorResponse('Cannot unblock as this user', 403);
      }

      const deleted = await this.env.DB.prepare(`
        DELETE FROM blocks
        WHERE blocker_type = ? AND blocker_id = ? AND blocked_type = ? AND blocked_id = ?
      `).bind(actualBlockerType, actualBlockerId, actualBlockedType, actualBlockedId).run();

      if (deleted.changes === 0) {
        return errorResponse('Not blocked', 400);
      }

      // Invalidate block cache for feed optimization
      if (this.env.CACHE && actualBlockerType === 'user') {
        try {
          await this.env.CACHE.delete(`blocks:${actualBlockerId}`);
        } catch { /* ignore cache errors */ }
      }

      return successResponse(null, 'Unblocked');
    } catch (error) {
      console.error('Unblock error:', error);
      return errorResponse('Failed to unblock', 500);
    }
  }

  async list(request, userId) {
    try {
      const url = new URL(request.url);
      const blockerType = url.searchParams.get('blockerType') || 'user';
      const blockerId = url.searchParams.get('blockerId') || userId;

      if (blockerType === 'user' && blockerId !== userId) {
        return errorResponse('Cannot view blocks for other users', 403);
      }

      const result = await this.env.DB.prepare(`
        SELECT b.*,
          CASE 
            WHEN b.blocked_type = 'user' THEN u.username
            ELSE NULL
          END as username,
          CASE 
            WHEN b.blocked_type = 'user' THEN u.name
            WHEN b.blocked_type = 'page' THEN p.name
          END as name
        FROM blocks b
        LEFT JOIN users u ON b.blocked_type = 'user' AND b.blocked_id = u.id
        LEFT JOIN pages p ON b.blocked_type = 'page' AND b.blocked_id = p.id
        WHERE b.blocker_type = ? AND b.blocker_id = ?
        ORDER BY b.created_at DESC
      `).bind(blockerType, blockerId).all();

      return successResponse({ blocks: result.results || [] });
    } catch (error) {
      console.error('List blocks error:', error);
      return errorResponse('Failed to get blocks', 500);
    }
  }
}
