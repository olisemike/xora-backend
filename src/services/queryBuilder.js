/**
 * Batch Query Helper for D1
 * Combines multiple similar queries into fewer database calls
 * Cloudflare D1 doesn't have native batch API, so we batch at application level
 */

export class BatchQueryBuilder {
  constructor(db) {
    this.db = db;
    this.queue = [];
    this.flushTimeout = null;
    this.flushInterval = 50; // ms - batch window
    this.maxBatchSize = 100;
  }

  /**
   * Execute multiple read queries in a batch
   * Combines IN queries where possible
   */
  async batchRead(queries) {
    // Group queries by type
    const grouped = this._groupQueries(queries);
    const results = [];

    // Execute grouped queries
    for (const [type, items] of Object.entries(grouped)) {
      if (type === 'userIds') {
        // Combine: SELECT * FROM users WHERE id IN (?)
        const ids = items.map(q => q.ids).flat();
        const uniqueIds = [...new Set(ids)];
        
        if (uniqueIds.length > 0) {
          const placeholders = uniqueIds.map(() => '?').join(',');
          const stmt = this.db.prepare(
            `SELECT * FROM users WHERE id IN (${placeholders})`
          );
          const rows = await stmt.bind(...uniqueIds).all();
          const rowsArray = rows?.results || [];
          
          // Map results back to individual queries
          for (const query of items) {
            const filtered = rowsArray.filter(r => query.ids.includes(r.id));
            results.push({
              key: query.key,
              data: filtered,
              fromBatch: true
            });
          }
        }
      } else if (type === 'postIds') {
        // Combine: SELECT * FROM posts WHERE id IN (?)
        const ids = items.map(q => q.ids).flat();
        const uniqueIds = [...new Set(ids)];
        
        if (uniqueIds.length > 0) {
          const placeholders = uniqueIds.map(() => '?').join(',');
          const stmt = this.db.prepare(
            `SELECT * FROM posts WHERE id IN (${placeholders})`
          );
          const rows = await stmt.bind(...uniqueIds).all();
          const rowsArray = rows?.results || [];
          
          for (const query of items) {
            const filtered = rowsArray.filter(r => query.ids.includes(r.id));
            results.push({
              key: query.key,
              data: filtered,
              fromBatch: true
            });
          }
        }
      } else if (type === 'conversations') {
        // Get multiple conversations
        const ids = items.map(q => q.id);
        const placeholders = ids.map(() => '?').join(',');
        const stmt = this.db.prepare(
          `SELECT * FROM conversations WHERE id IN (${placeholders})`
        );
        const rows = await stmt.bind(...ids).all();
        const rowsArray = rows?.results || [];
        
        for (const query of items) {
          const row = rowsArray.find(r => r.id === query.id);
          results.push({
            key: query.key,
            data: row,
            fromBatch: true
          });
        }
      } else {
        // Fallback: execute individually
        for (const query of items) {
          const result = await query.queryFn();
          results.push({
            key: query.key,
            data: result,
            fromBatch: false
          });
        }
      }
    }

    return results;
  }

  /**
   * Batch write operations (transactions)
   * Groups multiple writes into logical units
   */
  async batchWrite(operations) {
    const results = [];

    // Group by operation type
    const inserts = operations.filter(op => op.type === 'insert');
    const updates = operations.filter(op => op.type === 'update');
    const deletes = operations.filter(op => op.type === 'delete');

    // Execute each group
    for (const insert of inserts) {
      try {
        const result = await this.db.prepare(insert.sql).bind(...insert.params).run();
        results.push({ key: insert.key, success: true, result });
      } catch (error) {
        results.push({ key: insert.key, success: false, error: error.message });
      }
    }

    for (const update of updates) {
      try {
        const result = await this.db.prepare(update.sql).bind(...update.params).run();
        results.push({ key: update.key, success: true, result });
      } catch (error) {
        results.push({ key: update.key, success: false, error: error.message });
      }
    }

    for (const del of deletes) {
      try {
        const result = await this.db.prepare(del.sql).bind(...del.params).run();
        results.push({ key: del.key, success: true, result });
      } catch (error) {
        results.push({ key: del.key, success: false, error: error.message });
      }
    }

    return results;
  }

  /**
   * Defer query execution and batch with others
   * Useful for request handlers (e.g., batch within same request)
   */
  async deferred(key, queryFn) {
    return new Promise((resolve) => {
      this.queue.push({ key, queryFn, resolve });

      if (!this.flushTimeout) {
        this.flushTimeout = setTimeout(() => this._flush(), this.flushInterval);
      }

      if (this.queue.length >= this.maxBatchSize) {
        clearTimeout(this.flushTimeout);
        this.flushTimeout = null;
        this._flush();
      }
    });
  }

  /**
   * Internal: Group queries by type for batch optimization
   */
  _groupQueries(queries) {
    const grouped = {};

    for (const query of queries) {
      if (query.type === 'userIds') {
        if (!grouped.userIds) grouped.userIds = [];
        grouped.userIds.push(query);
      } else if (query.type === 'postIds') {
        if (!grouped.postIds) grouped.postIds = [];
        grouped.postIds.push(query);
      } else if (query.type === 'conversations') {
        if (!grouped.conversations) grouped.conversations = [];
        grouped.conversations.push(query);
      } else {
        if (!grouped.other) grouped.other = [];
        grouped.other.push(query);
      }
    }

    return grouped;
  }

  /**
   * Internal: Execute deferred queries
   */
  async _flush() {
    if (this.queue.length === 0) return;

    const toExecute = this.queue.splice(0, this.maxBatchSize);
    this.flushTimeout = null;

    try {
      // Execute all in parallel (not truly batched, but grouped)
      const results = await Promise.all(
        toExecute.map(item => 
          Promise.resolve(item.queryFn())
            .then(data => ({ key: item.key, data, error: null }))
            .catch(error => ({ key: item.key, data: null, error }))
        )
      );

      // Resolve each promise
      for (let i = 0; i < results.length; i++) {
        toExecute[i].resolve(results[i]);
      }
    } catch (error) {
      // Resolve all with error
      for (const item of toExecute) {
        item.resolve({ error });
      }
    }

    // Continue flushing if more in queue
    if (this.queue.length > 0) {
      this.flushTimeout = setTimeout(() => this._flush(), this.flushInterval);
    }
  }
}

/**
 * Helper function to batch read multiple users at once
 */
export function buildUserBatchQuery(userIds) {
  return {
    type: 'userIds',
    ids: userIds,
    key: `users:${userIds.join(',')}`
  };
}

/**
 * Helper function to batch read multiple posts at once
 */
export function buildPostBatchQuery(postIds) {
  return {
    type: 'postIds',
    ids: postIds,
    key: `posts:${postIds.join(',')}`
  };
}

/**
 * Helper function to batch read multiple conversations
 */
export function buildConversationBatchQuery(conversationIds) {
  return conversationIds.map(id => ({
    type: 'conversations',
    id,
    key: `conversation:${id}`
  }));
}
