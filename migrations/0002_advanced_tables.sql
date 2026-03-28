-- ============================================
-- FEED ALGORITHM TABLES
-- ============================================

-- Post suggestion batches (tracks distribution state)
CREATE TABLE IF NOT EXISTS post_suggestion_batches (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  batch_size INTEGER NOT NULL,
  batch_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'completed', 'terminated')),
  engagement_rate REAL DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  engagements INTEGER DEFAULT 0,
  window_type TEXT NOT NULL CHECK(window_type IN ('integrity', 'primary', 'stability')),
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE INDEX idx_suggestion_batches_post ON post_suggestion_batches(post_id);
CREATE INDEX idx_suggestion_batches_status ON post_suggestion_batches(status);
CREATE INDEX idx_suggestion_batches_window_end ON post_suggestion_batches(window_end);

-- Exposure tracking (ensures users don't see same post twice)
CREATE TABLE IF NOT EXISTS post_exposures (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  exposed_at INTEGER NOT NULL,
  engaged BOOLEAN DEFAULT 0,
  UNIQUE(post_id, user_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (batch_id) REFERENCES post_suggestion_batches(id) ON DELETE CASCADE
);

CREATE INDEX idx_exposures_post ON post_exposures(post_id);
CREATE INDEX idx_exposures_user ON post_exposures(user_id);
CREATE INDEX idx_exposures_batch ON post_exposures(batch_id);

-- Trending posts
CREATE TABLE IF NOT EXISTS trending_posts (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  language TEXT NOT NULL,
  region TEXT,
  score REAL NOT NULL,
  started_trending_at INTEGER NOT NULL,
  last_calculated_at INTEGER NOT NULL,
  UNIQUE(post_id, language, region),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE INDEX idx_trending_language ON trending_posts(language);
CREATE INDEX idx_trending_region ON trending_posts(region);
CREATE INDEX idx_trending_score ON trending_posts(score DESC);

-- Trending topics/hashtags
CREATE TABLE IF NOT EXISTS trending_topics (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  language TEXT NOT NULL,
  region TEXT,
  post_count INTEGER DEFAULT 0,
  engagement_count INTEGER DEFAULT 0,
  score REAL NOT NULL,
  last_updated INTEGER NOT NULL,
  UNIQUE(topic, language, region)
);

CREATE INDEX idx_trending_topics_language ON trending_topics(language);
CREATE INDEX idx_trending_topics_score ON trending_topics(score DESC);

-- User behavior profiles (for suggestion targeting)
CREATE TABLE IF NOT EXISTS user_behavior_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  languages TEXT DEFAULT '[]',
  interests TEXT DEFAULT '[]',
  engagement_patterns TEXT DEFAULT '{}',
  last_updated INTEGER NOT NULL,
  UNIQUE(user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_behavior_user ON user_behavior_profiles(user_id);

-- ============================================
-- SETTINGS & PREFERENCES TABLES
-- ============================================

-- User settings
CREATE TABLE IF NOT EXISTS user_settings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  
  -- Privacy
  private_account BOOLEAN DEFAULT 0,
  who_can_message TEXT DEFAULT 'everyone' CHECK(who_can_message IN ('everyone', 'followers', 'mutual', 'none')),
  who_can_comment TEXT DEFAULT 'everyone' CHECK(who_can_comment IN ('everyone', 'followers', 'none')),
  who_can_tag TEXT DEFAULT 'everyone' CHECK(who_can_tag IN ('everyone', 'followers', 'none')),
  show_activity_status BOOLEAN DEFAULT 1,
  
  -- Sensitive content
  display_sensitive_content BOOLEAN DEFAULT 0,
  suggest_sensitive_content BOOLEAN DEFAULT 0,
  content_warnings BOOLEAN DEFAULT 1,
  
  -- Notifications
  notifications_email BOOLEAN DEFAULT 0,
  notifications_push BOOLEAN DEFAULT 1,
  notifications_in_app BOOLEAN DEFAULT 1,
  notify_likes BOOLEAN DEFAULT 1,
  notify_comments BOOLEAN DEFAULT 1,
  notify_follows BOOLEAN DEFAULT 1,
  notify_mentions BOOLEAN DEFAULT 1,
  notify_messages BOOLEAN DEFAULT 1,
  notify_shares BOOLEAN DEFAULT 1,
  
  -- Accessibility
  font_size TEXT DEFAULT 'medium' CHECK(font_size IN ('small', 'medium', 'large')),
  high_contrast BOOLEAN DEFAULT 0,
  reduced_motion BOOLEAN DEFAULT 0,
  screen_reader BOOLEAN DEFAULT 0,
  
  -- Language
  preferred_language TEXT DEFAULT 'en',
  
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_settings_user ON user_settings(user_id);

-- ============================================
-- ADMIN & MODERATION TABLES
-- ============================================

-- Admin users (hardcoded super admin + delegated admins)
CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('super_admin', 'admin', 'moderator')),
  permissions TEXT DEFAULT '[]',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id)
);

CREATE INDEX idx_admin_users_role ON admin_users(role);

-- Reports
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_type TEXT NOT NULL CHECK(reporter_type IN ('user', 'page')),
  reporter_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK(target_type IN ('user', 'page', 'post', 'comment', 'reel', 'story')),
  target_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('spam', 'abuse', 'nsfw', 'violence', 'impersonation', 'harassment', 'misinformation', 'other')),
  description TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'under_review', 'resolved', 'dismissed')),
  reviewed_by TEXT,
  reviewed_at INTEGER,
  resolution TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (reviewed_by) REFERENCES admin_users(id)
);

CREATE INDEX idx_reports_status ON reports(status);
CREATE INDEX idx_reports_target ON reports(target_type, target_id);
CREATE INDEX idx_reports_created_at ON reports(created_at DESC);

-- Appeals
CREATE TABLE IF NOT EXISTS appeals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  appeal_type TEXT NOT NULL CHECK(appeal_type IN ('content_removal', 'account_ban', 'page_ban')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'under_review', 'approved', 'rejected')),
  reviewed_by TEXT,
  reviewed_at INTEGER,
  resolution TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES admin_users(id)
);

CREATE INDEX idx_appeals_status ON appeals(status);
CREATE INDEX idx_appeals_user ON appeals(user_id);

-- Bans
CREATE TABLE IF NOT EXISTS bans (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK(target_type IN ('user', 'page')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  duration INTEGER,
  expires_at INTEGER,
  permanent BOOLEAN DEFAULT 0,
  banned_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (banned_by) REFERENCES admin_users(id)
);

CREATE INDEX idx_bans_target ON bans(target_type, target_id);
CREATE INDEX idx_bans_expires ON bans(expires_at);

-- Admin actions audit log
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT,
  ip_address TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (admin_id) REFERENCES admin_users(id)
);

CREATE INDEX idx_audit_admin ON admin_audit_logs(admin_id);
CREATE INDEX idx_audit_created_at ON admin_audit_logs(created_at DESC);

-- Admin created content (system posts/reels)
CREATE TABLE IF NOT EXISTS admin_content (
  id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL CHECK(content_type IN ('post', 'reel')),
  content_id TEXT NOT NULL,
  target_regions TEXT DEFAULT '[]',
  target_languages TEXT DEFAULT '[]',
  display_frequency INTEGER DEFAULT 1,
  batch_size INTEGER,
  duration_hours INTEGER,
  active BOOLEAN DEFAULT 1,
  created_by TEXT NOT NULL,
  starts_at INTEGER,
  ends_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (created_by) REFERENCES admin_users(id)
);

CREATE INDEX idx_admin_content_active ON admin_content(active);
CREATE INDEX idx_admin_content_ends_at ON admin_content(ends_at);

-- ============================================
-- i18n TABLES
-- ============================================

-- Missing translation keys (logged by clients)
CREATE TABLE IF NOT EXISTS missing_translation_keys (
  id TEXT PRIMARY KEY,
  locale TEXT NOT NULL,
  key_name TEXT NOT NULL,
  context TEXT,
  reported_count INTEGER DEFAULT 1,
  first_reported INTEGER NOT NULL,
  last_reported INTEGER NOT NULL,
  UNIQUE(locale, key_name)
);

CREATE INDEX idx_missing_trans_locale ON missing_translation_keys(locale);
CREATE INDEX idx_missing_trans_count ON missing_translation_keys(reported_count DESC);

-- ============================================
-- SESSIONS & AUTH TABLES
-- ============================================

-- Refresh tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  device_info TEXT,
  ip_address TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens(expires_at);

-- Active sessions
CREATE TABLE IF NOT EXISTS active_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  device_info TEXT,
  ip_address TEXT,
  last_activity INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user ON active_sessions(user_id);
CREATE INDEX idx_sessions_activity ON active_sessions(last_activity);

-- Email verification codes
CREATE TABLE IF NOT EXISTS email_verification_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_email_verify_email ON email_verification_codes(email);
CREATE INDEX idx_email_verify_expires ON email_verification_codes(expires_at);

-- Password reset tokens
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_password_reset_user ON password_reset_tokens(user_id);
CREATE INDEX idx_password_reset_expires ON password_reset_tokens(expires_at);

-- ============================================
-- MEDIA TABLES
-- ============================================

-- Media uploads
CREATE TABLE IF NOT EXISTS media_uploads (
  id TEXT PRIMARY KEY,
  uploader_type TEXT NOT NULL CHECK(uploader_type IN ('user', 'page')),
  uploader_id TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('image', 'video', 'avatar', 'cover')),
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'ready', 'failed')),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_media_uploader ON media_uploads(uploader_type, uploader_id);
CREATE INDEX idx_media_status ON media_uploads(status);

-- ============================================
-- PUSH NOTIFICATION TABLES
-- ============================================

-- Push subscriptions
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  keys TEXT NOT NULL,
  device_type TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_push_user ON push_subscriptions(user_id);

-- ============================================
-- HASHTAGS TABLE
-- ============================================

-- Hashtags
CREATE TABLE IF NOT EXISTS hashtags (
  id TEXT PRIMARY KEY,
  tag TEXT NOT NULL,
  post_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(tag)
);

CREATE INDEX idx_hashtags_tag ON hashtags(tag);
CREATE INDEX idx_hashtags_count ON hashtags(post_count DESC);

-- Post hashtags (junction table)
CREATE TABLE IF NOT EXISTS post_hashtags (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  hashtag_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(post_id, hashtag_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (hashtag_id) REFERENCES hashtags(id) ON DELETE CASCADE
);

CREATE INDEX idx_post_hashtags_post ON post_hashtags(post_id);
CREATE INDEX idx_post_hashtags_hashtag ON post_hashtags(hashtag_id);

-- ============================================
-- RATE LIMITING TABLES (stored in D1 for persistence)
-- ============================================

-- Rate limit tracking
CREATE TABLE IF NOT EXISTS rate_limits (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  window_start INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(key, endpoint)
);

CREATE INDEX idx_rate_limits_key ON rate_limits(key, endpoint);
CREATE INDEX idx_rate_limits_expires ON rate_limits(expires_at);
