-- Migration 0026: Video ID Tracking for Messages, Comments, and Posts
-- Add Cloudflare Stream video ID tracking to enable proper cleanup on deletion

-- Track Cloudflare Stream video IDs in posts (for video cleanup on deletion)
ALTER TABLE posts ADD COLUMN cloudflare_video_ids TEXT; -- JSON array of Stream video IDs

-- Track Cloudflare Stream video IDs in messages (for video cleanup on deletion)
ALTER TABLE messages ADD COLUMN cloudflare_video_ids TEXT; -- JSON array of Stream video IDs

-- Track Cloudflare Stream video IDs in comments (for video cleanup on deletion)
ALTER TABLE comments ADD COLUMN cloudflare_video_ids TEXT; -- JSON array of Stream video IDs

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_posts_cloudflare_videos ON posts(cloudflare_video_ids) WHERE cloudflare_video_ids IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_cloudflare_videos ON messages(cloudflare_video_ids) WHERE cloudflare_video_ids IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comments_cloudflare_videos ON comments(cloudflare_video_ids) WHERE cloudflare_video_ids IS NOT NULL;
