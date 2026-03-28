// ============================================
// DATABASE SERVICE
// ============================================

import { generateId, now, sanitizeText } from '../utils/helpers.js';
import { DbRouter } from './dbRouter.js';

/**
 * ============================================================
 * MULTI-DATABASE ROUTING STRATEGY
 * ============================================================
 * 
 * Architecture:
 * - DB1 (PRIMARY): All writes (INSERT/UPDATE/DELETE) go here
 * - DB2 (ANALYTICS): Read-only replica, contains analytics data
 * - DB3 (ARCHIVE): Read-only archive of old/deleted records
 * 
 * CRITICAL RULE for data consistency:
 * 
 * ⚠️  AFTER ANY WRITE OPERATION, ALWAYS READ FROM PRIMARY DB ONLY ⚠️ 
 * 
 * Example - CORRECT:
 *   await this.db.prepare('UPDATE posts SET ... WHERE id = ?').run();
 *   return await this.db.prepare('SELECT * FROM posts WHERE id = ?').first();
 *   // ✅ Reads from primary (this.db is primary)
 * 
 * Example - WRONG:
 *   await this.db.prepare('UPDATE posts SET ... WHERE id = ?').run();
 *   return this.getPostById(postId);
 *   // ❌ getPostById() searches primary → analytics → archive
 *   // Can return stale data if read hits replica before sync
 * 
 * Methods that search multiple DBs (safe for independent lookups):
 * - getPostById()     - searches: primary → analytics → archive
 * - getPageById()     - single-target lookup (safe)
 * - getUserById()     - single-target lookup (safe)
 * 
 * Write-then-read patterns that have been fixed:
 * - updatePost()      - reads directly from primary DB after UPDATE
 * - deletePost()      - deletes from primary DB, then cleans up replicas
 * - updatePage()      - reads directly from primary DB after UPDATE
 * - updateUser()      - reads directly from primary DB after UPDATE
 * - updateUserSettings() - reads directly from primary DB after UPDATE
 * 
 * If adding new write operations, ensure they read from this.db (primary)
 * immediately after, NOT through multi-DB routing methods.
 * ============================================================
 */

/**
 * Database service wrapper for D1 (via DbRouter)
 */
export class DatabaseService {
  constructor(db, router = null) {
    this.db = db;
    this.router = router;
  }

  /**
   * Factory to construct the appropriate DatabaseService for a given environment.
   * This now goes through DbRouter so we have a single place to plug in
   * sharding or alternate database adapters later without touching controllers.
   */
  static fromEnv(env) {
    const router = DbRouter.fromEnv(env);
    const primaryDb = router.getPrimaryDb();
    return new DatabaseService(primaryDb, router);
  }

  // ============================================
  // USER QUERIES
  // ============================================

  async createUser(data) {
    const userId = generateId('u');
    const timestamp = now();
    
    await this.db.prepare(`
      INSERT INTO users (
        id, email, username, password_hash, name, 
        preferred_language, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userId,
      data.email.toLowerCase(),
      data.username.toLowerCase(),
      data.passwordHash,
      sanitizeText(data.name, 50),
      data.language || 'en',
      timestamp,
      timestamp
    ).run();

    // Create default settings
    await this.createUserSettings(userId);

    return this.getUserById(userId);
  }

  async getUserById(userId) {
    return await this.db.prepare(`
      SELECT * FROM users WHERE id = ?
    `).bind(userId).first();
  }

  async getUserByEmail(email) {
    return await this.db.prepare(`
      SELECT * FROM users WHERE email = ?
    `).bind(email.toLowerCase()).first();
  }

  async getUserByUsername(username) {
    return await this.db.prepare(`
      SELECT * FROM users WHERE username = ?
    `).bind(username.toLowerCase()).first();
  }

  async updateUser(userId, data) {
    const { updates, values } = this.buildUserUpdateQuery(data);
    values.push(userId);

    await this.db.prepare(`
      UPDATE users SET ${updates.join(', ')} WHERE id = ?
    `).bind(...values).run();

    // Ensure write propagation before reading
    const result = await this.db.prepare(`
      SELECT * FROM users WHERE id = ?
    `).bind(userId).first();
    
    return result;
  }

  buildUserUpdateQuery(data) {
    const updates = [];
    const values = [];

    if (data.name !== undefined && data.name !== null) {
      updates.push('name = ?');
      values.push(sanitizeText(data.name, 50));
    }
    if (data.bio !== undefined && data.bio !== null) {
      updates.push('bio = ?');
      values.push(sanitizeText(data.bio, 150));
    }
    if (data.website !== undefined && data.website !== null) {
      updates.push('website = ?');
      values.push(data.website);
    }
    if (data.location !== undefined && data.location !== null) {
      updates.push('location = ?');
      values.push(sanitizeText(data.location, 50));
    }
    if (data.dateOfBirth !== undefined && data.dateOfBirth !== null) {
      updates.push('date_of_birth = ?');
      values.push(data.dateOfBirth);
    }
    if (data.gender !== undefined && data.gender !== null) {
      updates.push('gender = ?');
      values.push(data.gender);
    }
    if (data.avatarUrl !== undefined) {
      updates.push('avatar_url = ?');
      values.push(data.avatarUrl);
    }
    if (data.coverUrl !== undefined) {
      updates.push('cover_url = ?');
      values.push(data.coverUrl);
    }
    if (data.cloudflareAvatarId !== undefined) {
      updates.push('cloudflare_avatar_id = ?');
      values.push(data.cloudflareAvatarId);
    }
    if (data.cloudflareCoverId !== undefined) {
      updates.push('cloudflare_cover_id = ?');
      values.push(data.cloudflareCoverId);
    }

    updates.push('updated_at = ?');
    values.push(now());

    return { updates, values };
  }

  async deleteUser(userId) {
    await this.db.prepare(`
      DELETE FROM users WHERE id = ?
    `).bind(userId).run();
  }

  // ============================================
  // PAGE QUERIES
  // ============================================

  async createPage(ownerId, data) {
    const pageId = generateId('p');
    const timestamp = now();

    await this.db.prepare(`
      INSERT INTO pages (
        id, owner_id, name, bio, avatar_url, cover_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      pageId,
      ownerId,
      sanitizeText(data.name, 50),
      sanitizeText(data.bio, 150),
      data.avatarUrl || null,
      data.coverUrl || null,
      timestamp,
      timestamp
    ).run();

    return this.getPageById(pageId);
  }

  async getPageById(pageId) {
    return await this.db.prepare(`
      SELECT id, name, bio, avatar_url, cover_url, verified, created_at, updated_at
      FROM pages WHERE id = ?
    `).bind(pageId).first();
  }

  async getUserPages(userId) {
    const result = await this.db.prepare(`
      SELECT id, name, bio, avatar_url, cover_url, verified, created_at, updated_at
      FROM pages WHERE owner_id = ? ORDER BY created_at DESC
    `).bind(userId).all();

    return result.results || [];
  }

  async updatePage(pageId, data) {
    const updates = [];
    const values = [];

    if (data.name) {
      updates.push('name = ?');
      values.push(sanitizeText(data.name, 50));
    }
    if (data.bio !== undefined) {
      updates.push('bio = ?');
      values.push(sanitizeText(data.bio, 150));
    }
    if (data.avatarUrl !== undefined) {
      updates.push('avatar_url = ?');
      values.push(data.avatarUrl);
    }
    if (data.coverUrl !== undefined) {
      updates.push('cover_url = ?');
      values.push(data.coverUrl);
    }

    updates.push('updated_at = ?');
    values.push(now());

    values.push(pageId);

    await this.db.prepare(`
      UPDATE pages SET ${updates.join(', ')} WHERE id = ?
    `).bind(...values).run();

    // Read from primary DB to ensure fresh data
    return await this.db.prepare(`
      SELECT id, name, bio, avatar_url, cover_url, verified, created_at, updated_at
      FROM pages WHERE id = ?
    `).bind(pageId).first();
  }

  async deletePage(pageId) {
    await this.db.prepare(`
      DELETE FROM pages WHERE id = ?
    `).bind(pageId).run();
  }

  async isPageOwner(pageId, userId) {
    const page = await this.db.prepare(`
      SELECT owner_id FROM pages WHERE id = ?
    `).bind(pageId).first();

    return page && page.owner_id === userId;
  }

  // ============================================
  // POST QUERIES
  // ============================================

  async createPost(data) {
    const postId = generateId('post');
    const timestamp = now();

    await this.db.prepare(`
      INSERT INTO posts (
        id, actor_type, actor_id, content, media_type, media_urls,
        cloudflare_image_ids, cloudflare_video_ids, language, is_sensitive, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      postId,
      data.actorType,
      data.actorId,
      sanitizeText(data.content, 5000),
      data.mediaType || null,
      data.mediaUrls ? JSON.stringify(data.mediaUrls) : null,
      data.cloudflareImageIds ? JSON.stringify(data.cloudflareImageIds) : null,
      data.cloudflareVideoIds ? JSON.stringify(data.cloudflareVideoIds) : null,
      data.language || 'en',
      data.isSensitive ? 1 : 0,
      timestamp,
      timestamp
    ).run();

    // Read from primary DB directly (not multi-DB routing)
    // to ensure we get fresh data immediately after insert
    const post = await this.db.prepare(`
      SELECT * FROM posts WHERE id = ?
    `).bind(postId).first();

    if (post && post.media_urls) {
      try {
        post.media_urls = JSON.parse(post.media_urls);
      } catch {
        post.media_urls = [];
      }
    }

    if (post && post.cloudflare_image_ids) {
      try {
        post.cloudflare_image_ids = JSON.parse(post.cloudflare_image_ids);
      } catch {
        post.cloudflare_image_ids = [];
      }
    }

    if (post && post.cloudflare_video_ids) {
      try {
        post.cloudflare_video_ids = JSON.parse(post.cloudflare_video_ids);
      } catch {
        post.cloudflare_video_ids = [];
      }
    }

    return post;
  }


  async getPostById(postId) {
    // Try primary DB first
    let post = await this.db.prepare(`
      SELECT * FROM posts WHERE id = ?
    `).bind(postId).first();

    // If not found and we have access to other DBs, check them
    if (!post && this.router) {
      // Try analytics DB (DB2)
      const analyticsDb = this.router.getAnalyticsDb();
      if (analyticsDb && analyticsDb !== this.db) {
        try {
          post = await analyticsDb.prepare(`
            SELECT * FROM posts WHERE id = ?
          `).bind(postId).first();
        } catch (_e) {
          // Table might not exist in this DB
        }
      }

      // Try archive DB (DB3)
      if (!post) {
        const archiveDb = this.router.getArchiveDb();
        if (archiveDb && archiveDb !== this.db) {
          try {
            post = await archiveDb.prepare(`
              SELECT * FROM posts WHERE id = ?
            `).bind(postId).first();
          } catch (_e) {
            // Table might not exist in this DB
          }
        }
      }
    }

    if (post && post.media_urls) {
      try {
        post.media_urls = JSON.parse(post.media_urls);
      } catch {
        post.media_urls = [];
      }
    }

    if (post) {
      const [withCounts] = await this.attachEngagementCounts([post]);
      return withCounts;
    }

    return post;
  }

  async updatePost(postId, data) {
    const updates = [];
    const values = [];

    if (data.content !== undefined) {
      updates.push('content = ?');
      values.push(sanitizeText(data.content, 5000));
    }
    if (data.mediaType !== undefined) {
      updates.push('media_type = ?');
      values.push(data.mediaType || null);
    }
    if (data.mediaUrls !== undefined) {
      updates.push('media_urls = ?');
      values.push(data.mediaUrls ? JSON.stringify(data.mediaUrls) : null);
    }
    if (data.language !== undefined) {
      updates.push('language = ?');
      values.push(data.language || 'en');
    }
    if (data.isSensitive !== undefined) {
      updates.push('is_sensitive = ?');
      values.push(data.isSensitive ? 1 : 0);
    }

    if (updates.length === 0) {
      return this.getPostById(postId);
    }

    updates.push('updated_at = ?');
    values.push(now());
    values.push(postId);

    await this.db.prepare(`
      UPDATE posts SET ${updates.join(', ')} WHERE id = ?
    `).bind(...values).run();

    // Read from primary DB directly (not multi-DB routing)
    const post = await this.db.prepare(`
      SELECT * FROM posts WHERE id = ?
    `).bind(postId).first();

    if (post && post.media_urls) {
      try {
        post.media_urls = JSON.parse(post.media_urls);
      } catch {
        post.media_urls = [];
      }
    }

    return post;
  }

  async deletePost(postId) {
    // Delete from primary DB
    const result = await this.db.prepare(`
      DELETE FROM posts WHERE id = ?
    `).bind(postId).run();

    // If record was in primary DB, also remove from analytics/archive for cleanup
    if (result.meta?.changes > 0 && this.router) {
      // Try analytics DB (DB2) - but don't fail if not found
      const analyticsDb = this.router.getAnalyticsDb();
      if (analyticsDb && analyticsDb !== this.db) {
        try {
          await analyticsDb.prepare(`
            DELETE FROM posts WHERE id = ?
          `).bind(postId).run();
        } catch (_e) {
          // Table might not exist or record not in this DB
        }
      }

      // Try archive DB (DB3) - but don't fail if not found
      const archiveDb = this.router.getArchiveDb();
      if (archiveDb && archiveDb !== this.db) {
        try {
          await archiveDb.prepare(`
            DELETE FROM posts WHERE id = ?
          `).bind(postId).run();
        } catch (_e) {
          // Table might not exist or record not in this DB
        }
      }
    }
  }

  async incrementPostLikes(postId, increment = 1) {
    await this.db.prepare(`
      UPDATE posts SET likes_count = COALESCE(likes_count, 0) + ? WHERE id = ?
    `).bind(increment, postId).run();
  }

  async incrementPostComments(postId, increment = 1) {
    await this.db.prepare(`
      UPDATE posts SET comments_count = COALESCE(comments_count, 0) + ? WHERE id = ?
    `).bind(increment, postId).run();
  }

  async incrementPostShares(postId, increment = 1) {
    await this.db.prepare(`
      UPDATE posts SET shares_count = COALESCE(shares_count, 0) + ? WHERE id = ?
    `).bind(increment, postId).run();
  }

  async incrementPostBookmarks(postId, increment = 1) {
    await this.db.prepare(`
      UPDATE posts SET bookmarks_count = COALESCE(bookmarks_count, 0) + ? WHERE id = ?
    `).bind(increment, postId).run();
  }

  async getPostEngagementCounts(postIds) {
    const ids = [...new Set((postIds || []).map((id) => String(id)).filter(Boolean))];
    if (ids.length === 0) {
      return { likes: new Map(), comments: new Map(), shares: new Map() };
    }

    const placeholders = ids.map(() => '?').join(',');

    const [likesResult, commentsResult, sharesResult] = await Promise.all([
      this.db.prepare(`
        SELECT target_id as id, COUNT(*) as count
        FROM likes
        WHERE target_type = 'post' AND target_id IN (${placeholders})
        GROUP BY target_id
      `).bind(...ids).all(),
      this.db.prepare(`
        SELECT post_id as id, COUNT(*) as count
        FROM comments
        WHERE post_id IN (${placeholders})
        GROUP BY post_id
      `).bind(...ids).all(),
      this.db.prepare(`
        SELECT original_post_id as id, COUNT(*) as count
        FROM shares
        WHERE original_post_id IN (${placeholders})
        GROUP BY original_post_id
      `).bind(...ids).all()
    ]);

    const toMap = (rows) => new Map((rows || []).map((row) => [String(row.id), Number(row.count) || 0]));

    return {
      likes: toMap(likesResult?.results || []),
      comments: toMap(commentsResult?.results || []),
      shares: toMap(sharesResult?.results || [])
    };
  }

  async attachEngagementCounts(posts) {
    if (!Array.isArray(posts) || posts.length === 0) return posts;

    const ids = posts.map((post) => post?.id).filter(Boolean);
    const counts = await this.getPostEngagementCounts(ids);

    return posts.map((post) => {
      if (!post || !post.id) return post;
      const id = String(post.id);
      const likesCount = counts.likes.has(id)
        ? counts.likes.get(id)
        : (post.likes_count ?? post.likes ?? 0);
      const commentsCount = counts.comments.has(id)
        ? counts.comments.get(id)
        : (post.comments_count ?? post.comments ?? 0);
      const sharesCount = counts.shares.has(id)
        ? counts.shares.get(id)
        : (post.shares_count ?? post.shares ?? 0);

      return {
        ...post,
        likes_count: likesCount,
        comments_count: commentsCount,
        shares_count: sharesCount
      };
    });
  }

  // ============================================
  // SETTINGS QUERIES
  // ============================================

  async createUserSettings(userId) {
    const timestamp = now();

    await this.db.prepare(`
      INSERT INTO user_settings (
        id, user_id,
        private_account, who_can_comment, who_can_message,
        notifications_email, notifications_push, notifications_in_app,
        notify_likes, notify_comments, notify_follows, notify_mentions, notify_messages, notify_shares,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      generateId('settings'),
      userId,
      0,
      'everyone',
      'everyone',
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      timestamp,
      timestamp,
    ).run();
  }

  async getUserSettings(userId) {
    return await this.db.prepare(`
      SELECT * FROM user_settings WHERE user_id = ?
    `).bind(userId).first();
  }

  async updateUserSettings(userId, data) {
    const existing = await this.getUserSettings(userId);
    if (!existing) {
      await this.createUserSettings(userId);
    }

    const normalizeSettingsPayload = (input = {}) => ({
      privateAccount: input.privateAccount ?? input.private_account,
      whoCanMessage: input.whoCanMessage ?? input.who_can_message,
      whoCanComment: input.whoCanComment ?? input.who_can_comment,
      whoCanTag: input.whoCanTag ?? input.who_can_tag,
      showActivityStatus: input.showActivityStatus ?? input.show_activity_status,
      displaySensitiveContent: input.displaySensitiveContent ?? input.display_sensitive_content,
      suggestSensitiveContent: input.suggestSensitiveContent ?? input.suggest_sensitive_content,
      contentWarnings: input.contentWarnings ?? input.content_warnings,
      notificationsEmail: input.notificationsEmail ?? input.notifications_email,
      notificationsPush: input.notificationsPush ?? input.notifications_push,
      notificationsInApp: input.notificationsInApp ?? input.notifications_in_app,
      notifyLikes: input.notifyLikes ?? input.notify_likes,
      notifyComments: input.notifyComments ?? input.notify_comments,
      notifyFollows: input.notifyFollows ?? input.notify_follows,
      notifyMentions: input.notifyMentions ?? input.notify_mentions,
      notifyMessages: input.notifyMessages ?? input.notify_messages,
      notifyShares: input.notifyShares ?? input.notify_shares,
      fontSize: input.fontSize ?? input.font_size,
      highContrast: input.highContrast ?? input.high_contrast,
      reducedMotion: input.reducedMotion ?? input.reduced_motion,
      screenReader: input.screenReader ?? input.screen_reader,
      preferredLanguage: input.preferredLanguage ?? input.preferred_language,
      autoplayWifi: input.autoplayWifi ?? input.autoplay_wifi ?? input.mediaAutoplayWifi,
      mediaAutoplayMobile: input.mediaAutoplayMobile ?? input.media_autoplay_mobile,
      dataSaverMode: input.dataSaverMode ?? input.data_saver_mode,
      topicInterests: input.topicInterests ?? input.topic_interests,
      captionsForVideos: input.captionsForVideos ?? input.captions_for_videos,
    });

    const payload = normalizeSettingsPayload(data);

    const updates = [];
    const values = [];

    // Privacy settings
    if (payload.privateAccount !== undefined) {
      updates.push('private_account = ?');
      values.push(payload.privateAccount ? 1 : 0);
    }
    if (payload.whoCanMessage !== undefined) {
      updates.push('who_can_message = ?');
      values.push(payload.whoCanMessage);
    }
    if (payload.whoCanComment !== undefined) {
      updates.push('who_can_comment = ?');
      values.push(payload.whoCanComment);
    }
    if (payload.whoCanTag !== undefined) {
      updates.push('who_can_tag = ?');
      values.push(payload.whoCanTag);
    }
    if (payload.showActivityStatus !== undefined) {
      updates.push('show_activity_status = ?');
      values.push(payload.showActivityStatus ? 1 : 0);
    }

    // Sensitive content
    if (payload.displaySensitiveContent !== undefined) {
      updates.push('display_sensitive_content = ?');
      values.push(payload.displaySensitiveContent ? 1 : 0);
    }
    if (payload.suggestSensitiveContent !== undefined) {
      updates.push('suggest_sensitive_content = ?');
      values.push(payload.suggestSensitiveContent ? 1 : 0);
    }
    if (payload.contentWarnings !== undefined) {
      updates.push('content_warnings = ?');
      values.push(payload.contentWarnings ? 1 : 0);
    }

    // Notifications
    if (payload.notificationsEmail !== undefined) {
      updates.push('notifications_email = ?');
      values.push(payload.notificationsEmail ? 1 : 0);
    }
    if (payload.notificationsPush !== undefined) {
      updates.push('notifications_push = ?');
      values.push(payload.notificationsPush ? 1 : 0);
    }
    if (payload.notificationsInApp !== undefined) {
      updates.push('notifications_in_app = ?');
      values.push(payload.notificationsInApp ? 1 : 0);
    }
    if (payload.notifyLikes !== undefined) {
      updates.push('notify_likes = ?');
      values.push(payload.notifyLikes ? 1 : 0);
    }
    if (payload.notifyComments !== undefined) {
      updates.push('notify_comments = ?');
      values.push(payload.notifyComments ? 1 : 0);
    }
    if (payload.notifyFollows !== undefined) {
      updates.push('notify_follows = ?');
      values.push(payload.notifyFollows ? 1 : 0);
    }
    if (payload.notifyMentions !== undefined) {
      updates.push('notify_mentions = ?');
      values.push(payload.notifyMentions ? 1 : 0);
    }
    if (payload.notifyMessages !== undefined) {
      updates.push('notify_messages = ?');
      values.push(payload.notifyMessages ? 1 : 0);
    }
    if (payload.notifyShares !== undefined) {
      updates.push('notify_shares = ?');
      values.push(payload.notifyShares ? 1 : 0);
    }

    // Accessibility
    if (payload.fontSize !== undefined && payload.fontSize !== null) {
      const normalizedFontSize = payload.fontSize === 'default' ? 'medium' : payload.fontSize;
      const allowedFontSizes = new Set(['small', 'medium', 'large']);
      if (allowedFontSizes.has(normalizedFontSize)) {
        updates.push('font_size = ?');
        values.push(normalizedFontSize);
      }
    }
    if (payload.highContrast !== undefined) {
      updates.push('high_contrast = ?');
      values.push(payload.highContrast ? 1 : 0);
    }
    if (payload.reducedMotion !== undefined) {
      updates.push('reduced_motion = ?');
      values.push(payload.reducedMotion ? 1 : 0);
    }
    if (payload.screenReader !== undefined) {
      updates.push('screen_reader = ?');
      values.push(payload.screenReader ? 1 : 0);
    }

    // Language
    if (payload.preferredLanguage !== undefined && payload.preferredLanguage !== null) {
      updates.push('preferred_language = ?');
      values.push(payload.preferredLanguage);
    }

    // Media and data settings
    if (payload.autoplayWifi !== undefined) {
      updates.push('autoplay_wifi = ?');
      values.push(payload.autoplayWifi ? 1 : 0);
    }
    if (payload.mediaAutoplayMobile !== undefined) {
      updates.push('media_autoplay_mobile = ?');
      values.push(payload.mediaAutoplayMobile ? 1 : 0);
    }
    if (payload.dataSaverMode !== undefined) {
      updates.push('data_saver_mode = ?');
      values.push(payload.dataSaverMode ? 1 : 0);
    }
    if (payload.topicInterests !== undefined) {
      updates.push('topic_interests = ?');
      values.push(payload.topicInterests ? 1 : 0);
    }
    if (payload.captionsForVideos !== undefined) {
      updates.push('captions_for_videos = ?');
      values.push(payload.captionsForVideos ? 1 : 0);
    }

    // Add updated_at timestamp
    if (updates.length > 0) {
      updates.push('updated_at = ?');
      values.push(now());
      values.push(userId);

      const query = `UPDATE user_settings SET ${updates.join(', ')} WHERE user_id = ?`;
      console.log('[DB] Settings update:', {
        userId,
        fieldsCount: updates.length,
        fields: updates.slice(0, -1), // exclude 'updated_at' for clarity
        valuesCount: values.length,
      });
      
      try {
        const result = await this.db.prepare(query).bind(...values).run();
        console.log('[DB] ✓ Settings updated successfully:', {
          userId,
          affectedRows: result?.meta?.changes || 'unknown',
          duration: result?.meta?.duration || 'unknown',
        });
      } catch (error) {
        console.error('[DB] ✗ Settings update failed:', {
          userId,
          error: error.message,
          query: query.substring(0, 100),
        });
        throw error;
      }
    } else {
      console.log('[DB] ⚠ No settings to update for user:', userId, 'payload:', data);
    }

    // Read from primary DB to ensure fresh data (write must commit first)
    const updatedSettings = await this.db.prepare(`
      SELECT * FROM user_settings WHERE user_id = ?
    `).bind(userId).first();
    
    return updatedSettings;
  }
}
