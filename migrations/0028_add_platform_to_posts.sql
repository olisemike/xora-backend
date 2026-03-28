-- Migration: Add platform field to posts table for imported content tracking
-- Enables frontend to efficiently identify and filter imported content without JOINs

ALTER TABLE posts ADD COLUMN platform TEXT;

-- Index for filtering imported content by platform
CREATE INDEX IF NOT EXISTS idx_posts_platform ON posts(platform);

-- Create curator system account for imported content (must exist before any imports)
INSERT OR IGNORE INTO users (
  id, email, username, password_hash, name, bio, verified, email_verified, created_at, updated_at
) VALUES (
  'curator_system',
  'curator@xora.local',
  'curator_system',
  'system_account',
  'Content Curator',
  'System account for importing content from external sources',
  1, 1, 
  1704067200000,
  1704067200000
);
