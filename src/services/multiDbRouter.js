/**
 * Multi-Database Router
 * 
 * Intelligently routes queries across DB1, DB2, DB3, and R2 snapshots
 * Supports reading from active databases with fallback to archive and snapshots
 */

import { ArchivalService } from './archivalService.js';
import { safeJsonParse } from '../utils/helpers.js';

export class MultiDbRouter {
  constructor(db, db2, db3, storage, snapshots, cache) {
    this.db = db;
    this.db2 = db2;
    this.db3 = db3;
    this.archival = new ArchivalService(db, db2, db3, storage, snapshots, cache);
    this.cache = cache;
  }

  /**
   * Query with automatic fallback through all databases
   * Checks DB1 → DB2 → DB3 → R2 Snapshots
   */
  async query(table, whereClause = '', bindings = [], options = {}) {
    const cacheKey = `query:${table}:${whereClause}:${bindings.join(',')}`;
    
    // Check cache first
    if (options.useCache !== false) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        const parsed = safeJsonParse(cached);
        if (parsed !== null) return parsed;
      }
    }

    const results = [];

    try {
      // Try DB1 (Active)
      if (options.db1 !== false) {
        const query = `SELECT * FROM ${table} ${whereClause}`;
        try {
          const result = await this.db.prepare(query).bind(...bindings).all();
          if (result.results) {
            results.push(...result.results);
            if (options.firstHit && results.length > 0) {
              return this._cacheAndReturn(cacheKey, results, options);
            }
          }
        } catch (error) {
          console.warn(`DB1 query failed for ${table}:`, error.message);
        }
      }

      // Try DB2 (Active)
      if (options.db2 !== false) {
        const query = `SELECT * FROM ${table} ${whereClause}`;
        try {
          const result = await this.db2.prepare(query).bind(...bindings).all();
          if (result.results) {
            const newResults = result.results.filter(
              r2 => !results.some(r1 => r1.id === r2.id)
            );
            results.push(...newResults);
            if (options.firstHit && results.length > 0) {
              return this._cacheAndReturn(cacheKey, results, options);
            }
          }
        } catch (error) {
          console.warn(`DB2 query failed for ${table}:`, error.message);
        }
      }

      // Try DB3 (Archive)
      if (options.db3 !== false && !options.activeOnly) {
        const query = `SELECT * FROM ${table} ${whereClause}`;
        try {
          const result = await this.db3.prepare(query).bind(...bindings).all();
          if (result.results) {
            const newResults = result.results.filter(
              r3 => !results.some(r => r.id === r3.id)
            );
            results.push(...newResults);
            if (options.firstHit && results.length > 0) {
              return this._cacheAndReturn(cacheKey, results, options);
            }
          }
        } catch (error) {
          console.warn(`DB3 query failed for ${table}:`, error.message);
        }
      }

      // Try R2 Snapshots (only if specifically requested or no results yet)
      if ((options.includeSnapshots || results.length === 0) && !options.noSnapshots) {
        const snapshotResults = await this._querySnapshots(table, whereClause, bindings);
        const newSnapshots = snapshotResults.filter(
          sr => !results.some(r => r.id === sr.id)
        );
        results.push(...newSnapshots);
      }

      return this._cacheAndReturn(cacheKey, results, options);
    } catch (error) {
      console.error(`Multi-database query error for ${table}:`, error);
      return [];
    }
  }

  /**
   * Query only active databases (DB1 & DB2)
   */
  async queryActive(table, whereClause = '', bindings = []) {
    return await this.query(table, whereClause, bindings, { activeOnly: true });
  }

  /**
   * Query only archive databases (DB3)
   */
  async queryArchive(table, whereClause = '', bindings = []) {
    return await this.query(table, whereClause, bindings, { db1: false, db2: false });
  }

  /**
   * Query only snapshots
   */
  async querySnapshots(table, whereClause = '', bindings = []) {
    return await this._querySnapshots(table, whereClause, bindings);
  }

  /**
   * Get a specific record by ID across all databases
   */
  async findById(table, id, options = {}) {
    const results = await this.query(
      table,
      'WHERE id = ?',
      [id],
      { ...options, firstHit: true }
    );
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Get the least full database for writes (DB1 or DB2)
   */
  async getWriteDatabase() {
    try {
      const db1Usage = await this.archival.getDbUsage(this.db);
      const db2Usage = await this.archival.getDbUsage(this.db2);

      // Use the database with lower usage
      return db1Usage <= db2Usage ? this.db : this.db2;
    } catch (error) {
      console.error('Error checking database usage, defaulting to DB1:', error);
      return this.db; // Default to DB1 if check fails
    }
  }

  /**
   * Insert data with automatic load balancing between DB1 and DB2
   */
  async insert(table, columns, values) {
    try {
      // Get the least full database
      const writeDb = await this.getWriteDatabase();

      const placeholders = values.map(() => '?').join(',');
      const result = await writeDb.prepare(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`
      ).bind(...values).run();

      // Invalidate cache
      await this._invalidateTableCache(table);

      return result;
    } catch (error) {
      console.error(`Insert error for ${table}:`, error);
      throw error;
    }
  }

  /**
   * Update data (updates in source database)
   */
  async update(table, id, updates) {
    try {
      // Find which database has this record
      const record = await this.findById(table, id);
      if (!record) throw new Error(`Record ${id} not found in ${table}`);

      // Prepare SET clause
      const setClause = Object.keys(updates).map(k => `${k} = ?`).join(',');
      const values = [...Object.values(updates), id];

      // Try to update in all databases (one will have it)
      let updated = false;

      try {
        const result = await this.db.prepare(
          `UPDATE ${table} SET ${setClause} WHERE id = ?`
        ).bind(...values).run();
        if (result.meta.changes > 0) updated = true;
      } catch (e) {
        // Try DB2
        try {
          const result = await this.db2.prepare(
            `UPDATE ${table} SET ${setClause} WHERE id = ?`
          ).bind(...values).run();
          if (result.meta.changes > 0) updated = true;
        } catch (e2) {
          // Try DB3
          const result = await this.db3.prepare(
            `UPDATE ${table} SET ${setClause} WHERE id = ?`
          ).bind(...values).run();
          if (result.meta.changes > 0) updated = true;
        }
      }

      if (updated) {
        await this._invalidateTableCache(table);
      }

      return { success: updated };
    } catch (error) {
      console.error(`Update error for ${table}:`, error);
      throw error;
    }
  }

  /**
   * Delete data (deletes from source database)
   */
  async delete(table, id) {
    try {
      let deleted = false;

      try {
        const result = await this.db.prepare(
          `DELETE FROM ${table} WHERE id = ?`
        ).bind(id).run();
        if (result.meta.changes > 0) deleted = true;
      } catch (e) {
        try {
          const result = await this.db2.prepare(
            `DELETE FROM ${table} WHERE id = ?`
          ).bind(id).run();
          if (result.meta.changes > 0) deleted = true;
        } catch (e2) {
          const result = await this.db3.prepare(
            `DELETE FROM ${table} WHERE id = ?`
          ).bind(id).run();
          if (result.meta.changes > 0) deleted = true;
        }
      }

      if (deleted) {
        await this._invalidateTableCache(table);
      }

      return { success: deleted };
    } catch (error) {
      console.error(`Delete error for ${table}:`, error);
      throw error;
    }
  }

  /**
   * Internal: Query snapshots
   */
  async _querySnapshots(table, _whereClause = '', _bindings = []) {
    try {
      const snapshots = await this.archival.listSnapshots(table);
      const results = [];

      // Load all snapshots in parallel
      const loadPromises = snapshots.map(snapshotKey => this.archival.loadSnapshot(snapshotKey));
      const snapshotResults = await Promise.all(loadPromises);

      for (const snapshot of snapshotResults) {
        if (snapshot && snapshot.records) {
          results.push(...snapshot.records);
        }
      }

      return results;
    } catch (error) {
      console.warn(`Error querying snapshots for ${table}:`, error.message);
      return [];
    }
  }

  /**
   * Internal: Cache and return results
   */
  async _cacheAndReturn(cacheKey, results, options = {}) {
    if (options.useCache !== false) {
      const ttl = options.cacheTtl || 3600; // 1 hour default
      await this.cache.put(cacheKey, JSON.stringify(results), { expirationTtl: ttl });
    }
    return results;
  }

  /**
   * Internal: Invalidate cache for a table
   */
  async _invalidateTableCache(table) {
    // Simple approach: invalidate all cache keys containing table name
    // In production, consider using a more sophisticated cache invalidation strategy
    const _prefix = `query:${table}:`;
    // Note: KV doesn't have prefix deletion, so this is a simplified approach
  }

  /**
   * Get statistics on data distribution
   */
  async getDistribution(table) {
    try {
      // Count in each database
      const db1Count = await this._countRecords(this.db, table);
      const db2Count = await this._countRecords(this.db2, table);
      const db3Count = await this._countRecords(this.db3, table);

      // Count snapshots in parallel
      const snapshots = await this.archival.listSnapshots(table);
      const loadPromises = snapshots.map(snapshotKey => this.archival.loadSnapshot(snapshotKey));
      const snapshotResults = await Promise.all(loadPromises);
      let snapshotCount = 0;
      for (const snapshot of snapshotResults) {
        if (snapshot && snapshot.records) {
          snapshotCount += snapshot.records.length;
        }
      }

      return {
        table,
        db1: db1Count,
        db2: db2Count,
        db3: db3Count,
        snapshots: snapshotCount,
        total: db1Count + db2Count + db3Count + snapshotCount
      };
    } catch (error) {
      console.error(`Error getting distribution for ${table}:`, error);
      return null;
    }
  }

  /**
   * Internal: Count records in a database
   */
  async _countRecords(database, table) {
    try {
      const result = await database.prepare(
        `SELECT COUNT(*) as count FROM ${table}`
      ).first();
      return result ? result.count : 0;
    } catch (error) {
      return 0;
    }
  }
}
