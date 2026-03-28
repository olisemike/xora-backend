// Database Retry Logic with Exponential Backoff
import { logger } from './logger.js';

/**
 * Retry a database operation with exponential backoff and optional timeout
 * @param {Function} operation - Async function to retry
 * @param {Object} options - Retry options
 * @returns {Promise} Result of the operation
 */
export async function retryOperation(operation, options = {}) {
  const {
    maxRetries = 3,
    initialDelay = 100, // ms
    maxDelay = 5000, // ms
    backoffMultiplier = 2,
    timeoutMs = null, // Query timeout (null = no timeout)
    retryableErrors = [
      'SQLITE_BUSY',
      'SQLITE_LOCKED',
      'database is locked',
      'timeout',
      'ECONNRESET',
      'ETIMEDOUT'
    ]
  } = options;

  let lastError;
  let delay = initialDelay;

  // eslint-disable-next-line no-await-in-loop
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Wrap operation with timeout if specified
      if (timeoutMs && timeoutMs > 0) {
        return await Promise.race([
          operation(),
          new Promise((_resolve, reject) =>
            setTimeout(
              () => reject(new Error(`Query timeout after ${timeoutMs}ms`)),
              timeoutMs
            )
          )
        ]);
      }

      // eslint-disable-next-line no-await-in-loop
      return await operation();
    } catch (error) {
      lastError = error;

      // Check if error is retryable
      const isRetryable = retryableErrors.some(retryableError =>
        error.message?.toLowerCase().includes(retryableError.toLowerCase()) ||
        error.code?.toLowerCase().includes(retryableError.toLowerCase())
      );

      // If not retryable or last attempt, throw error
      if (!isRetryable || attempt === maxRetries) {
        logger.error('Database operation failed after retries', error, {
          attempt: attempt + 1,
          maxRetries: maxRetries + 1,
          timeout: timeoutMs
        });
        throw error;
      }

      // Log retry attempt
      logger.warn('Retrying database operation', {
        attempt: attempt + 1,
        maxRetries: maxRetries + 1,
        delay: `${delay}ms`,
        error: error.message
      });

      // Wait before retrying
      // eslint-disable-next-line no-await-in-loop
      await sleep(delay);

      // Calculate next delay with exponential backoff
      delay = Math.min(delay * backoffMultiplier, maxDelay);
    }
  }

  throw lastError;
}

/**
 * Sleep utility
 */
// eslint-disable-next-line promise/avoid-new
function sleep(ms) {
  // eslint-disable-next-line promise/avoid-new
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wrap a database instance with retry logic
 */
export class RetryableDatabase {
  constructor(db, retryOptions = {}) {
    this.db = db;
    this.retryOptions = retryOptions;
    
    // Timeout configuration for different query types
    this.readTimeoutMs = retryOptions.readTimeoutMs || 5000; // 5 sec for SELECTs
    this.writeTimeoutMs = retryOptions.writeTimeoutMs || 10000; // 10 sec for INSERT/UPDATE/DELETE
    
    // Simple cache for parameterless prepared statements (safe to reuse)
    this._stmtCache = new Map();
    this._stmtCacheLimit = retryOptions.stmtCacheLimit || 100;
  }

  /**
   * Determine if query is a write operation
   */
  _isWriteQuery(query) {
    return /^\s*(INSERT|UPDATE|DELETE|REPLACE)\s+/i.test(query);
  }

  /**
   * Get appropriate timeout for a query
   */
  _getQueryTimeout(query) {
    return this._isWriteQuery(query) ? this.writeTimeoutMs : this.readTimeoutMs;
  }

  /**
   * Execute a prepared statement with retry
   */
  prepare(query) {
    // Get appropriate timeout for this query type
    const timeout = this._getQueryTimeout(query);
    const retryOpts = { ...this.retryOptions, timeoutMs: timeout };

    // If the query has no parameter placeholders, reuse a cached statement
    const hasParams = query.includes('?') || query.includes('$') || query.includes(':');

    if (!hasParams) {
      let cached = this._stmtCache.get(query);
      if (!cached) {
        const stmt = this.db.prepare(query);
        cached = stmt;
        // Maintain simple LRU by deleting oldest when limit exceeded
        if (this._stmtCache.size >= this._stmtCacheLimit) {
          const firstKey = this._stmtCache.keys().next().value;
          if (firstKey) this._stmtCache.delete(firstKey);
        }
        this._stmtCache.set(query, cached);
      }

      return {
        first: () => retryOperation(() => cached.first(), retryOpts),
        all: () => retryOperation(() => cached.all(), retryOpts),
        run: () => retryOperation(() => cached.run(), retryOpts),
        raw: () => retryOperation(() => cached.raw(), retryOpts)
      };
    }

    // Parameterized queries: create a fresh statement per call to avoid
    // concurrency issues when binding parameters on the same statement.
    const stmt = this.db.prepare(query);

    return {
      bind: (...params) => {
        stmt.bind(...params);
        return {
          first: () => retryOperation(() => stmt.first(), retryOpts),
          all: () => retryOperation(() => stmt.all(), retryOpts),
          run: () => retryOperation(() => stmt.run(), retryOpts),
          raw: () => retryOperation(() => stmt.raw(), retryOpts)
        };
      },
      first: () => retryOperation(() => stmt.first(), retryOpts),
      all: () => retryOperation(() => stmt.all(), retryOpts),
      run: () => retryOperation(() => stmt.run(), this.retryOptions),
      raw: () => retryOperation(() => stmt.raw(), this.retryOptions)
    };
  }

  /**
   * Execute a batch of statements with retry
   */
  batch(statements) {
    return retryOperation(
      () => this.db.batch(statements),
      this.retryOptions
    );
  }

  /**
   * Execute a prepared statement directly (no retry)
   * Use for operations that shouldn't be retried
   */
  prepareWithoutRetry(query) {
    return this.db.prepare(query);
  }
}

/**
 * Create a retryable database instance
 */
export function createRetryableDb(db, options = {}) {
  return new RetryableDatabase(db, options);
}
