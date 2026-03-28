-- ============================================
-- XORA SOCIAL DATABASE SCHEMA
-- Migration 0001: Initial Schema
-- ============================================

-- Enable foreign keys
PRAGMA foreign_keys = ON;

-- ============================================
-- CORE USER & IDENTITY TABLES
-- ============================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  bio TEXT,
  website TEXT,
  location TEXT,
  date_of_birth TEXT,
  gender TEXT,
  avatar_url TEXT,
  cover_url TEXT,
  verified BOOLEAN DEFAULT 0,
  email_verified BOOLEAN DEFAULT 0,
  two_factor_enabled BOOLEAN DEFAULT 0,
  two_factor_secret TEXT,
  preferred_language TEXT DEFAULT 'en',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_created_at ON users(created_at);

-- Pages table (mini profiles, no public owner)
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  bio TEXT,
  avatar_url TEXT,
  cover_url TEXT,
  verified BOOLEAN DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_pages_owner ON pages(owner_id);
CREATE INDEX idx_pages_created_at ON pages(created_at);

-- ============================================
-- CONTENT TABLES
-- ============================================

-- Posts table
CREATE TABLE IF NOT EXISTS posts (
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
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_posts_actor ON posts(actor_type, actor_id);
CREATE INDEX idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX idx_posts_language ON posts(language);
CREATE INDEX idx_posts_sensitive ON posts(is_sensitive);

-- Shares table
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'page')),
  actor_id TEXT NOT NULL,
  original_post_id TEXT NOT NULL,
  comment TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (original_post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE INDEX idx_shares_actor ON shares(actor_type, actor_id);
CREATE INDEX idx_shares_post ON shares(original_post_id);
CREATE INDEX idx_shares_created_at ON shares(created_at DESC);

-- Comments table
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'page')),
  actor_id TEXT NOT NULL,
  content TEXT NOT NULL,
  parent_id TEXT,
  likes_count INTEGER DEFAULT 0,
  replies_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE
);

CREATE INDEX idx_comments_post ON comments(post_id);
CREATE INDEX idx_comments_actor ON comments(actor_type, actor_id);
CREATE INDEX idx_comments_parent ON comments(parent_id);
CREATE INDEX idx_comments_created_at ON comments(created_at DESC);

-- Reels table
CREATE TABLE IF NOT EXISTS reels (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'page')),
  actor_id TEXT NOT NULL,
  video_url TEXT NOT NULL,
  thumbnail_url TEXT,
  caption TEXT,
  language TEXT DEFAULT 'en',
  is_sensitive BOOLEAN DEFAULT 0,
  likes_count INTEGER DEFAULT 0,
  comments_count INTEGER DEFAULT 0,
  views_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_reels_actor ON reels(actor_type, actor_id);
CREATE INDEX idx_reels_created_at ON reels(created_at DESC);
CREATE INDEX idx_reels_language ON reels(language);
CREATE INDEX idx_reels_sensitive ON reels(is_sensitive);

-- Stories table (24-hour ephemeral)
CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'page')),
  actor_id TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('image', 'video')),
  media_url TEXT NOT NULL,
  views_count INTEGER DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_stories_actor ON stories(actor_type, actor_id);
CREATE INDEX idx_stories_expires ON stories(expires_at);
CREATE INDEX idx_stories_created_at ON stories(created_at DESC);

-- ============================================
-- ENGAGEMENT TABLES
-- ============================================

-- Likes table (polymorphic)
CREATE TABLE IF NOT EXISTS likes (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'page')),
  actor_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK(target_type IN ('post', 'comment', 'reel')),
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(actor_type, actor_id, target_type, target_id)
);

CREATE INDEX idx_likes_actor ON likes(actor_type, actor_id);
CREATE INDEX idx_likes_target ON likes(target_type, target_id);
CREATE INDEX idx_likes_created_at ON likes(created_at DESC);

-- Bookmarks table
CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, post_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE INDEX idx_bookmarks_user ON bookmarks(user_id);
CREATE INDEX idx_bookmarks_post ON bookmarks(post_id);
CREATE INDEX idx_bookmarks_created_at ON bookmarks(created_at DESC);

-- Story views table
CREATE TABLE IF NOT EXISTS story_views (
  id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL,
  viewer_type TEXT NOT NULL CHECK(viewer_type IN ('user', 'page')),
  viewer_id TEXT NOT NULL,
  viewed_at INTEGER NOT NULL,
  UNIQUE(story_id, viewer_type, viewer_id),
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

CREATE INDEX idx_story_views_story ON story_views(story_id);
CREATE INDEX idx_story_views_viewer ON story_views(viewer_type, viewer_id);

-- Reel views table
CREATE TABLE IF NOT EXISTS reel_views (
  id TEXT PRIMARY KEY,
  reel_id TEXT NOT NULL,
  viewer_type TEXT NOT NULL CHECK(viewer_type IN ('user', 'page')),
  viewer_id TEXT NOT NULL,
  viewed_at INTEGER NOT NULL,
  UNIQUE(reel_id, viewer_type, viewer_id),
  FOREIGN KEY (reel_id) REFERENCES reels(id) ON DELETE CASCADE
);

CREATE INDEX idx_reel_views_reel ON reel_views(reel_id);
CREATE INDEX idx_reel_views_viewer ON reel_views(viewer_type, viewer_id);

-- ============================================
-- SOCIAL GRAPH TABLES
-- ============================================

-- Follows table (user → user, user → page)
CREATE TABLE IF NOT EXISTS follows (
  id TEXT PRIMARY KEY,
  follower_type TEXT NOT NULL CHECK(follower_type IN ('user', 'page')),
  follower_id TEXT NOT NULL,
  followee_type TEXT NOT NULL CHECK(followee_type IN ('user', 'page')),
  followee_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(follower_type, follower_id, followee_type, followee_id)
);

CREATE INDEX idx_follows_follower ON follows(follower_type, follower_id);
CREATE INDEX idx_follows_followee ON follows(followee_type, followee_id);
CREATE INDEX idx_follows_created_at ON follows(created_at DESC);

-- Blocks table
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  blocker_type TEXT NOT NULL CHECK(blocker_type IN ('user', 'page')),
  blocker_id TEXT NOT NULL,
  blocked_type TEXT NOT NULL CHECK(blocked_type IN ('user', 'page')),
  blocked_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(blocker_type, blocker_id, blocked_type, blocked_id)
);

CREATE INDEX idx_blocks_blocker ON blocks(blocker_type, blocker_id);
CREATE INDEX idx_blocks_blocked ON blocks(blocked_type, blocked_id);

-- Mutes table (soft block - hide content but allow following)
CREATE TABLE IF NOT EXISTS mutes (
  id TEXT PRIMARY KEY,
  muter_type TEXT NOT NULL CHECK(muter_type IN ('user', 'page')),
  muter_id TEXT NOT NULL,
  muted_type TEXT NOT NULL CHECK(muted_type IN ('user', 'page')),
  muted_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(muter_type, muter_id, muted_type, muted_id)
);

CREATE INDEX idx_mutes_muter ON mutes(muter_type, muter_id);
CREATE INDEX idx_mutes_muted ON mutes(muted_type, muted_id);

-- ============================================
-- MESSAGING TABLES
-- ============================================

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  is_group BOOLEAN DEFAULT 0,
  name TEXT,
  avatar_url TEXT,
  last_message_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);

-- Conversation members
CREATE TABLE IF NOT EXISTS conversation_members (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  member_type TEXT NOT NULL CHECK(member_type IN ('user', 'page')),
  member_id TEXT NOT NULL,
  role TEXT DEFAULT 'member' CHECK(role IN ('admin', 'member')),
  joined_at INTEGER NOT NULL,
  last_read_at INTEGER,
  UNIQUE(conversation_id, member_type, member_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX idx_conv_members_conversation ON conversation_members(conversation_id);
CREATE INDEX idx_conv_members_member ON conversation_members(member_type, member_id);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_type TEXT NOT NULL CHECK(sender_type IN ('user', 'page')),
  sender_id TEXT NOT NULL,
  content TEXT,
  media_url TEXT,
  media_type TEXT,
  read_by TEXT DEFAULT '[]',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_sender ON messages(sender_type, sender_id);
CREATE INDEX idx_messages_created_at ON messages(created_at DESC);

-- ============================================
-- NOTIFICATIONS TABLE
-- ============================================

-- Notifications table
CREATE TABLE IF NOT EXISTS notifications (
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

CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_read ON notifications(read);
CREATE INDEX idx_notifications_created_at ON notifications(created_at DESC);
