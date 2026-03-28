// ============================================
// MESSAGING CONTROLLER
// Real-time chat conversations
// ============================================

import { DatabaseService } from '../services/database.js';
import {
  generateId,
  errorResponse,
  successResponse,
  sanitizeText,
  now,
  parseCursor,
  createCursor,
  safeParseInt
} from '../utils/helpers.js';
import { createNotification } from '../services/notifications.js';
import { PushNotificationService } from '../services/pushNotifications.js';

export class MessagingController {
  constructor(env) {
    this.db = DatabaseService.fromEnv(env);
    this.env = env;
    const primaryDb = this.db.router?.getPrimaryDb?.() || env.DB;
    this.pushService = new PushNotificationService(primaryDb, env);
  }

  /**
   * POST /conversations
   * Create new conversation
   */
  async create(request, userId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { participantIds, isGroup, name } = body;

      if (!participantIds || participantIds.length === 0) {
        return errorResponse('Participant IDs required', 400);
      }

      // Verify no blocks between participants and check message permissions
      /* eslint-disable no-await-in-loop */
      for (const participantId of participantIds) {
        const blocked = await this.env.DB.prepare(`
          SELECT COUNT(*) as count FROM blocks
          WHERE (blocker_type = 'user' AND blocker_id = ? AND blocked_type = 'user' AND blocked_id = ?)
             OR (blocker_type = 'user' AND blocker_id = ? AND blocked_type = 'user' AND blocked_id = ?)
        `).bind(userId, participantId, participantId, userId).first();

        if ((blocked?.count ?? 0) > 0) {
          return errorResponse('Cannot create conversation with blocked user', 403);
        }

        // Check who_can_message setting
        const settings = await this.env.DB.prepare(`
          SELECT who_can_message FROM user_settings WHERE user_id = ?
        `).bind(participantId).first();

        if (settings && settings.who_can_message) {
          if (settings.who_can_message === 'none') {
            return errorResponse('This user has disabled messages', 403);
          }
          if (settings.who_can_message === 'followers') {
            // Check if sender follows recipient
            const isFollower = await this.env.DB.prepare(`
              SELECT COUNT(*) as count FROM follows
              WHERE follower_type = 'user' AND follower_id = ?
                AND followee_type = 'user' AND followee_id = ?
            `).bind(userId, participantId).first();

            if ((isFollower?.count ?? 0) === 0) {
              return errorResponse('This user only accepts messages from followers', 403);
            }
          }
          if (settings.who_can_message === 'mutual') {
            // Check if both follow each other
            const mutual = await this.env.DB.prepare(`
              SELECT COUNT(*) as count FROM follows f1
              WHERE f1.follower_type = 'user' AND f1.follower_id = ?
                AND f1.followee_type = 'user' AND f1.followee_id = ?
                AND EXISTS (
                  SELECT 1 FROM follows f2
                  WHERE f2.follower_type = 'user' AND f2.follower_id = ?
                    AND f2.followee_type = 'user' AND f2.followee_id = ?
                )
            `).bind(userId, participantId, participantId, userId).first();

            if ((mutual?.count ?? 0) === 0) {
              return errorResponse('This user only accepts messages from mutual followers', 403);
            }
          }
          // 'everyone' - no restriction
        }
      }
      /* eslint-enable no-await-in-loop */

      // For 1-on-1, check if conversation already exists
      if (!isGroup && participantIds.length === 1) {
        const existing = await this.env.DB.prepare(`
          SELECT c.* FROM conversations c
          JOIN conversation_members cm1 ON c.id = cm1.conversation_id
          JOIN conversation_members cm2 ON c.id = cm2.conversation_id
          WHERE c.is_group = 0
            AND cm1.member_type = 'user' AND cm2.member_type = 'user'
            AND cm1.member_id = ? AND cm2.member_id = ?
        `).bind(userId, participantIds[0]).first();

        if (existing) {
          return successResponse({ conversation: existing }, 'Conversation already exists');
        }
      }

      // Create conversation
      const conversationId = generateId('conv');
      const timestamp = now();

      await this.env.DB.prepare(`
        INSERT INTO conversations (id, is_group, name, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        conversationId,
        isGroup ? 1 : 0,
        name || null,
        userId,
        timestamp,
        timestamp
      ).run();

      // Add creator as member
      await this.env.DB.prepare(`
        INSERT INTO conversation_members (id, conversation_id, member_type, member_id, joined_at)
        VALUES (?, ?, 'user', ?, ?)
      `).bind(generateId('cm'), conversationId, userId, timestamp).run();

      // Add other participants
      /* eslint-disable no-await-in-loop */
      for (const participantId of participantIds) {
        await this.env.DB.prepare(`
          INSERT INTO conversation_members (id, conversation_id, member_type, member_id, joined_at)
          VALUES (?, ?, 'user', ?, ?)
        `).bind(generateId('cm'), conversationId, participantId, timestamp).run();
      }
      /* eslint-enable no-await-in-loop */

      const conversation = await this.env.DB.prepare(`
        SELECT * FROM conversations WHERE id = ?
      `).bind(conversationId).first();

      return successResponse({ conversation }, 'Conversation created');
    } catch (error) {
      console.error('Create conversation error:', error);
      return errorResponse('Failed to create conversation', 500);
    }
  }

  /**
   * GET /conversations
   * List user's conversations
   */
  async list(request, userId) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
      const cursor = url.searchParams.get('cursor');

      let query = `
        SELECT DISTINCT c.*,
          (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND is_read = 0 
           AND sender_id != ?) as unread_count,
          (SELECT content FROM messages WHERE conversation_id = c.id 
           ORDER BY created_at DESC LIMIT 1) as last_message
        FROM conversations c
        JOIN conversation_members cm ON c.id = cm.conversation_id
        WHERE cm.member_type = 'user' AND cm.member_id = ?
      `;

      const params = [userId, userId];

      if (cursor) {
        const cursorData = parseCursor(cursor);
        if (cursorData?.updated_at) {
          query += ` AND c.updated_at < ?`;
          params.push(cursorData.updated_at);
        }
      }

      query += ` ORDER BY c.last_message_at DESC LIMIT ?`;
      params.push(limit + 1);

      const result = await this.env.DB.prepare(query).bind(...params).all();
      const conversations = result.results || [];

      const hasMore = conversations.length > limit;
      if (hasMore) conversations.pop();

      const nextCursor = hasMore && conversations.length > 0
        ? createCursor({ updated_at: conversations[conversations.length - 1].updated_at })
        : null;

      // Get participants for each conversation
      /* eslint-disable no-await-in-loop */
      for (const conv of conversations) {
        const participants = await this.env.DB.prepare(`
          SELECT u.id, u.username, u.name, u.avatar_url, u.verified
          FROM conversation_members cm
          JOIN users u ON cm.member_id = u.id
          WHERE cm.conversation_id = ? AND cm.member_type = 'user' AND u.id != ?
        `).bind(conv.id, userId).all();

        conv.participants = participants.results || [];
      }
      /* eslint-enable no-await-in-loop */

      return successResponse({ 
        conversations, 
        pagination: { hasMore, nextCursor } 
      });
    } catch (error) {
      console.error('List conversations error:', error);
      return errorResponse('Failed to get conversations', 500);
    }
  }

  /**
   * GET /conversations/:id
   * Get conversation details
   */
  async get(request, userId, conversationId) {
    try {
      // Verify membership
      const member = await this.env.DB.prepare(`
        SELECT * FROM conversation_members
        WHERE conversation_id = ? AND member_type = 'user' AND member_id = ?
      `).bind(conversationId, userId).first();

      if (!member) {
        return errorResponse('Not a member of this conversation', 403);
      }

      const conversation = await this.env.DB.prepare(`
        SELECT * FROM conversations WHERE id = ?
      `).bind(conversationId).first();

      if (!conversation) {
        return errorResponse('Conversation not found', 404);
      }

      // Get all participants
      const participants = await this.env.DB.prepare(`
        SELECT u.id, u.username, u.name, u.avatar_url, u.verified
        FROM conversation_members cm
        JOIN users u ON cm.member_id = u.id
        WHERE cm.conversation_id = ? AND cm.member_type = 'user'
      `).bind(conversationId).all();

      conversation.participants = participants.results || [];

      return successResponse({ conversation });
    } catch (error) {
      console.error('Get conversation error:', error);
      return errorResponse('Failed to get conversation', 500);
    }
  }

  /**
   * GET /conversations/:id/connect
   * Get WebSocket connection URL
   */
  async connect(request, userId, conversationId) {
    try {
      // Verify membership
      const member = await this.env.DB.prepare(`
        SELECT * FROM conversation_members
        WHERE conversation_id = ? AND member_type = 'user' AND member_id = ?
      `).bind(conversationId, userId).first();

      if (!member) {
        return errorResponse('Not a member of this conversation', 403);
      }

      // Generate Durable Object ID for this conversation
      this.env.CHAT_ROOM.idFromName(conversationId);

      // Return WebSocket URL
      const wsUrl = new URL(request.url);
      wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl.pathname = `/chat/${conversationId}`;
      wsUrl.searchParams.set('userId', userId);
      wsUrl.searchParams.set('conversationId', conversationId);

      return successResponse({
        wsUrl: wsUrl.toString(),
        conversationId
      });
    } catch (error) {
      console.error('Connect error:', error);
      return errorResponse('Failed to connect', 500);
    }
  }

  /**
   * GET /conversations/:id/messages
   * Get conversation messages (HTTP fallback)
   */
  async getMessages(request, userId, conversationId) {
    try {
      // Verify membership
      const member = await this.env.DB.prepare(`
        SELECT * FROM conversation_members
        WHERE conversation_id = ? AND member_type = 'user' AND member_id = ?
      `).bind(conversationId, userId).first();

      if (!member) {
        return errorResponse('Not a member of this conversation', 403);
      }

      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 50, 1, 100);
      const before = url.searchParams.get('before');

      // Join against either users or pages depending on sender_type so that
      // messages sent as a page identity are still returned and have a
      // display name/avatar for clients.
      let query = `
        SELECT 
          m.*,
          u.username                            AS username,
          COALESCE(u.name, p.name)             AS name,
          COALESCE(u.avatar_url, p.avatar_url) AS avatar_url,
          p.owner_id                            AS page_owner_id
        FROM messages m
        LEFT JOIN users u 
          ON m.sender_type = 'user' AND m.sender_id = u.id
        LEFT JOIN pages p
          ON m.sender_type = 'page' AND m.sender_id = p.id
        WHERE m.conversation_id = ?
      `;

      const params = [conversationId];

      if (before) {
        const beforeTs = safeParseInt(before, 0, 0, Number.MAX_SAFE_INTEGER);
        if (beforeTs > 0) {
          query += ` AND m.created_at < ?`;
          params.push(beforeTs);
        }
      }

      query += ` ORDER BY m.created_at DESC LIMIT ?`;
      params.push(limit + 1);

      const result = await this.env.DB.prepare(query).bind(...params).all();
      const messages = result.results || [];

      const hasMore = messages.length > limit;
      if (hasMore) messages.pop();

      // Parse media URLs
      const processedMessages = messages.map((msg) => {
        const processedMsg = { ...msg };
        if (processedMsg.media_urls) {
          try {
            processedMsg.media_urls = JSON.parse(processedMsg.media_urls);
          } catch {
            processedMsg.media_urls = [];
          }
        }
        if (processedMsg.sender_type === 'user') {
          processedMsg.is_sender_self = String(processedMsg.sender_id) === String(userId);
        } else if (processedMsg.sender_type === 'page') {
          processedMsg.is_sender_self = String(processedMsg.page_owner_id) === String(userId);
        }
        return processedMsg;
      });

      // Reverse to get chronological order
      processedMessages.reverse();

      return successResponse({
        messages: processedMessages,
        hasMore,
        oldestTimestamp: processedMessages.length > 0 ? processedMessages[0].created_at : null,
      });
    } catch (error) {
      console.error('Get messages error:', error);
      return errorResponse('Failed to get messages', 500);
    }
  }

  /**
   * POST /conversations/:id/messages
   * Send a message to conversation (REST fallback)
   */
  async sendMessage(request, userId, conversationId) {
    try {
      // Verify membership (membership is always tracked by the base user account)
      const member = await this.env.DB.prepare(`
        SELECT * FROM conversation_members
        WHERE conversation_id = ? AND member_type = 'user' AND member_id = ?
      `).bind(conversationId, userId).first();

      if (!member) {
        return errorResponse('Not a member of this conversation', 403);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }

      const { content, mediaUrls, cloudflareImageIds, cloudflareVideoIds, actorType, actorId } = body;

      // Require at least some text OR at least one media URL
      const hasText = typeof content === 'string' && content.trim().length > 0;
      const hasMedia = Array.isArray(mediaUrls) && mediaUrls.length > 0;

      if (!hasText && !hasMedia) {
        return errorResponse('Message must include text or media', 400);
      }

      const sanitizedContent = hasText ? sanitizeText(content) : '';
      if (sanitizedContent.length > 5000) {
        return errorResponse('Message too long (max 5000 characters)', 400);
      }

      // Determine which identity is sending the message.
      // By default messages are sent as the user account, but if the client
      // passes a page identity that the user owns we record it as a page.
      let senderType = 'user';
      let senderId = userId;

      if (actorType === 'page' && actorId) {
        try {
          const isOwner = await this.db.isPageOwner(actorId, userId);
          if (isOwner) {
            senderType = 'page';
            senderId = actorId;
          }
        } catch (ownerError) {
          console.error('Error checking page ownership for messaging:', ownerError);
        }
      }

      const messageId = generateId('msg');
      const timestamp = now();

      await this.env.DB.prepare(`
        INSERT INTO messages (id, conversation_id, sender_type, sender_id, content, media_urls, cloudflare_image_ids, cloudflare_video_ids, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        messageId,
        conversationId,
        senderType,
        senderId,
        sanitizedContent,
        mediaUrls ? JSON.stringify(mediaUrls) : null,
        cloudflareImageIds ? JSON.stringify(cloudflareImageIds) : null,
        cloudflareVideoIds ? JSON.stringify(cloudflareVideoIds) : null,
        timestamp
      ).run();

      // Update conversation updated_at and last_message_at
      await this.env.DB.prepare(`
        UPDATE conversations SET updated_at = ?, last_message_at = ? WHERE id = ?
      `).bind(timestamp, timestamp, conversationId).run();

      // Get sender display info from the appropriate table
      let display = { username: null, name: null, avatar_url: null };
      try {
        if (senderType === 'user') {
          const user = await this.env.DB.prepare(`
            SELECT id, username, name, avatar_url FROM users WHERE id = ?
          `).bind(senderId).first();
          if (user) {
            display = {
              username: user.username,
              name: user.name,
              avatar_url: user.avatar_url,
            };
          }
        } else if (senderType === 'page') {
          const page = await this.env.DB.prepare(`
            SELECT id, username, name, avatar_url FROM pages WHERE id = ?
          `).bind(senderId).first();
          if (page) {
            display = {
              username: page.username,
              name: page.name,
              avatar_url: page.avatar_url,
            };
          }
        }
      } catch (displayError) {
        console.error('Failed to load sender display info for message:', displayError);
      }

      const message = {
        id: messageId,
        conversation_id: conversationId,
        sender_type: senderType,
        sender_id: senderId,
        content: sanitizedContent,
        media_urls: mediaUrls || null,
        created_at: timestamp,
        username: display.username,
        name: display.name,
        avatar_url: display.avatar_url,
        is_sender_self: true,
      };

      // Notify other conversation members about the new message
      try {
        const membersResult = await this.env.DB.prepare(`
          SELECT member_id
          FROM conversation_members
          WHERE conversation_id = ? AND member_type = 'user' AND member_id != ?
        `).bind(conversationId, userId).all();

        const recipients = membersResult.results || [];
        const preview = sanitizedContent
          ? (sanitizedContent.length > 120 ? `${sanitizedContent.slice(0, 117)}...` : sanitizedContent)
          : 'Sent you a message.';

        /* eslint-disable no-await-in-loop */
        for (const row of recipients) {
          await createNotification(
            this.env.DB,
            row.member_id,
            'message',
            'sent you a new message',
            senderType,
            senderId,
            'conversation',
            conversationId
          );

          try {
            await this.pushService.triggerNotification('message', {
              recipientId: row.member_id,
              senderId,
              senderName: display.name || display.username || 'New message',
              senderAvatar: display.avatar_url || null,
              conversationId,
              messageId,
              messageText: preview,
            });
          } catch (pushError) {
            console.error('Failed to send message push notification:', pushError);
          }
        }
        /* eslint-enable no-await-in-loop */

        // Broadcast real-time notification to connected users
        try {
          if (this.env.NOTIFICATION_HUB && recipients.length > 0) {
            // Group recipients by shard for distributed delivery
            const recipientIds = recipients.map((row) => row.member_id);
            const shardedGroups = new Map();
            
            for (const recipient of recipientIds) {
              let hash = 0;
              for (let i = 0; i < recipient.length; i += 1) {
                hash = ((hash << 5) - hash) + recipient.charCodeAt(i);
                hash |= 0;
              }
              const shard = Math.abs(hash) % 16;
              if (!shardedGroups.has(shard)) {
                shardedGroups.set(shard, []);
              }
              shardedGroups.get(shard).push(recipient);
            }

            // Send to each shard in parallel
            for (const [shard, shardRecipients] of shardedGroups.entries()) {
              const notificationId = this.env.NOTIFICATION_HUB.idFromName(`notify-${shard}`);
              const notificationStub = this.env.NOTIFICATION_HUB.get(notificationId);

              notificationStub.fetch('http://internal/notify-multiple', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  userIds: shardRecipients,
                  notification: {
                    type: 'message_action',
                    action: 'sent',
                    title: 'New message',
                    body: preview,
                    message: {
                      id: messageId,
                      conversationId,
                      senderId,
                      senderType,
                      text: sanitizedContent,
                      time: new Date(timestamp * 1000).toISOString(),
                    },
                    data: {
                      type: 'message',
                      conversationId,
                      senderId,
                    }
                  }
                })
              }).catch(err => console.error('Failed to send message notification:', err));
            }
          }
        } catch (notifyError) {
          console.error('Failed to broadcast real-time message notification:', notifyError);
        }
      } catch (notifyError) {
        console.error('Failed to create message notifications:', notifyError);
      }

      return successResponse({ message }, 'Message sent');
    } catch (error) {
      console.error('Send message error:', error);
      return errorResponse('Failed to send message', 500);
    }
  }

  /**
   * POST /conversations/:id/members
   * Add member to group conversation
   */
  async addMember(request, userId, conversationId) {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
      const { userIdToAdd } = body;

      // Get conversation
      const conversation = await this.env.DB.prepare(`
        SELECT * FROM conversations WHERE id = ?
      `).bind(conversationId).first();

      if (!conversation) {
        return errorResponse('Conversation not found', 404);
      }

      if (!conversation.is_group) {
        return errorResponse('Cannot add members to non-group conversation', 400);
      }

      // Verify requester is member
      const member = await this.env.DB.prepare(`
        SELECT * FROM conversation_members
        WHERE conversation_id = ? AND member_type = 'user' AND member_id = ?
      `).bind(conversationId, userId).first();

      if (!member) {
        return errorResponse('You are not a member of this conversation', 403);
      }

      // Check if user already member
      const existing = await this.env.DB.prepare(`
        SELECT * FROM conversation_members
        WHERE conversation_id = ? AND member_type = 'user' AND member_id = ?
      `).bind(conversationId, userIdToAdd).first();

      if (existing) {
        return errorResponse('User already in conversation', 400);
      }

      // Add member
      await this.env.DB.prepare(`
        INSERT INTO conversation_members (id, conversation_id, member_type, member_id, joined_at)
        VALUES (?, ?, 'user', ?, ?)
      `).bind(generateId('cm'), conversationId, userIdToAdd, now()).run();

      return successResponse(null, 'Member added successfully');
    } catch (error) {
      console.error('Add member error:', error);
      return errorResponse('Failed to add member', 500);
    }
  }

  /**
   * DELETE /conversations/:id/members/:userId
   * Remove member or leave conversation
   */
  async removeMember(request, userId, conversationId, memberIdToRemove) {
    try {
      const conversation = await this.env.DB.prepare(`
        SELECT * FROM conversations WHERE id = ?
      `).bind(conversationId).first();

      if (!conversation) {
        return errorResponse('Conversation not found', 404);
      }

      // If removing self, anyone can do it
      if (memberIdToRemove === userId) {
        await this.env.DB.prepare(`
          DELETE FROM conversation_members
          WHERE conversation_id = ? AND member_type = 'user' AND member_id = ?
        `).bind(conversationId, userId).run();

        return successResponse(null, 'Left conversation');
      }

      // Only group creator can remove others
      if (conversation.created_by !== userId) {
        return errorResponse('Only conversation creator can remove members', 403);
      }

      await this.env.DB.prepare(`
        DELETE FROM conversation_members
        WHERE conversation_id = ? AND member_type = 'user' AND member_id = ?
      `).bind(conversationId, memberIdToRemove).run();

      return successResponse(null, 'Member removed');
    } catch (error) {
      console.error('Remove member error:', error);
      return errorResponse('Failed to remove member', 500);
    }
  }

  /**
  * DELETE /messages/:id
  * Delete a single message
  */
  async deleteMessage(request, userId, messageId) {
    try {
      // Load message with its conversation
      const message = await this.env.DB.prepare(`
        SELECT m.id, m.conversation_id, m.sender_type, m.sender_id, m.cloudflare_image_ids, m.cloudflare_video_ids, c.created_by
        FROM messages m
        JOIN conversations c ON m.conversation_id = c.id
        WHERE m.id = ?
      `).bind(messageId).first();

      if (!message) {
        return errorResponse('Message not found', 404);
      }

      // Permission rules:
      // - Sender (user) can delete their own message
      // - Page owner can delete messages sent by their page
      // - Conversation creator can delete any message in that conversation
      let canDelete = false;

      if (message.sender_type === 'user' && message.sender_id === userId) {
        canDelete = true;
      } else if (message.sender_type === 'page') {
        try {
          const isOwner = await this.db.isPageOwner(message.sender_id, userId);
          if (isOwner) {
            canDelete = true;
          }
        } catch (ownerError) {
          console.error('Error checking page ownership for message delete:', ownerError);
        }
      }

      if (message.created_by === userId) {
        canDelete = true;
      }

      if (!canDelete) {
        return errorResponse('You are not allowed to delete this message', 403);
      }

      // Clean up Cloudflare media before deleting message
      try {
        const { CloudflareMediaCleaner } = await import('../utils/cloudflare-media.js');
        const cleaner = new CloudflareMediaCleaner(this.env);
        
        // Delete images
        if (message.cloudflare_image_ids) {
          await cleaner.deleteImages(message.cloudflare_image_ids);
        }
        
        // Delete videos
        if (message.cloudflare_video_ids) {
          const videoIds = cleaner.safeParseJson(message.cloudflare_video_ids);
          for (const videoId of videoIds) {
            if (videoId) {
              await cleaner.deleteVideo(videoId);
            }
          }
        }
      } catch (cleanupError) {
        console.error('Cloudflare cleanup error for message deletion:', cleanupError);
        // Don't fail the deletion if cleanup fails
      }

      await this.env.DB.prepare(`
        DELETE FROM messages WHERE id = ?
      `).bind(messageId).run();

      return successResponse(null, 'Message deleted');
    } catch (error) {
      console.error('Delete message error:', error);
      return errorResponse('Failed to delete message', 500);
    }
  }

  /**
  * DELETE /conversations/:id
  * Delete conversation
  */
  async delete(request, userId, conversationId) {
    try {
      const conversation = await this.env.DB.prepare(`
        SELECT * FROM conversations WHERE id = ?
      `).bind(conversationId).first();

      if (!conversation) {
        return errorResponse('Conversation not found', 404);
      }

      // Only creator can delete
      if (conversation.created_by !== userId) {
        return errorResponse('Only conversation creator can delete', 403);
      }

      // Delete conversation (cascades to members and messages)
      await this.env.DB.prepare(`
        DELETE FROM conversations WHERE id = ?
      `).bind(conversationId).run();

      return successResponse(null, 'Conversation deleted');
    } catch (error) {
      console.error('Delete conversation error:', error);
      return errorResponse('Failed to delete conversation', 500);
    }
  }
}
