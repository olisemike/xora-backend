-- ============================================
-- Migration 0023: Admin Security & RBAC
-- Admin rate limiting, audit logging, and RBAC enhancements
-- ============================================

-- Admin operation rate limiting table
-- Tracks rate limits for expensive admin operations
CREATE TABLE IF NOT EXISTS admin_rate_limits (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  window_start INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(admin_id, operation),
  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_admin_rate_limits_admin_operation
  ON admin_rate_limits(admin_id, operation);

CREATE INDEX IF NOT EXISTS idx_admin_rate_limits_window
  ON admin_rate_limits(window_start);

-- Admin audit log table
-- Tracks all admin actions for accountability and debugging
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  target_id TEXT,
  timestamp INTEGER NOT NULL,
  client_ip TEXT,
  user_agent TEXT,
  details TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Indexes for querying audit logs
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin_id
  ON admin_audit_log(admin_id);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_operation
  ON admin_audit_log(operation);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_target_id
  ON admin_audit_log(target_id);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_timestamp
  ON admin_audit_log(timestamp DESC);

-- Composite index for common queries
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin_timestamp
  ON admin_audit_log(admin_id, timestamp DESC);

-- Enhance admin_users table with role management
-- Add role and permissions columns if they don't exist
-- (Some databases may already have these from 0015_local_admin.sql)
-- NOTE: SQLite doesn't support IF NOT EXISTS for ALTER TABLE
-- If these columns already exist, this step will be skipped
-- The system will check for these columns at runtime
-- ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'moderator';
-- ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS permissions TEXT DEFAULT 'null';
-- ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS created_at DATETIME DEFAULT CURRENT_TIMESTAMP;
-- ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS last_activity DATETIME DEFAULT CURRENT_TIMESTAMP;

-- Optional: Manually run these if columns don't exist:
-- ALTER TABLE admin_users ADD COLUMN role TEXT DEFAULT 'moderator';
-- ALTER TABLE admin_users ADD COLUMN permissions TEXT DEFAULT 'null';
-- ALTER TABLE admin_users ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP;
-- ALTER TABLE admin_users ADD COLUMN last_activity DATETIME DEFAULT CURRENT_TIMESTAMP;

-- Index for role-based queries
CREATE INDEX IF NOT EXISTS idx_admin_users_role
  ON admin_users(role);

-- Ensure admin_users table has necessary columns for RBAC
-- These are already in the schema from earlier migrations but we verify:
-- - id (PK)
-- - admin_id -> user_id (FK to users)
-- - role (admin_role: super_admin, admin, moderator, support)
-- - permissions (JSON array of permission strings)

-- Session management for admin panel (optional, for 30-min timeout)
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_id
  ON admin_sessions(admin_id);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
  ON admin_sessions(expires_at);

-- Cleanup old rate limit entries (run periodically)
-- DELETE FROM admin_rate_limits WHERE window_start < (strftime('%s', 'now') - 3600);

-- Cleanup old audit logs (run periodically, e.g., keep 90 days)
-- DELETE FROM admin_audit_log WHERE timestamp < (strftime('%s', 'now') - (90 * 86400));
