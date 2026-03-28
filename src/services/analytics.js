// ============================================
// ANALYTICS SERVICE
// Platform metrics and insights
// ============================================

import { now, safeJsonParseArray } from '../utils/helpers.js';

export class AnalyticsService {
  constructor(db) {
    this.db = db;
  }

  /**
   * Get platform overview stats
   */
  async getPlatformOverview() {
    try {
      const [users, posts, messages, reels, stories] = await Promise.all([
        this.db.prepare(`SELECT COUNT(*) as count FROM users`).first(),
        this.db.prepare(`SELECT COUNT(*) as count FROM posts`).first(),
        this.db.prepare(`SELECT COUNT(*) as count FROM messages`).first(),
        this.db.prepare(`SELECT COUNT(*) as count FROM reels`).first(),
        this.db.prepare(`SELECT COUNT(*) as count FROM stories WHERE expires_at > ?`).bind(now()).first()
      ]);

      return {
        totalUsers: users?.count || 0,
        totalPosts: posts?.count || 0,
        totalMessages: messages?.count || 0,
        totalReels: reels?.count || 0,
        activeStories: stories?.count || 0
      };
    } catch (error) {
      console.error('Get platform overview error:', error);
      return {};
    }
  }

  /**
   * Get user growth metrics
   */
  async getUserGrowth(period = '30d') {
    try {
      const periodMap = {
        '7d': 7 * 24 * 3600,
        '30d': 30 * 24 * 3600,
        '90d': 90 * 24 * 3600
      };

      const seconds = periodMap[period] || periodMap['30d'];
      const startTime = now() - seconds;

      // Users created in period
      const newUsers = await this.db.prepare(`
        SELECT COUNT(*) as count FROM users WHERE created_at >= ?
      `).bind(startTime).first();

      // Daily breakdown
      const dailyStats = await this.db.prepare(`
        SELECT 
          DATE(created_at, 'unixepoch') as date,
          COUNT(*) as count
        FROM users
        WHERE created_at >= ?
        GROUP BY date
        ORDER BY date ASC
      `).bind(startTime).all();

      return {
        period,
        newUsers: newUsers?.count || 0,
        daily: dailyStats?.results || []
      };
    } catch (error) {
      console.error('Get user growth error:', error);
      return {};
    }
  }

  /**
   * Get engagement metrics
   */
  async getEngagementMetrics(period = '30d') {
    try {
      const periodMap = {
        '7d': 7 * 24 * 3600,
        '30d': 30 * 24 * 3600,
        '90d': 90 * 24 * 3600
      };

      const seconds = periodMap[period] || periodMap['30d'];
      const startTime = now() - seconds;

      const [likes, comments, shares, posts, reels] = await Promise.all([
        this.db.prepare(`
          SELECT COUNT(*) as count FROM likes WHERE created_at >= ?
        `).bind(startTime).first(),
        
        this.db.prepare(`
          SELECT COUNT(*) as count FROM comments WHERE created_at >= ?
        `).bind(startTime).first(),
        
        this.db.prepare(`
          SELECT COUNT(*) as count FROM shares WHERE created_at >= ?
        `).bind(startTime).first(),
        
        this.db.prepare(`
          SELECT COUNT(*) as count FROM posts WHERE created_at >= ?
        `).bind(startTime).first(),
        
        this.db.prepare(`
          SELECT COUNT(*) as count FROM reels WHERE created_at >= ?
        `).bind(startTime).first()
      ]);

      const totalEngagements = (likes?.count || 0) + (comments?.count || 0) + (shares?.count || 0);
      const totalContent = (posts?.count || 0) + (reels?.count || 0);
      const engagementRate = totalContent > 0 ? (totalEngagements / totalContent).toFixed(2) : 0;

      return {
        period,
        likes: likes?.count || 0,
        comments: comments?.count || 0,
        shares: shares?.count || 0,
        posts: posts?.count || 0,
        reels: reels?.count || 0,
        totalEngagements,
        engagementRate
      };
    } catch (error) {
      console.error('Get engagement metrics error:', error);
      return {};
    }
  }

  /**
   * Get active users metrics
   */
  async getActiveUsers() {
    try {
      const now_ts = now();
      const last24h = now_ts - (24 * 3600);
      const last7d = now_ts - (7 * 24 * 3600);
      const last30d = now_ts - (30 * 24 * 3600);

      const [dau, wau, mau] = await Promise.all([
        this.db.prepare(`
          SELECT COUNT(DISTINCT user_id) as count 
          FROM active_sessions 
          WHERE last_activity >= ?
        `).bind(last24h).first(),
        
        this.db.prepare(`
          SELECT COUNT(DISTINCT user_id) as count 
          FROM active_sessions 
          WHERE last_activity >= ?
        `).bind(last7d).first(),
        
        this.db.prepare(`
          SELECT COUNT(DISTINCT user_id) as count 
          FROM active_sessions 
          WHERE last_activity >= ?
        `).bind(last30d).first()
      ]);

      return {
        dau: dau?.count || 0,
        wau: wau?.count || 0,
        mau: mau?.count || 0,
        timestamp: now_ts
      };
    } catch (error) {
      console.error('Get active users error:', error);
      return {};
    }
  }

  /**
   * Get top content (most engaged posts/reels)
   */
  async getTopContent(type = 'posts', limit = 10) {
    try {
      let query;

      if (type === 'posts') {
        query = `
          SELECT p.*, u.username, u.name,
            (p.likes_count + p.comments_count * 2 + p.shares_count * 3) as engagement_score
          FROM posts p
          JOIN users u ON p.actor_type = 'user' AND p.actor_id = u.id
          ORDER BY engagement_score DESC
          LIMIT ?
        `;
      } else if (type === 'reels') {
        query = `
          SELECT r.*, u.username, u.name,
            (r.likes_count + r.comments_count * 2 + r.views_count * 0.1) as engagement_score
          FROM reels r
          JOIN users u ON r.actor_type = 'user' AND r.actor_id = u.id
          ORDER BY engagement_score DESC
          LIMIT ?
        `;
      } else {
        throw new Error('Invalid content type');
      }

      const result = await this.db.prepare(query).bind(limit).all();

      const content = (result.results || []).map(item => {
        const processedItem = { ...item };
        if (processedItem.media_urls) {
          processedItem.media_urls = safeJsonParseArray(processedItem.media_urls);
        }
        return processedItem;
      });

      return {
        type,
        content,
        count: content.length
      };
    } catch (error) {
      console.error('Get top content error:', error);
      return { type, content: [], count: 0 };
    }
  }

  /**
   * Get trending topics
   */
  async getTrendingTopics(limit = 10) {
    try {
      const result = await this.db.prepare(`
        SELECT h.*, 
          (SELECT COUNT(*) FROM post_hashtags ph 
           JOIN posts p ON ph.post_id = p.id 
           WHERE ph.hashtag_id = h.id AND p.created_at >= ?) as recent_count
        FROM hashtags h
        ORDER BY recent_count DESC, h.post_count DESC
        LIMIT ?
      `).bind(now() - (7 * 24 * 3600), limit).all();

      return {
        topics: result.results || [],
        count: (result.results || []).length
      };
    } catch (error) {
      console.error('Get trending topics error:', error);
      return { topics: [], count: 0 };
    }
  }

  /**
   * Get language distribution
   */
  async getLanguageDistribution() {
    try {
      const result = await this.db.prepare(`
        SELECT language, COUNT(*) as count
        FROM posts
        GROUP BY language
        ORDER BY count DESC
      `).all();

      return {
        languages: result.results || []
      };
    } catch (error) {
      console.error('Get language distribution error:', error);
      return { languages: [] };
    }
  }

  /**
   * Get user retention metrics
   */
  async getRetentionMetrics() {
    try {
      const cohortDays = [1, 7, 14, 30];
      const retentionPromises = cohortDays.map(async (day) => {
        const cohortStart = now() - (day * 24 * 3600);

        const [cohortUsers, activeUsers] = await Promise.all([
          this.db.prepare(`
            SELECT COUNT(*) as count FROM users WHERE created_at >= ?
          `).bind(cohortStart).first(),
          this.db.prepare(`
            SELECT COUNT(DISTINCT user_id) as count
            FROM active_sessions
            WHERE user_id IN (SELECT id FROM users WHERE created_at >= ?)
              AND last_activity >= ?
          `).bind(cohortStart, now() - (24 * 3600)).first()
        ]);

        const rate = cohortUsers.count > 0
          ? ((activeUsers.count / cohortUsers.count) * 100).toFixed(2)
          : 0;

        return {
          day,
          cohortSize: cohortUsers.count,
          activeUsers: activeUsers.count,
          retentionRate: rate
        };
      });

      const retention = await Promise.all(retentionPromises);

      return { retention };
    } catch (error) {
      console.error('Get retention metrics error:', error);
      return { retention: [] };
    }
  }

  /**
   * Get messaging metrics
   */
  async getMessagingMetrics(period = '30d') {
    try {
      const periodMap = {
        '7d': 7 * 24 * 3600,
        '30d': 30 * 24 * 3600,
        '90d': 90 * 24 * 3600
      };

      const seconds = periodMap[period] || periodMap['30d'];
      const startTime = now() - seconds;

      const [conversations, messages, activeConversations] = await Promise.all([
        this.db.prepare(`
          SELECT COUNT(*) as count FROM conversations WHERE created_at >= ?
        `).bind(startTime).first(),
        
        this.db.prepare(`
          SELECT COUNT(*) as count FROM messages WHERE created_at >= ?
        `).bind(startTime).first(),
        
        this.db.prepare(`
          SELECT COUNT(DISTINCT conversation_id) as count 
          FROM messages 
          WHERE created_at >= ?
        `).bind(startTime).first()
      ]);

      return {
        period,
        newConversations: conversations.count,
        totalMessages: messages.count,
        activeConversations: activeConversations.count,
        avgMessagesPerConversation: activeConversations.count > 0 
          ? (messages.count / activeConversations.count).toFixed(2) 
          : 0
      };
    } catch (error) {
      console.error('Get messaging metrics error:', error);
      return {};
    }
  }

  /**
   * Get content moderation stats
   */
  async getModerationStats() {
    try {
      const [reports, bans, appeals] = await Promise.all([
        this.db.prepare(`
          SELECT status, COUNT(*) as count FROM reports GROUP BY status
        `).all(),
        
        this.db.prepare(`
          SELECT COUNT(*) as count FROM bans WHERE permanent = 0 AND expires_at > ?
        `).bind(now()).first(),
        
        this.db.prepare(`
          SELECT status, COUNT(*) as count FROM appeals GROUP BY status
        `).all()
      ]);

      const reportsByStatus = {};
      (reports.results || []).forEach(r => {
        reportsByStatus[r.status] = r.count;
      });

      const appealsByStatus = {};
      (appeals.results || []).forEach(a => {
        appealsByStatus[a.status] = a.count;
      });

      return {
        reports: reportsByStatus,
        activeBans: bans.count,
        appeals: appealsByStatus
      };
    } catch (error) {
      console.error('Get moderation stats error:', error);
      return {};
    }
  }

  /**
   * Export analytics report
   */
  async exportReport(period = '30d') {
    try {
      const [
        overview,
        userGrowth,
        engagement,
        activeUsers,
        topPosts,
        topReels,
        trending,
        languages,
        messaging,
        moderation
      ] = await Promise.all([
        this.getPlatformOverview(),
        this.getUserGrowth(period),
        this.getEngagementMetrics(period),
        this.getActiveUsers(),
        this.getTopContent('posts', 10),
        this.getTopContent('reels', 10),
        this.getTrendingTopics(10),
        this.getLanguageDistribution(),
        this.getMessagingMetrics(period),
        this.getModerationStats()
      ]);

      return {
        generatedAt: now(),
        period,
        overview,
        userGrowth,
        engagement,
        activeUsers,
        topContent: {
          posts: topPosts.content,
          reels: topReels.content
        },
        trending: trending.topics,
        languages: languages.languages,
        messaging,
        moderation
      };
    } catch (error) {
      console.error('Export report error:', error);
      throw error;
    }
  }
}
