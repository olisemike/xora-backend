// ============================================
// USERS CONTROLLER
// ============================================

import { DatabaseService } from '../services/database.js';
import { getCachedDB } from '../services/cachedQuery.js';
import { SensitiveContentHandler } from '../services/sensitiveContent.js';
import {
  errorResponse,
  successResponse,
  safeParseInt,
  parseCursor,
  createCursor
} from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

export class UsersController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
    this.cached = getCachedDB(this.db.db);
    this.sensitiveHandler = new SensitiveContentHandler(this.db.db, env.CACHE);
  }

  /**
   * GET /users/:id
   * Get user profile
   */
  async getProfile(request, userId, targetUsername) {
    try {
      const targetUser = await this.cached.getUserByUsername(targetUsername);
      
      if (!targetUser) {
        return errorResponse('User not found', 404);
      }

      // Check if blocked (single query instead of separate COUNT)
      if (userId) {
        const blocked = await this.env.DB.prepare(`
          SELECT COUNT(*) as count FROM blocks
          WHERE (blocker_type = 'user' AND blocker_id = ? AND blocked_type = 'user' AND blocked_id = ?)
             OR (blocker_type = 'user' AND blocker_id = ? AND blocked_type = 'user' AND blocked_id = ?)
          LIMIT 1
        `).bind(userId, targetUser.id, targetUser.id, userId).first();

        if ((blocked?.count ?? 0) > 0) {
          return errorResponse('User not found', 404);
        }
      }

      // Get settings to check privacy
      const settings = await this.cached.getUserSettings(targetUser.id);

      // Check if private and not following (single query)
      if (settings.private_account && userId && userId !== targetUser.id) {
        const isFollowing = await this.env.DB.prepare(`
          SELECT 1 FROM follows
          WHERE follower_type = 'user' AND follower_id = ?
            AND followee_type = 'user' AND followee_id = ?
          LIMIT 1
        `).bind(userId, targetUser.id).first();

        if (!isFollowing) {
          // Return limited profile
          return successResponse({
            id: targetUser.id,
            username: targetUser.username,
            name: targetUser.name,
            avatar_url: targetUser.avatar_url,
            verified: targetUser.verified,
            private: true
          });
        }
      }

      // Single cached stats query (followers, following, posts)
      const stats = await this.cached.getUserStats(targetUser.id);
      const followersCount = stats?.followers || 0;
      const followingCount = stats?.following || 0;
      const postsCount = stats?.posts || 0;

      // Check follow relationships (batch into single conditional block)
      let isFollowedByMe = false;
      let followsMe = false;

      if (userId && userId !== targetUser.id) {
        const [meFollowsTarget, targetFollowsMe] = await Promise.all([
          this.env.DB.prepare(`
            SELECT 1 FROM follows
            WHERE follower_type = 'user' AND follower_id = ?
              AND followee_type = 'user' AND followee_id = ?
            LIMIT 1
          `).bind(userId, targetUser.id).first(),
          
          this.env.DB.prepare(`
            SELECT 1 FROM follows
            WHERE follower_type = 'user' AND follower_id = ?
              AND followee_type = 'user' AND followee_id = ?
            LIMIT 1
          `).bind(targetUser.id, userId).first()
        ]);

        isFollowedByMe = Boolean(meFollowsTarget);
        followsMe = Boolean(targetFollowsMe);
      }

      // Normalize empty avatar/cover to null so clients use placeholders
      if (!targetUser.avatar_url || String(targetUser.avatar_url).trim() === '') {
        targetUser.avatar_url = null;
      }
      if (!targetUser.cover_url || String(targetUser.cover_url).trim() === '') {
        targetUser.cover_url = null;
      }

      // Remove sensitive data
      delete targetUser.password_hash;
      delete targetUser.two_factor_secret;
      delete targetUser.email;

      return successResponse({
        ...targetUser,
        stats: {
          followers: followersCount,
          following: followingCount,
          posts: postsCount
        },
        relationship: userId && userId !== targetUser.id ? {
          isFollowedByMe,
          followsMe
        } : null
      });

    } catch (error) {
      console.error('Get profile error:', error);
      return errorResponse('Failed to get profile', 500);
    }
  }

  /**
   * PATCH /users/me
   * Update current user profile
   */
  async updateProfile(request, userId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }

      const allowedFields = [
        'name', 'bio', 'website', 'location', 
        'dateOfBirth', 'gender', 'avatarUrl', 'coverUrl'
      ];

      const updates = {};
      for (const field of allowedFields) {
        if (body[field] !== undefined) {
          updates[field] = body[field];
        }
      }

      if (Object.keys(updates).length === 0) {
        return errorResponse('No fields to update', 400);
      }

      // Clean up old Cloudflare files if updating avatar or cover
      if (updates.avatarUrl !== undefined || updates.coverUrl !== undefined) {
        try {
          const currentUser = await this.db.getUserById(userId);
          const { CloudflareMediaCleaner } = await import('../utils/cloudflare-media.js');
          const cleaner = new CloudflareMediaCleaner(this.env);

          // Clean up old avatar if new one is being set or explicitly cleared
          if (updates.avatarUrl !== undefined && currentUser?.cloudflare_avatar_id) {
            await cleaner.deleteImage(currentUser.cloudflare_avatar_id);
          }

          // Clean up old cover if new one is being set or explicitly cleared
          if (updates.coverUrl !== undefined && currentUser?.cloudflare_cover_id) {
            await cleaner.deleteImage(currentUser.cloudflare_cover_id);
          }
        } catch (cleanupError) {
          console.error('Cloudflare cleanup error for profile update:', cleanupError);
          // Don't fail the update if cleanup fails
        }
      }

      // Clear Cloudflare IDs when clearing the URLs
      if (updates.avatarUrl === null) {
        updates.cloudflareAvatarId = null;
      }
      if (updates.coverUrl === null) {
        updates.cloudflareCoverId = null;
      }

      const updatedUser = await this.db.updateUser(userId, updates);

      // Remove sensitive data
      delete updatedUser.password_hash;
      delete updatedUser.two_factor_secret;

      return successResponse(updatedUser, 'Profile updated successfully');

    } catch (error) {
      console.error('Update profile error:', error);
      return errorResponse('Failed to update profile', 500);
    }
  }

  /**
   * GET /users/:username/feed
   * Get user's posts
   */
  async getUserFeed(request, userId, targetUsername) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');
      const lang = url.searchParams.get('lang');
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

      const targetUser = await this.cached.getUserByUsername(targetUsername);
      if (!targetUser) {
        return errorResponse('User not found', 404);
      }

      // Check privacy
      const settings = await this.cached.getUserSettings(targetUser.id);
      if (settings.private_account && userId !== targetUser.id) {
        const isFollowing = await this.env.DB.prepare(`
          SELECT COUNT(*) as count FROM follows
          WHERE follower_type = 'user' AND follower_id = ?
            AND followee_type = 'user' AND followee_id = ?
        `).bind(userId, targetUser.id).first();

        if ((isFollowing?.count ?? 0) === 0) {
          return errorResponse('This account is private', 403);
        }
      }

      // Build query
      let query = `
        SELECT p.*, u.username, u.name as actor_name, u.avatar_url, u.verified
        FROM posts p
        JOIN users u ON p.actor_id = u.id
        WHERE p.actor_type = 'user' AND p.actor_id = ?
      `;
      
      const params = [targetUser.id];

      if (lang) {
        query += ` AND p.language = ?`;
        params.push(lang);
      }

      if (cursor) {
        const cursorData = parseCursor(cursor);
        if (cursorData && cursorData.created_at) {
          query += ` AND p.created_at < ?`;
          params.push(cursorData.created_at);
        }
      }

      query += ` ORDER BY p.created_at DESC LIMIT ?`;
      params.push(limit + 1);

      const result = await this.env.DB.prepare(query).bind(...params).all();
      const posts = result.results || [];

      const hasMore = posts.length > limit;
      if (hasMore) {
        posts.pop();
      }

      const nextCursor = hasMore && posts.length > 0
        ? createCursor({ created_at: posts[posts.length - 1].created_at })
        : null;

      // Parse media URLs and enrich actor info
      const processedPosts = posts.map(post => {
        const processedPost = { ...post };
        // Actor info already included from JOIN (username, name, avatar_url, verified)
        if (processedPost.media_urls) {
          try {
            processedPost.media_urls = JSON.parse(processedPost.media_urls);
          } catch {
            processedPost.media_urls = [];
          }
        }
        // Add actor object matching post detail structure
        processedPost.actor = {
          id: post.actor_id,
          username: post.username || null,
          name: post.actor_name || null,
          avatar_url: post.avatar_url || null,
          verified: post.verified || 0
        };
        return processedPost;
      });

      const postsWithCounts = await this.db.attachEngagementCounts(processedPosts);

      // Attach liked_by_me for viewer identity
      if (userId && postsWithCounts.length > 0) {
        const postIds = postsWithCounts.map((p) => String(p.id));
        const placeholders = postIds.map(() => '?').join(',');
        const likesResult = await this.env.DB.prepare(`
          SELECT target_id FROM likes
          WHERE target_type = 'post'
            AND actor_type = ?
            AND actor_id = ?
            AND target_id IN (${placeholders})
        `).bind(resolvedActorType, resolvedActorId, ...postIds).all();

        const likedSet = new Set((likesResult.results || []).map((r) => String(r.target_id)));
        postsWithCounts.forEach((p) => {
          p.liked_by_me = likedSet.has(String(p.id));
        });
      }

      // Attach bookmarked_by_me for viewer identity
      if (userId && postsWithCounts.length > 0) {
        const postIds = postsWithCounts.map((p) => String(p.id));
        const placeholders = postIds.map(() => '?').join(',');
        const bookmarksResult = await this.env.DB.prepare(`
          SELECT post_id FROM bookmarks
          WHERE user_id = ?
            AND post_id IN (${placeholders})
        `).bind(userId, ...postIds).all();

        const bookmarkedSet = new Set((bookmarksResult.results || []).map((r) => String(r.post_id)));
        postsWithCounts.forEach((p) => {
          p.bookmarked_by_me = bookmarkedSet.has(String(p.id));
        });
      }

      // Fetch shares by this user to include in profile feed
      let shares = [];
      try {
        let sharesQuery = `
          SELECT * FROM shares
          WHERE actor_type = 'user' AND actor_id = ?
        `;
        const sharesParams = [targetUser.id];
        if (cursor) {
          const cursorData = parseCursor(cursor);
          if (cursorData && cursorData.created_at) {
            sharesQuery += ` AND created_at < ?`;
            sharesParams.push(cursorData.created_at);
          }
        }
        sharesQuery += ` ORDER BY created_at DESC LIMIT ?`;
        sharesParams.push(limit + 1);

        const sharesResult = await this.env.DB.prepare(sharesQuery).bind(...sharesParams).all();
        shares = sharesResult.results || [];
      } catch (e) {
        shares = [];
      }

      let hydratedShares = [];
      if (shares.length > 0) {
        const originalPostIds = [...new Set(shares.map(s => s.original_post_id).filter(Boolean))];
        if (originalPostIds.length > 0) {
          const placeholders = originalPostIds.map(() => '?').join(',');
          const originalResult = await this.env.DB.prepare(`
            SELECT * FROM posts WHERE id IN (${placeholders})
          `).bind(...originalPostIds).all();

          const originalsMap = new Map();
          for (const p of originalResult.results || []) {
            originalsMap.set(p.id, { ...p });
          }

          // Attach engagement counts to originals
          const originalsWithCounts = await this.db.attachEngagementCounts([...originalsMap.values()]);
          originalsWithCounts.forEach((p) => originalsMap.set(p.id, p));

          // Collect actor IDs for originals
          const actorIds = [];
          for (const share of shares) {
            actorIds.push({ type: 'user', id: share.actor_id });
            const originalPost = originalsMap.get(share.original_post_id);
            if (originalPost) {
              actorIds.push({ type: originalPost.actor_type, id: originalPost.actor_id });
            }
          }

          // Batch fetch actors (users/pages)
          const actorMap = new Map();
          const userIds = actorIds.filter(a => a.type === 'user').map(a => a.id);
          const pageIds = actorIds.filter(a => a.type === 'page').map(a => a.id);

          if (userIds.length > 0) {
            const users = await this.cached.getUsers(userIds);
            for (const u of users || []) {
              actorMap.set(`user:${u.id}`, {
                username: u.username,
                name: u.name || u.username,
                avatar_url: u.avatar_url,
                verified: u.verified
              });
            }
          }

          if (pageIds.length > 0) {
            const pPlaceholders = pageIds.map(() => '?').join(',');
            const pages = await this.env.DB.prepare(`
              SELECT id, name, avatar_url, verified FROM pages WHERE id IN (${pPlaceholders})
            `).bind(...pageIds).all();
            for (const p of pages.results || []) {
              actorMap.set(`page:${p.id}`, {
                username: p.name,
                name: p.name,
                avatar_url: p.avatar_url,
                verified: p.verified
              });
            }
          }

          const originalIds = [...new Set(shares.map(s => String(s.original_post_id)).filter(Boolean))];
          let likedOriginals = new Set();
          let bookmarkedOriginals = new Set();
          if (userId && originalIds.length > 0) {
            const oPlaceholders = originalIds.map(() => '?').join(',');
            const likesResult = await this.env.DB.prepare(`
              SELECT target_id FROM likes
              WHERE target_type = 'post'
                AND actor_type = ?
                AND actor_id = ?
                AND target_id IN (${oPlaceholders})
            `).bind(resolvedActorType, resolvedActorId, ...originalIds).all();
            likedOriginals = new Set((likesResult.results || []).map((r) => String(r.target_id)));

            const bookmarksResult = await this.env.DB.prepare(`
              SELECT post_id FROM bookmarks
              WHERE user_id = ?
                AND post_id IN (${oPlaceholders})
            `).bind(userId, ...originalIds).all();
            bookmarkedOriginals = new Set((bookmarksResult.results || []).map((r) => String(r.post_id)));
          }

          hydratedShares = shares.map((share) => {
            const originalPost = originalsMap.get(share.original_post_id);
            if (!originalPost) return null;

            let mediaUrls = [];
            if (originalPost.media_urls) {
              try { mediaUrls = JSON.parse(originalPost.media_urls); } catch { mediaUrls = []; }
            }

            const shareActorInfo = actorMap.get(`user:${share.actor_id}`) || {};
            const origActorInfo = actorMap.get(`${originalPost.actor_type}:${originalPost.actor_id}`) || {};

            return {
              ...share,
              username: shareActorInfo.username || null,
              actor_name: shareActorInfo.name || shareActorInfo.username || 'Unknown',
              avatar_url: shareActorInfo.avatar_url || null,
              verified: shareActorInfo.verified || 0,
              actor: {
                id: share.actor_id,
                username: shareActorInfo.username || null,
                name: shareActorInfo.name || null,
                avatar_url: shareActorInfo.avatar_url || null,
                verified: shareActorInfo.verified || 0
              },
              isShare: true,
              originalPost: {
                id: originalPost.id,
                content: originalPost.content,
                media_urls: mediaUrls,
                media_type: originalPost.media_type,
                likes_count: originalPost.likes_count,
                comments_count: originalPost.comments_count,
                shares_count: originalPost.shares_count,
                liked_by_me: likedOriginals.has(String(originalPost.id)),
                bookmarked_by_me: bookmarkedOriginals.has(String(originalPost.id)),
                actor_type: originalPost.actor_type,
                actor_id: originalPost.actor_id,
                username: origActorInfo.username || null,
                actor_name: origActorInfo.name || origActorInfo.username || 'Unknown',
                avatar_url: origActorInfo.avatar_url || null,
                verified: origActorInfo.verified || 0,
                actor: {
                  id: originalPost.actor_id,
                  username: origActorInfo.username || null,
                  name: origActorInfo.name || null,
                  avatar_url: origActorInfo.avatar_url || null,
                  verified: origActorInfo.verified || 0
                },
                created_at: originalPost.created_at
              }
            };
          }).filter(Boolean);
        }
      }

      const combined = [...postsWithCounts, ...hydratedShares].sort((a, b) => {
        const aTime = a.created_at || a.timestamp || 0;
        const bTime = b.created_at || b.timestamp || 0;
        return bTime - aTime;
      });

      const combinedHasMore = combined.length > limit;
      if (combinedHasMore) combined.pop();
      const combinedNextCursor = combinedHasMore && combined.length > 0
        ? createCursor({ created_at: combined[combined.length - 1].created_at || combined[combined.length - 1].timestamp })
        : null;

      // Filter sensitive content if viewer is not the profile owner
      let finalPosts = combined;
      if (userId && userId !== targetUser.id) {
        // Someone else viewing this profile - apply sensitive content filtering
        finalPosts = await this.sensitiveHandler.filterFeedPosts(combined, userId);
      }

      return successResponse({
        posts: finalPosts,
        pagination: {
          hasMore: combinedHasMore,
          nextCursor: combinedNextCursor
        }
      });

    } catch (error) {
      console.error('Get user feed error:', error);
      return errorResponse('Failed to get feed', 500);
    }
  }

  /**
   * GET /users/:username/bookmarks
   * Get user's bookmarks
   */
  async getUserBookmarks(request, userId, targetUsername) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');

      const targetUser = await this.cached.getUserByUsername(targetUsername);
      if (!targetUser) {
        return errorResponse('User not found', 404);
      }

      const settings = await this.cached.getUserSettings(targetUser.id);
      if (settings.private_account && userId !== targetUser.id) {
        if (!userId) {
          return errorResponse('This account is private', 403);
        }
        const isFollowing = await this.env.DB.prepare(`
          SELECT COUNT(*) as count FROM follows
          WHERE follower_type = 'user' AND follower_id = ?
            AND followee_type = 'user' AND followee_id = ?
        `).bind(userId, targetUser.id).first();

        if ((isFollowing?.count ?? 0) === 0) {
          return errorResponse('This account is private', 403);
        }
      }

      let query = `
        SELECT p.*, b.created_at as bookmarked_at,
          CASE WHEN p.actor_type = 'user' THEN u.username ELSE pg.name END as username,
          CASE WHEN p.actor_type = 'user' THEN u.name ELSE pg.name END as actor_name,
          CASE WHEN p.actor_type = 'user' THEN u.avatar_url ELSE pg.avatar_url END as avatar_url,
          CASE WHEN p.actor_type = 'user' THEN u.verified ELSE pg.verified END as verified
        FROM bookmarks b
        JOIN posts p ON b.post_id = p.id
        LEFT JOIN users u ON p.actor_type = 'user' AND p.actor_id = u.id
        LEFT JOIN pages pg ON p.actor_type = 'page' AND p.actor_id = pg.id
        WHERE b.user_id = ?
      `;

      const params = [targetUser.id];

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
      console.error('Get user bookmarks error:', error);
      return errorResponse('Failed to get bookmarks', 500);
    }
  }

  /**
   * GET /users/:username/followers
   * Get user's followers
   */
  async getFollowers(request, userId, targetUsername) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');

      const targetUser = await this.cached.getUserByUsername(targetUsername);
      if (!targetUser) {
        return errorResponse('User not found', 404);
      }

      let query = `
        SELECT u.id, u.username, u.name, u.avatar_url, u.verified, f.created_at
        FROM follows f
        JOIN users u ON f.follower_id = u.id
        WHERE f.followee_type = 'user' AND f.followee_id = ?
          AND f.follower_type = 'user'
      `;
      
      const params = [targetUser.id];

      if (cursor) {
        const cursorData = parseCursor(cursor);
        if (cursorData && cursorData.created_at) {
          query += ` AND f.created_at < ?`;
          params.push(cursorData.created_at);
        }
      }

      query += ` ORDER BY f.created_at DESC LIMIT ?`;
      params.push(limit + 1);

      const result = await this.env.DB.prepare(query).bind(...params).all();
      const followers = result.results || [];

      const hasMore = followers.length > limit;
      if (hasMore) {
        followers.pop();
      }

      const nextCursor = hasMore && followers.length > 0
        ? createCursor({ created_at: followers[followers.length - 1].created_at })
        : null;

      return successResponse({
        followers,
        pagination: {
          hasMore,
          nextCursor
        }
      });

    } catch (error) {
      console.error('Get followers error:', error);
      return errorResponse('Failed to get followers', 500);
    }
  }

  /**
   * GET /users/:username/following
   * Get users/pages that user follows
   */
  async getFollowing(request, userId, targetUsername) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');

      const targetUser = await this.cached.getUserByUsername(targetUsername);
      if (!targetUser) {
        return errorResponse('User not found', 404);
      }

      let query = `
        SELECT 
          CASE 
            WHEN f.followee_type = 'user' THEN u.id
            WHEN f.followee_type = 'page' THEN p.id
          END as id,
          CASE 
            WHEN f.followee_type = 'user' THEN u.username
            ELSE NULL
          END as username,
          CASE 
            WHEN f.followee_type = 'user' THEN u.name
            WHEN f.followee_type = 'page' THEN p.name
          END as name,
          CASE 
            WHEN f.followee_type = 'user' THEN u.avatar_url
            WHEN f.followee_type = 'page' THEN p.avatar_url
          END as avatar_url,
          CASE 
            WHEN f.followee_type = 'user' THEN u.verified
            WHEN f.followee_type = 'page' THEN p.verified
          END as verified,
          f.followee_type as type,
          f.created_at
        FROM follows f
        LEFT JOIN users u ON f.followee_type = 'user' AND f.followee_id = u.id
        LEFT JOIN pages p ON f.followee_type = 'page' AND f.followee_id = p.id
        WHERE f.follower_type = 'user' AND f.follower_id = ?
      `;
      
      const params = [targetUser.id];

      if (cursor) {
        const cursorData = parseCursor(cursor);
        if (cursorData && cursorData.created_at) {
          query += ` AND f.created_at < ?`;
          params.push(cursorData.created_at);
        }
      }

      query += ` ORDER BY f.created_at DESC LIMIT ?`;
      params.push(limit + 1);

      const result = await this.env.DB.prepare(query).bind(...params).all();
      const following = result.results || [];

      const hasMore = following.length > limit;
      if (hasMore) {
        following.pop();
      }

      const nextCursor = hasMore && following.length > 0
        ? createCursor({ created_at: following[following.length - 1].created_at })
        : null;

      return successResponse({
        following,
        pagination: {
          hasMore,
          nextCursor
        }
      });

    } catch (error) {
      console.error('Get following error:', error);
      return errorResponse('Failed to get following', 500);
    }
  }

  /**
   * GET /users/suggested
   * Get suggested users to follow
   */
  async getSuggestedUsers(request, userId) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 5, 1, 20);

      // Get user's sensitive content preferences
      const userSettings = await this.cached.getUserSettings(userId);
      const allowsSuggestSensitive = userSettings?.suggest_sensitive_content === 1;

      // Get users the current user is not following and not blocking
      let query = `
        SELECT DISTINCT u.id, u.username, u.name, u.bio, u.avatar_url, u.verified,
               (SELECT COUNT(*) FROM follows WHERE followee_type = 'user' AND followee_id = u.id) as follower_count
        FROM users u
        WHERE u.id != ?
          AND u.id NOT IN (
            SELECT followee_id FROM follows
            WHERE follower_type = 'user' AND follower_id = ? AND followee_type = 'user'
          )
          AND u.id NOT IN (
            SELECT blocked_id FROM blocks
            WHERE blocker_type = 'user' AND blocker_id = ? AND blocked_type = 'user'
          )
          AND u.id NOT IN (
            SELECT blocker_id FROM blocks
            WHERE blocked_type = 'user' AND blocked_id = ? AND blocker_type = 'user'
          )
      `;

      const params = [userId, userId, userId, userId];

      // Filter out accounts with sensitive posts (unless user allows sensitive suggestions)
      if (!allowsSuggestSensitive) {
        query += `
          AND u.id NOT IN (
            SELECT DISTINCT actor_id FROM posts
            WHERE actor_type = 'user' AND is_sensitive = 1
          )
        `;
      }

      query += ` ORDER BY RANDOM() LIMIT ?`;
      params.push(limit);

      const users = await this.env.DB.prepare(query).bind(...params).all();

      return successResponse({ users: users.results || [] });
    } catch (error) {
      console.error('Get suggested users error:', error);
      return errorResponse('Failed to get suggested users', 500);
    }
  }

  /**
   * DELETE /users/me
   * Delete account (GDPR)
   */
  async deleteAccount(request, userId) {
    try {
      const body = await request.json();
      const { password } = body;

      if (!password) {
        return errorResponse('Password required to delete account', 400);
      }

      const user = await this.cached.getUser(userId);

      if (!user) {
        return errorResponse('User not found', 404);
      }

      // Check if password_hash exists
      if (!user.password_hash) {
        console.error(`[Users] User ${userId} has no password_hash for account deletion`);
        return errorResponse('Password not set for this account', 400);
      }

      // Verify password
      const { verifyPassword } = await import('../utils/helpers.js');
      const isValid = await verifyPassword(password, user.password_hash);

      if (!isValid) {
        return errorResponse('Invalid password', 401);
      }

      // ============================================
      // Step 1: Delete Cloudflare media before DB deletion
      // ============================================
      try {
        const { CloudflareMediaCleaner } = await import('../utils/cloudflare-media.js');
        const cleaner = new CloudflareMediaCleaner(this.env);

        // Delete user's avatar
        if (user.cloudflare_avatar_id) {
          try {
            await cleaner.deleteImage(user.cloudflare_avatar_id);
          } catch (err) {
            logger.warn('Failed to delete user avatar from Cloudflare', { userId, avatarId: user.cloudflare_avatar_id });
          }
        }

        // Delete user's cover image
        if (user.cloudflare_cover_id) {
          try {
            await cleaner.deleteImage(user.cloudflare_cover_id);
          } catch (err) {
            logger.warn('Failed to delete user cover from Cloudflare', { userId, coverId: user.cloudflare_cover_id });
          }
        }

        // Delete all media from user's posts
        const userPosts = await this.env.DB.prepare(`
          SELECT id, cloudflare_image_ids, cloudflare_video_ids, media_urls
          FROM posts
          WHERE actor_type = 'user' AND actor_id = ?
        `).bind(userId).all();

        if (userPosts?.results) {
          for (const post of userPosts.results) {
            try {
              // Delete cloudflare images
              if (post.cloudflare_image_ids) {
                const imageIds = cleaner.safeParseJson(post.cloudflare_image_ids);
                for (const imageId of imageIds) {
                  if (imageId) {
                    try {
                      await cleaner.deleteImage(imageId);
                    } catch (err) {
                      // Continue with next image
                    }
                  }
                }
              }

              // Delete cloudflare videos
              if (post.cloudflare_video_ids) {
                const videoIds = cleaner.safeParseJson(post.cloudflare_video_ids);
                for (const videoId of videoIds) {
                  if (videoId) {
                    try {
                      await cleaner.deleteVideo(videoId);
                    } catch (err) {
                      // Continue with next video
                    }
                  }
                }
              } else if (post.media_urls) {
                // Parse media_urls and extract cloudflare IDs
                const mediaArray = typeof post.media_urls === 'string'
                  ? JSON.parse(post.media_urls)
                  : post.media_urls;

                if (Array.isArray(mediaArray)) {
                  const videosToDelete = mediaArray
                    .filter(m => m.type === 'video' && (m.cloudflareId || m.videoId))
                    .map(m => m.cloudflareId || m.videoId);

                  for (const videoId of videosToDelete) {
                    if (videoId) {
                      try {
                        await cleaner.deleteVideo(videoId);
                      } catch (err) {
                        // Continue with next video
                      }
                    }
                  }
                }
              }
            } catch (postMediaErr) {
              logger.warn('Failed to clean media from user post', { userId, postId: post.id });
            }
          }
        }

        // Delete all media from user's comments
        const userComments = await this.env.DB.prepare(`
          SELECT id, cloudflare_image_ids, cloudflare_video_ids, media_urls
          FROM comments
          WHERE actor_type = 'user' AND actor_id = ?
        `).bind(userId).all();

        if (userComments?.results) {
          for (const comment of userComments.results) {
            try {
              // Delete cloudflare images
              if (comment.cloudflare_image_ids) {
                const imageIds = cleaner.safeParseJson(comment.cloudflare_image_ids);
                for (const imageId of imageIds) {
                  if (imageId) {
                    try {
                      await cleaner.deleteImage(imageId);
                    } catch (err) {
                      // Continue
                    }
                  }
                }
              }

              // Delete cloudflare videos
              if (comment.cloudflare_video_ids) {
                const videoIds = cleaner.safeParseJson(comment.cloudflare_video_ids);
                for (const videoId of videoIds) {
                  if (videoId) {
                    try {
                      await cleaner.deleteVideo(videoId);
                    } catch (err) {
                      // Continue
                    }
                  }
                }
              }
            } catch (commentMediaErr) {
              logger.warn('Failed to clean media from user comment', { userId, commentId: comment.id });
            }
          }
        }

        logger.info('Cloudflare media cleanup completed for user account deletion', { userId });
      } catch (cloudflareError) {
        // Don't fail account deletion if cloudflare cleanup fails, but log it
        logger.error('Error cleaning user media from Cloudflare', { userId, error: cloudflareError });
      }

      // ============================================
      // Step 2: Delete user from active databases (cascades to all related data)
      // ============================================
      await this.db.deleteUser(userId);

      // ============================================
      // Step 3: Delete user data from R2 snapshots
      // ============================================
      try {
        const { ArchivalService } = await import('../services/archivalService.js');
        const archival = new ArchivalService(
          this.env.DB,
          this.env.DB2,
          this.env.DB3,
          this.env.STORAGE,
          this.env.SNAPSHOTS,
          this.env.CACHE
        );

        logger.info('Deleting user data from R2 snapshots', { userId });
        const result = await archival.deleteUserFromSnapshots(userId);
        logger.info('Snapshot cleanup result', { userId, result });
      } catch (snapshotError) {
        // Don't fail the account deletion if snapshot cleanup fails
        logger.error('Error cleaning user from snapshots', { userId, error: snapshotError });
      }

      return successResponse(null, 'Account deleted successfully');

    } catch (error) {
      console.error('Delete account error:', error);
      return errorResponse('Failed to delete account', 500);
    }
  }

  /**
   * GET /users/me/export
   * Export user data (GDPR)
   */
  async exportData(request, userId) {
    try {
      // Get all user data
      const [user, posts, comments, likes, bookmarks, followers, following] = await Promise.all([
        this.cached.getUser(userId),
        this.env.DB.prepare(`
          SELECT * FROM posts WHERE actor_type = 'user' AND actor_id = ?
        `).bind(userId).all(),
        this.env.DB.prepare(`
          SELECT * FROM comments WHERE actor_type = 'user' AND actor_id = ?
        `).bind(userId).all(),
        this.env.DB.prepare(`
          SELECT * FROM likes WHERE actor_type = 'user' AND actor_id = ?
        `).bind(userId).all(),
        this.env.DB.prepare(`
          SELECT * FROM bookmarks WHERE user_id = ?
        `).bind(userId).all(),
        this.env.DB.prepare(`
          SELECT * FROM follows WHERE follower_type = 'user' AND follower_id = ?
        `).bind(userId).all(),
        this.env.DB.prepare(`
          SELECT * FROM follows WHERE followee_type = 'user' AND followee_id = ?
        `).bind(userId).all()
      ]);

      const exportData = {
        user: {
          ...user,
          password_hash: undefined,
          two_factor_secret: undefined
        },
        posts: posts.results || [],
        comments: comments.results || [],
        likes: likes.results || [],
        bookmarks: bookmarks.results || [],
        followers: followers.results || [],
        following: following.results || [],
        exportedAt: new Date().toISOString()
      };

      return successResponse(exportData);

    } catch (error) {
      console.error('Export data error:', error);
      return errorResponse('Failed to export data', 500);
    }
  }
}
