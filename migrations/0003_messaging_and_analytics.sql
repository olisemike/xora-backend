-- ============================================
-- MIGRATION 3: Messaging & Analytics Tables
-- ============================================

-- Message reactions table
CREATE TABLE IF NOT EXISTS message_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_message_reactions_message ON message_reactions(message_id);
CREATE INDEX idx_message_reactions_user ON message_reactions(user_id);

-- Online status tracking (for real-time presence)
CREATE TABLE IF NOT EXISTS user_online_status (
  user_id TEXT PRIMARY KEY,
  is_online INTEGER DEFAULT 0,
  last_seen INTEGER,
  updated_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_online_status_online ON user_online_status(is_online, last_seen);

-- ============================================
-- Analytics Tables
-- ============================================

-- Daily metrics snapshot
CREATE TABLE IF NOT EXISTS daily_metrics (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  new_users INTEGER DEFAULT 0,
  active_users INTEGER DEFAULT 0,
  posts_created INTEGER DEFAULT 0,
  reels_created INTEGER DEFAULT 0,
  messages_sent INTEGER DEFAULT 0,
  total_engagement INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_daily_metrics_date ON daily_metrics(date);

-- Event tracking for analytics
CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  user_id TEXT,
  target_type TEXT,
  target_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_analytics_events_type ON analytics_events(event_type, created_at);
CREATE INDEX idx_analytics_events_user ON analytics_events(user_id, created_at);

-- Phone verification table
CREATE TABLE IF NOT EXISTS phone_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_phone_verifications_user ON phone_verifications(user_id);
CREATE INDEX idx_phone_verifications_code ON phone_verifications(code, expires_at);
