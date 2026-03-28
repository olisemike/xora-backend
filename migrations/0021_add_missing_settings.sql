-- Migration: Add missing user settings columns
-- Description: Adds additional settings columns for mobile app functionality
-- NOTE: These columns already exist in the schema, so this migration is a no-op
-- All columns were pre-created in earlier migrations

-- Columns that already exist and should not be re-added:
-- - autoplay_wifi
-- - media_autoplay_mobile
-- - data_saver_mode
-- - topic_interests
-- - captions_for_videos

-- This migration file is kept for history/audit trail purposes
-- Execute a no-op statement to confirm migration was processed
SELECT 1;