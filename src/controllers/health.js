// Health Check Controller
import { successResponse, errorResponse, now } from '../utils/helpers.js';

export class HealthController {
  constructor(env) {
    this.env = env;
  }

  /**
   * Basic health check
   */
  getHealth(_request) {
    return successResponse({
      status: 'healthy',
      timestamp: now(),
      uptime: 'N/A',
      service: 'Xora API',
      version: '1.0.0'
    });
  }

  /**
   * Detailed health check with database connectivity
   */
  async getDetailedHealth(_request) {
    try {
      const checks = {
        api: 'healthy',
        database: 'unknown',
        timestamp: now()
      };

      // Check database connectivity
      try {
        const result = await this.env.DB.prepare('SELECT 1 as test').first();
        checks.database = result && result.test === 1 ? 'healthy' : 'unhealthy';
      } catch (dbError) {
        checks.database = 'unhealthy';
        checks.databaseError = dbError.message;
      }

      // Overall status
      const isHealthy = checks.api === 'healthy' && checks.database === 'healthy';

      return successResponse({
        status: isHealthy ? 'healthy' : 'degraded',
        checks,
        service: 'Xora API',
        version: '1.0.0'
      });
    } catch (error) {
      console.error('Health check error:', error);
      return errorResponse('Health check failed', 500);
    }
  }

  /**
   * Readiness check (for Kubernetes/load balancers)
   */
  async getReadiness(_request) {
    try {
      // Check if we can query database
      await this.env.DB.prepare('SELECT 1').first();

      return successResponse({
        ready: true,
        timestamp: now()
      });
    } catch (error) {
      console.error('Readiness check error:', error);
      return errorResponse('Service not ready', 503, { reason: error.message });
    }
  }

  /**
   * Liveness check (for Kubernetes/load balancers)
   */
  getLiveness(_request) {
    return successResponse({
      alive: true,
      timestamp: now()
    });
  }
}
