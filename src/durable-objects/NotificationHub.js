// ============================================
// NOTIFICATION HUB DURABLE OBJECT
// Real-time notifications for feed events
// ============================================

import { generateId } from '../utils/helpers.js';
import { verifyToken, initJWT } from '../services/jwt.js';

export class NotificationHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.connections = new Map(); // userId -> Set of WebSockets
    this.maxConnectionsPerUser = 10; // Allow multiple tabs + reconnection buffer
    this.connectionOrder = new Map(); // userId -> Array of WebSockets in order of creation

    // Initialize JWT service with environment for token verification
    initJWT(env);
  }

  // Use Durable Object alarm for periodic cleanup (instead of setInterval which causes memory leaks)
  async alarm() {
    this.cleanupClosedConnections();
    
    // Schedule next cleanup in 5 minutes if there are active connections
    if (this.connections.size > 0) {
      await this.state.storage.setAlarm(Date.now() + 300000);
    }
  }

  cleanupClosedConnections() {
    for (const [userId, sockets] of this.connections.entries()) {
      const activeSockets = new Set(
        [...sockets].filter(ws => ws && ws.readyState === WebSocket.OPEN)
      );
      
      if (activeSockets.size === 0) {
        this.connections.delete(userId);
        this.connectionOrder.delete(userId);
      } else if (activeSockets.size !== sockets.size) {
        this.connections.set(userId, activeSockets);
        // Rebuild order array for active connections only
        const oldOrder = this.connectionOrder.get(userId) || [];
        const newOrder = oldOrder.filter(ws => activeSockets.has(ws));
        this.connectionOrder.set(userId, newOrder);
      }
    }
    
    // Force garbage collection of stale maps when size gets large
    if (this.connections.size > 1000) {
      const now = Date.now();
      console.warn(`[NotificationHub] Large connection map detected: ${this.connections.size} users`);
    }
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);

    // WebSocket upgrade request
    if (request.headers.get('Upgrade') === 'websocket') {
      return await this.handleWebSocket(request);
    }

    // HTTP endpoints
    if (pathname === '/notify' && request.method === 'POST') {
      return await this.broadcastNotification(request);
    }

    if (pathname === '/notify-multiple' && request.method === 'POST') {
      return await this.broadcastToMultiple(request);
    }

    if (pathname === '/connected' && request.method === 'GET') {
      return this.getConnectedUsers();
    }

    if (pathname === '/broadcast' && request.method === 'POST') {
      return await this.broadcastEvent(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  async handleWebSocket(request) {
    // Extract userId from query params
    const userId = new URL(request.url).searchParams.get('userId');

    if (!userId) {
      return new Response('Unauthorized: Missing userId', { 
        status: 401, 
        statusText: 'Unauthorized' 
      });
    }

    // Extract and verify JWT token from Authorization header, query param, or WebSocket protocol
    let authHeader = request.headers.get('Authorization');
    const url = new URL(request.url);
    const tokenFromQuery = url.searchParams.get('token');

    if (!authHeader && tokenFromQuery) {
      authHeader = `Bearer ${tokenFromQuery}`;
    }

    if (!authHeader) {
      const protocolHeader = request.headers.get('sec-websocket-protocol');
      if (protocolHeader) {
        const protocols = protocolHeader.split(',');
        if (protocols[0].trim() === 'bearer' && protocols[1]) {
          authHeader = `Bearer ${protocols[1].trim()}`;
        }
      }
    }
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response('Unauthorized: Missing or invalid token', {
        status: 401,
        statusText: 'Unauthorized'
      });
    }

    const token = authHeader.slice(7); // Remove 'Bearer ' prefix

    // Verify JWT token
    const payload = await verifyToken(token);
    if (!payload || payload.type !== 'access' || payload.userId !== userId) {
      return new Response('Unauthorized: Invalid token', {
        status: 401,
        statusText: 'Unauthorized'
      });
    }

    const { 0: client, 1: server } = new WebSocketPair();

    // Store connection
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Set());
      this.connectionOrder.set(userId, []);
    }

    const userSockets = this.connections.get(userId);
    const socketOrder = this.connectionOrder.get(userId);
    
    // If at max capacity, close oldest connection to make room
    if (userSockets.size >= this.maxConnectionsPerUser && socketOrder.length > 0) {
      const oldestSocket = socketOrder.shift();
      try {
        if (oldestSocket && oldestSocket.readyState === WebSocket.OPEN) {
          oldestSocket.close(1000, 'Replaced by newer connection');
        }
      } catch (e) {
        // Ignore close errors
      }
      userSockets.delete(oldestSocket);
    }

    userSockets.add(server);
    socketOrder.push(server);

    // Schedule cleanup alarm if this is the first connection
    if (this.connections.size === 1 && userSockets.size === 1) {
      await this.state.storage.setAlarm(Date.now() + 300000); // 5 minutes
    }

    // Accept WebSocket connection
    server.accept();

    // Handle incoming messages
    server.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'ping') {
          server.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (e) {
        // Ignore malformed messages
      }
    });

    server.addEventListener('close', () => {
      userSockets.delete(server);
      const orderIndex = socketOrder.indexOf(server);
      if (orderIndex !== -1) {
        socketOrder.splice(orderIndex, 1);
      }
      if (userSockets.size === 0) {
        this.connections.delete(userId);
        this.connectionOrder.delete(userId);
      }
    });

    server.addEventListener('error', (event) => {
      console.error('WebSocket error:', event);
      userSockets.delete(server);
      const orderIndex = socketOrder.indexOf(server);
      if (orderIndex !== -1) {
        socketOrder.splice(orderIndex, 1);
      }
    });

    // Return WebSocket upgrade response
    // For Sec-WebSocket-Protocol handshake: echo back the protocol if client sent one
    const protocolHeader = request.headers.get('sec-websocket-protocol');
    const responseHeaders = new Headers();
    
    if (protocolHeader) {
      // Extract and echo back the first protocol value
      const protocols = protocolHeader.split(',').map(p => p.trim());
      if (protocols.length > 0) {
        responseHeaders.set('Sec-WebSocket-Protocol', protocols[0]);
      }
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: responseHeaders
    });
  }

  async broadcastNotification(request) {
    try {
      const { userId, notification } = await request.json();

      if (!userId || !notification) {
        return new Response(
          JSON.stringify({ error: 'Missing userId or notification' }),
          { status: 400 }
        );
      }

      const sockets = this.connections.get(userId);
      if (!sockets || sockets.size === 0) {
        return new Response(
          JSON.stringify({ 
            success: true, 
            delivered: 0,
            message: 'User not connected'
          })
        );
      }

      const payload = JSON.stringify({
        type: 'notification',
        id: generateId('notif'),
        timestamp: new Date().toISOString(),
        ...notification
      });

      let delivered = 0;
      for (const socket of sockets) {
        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(payload);
            delivered++;
          }
        } catch (e) {
          console.error('Failed to send notification:', e);
        }
      }

      return new Response(
        JSON.stringify({ 
          success: true, 
          delivered,
          total: sockets.size
        })
      );
    } catch (error) {
      console.error('Broadcast error:', error);
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500 }
      );
    }
  }

  async broadcastToMultiple(request) {
    try {
      const { userIds, notification } = await request.json();

      if (!userIds || !Array.isArray(userIds) || !notification) {
        return new Response(
          JSON.stringify({ error: 'Invalid request' }),
          { status: 400 }
        );
      }

      // Rate limit: max 10,000 users per batch to prevent overwhelming the DO
      const MAX_BATCH_SIZE = 10000;
      const CHUNK_SIZE = 100; // Process in chunks to avoid blocking

      const usersToNotify = userIds.slice(0, MAX_BATCH_SIZE);

      const payload = JSON.stringify({
        type: 'notification',
        id: generateId('notif'),
        timestamp: new Date().toISOString(),
        ...notification
      });

      let totalDelivered = 0;
      let totalConnected = 0;

      // Process in chunks to avoid blocking the event loop
      for (let i = 0; i < usersToNotify.length; i += CHUNK_SIZE) {
        const chunk = usersToNotify.slice(i, i + CHUNK_SIZE);

        // Process chunk concurrently
        // eslint-disable-next-line no-await-in-loop
        const chunkResults = await Promise.all(
          chunk.map(async (userId) => {
            const sockets = this.connections.get(userId);
            if (!sockets) {
              return { delivered: 0, connected: false };
            }

            let delivered = 0;
            for (const socket of sockets) {
              try {
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(payload);
                  delivered++;
                }
              } catch {
                // Failed to send, socket may be closed
              }
            }

            return { delivered, connected: true };
          })
        );

        // Aggregate results
        for (const result of chunkResults) {
          totalDelivered += result.delivered;
          if (result.connected) totalConnected++;
        }

        // Small yield between chunks for very large batches
        if (i + CHUNK_SIZE < usersToNotify.length && usersToNotify.length > 1000) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          totalDelivered,
          totalConnected,
          totalRequested: usersToNotify.length,
          truncated: userIds.length > MAX_BATCH_SIZE
        })
      );
    } catch (error) {
      console.error('Broadcast to multiple error:', error);
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500 }
      );
    }
  }

  getConnectedUsers() {
    const connectedUsers = [];
    for (const [userId, sockets] of this.connections.entries()) {
      connectedUsers.push({
        userId,
        connections: sockets.size
      });
    }

    return new Response(
      JSON.stringify({
        connectedUsers,
        total: connectedUsers.length
      })
    );
  }

  async broadcastEvent(request) {
    try {
      const eventData = await request.json();

      if (!eventData || !eventData.type) {
        return new Response(
          JSON.stringify({ error: 'Missing event type' }),
          { status: 400 }
        );
      }

      // Broadcast to ALL connected users
      let totalDelivered = 0;
      for (const [userId, sockets] of this.connections.entries()) {
        const payload = JSON.stringify({
          type: eventData.type,
          action: eventData.action,
          ...eventData,
          timestamp: new Date().toISOString()
        });

        for (const socket of sockets) {
          try {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(payload);
              totalDelivered++;
            }
          } catch (e) {
            console.error(`Failed to send to user ${userId}:`, e);
          }
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          delivered: totalDelivered,
          message: `Event broadcasted to ${totalDelivered} connections`
        })
      );
    } catch (error) {
      console.error('Broadcast event error:', error);
      return new Response(
        JSON.stringify({ error: 'Failed to broadcast event' }),
        { status: 500 }
      );
    }
  }
}
