// ============================================
// FEED ALGORITHM - PART 2
// Decay System & Engagement Tracking
// ============================================

import { generateId, now, hoursFromNow, FEED_BATCH_SIZES, RECOVERY_THRESHOLD, DECAY_PERIOD_HOURS, safeJsonParse, safeJsonParseArray } from '../utils/helpers.js';

/**
 * Additional methods for FeedAlgorithmService
 * Add these to the class in feedAlgorithm.js
 */

export class DecaySystem {
  constructor(db) {
    this.db = db;
  }

  /**
   * Start decay process for underperforming post
   */
  async startDecayProcess(batch) {
    try {
      const currentIndex = FEED_BATCH_SIZES.indexOf(batch.batch_size);
      
      if (currentIndex === 0) {
        // Already at minimum - terminate after decay period
        await this.scheduleTermination(batch.post_id);
        // Post in final decay period
      } else {
        // Step down to lower batch
        const newBatchSize = FEED_BATCH_SIZES[currentIndex - 1];
        await this.createDecayBatch(batch, newBatchSize);
        // Post decayed
      }
    } catch (error) {
      console.error('Start decay error:', error);
      throw error;
    }
  }

  /**
   * Create decay batch (special batch during decay period)
   */
  async createDecayBatch(previousBatch, newBatchSize) {
    try {
      const timestamp = now();
      const decayEndTime = hoursFromNow(DECAY_PERIOD_HOURS / FEED_BATCH_SIZES.length); // Split decay period

      // Mark previous batch
      await this.db.prepare(`
        UPDATE post_suggestion_batches
        SET status = 'completed'
        WHERE id = ?
      `).bind(previousBatch.id).run();

      // Create decay batch
      const newBatchId = generateId('batch');
      await this.db.prepare(`
        INSERT INTO post_suggestion_batches (
          id, post_id, batch_size, batch_number, status,
          window_type, window_start, window_end, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        newBatchId,
        previousBatch.post_id,
        newBatchSize,
        previousBatch.batch_number + 1,
        'active',
        'decay',
        timestamp,
        decayEndTime,
        timestamp
      ).run();

      // Get post details
      const post = await this.db.prepare(`
        SELECT actor_type, actor_id, language FROM posts WHERE id = ?
      `).bind(previousBatch.post_id).first();

      // Expose to candidates
      const feedAlgo = new (await import('./feedAlgorithm.js')).FeedAlgorithmService(this.db, null);
      await feedAlgo.selectAndExposeCandidates(
        previousBatch.post_id,
        newBatchId,
        newBatchSize,
        post.language,
        post.actor_type,
        post.actor_id
      );
    } catch (error) {
      console.error('Create decay batch error:', error);
      throw error;
    }
  }

  /**
   * Evaluate decay batch
   */
  async evaluateDecayBatch(batch, engagementRate) {
    try {
      if (engagementRate >= RECOVERY_THRESHOLD) {
        // RECOVERY: Engagement recovered above 20%
        await this.recoverFromDecay(batch);
      } else {
        // Continue decay
        const currentIndex = FEED_BATCH_SIZES.indexOf(batch.batch_size);
        
        if (currentIndex === 0) {
          // Reached minimum - terminate
          await this.terminateDistribution(batch.post_id, 'decay_complete');
        } else {
          // Continue stepping down
          const newBatchSize = FEED_BATCH_SIZES[currentIndex - 1];
          await this.createDecayBatch(batch, newBatchSize);
        }
      }
    } catch (error) {
      console.error('Evaluate decay batch error:', error);
      throw error;
    }
  }

  /**
   * Recover post from decay
   */
  async recoverFromDecay(batch) {
    try {
      // Pause decay - stay at current batch size
      const timestamp = now();

      await this.db.prepare(`
        UPDATE post_suggestion_batches
        SET status = 'completed'
        WHERE id = ?
      `).bind(batch.id).run();

      // Create new stability batch at current size
      const newBatchId = generateId('batch');
      await this.db.prepare(`
        INSERT INTO post_suggestion_batches (
          id, post_id, batch_size, batch_number, status,
          window_type, window_start, window_end, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        newBatchId,
        batch.post_id,
        batch.batch_size,
        batch.batch_number + 1,
        'active',
        'stability',
        timestamp,
        hoursFromNow(60), // Back to stability window
        timestamp
      ).run();

      // Post recovered from decay
    } catch (error) {
      console.error('Recover from decay error:', error);
      throw error;
    }
  }

  /**
   * Schedule termination after decay period
   */
  async scheduleTermination(postId) {
    try {
      // Set termination time
      const terminateAt = hoursFromNow(DECAY_PERIOD_HOURS);
      
      await this.db.prepare(`
        UPDATE post_suggestion_batches
        SET status = 'scheduled_termination', window_end = ?
        WHERE post_id = ? AND status = 'active'
      `).bind(terminateAt, postId).run();

      // Post scheduled for termination
    } catch (error) {
      console.error('Schedule termination error:', error);
      throw error;
    }
  }

  async terminateDistribution(postId, _reason) {
    try {
      await this.db.prepare(`
        UPDATE post_suggestion_batches
        SET status = 'terminated'
        WHERE post_id = ? AND status IN ('active', 'scheduled_termination')
      `).bind(postId).run();

      // Post terminated
    } catch (error) {
      console.error('Terminate distribution error:', error);
      throw error;
    }
  }
}

/**
 * Engagement Tracking Service
 */
export class EngagementTracker {
  constructor(db) {
    this.db = db;
  }

  /**
   * Record engagement (like, comment, share, bookmark)
   */
  async recordEngagement(postId, userId, engagementType) {
    try {
      // Update exposure record
      await this.db.prepare(`
        UPDATE post_exposures
        SET engaged = 1
        WHERE post_id = ? AND user_id = ? AND engaged = 0
      `).bind(postId, userId).run();

      // Get active batch for this post
      const batch = await this.db.prepare(`
        SELECT * FROM post_suggestion_batches
        WHERE post_id = ? AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
      `).bind(postId).first();

      if (batch) {
        // Increment batch engagements
        await this.db.prepare(`
          UPDATE post_suggestion_batches
          SET engagements = engagements + 1,
              engagement_rate = (engagements + 1) * 100.0 / NULLIF(impressions, 0)
          WHERE id = ?
        `).bind(batch.id).run();
      }

      // Update user behavior profile
      await this.updateUserBehavior(userId, postId, engagementType);

      // Engagement recorded
    } catch (error) {
      console.error('Record engagement error:', error);
      throw error;
    }
  }

  /**
   * Update user behavior profile for better suggestions
   */
  async updateUserBehavior(userId, postId, engagementType) {
    try {
      // Get post details
      const post = await this.db.prepare(`
        SELECT language, content FROM posts WHERE id = ?
      `).bind(postId).first();

      // Get or create behavior profile
      const profile = await this.db.prepare(`
        SELECT * FROM user_behavior_profiles WHERE user_id = ?
      `).bind(userId).first();

      if (profile) {
        // Update existing profile
        const languages = safeJsonParseArray(profile.languages);
        if (!languages.includes(post.language)) {
          languages.push(post.language);
        }

        const patterns = safeJsonParse(profile.engagement_patterns, {});
        if (!languages.includes(post.language)) {
          languages.push(post.language);
        }

        patterns[engagementType] = (patterns[engagementType] || 0) + 1;

        await this.db.prepare(`
          UPDATE user_behavior_profiles
          SET languages = ?, engagement_patterns = ?, last_updated = ?
          WHERE user_id = ?
        `).bind(
          JSON.stringify(languages),
          JSON.stringify(patterns),
          now(),
          userId
        ).run();
      }
    } catch (error) {
      console.error('Update user behavior error:', error);
      // Non-critical, don't throw
    }
  }

  /**
   * Get engagement stats for a post
   */
  async getEngagementStats(postId) {
    try {
      const stats = await this.db.prepare(`
        SELECT 
          COUNT(DISTINCT user_id) as total_impressions,
          COUNT(DISTINCT CASE WHEN engaged = 1 THEN user_id END) as total_engagements,
          (COUNT(DISTINCT CASE WHEN engaged = 1 THEN user_id END) * 100.0 / 
           NULLIF(COUNT(DISTINCT user_id), 0)) as overall_engagement_rate
        FROM post_exposures
        WHERE post_id = ?
      `).bind(postId).first();

      return stats;
    } catch (error) {
      console.error('Get engagement stats error:', error);
      return { total_impressions: 0, total_engagements: 0, overall_engagement_rate: 0 };
    }
  }

  /**
   * Get current batch status for a post
   */
  async getCurrentBatchStatus(postId) {
    try {
      const batch = await this.db.prepare(`
        SELECT * FROM post_suggestion_batches
        WHERE post_id = ? AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
      `).bind(postId).first();

      if (!batch) {
        return { status: 'not_distributed' };
      }

      return {
        status: 'active',
        batchSize: batch.batch_size,
        windowType: batch.window_type,
        impressions: batch.impressions,
        engagements: batch.engagements,
        engagementRate: batch.engagement_rate,
        windowEnd: batch.window_end,
        timeRemaining: Math.max(0, batch.window_end - now())
      };
    } catch (error) {
      console.error('Get batch status error:', error);
      return { status: 'error' };
    }
  }
}

/**
 * Batch Processing Scheduler
 * Call this periodically (e.g., every 5 minutes)
 */
export class BatchScheduler {
  constructor(db, cache) {
    this.db = db;
    this.cache = cache;
  }

  /**
   * Process all expired batches
   */
  async processExpiredBatches() {
    try {
      const feedAlgo = new (await import('./feedAlgorithm.js')).FeedAlgorithmService(this.db, this.cache);
      const decaySystem = new DecaySystem(this.db);
      
      const currentTime = now();

      // Get expired batches
      const batches = await this.db.prepare(`
        SELECT * FROM post_suggestion_batches
        WHERE status = 'active' AND window_end <= ?
        ORDER BY created_at ASC
        LIMIT 50
      `).bind(currentTime).all();

      const results = batches.results || [];

      const evaluationPromises = results.map(async (batch) => {
        try {
          // Get engagement rate
          const engagement = await this.db.prepare(`
            SELECT COUNT(*) as count FROM post_exposures
            WHERE batch_id = ? AND engaged = 1
          `).bind(batch.id).first();

          const engagementRate = (engagement.count / batch.impressions) * 100;

          // Handle based on window type
          if (batch.window_type === 'decay') {
            await decaySystem.evaluateDecayBatch(batch, engagementRate);
          } else {
            await feedAlgo.evaluateBatch(batch);
          }
        } catch (error) {
          console.error(`Error processing batch ${batch.id}:`, error);
        }
      });
      await Promise.all(evaluationPromises);

      // Processed batches
      return results.length;
    } catch (error) {
      console.error('Batch scheduler error:', error);
      throw error;
    }
  }

  /**
   * Clean up old exposures (older than 90 days)
   */
  async cleanupOldExposures() {
    try {
      const ninetyDaysAgo = now() - (90 * 24 * 3600);

      const result = await this.db.prepare(`
        DELETE FROM post_exposures WHERE exposed_at < ?
      `).bind(ninetyDaysAgo).run();

      // Cleaned up old exposures
      return result.changes;
    } catch (error) {
      console.error('Cleanup exposures error:', error);
      throw error;
    }
  }

  /**
   * Remove posts from trending that dropped below max batch
   */
  async cleanupTrending() {
    try {
      const result = await this.db.prepare(`
        DELETE FROM trending_posts
        WHERE post_id IN (
          SELECT post_id FROM post_suggestion_batches
          WHERE status = 'active' AND batch_size < ?
        )
      `).bind(FEED_BATCH_SIZES[FEED_BATCH_SIZES.length - 1]).run();

      return result.changes;
    } catch (error) {
      console.error('Cleanup trending error:', error);
      throw error;
    }
  }
}
