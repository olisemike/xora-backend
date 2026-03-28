// ============================================
// SCHEDULED JOBS CONTROLLER
// Run these periodically via Cron Triggers
// ============================================

import { BatchScheduler } from '../services/feedAlgorithmDecay.js';
import { DbRouter } from '../services/dbRouter.js';
import { successResponse, errorResponse, now, generateId } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

export class ScheduledJobsController {
  constructor(env) {
    this.env = env;
    this.dbRouter = DbRouter.fromEnv(env);
    const primaryDb = this.dbRouter.getPrimaryDb();
    this.scheduler = new BatchScheduler(primaryDb, env.CACHE);
  }

  /**
   * Process expired batches
   * Run every 5-10 minutes
   */
  async processExpiredBatches(_request) {
    try {
      const count = await this.scheduler.processExpiredBatches();
      
      return successResponse({
        processed: count,
        timestamp: Date.now()
      }, `Processed ${count} expired batches`);
    } catch (error) {
      console.error('Process expired batches job error:', error);
      return errorResponse('Batch processing failed', 500);
    }
  }

/**
 * Cleanup old exposures and other aged data
 * Run daily
 */
async cleanupOldData(_request) {
  try {
    const exposuresDeleted = await this.scheduler.cleanupOldExposures();
    const trendingUpdated = await this.scheduler.cleanupTrending();
    
    // Clean up expired stories
    const primaryDb = this.dbRouter.getPrimaryDb();
    const expiredStories = await primaryDb.prepare(`
      DELETE FROM stories WHERE expires_at < ?
    `).bind(now()).run();

    // Clean up old login history (older than 90 days)
    const cutoff = now() - (90 * 24 * 60 * 60);
    const oldLogins = await primaryDb.prepare(`
      DELETE FROM login_history WHERE logged_in_at < ?
    `).bind(cutoff).run();

    // Clean up expired refresh tokens
    const expiredTokens = await primaryDb.prepare(`
      DELETE FROM refresh_tokens WHERE expires_at < ?
    `).bind(now()).run();

    // Clean up expired device verification codes (older than 24 hours)
    const deviceVerifCutoff = now() - (24 * 60 * 60);
    const oldDeviceVerifications = await primaryDb.prepare(`
      DELETE FROM device_verifications WHERE created_at < ?
    `).bind(deviceVerifCutoff).run();

    // Clean up expired password reset tokens (older than 24 hours)
    const passwordResetCutoff = now() - (24 * 60 * 60);
    const oldPasswordResets = await primaryDb.prepare(`
      DELETE FROM password_reset_tokens WHERE created_at < ?
    `).bind(passwordResetCutoff).run();

    // Check database capacity and notify super admins if needed
    const capacity = await this.checkDatabaseCapacity();

    logger.info('Cleanup complete', {
      expiredStories: expiredStories.changes,
      oldLogins: oldLogins.changes,
      expiredTokens: expiredTokens.changes,
      oldDeviceVerifications: oldDeviceVerifications.changes,
      oldPasswordResets: oldPasswordResets.changes
    });

    return successResponse({
      exposuresDeleted,
      trendingUpdated,
      expiredStoriesDeleted: expiredStories.changes,
      oldLoginHistoryDeleted: oldLogins.changes,
      expiredRefreshTokensDeleted: expiredTokens.changes,
      oldDeviceVerificationsDeleted: oldDeviceVerifications.changes,
      oldPasswordResetsDeleted: oldPasswordResets.changes,
      loginHistoryCutoff: cutoff,
      capacity,
      timestamp: Date.now()
    }, `Cleanup complete`);
  } catch (error) {
    console.error('Cleanup job error:', error);
    return errorResponse('Cleanup failed', 500);
  }
}

  /**
   * Check current database size vs ~10GB D1 limit and notify super admins
   * when thresholds are crossed. Intended to be called from scheduled jobs.
   */
  async checkDatabaseCapacity() {
    try {
      const db = this.dbRouter.getPrimaryDb();

      // PRAGMA calls return single-row objects with page_count / page_size
      const pageCountRow = await db.prepare('PRAGMA page_count').first();
      const pageSizeRow = await db.prepare('PRAGMA page_size').first();

      const pageCount = pageCountRow?.page_count ?? pageCountRow?.PAGE_COUNT ?? 0;
      const pageSize = pageSizeRow?.page_size ?? pageSizeRow?.PAGE_SIZE ?? 0;
      const bytesUsed = pageCount * pageSize;

      const maxBytes = 10 * 1024 * 1024 * 1024; // 10 GB
      const usedPercent = maxBytes > 0
        ? Math.round((bytesUsed / maxBytes) * 100)
        : 0;

      let level = 'normal';
      if (usedPercent >= 95) level = 'critical';
      else if (usedPercent >= 85) level = 'high';
      else if (usedPercent >= 70) level = 'warning';

      const stateKey = 'db_capacity_alert_level';
      const lastLevel = await this.env.CACHE.get(stateKey);

      if (lastLevel !== level) {
        // Persist new level so we only notify on changes, not every run
        await this.env.CACHE.put(stateKey, level, { expirationTtl: 7 * 24 * 3600 });

        if (level !== 'normal') {
          await this.notifySuperAdminsCapacity(level, usedPercent, bytesUsed);
        }
      }

      return { level, usedPercent, bytesUsed };
    } catch (error) {
      console.error('checkDatabaseCapacity error:', error);
      return { level: 'unknown', usedPercent: null, bytesUsed: null };
    }
  }

  /**
   * Create in-app notifications for all super admins when DB capacity is high.
   */
  async notifySuperAdminsCapacity(level, usedPercent, bytesUsed) {
    try {
      const db = this.dbRouter.getPrimaryDb();

      const adminsResult = await db.prepare(`
        SELECT u.id, u.email, u.username
        FROM admin_users au
        JOIN users u ON au.user_id = u.id
        WHERE au.role = 'super_admin'
      `).all();

      const admins = adminsResult.results || [];
      if (admins.length === 0) {
        console.warn('No super_admin users found for DB capacity notification');
        return;
      }

      const mbUsed = Math.round(bytesUsed / (1024 * 1024));
      const message = `Primary database is at ${usedPercent}% of the ~10GB D1 limit (${mbUsed} MB used). ` +
        'Please provision a new database and plan a migration before capacity is exhausted.';

      const timestamp = now();

      // Send notifications to all admins in parallel
      await Promise.all(admins.map(admin =>
        db.prepare(`
          INSERT INTO notifications (id, user_id, type, content, created_at, read)
          VALUES (?, ?, ?, ?, ?, 0)
        `).bind(
          generateId('notif'),
          admin.id,
          'system:db_capacity',
          message,
          timestamp
        ).run()
      ));

      logger.info('DB capacity alert sent', { level, adminCount: admins.length });
    } catch (error) {
      logger.error('notifySuperAdminsCapacity error', error);
    }
  }

  /**
   * Update trending scores
   * Run every hour
   */
  async updateTrendingScores(_request) {
    try {
      // Get all trending posts
      const primaryDb = this.dbRouter.getPrimaryDb();
      const trending = await primaryDb.prepare(`
        SELECT post_id FROM trending_posts
      `).all();

      const posts = trending.results || [];
      let updated = 0;

      // Update trending scores in parallel
      const updatePromises = posts.map(async (post) => {
        try {
          const { FeedAlgorithmService } = await import('../services/feedAlgorithm.js');
          const primaryDb = this.dbRouter.getPrimaryDb();
          const feedAlgo = new FeedAlgorithmService(primaryDb, this.env.CACHE);
          await feedAlgo.markAsTrending(post.post_id);
          return true;
        } catch (error) {
          console.error(`Failed to update trending score for ${post.post_id}:`, error);
          return false;
        }
      });

      const results = await Promise.allSettled(updatePromises);
      updated = results.filter(result => result.status === 'fulfilled' && result.value).length;

      return successResponse({
        updated,
        total: posts.length,
        timestamp: Date.now()
      }, `Updated ${updated} trending posts`);
    } catch (error) {
      console.error('Update trending job error:', error);
      return errorResponse('Trending update failed', 500);
    }
  }

  /**
   * Export a full logical snapshot of the primary DB to R2
   * Intended to be run as a daily/weekly cron job.
   */
  async exportSnapshot(_request) {
    try {
      const db = this.dbRouter.getPrimaryDb();

      // Introspect all non-internal tables
      const tablesResult = await db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
      `).all();

      const tableNames = (tablesResult.results || [])
        .map(row => row.name)
        .filter(Boolean);

      const snapshot = {
        meta: {
          exportedAt: now(),
          tableCount: tableNames.length
        },
        data: {}
      };

      // Export all tables in parallel for better performance
      const exportPromises = tableNames.map(async (name) => {
        const rowsResult = await db.prepare(`SELECT * FROM "${name}"`).all();
        return { name, rows: rowsResult.results || [] };
      });

      const exportResults = await Promise.all(exportPromises);
      for (const { name, rows } of exportResults) {
        snapshot.data[name] = rows;
      }

      const objectKey = `snapshots/xora-db-snapshot-${now()}.json`;

      // Write to R2 bucket bound as STORAGE (if available)
      if (!this.env.STORAGE) {
        return errorResponse('R2 storage binding STORAGE is not configured', 500);
      }

      await this.env.STORAGE.put(objectKey, JSON.stringify(snapshot), {
        httpMetadata: {
          contentType: 'application/json'
        }
      });

      return successResponse({
        objectKey,
        tableCount: snapshot.meta.tableCount,
        exportedAt: snapshot.meta.exportedAt
      }, 'Snapshot exported to R2');
    } catch (error) {
      console.error('Export snapshot job error:', error);
      return errorResponse('Snapshot export failed', 500);
    }
  }

  /**
   * List available DB snapshots in R2 (STORAGE) under the `snapshots/` prefix.
   */
  async listSnapshots(_request) {
    try {
      if (!this.env.STORAGE) {
        return errorResponse('R2 storage binding STORAGE is not configured', 500);
      }

      const listResult = await this.env.STORAGE.list({ prefix: 'snapshots/' });
      const objects = listResult.objects || [];

      const snapshots = objects.map(obj => ({
        key: obj.key,
        size: obj.size,
        uploadedAt: obj.uploaded,
      }));

      return successResponse({ snapshots });
    } catch (error) {
      console.error('List snapshots job error:', error);
      return errorResponse('Failed to list snapshots', 500);
    }
  }
}
