-- ============================================
-- MIGRATION 0026: Flexible Reel Views (Posts + Reels)
-- ============================================
-- Purpose: Allow reel_views to track views for both actual reels AND video posts
-- This handles all post types: single video, multiple videos, mixed media

-- SQLite doesn't support DROP CONSTRAINT, so we recreate the table
-- Save existing data, drop old table, create new one without FK, restore data

-- Create temporary table with existing data
CREATE TABLE reel_views_backup AS SELECT * FROM reel_views;

-- Drop the old table with FK constraint
DROP TABLE reel_views;

-- Recreate without FK constraint - reel_id can now be either a reel ID or post ID
CREATE TABLE IF NOT EXISTS reel_views (
  id TEXT PRIMARY KEY,
  reel_id TEXT NOT NULL,
  viewer_type TEXT NOT NULL CHECK(viewer_type IN ('user', 'page')),
  viewer_id TEXT NOT NULL,
  viewed_at INTEGER NOT NULL,
  UNIQUE(reel_id, viewer_type, viewer_id)
);

-- Restore data and recreate indexes
INSERT INTO reel_views SELECT * FROM reel_views_backup;
DROP TABLE reel_views_backup;

CREATE INDEX IF NOT EXISTS idx_reel_views_reel ON reel_views(reel_id);
CREATE INDEX IF NOT EXISTS idx_reel_views_viewer ON reel_views(viewer_type, viewer_id);
CREATE INDEX IF NOT EXISTS idx_reel_views_composite ON reel_views(reel_id, viewer_type, viewer_id);
