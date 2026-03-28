// ============================================
// FEED ALGORITHM SERVICE
// Advanced Batch Distribution System
// ============================================

import { 
  generateId, 
  now, 
  hoursFromNow,
  calculateEngagementRate,
  FEED_BATCH_SIZES,
  ENGAGEMENT_THRESHOLD,
  WINDOW_INTEGRITY_HOURS,
  WINDOW_PRIMARY_HOURS,
  WINDOW_STABILITY_HOURS
} from '../utils/helpers.js';

export class FeedAlgorithmService {
  constructor(db, cache) {
    this.db = db;
    this.cache = cache;
  }

  /**
   * Initialize suggestion distribution for a new post
   */
  async initializePostDistribution(postId, actorType, actorId, language) {
    try {
      // Start with smallest batch size
      const [initialBatchSize] = FEED_BATCH_SIZES; // 100
      const timestamp = now();

      // Create initial batch
      const batchId = generateId('batch');
      await this.db.prepare(`
        INSERT INTO post_suggestion_batches (
          id, post_id, batch_size, batch_number, status,
          window_type, window_start, window_end, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        batchId,
        postId,
        initialBatchSize,
        1,
        'active',
        'integrity',
        timestamp,
        hoursFromNow(WINDOW_INTEGRITY_HOURS),
        timestamp
      ).run();

      // Select initial candidates
      await this.selectAndExposeCandidates(postId, batchId, initialBatchSize, language, actorType, actorId);

      // Initialize distribution completed
      
      return { batchId, batchSize: initialBatchSize };
    } catch (error) {
      console.error('Initialize distribution error:', error);
      throw error;
    }
  }

  /**
   * Get cached user pool count by language (avoids expensive COUNT(*) on every post)
   * Cache TTL: 5 minutes - pool size doesn't change rapidly
   */
  async getCachedPoolCount(language) {
    const cacheKey = `feed:pool:${language}`;

    // Try cache first
    if (this.cache) {
      try {
        const cached = await this.cache.get(cacheKey);
        if (cached) {
          return parseInt(cached, 10);
        }
      } catch {
        // Ignore cache errors
      }
    }

    // Cache miss - query DB
    const countResult = await this.db.prepare(`
      SELECT COUNT(*) as cnt FROM users u
      JOIN user_settings us ON u.id = us.user_id
      WHERE us.preferred_language = ?
    `).bind(language).first();

    const count = countResult?.cnt || 1000;

    // Cache the result
    if (this.cache) {
      try {
        await this.cache.put(cacheKey, String(count), { expirationTtl: 300 }); // 5 min
      } catch {
        // Ignore cache errors
      }
    }

    return count;
  }

  /**
   * Select candidate users for suggestion
   * Uses efficient sampling instead of ORDER BY RANDOM() for better scaling
   */
  async selectAndExposeCandidates(postId, batchId, batchSize, language, actorType, actorId) {
    try {
      // Get users who:
      // 1. Match language preference
      // 2. Are not followers
      // 3. Haven't been exposed to this post before
      // 4. Are not blocked
      //
      // Uses modulo-based sampling for better performance at scale
      // Instead of ORDER BY RANDOM() which scans full table,
      // we use ABS(RANDOM()) % estimated_pool_size to create pseudo-random buckets

      // Get approximate count for sampling (cached for performance)
      const estimatedPool = await this.getCachedPoolCount(language);
      // Calculate sampling factor: if we need 100 users from 10000, sample every ~100th
      const sampleMod = Math.max(1, Math.floor(estimatedPool / (batchSize * 3)));

      const candidates = await this.db.prepare(`
        SELECT DISTINCT u.id
        FROM users u
        JOIN user_settings us ON u.id = us.user_id
        WHERE us.preferred_language = ?
          AND u.id NOT IN (
            -- Exclude followers
            SELECT follower_id FROM follows
            WHERE followee_type = ? AND followee_id = ?
          )
          AND u.id NOT IN (
            -- Exclude already exposed
            SELECT user_id FROM post_exposures WHERE post_id = ?
          )
          AND u.id NOT IN (
            -- Exclude blocked users
            SELECT blocked_id FROM blocks
            WHERE blocker_type = ? AND blocker_id = ?
            UNION
            SELECT blocker_id FROM blocks
            WHERE blocked_type = ? AND blocked_id = ?
          )
          AND (ABS(RANDOM()) % ? < ?)
        LIMIT ?
      `).bind(
        language,
        actorType, actorId,
        postId,
        actorType, actorId,
        actorType, actorId,
        sampleMod,
        Math.max(1, Math.ceil(sampleMod / 3)),
        batchSize * 2
      ).all();

      // Shuffle results in memory and take batchSize (faster than DB shuffle)
      let users = candidates.results || [];
      for (let i = users.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [users[i], users[j]] = [users[j], users[i]];
      }
      users = users.slice(0, batchSize);

      const exposedAt = now();

      // Record exposures
      const exposurePromises = users.map(user =>
        this.db.prepare(`
          INSERT INTO post_exposures (id, post_id, user_id, batch_id, exposed_at, engaged)
          VALUES (?, ?, ?, ?, ?, 0)
        `).bind(
          generateId('exp'),
          postId,
          user.id,
          batchId,
          exposedAt
        ).run()
      );
      await Promise.all(exposurePromises);

      // Update batch impressions
      await this.db.prepare(`
        UPDATE post_suggestion_batches
        SET impressions = ?
        WHERE id = ?
      `).bind(users.length, batchId).run();

      // Exposed post to users
      
      return users.length;
    } catch (error) {
      console.error('Select candidates error:', error);
      throw error;
    }
  }

  /**
   * Process expired batches and make promotion/demotion decisions
   */
  async processExpiredBatches() {
    try {
      const currentTime = now();

      // Get all active batches that have expired
      const expiredBatches = await this.db.prepare(`
        SELECT * FROM post_suggestion_batches
        WHERE status = 'active' AND window_end <= ?
        ORDER BY created_at ASC
      `).bind(currentTime).all();

      const batches = expiredBatches.results || [];

      const evaluationPromises = batches.map(batch => this.evaluateBatch(batch));
      await Promise.all(evaluationPromises);

      // Processed expired batches
      
      return batches.length;
    } catch (error) {
      console.error('Process expired batches error:', error);
      throw error;
    }
  }

  /**
   * Evaluate a batch and make promotion/demotion decision
   */
  async evaluateBatch(batch) {
    try {
      // Get engagement for this batch
      const engagement = await this.db.prepare(`
        SELECT COUNT(*) as count
        FROM post_exposures
        WHERE batch_id = ? AND engaged = 1
      `).bind(batch.id).first();

      const { count: engagements } = engagement;
      const { impressions } = batch;
      const engagementRate = calculateEngagementRate(impressions, engagements);

      // Update batch stats
      await this.db.prepare(`
        UPDATE post_suggestion_batches
        SET engagement_rate = ?, engagements = ?
        WHERE id = ?
      `).bind(engagementRate, engagements, batch.id).run();

      // Batch evaluation completed

      // Decision based on window type
      if (batch.window_type === 'integrity') {
        // Integrity window: Check for spam/bot activity
        if (engagementRate > 90) {
          // Suspiciously high - possible bot activity
        // Suspicious activity detected
          await this.terminateDistribution(batch.post_id, 'suspicious_activity');
          return;
        }
        
        // Move to primary window
        await this.transitionToPrimaryWindow(batch);
        
      } else if (batch.window_type === 'primary') {
        // Primary window: Main promotion decision
        await this.makePrimaryDecision(batch, engagementRate);
        
      } else if (batch.window_type === 'stability') {
        // Stability window: Sustained engagement check
        await this.makeStabilityDecision(batch, engagementRate);
      }
    } catch (error) {
      console.error('Evaluate batch error:', error);
      throw error;
    }
  }

  /**
   * Transition from integrity to primary window
   */
  async transitionToPrimaryWindow(batch) {
    try {
      const timestamp = now();

      // Mark current batch as completed
      await this.db.prepare(`
        UPDATE post_suggestion_batches
        SET status = 'completed'
        WHERE id = ?
      `).bind(batch.id).run();

      // Create primary window batch (same size)
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
        batch.batch_number,
        'active',
        'primary',
        timestamp,
        hoursFromNow(WINDOW_PRIMARY_HOURS),
        timestamp
      ).run();

      // Get post details for candidate selection
      const post = await this.db.prepare(`
        SELECT actor_type, actor_id, language FROM posts WHERE id = ?
      `).bind(batch.post_id).first();

      // Expose to new candidates
      await this.selectAndExposeCandidates(
        batch.post_id,
        newBatchId,
        batch.batch_size,
        post.language,
        post.actor_type,
        post.actor_id
      );

      // Post moved to PRIMARY window
    } catch (error) {
      console.error('Transition to primary error:', error);
      throw error;
    }
  }

  /**
   * Make promotion/demotion decision based on primary window performance
   */
  async makePrimaryDecision(batch, engagementRate) {
    try {
      if (engagementRate >= ENGAGEMENT_THRESHOLD) {
        // PROMOTE: Move to next higher batch
        await this.promoteBatch(batch);
      } else {
        // DEMOTE: Move to lower batch or terminate
        await this.demoteBatch(batch);
      }
    } catch (error) {
      console.error('Primary decision error:', error);
      throw error;
    }
  }

  /**
   * Promote batch to next higher size
   */
  async promoteBatch(batch) {
    try {
      const currentIndex = FEED_BATCH_SIZES.indexOf(batch.batch_size);
      
      if (currentIndex === FEED_BATCH_SIZES.length - 1) {
        // Already at max batch size, move to stability window
        await this.transitionToStabilityWindow(batch);
      } else {
        // Promote to next batch size
        const newBatchSize = FEED_BATCH_SIZES[currentIndex + 1];
        await this.createNextBatch(batch, newBatchSize, 'primary');
        
        // Post promoted
      }
    } catch (error) {
      console.error('Promote batch error:', error);
      throw error;
    }
  }

  /**
   * Demote batch to previous size or terminate
   */
  async demoteBatch(batch) {
    try {
      const currentIndex = FEED_BATCH_SIZES.indexOf(batch.batch_size);
      
      if (currentIndex === 0) {
        // Already at minimum batch size - TERMINATE
        // Post terminated
        await this.terminateDistribution(batch.post_id, 'low_engagement');
      } else {
        // Demote to previous batch size
        const newBatchSize = FEED_BATCH_SIZES[currentIndex - 1];
        await this.createNextBatch(batch, newBatchSize, 'primary');
        
        // Post demoted
      }
    } catch (error) {
      console.error('Demote batch error:', error);
      throw error;
    }
  }

  /**
   * Transition to stability window (for sustained engagement check)
   */
  async transitionToStabilityWindow(batch) {
    try {
      const timestamp = now();

      // Mark current batch as completed
      await this.db.prepare(`
        UPDATE post_suggestion_batches
        SET status = 'completed'
        WHERE id = ?
      `).bind(batch.id).run();

      // Create stability window batch
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
        hoursFromNow(WINDOW_STABILITY_HOURS),
        timestamp
      ).run();

      // Get post details
      const post = await this.db.prepare(`
        SELECT actor_type, actor_id, language FROM posts WHERE id = ?
      `).bind(batch.post_id).first();

      // Expose to new candidates
      await this.selectAndExposeCandidates(
        batch.post_id,
        newBatchId,
        batch.batch_size,
        post.language,
        post.actor_type,
        post.actor_id
      );

      // Post moved to STABILITY window
    } catch (error) {
      console.error('Transition to stability error:', error);
      throw error;
    }
  }

  /**
   * Make decision during stability window
   */
  async makeStabilityDecision(batch, engagementRate) {
    try {
      if (engagementRate >= ENGAGEMENT_THRESHOLD) {
        // Continue at current batch size
        await this.continueBatch(batch);
        
        // Check if qualifies for trending
        if (batch.batch_size === FEED_BATCH_SIZES[FEED_BATCH_SIZES.length - 1]) {
          await this.markAsTrending(batch.post_id);
        }
      } else {
        // Start decay process
        await this.startDecayProcess(batch);
      }
    } catch (error) {
      console.error('Stability decision error:', error);
      throw error;
    }
  }

  /**
   * Continue batch at same size (successful stability)
   */
  async continueBatch(batch) {
    try {
      await this.createNextBatch(batch, batch.batch_size, 'stability');
      // Continue at current batch size
    } catch (error) {
      console.error('Continue batch error:', error);
      throw error;
    }
  }

  /**
   * Create next batch
   */
  async createNextBatch(previousBatch, newBatchSize, windowType) {
    try {
      const timestamp = now();
      
      // Mark previous batch as completed
      await this.db.prepare(`
        UPDATE post_suggestion_batches
        SET status = 'completed'
        WHERE id = ?
      `).bind(previousBatch.id).run();

      // Determine window duration
      let windowDuration;
      if (windowType === 'integrity') {
        windowDuration = WINDOW_INTEGRITY_HOURS;
      } else if (windowType === 'primary') {
        windowDuration = WINDOW_PRIMARY_HOURS;
      } else {
        windowDuration = WINDOW_STABILITY_HOURS;
      }

      // Create new batch
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
        windowType,
        timestamp,
        hoursFromNow(windowDuration),
        timestamp
      ).run();

      // Get post details
      const post = await this.db.prepare(`
        SELECT actor_type, actor_id, language FROM posts WHERE id = ?
      `).bind(previousBatch.post_id).first();

      // Expose to candidates
      await this.selectAndExposeCandidates(
        previousBatch.post_id,
        newBatchId,
        newBatchSize,
        post.language,
        post.actor_type,
        post.actor_id
      );
    } catch (error) {
      console.error('Create next batch error:', error);
      throw error;
    }
  }

  /**
   * Terminate distribution
   */
  async terminateDistribution(postId, _reason) {
    try {
      // Mark all active batches as terminated
      await this.db.prepare(`
        UPDATE post_suggestion_batches
        SET status = 'terminated'
        WHERE post_id = ? AND status = 'active'
      `).bind(postId).run();

    } catch (error) {
      console.error('Terminate distribution error:', error);
      throw error;
    }
  }

  /**
   * Mark post as trending
   */
  async markAsTrending(postId) {
    try {
      const post = await this.db.prepare(`
        SELECT language FROM posts WHERE id = ?
      `).bind(postId).first();

      // Calculate trending score
      const score = await this.calculateTrendingScore(postId);

      // Check if already trending
      const existing = await this.db.prepare(`
        SELECT * FROM trending_posts WHERE post_id = ? AND language = ?
      `).bind(postId, post.language).first();

      const timestamp = now();

      if (existing) {
        // Update score
        await this.db.prepare(`
          UPDATE trending_posts
          SET score = ?, last_calculated_at = ?
          WHERE id = ?
        `).bind(score, timestamp, existing.id).run();
      } else {
        // Insert new trending post
        await this.db.prepare(`
          INSERT INTO trending_posts (id, post_id, language, score, started_trending_at, last_calculated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          generateId('trend'),
          postId,
          post.language,
          score,
          timestamp,
          timestamp
        ).run();
      }

    } catch (error) {
      console.error('Mark as trending error:', error);
      throw error;
    }
  }

  /**
   * Calculate trending score
   */
  async calculateTrendingScore(postId) {
    try {
      const post = await this.db.prepare(`
        SELECT likes_count, comments_count, shares_count, created_at
        FROM posts WHERE id = ?
      `).bind(postId).first();

      const age = now() - post.created_at;
      const ageHours = age / 3600;

      // Weighted engagement
      const engagement = 
        (Number(post.likes_count) * 1) +
        (Number(post.comments_count) * 2) +
        (Number(post.shares_count) * 3);

      // Time decay factor (newer posts score higher)
      const timeFactor = Math.max(0, 1 - (ageHours / 72)); // Decay over 72 hours

      const score = engagement * timeFactor;

      return score;
    } catch (error) {
      console.error('Calculate trending score error:', error);
      return 0;
    }
  }
}
