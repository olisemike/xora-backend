// ============================================
// PUSH NOTIFICATIONS CONTROLLER
// ============================================

import { PushNotificationService } from '../services/pushNotifications.js';
import { DbRouter } from '../services/dbRouter.js';
import { errorResponse, successResponse , safeParseInt } from '../utils/helpers.js';

export class PushNotificationsController {
  constructor(env) {
    this.dbRouter = DbRouter.fromEnv(env);
    const primaryDb = this.dbRouter.getPrimaryDb();
    this.pushService = new PushNotificationService(primaryDb, env);
  }

  async subscribe(request, userId) {
    try {
      const body = await request.json();
      const { subscription } = body;

      if (!subscription) {
        return errorResponse('Subscription object required', 400);
      }

      const result = await this.pushService.subscribe(userId, subscription);
      
      return successResponse(result, 'Subscribed to push notifications');
    } catch (error) {
      console.error('Subscribe error:', error);
      return errorResponse('Failed to subscribe', 500);
    }
  }

  async unsubscribe(request, _userId) {
    try {
      const body = await request.json();
      const { endpoint } = body;

      if (!endpoint) {
        return errorResponse('Endpoint required', 400);
      }

      await this.pushService.unsubscribe(endpoint);
      
      return successResponse(null, 'Unsubscribed from push notifications');
    } catch (error) {
      console.error('Unsubscribe error:', error);
      return errorResponse('Failed to unsubscribe', 500);
    }
  }

  async getSubscriptions(request, userId) {
    try {
      const subscriptions = await this.pushService.getUserSubscriptions(userId);
      
      return successResponse({ subscriptions });
    } catch (error) {
      console.error('Get subscriptions error:', error);
      return errorResponse('Failed to get subscriptions', 500);
    }
  }

  async subscribeExpo(request, userId) {
    try {
      const body = await request.json();
      const { token } = body;

      if (!token) {
        return errorResponse('Expo push token required', 400);
      }

      const result = await this.pushService.registerExpoToken(userId, token);
      return successResponse(result, 'Expo push token registered');
    } catch (error) {
      console.error('Expo subscribe error:', error);
      return errorResponse('Failed to register Expo push token', 500);
    }
  }

  async testNotification(request, userId) {
    try {
      const result = await this.pushService.notifyUser(userId, {
        title: 'Test Notification',
        body: 'This is a test push notification from Xora Social',
        icon: '/icon.png',
        tag: 'test',
        data: {
          type: 'test',
          url: '/'
        }
      });

      return successResponse(result, 'Test notification sent');
    } catch (error) {
      console.error('Test notification error:', error);
      return errorResponse('Failed to send test notification', 500);
    }
  }
}

// Analytics Controller
import { AnalyticsService } from '../services/analytics.js';

export class AnalyticsController {
  constructor(env) {
    this.dbRouter = DbRouter.fromEnv(env);
    const analyticsDb = this.dbRouter.getAnalyticsDb();
    this.analytics = new AnalyticsService(analyticsDb);
  }

  async getOverview(_request) {
    try {
      const overview = await this.analytics.getPlatformOverview();
      return successResponse({ overview });
    } catch (error) {
      console.error('Get overview error:', error);
      return errorResponse('Failed to get overview', 500);
    }
  }

  async getUserGrowth(request) {
    try {
      const url = new URL(request.url);
      const period = url.searchParams.get('period') || '30d';
      
      const growth = await this.analytics.getUserGrowth(period);
      return successResponse({ growth });
    } catch (error) {
      console.error('Get user growth error:', error);
      return errorResponse('Failed to get user growth', 500);
    }
  }

  async getEngagement(request) {
    try {
      const url = new URL(request.url);
      const period = url.searchParams.get('period') || '30d';
      
      const engagement = await this.analytics.getEngagementMetrics(period);
      return successResponse({ engagement });
    } catch (error) {
      console.error('Get engagement error:', error);
      return errorResponse('Failed to get engagement', 500);
    }
  }

  async getActiveUsers(_request) {
    try {
      const activeUsers = await this.analytics.getActiveUsers();
      return successResponse({ activeUsers });
    } catch (error) {
      console.error('Get active users error:', error);
      return errorResponse('Failed to get active users', 500);
    }
  }

  async getTopContent(request) {
    try {
      const url = new URL(request.url);
      const type = url.searchParams.get('type') || 'posts';
      const limit = safeParseInt(url.searchParams.get('limit'), 10, 1, 100);
      
      const topContent = await this.analytics.getTopContent(type, limit);
      return successResponse(topContent);
    } catch (error) {
      console.error('Get top content error:', error);
      return errorResponse('Failed to get top content', 500);
    }
  }

  async getTrending(request) {
    try {
      const url = new URL(request.url);
      const limit = safeParseInt(url.searchParams.get('limit'), 10, 1, 100);
      
      const trending = await this.analytics.getTrendingTopics(limit);
      return successResponse(trending);
    } catch (error) {
      console.error('Get trending error:', error);
      return errorResponse('Failed to get trending', 500);
    }
  }

  async getRetention(_request) {
    try {
      const retention = await this.analytics.getRetentionMetrics();
      return successResponse(retention);
    } catch (error) {
      console.error('Get retention error:', error);
      return errorResponse('Failed to get retention', 500);
    }
  }

  async getMessaging(request) {
    try {
      const url = new URL(request.url);
      const period = url.searchParams.get('period') || '30d';
      
      const messaging = await this.analytics.getMessagingMetrics(period);
      return successResponse({ messaging });
    } catch (error) {
      console.error('Get messaging error:', error);
      return errorResponse('Failed to get messaging stats', 500);
    }
  }

  async getModeration(_request) {
    try {
      const moderation = await this.analytics.getModerationStats();
      return successResponse({ moderation });
    } catch (error) {
      console.error('Get moderation error:', error);
      return errorResponse('Failed to get moderation stats', 500);
    }
  }

  async exportReport(request) {
    try {
      const url = new URL(request.url);
      const period = url.searchParams.get('period') || '30d';
      
      const report = await this.analytics.exportReport(period);
      return successResponse({ report });
    } catch (error) {
      console.error('Export report error:', error);
      return errorResponse('Failed to export report', 500);
    }
  }
}
