// Search, Settings, Notifications, Reports, Admin Controllers
import { DatabaseService } from '../services/database.js';
import { generateId, errorResponse, successResponse, now, parseCursor, createCursor, safeParseInt } from '../utils/helpers.js';
import { validateBanUser, validateAdminPermissions, safeJsonParse, isValidTableName } from '../utils/validation.js';
import { AdService } from '../services/adService.js';
import { SensitiveContentHandler } from '../services/sensitiveContent.js';
import { createNotification } from '../services/notifications.js';
import { CloudflareMediaCleaner } from '../utils/cloudflare-media.js';

// SEARCH CONTROLLER
export class SearchController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
    this.adService = new AdService(env.DB, env.CACHE);
    this.sensitiveHandler = new SensitiveContentHandler(env.DB, env.CACHE);
  }

  async search(request, userId) {
    try {
      const url = new URL(request.url);
      const query = url.searchParams.get('q');
      const type = url.searchParams.get('type') || 'all';
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');
      const sortBy = url.searchParams.get('sort') || 'relevance'; // relevance, recent, popular

      if (!query) {
        return errorResponse('Search query required', 400);
      }

      const results = {};
      const pagination = { hasMore: false, nextCursor: null };

      // Parse cursor for pagination
      let cursorData = null;
      if (cursor) {
        try {
          cursorData = JSON.parse(Buffer.from(cursor, 'base64').toString());
        } catch (e) {
          return errorResponse('Invalid cursor', 400);
        }
      }

      if (type === 'users' || type === 'all') {
        const escapedQuery = query.replace(/[%_]/g, '\\$&');
        let usersQuery = `
          SELECT id, username, name, avatar_url, verified,
                 (CASE
                   WHEN username LIKE ? THEN 3
                   WHEN name LIKE ? THEN 2
                   ELSE 1
                 END) as relevance_score
          FROM users
          WHERE (username LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
            AND NOT EXISTS (
              SELECT 1 FROM blocks b
              WHERE b.blocker_type = 'user' AND b.blocker_id = ? AND b.blocked_type = 'user' AND b.blocked_id = users.id
            )
        `;

        const bindParams = [`${escapedQuery}%`, `${escapedQuery}%`, `%${escapedQuery}%`, `%${escapedQuery}%`, userId];

        // Add cursor condition for pagination
        if (cursorData && cursorData.users) {
          usersQuery += ` AND (relevance_score < ? OR (relevance_score = ? AND id < ?))`;
          bindParams.push(cursorData.users.score, cursorData.users.score, cursorData.users.id);
        }

        // Order by relevance score and ID for consistent pagination
        usersQuery += ` ORDER BY relevance_score DESC, id DESC LIMIT ?`;
        bindParams.push(limit + 1); // +1 to check if there are more results

        const users = await this.env.DB.prepare(usersQuery).bind(...bindParams).all();
        const userResults = users.results || [];

        // Check if there are more results
        if (userResults.length > limit) {
          pagination.hasMore = true;
          userResults.pop(); // Remove the extra result
        }

        // Set next cursor if there are more results
        if (pagination.hasMore && userResults.length > 0) {
          const lastUser = userResults[userResults.length - 1];
          pagination.nextCursor = Buffer.from(JSON.stringify({
            users: { id: lastUser.id, score: lastUser.relevance_score }
          })).toString('base64');
        }

        results.users = userResults;
      }

      if (type === 'pages' || type === 'all') {
        let pagesQuery = `
          SELECT id, name, avatar_url, verified
          FROM pages
          WHERE name LIKE ?
        `;

        const bindParams = [`%${query}%`];

        // Add cursor condition for pagination
        if (cursorData && cursorData.pages) {
          pagesQuery += ` AND id < ?`;
          bindParams.push(cursorData.pages.id);
        }

        pagesQuery += ` ORDER BY id DESC LIMIT ?`;
        bindParams.push(limit + 1);

        const pages = await this.env.DB.prepare(pagesQuery).bind(...bindParams).all();
        const pageResults = pages.results || [];

        if (pageResults.length > limit) {
          pagination.hasMore = true;
          pageResults.pop();
        }

        if (pagination.hasMore && pageResults.length > 0) {
          const lastPage = pageResults[pageResults.length - 1];
          const cursorObj = pagination.nextCursor ? JSON.parse(Buffer.from(pagination.nextCursor, 'base64').toString()) : {};
          cursorObj.pages = { id: lastPage.id };
          pagination.nextCursor = Buffer.from(JSON.stringify(cursorObj)).toString('base64');
        }

        results.pages = pageResults;
      }

      if (type === 'posts' || type === 'all') {
        let postsQuery = `
          SELECT p.*,
            CASE WHEN p.actor_type = 'user' THEN u.username ELSE NULL END as username,
            CASE WHEN p.actor_type = 'user' THEN u.name WHEN p.actor_type = 'page' THEN pg.name END as actor_name,
            CASE WHEN p.actor_type = 'user' THEN u.avatar_url WHEN p.actor_type = 'page' THEN pg.avatar_url END as avatar_url,
            CASE WHEN p.actor_type = 'user' THEN u.verified WHEN p.actor_type = 'page' THEN pg.verified END as verified,
            CASE WHEN ? = 'recent' THEN p.created_at
                 WHEN ? = 'popular' THEN (COALESCE(p.likes_count, 0) + COALESCE(p.comments_count, 0) + COALESCE(p.shares_count, 0))
                 ELSE (CASE
                   WHEN p.content LIKE ? THEN 3
                   WHEN p.content LIKE ? THEN 2
                   ELSE 1
                 END)
            END as sort_value
          FROM posts p
          LEFT JOIN users u ON p.actor_type = 'user' AND p.actor_id = u.id
          LEFT JOIN pages pg ON p.actor_type = 'page' AND p.actor_id = pg.id
          WHERE p.content LIKE ?
        `;

        const bindParams = [sortBy, sortBy, `${query}%`, `%${query}%`, `%${query}%`];

        // Add cursor condition for pagination
        if (cursorData && cursorData.posts) {
          postsQuery += ` AND (sort_value < ? OR (sort_value = ? AND p.id < ?))`;
          bindParams.push(cursorData.posts.sortValue, cursorData.posts.sortValue, cursorData.posts.id);
        }

        // Order by sort value and ID for consistent pagination
        const sortDirection = sortBy === 'recent' ? 'DESC' : 'DESC'; // Both relevance and popular use DESC
        postsQuery += ` ORDER BY sort_value ${sortDirection}, p.id DESC LIMIT ?`;
        bindParams.push(limit + 1);

        const posts = await this.env.DB.prepare(postsQuery).bind(...bindParams).all();
        let postResults = posts.results || [];

        if (postResults.length > 0) {
          postResults = await this.db.attachEngagementCounts(postResults);
          // Enrich posts with actor objects
          postResults = postResults.map(post => ({
            ...post,
            actor: {
              id: post.actor_id,
              username: post.username || null,
              name: post.actor_name || null,
              avatar_url: post.avatar_url || null,
              verified: post.verified || 0
            }
          }));
        }

        if (postResults.length > limit) {
          pagination.hasMore = true;
          postResults.pop();
        }

        if (pagination.hasMore && postResults.length > 0) {
          const lastPost = postResults[postResults.length - 1];
          const cursorObj = pagination.nextCursor ? JSON.parse(Buffer.from(pagination.nextCursor, 'base64').toString()) : {};
          cursorObj.posts = { id: lastPost.id, sortValue: lastPost.sort_value };
          pagination.nextCursor = Buffer.from(JSON.stringify(cursorObj)).toString('base64');
        }

        // Filter sensitive content based on user settings
        results.posts = await this.sensitiveHandler.filterFeedPosts(postResults, userId);
      }

      if (type === 'hashtags' || type === 'all') {
        let hashtagsQuery = `
          SELECT *
          FROM hashtags
          WHERE tag LIKE ?
        `;

        const bindParams = [`%${query}%`];

        // Add cursor condition for pagination
        if (cursorData && cursorData.hashtags) {
          hashtagsQuery += ` AND (post_count < ? OR (post_count = ? AND id < ?))`;
          bindParams.push(cursorData.hashtags.postCount, cursorData.hashtags.postCount, cursorData.hashtags.id);
        }

        hashtagsQuery += ` ORDER BY post_count DESC, id DESC LIMIT ?`;
        bindParams.push(limit + 1);

        const hashtags = await this.env.DB.prepare(hashtagsQuery).bind(...bindParams).all();
        const hashtagResults = hashtags.results || [];

        if (hashtagResults.length > limit) {
          pagination.hasMore = true;
          hashtagResults.pop();
        }

        if (pagination.hasMore && hashtagResults.length > 0) {
          const lastHashtag = hashtagResults[hashtagResults.length - 1];
          const cursorObj = pagination.nextCursor ? JSON.parse(Buffer.from(pagination.nextCursor, 'base64').toString()) : {};
          cursorObj.hashtags = { id: lastHashtag.id, postCount: lastHashtag.post_count };
          pagination.nextCursor = Buffer.from(JSON.stringify(cursorObj)).toString('base64');
        }

        results.hashtags = hashtagResults;
      }

      // Inject advertisements into search results (posts only)
      if (results.posts && results.posts.length > 0) {
        const ads = await this.adService.selectAdsForUser(userId, 'search', 1);
        if (ads.length > 0) {
          results.ads = ads;
        }
      }

      return successResponse({ ...results, pagination });
    } catch (error) {
      console.error('Search error:', error);
      return errorResponse('Search failed', 500);
    }
  }
}

// SETTINGS CONTROLLER
export class SettingsController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
  }

  async get(request, userId) {
    try {
      let settings = await this.db.getUserSettings(userId);

      // Create default settings if they don't exist
      if (!settings) {
        const settingsId = generateId('settings');
        const timestamp = now();
        const defaultSettings = {
          // Privacy
          private_account: 0,
          who_can_comment: 'everyone',
          who_can_message: 'everyone',
          who_can_tag: 'everyone',
          show_activity_status: 1,

          // Sensitive content
          display_sensitive_content: 0,
          suggest_sensitive_content: 0,
          content_warnings: 1,

          // Notifications
          notifications_email: 0,
          notifications_push: 1,
          notifications_in_app: 1,
          notify_likes: 1,
          notify_comments: 1,
          notify_follows: 1,
          notify_mentions: 1,
          notify_messages: 1,
          notify_shares: 1,

          // Accessibility
          font_size: 'medium',
          high_contrast: 0,
          reduced_motion: 0,
          screen_reader: 0,

          // Media and data settings
          autoplay_wifi: 1,
          media_autoplay_mobile: 0,
          data_saver_mode: 0,
          topic_interests: 1,
          captions_for_videos: 1,

          // Language
          preferred_language: 'en'
        };

        // Insert default settings (use this.env.DB directly, not this.db which is DatabaseService)
        await this.env.DB.prepare(`
          INSERT INTO user_settings (
            id, user_id, private_account, who_can_comment, who_can_message, who_can_tag, show_activity_status,
            display_sensitive_content, suggest_sensitive_content, content_warnings,
            notifications_email, notifications_push, notifications_in_app,
            notify_likes, notify_comments, notify_follows, notify_mentions, notify_messages, notify_shares,
            font_size, high_contrast, reduced_motion, screen_reader,
            autoplay_wifi, media_autoplay_mobile, data_saver_mode, topic_interests, captions_for_videos,
            preferred_language, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          settingsId,
          userId,
          defaultSettings.private_account,
          defaultSettings.who_can_comment,
          defaultSettings.who_can_message,
          defaultSettings.who_can_tag,
          defaultSettings.show_activity_status,
          defaultSettings.display_sensitive_content,
          defaultSettings.suggest_sensitive_content,
          defaultSettings.content_warnings,
          defaultSettings.notifications_email,
          defaultSettings.notifications_push,
          defaultSettings.notifications_in_app,
          defaultSettings.notify_likes,
          defaultSettings.notify_comments,
          defaultSettings.notify_follows,
          defaultSettings.notify_mentions,
          defaultSettings.notify_messages,
          defaultSettings.notify_shares,
          defaultSettings.font_size,
          defaultSettings.high_contrast,
          defaultSettings.reduced_motion,
          defaultSettings.screen_reader,
          defaultSettings.autoplay_wifi,
          defaultSettings.media_autoplay_mobile,
          defaultSettings.data_saver_mode,
          defaultSettings.topic_interests,
          defaultSettings.captions_for_videos,
          defaultSettings.preferred_language,
          timestamp,
          timestamp
        ).run();

        settings = { id: settingsId, user_id: userId, ...defaultSettings, created_at: timestamp, updated_at: timestamp };
      }

      // Also fetch 2FA status from users table
      const user = await this.env.DB.prepare(`
        SELECT two_factor_enabled FROM users WHERE id = ?
      `).bind(userId).first();

      return successResponse({
        ...settings,
        two_factor_enabled: user?.two_factor_enabled === 1,
      });
    } catch (error) {
      console.error('Get settings error:', error);
      return errorResponse('Failed to get settings', 500);
    }
  }

  async update(request, userId) {
    try {
      const body = await request.json();
      console.log('[Settings] Update request:', {
        userId,
        payloadKeys: Object.keys(body),
        payload: body,
      });
      
      const settings = await this.db.updateUserSettings(userId, body);
      console.log('[Settings] ✓ Updated successfully:', {
        userId,
        settingsKeys: Object.keys(settings || {}),
        keysSample: Object.keys(settings || {}).slice(0, 5),
      });
      
      return successResponse(settings, 'Settings updated');
    } catch (error) {
      console.error('[Settings] ✗ Update error:', {
        userId,
        errorMsg: error.message,
        errorStack: error.stack ? error.stack.split('\n')[0] : 'unknown',
      });
      return errorResponse('Failed to update settings', 500);
    }
  }
}

// NOTIFICATIONS CONTROLLER
export class NotificationsController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
  }

  async list(request, userId) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');

      let query = `
        SELECT n.*,
          CASE
            WHEN n.actor_type = 'user' THEN u.username
            ELSE NULL
          END as actor_username,
          CASE
            WHEN n.actor_type = 'user' THEN u.name
            WHEN n.actor_type = 'page' THEN p.name
            ELSE NULL
          END as actor_name,
          CASE
            WHEN n.actor_type = 'user' THEN u.avatar_url
            WHEN n.actor_type = 'page' THEN p.avatar_url
            ELSE NULL
          END as actor_avatar
        FROM notifications n
        LEFT JOIN users u ON n.actor_type = 'user' AND n.actor_id = u.id
        LEFT JOIN pages p ON n.actor_type = 'page' AND n.actor_id = p.id
        WHERE n.user_id = ?
      `;

      const params = [userId];

      if (cursor) {
        const cursorData = parseCursor(cursor);
        if (cursorData?.created_at) {
          query += ` AND n.created_at < ?`;
          params.push(cursorData.created_at);
        }
      }

      query += ` ORDER BY n.created_at DESC LIMIT ?`;
      params.push(limit + 1);

      const result = await this.env.DB.prepare(query).bind(...params).all();
      const rawNotifications = result.results || [];

      const hasMore = rawNotifications.length > limit;
      if (hasMore) rawNotifications.pop();

      // Format notifications with actor data for frontend compatibility
      const notifications = rawNotifications.map(n => ({
        id: n.id,
        userId: n.user_id,
        type: n.type,
        content: n.content,
        read: n.read,
        createdAt: n.created_at,
        targetType: n.target_type,
        targetId: n.target_id,
        actorType: n.actor_type,
        actorId: n.actor_id,
        // Include denormalized actor data for frontend
        actors: n.actor_id ? [{
          id: n.actor_id,
          type: n.actor_type,
          name: n.actor_name || 'Unknown',
          username: n.actor_username || null,
          avatar: n.actor_avatar || null
        }] : []
      }));

      const nextCursor = hasMore && notifications.length > 0
        ? createCursor({ created_at: rawNotifications[rawNotifications.length - 1].created_at })
        : null;

      return successResponse({ notifications, pagination: { hasMore, nextCursor } });
    } catch (error) {
      console.error('List notifications error:', error);
      return errorResponse('Failed to get notifications', 500);
    }
  }

  async getUnreadCount(request, userId) {
    try {
      const result = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0
      `).bind(userId).first();

      return successResponse({ unreadCount: result?.count || 0 });
    } catch (error) {
      console.error('Get unread count error:', error);
      return errorResponse('Failed to get notification count', 500);
    }
  }

  async markAllRead(request, userId) {
    try {
      await this.env.DB.prepare(`
        UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0
      `).bind(userId).run();

      return successResponse(null, 'All notifications marked as read');
    } catch (error) {
      console.error('Mark all read error:', error);
      return errorResponse('Failed to mark notifications', 500);
    }
  }

  async markRead(request, userId, notificationId) {
    try {
      await this.env.DB.prepare(`
        UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?
      `).bind(notificationId, userId).run();

      return successResponse(null, 'Notification marked as read');
    } catch (error) {
      console.error('Mark read error:', error);
      return errorResponse('Failed to mark notification', 500);
    }
  }
}

// REPORTS CONTROLLER
export class ReportsController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
  }

  async create(request, userId) {
    try {
      const body = await request.json();
      const { reporterType, reporterId, targetType, targetId, category, description } = body;

      if (!targetType || !targetId || !category) {
        return errorResponse('Target type, ID, and category required', 400);
      }

      const reportId = generateId('report');

      await this.env.DB.prepare(`
        INSERT INTO reports (id, reporter_type, reporter_id, target_type, target_id, category, description, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(reportId, reporterType || 'user', reporterId || userId, targetType, targetId, category, description || '', now()).run();

      // Notify admins/moderators about the new report
      try {
        const adminsResult = await this.env.DB.prepare(`
          SELECT DISTINCT user_id FROM admin_users 
          WHERE role IN ('admin', 'moderator', 'super_admin')
        `).all();
        
        const admins = adminsResult.results || [];
        const notificationContent = `New report: ${category} on ${targetType} #${targetId}${description ? `: ${description.substring(0, 50)}` : ''}`;
        
        // Create notifications for all admins (non-blocking)
        const notificationPromises = admins.map(admin =>
          createNotification(
            this.env.DB,
            admin.user_id,
            'report_created',
            notificationContent,
            'user', // actor_type
            userId, // actor_id
            targetType,
            targetId
          ).catch(err => console.error(`Failed to notify admin ${admin.user_id}:`, err))
        );
        
        await Promise.allSettled(notificationPromises);
      } catch (notifyError) {
        console.warn('Failed to notify admins about report:', notifyError);
        // Don't fail the report creation if notification fails
      }

      return successResponse({ id: reportId }, 'Report submitted. We will review it soon.');
    } catch (error) {
      console.error('Create report error:', error);
      return errorResponse('Failed to create report', 500);
    }
  }
}

// ADMIN CONTROLLER
export class AdminController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
  }

  async listUsers(request, _adminInfo) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 50, 1, 200);
      const cursor = url.searchParams.get('cursor');

      let query = `
        SELECT id, email, username, name, avatar_url, verified, created_at
        FROM users
      `;
      const params = [];

      if (cursor) {
        query += ' WHERE created_at < ?';
        params.push(Number(cursor));
      }

      query += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit + 1);

      const result = await this.env.DB.prepare(query).bind(...params).all();
      const rows = result.results || [];
      const hasMore = rows.length > limit;
      const users = hasMore ? rows.slice(0, limit) : rows;

      const nextCursor = hasMore ? users[users.length - 1]?.created_at : null;

      return successResponse({
        users,
        pagination: {
          hasMore,
          nextCursor
        }
      });
    } catch (error) {
      console.error('List users error:', error);
      return errorResponse('Failed to list users', 500);
    }
  }

  async getReports(request, _adminInfo) {
    try {
      const url = new URL(request.url);
      const status = url.searchParams.get('status') || 'pending';

      // Get reports with basic info
      const reportsResult = await this.env.DB.prepare(`
        SELECT * FROM reports
        WHERE status = ?
        ORDER BY created_at DESC
        LIMIT 50
      `).bind(status).all();

      const reports = reportsResult.results || [];

      if (reports.length === 0) {
        return successResponse({ reports: [] });
      }

      // ============================================
      // BATCH QUERIES - Fixes N+1 query problem
      // Before: 350+ queries for 50 reports
      // After: ~15 queries total
      // ============================================

      // Collect all unique IDs to batch fetch
      const userReporterIds = new Set();
      const pageReporterIds = new Set();
      const postTargetIds = new Set();
      const commentTargetIds = new Set();
      const userTargetIds = new Set();
      const reelTargetIds = new Set();
      const pageTargetIds = new Set();
      const storyTargetIds = new Set();

      reports.forEach(report => {
        if (report.reporter_type === 'user') userReporterIds.add(report.reporter_id);
        if (report.reporter_type === 'page') pageReporterIds.add(report.reporter_id);
        if (report.target_type === 'post') postTargetIds.add(report.target_id);
        if (report.target_type === 'comment') commentTargetIds.add(report.target_id);
        if (report.target_type === 'user') userTargetIds.add(report.target_id);
        if (report.target_type === 'reel') reelTargetIds.add(report.target_id);
        if (report.target_type === 'page') pageTargetIds.add(report.target_id);
        if (report.target_type === 'story') storyTargetIds.add(report.target_id);
      });

      // Batch fetch all reporter users
      const reporterUsersMap = new Map();
      if (userReporterIds.size > 0) {
        const placeholders = Array.from(userReporterIds).map(() => '?').join(',');
        const userReporters = await this.env.DB.prepare(`
          SELECT id, username, name AS display_name, avatar_url AS avatar, verified, created_at
          FROM users WHERE id IN (${placeholders})
        `).bind(...Array.from(userReporterIds)).all();
        (userReporters.results || []).forEach(u => reporterUsersMap.set(u.id, u));
      }

      // Batch fetch all reporter pages
      const reporterPagesMap = new Map();
      if (pageReporterIds.size > 0) {
        const placeholders = Array.from(pageReporterIds).map(() => '?').join(',');
        const pageReporters = await this.env.DB.prepare(`
          SELECT id, name, username, avatar_url AS avatar, verified, created_at
          FROM pages WHERE id IN (${placeholders})
        `).bind(...Array.from(pageReporterIds)).all();
        (pageReporters.results || []).forEach(p => reporterPagesMap.set(p.id, p));
      }

      // Batch fetch target posts
      const postsMap = new Map();
      if (postTargetIds.size > 0) {
        const placeholders = Array.from(postTargetIds).map(() => '?').join(',');
        const posts = await this.env.DB.prepare(`
          SELECT p.*, u.username, u.name AS display_name, u.avatar_url AS avatar, u.verified
          FROM posts p
          LEFT JOIN users u ON p.actor_id = u.id AND p.actor_type = 'user'
          WHERE p.id IN (${placeholders})
        `).bind(...Array.from(postTargetIds)).all();
        (posts.results || []).forEach(p => postsMap.set(p.id, p));
      }

      // Batch fetch target comments
      const commentsMap = new Map();
      if (commentTargetIds.size > 0) {
        const placeholders = Array.from(commentTargetIds).map(() => '?').join(',');
        const comments = await this.env.DB.prepare(`
          SELECT c.*, u.username, u.name AS display_name, u.avatar_url AS avatar, u.verified
          FROM comments c
          LEFT JOIN users u ON c.actor_id = u.id AND c.actor_type = 'user'
          WHERE c.id IN (${placeholders})
        `).bind(...Array.from(commentTargetIds)).all();
        (comments.results || []).forEach(c => commentsMap.set(c.id, c));
      }

      // Batch fetch target users
      const targetUsersMap = new Map();
      if (userTargetIds.size > 0) {
        const placeholders = Array.from(userTargetIds).map(() => '?').join(',');
        const users = await this.env.DB.prepare(`
          SELECT id, username, name AS display_name, bio, avatar_url AS avatar, cover_url AS cover, verified, created_at, is_banned
          FROM users WHERE id IN (${placeholders})
        `).bind(...Array.from(userTargetIds)).all();
        (users.results || []).forEach(u => targetUsersMap.set(u.id, u));
      }

      // Batch fetch target reels
      const reelsMap = new Map();
      if (reelTargetIds.size > 0) {
        const placeholders = Array.from(reelTargetIds).map(() => '?').join(',');
        const reels = await this.env.DB.prepare(`
          SELECT r.*, u.username, u.name AS display_name, u.avatar_url AS avatar, u.verified
          FROM reels r
          LEFT JOIN users u ON r.actor_id = u.id AND r.actor_type = 'user'
          WHERE r.id IN (${placeholders})
        `).bind(...Array.from(reelTargetIds)).all();
        (reels.results || []).forEach(r => reelsMap.set(r.id, r));
      }

      // Batch fetch target pages
      const targetPagesMap = new Map();
      if (pageTargetIds.size > 0) {
        const placeholders = Array.from(pageTargetIds).map(() => '?').join(',');
        const pages = await this.env.DB.prepare(`
          SELECT id, name, username, bio, avatar_url AS avatar, cover_url AS cover, verified, created_at
          FROM pages WHERE id IN (${placeholders})
        `).bind(...Array.from(pageTargetIds)).all();
        (pages.results || []).forEach(p => targetPagesMap.set(p.id, p));
      }

      // Batch fetch target stories
      const storiesMap = new Map();
      if (storyTargetIds.size > 0) {
        const placeholders = Array.from(storyTargetIds).map(() => '?').join(',');
        const stories = await this.env.DB.prepare(`
          SELECT s.*, u.username, u.name AS display_name, u.avatar_url AS avatar, u.verified
          FROM stories s
          LEFT JOIN users u ON s.actor_id = u.id AND s.actor_type = 'user'
          WHERE s.id IN (${placeholders})
        `).bind(...Array.from(storyTargetIds)).all();
        (stories.results || []).forEach(s => storiesMap.set(s.id, s));
      }

      // Build enhanced reports from batched data
      const enhancedReports = reports.map((report) => {
        // Get reporter details from batched data
        let reporter = null;
        if (report.reporter_type === 'user') {
          const reporterData = reporterUsersMap.get(report.reporter_id);
          if (reporterData) {
            reporter = {
              id: reporterData.id,
              type: 'user',
              username: reporterData.username,
              display_name: reporterData.display_name,
              avatar: reporterData.avatar,
              verified: Boolean(reporterData.verified),
              account_age_days: Math.floor((Date.now() / 1000 - reporterData.created_at) / 86400)
            };
          }
        } else if (report.reporter_type === 'page') {
          const pageData = reporterPagesMap.get(report.reporter_id);
          if (pageData) {
            reporter = {
              id: pageData.id,
              type: 'page',
              username: pageData.username,
              display_name: pageData.name,
              avatar: pageData.avatar,
              verified: Boolean(pageData.verified),
              account_age_days: Math.floor((Date.now() / 1000 - pageData.created_at) / 86400)
            };
          }
        }

        // Get target content from batched data
        let target = null;
        let targetAuthor = null;

        if (report.target_type === 'post') {
          const postData = postsMap.get(report.target_id);
          if (postData) {
            target = {
              id: postData.id,
              type: 'post',
              content: postData.content,
              media: postData.media ? safeJsonParse(postData.media, []) : [],
              likes_count: postData.likes_count || 0,
              comments_count: postData.comments_count || 0,
              shares_count: postData.shares_count || 0,
              created_at: postData.created_at
            };

            targetAuthor = {
              id: postData.actor_id,
              username: postData.username,
              display_name: postData.display_name,
              avatar: postData.avatar,
              verified: Boolean(postData.verified)
            };
          }
        } else if (report.target_type === 'comment') {
          const commentData = commentsMap.get(report.target_id);
          if (commentData) {
            target = {
              id: commentData.id,
              type: 'comment',
              content: commentData.content,
              post_id: commentData.post_id,
              likes_count: commentData.likes_count || 0,
              created_at: commentData.created_at
            };

            targetAuthor = {
              id: commentData.actor_id,
              username: commentData.username,
              display_name: commentData.display_name,
              avatar: commentData.avatar,
              verified: Boolean(commentData.verified)
            };
          }
        } else if (report.target_type === 'user') {
          const userData = targetUsersMap.get(report.target_id);
          if (userData) {
            target = {
              id: userData.id,
              type: 'user',
              username: userData.username,
              display_name: userData.display_name,
              bio: userData.bio,
              avatar: userData.avatar,
              cover: userData.cover,
              verified: Boolean(userData.verified),
              followers_count: userData.followers_count || 0,
              following_count: userData.following_count || 0,
              is_banned: Boolean(userData.is_banned),
              account_age_days: Math.floor((Date.now() / 1000 - userData.created_at) / 86400)
            };
          }
        } else if (report.target_type === 'reel') {
          const reelData = reelsMap.get(report.target_id);
          if (reelData) {
            target = {
              id: reelData.id,
              type: 'reel',
              title: reelData.title,
              description: reelData.description,
              video_url: reelData.video_url,
              thumbnail: reelData.thumbnail,
              likes_count: reelData.likes_count || 0,
              views_count: reelData.views_count || 0,
              comments_count: reelData.comments_count || 0,
              created_at: reelData.created_at
            };

            targetAuthor = {
              id: reelData.actor_id,
              username: reelData.username,
              display_name: reelData.display_name,
              avatar: reelData.avatar,
              verified: Boolean(reelData.verified)
            };
          }
        } else if (report.target_type === 'page') {
          const pageData = targetPagesMap.get(report.target_id);
          if (pageData) {
            target = {
              id: pageData.id,
              type: 'page',
              username: pageData.username,
              display_name: pageData.name,
              bio: pageData.bio,
              avatar: pageData.avatar,
              cover: pageData.cover,
              verified: Boolean(pageData.verified),
              followers_count: pageData.followers_count || 0,
              account_age_days: Math.floor((Date.now() / 1000 - pageData.created_at) / 86400)
            };
          }
        } else if (report.target_type === 'story') {
          const storyData = storiesMap.get(report.target_id);
          if (storyData) {
            target = {
              id: storyData.id,
              type: 'story',
              media_type: storyData.media_type,
              media_url: storyData.media_url,
              thumbnail: storyData.thumbnail,
              views_count: storyData.views_count || 0,
              created_at: storyData.created_at,
              expires_at: storyData.expires_at
            };

            targetAuthor = {
              id: storyData.actor_id,
              username: storyData.username,
              display_name: storyData.display_name,
              avatar: storyData.avatar,
              verified: Boolean(storyData.verified)
            };
          }
        }

        // Build enhanced report object (context stats removed to reduce queries)
        return {
          id: report.id,
          category: report.category,
          description: report.description,
          status: report.status,
          created_at: report.created_at,
          reviewed_by: report.reviewed_by,
          reviewed_at: report.reviewed_at,
          resolution: report.resolution,
          reporter,
          target,
          target_author: targetAuthor,
          // Context stats moved to detail view only (not list view)
          context: {}
        };
      });

      return successResponse({ reports: enhancedReports });
    } catch (error) {
      console.error('Get reports error:', error);
      return errorResponse('Failed to get reports', 500);
    }
  }

  async resolveReport(request, adminInfo, reportId) {
    try {
      const body = await request.json();
      const { resolution } = body;

      await this.env.DB.prepare(`
        UPDATE reports
        SET status = 'resolved', reviewed_by = ?, reviewed_at = ?, resolution = ?
        WHERE id = ?
      `).bind(adminInfo.adminId, now(), resolution, reportId).run();

      // Log admin action
      await this.env.DB.prepare(`
        INSERT INTO admin_audit_logs (id, admin_id, action_type, target_type, target_id, details, created_at)
        VALUES (?, ?, 'resolve_report', 'report', ?, ?, ?)
      `).bind(generateId('log'), adminInfo.adminId, reportId, resolution, now()).run();

      return successResponse(null, 'Report resolved');
    } catch (error) {
      console.error('Resolve report error:', error);
      return errorResponse('Failed to resolve report', 500);
    }
  }

  async banUser(request, adminInfo, targetUserId) {
    try {
      const body = await request.json();
      const { reason, duration, permanent } = body;

      // Get target user
      const targetUser = await this.env.DB.prepare(`
        SELECT * FROM users WHERE id = ?
      `).bind(targetUserId).first();

      if (!targetUser) {
        return errorResponse('User not found', 404);
      }

      // Validate ban data
      const validation = validateBanUser(body, targetUser, adminInfo);
      if (!validation.isValid) {
        return errorResponse(validation.errors.join(', '), 400);
      }

      const banId = generateId('ban');
      const expiresAt = permanent ? null : now() + (duration * 3600);

      await this.env.DB.prepare(`
        INSERT INTO bans (id, target_type, target_id, reason, duration, expires_at, permanent, banned_by, created_at)
        VALUES (?, 'user', ?, ?, ?, ?, ?, ?, ?)
      `).bind(banId, targetUserId, reason, duration, expiresAt, permanent ? 1 : 0, adminInfo.adminId, now()).run();

      // Also set ban flags on the user record for fast checks
      await this.env.DB.prepare(`
        UPDATE users
        SET is_banned = 1,
            banned_until = ?
        WHERE id = ?
      `).bind(expiresAt, targetUserId).run();

      // Log
      await this.env.DB.prepare(`
        INSERT INTO admin_audit_logs (id, admin_id, action_type, target_type, target_id, details, created_at)
        VALUES (?, ?, 'ban_user', 'user', ?, ?, ?)
      `).bind(generateId('log'), adminInfo.adminId, targetUserId, JSON.stringify({ reason, duration, permanent }), now()).run();

      return successResponse(null, 'User banned');
    } catch (error) {
      console.error('Ban user error:', error);
      return errorResponse('Failed to ban user', 500);
    }
  }

  async verifyUser(request, adminInfo, targetUserId) {
    try {
      await this.env.DB.prepare(`
        UPDATE users SET verified = 1 WHERE id = ?
      `).bind(targetUserId).run();

      // Log
      await this.env.DB.prepare(`
        INSERT INTO admin_audit_logs (id, admin_id, action_type, target_type, target_id, created_at)
        VALUES (?, ?, 'verify_user', 'user', ?, ?)
      `).bind(generateId('log'), adminInfo.adminId, targetUserId, now()).run();

      return successResponse(null, 'User verified');
    } catch (error) {
      console.error('Verify user error:', error);
      return errorResponse('Failed to verify user', 500);
    }
  }

  async deletePost(request, adminInfo, postId) {
    try {
      const post = await this.db.getPostById(postId);

      if (!post) {
        return errorResponse('Post not found', 404);
      }

      const deletePostVideosCleanup = async (mediaUrls, cleaner) => {
        if (!mediaUrls) return;

        try {
          const mediaArray = typeof mediaUrls === 'string'
            ? JSON.parse(mediaUrls)
            : mediaUrls;

          if (!Array.isArray(mediaArray)) return;

          const videoIds = mediaArray
            .filter(m => m.type === 'video' && (m.cloudflareId || m.videoId))
            .map(m => m.cloudflareId || m.videoId);

          if (videoIds.length > 0) {
            await cleaner.deleteVideos(videoIds);
          }
        } catch (parseErr) {
          console.warn('Could not parse video IDs from media_urls');
        }
      };

      // Clean up Cloudflare media before deleting post
      try {
        const cleaner = new CloudflareMediaCleaner(this.env);

        if (post.cloudflare_image_ids) {
          await cleaner.deleteImages(post.cloudflare_image_ids);
        }

        if (post.cloudflare_video_ids) {
          const videoIds = cleaner.safeParseJson(post.cloudflare_video_ids);
          for (const videoId of videoIds) {
            if (videoId) {
              await cleaner.deleteVideo(videoId);
            }
          }
        } else {
          await deletePostVideosCleanup(post.media_urls, cleaner);
        }
      } catch (cleanupError) {
        console.error('Cloudflare cleanup error for admin post deletion:', cleanupError);
      }

      await this.db.deletePost(postId);

      // Log
      await this.env.DB.prepare(`
        INSERT INTO admin_audit_logs (id, admin_id, action_type, target_type, target_id, created_at)
        VALUES (?, ?, 'delete_post', 'post', ?, ?)
      `).bind(generateId('log'), adminInfo.adminId, postId, now()).run();

      return successResponse(null, 'Post deleted');
    } catch (error) {
      console.error('Delete post error:', error);
      return errorResponse('Failed to delete post', 500);
    }
  }

  async getAnalytics(_request, _adminInfo) {
    try {
      const [users, posts, activeUsers] = await Promise.all([
        this.env.DB.prepare(`SELECT COUNT(*) as count FROM users`).first(),
        this.env.DB.prepare(`SELECT COUNT(*) as count FROM posts`).first(),
        this.env.DB.prepare(`
          SELECT COUNT(DISTINCT user_id) as count FROM active_sessions
          WHERE last_activity > ?
        `).bind(now() - 86400).first()
      ]);

      return successResponse({
        totalUsers: users?.count ?? 0,
        totalPosts: posts?.count ?? 0,
        activeUsers24h: activeUsers?.count ?? 0
      });
    } catch (error) {
      console.error('Get analytics error:', error);
      return errorResponse('Failed to get analytics', 500);
    }
  }

  // ============================================
  // ADMIN MANAGEMENT (Super Admin Only)
  // ============================================

  async listAdmins(request, adminInfo) {
    try {
      // Check if requester is super admin
      if (adminInfo.role !== 'super_admin') {
        return errorResponse('Only super admins can list admins', 403);
      }

      const result = await this.env.DB.prepare(`
        SELECT
          au.id,
          au.user_id,
          au.role,
          au.permissions,
          au.created_by,
          au.created_at,
          u.email,
          u.username,
          u.name,
          u.avatar_url
        FROM admin_users au
        JOIN users u ON au.user_id = u.id
        ORDER BY au.created_at DESC
      `).all();

      const admins = (result.results || []).map(admin => ({
        id: admin.id,
        userId: admin.user_id,
        email: admin.email,
        username: admin.username,
        name: admin.name,
        avatarUrl: admin.avatar_url,
        role: admin.role,
        permissions: safeJsonParse(admin.permissions, []),
        createdBy: admin.created_by,
        createdAt: admin.created_at
      }));

      return successResponse({ admins });
    } catch (error) {
      console.error('List admins error:', error);
      return errorResponse('Failed to list admins', 500);
    }
  }

  async createAdmin(request, adminInfo) {
    try {
      // Check if requester is super admin
      if (adminInfo.role !== 'super_admin') {
        return errorResponse('Only super admins can create admins', 403);
      }

      const body = await request.json();
      const { userId, role, permissions } = body;

      if (!userId || !role) {
        return errorResponse('User ID and role are required', 400);
      }

      if (!['admin', 'moderator'].includes(role)) {
        return errorResponse('Invalid role. Must be admin or moderator', 400);
      }

      // Check if user exists
      const user = await this.env.DB.prepare(`
        SELECT * FROM users WHERE id = ?
      `).bind(userId).first();

      if (!user) {
        return errorResponse('User not found', 404);
      }

      // Check if already admin
      const existing = await this.env.DB.prepare(`
        SELECT * FROM admin_users WHERE user_id = ?
      `).bind(userId).first();

      if (existing) {
        return errorResponse('User is already an admin', 400);
      }

      // Create admin
      const adminId = generateId('admin');
      const timestamp = now();

      const defaultPermissions = role === 'admin'
        ? ['create_ads', 'moderate_ads', 'view_analytics', 'manage_reports', 'moderate_content']
        : ['moderate_ads', 'view_analytics', 'manage_reports'];

      // Validate permissions if provided
      const finalPermissions = permissions || defaultPermissions;
      const permissionValidation = validateAdminPermissions(finalPermissions);
      if (!permissionValidation.isValid) {
        return errorResponse(permissionValidation.errors.join(', '), 400);
      }

      await this.env.DB.prepare(`
        INSERT INTO admin_users (id, user_id, role, permissions, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        adminId,
        userId,
        role,
        JSON.stringify(finalPermissions),
        adminInfo.adminId,
        timestamp
      ).run();

      // Log action
      await this.env.DB.prepare(`
        INSERT INTO admin_audit_logs (id, admin_id, action_type, target_type, target_id, details, created_at)
        VALUES (?, ?, 'create_admin', 'admin', ?, ?, ?)
      `).bind(
        generateId('log'),
        adminInfo.adminId,
        adminId,
        JSON.stringify({ userId, role, permissions }),
        timestamp
      ).run();

      return successResponse({ adminId }, 'Admin created successfully');
    } catch (error) {
      console.error('Create admin error:', error);
      return errorResponse('Failed to create admin', 500);
    }
  }

  async updateAdminRole(request, adminInfo, targetAdminId) {
    try {
      // Check if requester is super admin
      if (adminInfo.role !== 'super_admin') {
        return errorResponse('Only super admins can update admin roles', 403);
      }

      const body = await request.json();
      const { role, permissions } = body;

      // Get target admin FIRST to prevent TOCTOU race condition
      const targetAdmin = await this.env.DB.prepare(`
        SELECT * FROM admin_users WHERE id = ?
      `).bind(targetAdminId).first();

      if (!targetAdmin) {
        return errorResponse('Admin not found', 404);
      }

      // SECURITY: Prevent self-modification AFTER fetching target (TOCTOU fix)
      // Check against user_id, not admin_id parameter
      if (targetAdmin.user_id === adminInfo.userId) {
        return errorResponse('Cannot modify your own role', 403);
      }

      // Cannot modify super admins
      if (targetAdmin.role === 'super_admin') {
        return errorResponse('Cannot modify super admin', 403);
      }

      // Validate permissions if provided
      if (permissions) {
        const validation = validateAdminPermissions(permissions);
        if (!validation.isValid) {
          return errorResponse('Invalid permissions: ' + validation.errors.join(', '), 400);
        }
      }

      const updates = [];
      const params = [];

      if (role) {
        if (!['admin', 'moderator'].includes(role)) {
          return errorResponse('Invalid role', 400);
        }
        updates.push('role = ?');
        params.push(role);
      }

      if (permissions) {
        updates.push('permissions = ?');
        params.push(JSON.stringify(permissions));
      }

      if (updates.length === 0) {
        return errorResponse('No updates provided', 400);
      }

      params.push(targetAdminId);

      await this.env.DB.prepare(`
        UPDATE admin_users SET ${updates.join(', ')} WHERE id = ?
      `).bind(...params).run();

      // Log action
      await this.env.DB.prepare(`
        INSERT INTO admin_audit_logs (id, admin_id, action_type, target_type, target_id, details, created_at)
        VALUES (?, ?, 'update_admin', 'admin', ?, ?, ?)
      `).bind(
        generateId('log'),
        adminInfo.adminId,
        targetAdminId,
        JSON.stringify({ role, permissions }),
        now()
      ).run();

      return successResponse(null, 'Admin role updated successfully');
    } catch (error) {
      console.error('Update admin role error:', error);
      return errorResponse('Failed to update admin role', 500);
    }
  }

  async deleteAdmin(request, adminInfo, targetAdminId) {
    try {
      // Check if requester is super admin
      if (adminInfo.role !== 'super_admin') {
        return errorResponse('Only super admins can delete admins', 403);
      }

      // Get target admin
      const targetAdmin = await this.env.DB.prepare(`
        SELECT * FROM admin_users WHERE id = ?
      `).bind(targetAdminId).first();

      if (!targetAdmin) {
        return errorResponse('Admin not found', 404);
      }

      // Cannot delete super admins
      if (targetAdmin.role === 'super_admin') {
        return errorResponse('Cannot delete super admin', 403);
      }

      // Prevent self-deletion
      if (targetAdminId === adminInfo.adminId) {
        return errorResponse('Cannot delete yourself', 403);
      }

      await this.env.DB.prepare(`
        DELETE FROM admin_users WHERE id = ?
      `).bind(targetAdminId).run();

      // Log action
      await this.env.DB.prepare(`
        INSERT INTO admin_audit_logs (id, admin_id, action_type, target_type, target_id, details, created_at)
        VALUES (?, ?, 'delete_admin', 'admin', ?, ?, ?)
      `).bind(
        generateId('log'),
        adminInfo.adminId,
        targetAdminId,
        JSON.stringify({ userId: targetAdmin.user_id, role: targetAdmin.role }),
        now()
      ).run();

      return successResponse(null, 'Admin deleted successfully');
    } catch (error) {
      console.error('Delete admin error:', error);
      return errorResponse('Failed to delete admin', 500);
    }
  }

  async getAuditLogs(request, adminInfo) {
    try {
      // Check if requester is super admin
      if (adminInfo.role !== 'super_admin') {
        return errorResponse('Only super admins can view audit logs', 403);
      }

      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 50, 1, 100);
      const adminId = url.searchParams.get('adminId');
      const actionType = url.searchParams.get('actionType');

      let query = `
        SELECT
          al.*,
          u.username,
          u.name
        FROM admin_audit_logs al
        JOIN admin_users au ON al.admin_id = au.id
        JOIN users u ON au.user_id = u.id
        WHERE 1=1
      `;

      const params = [];

      if (adminId) {
        query += ` AND al.admin_id = ?`;
        params.push(adminId);
      }

      if (actionType) {
        query += ` AND al.action_type = ?`;
        params.push(actionType);
      }

      query += ` ORDER BY al.created_at DESC LIMIT ?`;
      params.push(limit);

      const result = await this.env.DB.prepare(query).bind(...params).all();

      const logs = (result.results || []).map(log => ({
        id: log.id,
        adminId: log.admin_id,
        adminUsername: log.username,
        adminName: log.name,
        actionType: log.action_type,
        targetType: log.target_type,
        targetId: log.target_id,
        details: log.details,
        ipAddress: log.ip_address,
        createdAt: log.created_at
      }));

      return successResponse({ logs });
    } catch (error) {
      console.error('Get audit logs error:', error);
      return errorResponse('Failed to get audit logs', 500);
    }
  }

  // ============================================
  // ADMIN: FULL DATA EXPORT (Super Admin Only)
  // ============================================

  async exportAllData(request, adminInfo) {
    try {
      // Only super admins can perform a full logical export of the database
      if (adminInfo.role !== 'super_admin') {
        return errorResponse('Only super admins can export all data', 403);
      }

      const url = new URL(request.url);
      // Optional: allow clients to request a subset of tables as a comma-separated list
      const tablesParam = url.searchParams.get('tables');
      const requestedTables = tablesParam
        ? tablesParam.split(',').map(t => t.trim()).filter(Boolean)
        : null;

      // Use the same primary DB that the DbRouter would choose
      const db = this.db?.router?.getPrimaryDb?.() || this.env.DB;

      // Introspect all non-internal tables from SQLite schema
      const tablesResult = await db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
      `).all();

      let tableNames = (tablesResult.results || [])
        .map(row => row.name)
        .filter(Boolean);

      // If caller requested specific tables, filter down to that set
      if (requestedTables && requestedTables.length > 0) {
        const requestedSet = new Set(requestedTables);
        tableNames = tableNames.filter(name => requestedSet.has(name));
      }

      const data = {};
      const tableMeta = [];

      // Parallelize the database queries for better performance
      const queryPromises = tableNames.map(async (name) => {
        // SECURITY: Validate table name against whitelist to prevent SQL injection
        if (!isValidTableName(name)) {
          throw new Error(`Invalid table name: ${name}`);
        }
        const rowsResult = await db.prepare(`SELECT * FROM "${name}"`).all();
        const rows = rowsResult.results || [];
        return { name, rows, rowCount: rows.length };
      });

      const results = await Promise.all(queryPromises);

      for (const { name, rows, rowCount } of results) {
        data[name] = rows;
        tableMeta.push({ name, rowCount });
      }

      const payload = {
        meta: {
          exportedAt: now(),
          tableCount: tableNames.length,
          tables: tableMeta
        },
        data
      };

      return successResponse(payload, 'Full database export generated');
    } catch (error) {
      console.error('Export all data error:', error);
      return errorResponse('Failed to export data', 500);
    }
  }

  // ============================================
  // ADMIN: FULL DATA IMPORT (Super Admin Only)
  // ============================================

  async importAllData(request, adminInfo) {
    try {
      if (adminInfo.role !== 'super_admin') {
        return errorResponse('Only super admins can import all data', 403);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }

      const { data, dryRun } = body;
      if (!data || typeof data !== 'object') {
        return errorResponse('Snapshot data object is required', 400);
      }

      const db = this.db?.router?.getPrimaryDb?.() || this.env.DB;

      // Dry-run mode: validate snapshot compatibility without writing
      if (dryRun) {
        // Get existing table list
        const tablesResult = await db.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
        `).all();

        const existingTables = new Set(
          (tablesResult.results || []).map(row => row.name).filter(Boolean)
        );

        const issues = {};

        // Collect all tables that need introspection
        const tablesToIntrospect = [];
        for (const [tableName, rows] of Object.entries(data)) {
          if (!Array.isArray(rows)) continue;

          const tableIssues = { missingTable: false, unknownColumns: [], missingRequiredColumns: [] };

          if (!existingTables.has(tableName)) {
            tableIssues.missingTable = true;
            issues[tableName] = tableIssues;
            continue;
          }

          if (rows.length === 0) {
            continue; // nothing else to validate
          }

          tablesToIntrospect.push({ tableName, rows, tableIssues });
        }

        // Parallelize table introspection
        const introspectionPromises = tablesToIntrospect.map(async ({ tableName, rows, tableIssues }) => {
          const infoResult = await db.prepare(`PRAGMA table_info("${tableName}")`).all();
          const columnsInfo = infoResult.results || [];
          const columnNames = new Set(columnsInfo.map(col => col.name));

          const snapshotColumns = Object.keys(rows[0]);

          // Unknown columns in snapshot
          for (const col of snapshotColumns) {
            if (!columnNames.has(col)) {
              tableIssues.unknownColumns.push(col);
            }
          }

          // Missing NOT NULL columns without default
          for (const col of columnsInfo) {
            if (col.notnull === 1 && col.pk === 0 && col.dflt_value === null) {
              if (!snapshotColumns.includes(col.name)) {
                tableIssues.missingRequiredColumns.push(col.name);
              }
            }
          }

          return { tableName, tableIssues };
        });

        const introspectionResults = await Promise.all(introspectionPromises);

        // Collect issues
        for (const { tableName, tableIssues } of introspectionResults) {
          if (
            tableIssues.missingTable ||
            tableIssues.unknownColumns.length > 0 ||
            tableIssues.missingRequiredColumns.length > 0
          ) {
            issues[tableName] = tableIssues;
          }
        }

        const hasIssues = Object.keys(issues).length > 0;
        return successResponse(
          {
            dryRun: true,
            valid: !hasIssues,
            issues
          },
          hasIssues
            ? 'Dry run completed with compatibility issues'
            : 'Dry run successful: snapshot appears compatible'
        );
      }

      // Real import: delete existing rows then reinsert from snapshot
      for (const [tableName, rows] of Object.entries(data)) {
        if (!Array.isArray(rows)) continue;

        // Best-effort: skip SQLite internal tables
        if (tableName.startsWith('sqlite_')) continue;

        // SECURITY: Validate table name against whitelist to prevent SQL injection
        if (!isValidTableName(tableName)) {
          console.warn(`Skipping invalid table name: ${tableName}`);
          continue;
        }

        // Clear existing table contents (sequential for data integrity)
        // eslint-disable-next-line no-await-in-loop
        await db.prepare(`DELETE FROM "${tableName}"`).run();

        if (rows.length === 0) continue;

        const columns = Object.keys(rows[0]);
        const placeholders = columns.map(() => '?').join(', ');
        const columnList = columns.map(c => `"${c}"`).join(', ');

        // Insert rows sequentially to maintain data integrity
        for (const row of rows) {
          const values = columns.map(c => row[c]);
          // eslint-disable-next-line no-await-in-loop
          await db.prepare(`INSERT INTO "${tableName}" (${columnList}) VALUES (${placeholders})`).bind(...values).run();
        }
      }

      return successResponse(null, 'Snapshot imported successfully');
    } catch (error) {
      console.error('Import all data error:', error);
      return errorResponse('Failed to import data', 500);
    }
  }
}
