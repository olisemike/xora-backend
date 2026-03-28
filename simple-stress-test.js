#!/usr/bin/env node

/**
 * Simple Stress Test for Xora Backend
 * Simulates concurrent users making requests
 */

const http = require('http');
const https = require('https');

class StressTester {
  constructor(options = {}) {
    this.targetUrl = options.targetUrl || 'http://localhost:8787';
    this.duration = options.duration || 60; // seconds
    this.concurrency = options.concurrency || 100; // concurrent users
    this.requestsPerSecond = options.requestsPerSecond || 50;
    this.endpoints = options.endpoints || [
      '/health',
      '/auth/login'
    ];

    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      responseTimes: [],
      errors: {}
    };

    this.startTime = null;
    this.endTime = null;
  }

  async run() {
    console.log('🚀 Starting Stress Test');
    console.log('======================');
    console.log(`Target: ${this.targetUrl}`);
    console.log(`Duration: ${this.duration} seconds`);
    console.log(`Concurrency: ${this.concurrency} users`);
    console.log(`Rate: ${this.requestsPerSecond} req/sec`);
    console.log('');

    this.startTime = Date.now();
    this.endTime = this.startTime + (this.duration * 1000);

    // Start multiple concurrent user simulations
    const userPromises = [];
    for (let i = 0; i < this.concurrency; i++) {
      userPromises.push(this.simulateUser(i));
    }

    try {
      await Promise.all(userPromises);
    } catch (error) {
      console.error('Test error:', error);
    }

    this.printResults();
  }

  async simulateUser(userId) {
    const interval = 1000 / (this.requestsPerSecond / this.concurrency);

    while (Date.now() < this.endTime) {
      const endpoint = this.endpoints[Math.floor(Math.random() * this.endpoints.length)];
      const url = this.targetUrl + endpoint;

      try {
        const responseTime = await this.makeRequest(url);
        this.stats.totalRequests++;
        this.stats.successfulRequests++;
        this.stats.responseTimes.push(responseTime);

        if (this.stats.totalRequests % 100 === 0) {
          this.printProgress();
        }
      } catch (error) {
        this.stats.totalRequests++;
        this.stats.failedRequests++;
        this.stats.errors[error.message] = (this.stats.errors[error.message] || 0) + 1;
      }

      // Wait before next request
      await this.sleep(interval);
    }
  }

  makeRequest(url) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const client = url.startsWith('https:') ? https : http;

      const req = client.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Xora-Stress-Test/1.0'
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          const responseTime = Date.now() - startTime;
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(responseTime);
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
    });
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  printProgress() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const rps = this.stats.totalRequests / elapsed;
    const avgResponseTime = this.stats.responseTimes.length > 0
      ? this.stats.responseTimes.reduce((a, b) => a + b, 0) / this.stats.responseTimes.length
      : 0;

    process.stdout.write(`\r📊 ${this.stats.totalRequests} requests | ${rps.toFixed(1)} req/sec | ${avgResponseTime.toFixed(0)}ms avg | ${this.stats.failedRequests} errors`);
  }

  printResults() {
    console.log('\n\n📈 Test Results');
    console.log('==============');

    const totalTime = (Date.now() - this.startTime) / 1000;
    const actualRPS = this.stats.totalRequests / totalTime;

    console.log(`Duration: ${totalTime.toFixed(1)} seconds`);
    console.log(`Total Requests: ${this.stats.totalRequests.toLocaleString()}`);
    console.log(`Successful Requests: ${this.stats.successfulRequests.toLocaleString()}`);
    console.log(`Failed Requests: ${this.stats.failedRequests.toLocaleString()}`);
    console.log(`Requests per Second: ${actualRPS.toFixed(1)}`);

    if (this.stats.responseTimes.length > 0) {
      const sorted = [...this.stats.responseTimes].sort((a, b) => a - b);
      const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const p99 = sorted[Math.floor(sorted.length * 0.99)];
      const max = Math.max(...sorted);

      console.log('\nResponse Times:');
      console.log(`  Average: ${avg.toFixed(0)}ms`);
      console.log(`  Median (p50): ${p50}ms`);
      console.log(`  95th percentile: ${p95}ms`);
      console.log(`  99th percentile: ${p99}ms`);
      console.log(`  Maximum: ${max}ms`);
    }

    if (Object.keys(this.stats.errors).length > 0) {
      console.log('\nErrors:');
      Object.entries(this.stats.errors).forEach(([error, count]) => {
        console.log(`  ${error}: ${count}`);
      });
    }

    // Performance assessment
    console.log('\n🎯 Performance Assessment:');
    const successRate = (this.stats.successfulRequests / this.stats.totalRequests) * 100;

    if (successRate > 99) {
      console.log('✅ Excellent: >99% success rate');
    } else if (successRate > 95) {
      console.log('👍 Good: >95% success rate');
    } else if (successRate > 90) {
      console.log('⚠️  Fair: >90% success rate');
    } else {
      console.log('❌ Poor: <90% success rate');
    }

    if (actualRPS > 100) {
      console.log('🚀 High throughput achieved!');
    } else if (actualRPS > 50) {
      console.log('✅ Good throughput');
    } else {
      console.log('⚠️  Low throughput - consider optimization');
    }
  }
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};

  // Parse command line arguments
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace('--', '');
    const value = args[i + 1];

    switch (key) {
      case 'url':
        options.targetUrl = value;
        break;
      case 'duration':
        options.duration = parseInt(value);
        break;
      case 'concurrency':
        options.concurrency = parseInt(value);
        break;
      case 'rate':
        options.requestsPerSecond = parseInt(value);
        break;
    }
  }

  const tester = new StressTester(options);
  tester.run().catch(console.error);
}

module.exports = StressTester;