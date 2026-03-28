// ============================================
// SENSITIVE CONTENT HANDLER
// ============================================

import { now } from '../utils/helpers.js';

export class SensitiveContentHandler {
  constructor(db, cache) {
    this.db = db;
    this.cache = cache;
  }

  /**
   * Get sensitive settings in one query
   */
  async getSensitiveSettings(userId) {
    try {
      const settings = await this.db.prepare(`
        SELECT display_sensitive_content, suggest_sensitive_content, content_warnings
        FROM user_settings
        WHERE user_id = ?
      `).bind(userId).first();

      return {
        canViewSensitive: settings?.display_sensitive_content === 1,
        suggestSensitive: settings?.suggest_sensitive_content === 1,
        wantsWarnings: !settings || settings.content_warnings === 1,
      };
    } catch (error) {
      console.error('Get sensitive settings error:', error);
      return {
        canViewSensitive: false,
        suggestSensitive: false,
        wantsWarnings: true,
      };
    }
  }

  /**
   * Get actors followed by this user (both users and pages)
   */
  async getFollowedActors(userId) {
    try {
      const result = await this.db.prepare(`
        SELECT followee_type, followee_id
        FROM follows
        WHERE follower_type = 'user' AND follower_id = ?
      `).bind(userId).all();

      const followed = new Set();
      for (const row of result?.results || []) {
        followed.add(`${row.followee_type}:${row.followee_id}`);
      }
      return followed;
    } catch (error) {
      console.error('Get followed actors error:', error);
      return new Set();
    }
  }

  /**
   * Check if user can see sensitive content
   */
  async canViewSensitive(userId) {
    try {
      const settings = await this.db.prepare(`
        SELECT display_sensitive_content FROM user_settings WHERE user_id = ?
      `).bind(userId).first();

      return settings && settings.display_sensitive_content === 1;
    } catch (error) {
      console.error('Can view sensitive error:', error);
      return false;
    }
  }

  /**
   * Check if user allows sensitive suggestions
   */
  async allowsSensitiveSuggestions(userId) {
    try {
      const settings = await this.db.prepare(`
        SELECT display_sensitive_content, suggest_sensitive_content
        FROM user_settings WHERE user_id = ?
      `).bind(userId).first();

      return settings && 
             settings.display_sensitive_content === 1 && 
             settings.suggest_sensitive_content === 1;
    } catch (error) {
      console.error('Allows sensitive suggestions error:', error);
      return false;
    }
  }

  /**
   * Check if user wants content warnings
   */
  async wantsWarnings(userId) {
    try {
      const settings = await this.db.prepare(`
        SELECT content_warnings FROM user_settings WHERE user_id = ?
      `).bind(userId).first();

      return !settings || settings.content_warnings === 1;
    } catch (error) {
      console.error('Wants warnings error:', error);
      return true; // Default to showing warnings
    }
  }

  /**
   * Filter feed posts based on sensitive content settings
   * Rules:
   * - If show sensitive content is ON: show all sensitive unblurred.
   * - Else if suggest sensitive is ON: include sensitive suggestions (blurred).
   * - Else: include sensitive only from followed actors (and own posts), blurred.
   */
  async filterFeedPosts(posts, userId) {
    try {
      const {
        canViewSensitive,
        suggestSensitive,
        wantsWarnings,
      } = await this.getSensitiveSettings(userId);

      const followedActors = await this.getFollowedActors(userId);

      // Batch fetch pages owned by this user to check if they're posting as admin/owner
      const pageIds = [...new Set(posts.filter(p => p.actor_type === 'page').map(p => p.actor_id))];
      const ownedPages = new Set();
      if (pageIds.length > 0) {
        const placeholders = pageIds.map(() => '?').join(',');
        const pagesResult = await this.db.prepare(`
          SELECT id FROM pages WHERE owner_id = ? AND id IN (${placeholders})
        `).bind(userId, ...pageIds).all();
        for (const p of pagesResult.results || []) {
          ownedPages.add(p.id);
        }
      }

      return posts.flatMap((post) => {
        const isSensitive = post.is_sensitive === 1 || post.is_sensitive === true;
        if (!isSensitive) {
          return [{
            ...post,
            requiresWarning: false,
            isBlurred: false,
          }];
        }

        // Check if this is the viewer's own post (either as user or as page owner)
        let isOwnPost = false;
        if (post.actor_type === 'user' && String(post.actor_id) === String(userId)) {
          isOwnPost = true;
        } else if (post.actor_type === 'page' && ownedPages.has(post.actor_id)) {
          isOwnPost = true;
        }

        const actorKey = `${post.actor_type || 'user'}:${post.actor_id}`;
        const isFollowingActor = followedActors.has(actorKey);

        const shouldInclude =
          isOwnPost ||
          canViewSensitive ||
          suggestSensitive ||
          isFollowingActor;

        if (!shouldInclude) {
          return [];
        }

        const canSeeUnblurred = isOwnPost || canViewSensitive;

        return [{
          ...post,
          requiresWarning: wantsWarnings,
          isBlurred: !canSeeUnblurred,
        }];
      });
    } catch (error) {
      console.error('Filter feed posts error:', error);
      return posts; // Return unfiltered on error
    }
  }

  /**
   * Check if sensitive content should be suggested to user
   */
  async shouldSuggestSensitive(userId, post) {
    try {
      // Never suggest sensitive content unless user explicitly allows it
      if (post.is_sensitive) {
        return await this.allowsSensitiveSuggestions(userId);
      }
      return true;
    } catch (error) {
      console.error('Should suggest sensitive error:', error);
      return false;
    }
  }

  /**
   * Activate sensitive-only mode for reels
   */
  async activateSensitiveMode(userId, reelId) {
    try {
      const reel = await this.db.prepare(`
        SELECT is_sensitive FROM reels WHERE id = ?
      `).bind(reelId).first();

      if (!reel || !reel.is_sensitive) {
        return false;
      }

      const allows = await this.allowsSensitiveSuggestions(userId);
      if (!allows) {
        return false;
      }

      // Store in cache for session duration
      await this.cache.put(
        `sensitive_mode:${userId}`,
        reelId,
        { expirationTtl: 3600 } // 1 hour
      );

      return true;
    } catch (error) {
      console.error('Activate sensitive mode error:', error);
      return false;
    }
  }

  /**
   * Check if user is in sensitive-only mode
   */
  async isInSensitiveMode(userId) {
    try {
      const mode = await this.cache.get(`sensitive_mode:${userId}`);
      return Boolean(mode);
    } catch (error) {
      console.error('Is in sensitive mode error:', error);
      return false;
    }
  }

  /**
   * Deactivate sensitive mode
   */
  async deactivateSensitiveMode(userId) {
    try {
      await this.cache.delete(`sensitive_mode:${userId}`);
    } catch (error) {
      console.error('Deactivate sensitive mode error:', error);
    }
  }

  /**
   * Filter reels based on sensitive mode
   * Uses 1:30 ratio for sensitive content to maximize ad revenue
   */
  async filterReels(reels, userId) {
    try {
      const isInSensitiveMode = await this.isInSensitiveMode(userId);

      if (isInSensitiveMode) {
        // Only show sensitive reels when in sensitive mode
        return reels.filter(reel => reel.is_sensitive === 1);
      }

      // Apply normal sensitive content filters with 1:30 ratio
      const canView = await this.canViewSensitive(userId);
      const allows = await this.allowsSensitiveSuggestions(userId);

      // Separate sensitive and normal reels
      const sensitiveReels = [];
      const normalReels = [];

      for (const reel of reels) {
        if (reel.is_sensitive === 1 || reel.is_sensitive === true) {
          if (canView && allows) {
            sensitiveReels.push(reel);
          }
        } else {
          normalReels.push(reel);
        }
      }

      // Build final list with 1:30 ratio
      const SENSITIVE_RATIO = 30;
      const result = [];
      let normalCount = 0;
      let sensitiveIndex = 0;

      for (const reel of normalReels) {
        result.push(reel);
        normalCount++;

        if (normalCount >= SENSITIVE_RATIO && sensitiveIndex < sensitiveReels.length) {
          result.push(sensitiveReels[sensitiveIndex]);
          sensitiveIndex++;
          normalCount = 0;
        }
      }

      return result;
    } catch (error) {
      console.error('Filter reels error:', error);
      return reels;
    }
  }

  /**
   * Blur sensitive media in response
   */
  blurSensitiveMedia(posts, userId, canView) {
    return posts.map(post => {
      if (post.is_sensitive && !canView) {
        return {
          ...post,
          media_urls: post.media_urls ? post.media_urls.map(() => 'BLURRED') : null,
          isBlurred: true,
          requiresExplicitView: true
        };
      }
      return post;
    });
  }

  /**
   * Check if post should be excluded from trending
   */
  shouldExcludeFromTrending(post) {
    // Sensitive content is never eligible for trending
    return post.is_sensitive === 1;
  }
}

/**
 * Trending Safety Filter
 */
export class TrendingSafetyFilter {
  constructor(db) {
    this.db = db;
  }

  /**
   * Filter trending posts for safety
   */
  async filterTrendingPosts(posts) {
    try {
      // Remove sensitive posts from trending
      const filtered = posts.filter(post => {
        return !post.is_sensitive;
      });

      // Remove posts from banned/suspended users
      const banCheckPromises = filtered.map(post =>
        this.db.prepare(`
          SELECT COUNT(*) as count FROM bans
          WHERE target_type = ? AND target_id = ?
            AND (permanent = 1 OR expires_at > ?)
        `).bind(post.actor_type, post.actor_id, now()).first()
      );

      const banResults = await Promise.all(banCheckPromises);
      const safe = filtered.filter((post, index) => banResults[index].count === 0);

      return safe;
    } catch (error) {
      console.error('Filter trending posts error:', error);
      return posts;
    }
  }

  /**
   * Filter trending topics for safety
   */
  filterTrendingTopics(topics) {
    try {
      if (!Array.isArray(topics) || topics.length === 0) return topics;

      // Conservative banned-topic patterns (extendable later)
      const bannedPatterns = [
        /\bnsfw\b/i,
        /\b18\+\b/i,
        /\bporn\b/i,
        /\bxxx\b/i,
        /\bgore\b/i,
        /\bviolence\b/i,
        /\bself\s*harm\b/i,
        /\bsuicide\b/i,
      ];

      const isSafeTopic = (name = '') => !bannedPatterns.some((re) => re.test(name));

      return topics.filter((topic) => {
        const name = typeof topic === 'string' ? topic : (topic.name || topic.tag || '');
        return isSafeTopic(name);
      });
    } catch (error) {
      console.error('Filter trending topics error:', error);
      return topics;
    }
  }
}
