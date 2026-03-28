-- ============================================
-- MIGRATION 0016: SECURITY FIXES
-- Add UNIQUE constraints to prevent race conditions
-- Fix CASCADE deletes for data integrity
-- ============================================

-- IMPORTANT: This migration makes significant schema changes
-- Backup database before running

PRAGMA foreign_keys = OFF;

-- ============================================
-- 1. ADD UNIQUE CONSTRAINTS FOR RACE CONDITION PREVENTION
-- ============================================

-- Likes: Prevent duplicate likes from same actor on same target
-- Drop existing table and recreate with UNIQUE constraint
CREATE TABLE IF NOT EXISTS likes_new (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'page')),
  actor_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK(target_type IN ('post', 'comment', 'reel', 'story')),
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(actor_type, actor_id, target_type, target_id)
);

INSERT INTO likes_new SELECT * FROM likes;
DROP TABLE likes;
ALTER TABLE likes_new RENAME TO likes;

CREATE INDEX idx_likes_actor ON likes(actor_type, actor_id);
CREATE INDEX idx_likes_target ON likes(target_type, target_id);
CREATE INDEX idx_likes_created_at ON likes(created_at DESC);

-- Follows: Prevent duplicate follows from same follower to same followee
CREATE TABLE IF NOT EXISTS follows_new (
  id TEXT PRIMARY KEY,
  follower_type TEXT NOT NULL CHECK(follower_type IN ('user', 'page')),
  follower_id TEXT NOT NULL,
  followee_type TEXT NOT NULL CHECK(followee_type IN ('user', 'page')),
  followee_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(follower_type, follower_id, followee_type, followee_id)
);

INSERT INTO follows_new SELECT * FROM follows;
DROP TABLE follows;
ALTER TABLE follows_new RENAME TO follows;

CREATE INDEX idx_follows_follower ON follows(follower_type, follower_id);
CREATE INDEX idx_follows_followee ON follows(followee_type, followee_id);
CREATE INDEX idx_follows_created_at ON follows(created_at DESC);

-- Bookmarks: Prevent duplicate bookmarks
CREATE TABLE IF NOT EXISTS bookmarks_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, post_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

INSERT INTO bookmarks_new SELECT * FROM bookmarks;
DROP TABLE bookmarks;
ALTER TABLE bookmarks_new RENAME TO bookmarks;

CREATE INDEX idx_bookmarks_user ON bookmarks(user_id);
CREATE INDEX idx_bookmarks_post ON bookmarks(post_id);
CREATE INDEX idx_bookmarks_created_at ON bookmarks(created_at DESC);

-- Shares: Prevent duplicate shares (same actor sharing same post multiple times)
CREATE TABLE IF NOT EXISTS shares_new (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'page')),
  actor_id TEXT NOT NULL,
  original_post_id TEXT NOT NULL,
  comment TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(actor_type, actor_id, original_post_id),
  FOREIGN KEY (original_post_id) REFERENCES posts(id) ON DELETE CASCADE
);

INSERT INTO shares_new SELECT * FROM shares;
DROP TABLE shares;
ALTER TABLE shares_new RENAME TO shares;

CREATE INDEX idx_shares_actor ON shares(actor_type, actor_id);
CREATE INDEX idx_shares_post ON shares(original_post_id);
CREATE INDEX idx_shares_created_at ON shares(created_at DESC);

-- ============================================
-- 2. FIX CASCADE DELETES FOR DATA INTEGRITY
-- ============================================

-- Posts: CASCADE delete when user is deleted
CREATE TABLE IF NOT EXISTS posts_new (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'page')),
  actor_id TEXT NOT NULL,
  content TEXT,
  media_type TEXT,
  media_urls TEXT,
  language TEXT DEFAULT 'en',
  is_sensitive BOOLEAN DEFAULT 0,
  likes_count INTEGER DEFAULT 0,
  comments_count INTEGER DEFAULT 0,
  shares_count INTEGER DEFAULT 0,
  bookmarks_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO posts_new SELECT * FROM posts;
DROP TABLE posts;
ALTER TABLE posts_new RENAME TO posts;

CREATE INDEX idx_posts_actor ON posts(actor_type, actor_id);
CREATE INDEX idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX idx_posts_language ON posts(language);
CREATE INDEX idx_posts_sensitive ON posts(is_sensitive);

-- Comments: Ensure CASCADE on user deletion
CREATE TABLE IF NOT EXISTS comments_new (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  parent_id TEXT,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'page')),
  actor_id TEXT NOT NULL,
  content TEXT NOT NULL,
  likes_count INTEGER DEFAULT 0,
  replies_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO comments_new SELECT * FROM comments;
DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;

CREATE INDEX idx_comments_post ON comments(post_id);
CREATE INDEX idx_comments_parent ON comments(parent_id);
CREATE INDEX idx_comments_actor ON comments(actor_type, actor_id);
CREATE INDEX idx_comments_created_at ON comments(created_at DESC);

-- Notifications: CASCADE delete when user or target is deleted
CREATE TABLE IF NOT EXISTS notifications_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_type TEXT,
  actor_id TEXT,
  target_type TEXT,
  target_id TEXT,
  content TEXT NOT NULL,
  read BOOLEAN DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO notifications_new SELECT * FROM notifications;
DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_read ON notifications(read);
CREATE INDEX idx_notifications_created_at ON notifications(created_at DESC);

-- Reports: CASCADE delete when reporter is deleted
CREATE TABLE IF NOT EXISTS reports_new (
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
  FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES admin_users(id)
);

INSERT INTO reports_new SELECT * FROM reports;
DROP TABLE reports;
ALTER TABLE reports_new RENAME TO reports;

CREATE INDEX idx_reports_reporter ON reports(reporter_id);
CREATE INDEX idx_reports_status ON reports(status);
CREATE INDEX idx_reports_created_at ON reports(created_at DESC);

-- ============================================
-- 3. ADD MISSING INDEXES FOR PERFORMANCE
-- ============================================

-- Ad analytics: Improve query performance
CREATE INDEX IF NOT EXISTS idx_ad_analytics_ad_date ON ad_analytics_daily(ad_id, date DESC);

-- User ad frequency: Improve query performance
CREATE INDEX IF NOT EXISTS idx_user_ad_freq_user ON user_ad_frequency(user_id, ad_id);

-- Notifications: Improve unread query performance
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read, created_at DESC);

PRAGMA foreign_keys = ON;

-- ============================================
-- MIGRATION COMPLETE
-- ============================================
-- Summary of changes:
-- 1. Added UNIQUE constraints on likes, follows, bookmarks, shares
-- 2. Added CASCADE DELETE on posts, comments, notifications, reports
-- 3. Added performance indexes for ad analytics and notifications
--
-- Security improvements:
-- - Prevents race condition double-likes/follows
-- - Ensures proper data cleanup on user deletion (GDPR compliance)
-- - Improves query performance on high-traffic endpoints
-- ============================================
