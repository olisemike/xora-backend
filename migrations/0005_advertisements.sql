-- ============================================
-- ADVERTISEMENTS TABLES
-- ============================================

-- Advertisements table
CREATE TABLE IF NOT EXISTS advertisements (
  id TEXT PRIMARY KEY,

  -- Ad metadata
  title TEXT NOT NULL,
  description TEXT,

  -- Ad content
  ad_type TEXT NOT NULL CHECK(ad_type IN ('image', 'video', 'script')),
  content_url TEXT, -- For images/videos (Cloudflare Images/Stream URL)
  script_content TEXT, -- For script-based ads (HTML/JS snippet)
  thumbnail_url TEXT, -- Thumbnail for video ads

  -- Targeting
  target_regions TEXT DEFAULT '[]', -- JSON array of region codes
  target_languages TEXT DEFAULT '[]', -- JSON array of language codes
  target_demographics TEXT DEFAULT '{}', -- JSON object with age_min, age_max, gender, etc.
  target_interests TEXT DEFAULT '[]', -- JSON array of interest tags
  global_targeting BOOLEAN DEFAULT 0, -- If true, show to everyone

  -- Placement configuration
  placement_feeds BOOLEAN DEFAULT 0, -- Show in regular feeds
  placement_reels BOOLEAN DEFAULT 0, -- Show in reels
  placement_stories BOOLEAN DEFAULT 0, -- Show in stories

  -- Reel-specific placement
  reel_position TEXT CHECK(reel_position IN ('before', 'after', 'both', NULL)), -- Position relative to content

  -- Frequency & scheduling
  frequency_type TEXT NOT NULL DEFAULT 'manual' CHECK(frequency_type IN ('manual', 'impressions', 'time_based')),
  frequency_value INTEGER, -- Every N impressions or every N minutes
  max_impressions_per_user INTEGER DEFAULT 3, -- Max times a user sees this ad
  max_clicks_per_user INTEGER DEFAULT 1, -- Max times a user can click

  -- Priority & weights
  priority INTEGER DEFAULT 0, -- Higher priority = more likely to show
  weight REAL DEFAULT 1.0, -- Weight for random selection (0.0-1.0)

  -- Budget & limits (optional)
  total_budget REAL, -- Total budget in currency
  cost_per_impression REAL, -- Cost per impression
  cost_per_click REAL, -- Cost per click
  total_impressions_limit INTEGER, -- Max total impressions
  total_clicks_limit INTEGER, -- Max total clicks
  daily_impressions_limit INTEGER, -- Max impressions per day
  daily_budget_limit REAL, -- Max spend per day

  -- Call to action
  cta_text TEXT, -- Button text (e.g., "Learn More", "Shop Now")
  cta_url TEXT, -- Destination URL

  -- Scheduling
  starts_at INTEGER, -- Unix timestamp when ad becomes active
  ends_at INTEGER, -- Unix timestamp when ad expires

  -- Status & moderation
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'pending_review', 'approved', 'active', 'paused', 'rejected', 'expired')),
  moderation_notes TEXT, -- Admin notes during review
  rejection_reason TEXT, -- Reason if rejected

  -- Tracking
  total_impressions INTEGER DEFAULT 0,
  total_clicks INTEGER DEFAULT 0,
  total_spend REAL DEFAULT 0.0,

  -- Audit
  created_by TEXT NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (created_by) REFERENCES admin_users(id),
  FOREIGN KEY (approved_by) REFERENCES admin_users(id)
);

CREATE INDEX idx_ads_status ON advertisements(status);
CREATE INDEX idx_ads_active ON advertisements(status, starts_at, ends_at);
CREATE INDEX idx_ads_created_by ON advertisements(created_by);
CREATE INDEX idx_ads_placement ON advertisements(placement_feeds, placement_reels, placement_stories);

-- Advertisement impressions (tracking)
CREATE TABLE IF NOT EXISTS ad_impressions (
  id TEXT PRIMARY KEY,
  ad_id TEXT NOT NULL,
  user_id TEXT,

  -- Context
  placement_type TEXT NOT NULL CHECK(placement_type IN ('feed', 'reel', 'story')),
  position_in_feed INTEGER, -- Position where ad appeared

  -- Engagement
  viewed BOOLEAN DEFAULT 0, -- Did user actually view it
  view_duration INTEGER, -- Seconds viewed (for video ads)
  clicked BOOLEAN DEFAULT 0,
  click_timestamp INTEGER,

  -- Device & session info
  device_type TEXT,
  user_agent TEXT,
  ip_address TEXT,

  -- Analytics
  created_at INTEGER NOT NULL,

  FOREIGN KEY (ad_id) REFERENCES advertisements(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_ad_impressions_ad ON ad_impressions(ad_id);
CREATE INDEX idx_ad_impressions_user ON ad_impressions(user_id);
CREATE INDEX idx_ad_impressions_created_at ON ad_impressions(created_at);
CREATE INDEX idx_ad_impressions_placement ON ad_impressions(placement_type);

-- User ad frequency tracking (prevents over-showing)
CREATE TABLE IF NOT EXISTS user_ad_frequency (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ad_id TEXT NOT NULL,
  impression_count INTEGER DEFAULT 0,
  click_count INTEGER DEFAULT 0,
  last_shown_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, ad_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (ad_id) REFERENCES advertisements(id) ON DELETE CASCADE
);

CREATE INDEX idx_user_ad_freq_user ON user_ad_frequency(user_id);
CREATE INDEX idx_user_ad_freq_ad ON user_ad_frequency(ad_id);
CREATE INDEX idx_user_ad_freq_last_shown ON user_ad_frequency(last_shown_at);

-- Advertisement analytics (daily aggregates)
CREATE TABLE IF NOT EXISTS ad_analytics_daily (
  id TEXT PRIMARY KEY,
  ad_id TEXT NOT NULL,
  date TEXT NOT NULL, -- YYYY-MM-DD format

  -- Metrics
  impressions INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0, -- Actually viewed
  clicks INTEGER DEFAULT 0,
  unique_users INTEGER DEFAULT 0,
  total_view_duration INTEGER DEFAULT 0, -- Total seconds

  -- Costs
  spend REAL DEFAULT 0.0,

  -- Breakdown by placement
  feed_impressions INTEGER DEFAULT 0,
  reel_impressions INTEGER DEFAULT 0,
  story_impressions INTEGER DEFAULT 0,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(ad_id, date),
  FOREIGN KEY (ad_id) REFERENCES advertisements(id) ON DELETE CASCADE
);

CREATE INDEX idx_ad_analytics_ad ON ad_analytics_daily(ad_id);
CREATE INDEX idx_ad_analytics_date ON ad_analytics_daily(date DESC);

-- Advertisement targeting cache (pre-computed user segments)
CREATE TABLE IF NOT EXISTS ad_targeting_cache (
  id TEXT PRIMARY KEY,
  ad_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  is_eligible BOOLEAN DEFAULT 1,
  computed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, -- Recompute after expiry
  UNIQUE(ad_id, user_id),
  FOREIGN KEY (ad_id) REFERENCES advertisements(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_ad_targeting_ad ON ad_targeting_cache(ad_id);
CREATE INDEX idx_ad_targeting_user ON ad_targeting_cache(user_id);
CREATE INDEX idx_ad_targeting_expires ON ad_targeting_cache(expires_at);
