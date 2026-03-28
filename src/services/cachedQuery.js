/**
 * Database Query Helper with Caching
 * Wraps common queries with automatic caching
 */

import { getCache } from './dbCache.js';
import { BatchQueryBuilder } from './queryBuilder.js';

export class CachedDB {
  constructor(db) {
    this.db = db;
    this.cache = getCache();
    this.batch = new BatchQueryBuilder(db);
  }

  /**
   * Get user by ID with caching
   */
  async getUser(userId) {
    return this.cache.query(
      `user:${userId}`,
      async () => {
        const result = await this.db.prepare(
          'SELECT * FROM users WHERE id = ?'
        ).bind(userId).first();
        return result;
      },
      { ttl: 120000, tags: ['users', `user:${userId}`] }
    );
  }

  /**
   * Get user by email with caching
   */
  async getUserByEmail(email) {
    const normalized = String(email || '').toLowerCase();
    return this.cache.query(
      `user-email:${normalized}`,
      async () => {
        const result = await this.db.prepare(
          'SELECT * FROM users WHERE email = ?'
        ).bind(normalized).first();
        return result;
      },
      { ttl: 300000, tags: ['users', 'user-email'] }
    );
  }

  /**
   * Get user by username with caching
   */
  async getUserByUsername(username) {
    const normalized = String(username || '').toLowerCase();
    return this.cache.query(
      `user-username:${normalized}`,
      async () => {
        const result = await this.db.prepare(
          'SELECT * FROM users WHERE username = ?'
        ).bind(normalized).first();
        return result;
      },
      { ttl: 300000, tags: ['users', 'user-username'] }
    );
  }

  /**
   * Get user settings with caching
   */
  async getUserSettings(userId) {
    return this.cache.query(
      `user-settings:${userId}`,
      async () => {
        const result = await this.db.prepare(
          'SELECT * FROM user_settings WHERE user_id = ?'
        ).bind(userId).first();
        return result;
      },
      { ttl: 120000, tags: ['user-settings', `user:${userId}`] }
    );
  }

  /**
   * Get user stats with caching
   */
  async getUserStats(userId) {
    return this.cache.query(
      `user-stats:${userId}`,
      async () => {
        const result = await this.db.prepare(`
          SELECT
            (SELECT COUNT(*) FROM follows WHERE followee_type = 'user' AND followee_id = ?) as followers,
            (SELECT COUNT(*) FROM follows WHERE follower_type = 'user' AND follower_id = ?) as following,
            (SELECT COUNT(*) FROM posts WHERE actor_type = 'user' AND actor_id = ?) as posts
        `).bind(userId, userId, userId).first();
        return result || { followers: 0, following: 0, posts: 0 };
      },
      { ttl: 120000, tags: ['user-stats', `user:${userId}`] }
    );
  }

  /**
   * Get multiple users at once (batched)
   */
  async getUsers(userIds) {
    const unique = [...new Set(userIds)];
    const cached = this.cache.get(`users:${unique.join(',')}`);
    if (cached) return cached;

    const placeholders = unique.map(() => '?').join(',');
    const result = await this.db.prepare(
      `SELECT * FROM users WHERE id IN (${placeholders})`
    ).bind(...unique).all();

    this.cache.set(`users:${unique.join(',')}`, result.results, 120000, ['users']);
    return result.results;
  }

  /**
   * Get post by ID with caching
   */
  async getPost(postId) {
    return this.cache.query(
      `post:${postId}`,
      async () => {
        const result = await this.db.prepare(
          'SELECT * FROM posts WHERE id = ?'
        ).bind(postId).first();
        return result;
      },
      { ttl: 180000, tags: ['posts', `post:${postId}`] }
    );
  }

  /**
   * Get posts by user (cached separately)
   */
  async getPostsByUser(userId, limit = 20, offset = 0) {
    return this.cache.query(
      `posts:user:${userId}:${limit}:${offset}`,
      async () => {
        const result = await this.db.prepare(
          'SELECT * FROM posts WHERE creator_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
        ).bind(userId, limit, offset).all();
        return result.results;
      },
      { ttl: 60000, tags: ['posts', `posts:user:${userId}`] }
    );
  }

  /**
   * Get feed for user (cached)
   */
  async getFeed(userId, limit = 20, offset = 0) {
    return this.cache.query(
      `feed:${userId}:${limit}:${offset}`,
      async () => {
        const result = await this.db.prepare(`
          SELECT p.* FROM posts p
          WHERE p.creator_id IN (
            SELECT following_user_id FROM follows WHERE user_id = ?
          ) OR p.creator_id = ?
          ORDER BY p.created_at DESC
          LIMIT ? OFFSET ?
        `).bind(userId, userId, limit, offset).all();
        return result.results;
      },
      { ttl: 30000, tags: ['feed', `feed:${userId}`] }
    );
  }

  /**
   * Get conversation with caching
   */
  async getConversation(conversationId) {
    return this.cache.query(
      `conversation:${conversationId}`,
      async () => {
        const result = await this.db.prepare(
          'SELECT * FROM conversations WHERE id = ?'
        ).bind(conversationId).first();
        return result;
      },
      { ttl: 120000, tags: ['conversations', `conversation:${conversationId}`] }
    );
  }

  /**
   * Invalidate user cache (after update/delete)
   */
  invalidateUser(userId) {
    this.cache.invalidate(`user:${userId}`);
    this.cache.invalidate('users:'); // invalidate all user listings
    this.cache.invalidate('user-settings:');
    this.cache.invalidate('user-stats:');
    this.cache.invalidate('user-email:');
    this.cache.invalidate('user-username:');
    this.cache.invalidate('', 'users');
  }

  /**
   * Invalidate post cache
   */
  invalidatePost(postId, userId = null) {
    this.cache.invalidate(`post:${postId}`);
    this.cache.invalidate('posts:'); // invalidate all post listings
    if (userId) {
      this.cache.invalidate(`posts:user:${userId}`);
    }
  }

  /**
   * Invalidate feed cache
   */
  invalidateFeed(userId) {
    this.cache.invalidate(`feed:${userId}`);
  }

  /**
   * Invalidate conversation cache
   */
  invalidateConversation(conversationId) {
    this.cache.invalidate(`conversation:${conversationId}`);
  }

  /**
   * Invalidate by tag (batch invalidation)
   */
  invalidateByTag(tag) {
    this.cache.invalidate('', tag); // invalidate all with tag
  }

  /**
   * Get cache stats
   */
  getCacheStats() {
    return this.cache.getStats();
  }

  /**
   * Direct DB access (bypasses cache)
   */
  raw() {
    return this.db;
  }
}

// Create singleton instance
let cachedDB = null;

export function initCachedDB(db) {
  cachedDB = new CachedDB(db);
  return cachedDB;
}

export function getCachedDB(db) {
  if (!cachedDB && db) {
    cachedDB = new CachedDB(db);
  }
  return cachedDB;
}
