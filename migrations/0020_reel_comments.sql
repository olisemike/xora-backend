-- Migration: Add reel comments table
-- DEPRECATED: This table is no longer used.
-- Reels are now video posts from the posts table, and comments use the standard
-- comments table with target_type='post'. This migration is kept for backwards
-- compatibility but the table will not be used for new comments.

CREATE TABLE IF NOT EXISTS reel_comments (
  id TEXT PRIMARY KEY,
  reel_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'page')),
  actor_id TEXT NOT NULL,
  content TEXT NOT NULL,
  parent_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (reel_id) REFERENCES reels(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES reel_comments(id) ON DELETE CASCADE
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_reel_comments_reel_id ON reel_comments(reel_id);
CREATE INDEX IF NOT EXISTS idx_reel_comments_actor ON reel_comments(actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_reel_comments_parent ON reel_comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_reel_comments_created ON reel_comments(reel_id, created_at DESC);
