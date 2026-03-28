-- Migration: Add performance indexes for advertisements and analytics
-- Created: 2024-12-29

-- Indexes for advertisement queries
-- These indexes significantly improve query performance for ad selection and analytics

-- Index for filtering active ads with budget limits
CREATE INDEX IF NOT EXISTS idx_ads_status_impressions ON advertisements(status, total_impressions, total_impressions_limit);

-- Index for filtering active ads with click limits
CREATE INDEX IF NOT EXISTS idx_ads_status_clicks ON advertisements(status, total_clicks, total_clicks_limit);

-- Index for ad placement queries
CREATE INDEX IF NOT EXISTS idx_ads_placement_feeds ON advertisements(placement_feeds, status);
CREATE INDEX IF NOT EXISTS idx_ads_placement_reels ON advertisements(placement_reels, status);
CREATE INDEX IF NOT EXISTS idx_ads_placement_stories ON advertisements(placement_stories, status);

-- Index for ad scheduling queries
CREATE INDEX IF NOT EXISTS idx_ads_schedule ON advertisements(status, starts_at, ends_at);

-- Composite index for active ad selection with placement
CREATE INDEX IF NOT EXISTS idx_ads_active_selection ON advertisements(
  status,
  placement_feeds,
  placement_reels,
  placement_stories,
  total_impressions,
  total_impressions_limit
);

-- Index for creator-based ad queries
CREATE INDEX IF NOT EXISTS idx_ads_creator ON advertisements(created_by, status);

-- Indexes for ad_impressions table
-- Improve performance for analytics and frequency tracking

-- Index for ad analytics queries
CREATE INDEX IF NOT EXISTS idx_impressions_ad_created ON ad_impressions(ad_id, created_at);

-- Index for user frequency queries
CREATE INDEX IF NOT EXISTS idx_impressions_user_ad ON ad_impressions(user_id, ad_id);

-- Index for placement-based analytics
CREATE INDEX IF NOT EXISTS idx_impressions_placement ON ad_impressions(placement_type, created_at);

-- Index for click tracking
CREATE INDEX IF NOT EXISTS idx_impressions_clicked ON ad_impressions(clicked, created_at);

-- Composite index for comprehensive ad analytics
CREATE INDEX IF NOT EXISTS idx_impressions_analytics ON ad_impressions(
  ad_id,
  created_at,
  viewed,
  clicked
);

-- Indexes for user_ad_frequency table
-- Already has UNIQUE(user_id, ad_id) which serves as an index

-- Index for finding users at frequency cap
CREATE INDEX IF NOT EXISTS idx_frequency_caps ON user_ad_frequency(
  ad_id,
  impression_count,
  click_count
);

-- Indexes for ad_analytics_daily table
-- Improve performance for daily analytics queries

-- Index for date range queries
CREATE INDEX IF NOT EXISTS idx_analytics_daily_date ON ad_analytics_daily(ad_id, date);

-- Indexes for admin_audit_logs
-- Improve performance for audit log queries

-- Index for admin-specific logs
CREATE INDEX IF NOT EXISTS idx_audit_admin ON admin_audit_logs(admin_id, created_at);

-- Index for action type filtering
CREATE INDEX IF NOT EXISTS idx_audit_action_type ON admin_audit_logs(action_type, created_at);

-- Index for target-based queries
CREATE INDEX IF NOT EXISTS idx_audit_target ON admin_audit_logs(target_type, target_id, created_at);

-- Composite index for comprehensive audit queries
CREATE INDEX IF NOT EXISTS idx_audit_comprehensive ON admin_audit_logs(
  admin_id,
  action_type,
  created_at
);

-- Indexes for user-related queries (if not already present)
-- NOTE: The following indexes reference columns/tables that do not exist in the current schema
-- (e.g., users.is_banned, users.banned_until, posts.author_id, posts.visibility, batch_distribution table).
-- They are purely performance optimizations and are safe to omit for local development.
-- If you later add these columns/tables, you can reintroduce or adjust these indexes.
--
-- Index for user searches by username (users.username already indexed in earlier migrations)
-- CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
--
-- Index for user searches by email (users.email already indexed in earlier migrations)
-- CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
--
-- Index for active/banned users (requires is_banned, banned_until columns on users)
-- CREATE INDEX IF NOT EXISTS idx_users_banned ON users(is_banned, banned_until);
--
-- Indexes for posts table (would require author_id/visibility columns)
-- CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, created_at);
-- CREATE INDEX IF NOT EXISTS idx_posts_visibility ON posts(visibility, created_at);
-- CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts(visibility, created_at, author_id);
--
-- Indexes for batch_distribution table (table not present in current schema)
-- CREATE INDEX IF NOT EXISTS idx_batch_user ON batch_distribution(user_id, batch_number);
-- CREATE INDEX IF NOT EXISTS idx_batch_content ON batch_distribution(batch_number, content_type, content_id);
--
-- Performance Notes:
-- 1. These indexes will slow down INSERT/UPDATE operations slightly
-- 2. But they will dramatically improve SELECT query performance
-- 3. Recommended to run ANALYZE after creating these indexes
-- 4. Monitor index usage and remove unused indexes if needed
-- 5. Consider running VACUUM ANALYZE periodically to optimize database

-- To check index usage:
-- SELECT * FROM sqlite_stat1;

-- To see all indexes:
-- SELECT name, tbl_name FROM sqlite_master WHERE type = 'index';
