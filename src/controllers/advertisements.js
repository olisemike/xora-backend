// Advertisement Controller - Admin management of ads
import { DatabaseService } from '../services/database.js';
import { AdService } from '../services/adService.js';
import { generateId, errorResponse, successResponse, now, parseCursor, createCursor, safeParseInt } from '../utils/helpers.js';
import { validateAdvertisement, safeJsonParse } from '../utils/validation.js';

export class AdvertisementController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
    // Initialize AdService with impression buffering (5s flush interval, batch size 100)
    this.adService = new AdService(this.db, env.CACHE);
    this.adService.initializeImpressionBuffering(5000, 100);
  }

  // ============================================
  // ADMIN: Create Advertisement
  // ============================================
  async createAd(request, adminInfo) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }

      // Validate advertisement data
      const validation = validateAdvertisement(body);
      if (!validation.isValid) {
        return errorResponse(validation.errors.join(', '), 400);
      }
      const {
        title,
        description,
        adType,
        contentUrl,
        scriptContent,
        thumbnailUrl,
        sdkProvider,
        sdkAdUnitId,
        sdkConfig,
        targetRegions,
        targetLanguages,
        targetDemographics,
        targetInterests,
        globalTargeting,
        placementFeeds,
        placementReels,
        placementStories,
        placementSearch,
        reelPosition,
        frequencyType,
        frequencyValue,
        maxImpressionsPerUser,
        maxClicksPerUser,
        priority,
        weight,
        totalBudget,
        costPerImpression,
        costPerClick,
        totalImpressionsLimit,
        totalClicksLimit,
        dailyImpressionsLimit,
        dailyBudgetLimit,
        ctaText,
        ctaUrl,
        startsAt,
        endsAt
      } = body;

      // Validation
      if (!title || !adType) {
        return errorResponse('Title and ad type are required', 400);
      }

      if (!['image', 'video', 'script', 'sdk'].includes(adType)) {
        return errorResponse('Invalid ad type', 400);
      }

      if (adType === 'script' && !scriptContent) {
        return errorResponse('Script content required for script ads', 400);
      }

      if ((adType === 'image' || adType === 'video') && !contentUrl) {
        return errorResponse('Content URL required for image/video ads', 400);
      }

      if (adType === 'sdk' && (!sdkProvider || !sdkAdUnitId)) {
        return errorResponse('SDK provider and ad unit ID required for SDK ads', 400);
      }

      if (!placementFeeds && !placementReels && !placementStories && !placementSearch) {
        return errorResponse('At least one placement type must be selected', 400);
      }

      if (placementReels && reelPosition && !['before', 'after', 'both'].includes(reelPosition)) {
        return errorResponse('Invalid reel position', 400);
      }

      const adId = generateId('ad');
      const timestamp = now();

      await this.env.DB.prepare(`
        INSERT INTO advertisements (
          id, title, description, ad_type, content_url, script_content, thumbnail_url,
          sdk_provider, sdk_ad_unit_id, sdk_config,
          target_regions, target_languages, target_demographics, target_interests, global_targeting,
          placement_feeds, placement_reels, placement_stories, placement_search, reel_position,
          frequency_type, frequency_value, max_impressions_per_user, max_clicks_per_user,
          priority, weight, total_budget, cost_per_impression, cost_per_click,
          total_impressions_limit, total_clicks_limit, daily_impressions_limit, daily_budget_limit,
          cta_text, cta_url, starts_at, ends_at,
          status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        adId, title, description || null, adType, contentUrl || null, scriptContent || null, thumbnailUrl || null,
        sdkProvider || null,
        sdkAdUnitId || null,
        JSON.stringify(sdkConfig || {}),
        JSON.stringify(targetRegions || []),
        JSON.stringify(targetLanguages || []),
        JSON.stringify(targetDemographics || {}),
        JSON.stringify(targetInterests || []),
        globalTargeting ? 1 : 0,
        placementFeeds ? 1 : 0,
        placementReels ? 1 : 0,
        placementStories ? 1 : 0,
        placementSearch ? 1 : 0,
        reelPosition || null,
        frequencyType || 'manual',
        frequencyValue || null,
        maxImpressionsPerUser || 3,
        maxClicksPerUser || 1,
        priority || 0,
        weight || 1.0,
        totalBudget || null,
        costPerImpression || null,
        costPerClick || null,
        totalImpressionsLimit || null,
        totalClicksLimit || null,
        dailyImpressionsLimit || null,
        dailyBudgetLimit || null,
        ctaText || null,
        ctaUrl || null,
        startsAt || null,
        endsAt || null,
        'draft',
        adminInfo.adminId,
        timestamp,
        timestamp
      ).run();

      // Log admin action
      await this.env.DB.prepare(`
        INSERT INTO admin_audit_logs (id, admin_id, action_type, target_type, target_id, details, created_at)
        VALUES (?, ?, 'create_ad', 'advertisement', ?, ?, ?)
      `).bind(generateId('log'), adminInfo.adminId, adId, title, timestamp).run();

      const ad = await this.env.DB.prepare(`
        SELECT * FROM advertisements WHERE id = ?
      `).bind(adId).first();

      if (!ad) {
        return errorResponse('Advertisement creation verification failed', 500);
      }

      return successResponse(this.formatAd(ad), 'Advertisement created successfully');
    } catch (error) {
      console.error('Create ad error:', error);
      return errorResponse('Failed to create advertisement', 500);
    }
  }

  // ============================================
  // ADMIN: List Advertisements
  // ============================================
  async listAds(request, _adminInfo) {
    try {
      const url = new URL(request.url);
      const status = url.searchParams.get('status');
      const placement = url.searchParams.get('placement');
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');

      const validPlacements = ['feeds', 'reels', 'stories', 'search'];
      if (placement && !validPlacements.includes(placement)) {
        return errorResponse('Invalid placement type', 400);
      }

      let query = `SELECT * FROM advertisements WHERE 1=1`;
      const params = [];

      if (status) {
        query += ` AND status = ?`;
        params.push(status);
      }

      if (placement === 'feeds') {
        query += ` AND placement_feeds = 1`;
      } else if (placement === 'reels') {
        query += ` AND placement_reels = 1`;
      } else if (placement === 'search') {
        query += ` AND placement_search = 1`;
      } else if (placement === 'stories') {
        query += ` AND placement_stories = 1`;
      }

      if (cursor) {
        const cursorData = parseCursor(cursor);
        if (cursorData?.created_at) {
          query += ` AND created_at < ?`;
          params.push(cursorData.created_at);
        }
      }

      query += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit + 1);

      const result = await this.env.DB.prepare(query).bind(...params).all();
      const ads = (result.results || []).map(ad => this.formatAd(ad));

      const hasMore = ads.length > limit;
      if (hasMore) ads.pop();

      const nextCursor = hasMore && ads.length > 0
        ? createCursor({ created_at: ads[ads.length - 1].createdAt })
        : null;

      return successResponse({
        ads,
        pagination: { hasMore, nextCursor }
      });
    } catch (error) {
      console.error('List ads error:', error);
      return errorResponse('Failed to list advertisements', 500);
    }
  }

  // ============================================
  // ADMIN: Get Advertisement Details
  // ============================================
  async getAd(request, adminInfo, adId) {
    try {
      const ad = await this.env.DB.prepare(`
        SELECT * FROM advertisements WHERE id = ?
      `).bind(adId).first();

      if (!ad) {
        return errorResponse('Advertisement not found', 404);
      }

      // Get analytics
      const analytics = await this.env.DB.prepare(`
        SELECT
          SUM(impressions) as total_impressions,
          SUM(views) as total_views,
          SUM(clicks) as total_clicks,
          SUM(spend) as total_spend
        FROM ad_analytics_daily
        WHERE ad_id = ?
      `).bind(adId).first();

      return successResponse({
        ...this.formatAd(ad),
        analytics: analytics || {
          total_impressions: 0,
          total_views: 0,
          total_clicks: 0,
          total_spend: 0
        }
      });
    } catch (error) {
      console.error('Get ad error:', error);
      return errorResponse('Failed to get advertisement', 500);
    }
  }

  // ============================================
  // ADMIN: Update Advertisement
  // ============================================
  async updateAd(request, adminInfo, adId) {
    try {
      const ad = await this.env.DB.prepare(`
        SELECT * FROM advertisements WHERE id = ?
      `).bind(adId).first();

      if (!ad) {
        return errorResponse('Advertisement not found', 404);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const updates = [];
      const params = [];

      // Whitelist of allowed fields to prevent SQL injection
      const ALLOWED_FIELDS = new Set([
        'title', 'description', 'content_url', 'script_content', 'thumbnail_url',
        'sdk_provider', 'sdk_ad_unit_id', 'sdk_config',
        'target_regions', 'target_languages', 'target_demographics', 'target_interests',
        'global_targeting', 'placement_feeds', 'placement_reels', 'placement_stories', 'placement_search',
        'reel_position', 'frequency_type', 'frequency_value', 'max_impressions_per_user',
        'max_clicks_per_user', 'priority', 'weight', 'total_budget', 'cost_per_impression',
        'cost_per_click', 'total_impressions_limit', 'total_clicks_limit',
        'daily_impressions_limit', 'daily_budget_limit', 'cta_text', 'cta_url',
        'starts_at', 'ends_at'
      ]);

      for (const field of ALLOWED_FIELDS) {
        const camelField = field.replace(/_(?<letter>[a-z])/g, (_, letter) => letter.toUpperCase());
        if (body[camelField] !== undefined) {
          // Field is guaranteed to be from whitelist
          updates.push(`${field} = ?`);

          // Handle JSON fields
          if (['target_regions', 'target_languages', 'target_demographics', 'target_interests', 'sdk_config'].includes(field)) {
            params.push(JSON.stringify(body[camelField]));
          } else if (['global_targeting', 'placement_feeds', 'placement_reels', 'placement_stories', 'placement_search'].includes(field)) {
            params.push(body[camelField] === true ? 1 : 0);
          } else {
            params.push(body[camelField]);
          }
        }
      }

      if (updates.length === 0) {
        return errorResponse('No fields to update', 400);
      }

      updates.push('updated_at = ?');
      params.push(now());
      params.push(adId);

      await this.env.DB.prepare(`
        UPDATE advertisements SET ${updates.join(', ')} WHERE id = ?
      `).bind(...params).run();

      // Log admin action
      await this.env.DB.prepare(`
        INSERT INTO admin_audit_logs (id, admin_id, action_type, target_type, target_id, created_at)
        VALUES (?, ?, 'update_ad', 'advertisement', ?, ?)
      `).bind(generateId('log'), adminInfo.adminId, adId, now()).run();

      const updatedAd = await this.env.DB.prepare(`
        SELECT * FROM advertisements WHERE id = ?
      `).bind(adId).first();

      if (!updatedAd) {
        return errorResponse('Advertisement update verification failed', 500);
      }

      return successResponse(this.formatAd(updatedAd), 'Advertisement updated successfully');
    } catch (error) {
      console.error('Update ad error:', error);
      return errorResponse('Failed to update advertisement', 500);
    }
  }

  // ============================================
  // ADMIN: Moderate Advertisement (Approve/Reject)
  // ============================================
  async moderateAd(request, adminInfo, adId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { action, moderationNotes, rejectionReason } = body;

      if (!['approve', 'reject'].includes(action)) {
        return errorResponse('Invalid moderation action', 400);
      }

      const ad = await this.env.DB.prepare(`
        SELECT * FROM advertisements WHERE id = ?
      `).bind(adId).first();

      if (!ad) {
        return errorResponse('Advertisement not found', 404);
      }

      const timestamp = now();
      const newStatus = action === 'approve' ? 'approved' : 'rejected';

      await this.env.DB.prepare(`
        UPDATE advertisements
        SET status = ?,
            approved_by = ?,
            approved_at = ?,
            moderation_notes = ?,
            rejection_reason = ?,
            updated_at = ?
        WHERE id = ?
      `).bind(
        newStatus,
        adminInfo.adminId,
        timestamp,
        moderationNotes || null,
        action === 'reject' ? rejectionReason : null,
        timestamp,
        adId
      ).run();

      // Log admin action
      await this.env.DB.prepare(`
        INSERT INTO admin_audit_logs (id, admin_id, action_type, target_type, target_id, details, created_at)
        VALUES (?, ?, ?, 'advertisement', ?, ?, ?)
      `).bind(
        generateId('log'),
        adminInfo.adminId,
        action === 'approve' ? 'approve_ad' : 'reject_ad',
        adId,
        JSON.stringify({ moderationNotes, rejectionReason }),
        timestamp
      ).run();

      return successResponse(null, `Advertisement ${action}d successfully`);
    } catch (error) {
      console.error('Moderate ad error:', error);
      return errorResponse('Failed to moderate advertisement', 500);
    }
  }

  // ============================================
  // ADMIN: Activate/Pause Advertisement
  // ============================================
  async toggleAdStatus(request, adminInfo, adId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { status } = body;

      if (!['active', 'paused'].includes(status)) {
        return errorResponse('Invalid status. Must be active or paused', 400);
      }

      const ad = await this.env.DB.prepare(`
        SELECT * FROM advertisements WHERE id = ?
      `).bind(adId).first();

      if (!ad) {
        return errorResponse('Advertisement not found', 404);
      }

      if (ad.status !== 'approved' && ad.status !== 'active' && ad.status !== 'paused') {
        return errorResponse('Only approved ads can be activated or paused', 400);
      }

      const timestamp = now();

      await this.env.DB.prepare(`
        UPDATE advertisements SET status = ?, updated_at = ? WHERE id = ?
      `).bind(status, timestamp, adId).run();

      // Log admin action
      await this.env.DB.prepare(`
        INSERT INTO admin_audit_logs (id, admin_id, action_type, target_type, target_id, created_at)
        VALUES (?, ?, ?, 'advertisement', ?, ?)
      `).bind(
        generateId('log'),
        adminInfo.adminId,
        status === 'active' ? 'activate_ad' : 'pause_ad',
        adId,
        timestamp
      ).run();

      return successResponse(null, `Advertisement ${status === 'active' ? 'activated' : 'paused'} successfully`);
    } catch (error) {
      console.error('Toggle ad status error:', error);
      return errorResponse('Failed to update advertisement status', 500);
    }
  }

  // ============================================
  // ADMIN: Delete Advertisement
  // ============================================
  async deleteAd(request, adminInfo, adId) {
    try {
      const ad = await this.env.DB.prepare(`
        SELECT * FROM advertisements WHERE id = ?
      `).bind(adId).first();

      if (!ad) {
        return errorResponse('Advertisement not found', 404);
      }

      await this.env.DB.prepare(`
        DELETE FROM advertisements WHERE id = ?
      `).bind(adId).run();

      // Log admin action
      await this.env.DB.prepare(`
        INSERT INTO admin_audit_logs (id, admin_id, action_type, target_type, target_id, details, created_at)
        VALUES (?, ?, 'delete_ad', 'advertisement', ?, ?, ?)
      `).bind(generateId('log'), adminInfo.adminId, adId, ad.title, now()).run();

      return successResponse(null, 'Advertisement deleted successfully');
    } catch (error) {
      console.error('Delete ad error:', error);
      return errorResponse('Failed to delete advertisement', 500);
    }
  }

  // ============================================
  // ADMIN: Get Advertisement Analytics
  // ============================================
  async getAdAnalytics(request, adminInfo, adId) {
    try {
      const url = new URL(request.url);
      const days = safeParseInt(url.searchParams.get('days'), 30, 1, 365);
      const ad = await this.env.DB.prepare(`
        SELECT * FROM advertisements WHERE id = ?
      `).bind(adId).first();

      if (!ad) {
        return errorResponse('Advertisement not found', 404);
      }

      // Get daily analytics
      const dailyAnalytics = await this.env.DB.prepare(`
        SELECT * FROM ad_analytics_daily
        WHERE ad_id = ?
        ORDER BY date DESC
        LIMIT ?
      `).bind(adId, days).all();

      // Get overall stats
      const overall = await this.env.DB.prepare(`
        SELECT
          SUM(impressions) as total_impressions,
          SUM(views) as total_views,
          SUM(clicks) as total_clicks,
          SUM(spend) as total_spend,
          SUM(unique_users) as total_unique_users,
          SUM(feed_impressions) as total_feed_impressions,
          SUM(reel_impressions) as total_reel_impressions,
          SUM(story_impressions) as total_story_impressions
        FROM ad_analytics_daily
        WHERE ad_id = ?
      `).bind(adId).first();

      // Calculate CTR and other metrics
      const ctr = overall.total_impressions > 0
        ? (overall.total_clicks / overall.total_impressions * 100).toFixed(2)
        : 0;

      const viewRate = overall.total_impressions > 0
        ? (overall.total_views / overall.total_impressions * 100).toFixed(2)
        : 0;

      return successResponse({
        ad: this.formatAd(ad),
        overall: {
          ...overall,
          ctr: parseFloat(ctr),
          viewRate: parseFloat(viewRate)
        },
        dailyBreakdown: dailyAnalytics.results || []
      });
    } catch (error) {
      console.error('Get ad analytics error:', error);
      return errorResponse('Failed to get advertisement analytics', 500);
    }
  }

  // ============================================
  // ADMIN: Get Global Advertisement Analytics
  // ============================================
  async getGlobalAnalytics(request, _adminInfo) {
    try {
      const url = new URL(request.url);
      const days = safeParseInt(url.searchParams.get('days'), 30, 1, 365);
      // Get overall stats
      const overall = await this.env.DB.prepare(`
        SELECT
          COUNT(DISTINCT ad_id) as total_ads,
          SUM(impressions) as total_impressions,
          SUM(views) as total_views,
          SUM(clicks) as total_clicks,
          SUM(spend) as total_spend
        FROM ad_analytics_daily
        WHERE date >= date('now', '-' || ? || ' days')
      `).bind(days).first();

      // Get top performing ads
      const topAds = await this.env.DB.prepare(`
        SELECT
          a.id, a.title, a.ad_type,
          SUM(ada.impressions) as impressions,
          SUM(ada.clicks) as clicks,
          SUM(ada.spend) as spend
        FROM advertisements a
        JOIN ad_analytics_daily ada ON a.id = ada.ad_id
        WHERE ada.date >= date('now', '-' || ? || ' days')
        GROUP BY a.id
        ORDER BY impressions DESC
        LIMIT 10
      `).bind(days).all();

      // Get active ads count
      const activeAds = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM advertisements WHERE status = 'active'
      `).first();

      return successResponse({
        overall,
        activeAdsCount: activeAds.count,
        topPerformingAds: topAds.results || []
      });
    } catch (error) {
      console.error('Get global analytics error:', error);
      return errorResponse('Failed to get global analytics', 500);
    }
  }

  // ============================================
  // ============================================
  // PUBLIC: Get Eligible Ads
  // ============================================
  async getEligibleAds(request, _userId) {
    try {
      const url = new URL(request.url);
      const placement = url.searchParams.get('placement') || url.searchParams.get('position') || 'feeds'; // feeds, reels, stories
      const userRegion = url.searchParams.get('region');
      const userLanguage = url.searchParams.get('language');
      const limit = Math.min(safeParseInt(url.searchParams.get('limit'), 5), 10);

      const timestamp = now();

      // Build dynamic WHERE clause for targeting
      let placementColumn;
      if (placement === 'reels') placementColumn = 'placement_reels';
      else if (placement === 'stories') placementColumn = 'placement_stories';
      else if (placement === 'search') placementColumn = 'placement_search';
      else placementColumn = 'placement_feeds';

      const query = `
        SELECT * FROM advertisements
        WHERE status = 'active'
          AND ${placementColumn} = 1
          AND (starts_at IS NULL OR starts_at <= ?)
          AND (ends_at IS NULL OR ends_at >= ?)
          AND (total_impressions_limit IS NULL OR total_impressions < total_impressions_limit)
          AND (total_clicks_limit IS NULL OR total_clicks < total_clicks_limit)
          AND (global_targeting = 1 OR target_regions LIKE ? OR target_languages LIKE ?)
        ORDER BY priority DESC, weight DESC, RANDOM()
        LIMIT ?
      `;

      const regionMatch = userRegion ? `%"${userRegion}"%` : '%';
      const languageMatch = userLanguage ? `%"${userLanguage}"%` : '%';

      const result = await this.env.DB.prepare(query)
        .bind(timestamp, timestamp, regionMatch, languageMatch, limit)
        .all();

      const ads = result.results ? result.results.map(ad => this.formatAd(ad)) : [];

      return successResponse({ ads });
    } catch (error) {
      console.error('Get eligible ads error:', error);
      return errorResponse('Failed to fetch ads', 500);
    }
  }

  // ============================================
  // PUBLIC: Track Ad Impression
  // ============================================
  async trackImpression(request, userId) {
    try {
      const adId = request.params?.adId;
      if (!adId) {
        return errorResponse('Ad ID required', 400);
      }

      // Extract additional tracking data from query params or body
      let requestData = {};
      try {
        const bodyText = await request.text();
        if (bodyText) {
          requestData = JSON.parse(bodyText);
        }
      } catch {
        // No body, that's OK
      }

      // Add impression to buffer for batch processing
      // This significantly reduces database writes - from individual INSERTs to batched operations
      const result = await this.adService.addImpressionToBuffer(
        adId,
        userId || 'anonymous',
        requestData.placementType || 'feed',
        {
          position: requestData.position,
          deviceType: requestData.deviceType,
          userAgent: request.headers.get('user-agent'),
          ipAddress: request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')
        }
      );

      // Also update real-time analytics (not buffered since these are aggregate queries)
      // This is lower volume - once per ad view, not per impression
      const timestamp = now();
      const [today] = new Date().toISOString().split('T');

      // Update advertisement totals (non-critical, can be approximate due to buffering)
      try {
        await this.env.DB.prepare(`
          UPDATE advertisements
          SET total_impressions = total_impressions + 1,
              total_spend = total_spend + COALESCE(cost_per_impression, 0),
              updated_at = ?
          WHERE id = ?
        `).bind(timestamp, adId).run();

        // Update daily analytics (for reporting)
        await this.env.DB.prepare(`
          INSERT INTO ad_analytics_daily (ad_id, date, impressions, clicks, spend, created_at, updated_at)
          VALUES (?, ?, 1, 0, COALESCE((SELECT cost_per_impression FROM advertisements WHERE id = ?), 0), ?, ?)
          ON CONFLICT(ad_id, date) DO UPDATE SET
            impressions = impressions + 1,
            spend = spend + COALESCE((SELECT cost_per_impression FROM advertisements WHERE id = ?), 0),
            updated_at = ?
        `).bind(adId, today, adId, timestamp, timestamp, adId, timestamp).run();
      } catch (error) {
        // Non-critical - don't fail the request if analytics update fails
        console.warn('Analytics update failed:', error.message);
      }

      return successResponse({ 
        tracked: true,
        buffered: result.buffered,
        bufferSize: result.bufferSize,
        deduped: !result.buffered && result.reason === 'Deduplicated'
      });
    } catch (error) {
      console.error('Track impression error:', error);
      return errorResponse('Failed to track impression', 500);
    }
  }

  // ============================================
  // PUBLIC: Batch Track Ad Impressions
  // ============================================
  async batchTrackImpressions(request, userId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }

      const { impressions } = body;
      if (!Array.isArray(impressions) || impressions.length === 0) {
        return errorResponse('Impressions array required', 400);
      }

      if (impressions.length > 500) {
        return errorResponse('Maximum 500 impressions per batch', 400);
      }

      // Add all impressions to buffer
      const results = [];
      const timestamp = now();
      const [today] = new Date().toISOString().split('T');
      const adsToUpdate = new Set();

      for (const imp of impressions) {
        if (!imp.adId) continue;

        const result = await this.adService.addImpressionToBuffer(
          imp.adId,
          userId || 'anonymous',
          imp.placementType || 'feed',
          {
            position: imp.position,
            deviceType: imp.deviceType,
            userAgent: request.headers.get('user-agent'),
            ipAddress: request.headers.get('cf-connecting-ip')
          }
        );

        results.push({ adId: imp.adId, ...result });
        adsToUpdate.add(imp.adId);
      }

      // Update analytics for all ads in batch
      try {
        for (const adId of adsToUpdate) {
          await this.env.DB.prepare(`
            UPDATE advertisements
            SET total_impressions = total_impressions + 1,
                total_spend = total_spend + COALESCE(cost_per_impression, 0),
                updated_at = ?
            WHERE id = ?
          `).bind(timestamp, adId).run();

          await this.env.DB.prepare(`
            INSERT INTO ad_analytics_daily (ad_id, date, impressions, clicks, spend, created_at, updated_at)
            VALUES (?, ?, 1, 0, COALESCE((SELECT cost_per_impression FROM advertisements WHERE id = ?), 0), ?, ?)
            ON CONFLICT(ad_id, date) DO UPDATE SET
              impressions = impressions + 1,
              spend = spend + COALESCE((SELECT cost_per_impression FROM advertisements WHERE id = ?), 0),
              updated_at = ?
          `).bind(adId, today, adId, timestamp, timestamp, adId, timestamp).run();
        }
      } catch (error) {
        console.warn('Analytics update failed:', error.message);
      }

      const bufferedCount = results.filter(r => r.buffered).length;
      const dedupedCount = results.filter(r => !r.buffered && r.reason === 'Deduplicated').length;

      return successResponse({
        tracked: true,
        totalImpressions: impressions.length,
        bufferedCount,
        dedupedCount,
        bufferStats: this.adService.getBufferStats()
      });
    } catch (error) {
      console.error('Batch track impressions error:', error);
      return errorResponse('Failed to batch track impressions', 500);
    }
  }

  // ============================================
  // ADMIN: Get Impression Buffer Stats
  // ============================================
  async getBufferStats(request, adminInfo) {
    try {
      // Require admin access
      if (!adminInfo || adminInfo.role !== 'admin') {
        return errorResponse('Admin access required', 403);
      }

      const stats = this.adService.getBufferStats();
      return successResponse(stats);
    } catch (error) {
      console.error('Get buffer stats error:', error);
      return errorResponse('Failed to get buffer stats', 500);
    }
  }

  // ============================================
  // ADMIN: Flush Impression Buffer
  // ============================================
  async flushBufferManually(request, adminInfo) {
    try {
      // Require admin access
      if (!adminInfo || adminInfo.role !== 'admin') {
        return errorResponse('Admin access required', 403);
      }

      const result = await this.adService.flushImpressionBuffer();
      return successResponse(result);
    } catch (error) {
      console.error('Flush buffer error:', error);
      return errorResponse('Failed to flush buffer', 500);
    }
  }

  // ============================================
  // PUBLIC: Track Ad Click
  // ============================================
  async trackClick(request, _userId) {
    try {
      const adId = request.params?.adId;
      if (!adId) {
        return errorResponse('Ad ID required', 400);
      }

      const timestamp = now();
      const [today] = new Date().toISOString().split('T');

      // Update advertisement totals
      await this.env.DB.prepare(`
        UPDATE advertisements
        SET total_clicks = total_clicks + 1,
            total_spend = total_spend + COALESCE(cost_per_click, 0),
            updated_at = ?
        WHERE id = ?
      `).bind(timestamp, adId).run();

      // Update daily analytics
      await this.env.DB.prepare(`
        INSERT INTO ad_analytics_daily (ad_id, date, impressions, clicks, spend, created_at, updated_at)
        VALUES (?, ?, 0, 1, COALESCE((SELECT cost_per_click FROM advertisements WHERE id = ?), 0), ?, ?)
        ON CONFLICT(ad_id, date) DO UPDATE SET
          clicks = clicks + 1,
          spend = spend + COALESCE((SELECT cost_per_click FROM advertisements WHERE id = ?), 0),
          updated_at = ?
      `).bind(adId, today, adId, timestamp, timestamp, adId, timestamp).run();

      return successResponse({ tracked: true });
    } catch (error) {
      console.error('Track click error:', error);
      return errorResponse('Failed to track click', 500);
    }
  }

  // Helper: Format Advertisement
  // ============================================
  formatAd(ad) {
    if (!ad) return null;

    return {
      id: ad.id,
      title: ad.title,
      description: ad.description,
      adType: ad.ad_type,
      contentUrl: ad.content_url,
      scriptContent: ad.script_content,
      thumbnailUrl: ad.thumbnail_url,
      sdkProvider: ad.sdk_provider,
      sdkAdUnitId: ad.sdk_ad_unit_id,
      sdkConfig: safeJsonParse(ad.sdk_config, {}),
      targetRegions: safeJsonParse(ad.target_regions, []),
      targetLanguages: safeJsonParse(ad.target_languages, []),
      targetDemographics: safeJsonParse(ad.target_demographics, {}),
      targetInterests: safeJsonParse(ad.target_interests, []),
      globalTargeting: ad.global_targeting === 1,
      placementFeeds: ad.placement_feeds === 1,
      placementReels: ad.placement_reels === 1,
      placementStories: ad.placement_stories === 1,
      placementSearch: ad.placement_search === 1,
      reelPosition: ad.reel_position,
      frequencyType: ad.frequency_type,
      frequencyValue: ad.frequency_value,
      maxImpressionsPerUser: ad.max_impressions_per_user,
      maxClicksPerUser: ad.max_clicks_per_user,
      priority: ad.priority,
      weight: ad.weight,
      totalBudget: ad.total_budget,
      costPerImpression: ad.cost_per_impression,
      costPerClick: ad.cost_per_click,
      totalImpressionsLimit: ad.total_impressions_limit,
      totalClicksLimit: ad.total_clicks_limit,
      dailyImpressionsLimit: ad.daily_impressions_limit,
      dailyBudgetLimit: ad.daily_budget_limit,
      ctaText: ad.cta_text,
      ctaUrl: ad.cta_url,
      startsAt: ad.starts_at,
      endsAt: ad.ends_at,
      status: ad.status,
      moderationNotes: ad.moderation_notes,
      rejectionReason: ad.rejection_reason,
      totalImpressions: ad.total_impressions,
      totalClicks: ad.total_clicks,
      totalSpend: ad.total_spend,
      createdBy: ad.created_by,
      approvedBy: ad.approved_by,
      approvedAt: ad.approved_at,
      createdAt: ad.created_at,
      updatedAt: ad.updated_at
    };
  }
}
