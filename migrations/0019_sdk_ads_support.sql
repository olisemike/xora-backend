-- ============================================
-- SDK ADS SUPPORT
-- Add support for third-party SDK advertisements
-- ============================================

-- Update ad_type to support 'sdk' type
-- Note: SQLite doesn't support ALTER CHECK constraint, so we document the new allowed value
-- The check constraint allows: 'image', 'video', 'script', 'sdk'

-- Add SDK-specific columns to advertisements table
ALTER TABLE advertisements ADD COLUMN sdk_provider TEXT; -- 'admob', 'meta', 'unity', 'applovin', etc.
ALTER TABLE advertisements ADD COLUMN sdk_ad_unit_id TEXT; -- Ad unit ID from SDK provider
ALTER TABLE advertisements ADD COLUMN sdk_config TEXT DEFAULT '{}'; -- JSON config for SDK-specific settings

-- Add placement for search results
ALTER TABLE advertisements ADD COLUMN placement_search BOOLEAN DEFAULT 0; -- Show in search results

-- Create index for search placement
CREATE INDEX IF NOT EXISTS idx_ads_placement_search ON advertisements(placement_search) WHERE placement_search = 1;

-- Add comment explaining new ad_type values
-- Valid ad_type values: 'image', 'video', 'script', 'sdk'
-- For 'sdk' type ads:
--   - sdk_provider: Provider name (e.g., 'admob', 'meta_audience', 'unity')
--   - sdk_ad_unit_id: Ad unit/placement ID from the provider
--   - sdk_config: JSON object with provider-specific configuration
--     Example for AdMob banner: {"format": "banner", "size": "320x50"}
--     Example for Meta native: {"format": "native", "template": "card"}

-- Update ad_impressions table placement_type check constraint
-- Note: SQLite doesn't support ALTER CHECK constraint, so we document the new allowed values
-- Valid placement_type values: 'feed', 'reel', 'story', 'search'
