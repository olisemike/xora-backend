-- ============================================
-- ADD MEDIA SUPPORT TO COMMENTS
-- Migration 0018: Comment Media URLs
-- ============================================

-- Add media support to comments
ALTER TABLE comments ADD COLUMN media_urls TEXT;

-- Index for media queries (only when media exists)
CREATE INDEX IF NOT EXISTS idx_comments_media ON comments(media_urls) WHERE media_urls IS NOT NULL;

-- Optimize query planner after schema change
ANALYZE;
