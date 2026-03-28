/**
 * Circuit Breaker Pattern for D1 Database
 * Prevents cascading failures when database is overwhelmed
 */

import { logger } from '../utils/logger.js';

export class CircuitBreaker {
  constructor(options = {}) {
    this.state = 'CLOSED'; // CLOSED (normal), OPEN (failing), HALF_OPEN (testing)
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.failureTimestamps = [];

    // Config
    this.failureThreshold = options.failureThreshold || 5; // Fail after N errors
    this.windowMs = options.windowMs || 10000; // 10 second rolling window
    this.resetTimeoutMs = options.resetTimeoutMs || 15000; // 15 seconds before retry
    this.onOpen = options.onOpen || null;
    this.onClose = options.onClose || null;
    this.onHalfOpen = options.onHalfOpen || null;
  }

  pruneFailures(currentTime = Date.now()) {
    const cutoff = currentTime - this.windowMs;
    this.failureTimestamps = this.failureTimestamps.filter(timestamp => timestamp >= cutoff);
    this.failureCount = this.failureTimestamps.length;
  }

  /**
   * Check if request can proceed
   * @returns {boolean} True if circuit allows request
   */
  canRequest() {
    if (this.state === 'CLOSED') {
      // Normal operation
      return true;
    }

    if (this.state === 'OPEN') {
      // Circuit is open, check if we can attempt recovery
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure > this.resetTimeoutMs) {
        // Try to recover
        this.state = 'HALF_OPEN';
        this.successCount = 0;
        this.failureCount = 0;
        if (this.onHalfOpen) this.onHalfOpen();
        logger.warn('[CircuitBreaker] State changed to HALF_OPEN');
        return true;
      }
      // Still in cooldown, reject
      return false;
    }

    if (this.state === 'HALF_OPEN') {
      // Allow limited requests during recovery
      return true;
    }

    return false;
  }

  /**
   * Record successful operation
   */
  recordSuccess() {
    this.failureTimestamps = [];
    this.failureCount = 0;

    if (this.state === 'HALF_OPEN') {
      this.successCount += 1;
      // Require 3 successes before full closure
      if (this.successCount >= 3) {
        this.close();
      }
    }
  }

  /**
   * Record failed operation
   */
  recordFailure() {
    const currentTime = Date.now();
    this.lastFailureTime = currentTime;
    this.failureTimestamps.push(currentTime);
    this.pruneFailures(currentTime);

    if (this.state === 'HALF_OPEN') {
      // One failure during recovery = back to OPEN
      this.open();
      return;
    }

    if (this.state === 'CLOSED' && this.failureCount >= this.failureThreshold) {
      this.open();
    }
  }

  /**
   * Manually open circuit
   */
  open() {
    if (this.state !== 'OPEN') {
      this.state = 'OPEN';
      this.lastFailureTime = Date.now();
      if (this.onOpen) this.onOpen();
      logger.error('[CircuitBreaker] State changed to OPEN');
    }
  }

  /**
   * Manually close circuit
   */
  close() {
    if (this.state !== 'CLOSED') {
      this.state = 'CLOSED';
      this.failureCount = 0;
      this.successCount = 0;
      this.failureTimestamps = [];
      if (this.onClose) this.onClose();
      logger.info('[CircuitBreaker] State changed to CLOSED');
    }
  }

  /**
   * Get current state
   */
  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      windowMs: this.windowMs
    };
  }
}

/**
 * Global circuit breaker for D1 writes
 */
let globalWriteBreaker = null;

/**
 * Initialize or get global write circuit breaker
 */
export function getWriteCircuitBreaker() {
  if (!globalWriteBreaker) {
    globalWriteBreaker = new CircuitBreaker({
      failureThreshold: 5,
      windowMs: 10000,
      resetTimeoutMs: 15000,
      onOpen: () => {
        logger.error('[DB] Write circuit breaker OPEN - rejecting writes');
      },
      onClose: () => {
        logger.info('[DB] Write circuit breaker CLOSED - resuming writes');
      },
      onHalfOpen: () => {
        logger.warn('[DB] Write circuit breaker HALF_OPEN - limited write attempts');
      }
    });
  }
  return globalWriteBreaker;
}

export default {
  CircuitBreaker,
  getWriteCircuitBreaker
};
