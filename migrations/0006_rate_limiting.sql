-- Migration: Add rate limiting table
-- Created: 2024-12-29

-- Rate limit tracking table
CREATE TABLE IF NOT EXISTS rate_limit_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

-- Index for efficient rate limit queries
CREATE INDEX IF NOT EXISTS idx_rate_limit_key_timestamp ON rate_limit_tracking(key, timestamp);

-- Clean up old records (this should be run periodically by a cron job)
-- Records older than 1 hour can be safely deleted
-- DELETE FROM rate_limit_tracking WHERE timestamp < (strftime('%s', 'now') - 3600);
