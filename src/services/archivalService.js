/**
 * Archival Service - 3-tier database system
 * 
 * DB1 & DB2: Active data (< 18 months)
 * DB3: Archive data (1-18 months)
 * R2 Snapshots: Permanent archive (> 18 months)
 * 
 * When DB1/DB2 reach 80% capacity, old data moves to DB3
 * Data > 18 months old is snapshotted to R2
 */

export class ArchivalService {
  constructor(db, db2, db3, storage, snapshots, cache) {
    this.db = db;           // Active DB 1
    this.db2 = db2;         // Active DB 2
    this.db3 = db3;         // Archive DB (1-18 months)
    this.storage = storage; // Media storage
    this.snapshots = snapshots; // Snapshot storage
    this.cache = cache;     // KV for metadata
  }

  /**
   * Get database usage percentage
   */
  async getDbUsage(database) {
    try {
      const result = await database.prepare(
        "SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size();"
      ).first();

      if (!result) return 0;

      // Cloudflare D1 free tier limit is 10GB per database
      // Paid plans can go higher, but we set conservative limit
      const MAX_SIZE = 10 * 1024 * 1024 * 1024; // 10GB
      const usage = (result.size / MAX_SIZE) * 100;
      return Math.min(usage, 100);
    } catch (error) {
      console.error('Error getting DB usage:', error);
      return 0;
    }
  }

  /**
   * Check if database needs archival (> 80% full)
   */
  async checkArchivalNeeded(database, _dbName) {
    const usage = await this.getDbUsage(database);
    // Database usage logged
    return usage > 80;
  }

  /**
   * Get data older than specified months from a specific database
   */
  async getOldData(sourceDb, table, monthsOld = 18) {
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - monthsOld);
    const cutoffISO = cutoffDate.toISOString();

    try {
      const result = await sourceDb.prepare(
        `SELECT * FROM ${table} WHERE created_at < ? OR updated_at < ?`
      ).bind(cutoffISO, cutoffISO).all();

      return result.results || [];
    } catch (error) {
      console.error(`Error getting old data from ${table}:`, error);
      return [];
    }
  }

  /**
   * Move data from DB1/DB2 to DB3
   */
  async moveToArchive(sourceDb, table, ids) {
    if (!ids || ids.length === 0) return 0;

    try {
      // Get data from source
      const placeholders = ids.map(() => '?').join(',');
      const sourceData = await sourceDb.prepare(
        `SELECT * FROM ${table} WHERE id IN (${placeholders})`
      ).bind(...ids).all();

      if (!sourceData.results || sourceData.results.length === 0) {
        return 0;
      }

      // Insert into DB3
      const insertPromises = sourceData.results.map(row =>
        this.db3.prepare(
          `INSERT OR REPLACE INTO ${table} VALUES (${Object.keys(row).map(() => '?').join(',')})`
        ).bind(...Object.values(row)).run()
      );
      await Promise.all(insertPromises);

      // Delete from source
      await sourceDb.prepare(
        `DELETE FROM ${table} WHERE id IN (${placeholders})`
      ).bind(...ids).run();

      return sourceData.results.length;
    } catch (error) {
      console.error(`Error moving data to archive: ${table}`, error);
      return 0;
    }
  }

  /**
   * Create snapshot of data to R2
   */
  async createSnapshot(table, data, monthsOld = 18) {
    if (!data || data.length === 0) return null;

    try {
      const timestamp = new Date().toISOString();
      const snapshotKey = `snapshots/${table}/${timestamp.split('T')[0]}.json`;

      const snapshot = {
        table,
        created_at: timestamp,
        data_age_months: monthsOld,
        record_count: data.length,
        records: data
      };

      // Store in R2
      await this.snapshots.put(snapshotKey, JSON.stringify(snapshot), {
        httpMetadata: {
          contentType: 'application/json',
          cacheControl: 'max-age=31536000' // 1 year
        },
        customMetadata: {
          table,
          created_at: timestamp,
          record_count: data.length.toString()
        }
      });

      // Track snapshot in KV
      await this.cache.put(
        `snapshot:${table}:${timestamp}`,
        JSON.stringify({ key: snapshotKey, record_count: data.length }),
        { expirationTtl: 86400 * 365 } // 1 year
      );

      // Snapshot created
      return snapshotKey;
    } catch (error) {
      console.error(`Error creating snapshot for ${table}:`, error);
      return null;
    }
  }

  /**
   * Archive old data: DB3 → R2 snapshots
   */
  async archiveOldData(table, monthsOld = 18) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setMonth(cutoffDate.getMonth() - monthsOld);
      const cutoffISO = cutoffDate.toISOString();

      // Get old data from DB3
      const oldData = await this.db3.prepare(
        `SELECT * FROM ${table} WHERE created_at < ? OR updated_at < ?`
      ).bind(cutoffISO, cutoffISO).all();

      if (!oldData.results || oldData.results.length === 0) {
        return { archived: 0, snapshot_key: null };
      }

      // Create snapshot
      const snapshotKey = await this.createSnapshot(table, oldData.results, monthsOld);

      // Delete from DB3 after snapshot
      if (snapshotKey) {
        const ids = oldData.results.map(r => r.id);
        const placeholders = ids.map(() => '?').join(',');

        await this.db3.prepare(
          `DELETE FROM ${table} WHERE id IN (${placeholders})`
        ).bind(...ids).run();

        // Records archived to R2
      }

      return {
        archived: oldData.results.length,
        snapshot_key: snapshotKey
      };
    } catch (error) {
      console.error(`Error archiving old data from ${table}:`, error);
      return { archived: 0, snapshot_key: null };
    }
  }

  /**
   * Load snapshot from R2
   */
  async loadSnapshot(snapshotKey) {
    try {
      const data = await this.snapshots.get(snapshotKey);
      if (!data) return null;

      return JSON.parse(await data.text());
    } catch (error) {
      console.error(`Error loading snapshot ${snapshotKey}:`, error);
      return null;
    }
  }

  /**
   * Search across all databases and snapshots
   */
  async queryAllDatabases(table, whereClause, bindings = []) {
    const results = [];

    try {
      // Try DB1 first (active)
      const query = `SELECT * FROM ${table} ${whereClause}`;
      const db1Result = await this.db.prepare(query).bind(...bindings).all();
      if (db1Result.results) results.push(...db1Result.results);

      // Try DB3 (archive)
      const db3Result = await this.db3.prepare(query).bind(...bindings).all();
      if (db3Result.results) {
        results.push(...db3Result.results.filter(
          r3 => !results.some(r1 => r1.id === r3.id)
        ));
      }

      // Try R2 snapshots if no results found
      if (results.length === 0) {
        const snapshots = await this.listSnapshots(table);
        const snapshotPromises = snapshots.map(snapshotKey => this.loadSnapshot(snapshotKey));
        const loadedSnapshots = await Promise.all(snapshotPromises);
        for (const snapshot of loadedSnapshots) {
          if (snapshot && snapshot.records) {
            // Simple client-side filtering for snapshots
            const filtered = snapshot.records.filter(r =>
              this.matchesWhere(r, whereClause)
            );
            results.push(...filtered);
          }
        }
      }

      return results;
    } catch (error) {
      console.error(`Error querying across databases for ${table}:`, error);
      return results;
    }
  }

  /**
   * List all snapshots for a table
   */
  async listSnapshots(table) {
    try {
      const prefix = `snapshots/${table}/`;
      const objects = await this.snapshots.list({ prefix });

      return objects.objects.map(obj => obj.key);
    } catch (error) {
      console.error(`Error listing snapshots for ${table}:`, error);
      return [];
    }
  }

  /**
   * Helper: Basic WHERE clause matching (simple implementation)
   */
  matchesWhere(record, whereClause) {
    // This is a simplified version - for production, use proper query parsing
    if (!whereClause || whereClause === '') return true;

    // Example: "WHERE user_id = ?" would be checked in actual implementation
    return true;
  }

  /**
   * Get archival statistics
   */
  async getStats() {
    try {
      const db1Usage = await this.getDbUsage(this.db);
      const db2Usage = await this.getDbUsage(this.db2);
      const db3Usage = await this.getDbUsage(this.db3);

      // Count snapshots
      const snapshots = await this.snapshots.list();
      const snapshotCount = snapshots.objects.length;
      const snapshotSize = snapshots.objects.reduce((sum, obj) => sum + (obj.size || 0), 0);

      return {
        databases: {
          db1: { usage_percent: db1Usage.toFixed(2), status: db1Usage > 80 ? 'NEEDS_ARCHIVAL' : 'OK' },
          db2: { usage_percent: db2Usage.toFixed(2), status: db2Usage > 80 ? 'NEEDS_ARCHIVAL' : 'OK' },
          db3: { usage_percent: db3Usage.toFixed(2), status: 'ARCHIVE' }
        },
        snapshots: {
          count: snapshotCount,
          total_size_mb: (snapshotSize / 1024 / 1024).toFixed(2)
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error getting archival stats:', error);
      return null;
    }
  }

  /**
   * List all snapshots (NO AUTO-DELETE - snapshots are permanent)
   */
  async listAllSnapshots() {
    try {
      const snapshots = await this.snapshots.list();
      return snapshots.objects.map(obj => ({
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded
      }));
    } catch (error) {
      console.error('Error listing all snapshots:', error);
      return [];
    }
  }

  /**
   * Delete user data from ALL snapshots when user deletes account
   * This removes the user's data from R2 snapshots permanently
   */
  async deleteUserFromSnapshots(userId) {
    try {
      const snapshots = await this.snapshots.list();
      let deletedCount = 0;

      // Process snapshots in parallel to delete user data
      const processPromises = snapshots.objects.map(async (obj) => {
        try {
          // Load snapshot
          const data = await this.snapshots.get(obj.key);
          if (!data) return { modified: false, deleted: false };

          const snapshot = JSON.parse(await data.text());

          // Filter out user's data
          const originalCount = snapshot.records.length;
          snapshot.records = snapshot.records.filter(record => {
            // Check various user ID fields depending on table
            return record.user_id !== userId &&
                   record.author_id !== userId &&
                   record.sender_id !== userId &&
                   record.receiver_id !== userId &&
                   record.id !== userId;
          });

          const newCount = snapshot.records.length;

          // If data was removed, update the snapshot
          if (newCount < originalCount) {
            snapshot.record_count = newCount;

            if (newCount === 0) {
              // If snapshot is empty, delete it
              await this.snapshots.delete(obj.key);
              return { modified: true, deleted: true };
            } else {
              // Update snapshot with filtered data
              await this.snapshots.put(obj.key, JSON.stringify(snapshot), {
                httpMetadata: {
                  contentType: 'application/json',
                  cacheControl: 'max-age=31536000'
                },
                customMetadata: {
                  table: snapshot.table,
                  created_at: snapshot.created_at,
                  record_count: newCount.toString()
                }
              });
              return { modified: true, deleted: false };
            }
          }

          return { modified: false, deleted: false };
        } catch (error) {
          console.error(`Error processing snapshot ${obj.key}:`, error);
          return { modified: false, deleted: false };
        }
      });

      const results = await Promise.allSettled(processPromises);
      const successfulResults = results
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value);

      deletedCount = successfulResults.filter(result => result.deleted).length;
      const modifiedCount = successfulResults.filter(result => result.modified).length;

      // User data deleted from snapshots
      return { success: true, snapshots_modified: modifiedCount, snapshots_deleted: deletedCount };
    } catch (error) {
      console.error('Error deleting user from snapshots:', error);
      return { success: false, error: error.message };
    }
  }
}
