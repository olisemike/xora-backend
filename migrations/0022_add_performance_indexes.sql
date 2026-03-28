-- Migration: Add missing performance indexes
-- Description: Adds indexes for user feeds, follows, likes, and comments to resolve N+1 queries

-- Posts by user with timestamp (for user feed queries)
CREATE INDEX IF NOT EXISTS idx_posts_user_created ON posts(actor_type, actor_id, created_at DESC);

-- Follow checks (follower, followee lookups)
CREATE INDEX IF NOT EXISTS idx_follows_follower_followee ON follows(follower_type, follower_id, followee_type, followee_id);
CREATE INDEX IF NOT EXISTS idx_follows_followee_follower ON follows(followee_type, followee_id, follower_type, follower_id);

-- Like lookups (target_type changes, user combinations)
-- Likes use target_type (post, comment, reel) instead of post_id
CREATE INDEX IF NOT EXISTS idx_likes_target_user ON likes(target_type, target_id, actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_likes_target ON likes(target_type, target_id);

-- Comment feeds (post, timestamp for pagination)
CREATE INDEX IF NOT EXISTS idx_comments_post_created ON comments(post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_user_created ON comments(actor_type, actor_id, created_at DESC);

-- Block checks (bi-directional blocks)
CREATE INDEX IF NOT EXISTS idx_blocks_blocker_blocked ON blocks(blocker_type, blocker_id, blocked_type, blocked_id);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked_blocker ON blocks(blocked_type, blocked_id, blocker_type, blocker_id);

-- Share/repost lookups
CREATE INDEX IF NOT EXISTS idx_shares_post_user ON shares(original_post_id, actor_type, actor_id);

-- Engagement aggregation queries (faster stats)
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_shares_post ON shares(original_post_id);

-- Bookmark lookups (user_id, not actor_type/actor_id in bookmarks)
CREATE INDEX IF NOT EXISTS idx_bookmarks_user_created ON bookmarks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookmarks_post ON bookmarks(post_id);
