-- ============================================
-- CRITICAL FEED PERFORMANCE INDEXES
-- Matches actual remote database schema exactly
-- ============================================

-- User settings indexes (CONFIRMED: user_id and private_account columns exist)
CREATE INDEX IF NOT EXISTS idx_user_settings_private ON user_settings(user_id, private_account);
CREATE INDEX IF NOT EXISTS idx_user_settings_language ON user_settings(preferred_language);

-- Posts composite indexes for feed queries (CONFIRMED: actor_type, actor_id, created_at, language exist)
CREATE INDEX IF NOT EXISTS idx_posts_actor_created ON posts(actor_type, actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_language_created ON posts(language, created_at DESC);

-- Follow relationship composite index (CONFIRMED: all columns exist)
CREATE INDEX IF NOT EXISTS idx_follows_relationship ON follows(follower_type, follower_id, followee_type, followee_id);

-- Block relationship composite index (CONFIRMED: all columns exist)
CREATE INDEX IF NOT EXISTS idx_blocks_relationship ON blocks(blocker_type, blocker_id, blocked_type, blocked_id);

-- Trending posts indexes (CONFIRMED: language, score, started_trending_at exist)
CREATE INDEX IF NOT EXISTS idx_trending_language ON trending_posts(language, score DESC);
CREATE INDEX IF NOT EXISTS idx_trending_time ON trending_posts(started_trending_at DESC);
CREATE INDEX IF NOT EXISTS idx_trending_feed ON trending_posts(language, score DESC, started_trending_at DESC);

-- Post exposures indexes (CONFIRMED: user_id, post_id, exposed_at, engaged exist)
CREATE INDEX IF NOT EXISTS idx_post_exposures_user_time ON post_exposures(user_id, exposed_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_exposures_engaged ON post_exposures(post_id, engaged);

-- Post suggestion batches indexes (CONFIRMED: status, window_end, post_id, batch_number exist)
CREATE INDEX IF NOT EXISTS idx_batch_status_window ON post_suggestion_batches(status, window_end);
CREATE INDEX IF NOT EXISTS idx_batch_post_number ON post_suggestion_batches(post_id, batch_number);

-- Pages verification index (CONFIRMED: verified column exists)
CREATE INDEX IF NOT EXISTS idx_pages_verified ON pages(verified);

-- Users verification index (CONFIRMED: verified column exists)
CREATE INDEX IF NOT EXISTS idx_users_verified ON users(verified);

-- Notifications unread index (CONFIRMED: user_id, read, created_at exist)
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read, created_at DESC);

-- Stories expiration index (CONFIRMED: expires_at exists)
CREATE INDEX IF NOT EXISTS idx_stories_expires_at ON stories(expires_at);

-- Stories by actor (FIXED: uses actor_id not user_id)
CREATE INDEX IF NOT EXISTS idx_stories_actor_time ON stories(actor_type, actor_id, created_at DESC);

-- Reels by actor (FIXED: uses actor_id not user_id, removed non-existent visibility column)
CREATE INDEX IF NOT EXISTS idx_reels_actor_time ON reels(actor_type, actor_id, created_at DESC);

-- Hashtags indexes (FIXED: uses post_count not usage_count)
CREATE INDEX IF NOT EXISTS idx_hashtags_post_count ON hashtags(post_count DESC);

-- Post hashtags indexes (CONFIRMED: post_id, hashtag_id, created_at exist)
CREATE INDEX IF NOT EXISTS idx_post_hashtags_post ON post_hashtags(post_id);
CREATE INDEX IF NOT EXISTS idx_post_hashtags_tag_time ON post_hashtags(hashtag_id, created_at DESC);

-- Likes composite index (CONFIRMED: actor_type, actor_id, target_type, target_id, created_at exist)
CREATE INDEX IF NOT EXISTS idx_likes_actor_time ON likes(actor_type, actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_likes_target ON likes(target_type, target_id, created_at DESC);

-- Shares composite index (CONFIRMED: actor_type, actor_id, created_at exist)
CREATE INDEX IF NOT EXISTS idx_shares_actor_time ON shares(actor_type, actor_id, created_at DESC);

-- Comments composite index (CONFIRMED: actor_type, actor_id, post_id, created_at exist)
CREATE INDEX IF NOT EXISTS idx_comments_actor_time ON comments(actor_type, actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_post_time ON comments(post_id, created_at DESC);

-- Bookmarks composite index (CONFIRMED: user_id, post_id, created_at exist)
CREATE INDEX IF NOT EXISTS idx_bookmarks_user_time ON bookmarks(user_id, created_at DESC);

-- Messages indexes (CONFIRMED: conversation_id, sender_type, sender_id, created_at exist)
CREATE INDEX IF NOT EXISTS idx_messages_conversation_time ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_type, sender_id);

-- Optimize query planner after index creation
ANALYZE;
