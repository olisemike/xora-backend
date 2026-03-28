// ============================================
// PAGES CONTROLLER
// ============================================

import { DatabaseService } from '../services/database.js';
import { SensitiveContentHandler } from '../services/sensitiveContent.js';
import { errorResponse, successResponse, parseCursor, createCursor , safeParseInt } from '../utils/helpers.js';

export class PagesController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
    this.sensitiveHandler = new SensitiveContentHandler(this.db.db, env.CACHE);
  }

  async list(request, userId) {
    try {
      const pages = await this.db.getUserPages(userId);
      return successResponse({ pages });
    } catch (error) {
      console.error('List pages error:', error);
      return errorResponse('Failed to list pages', 500);
    }
  }

  async create(request, userId) {
    try {
      const body = await request.json();
      const { name, bio, avatarUrl, coverUrl } = body;

      if (!name) {
        return errorResponse('Page name is required', 400);
      }

      const page = await this.db.createPage(userId, {
        name,
        bio,
        avatarUrl,
        coverUrl
      });

      return successResponse(page, 'Page created successfully');
    } catch (error) {
      console.error('Create page error:', error);
      return errorResponse('Failed to create page', 500);
    }
  }

  async get(request, userId, pageId) {
    try {
      const page = await this.db.getPageById(pageId);
      
      if (!page) {
        return errorResponse('Page not found', 404);
      }

      // Normalize empty avatar/cover to null so clients use placeholders
      if (!page.avatar_url || String(page.avatar_url).trim() === '') {
        page.avatar_url = null;
      }
      if (!page.cover_url || String(page.cover_url).trim() === '') {
        page.cover_url = null;
      }

      // Get stats
      const [followers, posts, following] = await Promise.all([
        this.env.DB.prepare(`
          SELECT COUNT(*) as count FROM follows
          WHERE followee_type = 'page' AND followee_id = ?
        `).bind(pageId).first(),
        
        this.env.DB.prepare(`
          SELECT COUNT(*) as count FROM posts
          WHERE actor_type = 'page' AND actor_id = ?
        `).bind(pageId).first(),

        this.env.DB.prepare(`
          SELECT COUNT(*) as count FROM follows
          WHERE follower_type = 'page' AND follower_id = ?
        `).bind(pageId).first()
      ]);

      // Check if current user follows
      let isFollowedByMe = false;
      if (userId) {
        const follow = await this.env.DB.prepare(`
          SELECT COUNT(*) as count FROM follows
          WHERE follower_type = 'user' AND follower_id = ?
            AND followee_type = 'page' AND followee_id = ?
        `).bind(userId, pageId).first();
        
        isFollowedByMe = (follow?.count ?? 0) > 0;
      }

      // Check if user is owner (only for logged in user, not sent to client)
      let isOwner = false;
      if (userId) {
        isOwner = await this.db.isPageOwner(pageId, userId);
      }

      return successResponse({
        ...page,
        stats: {
          followers: followers?.count ?? 0,
          posts: posts?.count ?? 0,
          following: following?.count ?? 0
        },
        isFollowedByMe,
        isOwner
      });
    } catch (error) {
      console.error('Get page error:', error);
      return errorResponse('Failed to get page', 500);
    }
  }

  async update(request, userId, pageId) {
    try {
      // Check ownership
      const isOwner = await this.db.isPageOwner(pageId, userId);
      if (!isOwner) {
        return errorResponse('You do not own this page', 403);
      }

      const body = await request.json();
      const page = await this.db.updatePage(pageId, body);

      return successResponse(page, 'Page updated successfully');
    } catch (error) {
      console.error('Update page error:', error);
      return errorResponse('Failed to update page', 500);
    }
  }

  async delete(request, userId, pageId) {
    try {
      const isOwner = await this.db.isPageOwner(pageId, userId);
      if (!isOwner) {
        return errorResponse('You do not own this page', 403);
      }

      await this.db.deletePage(pageId);
      return successResponse(null, 'Page deleted successfully');
    } catch (error) {
      console.error('Delete page error:', error);
      return errorResponse('Failed to delete page', 500);
    }
  }

  async getFeed(request, userId, pageId) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');
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

      const page = await this.db.getPageById(pageId);
      if (!page) {
        return errorResponse('Page not found', 404);
      }

      let query = `
        SELECT p.*, pg.name as actor_name, pg.name as username, pg.avatar_url, pg.verified
        FROM posts p
        JOIN pages pg ON p.actor_id = pg.id
        WHERE p.actor_type = 'page' AND p.actor_id = ?
      `;
      
      const params = [pageId];

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
      if (hasMore) posts.pop();

      const nextCursor = hasMore && posts.length > 0
        ? createCursor({ created_at: posts[posts.length - 1].created_at })
        : null;

      posts.forEach(post => {
        if (post.media_urls) {
          try {
            post.media_urls = JSON.parse(post.media_urls);
          } catch {
            post.media_urls = [];
          }
        }
        // Add actor object matching post detail structure
        post.actor = {
          id: post.actor_id,
          username: post.username || null,
          name: post.actor_name || null,
          avatar_url: post.avatar_url || null,
          verified: post.verified || 0
        };
      });

      const postsWithCounts = await this.db.attachEngagementCounts(posts);

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

      // Filter sensitive content if viewer is not the page owner
      let finalPosts = postsWithCounts;
      if (userId && page.owner_id !== userId) {
        // Someone else viewing this page - apply sensitive content filtering
        finalPosts = await this.sensitiveHandler.filterFeedPosts(postsWithCounts, userId);
      }

      return successResponse({
        posts: finalPosts,
        pagination: { hasMore, nextCursor }
      });
    } catch (error) {
      console.error('Get page feed error:', error);
      return errorResponse('Failed to get feed', 500);
    }
  }

  async getFollowers(request, userId, pageId) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');

      const page = await this.db.getPageById(pageId);
      if (!page) {
        return errorResponse('Page not found', 404);
      }

      let query = `
        SELECT u.id, u.username, u.name, u.avatar_url, u.verified, f.created_at
        FROM follows f
        JOIN users u ON f.follower_id = u.id
        WHERE f.followee_type = 'page' AND f.followee_id = ?
          AND f.follower_type = 'user'
      `;
      
      const params = [pageId];

      if (cursor) {
        const cursorData = parseCursor(cursor);
        if (cursorData?.created_at) {
          query += ` AND f.created_at < ?`;
          params.push(cursorData.created_at);
        }
      }

      query += ` ORDER BY f.created_at DESC LIMIT ?`;
      params.push(limit + 1);

      const result = await this.env.DB.prepare(query).bind(...params).all();
      const followers = result.results || [];

      const hasMore = followers.length > limit;
      if (hasMore) followers.pop();

      const nextCursor = hasMore && followers.length > 0
        ? createCursor({ created_at: followers[followers.length - 1].created_at })
        : null;

      return successResponse({
        followers,
        pagination: { hasMore, nextCursor }
      });
    } catch (error) {
      console.error('Get page followers error:', error);
      return errorResponse('Failed to get followers', 500);
    }
  }
}
