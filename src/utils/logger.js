// Structured Logging System
import { now } from './helpers.js';

/**
 * Log levels
 */
export const LogLevel = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG'
};

/**
 * Logger class for structured logging
 */
export class Logger {
  constructor(context = {}) {
    this.context = context;
    this.enabledLevels = new Set([
      LogLevel.ERROR,
      LogLevel.WARN,
      LogLevel.INFO
      // LogLevel.DEBUG  // Uncomment for debug logging
    ]);
  }

  /**
   * Create log entry with structured format
   */
  createLogEntry(level, message, data = {}) {
    return {
      timestamp: now(),
      level,
      message,
      ...this.context,
      ...data
    };
  }

  /**
   * Log error
   */
  error(message, error, data = {}) {
    if (!this.enabledLevels.has(LogLevel.ERROR)) return;

    const logEntry = this.createLogEntry(LogLevel.ERROR, message, {
      ...data,
      error: error ? {
        message: error.message,
        stack: error.stack,
        name: error.name
      } : undefined
    });

    console.error(JSON.stringify(logEntry));
  }

  /**
   * Log warning
   */
  warn(message, data = {}) {
    if (!this.enabledLevels.has(LogLevel.WARN)) return;

    const logEntry = this.createLogEntry(LogLevel.WARN, message, data);
    console.warn(JSON.stringify(logEntry));
  }

  /**
   * Log info
   */
  info(message, data = {}) {
    if (!this.enabledLevels.has(LogLevel.INFO)) return;

    const logEntry = this.createLogEntry(LogLevel.INFO, message, data);
    console.error(JSON.stringify(logEntry));

  }

  /**
   * Log debug
   */
  debug(message, data = {}) {
    if (!this.enabledLevels.has(LogLevel.DEBUG)) return;

    const logEntry = this.createLogEntry(LogLevel.DEBUG, message, data);
    console.error(JSON.stringify(logEntry));

  }

  /**
   * Create child logger with additional context
   */
  child(additionalContext = {}) {
    return new Logger({
      ...this.context,
      ...additionalContext
    });
  }

  /**
   * Log API request
   */
  logRequest(request, userId = null) {
    const url = new URL(request.url);

    return this.info('API Request', {
      method: request.method,
      path: url.pathname,
      query: url.search,
      userId,
      userAgent: request.headers.get('User-Agent'),
      ip: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')
    });
  }

  /**
   * Log API response
   */
  logResponse(request, response, duration) {
    const url = new URL(request.url);

    let level;
    if (response.status >= 500) {
      level = LogLevel.ERROR;
    } else if (response.status >= 400) {
      level = LogLevel.WARN;
    } else {
      level = LogLevel.INFO;
    }

    const logEntry = this.createLogEntry(level, 'API Response', {
      method: request.method,
      path: url.pathname,
      status: response.status,
      duration: `${duration}ms`
    });

    if (level === LogLevel.ERROR) {
      console.error(JSON.stringify(logEntry));
    } else if (level === LogLevel.WARN) {
      console.warn(JSON.stringify(logEntry));
    } else {
      console.error(JSON.stringify(logEntry));
    }

    return logEntry;
  }

  /**
   * Log database query
   */
  logQuery(query, params = [], duration = 0) {
    return this.debug('Database Query', {
      query: query.substring(0, 200), // Truncate long queries
      paramCount: params.length,
      duration: `${duration}ms`
    });
  }

  /**
   * Log security event
   */
  logSecurityEvent(event, data = {}) {
    return this.warn('Security Event', {
      event,
      ...data
    });
  }

  /**
   * Log performance metric
   */
  logPerformance(metric, value, unit = 'ms') {
    return this.info('Performance Metric', {
      metric,
      value,
      unit
    });
  }
}

/**
 * Create default logger
 */
export function createLogger(context = {}) {
  return new Logger(context);
}

/**
 * Global logger instance
 */
export const logger = new Logger({ service: 'xora-api' });
