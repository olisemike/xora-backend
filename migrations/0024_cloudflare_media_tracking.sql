-- Migration 0024: Cloudflare Media Tracking
-- Add columns to track Cloudflare image IDs for cleanup on deletion

-- Track Cloudflare image IDs in posts (for media deletion)
ALTER TABLE posts ADD COLUMN cloudflare_image_ids TEXT; -- JSON array of image IDs

-- Track Cloudflare image IDs in comments (for media deletion)
ALTER TABLE comments ADD COLUMN cloudflare_image_ids TEXT; -- JSON array of image IDs

-- Track Cloudflare image IDs in messages (for media deletion)
ALTER TABLE messages ADD COLUMN cloudflare_image_ids TEXT; -- JSON array of image IDs

-- Track Cloudflare IDs for user avatars and covers
ALTER TABLE users ADD COLUMN cloudflare_avatar_id TEXT;
ALTER TABLE users ADD COLUMN cloudflare_cover_id TEXT;

-- Track Cloudflare IDs for page avatars and covers
ALTER TABLE pages ADD COLUMN cloudflare_avatar_id TEXT;
ALTER TABLE pages ADD COLUMN cloudflare_cover_id TEXT;

-- Create indexes for queries that check for media
CREATE INDEX IF NOT EXISTS idx_posts_cloudflare_media ON posts(cloudflare_image_ids) WHERE cloudflare_image_ids IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comments_cloudflare_media ON comments(cloudflare_image_ids) WHERE cloudflare_image_ids IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_cloudflare_media ON messages(cloudflare_image_ids) WHERE cloudflare_image_ids IS NOT NULL;
