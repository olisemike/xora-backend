// ============================================
// REAL-TIME NOTIFICATION SERVICE
// Sends real-time notifications via NotificationHub
// ============================================

export class RealTimeNotificationService {
  constructor(env) {
    this.env = env;
    this.NOTIFICATION_HUB_SHARDS = 16;
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
   * Get shard ID for a user
   * @private
   */
  _getShardForUser(userId) {
    return this._hashKey(userId) % this.NOTIFICATION_HUB_SHARDS;
  }

  /**
   * Send real-time notification to a single user
   */
  async notifyUser(userId, notification) {
    try {
      if (!this.env.NOTIFICATION_HUB) {
        console.warn('NOTIFICATION_HUB not configured');
        return false;
      }

      const shard = this._getShardForUser(userId);
      const hubId = this.env.NOTIFICATION_HUB.idFromName(`notify-${shard}`);
      const hub = this.env.NOTIFICATION_HUB.get(hubId);

      const response = await hub.fetch('http://internal/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          notification: {
            title: notification.title,
            body: notification.body,
            data: notification.data || {},
            action: notification.action
          }
        })
      });

      const result = await response.json();
      return result.success && result.delivered > 0;
    } catch (error) {
      console.error('Error sending real-time notification:', error);
      return false;
    }
  }

  /**
   * Send real-time notification to multiple users
   */
  async notifyUsers(userIds, notification) {
    try {
      if (!this.env.NOTIFICATION_HUB) {
        console.warn('NOTIFICATION_HUB not configured');
        return { success: false, delivered: 0 };
      }

      // Group users by shard for distributed delivery
      const shardedGroups = new Map();
      for (const userId of userIds) {
        const shard = this._getShardForUser(userId);
        if (!shardedGroups.has(shard)) {
          shardedGroups.set(shard, []);
        }
        shardedGroups.get(shard).push(userId);
      }

      // Send to each shard in parallel
      const promises = Array.from(shardedGroups.entries()).map(([shard, shardUserIds]) => {
        const hubId = this.env.NOTIFICATION_HUB.idFromName(`notify-${shard}`);
        const hub = this.env.NOTIFICATION_HUB.get(hubId);

        return hub.fetch('http://internal/notify-multiple', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userIds: shardUserIds,
            notification: {
              title: notification.title,
              body: notification.body,
              data: notification.data || {},
              action: notification.action
            }
          })
        });
      });

      const results = await Promise.allSettled(promises);
      let totalDelivered = 0;
      let totalRequested = userIds.length;

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const json = await result.value.json();
          totalDelivered += json.totalDelivered || 0;
        }
      }

      return {
        success: results.every(r => r.status === 'fulfilled'),
        delivered: totalDelivered,
        total: totalRequested
      };
    } catch (error) {
      console.error('Error broadcasting real-time notifications:', error);
      return { success: false, delivered: 0 };
    }
  }

  /**
   * Notify user received a like
   */
  async notifyLike(userId, postId, likerName, likerId) {
    return await this.notifyUser(userId, {
      title: '👍 New Like',
      body: `${likerName} liked your post`,
      action: 'like',
      data: {
        postId,
        likerId,
        likerName,
        type: 'like'
      }
    });
  }

  /**
   * Notify user received a comment
   */
  async notifyComment(userId, postId, commenterName, commenterId, commentText) {
    return await this.notifyUser(userId, {
      title: '💬 New Comment',
      body: `${commenterName} commented: ${commentText.substring(0, 50)}...`,
      action: 'comment',
      data: {
        postId,
        commenterId,
        commenterName,
        commentText,
        type: 'comment'
      }
    });
  }

  /**
   * Notify user received a new follower
   */
  async notifyFollow(userId, followerName, followerId) {
    return await this.notifyUser(userId, {
      title: '👤 New Follower',
      body: `${followerName} started following you`,
      action: 'follow',
      data: {
        followerId,
        followerName,
        type: 'follow'
      }
    });
  }

  /**
   * Notify users mentioned in a post
   */
  async notifyMentions(userIds, mentionerName, mentionerId, postId) {
    return await this.notifyUsers(userIds, {
      title: '📌 You were mentioned',
      body: `${mentionerName} mentioned you in a post`,
      action: 'mention',
      data: {
        postId,
        mentionerId,
        mentionerName,
        type: 'mention'
      }
    });
  }

  /**
   * Notify user of a reply to their comment
   */
  async notifyCommentReply(userId, postId, replierName, replierId, replyText) {
    return await this.notifyUser(userId, {
      title: '🔄 New Reply',
      body: `${replierName} replied: ${replyText.substring(0, 50)}...`,
      action: 'comment_reply',
      data: {
        postId,
        replierId,
        replierName,
        replyText,
        type: 'comment_reply'
      }
    });
  }

  /**
   * Notify user of a shared post
   */
  async notifyShare(userId, postId, sharedByName, sharedById) {
    return await this.notifyUser(userId, {
      title: '🔗 Post Shared',
      body: `${sharedByName} shared your post`,
      action: 'share',
      data: {
        postId,
        sharedById,
        sharedByName,
        type: 'share'
      }
    });
  }

  /**
   * Notify followers of new post
   */
  async notifyNewPost(followerIds, posterName, posterId, postId) {
    return await this.notifyUsers(followerIds, {
      title: '📝 New Post',
      body: `${posterName} posted something new`,
      action: 'new_post',
      data: {
        postId,
        posterId,
        posterName,
        type: 'new_post'
      }
    });
  }

  /**
   * Notify followers of new story
   */
  async notifyNewStory(followerIds, posterName, posterId, storyId) {
    return await this.notifyUsers(followerIds, {
      title: '📸 New Story',
      body: `${posterName} posted a new story`,
      action: 'new_story',
      data: {
        storyId,
        posterId,
        posterName,
        type: 'new_story'
      }
    });
  }

  /**
   * Notify followers of new reel
   */
  async notifyNewReel(followerIds, creatorName, creatorId, reelId) {
    return await this.notifyUsers(followerIds, {
      title: '🎬 New Reel',
      body: `${creatorName} posted a new reel`,
      action: 'new_reel',
      data: {
        reelId,
        creatorId,
        creatorName,
        type: 'new_reel'
      }
    });
  }

  /**
   * Check if user is connected
   */
  async isUserOnline(userId) {
    try {
      if (!this.env.NOTIFICATION_HUB) {
        return false;
      }

      const shard = this._getShardForUser(userId);
      const hubId = this.env.NOTIFICATION_HUB.idFromName(`notify-${shard}`);
      const hub = this.env.NOTIFICATION_HUB.get(hubId);

      const response = await hub.fetch('http://internal/connected', {
        method: 'GET'
      });

      const result = await response.json();
      return result.connectedUsers.some(u => u.userId === userId);
    } catch (error) {
      console.error('Error checking online status:', error);
      return false;
    }
  }
}

export function getRealTimeNotificationService(env) {
  return new RealTimeNotificationService(env);
}
