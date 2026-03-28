// ============================================
// PUSH NOTIFICATIONS SERVICE
// Web Push API integration
// ============================================

import { generateId, now } from '../utils/helpers.js';

export class PushNotificationService {
  constructor(db, env) {
    this.db = db;
    this.env = env;
    this.EXPO_BATCH_SIZE = 100;
    this.EXPO_MAX_RETRIES = 3;
    this.expoRetryQueue = [];
    this.EXPO_RETRY_INDEX_KEY = 'push:expo:retry:index';
    this.EXPO_RETRY_KEY_PREFIX = 'push:expo:retry:';
    this.EXPO_RETRY_QUEUE_LIMIT = 1000;
  }

  _createTraceId(prefix = 'push') {
    return `${prefix}_${generateId('trace')}`;
  }

  async _deleteExpoToken(token) {
    if (!token) return;
    try {
      await this.db
        .prepare('DELETE FROM expo_push_tokens WHERE token = ?')
        .bind(token)
        .run();
    } catch (error) {
      console.error('Failed to delete Expo token:', error);
    }
  }

  _hasPersistentRetryStore() {
    return Boolean(this.env?.CACHE && typeof this.env.CACHE.get === 'function' && typeof this.env.CACHE.put === 'function');
  }

  async _loadRetryIndex() {
    if (!this._hasPersistentRetryStore()) return [];
    try {
      const raw = await this.env.CACHE.get(this.EXPO_RETRY_INDEX_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error('Failed to load Expo retry index:', error);
      return [];
    }
  }

  async _saveRetryIndex(index) {
    if (!this._hasPersistentRetryStore()) return;
    try {
      await this.env.CACHE.put(this.EXPO_RETRY_INDEX_KEY, JSON.stringify(index));
    } catch (error) {
      console.error('Failed to save Expo retry index:', error);
    }
  }

  async _persistRetryEntry(entry) {
    if (!this._hasPersistentRetryStore()) return null;

    const id = generateId('xretry');
    const key = `${this.EXPO_RETRY_KEY_PREFIX}${id}`;

    try {
      await this.env.CACHE.put(key, JSON.stringify({ ...entry, id }));
      const index = await this._loadRetryIndex();
      index.push(id);

      if (index.length > this.EXPO_RETRY_QUEUE_LIMIT) {
        const overflow = index.splice(0, index.length - this.EXPO_RETRY_QUEUE_LIMIT);
        await Promise.allSettled(
          overflow.map((staleId) => this.env.CACHE.delete(`${this.EXPO_RETRY_KEY_PREFIX}${staleId}`))
        );
      }

      await this._saveRetryIndex(index);
      return id;
    } catch (error) {
      console.error('Failed to persist Expo retry entry:', error);
      return null;
    }
  }

  async _updatePersistentRetryEntry(id, entry) {
    if (!this._hasPersistentRetryStore() || !id) return;
    try {
      await this.env.CACHE.put(`${this.EXPO_RETRY_KEY_PREFIX}${id}`, JSON.stringify({ ...entry, id }));
    } catch (error) {
      console.error('Failed to update Expo retry entry:', error);
    }
  }

  async _removePersistentRetryEntry(id) {
    if (!this._hasPersistentRetryStore() || !id) return;
    try {
      await this.env.CACHE.delete(`${this.EXPO_RETRY_KEY_PREFIX}${id}`);
      const index = await this._loadRetryIndex();
      const nextIndex = index.filter((entryId) => entryId !== id);
      await this._saveRetryIndex(nextIndex);
    } catch (error) {
      console.error('Failed to remove Expo retry entry:', error);
    }
  }

  async _loadPersistentRetryEntries() {
    if (!this._hasPersistentRetryStore()) return [];
    const index = await this._loadRetryIndex();
    if (!index.length) return [];

    const loaded = await Promise.all(
      index.map(async (id) => {
        try {
          const raw = await this.env.CACHE.get(`${this.EXPO_RETRY_KEY_PREFIX}${id}`);
          if (!raw) return null;
          const parsed = JSON.parse(raw);
          if (!parsed || !Array.isArray(parsed.messages)) return null;
          return { ...parsed, id };
        } catch {
          return null;
        }
      })
    );

    return loaded.filter(Boolean);
  }

  async _sendExpoBatchWithRetry(messages, traceId) {
    let lastError = null;

    for (let attempt = 1; attempt <= this.EXPO_MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(messages),
        });

        if (!response.ok) {
          const shouldRetry = response.status >= 500 || response.status === 429;
          const error = new Error(`Expo push failed: ${response.status}`);
          error.status = response.status;
          if (!shouldRetry || attempt === this.EXPO_MAX_RETRIES) {
            throw error;
          }
          lastError = error;
          continue;
        }

        const json = await response.json();
        return json;
      } catch (error) {
        lastError = error;
        if (attempt === this.EXPO_MAX_RETRIES) {
          console.error(`[Push:${traceId}] Expo batch failed after retries:`, error);
          throw error;
        }
      }
    }

    throw lastError || new Error('Expo batch failed');
  }

  async _checkExpoReceipts(receiptTokenMap, traceId) {
    const receiptIds = Object.keys(receiptTokenMap || {});
    if (receiptIds.length === 0) return;

    try {
      const response = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ ids: receiptIds }),
      });

      if (!response.ok) {
        console.warn(`[Push:${traceId}] Expo receipts fetch failed:`, response.status);
        return;
      }

      const json = await response.json();
      const data = json?.data || {};

      for (const [receiptId, receipt] of Object.entries(data)) {
        if (receipt?.status === 'error' && receipt?.details?.error === 'DeviceNotRegistered') {
          const badToken = receiptTokenMap[receiptId];
          await this._deleteExpoToken(badToken);
          console.warn(`[Push:${traceId}] Removed unregistered Expo token from receipt`, { receiptId });
        }
      }
    } catch (error) {
      console.error(`[Push:${traceId}] Expo receipts processing error:`, error);
    }
  }

  async _enqueueExpoRetry(messages, reason) {
    const entry = {
      messages,
      reason,
      attempts: 1,
      enqueuedAt: now(),
    };

    this.expoRetryQueue.push(entry);
    // Prevent unbounded growth in-memory
    if (this.expoRetryQueue.length > this.EXPO_RETRY_QUEUE_LIMIT) {
      this.expoRetryQueue.splice(0, this.expoRetryQueue.length - this.EXPO_RETRY_QUEUE_LIMIT);
    }

    await this._persistRetryEntry(entry);
  }

  async _flushExpoRetryQueue(traceId) {
    const persistentEntries = await this._loadPersistentRetryEntries();
    if (!this.expoRetryQueue.length && !persistentEntries.length) return;

    const pending = [
      ...this.expoRetryQueue,
      ...persistentEntries.filter((entry) => !this.expoRetryQueue.some((mem) => JSON.stringify(mem.messages) === JSON.stringify(entry.messages))),
    ];
    this.expoRetryQueue = [];

    for (const entry of pending) {
      try {
        await this._sendExpoBatchWithRetry(entry.messages, traceId);
        if (entry.id) {
          await this._removePersistentRetryEntry(entry.id);
        }
      } catch (error) {
        if (entry.attempts < this.EXPO_MAX_RETRIES) {
          const nextEntry = {
            ...entry,
            attempts: entry.attempts + 1,
            reason: error?.message || entry.reason,
          };
          this.expoRetryQueue.push(nextEntry);
          if (entry.id) {
            await this._updatePersistentRetryEntry(entry.id, nextEntry);
          } else {
            await this._persistRetryEntry(nextEntry);
          }
        } else if (entry.id) {
          await this._removePersistentRetryEntry(entry.id);
        }
      }
    }
  }

  /**
   * Register Expo push token for a mobile device
   */
  async registerExpoToken(userId, expoToken) {
    if (!expoToken) {
      throw new Error('Expo push token required');
    }

    // If token already exists, just update user and timestamp
    const existing = await this.db
      .prepare('SELECT * FROM expo_push_tokens WHERE token = ?')
      .bind(expoToken)
      .first();

    const timestamp = now();

    if (existing) {
      await this.db
        .prepare(
          'UPDATE expo_push_tokens SET user_id = ?, updated_at = ? WHERE token = ?'
        )
        .bind(userId, timestamp, expoToken)
        .run();
      return { id: existing.id };
    }

    const id = generateId('expo');
    await this.db
      .prepare(
        'INSERT INTO expo_push_tokens (id, user_id, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?)' 
      )
      .bind(id, userId, expoToken, timestamp, timestamp)
      .run();

    return { id };
  }

  async getExpoTokens(userId) {
    const result = await this.db
      .prepare('SELECT token FROM expo_push_tokens WHERE user_id = ?')
      .bind(userId)
      .all();
    return (result?.results || []).map((r) => r.token);
  }

  /**
   * Subscribe to push notifications
   */
  async subscribe(userId, subscription) {
    try {
      const { endpoint, keys } = subscription;

      if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
        throw new Error('Invalid subscription object');
      }

      // Check if subscription already exists
      const existing = await this.db.prepare(`
        SELECT * FROM push_subscriptions WHERE endpoint = ?
      `).bind(endpoint).first();

      if (existing) {
        // Update existing subscription
        await this.db.prepare(`
          UPDATE push_subscriptions
          SET user_id = ?, p256dh_key = ?, auth_key = ?, updated_at = ?
          WHERE endpoint = ?
        `).bind(userId, keys.p256dh, keys.auth, now(), endpoint).run();

        return { subscriptionId: existing.id };
      }

      // Create new subscription
      const subscriptionId = generateId('sub');

      await this.db.prepare(`
        INSERT INTO push_subscriptions (
          id, user_id, endpoint, p256dh_key, auth_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        subscriptionId,
        userId,
        endpoint,
        keys.p256dh,
        keys.auth,
        now(),
        now()
      ).run();

      // Push subscription created

      return { subscriptionId };
    } catch (error) {
      console.error('Subscribe error:', error);
      throw error;
    }
  }

  /**
   * Unsubscribe from push notifications
   */
  async unsubscribe(endpoint) {
    try {
      await this.db.prepare(`
        DELETE FROM push_subscriptions WHERE endpoint = ?
      `).bind(endpoint).run();

      // Push subscription removed
    } catch (error) {
      console.error('Unsubscribe error:', error);
      throw error;
    }
  }

  /**
   * Send push notification to user via Web Push (for web clients)
   */
  async sendToUser(userId, notification) {
    try {
      // Get user's subscriptions
      const subscriptions = await this.db.prepare(`
        SELECT * FROM push_subscriptions WHERE user_id = ?
      `).bind(userId).all();

      const subs = subscriptions?.results || [];

      if (subs.length === 0) {
        // No push subscriptions found
        return { sent: 0 };
      }

      // Send to all user's devices
      const sendPromises = subs.map(async (sub) => {
        try {
          await this.sendPush(sub, notification);
          return { success: true };
        } catch (error) {
          console.error(`Failed to send push to ${sub.endpoint}:`, error);

          // Remove invalid subscriptions (410 Gone)
          if (error.status === 410) {
            await this.unsubscribe(sub.endpoint);
          }
          return { success: false };
        }
      });

      const results = await Promise.allSettled(sendPromises);
      const sent = results.filter(result => result.status === 'fulfilled' && result.value.success).length;

      return { sent };
    } catch (error) {
      console.error('Send to user error:', error);
      throw error;
    }
  }

  /**
   * Send Expo push notification to user's mobile devices (iOS / Android via Expo)
   */
  async sendExpoToUser(userId, notification) {
    const traceId = this._createTraceId('expo');
    const tokens = await this.getExpoTokens(userId);
    if (!tokens || tokens.length === 0) {
      // No Expo push tokens found
      return { sent: 0, traceId };
    }

    await this._flushExpoRetryQueue(traceId);

    const chunks = [];
    for (let i = 0; i < tokens.length; i += this.EXPO_BATCH_SIZE) {
      chunks.push(tokens.slice(i, i + this.EXPO_BATCH_SIZE));
    }

    let sent = 0;
    let failed = 0;
    const receiptTokenMap = {};
    const invalidTokens = new Set();

    for (const tokenChunk of chunks) {
      const messages = tokenChunk.map((token) => ({
        to: token,
        sound: 'default',
        title: notification.title,
        body: notification.body,
        data: notification.data || {},
      }));

      try {
        const json = await this._sendExpoBatchWithRetry(messages, traceId);
        const results = Array.isArray(json?.data) ? json.data : [];

        for (let i = 0; i < results.length; i += 1) {
          const ticket = results[i];
          const token = tokenChunk[i];
          if (ticket?.status === 'ok') {
            sent += 1;
            if (ticket.id) {
              receiptTokenMap[ticket.id] = token;
            }
          } else {
            failed += 1;
            if (ticket?.details?.error === 'DeviceNotRegistered') {
              invalidTokens.add(token);
            }
          }
        }
      } catch (error) {
        failed += tokenChunk.length;
        await this._enqueueExpoRetry(messages, error?.message || 'batch-send-failed');
      }
    }

    for (const token of invalidTokens) {
      await this._deleteExpoToken(token);
    }

    await this._checkExpoReceipts(receiptTokenMap, traceId);

    console.info(`[Push:${traceId}] Expo delivery summary`, {
      userId,
      requested: tokens.length,
      sent,
      failed,
      queuedRetries: this.expoRetryQueue.length,
      persistentRetriesEnabled: this._hasPersistentRetryStore(),
    });

    return { sent, failed, traceId };
  }

  /**
   * Send push notification to multiple users via Web Push
   */
  async sendToUsers(userIds, notification) {
    try {
      const results = await Promise.allSettled(
        userIds.map(userId => this.sendToUser(userId, notification))
      );

      const totalSent = results.reduce((sum, result) => {
        if (result.status === 'fulfilled') {
          return sum + result.value.sent;
        }
        return sum;
      }, 0);

      return { sent: totalSent, users: userIds.length };
    } catch (error) {
      console.error('Send to users error:', error);
      throw error;
    }
  }

  /**
   * Send actual Web Push notification
   */
  async sendPush(subscription, notification) {
    try {
      const payload = JSON.stringify({
        title: notification.title,
        body: notification.body,
        icon: notification.icon || '/icon.png',
        badge: notification.badge || '/badge.png',
        image: notification.image,
        data: notification.data || {},
        tag: notification.tag,
        requireInteraction: notification.requireInteraction || false,
        actions: notification.actions || []
      });

      // Reconstruct subscription object
      const _pushSubscription = {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.p256dh_key,
          auth: subscription.auth_key
        }
      };

      // In production, use web-push library
      // For now, we'll use fetch to send to endpoint
      const response = await fetch(subscription.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'TTL': '86400' // 24 hours
        },
        body: payload
      });

      if (!response.ok) {
        throw new Error(`Push failed: ${response.status} ${response.statusText}`);
      }

      // Push notification sent
    } catch (error) {
      console.error('Send push error:', error);
      throw error;
    }
  }

  /**
   * Create notification and send push (web + mobile)
   */
  async notifyUser(userId, notification) {
    try {
      const traceId = this._createTraceId('notify');
      // Check user's notification preferences
      const settings = await this.db.prepare(`
        SELECT * FROM user_settings WHERE user_id = ?
      `).bind(userId).first();

      if (!settings || !settings.notifications_push) {
        // Push notifications disabled for user
        return { sent: false, traceId };
      }

      // Send Web Push (for browser clients)
      const webResult = await this.sendToUser(userId, notification);

      // Send Expo push (for mobile clients)
      let expoResult = { sent: 0 };
      try {
        expoResult = await this.sendExpoToUser(userId, notification);
      } catch (expoError) {
        console.error('Expo push error:', expoError);
      }

      const totalSent = (webResult.sent || 0) + (expoResult.sent || 0);
      console.info(`[Push:${traceId}] Notification delivery summary`, {
        userId,
        webSent: webResult.sent || 0,
        expoSent: expoResult.sent || 0,
        totalSent,
      });

      return { sent: totalSent > 0, count: totalSent, traceId };
    } catch (error) {
      console.error('Notify user error:', error);
      return { sent: false, error: error.message };
    }
  }

  /**
   * Trigger notification for specific events
   */
  async triggerNotification(event, data) {
    try {
      let notification = {};
      let targetUserId = null;

      switch (event) {
        case 'like':
          targetUserId = data.postOwnerId;
          notification = {
            title: 'New Like',
            body: `${data.likerName} liked your post`,
            icon: data.likerAvatar,
            tag: `like_${data.postId}`,
            data: {
              type: 'like',
              postId: data.postId,
              userId: data.likerId,
              url: `/posts/${data.postId}`
            }
          };
          break;

        case 'comment':
          targetUserId = data.postOwnerId;
          notification = {
            title: 'New Comment',
            body: `${data.commenterName}: ${data.commentText}`,
            icon: data.commenterAvatar,
            tag: `comment_${data.postId}`,
            data: {
              type: 'comment',
              postId: data.postId,
              commentId: data.commentId,
              userId: data.commenterId,
              url: `/posts/${data.postId}#comment-${data.commentId}`
            }
          };
          break;

        case 'follow':
          targetUserId = data.followedUserId;
          notification = {
            title: 'New Follower',
            body: `${data.followerName} started following you`,
            icon: data.followerAvatar,
            tag: `follow_${data.followerId}`,
            data: {
              type: 'follow',
              userId: data.followerId,
              url: `/users/${data.followerUsername}`
            }
          };
          break;

        case 'message':
          targetUserId = data.recipientId;
          notification = {
            title: data.senderName,
            body: data.messageText,
            icon: data.senderAvatar,
            tag: `message_${data.conversationId}`,
            requireInteraction: true,
            data: {
              type: 'message',
              conversationId: data.conversationId,
              messageId: data.messageId,
              userId: data.senderId,
              url: `/messages/${data.conversationId}`
            }
          };
          break;

        case 'share':
          targetUserId = data.postOwnerId;
          notification = {
            title: 'Post Shared',
            body: `${data.sharerName} shared your post`,
            icon: data.sharerAvatar,
            tag: `share_${data.postId}`,
            data: {
              type: 'share',
              postId: data.postId,
              shareId: data.shareId,
              userId: data.sharerId,
              url: `/shares/${data.shareId}`
            }
          };
          break;

        case 'mention':
          targetUserId = data.mentionedUserId;
          notification = {
            title: 'You were mentioned',
            body: `${data.mentionerName} mentioned you in a post`,
            icon: data.mentionerAvatar,
            tag: `mention_${data.postId}`,
            data: {
              type: 'mention',
              postId: data.postId,
              userId: data.mentionerId,
              url: `/posts/${data.postId}`
            }
          };
          break;

        default:
          console.warn('Unknown notification event:', event);
          return { sent: false };
      }

      if (!targetUserId) {
        throw new Error('No target user ID');
      }

      const result = await this.notifyUser(targetUserId, notification);
      console.info('[Push] Event triggered', {
        event,
        targetUserId,
        sent: result?.sent || false,
        traceId: result?.traceId || null,
      });
      return result;
    } catch (error) {
      console.error('Trigger notification error:', error);
      return { sent: false, error: error.message };
    }
  }

  /**
   * Get user's subscriptions
   */
  async getUserSubscriptions(userId) {
    try {
      const result = await this.db.prepare(`
        SELECT id, endpoint, created_at FROM push_subscriptions WHERE user_id = ?
      `).bind(userId).all();

      return result?.results || [];
    } catch (error) {
      console.error('Get user subscriptions error:', error);
      return [];
    }
  }
}
