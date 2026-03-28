// ============================================
// ACTION BROADCASTER UTILITY
// Broadcasts real-time updates to connected clients with sharding
// ============================================

/**
 * Broadcasts an action to specific users or feeds
 * Sends updates via NotificationHub WebSocket with automatic sharding
 */
export class ActionBroadcaster {
  constructor(env) {
    if (!env) {
      throw new Error('ActionBroadcaster requires env');
    }
    this.env = env;
    this.LARGE_FOLLOWER_THRESHOLD = 1000; // Threshold for large follower counts
    this.BATCH_SIZE = 500; // Batch size for large broadcasts
    this.NOTIFICATION_HUB_SHARDS = 16; // Number of NotificationHub shards for scaling
  }

  /**
   * Hash a key for consistent sharding
   * @private
   */
  _hashKey(key) {
    if (!key) return 0;
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) {
      hash = ((hash << 5) - hash) + key.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  /**
   * Get shard ID for a user (for consistent routing)
   * @private
   */
  _getShardForUser(userId) {
    return this._hashKey(userId) % this.NOTIFICATION_HUB_SHARDS;
  }

  /**
   * Get sharded NotificationHub stub
   * @private
   */
  _getShardedStub(userId) {
    if (!this.env.NOTIFICATION_HUB) {
      throw new Error('NOTIFICATION_HUB not configured');
    }
    const shard = this._getShardForUser(userId);
    const shardName = `notify-${shard}`;
    const id = this.env.NOTIFICATION_HUB.idFromName(shardName);
    return this.env.NOTIFICATION_HUB.get(id);
  }

  /**
   * Broadcast to a specific user - routed to correct shard
   */
  async broadcastToUser(userId, action) {
    if (!userId || !action) return;

    try {
      // Check if NOTIFICATION_HUB is available
      if (!this.env.NOTIFICATION_HUB) {
        console.warn('NOTIFICATION_HUB not configured, skipping broadcast');
        return;
      }

      // Get sharded stub based on userId for consistent routing
      const stub = this._getShardedStub(userId);

      const response = await stub.fetch(new Request('https://hub/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId,
          notification: action
        })
      }));

      if (!response.ok) {
        console.error(`Failed to broadcast to user ${userId}:`, response.status);
      }
    } catch (error) {
      console.error('ActionBroadcaster error:', error);
    }
  }

  /**
   * Broadcast to multiple users with automatic sharding for scale
   * Groups users by shard and sends in parallel to distribute load
   */
  async broadcastToUsers(userIds, action) {
    if (!userIds || userIds.length === 0 || !action) return;

    try {
      // Check if NOTIFICATION_HUB is available
      if (!this.env.NOTIFICATION_HUB) {
        console.warn('NOTIFICATION_HUB not configured, skipping broadcast');
        return;
      }

      // Always group users by their designated shard to ensure correct delivery.
      const shardedGroups = new Map();
      for (const userId of userIds) {
        const shard = this._getShardForUser(userId);
        if (!shardedGroups.has(shard)) {
          shardedGroups.set(shard, []);
        }
        shardedGroups.get(shard).push(userId);
      }

      // Send to each shard in parallel
      const promises = Array.from(shardedGroups.entries()).map(([shard, shardUserIds]) =>
        this._broadcastToShard(shard, shardUserIds, action).catch(error => {
          console.error(`Shard ${shard} broadcast failed:`, error);
          return null;
        })
      );

      const results = await Promise.allSettled(promises);
      const failures = results.filter(r => r.status === 'rejected').length;

      if (failures > 0) {
        console.warn(`${failures}/${Array.from(shardedGroups.keys()).length} shards failed to broadcast`);
      }

      if (userIds.length > this.LARGE_FOLLOWER_THRESHOLD) {
        console.info(`Large broadcast: ${userIds.length} users across ${shardedGroups.size} shards`);
      }
    } catch (error) {
      console.error('ActionBroadcaster error:', error);
    }
  }

  /**
   * Send broadcast to a specific shard
   * @private
   */
  async _broadcastToShard(shard, userIds, action) {
    const shardName = `notify-${shard}`;
    const id = this.env.NOTIFICATION_HUB.idFromName(shardName);
    const stub = this.env.NOTIFICATION_HUB.get(id);

    const response = await stub.fetch(new Request('https://hub/notify-multiple', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userIds,
        notification: action
      })
    }));

    if (!response.ok) {
      console.error(`Failed to broadcast to shard ${shard}:`, response.status);
    }
  }

  /**
   * Broadcast a post action (create, update, delete)
   */
  async broadcastPostAction(action, postData, affectedUserIds = []) {
    const payload = {
      type: 'post_action',
      action, // 'created', 'updated', 'deleted', 'liked', 'unliked', 'shared'
      post: postData,
      timestamp: new Date().toISOString()
    };

    if (affectedUserIds.length > 0) {
      await this.broadcastToUsers(affectedUserIds, payload);
    }
  }

  /**
   * Broadcast a comment action
   */
  async broadcastCommentAction(action, commentData, postOwnerId, affectedUserIds = []) {
    const payload = {
      type: 'comment_action',
      action, // 'created', 'updated', 'deleted'
      comment: commentData,
      postOwnerId,
      timestamp: new Date().toISOString()
    };

    // Always notify post owner
    const recipients = new Set(affectedUserIds);
    if (postOwnerId) recipients.add(postOwnerId);

    if (recipients.size > 0) {
      await this.broadcastToUsers(Array.from(recipients), payload);
    }
  }

  /**
   * Broadcast a like action
   */
  async broadcastLikeAction(action, likeData, contentOwnerId, affectedUserIds = []) {
    const payload = {
      type: 'like_action',
      action, // 'liked', 'unliked'
      like: likeData,
      contentOwnerId,
      timestamp: new Date().toISOString()
    };

    const recipients = new Set(affectedUserIds);
    if (contentOwnerId) recipients.add(contentOwnerId);

    if (recipients.size > 0) {
      await this.broadcastToUsers(Array.from(recipients), payload);
    }
  }

  /**
   * Broadcast a bookmark action
   */
  async broadcastBookmarkAction(action, bookmarkData, userId) {
    const payload = {
      type: 'bookmark_action',
      action, // 'bookmarked', 'unbookmarked'
      bookmark: bookmarkData,
      timestamp: new Date().toISOString()
    };

    await this.broadcastToUser(userId, payload);
  }

  /**
   * Broadcast a share action
   */
  async broadcastShareAction(action, shareData, postOwnerId, affectedUserIds = []) {
    const payload = {
      type: 'share_action',
      action, // 'shared', 'unshared'
      share: shareData,
      postOwnerId,
      timestamp: new Date().toISOString()
    };

    const recipients = new Set(affectedUserIds);
    if (postOwnerId) recipients.add(postOwnerId);

    if (recipients.size > 0) {
      await this.broadcastToUsers(Array.from(recipients), payload);
    }
  }

  /**
   * Broadcast a reel action
   */
  async broadcastReelAction(action, reelData, reelOwnerId, affectedUserIds = []) {
    const payload = {
      type: 'reel_action',
      action, // 'created', 'updated', 'deleted', 'liked', 'unliked'
      reel: reelData,
      reelOwnerId,
      timestamp: new Date().toISOString()
    };

    const recipients = new Set(affectedUserIds);
    if (reelOwnerId) recipients.add(reelOwnerId);

    if (recipients.size > 0) {
      await this.broadcastToUsers(Array.from(recipients), payload);
    }
  }

  /**
   * Broadcast a story action
   */
  async broadcastStoryAction(action, storyData, storyOwnerId, affectedUserIds = []) {
    const payload = {
      type: 'story_action',
      action, // 'created', 'viewed', 'deleted'
      story: storyData,
      storyOwnerId,
      timestamp: new Date().toISOString()
    };

    const recipients = new Set(affectedUserIds);
    if (storyOwnerId) recipients.add(storyOwnerId);

    if (recipients.size > 0) {
      await this.broadcastToUsers(Array.from(recipients), payload);
    }
  }

  /**
   * Broadcast a follow action
   */
  async broadcastFollowAction(action, followData, targetUserId) {
    const payload = {
      type: 'follow_action',
      action, // 'followed', 'unfollowed'
      follow: followData,
      timestamp: new Date().toISOString()
    };

    await this.broadcastToUser(targetUserId, payload);
  }

  /**
   * Broadcast a user profile update
   */
  async broadcastUserProfileUpdate(userId, updatedFields, followerIds = []) {
    const payload = {
      type: 'profile_update',
      userId,
      updatedFields,
      timestamp: new Date().toISOString()
    };

    if (followerIds.length > 0) {
      await this.broadcastToUsers(followerIds, payload);
    }
  }

  /**
   * Broadcast a feed refresh signal (for specific feed types)
   */
  async broadcastFeedRefresh(userId, feedType = 'home') {
    const payload = {
      type: 'feed_refresh',
      feedType, // 'home', 'explore', 'hashtag', 'profile', etc.
      timestamp: new Date().toISOString()
    };

    await this.broadcastToUser(userId, payload);
  }

  /**
   * Broadcast engagement update to ALL connected users
   * Used for real-time likes/comments/shares count updates in feeds
   */
  async broadcastEngagementUpdate(postId, engagementType, counts) {
    try {
      if (!this.env.NOTIFICATION_HUB) {
        console.warn('NOTIFICATION_HUB not configured, skipping global broadcast');
        return;
      }

      const payload = {
        type: 'engagement_update',
        engagementType, // 'like', 'unlike', 'comment', 'share'
        postId,
        counts, // { likesCount, commentsCount, sharesCount }
        timestamp: new Date().toISOString()
      };

      const shardRequests = [];
      for (let shard = 0; shard < this.NOTIFICATION_HUB_SHARDS; shard += 1) {
        const id = this.env.NOTIFICATION_HUB.idFromName(`notify-${shard}`);
        const stub = this.env.NOTIFICATION_HUB.get(id);
        shardRequests.push(
          stub.fetch(new Request('https://hub/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }))
        );
      }

      await Promise.allSettled(shardRequests);
    } catch (error) {
      console.error('Global engagement broadcast error:', error);
    }
  }
}
