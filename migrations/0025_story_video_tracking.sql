-- Migration 0025: Story Video Tracking
-- Add column to track Cloudflare Stream video IDs for cleanup on deletion

-- Track Cloudflare video ID in stories (for media deletion)
ALTER TABLE stories ADD COLUMN cloudflare_video_id TEXT;

-- Create index for queries that check for video media
CREATE INDEX IF NOT EXISTS idx_stories_cloudflare_video ON stories(cloudflare_video_id) WHERE cloudflare_video_id IS NOT NULL;
