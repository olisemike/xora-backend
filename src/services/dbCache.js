/**
 * Database Query Caching Layer
 * Reduces load on D1 by caching frequently accessed data
 * Auto-invalidates on mutations
 */

export class DatabaseCache {
  constructor(options = {}) {
    this.cache = new Map();
    this.ttl = options.ttl || 60000; // 1 minute default
    this.maxSize = options.maxSize || 1000; // max cached items
    this.stats = {
      hits: 0,
      misses: 0,
      invalidations: 0
    };
  }

  /**
   * Execute a query with caching
   * @param {string} key - Cache key
   * @param {Function} queryFn - Async function that executes query
   * @param {Object} options - { ttl, tags }
   */
  async query(key, queryFn, options = {}) {
    const cacheKey = `query:${key}`;
    const ttl = options.ttl || this.ttl;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      this.stats.hits++;
      return cached.data;
    }

    this.stats.misses++;

    // Execute query
    const data = await queryFn();

    // Cache result
    this._set(cacheKey, data, ttl, options.tags);

    return data;
  }

  /**
   * Batch multiple queries into one cache check
   * Returns only non-cached items' queries
   */
  batch(queries) {
    const cached = [];
    const toQuery = [];

    for (const { key, queryFn, options } of queries) {
      const cacheKey = `query:${key}`;
      const item = this.cache.get(cacheKey);

      if (item && item.expires > Date.now()) {
        cached.push({ key, data: item.data, fromCache: true });
        this.stats.hits++;
      } else {
        toQuery.push({ key, queryFn, options, cacheKey });
        this.stats.misses++;
      }
    }

    return { cached, toQuery };
  }

  /**
   * Invalidate cache by pattern or tag
   * @param {string} pattern - Pattern to match keys
   * @param {string} tag - Tag to invalidate
   */
  invalidate(pattern, tag = null) {
    if (tag) {
      // Invalidate by tag
      for (const [key, value] of this.cache.entries()) {
        if (value.tags && value.tags.includes(tag)) {
          this.cache.delete(key);
          this.stats.invalidations++;
        }
      }
    } else {
      // Invalidate by pattern
      for (const key of this.cache.keys()) {
        if (key.includes(pattern)) {
          this.cache.delete(key);
          this.stats.invalidations++;
        }
      }
    }

    // Cleanup if cache is too large
    if (this.cache.size > this.maxSize) {
      this._cleanup();
    }
  }

  /**
   * Set cache manually
   */
  set(key, data, ttl = null, tags = []) {
    const cacheKey = `query:${key}`;
    this._set(cacheKey, data, ttl || this.ttl, tags);
  }

  /**
   * Get from cache without executing query
   */
  get(key) {
    const cacheKey = `query:${key}`;
    const item = this.cache.get(cacheKey);
    if (item && item.expires > Date.now()) {
      return item.data;
    }
    return null;
  }

  /**
   * Clear all cache
   */
  clear() {
    this.cache.clear();
    this.stats.invalidations = 0;
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? (this.stats.hits / total) : 0;
    return {
      ...this.stats,
      hitRate,
      size: this.cache.size
    };
  }

  /**
   * Internal: Set cache item
   */
  _set(cacheKey, data, ttl, tags = []) {
    this.cache.set(cacheKey, {
      data,
      expires: Date.now() + ttl,
      tags,
      createdAt: Date.now()
    });

    // Cleanup if too large
    if (this.cache.size > this.maxSize) {
      this._cleanup();
    }
  }

  /**
   * Internal: Remove expired and least-used items
   */
  _cleanup() {
    const now = Date.now();
    const toDelete = [];

    // Remove expired items
    for (const [key, value] of this.cache.entries()) {
      if (value.expires <= now) {
        toDelete.push(key);
      }
    }

    // If still over size, remove oldest
    if (this.cache.size - toDelete.length > this.maxSize * 0.8) {
      const entries = Array.from(this.cache.entries())
        .sort((a, b) => a[1].createdAt - b[1].createdAt)
        .slice(0, Math.ceil(this.maxSize * 0.2));

      entries.forEach(([key]) => {
        if (!toDelete.includes(key)) toDelete.push(key);
      });
    }

    toDelete.forEach(key => this.cache.delete(key));
  }
}

// Global cache instance (per worker)
let globalCache = null;

export function initCache(options = {}) {
  globalCache = new DatabaseCache(options);
  return globalCache;
}

export function getCache() {
  if (!globalCache) {
    globalCache = new DatabaseCache();
  }
  return globalCache;
}
