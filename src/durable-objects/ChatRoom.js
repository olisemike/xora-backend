// ============================================
// CHAT DURABLE OBJECT
// Real-time WebSocket messaging
// ============================================

import { generateId, safeParseInt } from '../utils/helpers.js';
import { verifyToken, initJWT } from '../services/jwt.js';

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // userId -> WebSocket
    this.typingUsers = new Set();
    this.maxSessions = 1000;

    // Initialize JWT service with environment for token verification
    initJWT(env);
  }

  // Use Durable Object alarm for periodic cleanup (instead of setInterval which causes memory leaks)
  async alarm() {
    this.cleanupStaleSessions();
    
    // Schedule next cleanup in 5 minutes if there are active sessions
    if (this.sessions.size > 0) {
      await this.state.storage.setAlarm(Date.now() + 300000);
    }
  }

  cleanupStaleSessions() {
    for (const [userId, ws] of this.sessions.entries()) {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        this.sessions.delete(userId);
        this.typingUsers.delete(userId);
      }
    }
  }

  // Cleanup interval on destruction to prevent memory leaks
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade request
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Validate before accepting WebSocket
      const validationResult = await this.validateWebSocketRequest(request);
      if (!validationResult.valid) {
        return new Response(validationResult.error, {
          status: validationResult.status || 400
        });
      }

      // Accept the WebSocket connection
      server.accept();

      await this.handleSession(server, request, validationResult.userId);

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    // HTTP endpoints for chat room
    if (url.pathname === '/messages') {
      return await this.getMessages(request);
    }

    if (url.pathname === '/typing') {
      return await this.handleTyping(request);
    }

    return new Response('Not found', { status: 404 });
  }

  async validateWebSocketRequest(request) {
    const url = new URL(request.url);
    let token = url.searchParams.get('token');
    const conversationId = url.searchParams.get('conversationId')
      || url.pathname.split('/').filter(Boolean).pop();

    if (!token) {
      const protocolHeader = request.headers.get('sec-websocket-protocol');
      if (protocolHeader && protocolHeader.includes('bearer')) {
        token = protocolHeader.split(',').find(p => p.trim() !== 'bearer')?.trim();
      }
    }

    if (!token) {
      const authHeader = request.headers.get('Authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7);
      }
    }

    if (!token || !conversationId) {
      return {
        valid: false,
        error: 'Missing token or conversationId',
        status: 400
      };
    }

    // Verify JWT token
    try {
      const payload = await verifyToken(token);

      if (!payload || payload.type !== 'access') {
        return {
          valid: false,
          error: 'Invalid authentication token',
          status: 401
        };
      }

      // Verify user is a member of this conversation
      const membership = await this.env.DB.prepare(`
        SELECT 1 FROM conversation_members
        WHERE conversation_id = ? AND member_type = 'user' AND member_id = ?
      `).bind(conversationId, payload.userId).first();

      if (!membership) {
        return {
          valid: false,
          error: 'Not a member of this conversation',
          status: 403
        };
      }

      return {
        valid: true,
        userId: payload.userId
      };
    } catch (error) {
      console.error('WebSocket validation error:', error);
      return {
        valid: false,
        error: 'Token verification failed',
        status: 401
      };
    }
  }

  // eslint-disable-next-line require-await
  async handleSession(websocket, request, userId) {
    const url = new URL(request.url);
    const conversationId = url.searchParams.get('conversationId')
      || url.pathname.split('/').filter(Boolean).pop();

    // Check max sessions limit
    if (this.sessions.size >= this.maxSessions) {
      websocket.close(1008, 'Maximum sessions reached');
      return;
    }

    // Store session with verified userId
    this.sessions.set(userId, websocket);

    // Schedule cleanup alarm if this is the first session
    if (this.sessions.size === 1) {
      await this.state.storage.setAlarm(Date.now() + 300000); // 5 minutes
    }

    try {
      // Send current online users
      const onlineUsers = Array.from(this.sessions.keys());
      websocket.send(JSON.stringify({
        type: 'online_users',
        users: onlineUsers
      }));

      // Broadcast new user joined
      this.broadcast({
        type: 'user_joined',
        userId,
        timestamp: Date.now()
      }, userId);

      // Handle incoming messages
      websocket.addEventListener('message', async (event) => {
        try {
          const data = JSON.parse(event.data);
          await this.handleMessage(data, userId, conversationId);
        } catch (error) {
          console.error('WebSocket message error:', error);
        }
      });
      
      // Handle WebSocket errors
      websocket.addEventListener('error', (event) => {
        console.error('WebSocket error for user', userId, event);
        this.sessions.delete(userId);
        this.typingUsers.delete(userId);
      });

      // Handle disconnect
      websocket.addEventListener('close', () => {
        this.sessions.delete(userId);
        this.typingUsers.delete(userId);
        
        // Broadcast user left
        try {
          this.broadcast({
            type: 'user_left',
            userId,
            timestamp: Date.now()
          }, userId);
        } catch (error) {
          console.error('Error broadcasting user_left:', error);
        }
      });
      websocket.addEventListener('close', () => {
        this.sessions.delete(userId);
        this.typingUsers.delete(userId);

        // Broadcast user left
        this.broadcast({
          type: 'user_left',
          userId,
          timestamp: Date.now()
        });
      });

      websocket.addEventListener('error', (error) => {
        console.error('WebSocket error:', error);
        this.sessions.delete(userId);
      });
    } catch (error) {
      console.error('WebSocket authentication error:', error);
      websocket.close(1008, 'Authentication failed');
    }
  }

  async handleMessage(data, userId, conversationId) {
    const { type, payload } = data;

    switch (type) {
      case 'send_message':
        await this.handleSendMessage(payload, userId, conversationId);
        break;

      case 'ping':
        try {
          const ws = this.sessions.get(userId);
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch {
          // ignore pong failures
        }
        break;

      case 'typing_start':
        await this.handleTypingStart(userId);
        break;

      case 'typing_stop':
        await this.handleTypingStop(userId);
        break;

      case 'read_receipt':
        await this.handleReadReceipt(payload, userId);
        break;

      case 'message_reaction':
        await this.handleReaction(payload, userId, conversationId);
        break;

      default:
        console.warn('Unknown message type:', type);
    }
  }

  async handleSendMessage(payload, userId, conversationId) {
    const { content, mediaUrls, replyToId } = payload;

    // Generate message ID
    const messageId = generateId('msg');
    const timestamp = Math.floor(Date.now() / 1000);

    // Save to database
    try {
      await this.env.DB.prepare(`
        INSERT INTO messages (
          id, conversation_id, sender_type, sender_id, content, 
          media_urls, reply_to_id, is_read, created_at, updated_at
        ) VALUES (?, ?, 'user', ?, ?, ?, ?, 0, ?, ?)
      `).bind(
        messageId,
        conversationId,
        userId,
        content || null,
        mediaUrls ? JSON.stringify(mediaUrls) : null,
        replyToId || null,
        timestamp,
        timestamp
      ).run();

      // Update conversation last_message_at
      await this.env.DB.prepare(`
        UPDATE conversations 
        SET last_message_at = ?, updated_at = ?
        WHERE id = ?
      `).bind(timestamp, timestamp, conversationId).run();

      // Broadcast message to all users in room
      this.broadcast({
        type: 'new_message',
        message: {
          id: messageId,
          conversationId,
          senderType: 'user',
          senderId: userId,
          content,
          mediaUrls,
          replyToId,
          createdAt: timestamp,
          isRead: false
        }
      });

      // Send to NotificationHub for real-time conversation updates
      try {
        const membersResult = await this.env.DB.prepare(`
          SELECT member_id
          FROM conversation_members
          WHERE conversation_id = ? AND member_type = 'user' AND member_id != ?
        `).bind(conversationId, userId).all();

        const recipients = (membersResult.results || []).map((row) => row.member_id);

        if (recipients.length > 0) {
          // Group recipients by shard for distributed delivery
          const shardedGroups = new Map();
          for (const recipient of recipients) {
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

          const preview = typeof content === 'string' && content.length > 0
            ? (content.length > 120 ? `${content.slice(0, 117)}...` : content)
            : 'Sent you a message.';

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
                    senderId: userId,
                    senderType: 'user',
                    text: content,
                    time: new Date(timestamp * 1000).toISOString(),
                  },
                  data: {
                    type: 'message',
                    conversationId,
                    senderId: userId,
                  }
                }
              })
            }).catch(err => {
              console.error('Failed to send chat notification:', err);
            });
          }
        }
      } catch (error) {
        console.error('Failed to send message notification:', error);
      }

    } catch (error) {
      console.error('Save message error:', error);
      
      // Send error to sender
      const ws = this.sessions.get(userId);
      if (ws) {
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Failed to send message'
        }));
      }
    }
  }

  handleTypingStart(userId) {
    this.typingUsers.add(userId);

    // Broadcast typing indicator
    this.broadcast({
      type: 'typing_start',
      userId,
      timestamp: Date.now()
    }, userId);
  }

  handleTypingStop(userId) {
    this.typingUsers.delete(userId);

    // Broadcast typing stopped
    this.broadcast({
      type: 'typing_stop',
      userId,
      timestamp: Date.now()
    }, userId);
  }

  async handleReadReceipt(payload, userId) {
    const { messageId } = payload;

    try {
      // Update read status in database
      await this.env.DB.prepare(`
        UPDATE messages SET is_read = 1, updated_at = ? WHERE id = ?
      `).bind(Math.floor(Date.now() / 1000), messageId).run();

      // Broadcast read receipt
      this.broadcast({
        type: 'message_read',
        messageId,
        readBy: userId,
        timestamp: Date.now()
      });

    } catch (error) {
      console.error('Read receipt error:', error);
    }
  }

  async handleReaction(payload, userId, _conversationId) {
    const { messageId, emoji } = payload;

    try {
      const reactionId = generateId('react');

      // Check if reaction exists
      const existing = await this.env.DB.prepare(`
        SELECT * FROM message_reactions 
        WHERE message_id = ? AND user_id = ? AND emoji = ?
      `).bind(messageId, userId, emoji).first();

      if (existing) {
        // Remove reaction
        await this.env.DB.prepare(`
          DELETE FROM message_reactions WHERE id = ?
        `).bind(existing.id).run();

        this.broadcast({
          type: 'reaction_removed',
          messageId,
          userId,
          emoji,
          timestamp: Date.now()
        });
      } else {
        // Add reaction
        await this.env.DB.prepare(`
          INSERT INTO message_reactions (id, message_id, user_id, emoji, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).bind(reactionId, messageId, userId, emoji, Math.floor(Date.now() / 1000)).run();

        this.broadcast({
          type: 'reaction_added',
          messageId,
          userId,
          emoji,
          timestamp: Date.now()
        });
      }

    } catch (error) {
      console.error('Reaction error:', error);
    }
  }

  async getMessages(request) {
    const url = new URL(request.url);
    const conversationId = url.searchParams.get('conversationId');
    const limit = safeParseInt(url.searchParams.get('limit'), 50, 1, 200);
    const before = url.searchParams.get('before');

    try {
      let query = `
        SELECT m.*, u.username, u.name, u.avatar_url
        FROM messages m
        JOIN users u ON m.sender_id = u.id
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
      params.push(limit);

      const result = await this.env.DB.prepare(query).bind(...params).all();
      const messages = result.results || [];

      // Parse media URLs
      const processedMessages = messages.map(msg => {
        const processedMsg = { ...msg };
        if (processedMsg.media_urls) {
          try {
            processedMsg.media_urls = JSON.parse(processedMsg.media_urls);
          } catch {
            processedMsg.media_urls = [];
          }
        }
        return processedMsg;
      });

      return new Response(JSON.stringify({
        success: true,
        data: { messages: processedMessages }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('Get messages error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to get messages'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  broadcast(message, excludeUserId = null) {
    const messageStr = JSON.stringify(message);
    const deadConnections = [];

    for (const [userId, ws] of this.sessions) {
      if (userId === excludeUserId) continue;

      // Check WebSocket state before sending
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        deadConnections.push(userId);
        continue;
      }

      try {
        ws.send(messageStr);
      } catch (error) {
        console.error(`Failed to send to ${userId}:`, error);
        deadConnections.push(userId);
      }
    }
    
    // Cleanup dead connections
    for (const userId of deadConnections) {
      this.sessions.delete(userId);
      this.typingUsers.delete(userId);
    }
  }
}
