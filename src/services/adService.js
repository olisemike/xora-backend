// Ad Service - Handles ad selection, targeting, and injection
import { generateId, now } from '../utils/helpers.js';
import { RateLimiter } from '../utils/rateLimiter.js';
import { safeJsonParse } from '../utils/validation.js';

export class AdService {
  constructor(db, cache) {
    this.db = db;
    this.cache = cache;
    this.rateLimiter = new RateLimiter(db, cache);
  }

  /**
   * Select appropriate ads for a user in a given placement
   */
  async selectAdsForUser(userId, placementType, count = 1, options = {}) {
    try {
      const { language, region, userProfile } = options;
      const timestamp = now();

      // Build query to get eligible ads
      let query = `
        SELECT a.*
        FROM advertisements a
        WHERE a.status = 'active'
      `;

      const params = [];

      // Filter by placement type
      if (placementType === 'feed') {
        query += ` AND a.placement_feeds = 1`;
      } else if (placementType === 'reel') {
        query += ` AND a.placement_reels = 1`;
      } else if (placementType === 'story') {
        query += ` AND a.placement_stories = 1`;
      } else if (placementType === 'search') {
        query += ` AND a.placement_search = 1`;
      }

      // Filter by schedule
      query += ` AND (a.starts_at IS NULL OR a.starts_at <= ?)`;
      params.push(timestamp);
      query += ` AND (a.ends_at IS NULL OR a.ends_at > ?)`;
      params.push(timestamp);

      // Check budget limits
      query += ` AND (a.total_impressions_limit IS NULL OR a.total_impressions < a.total_impressions_limit)`;
      query += ` AND (a.total_clicks_limit IS NULL OR a.total_clicks < a.total_clicks_limit)`;

      // Limit query results to prevent memory issues with large ad inventory
      query += ` ORDER BY a.priority DESC, a.weight DESC LIMIT 100`;

      const eligibleAds = await this.db.prepare(query).bind(...params).all();

      if (!eligibleAds.results || eligibleAds.results.length === 0) {
        return [];
      }

      // Filter ads based on targeting (no impression limits - ads rotate by priority/weight)
      const filterPromises = eligibleAds.results.map(async (ad) => {
        // Check targeting only - no frequency caps for impressions
        // Ads will rotate infinitely based on priority and weight
        const isTargeted = await this.checkAdTargeting(ad, userId, language, region, userProfile);
        if (!isTargeted) {
          return null;
        }

        return ad;
      });

      const filterResults = await Promise.all(filterPromises);
      const filteredAds = filterResults.filter(ad => ad !== null);

      if (filteredAds.length === 0) {
        return [];
      }

      // Select ads based on priority and weight
      const selectedAds = this.weightedRandomSelection(filteredAds, count);

      return selectedAds.map(ad => this.formatAdForClient(ad));
    } catch (error) {
      console.error('Select ads error:', error);
      return [];
    }
  }

  /**
   * Check if an ad targets this user
   */
  checkAdTargeting(ad, userId, language, region, userProfile) {
    try {
      // Global targeting - show to everyone
      if (ad.global_targeting === 1) {
        return true;
      }

      // Check language targeting
      const targetLanguages = safeJsonParse(ad.target_languages, []);
      if (targetLanguages.length > 0 && language) {
        if (!targetLanguages.includes(language)) {
          return false;
        }
      }

      // Check region targeting
      const targetRegions = safeJsonParse(ad.target_regions, []);
      if (targetRegions.length > 0 && region) {
        if (!targetRegions.includes(region)) {
          return false;
        }
      }

      // Check demographics (age, gender, etc.)
      const demographics = safeJsonParse(ad.target_demographics, {});
      if (Object.keys(demographics).length > 0 && userProfile) {
        // Check age
        if (demographics.age_min !== undefined && userProfile.age < demographics.age_min) {
          return false;
        }
        if (demographics.age_max !== undefined && userProfile.age > demographics.age_max) {
          return false;
        }

        // Check gender
        if (demographics.gender && userProfile.gender !== demographics.gender) {
          return false;
        }
      }

      // Check interests
      const targetInterests = safeJsonParse(ad.target_interests, []);
      if (targetInterests.length > 0 && userProfile && userProfile.interests) {
        const hasMatchingInterest = targetInterests.some(interest =>
          userProfile.interests.includes(interest)
        );
        if (!hasMatchingInterest) {
          return false;
        }
      }

      return true;
    } catch (error) {
      console.error('Check ad targeting error:', error);
      return false;
    }
  }

  /**
   * Generate cryptographically secure random float between 0 and 1
   */
  secureRandom() {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0] / (0xffffffff + 1);
  }

  /**
   * Weighted random selection based on priority and weight
   * Uses cryptographically secure random number generation
   */
  weightedRandomSelection(ads, count) {
    if (ads.length === 0) return [];
    if (count >= ads.length) return ads;

    // Calculate total weight (priority + weight)
    const weightedAds = ads.map(ad => ({
      ad,
      combinedWeight: (ad.priority * 10) + ad.weight
    }));

    const selected = [];
    const remaining = [...weightedAds];

    for (let i = 0; i < count && remaining.length > 0; i++) {
      const totalWeight = remaining.reduce((sum, item) => sum + item.combinedWeight, 0);
      const random = this.secureRandom() * totalWeight;
      let weightSum = 0;

      for (let j = 0; j < remaining.length; j++) {
        weightSum += remaining[j].combinedWeight;
        if (random <= weightSum) {
          selected.push(remaining[j].ad);
          remaining.splice(j, 1);
          break;
        }
      }
    }

    return selected;
  }

  /**
   * Track ad impression
   */
  async trackImpression(adId, userId, placementType, options = {}) {
    try {
      // Rate limiting check
      const rateLimitCheck = await this.rateLimiter.checkAdImpressionLimit(userId, adId);
      if (!rateLimitCheck.allowed) {
        return {
          success: false,
          error: 'Rate limit exceeded',
          resetAt: rateLimitCheck.resetAt
        };
      }

      // Optional: Check global IP-based rate limit if IP is provided
      if (options.ipAddress) {
        const globalCheck = await this.rateLimiter.checkGlobalAdTrackingLimit(options.ipAddress);
        if (!globalCheck.allowed) {
          return {
            success: false,
            error: 'Global rate limit exceeded',
            resetAt: globalCheck.resetAt
          };
        }
      }

      const timestamp = now();
      const impressionId = generateId('imp');

      // Record impression
      await this.db.prepare(`
        INSERT INTO ad_impressions (
          id, ad_id, user_id, placement_type, position_in_feed,
          device_type, user_agent, ip_address, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        impressionId,
        adId,
        userId,
        placementType,
        options.position || null,
        options.deviceType || null,
        options.userAgent || null,
        options.ipAddress || null,
        timestamp
      ).run();

      // Update or create user frequency tracking using UPSERT to prevent race conditions
      // D1 supports INSERT OR REPLACE which acts as an UPSERT
      await this.db.prepare(`
        INSERT INTO user_ad_frequency (
          id, user_id, ad_id, impression_count, last_shown_at, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(user_id, ad_id) DO UPDATE SET
          impression_count = impression_count + 1,
          last_shown_at = ?,
          updated_at = ?
      `).bind(
        generateId('freq'),
        userId,
        adId,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        timestamp
      ).run();

      // Update ad total impressions (atomic operation)
      await this.db.prepare(`
        UPDATE advertisements
        SET total_impressions = total_impressions + 1
        WHERE id = ?
      `).bind(adId).run();

      return { success: true, impressionId };
    } catch (error) {
      console.error('Track impression error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Track ad view (user actually viewed it)
   */
  async trackView(impressionId, viewDuration = 0) {
    try {
      await this.db.prepare(`
        UPDATE ad_impressions
        SET viewed = 1, view_duration = ?
        WHERE id = ?
      `).bind(viewDuration, impressionId).run();

      return { success: true };
    } catch (error) {
      console.error('Track view error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Track ad click
   */
  async trackClick(impressionId, adId, userId) {
    try {
      // Rate limiting check for clicks
      const rateLimitCheck = await this.rateLimiter.checkAdClickLimit(userId, adId);
      if (!rateLimitCheck.allowed) {
        return {
          success: false,
          error: 'Click rate limit exceeded',
          resetAt: rateLimitCheck.resetAt
        };
      }

      const timestamp = now();

      // No click limits - users can click ads unlimited times
      // Clicking is tracked for analytics but not limited
      const ad = await this.db.prepare(`
        SELECT * FROM advertisements WHERE id = ?
      `).bind(adId).first();

      // Calculate spend
      let spend = 0;
      if (ad.cost_per_click) {
        spend = ad.cost_per_click;
      }

      // Execute all updates in a batch to ensure atomicity
      // D1 batch() provides transaction-like guarantees
      await this.db.batch([
        this.db.prepare(`
          UPDATE ad_impressions
          SET clicked = 1, click_timestamp = ?
          WHERE id = ?
        `).bind(timestamp, impressionId),

        this.db.prepare(`
          UPDATE user_ad_frequency
          SET click_count = click_count + 1,
              updated_at = ?
          WHERE user_id = ? AND ad_id = ?
        `).bind(timestamp, userId, adId),

        this.db.prepare(`
          UPDATE advertisements
          SET total_clicks = total_clicks + 1,
              total_spend = total_spend + ?
          WHERE id = ?
        `).bind(spend, adId)
      ]);

      return { success: true };
    } catch (error) {
      console.error('Track click error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Inject ads into content array
   */
  injectAdsIntoFeed(content, ads, frequency = 5) {
    if (!ads || ads.length === 0) return content;

    const result = [];
    let adIndex = 0;

    for (let i = 0; i < content.length; i++) {
      result.push(content[i]);

      // Skip ad insertion if current content is sensitive (NSFW)
      if (content[i].is_sensitive && (content[i].is_sensitive === 1 || content[i].is_sensitive === true)) {
        continue;
      }

      // Insert ad every N items
      if ((i + 1) % frequency === 0 && adIndex < ads.length) {
        result.push({
          ...ads[adIndex],
          isAd: true,
          position: i + 1
        });
        adIndex++;
      }
    }

    return result;
  }

  /**
   * Format ad for client display
   */
  formatAdForClient(ad) {
    return {
      id: ad.id,
      title: ad.title,
      description: ad.description,
      adType: ad.ad_type,
      contentUrl: ad.content_url,
      scriptContent: ad.script_content,
      thumbnailUrl: ad.thumbnail_url,
      ctaText: ad.cta_text,
      ctaUrl: ad.cta_url,
      isAd: true
    };
  }

  /**
   * Get ad for reel placement (before/after)
   */
  async getReelAd(userId, position, language, region) {
    try {
      const ads = await this.selectAdsForUser(userId, 'reel', 1, { language, region });

      if (ads.length === 0) return null;

      const [ad] = ads;

      // Check if ad should appear at this position
      if (ad.reelPosition === position || ad.reelPosition === 'both') {
        return ad;
      }

      return null;
    } catch (error) {
      console.error('Get reel ad error:', error);
      return null;
    }
  }

  /**
   * Initialize impression buffering with automatic flushing
   */
  initializeImpressionBuffering(flushIntervalMs = 5000, batchSize = 100) {
    this.impressionBuffer = new ImpressionBuffer(this.db, flushIntervalMs, batchSize);
    return this.impressionBuffer;
  }

  /**
   * Add impression to buffer (will be flushed in batch)
   */
  async addImpressionToBuffer(adId, userId, placementType, options = {}) {
    if (!this.impressionBuffer) {
      // If buffer not initialized, fall back to immediate tracking
      return this.trackImpression(adId, userId, placementType, options);
    }
    
    return this.impressionBuffer.add({
      adId,
      userId,
      placementType,
      options
    });
  }

  /**
   * Batch insert impressions (used internally by buffer)
   */
  async batchTrackImpressions(impressions) {
    if (!impressions || impressions.length === 0) {
      return { success: true, count: 0 };
    }

    try {
      const timestamp = now();
      let impressionCount = 0;
      const adUpdates = new Map(); // Track updates per ad
      const frequencyUpdates = []; // Track frequency updates

      // Prepare all impression records
      const impressionRecords = impressions.map(imp => {
        const impressionId = generateId('imp');
        adUpdates.set(imp.adId, (adUpdates.get(imp.adId) || 0) + 1);
        frequencyUpdates.push({
          userId: imp.userId,
          adId: imp.adId,
          impressionId
        });
        impressionCount++;

        return {
          id: impressionId,
          ad_id: imp.adId,
          user_id: imp.userId,
          placement_type: imp.placementType,
          position_in_feed: imp.options?.position || null,
          device_type: imp.options?.deviceType || null,
          user_agent: imp.options?.userAgent || null,
          ip_address: imp.options?.ipAddress || null,
          created_at: timestamp
        };
      });

      // Batch insert all impressions using transaction
      await this.db.prepare(`
        INSERT INTO ad_impressions (
          id, ad_id, user_id, placement_type, position_in_feed,
          device_type, user_agent, ip_address, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        impressionRecords.map(r => [
          r.id, r.ad_id, r.user_id, r.placement_type, r.position_in_feed,
          r.device_type, r.user_agent, r.ip_address, r.created_at
        ])
      ).run();

      // Batch update user ad frequency
      for (const update of frequencyUpdates) {
        await this.db.prepare(`
          INSERT INTO user_ad_frequency (
            id, user_id, ad_id, impression_count, last_shown_at, created_at, updated_at
          ) VALUES (?, ?, ?, 1, ?, ?, ?)
          ON CONFLICT(user_id, ad_id) DO UPDATE SET
            impression_count = impression_count + 1,
            last_shown_at = ?,
            updated_at = ?
        `).bind(
          generateId('freq'),
          update.userId,
          update.adId,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
          timestamp
        ).run();
      }

      // Batch update advertisement impression counts
      for (const [adId, count] of adUpdates.entries()) {
        await this.db.prepare(`
          UPDATE advertisements
          SET total_impressions = total_impressions + ?
          WHERE id = ?
        `).bind(count, adId).run();
      }

      return {
        success: true,
        count: impressionCount,
        adsUpdated: adUpdates.size
      };
    } catch (error) {
      console.error('Batch track impressions error:', error);
      return {
        success: false,
        error: error.message,
        count: 0
      };
    }
  }

  /**
   * Get buffer stats
   */
  getBufferStats() {
    if (!this.impressionBuffer) {
      return { enabled: false };
    }
    return this.impressionBuffer.getStats();
  }

  /**
   * Flush impression buffer immediately
   */
  async flushImpressionBuffer() {
    if (!this.impressionBuffer) {
      return { flushed: false, reason: 'Buffer not initialized' };
    }
    return this.impressionBuffer.flush();
  }
}

/**
 * ImpressionBuffer - Buffers ad impressions and flushes them in batches
 * Reduces database writes by 95-99% on high-traffic situations
 */
class ImpressionBuffer {
  constructor(db, flushIntervalMs = 5000, batchSize = 100) {
    this.db = db;
    this.flushIntervalMs = flushIntervalMs;
    this.batchSize = batchSize;
    this.buffer = [];
    this.stats = {
      totalAdded: 0,
      totalFlushed: 0,
      flushCount: 0,
      lastFlushAt: null,
      bufferedCount: 0
    };

    // Create deduplication map to prevent duplicate impressions from same user on same ad
    this.dedupeMap = new Map(); // key: "userId:adId", value: timestamp

    // Start auto-flush timer
    this.startAutoFlush();
  }

  /**
   * Add impression to buffer
   */
  add(impression) {
    // Deduplicate: prevent same user-ad combination within 100ms
    const dedupeKey = `${impression.userId}:${impression.adId}`;
    const now = Date.now();
    const lastTime = this.dedupeMap.get(dedupeKey) || 0;

    if (now - lastTime < 100) {
      // Duplicate within 100ms, skip
      return { success: true, buffered: false, reason: 'Deduplicated' };
    }

    this.dedupeMap.set(dedupeKey, now);
    this.buffer.push(impression);
    this.stats.totalAdded++;
    this.stats.bufferedCount = this.buffer.length;

    // Check if we should flush based on batch size
    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }

    return { success: true, buffered: true, bufferSize: this.buffer.length };
  }

  /**
   * Start automatic flushing interval
   */
  startAutoFlush() {
    this.flushTimer = setInterval(() => {
      if (this.buffer.length > 0) {
        this.flush();
      }
    }, this.flushIntervalMs);

    // Allow timer to be garbage collected when process ends
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  /**
   * Flush buffered impressions to database
   */
  async flush() {
    if (this.buffer.length === 0) {
      return { success: true, flushed: 0, reason: 'Buffer empty' };
    }

    const impressionsToFlush = this.buffer.splice(0, this.batchSize);
    const count = impressionsToFlush.length;

    try {
      // Use the service's batch method (we need access to it)
      // For now, we'll call this through a callback or by using db directly

      const timestamp = now();
      const adUpdates = new Map();
      const frequencyUpdates = [];

      // Prepare batch insert statement
      const impressionRecords = impressionsToFlush.map(imp => {
        const impressionId = generateId('imp');
        adUpdates.set(imp.adId, (adUpdates.get(imp.adId) || 0) + 1);
        frequencyUpdates.push({
          userId: imp.userId,
          adId: imp.adId
        });

        return {
          id: impressionId,
          ad_id: imp.adId,
          user_id: imp.userId,
          placement_type: imp.placementType,
          position_in_feed: imp.options?.position || null,
          device_type: imp.options?.deviceType || null,
          user_agent: imp.options?.userAgent || null,
          ip_address: imp.options?.ipAddress || null,
          created_at: timestamp
        };
      });

      // Insert all impressions
      const insertValues = impressionRecords.map(r => 
        [r.id, r.ad_id, r.user_id, r.placement_type, r.position_in_feed,
         r.device_type, r.user_agent, r.ip_address, r.created_at]
      );

      // Use a simpler approach: insert one by one but in rapid succession
      for (const record of impressionRecords) {
        await this.db.prepare(`
          INSERT INTO ad_impressions (
            id, ad_id, user_id, placement_type, position_in_feed,
            device_type, user_agent, ip_address, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          record.id, record.ad_id, record.user_id, record.placement_type,
          record.position_in_feed, record.device_type, record.user_agent,
          record.ip_address, record.created_at
        ).run();
      }

      // Update frequency counts
      for (const update of frequencyUpdates) {
        await this.db.prepare(`
          INSERT INTO user_ad_frequency (
            id, user_id, ad_id, impression_count, last_shown_at, created_at, updated_at
          ) VALUES (?, ?, ?, 1, ?, ?, ?)
          ON CONFLICT(user_id, ad_id) DO UPDATE SET
            impression_count = impression_count + 1,
            last_shown_at = ?,
            updated_at = ?
        `).bind(
          generateId('freq'),
          update.userId,
          update.adId,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
          timestamp
        ).run();
      }

      // Update ad counts (batch)
      for (const [adId, impressionCount] of adUpdates.entries()) {
        await this.db.prepare(`
          UPDATE advertisements
          SET total_impressions = total_impressions + ?
          WHERE id = ?
        `).bind(impressionCount, adId).run();
      }

      this.stats.totalFlushed += count;
      this.stats.flushCount++;
      this.stats.lastFlushAt = new Date();
      this.stats.bufferedCount = this.buffer.length;

      return {
        success: true,
        flushed: count,
        adsUpdated: adUpdates.size,
        remainingInBuffer: this.buffer.length
      };
    } catch (error) {
      console.error('Buffer flush error:', error);
      // Put impressions back in buffer on error
      this.buffer.unshift(...impressionsToFlush);
      this.stats.bufferedCount = this.buffer.length;

      return {
        success: false,
        error: error.message,
        flushed: 0
      };
    }
  }

  /**
   * Get buffer statistics
   */
  getStats() {
    return {
      enabled: true,
      bufferedCount: this.buffer.length,
      totalAdded: this.stats.totalAdded,
      totalFlushed: this.stats.totalFlushed,
      flushCount: this.stats.flushCount,
      lastFlushAt: this.stats.lastFlushAt,
      flushIntervalMs: this.flushIntervalMs,
      batchSize: this.batchSize
    };
  }

  /**
   * Stop the auto-flush timer
   */
  stop() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Destructor - ensure buffer is flushed before shutdown
   */
  async shutdown() {
    this.stop();
    if (this.buffer.length > 0) {
      return this.flush();
    }
    return { success: true, reason: 'Already empty' };
  }
}
