#!/usr/bin/env node

/**
 * System Resource Monitor for Stress Testing
 * Monitors CPU, memory, and backend response times during load tests
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

class SystemMonitor {
  constructor() {
    this.startTime = Date.now();
    this.metrics = [];
    this.interval = null;
  }

  start(intervalMs = 5000) {
    console.log('📊 Starting system monitoring...');
    console.log('================================');

    this.interval = setInterval(() => {
      this.collectMetrics();
    }, intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.generateReport();
    }
  }

  collectMetrics() {
    const timestamp = Date.now();
    const elapsed = (timestamp - this.startTime) / 1000;

    // Get system metrics
    const cpuUsage = process.cpuUsage();
    const memUsage = process.memoryUsage();
    const systemMem = os.totalmem() - os.freemem();

    // Test backend response time
    this.testBackendResponse().then(responseTime => {
      const metric = {
        timestamp,
        elapsed: Math.round(elapsed),
        cpu: {
          user: cpuUsage.user / 1000, // Convert to milliseconds
          system: cpuUsage.system / 1000
        },
        memory: {
          rss: Math.round(memUsage.rss / 1024 / 1024), // MB
          heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
          systemUsed: Math.round(systemMem / 1024 / 1024)
        },
        backend: {
          responseTime
        }
      };

      this.metrics.push(metric);
      this.displayCurrentMetrics(metric);
      return metric; // Return to satisfy ESLint promise/always-return
    }).catch(err => {
      console.log(`⚠️  Backend response test failed: ${err.message}`);
      return null; // Return to satisfy ESLint promise/always-return
    });
  }

  async testBackendResponse() {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const curl = spawn('curl', ['-s', '-o', '/dev/null', '-w', '%{time_total}', 'http://localhost:8787/health'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let output = '';
      curl.stdout.on('data', (data) => {
        output += data.toString();
      });

      curl.on('close', (code) => {
        if (code === 0) {
          const responseTime = parseFloat(output) * 1000; // Convert to milliseconds
          resolve(Math.round(responseTime));
        } else {
          reject(new Error('Request failed'));
        }
      });

      curl.on('error', reject);

      // Timeout after 10 seconds
      setTimeout(() => {
        curl.kill();
        reject(new Error('Timeout'));
      }, 10000);
    });
  }

  displayCurrentMetrics(metric) {
    console.log(`[${metric.elapsed}s] CPU: ${metric.cpu.user + metric.cpu.system}ms | ` +
                `Mem: ${metric.memory.heapUsed}/${metric.memory.heapTotal}MB | ` +
                `Backend: ${metric.backend.responseTime}ms`);
  }

  generateReport() {
    console.log('\n📈 Generating performance report...');
    console.log('====================================');

    if (this.metrics.length === 0) {
      console.log('No metrics collected');
      return;
    }

    // Calculate averages and peaks
    const cpuAvg = this.metrics.reduce((sum, m) => sum + m.cpu.user + m.cpu.system, 0) / this.metrics.length;
    const memPeak = Math.max(...this.metrics.map(m => m.heapUsed));
    const responseTimes = this.metrics.map(m => m.backend.responseTime).filter(t => t > 0);
    const avgResponseTime = responseTimes.reduce((sum, t) => sum + t, 0) / responseTimes.length;
    const maxResponseTime = Math.max(...responseTimes);

    console.log(`Duration: ${this.metrics[this.metrics.length - 1].elapsed} seconds`);
    console.log(`Average CPU usage: ${Math.round(cpuAvg)}ms`);
    console.log(`Peak memory usage: ${memPeak}MB`);
    console.log(`Average response time: ${Math.round(avgResponseTime)}ms`);
    console.log(`Max response time: ${maxResponseTime}ms`);

    // Performance assessment
    console.log('\n🎯 Performance Assessment:');
    if (avgResponseTime < 100) {
      console.log('✅ Excellent: < 100ms average response time');
    } else if (avgResponseTime < 500) {
      console.log('👍 Good: < 500ms average response time');
    } else if (avgResponseTime < 1000) {
      console.log('⚠️  Fair: < 1s average response time');
    } else {
      console.log('❌ Poor: > 1s average response time');
    }

    // Save detailed report
    const reportPath = path.join(process.cwd(), 'stress-test-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      summary: {
        duration: this.metrics[this.metrics.length - 1].elapsed,
        avgCpuUsage: Math.round(cpuAvg),
        peakMemory: memPeak,
        avgResponseTime: Math.round(avgResponseTime),
        maxResponseTime
      },
      metrics: this.metrics
    }, null, 2));

    console.log(`\n📄 Detailed report saved to: ${reportPath}`);
  }
}

// Main execution
const monitor = new SystemMonitor();

// Start monitoring
monitor.start();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n⏹️  Stopping monitoring...');
  monitor.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  monitor.stop();
  process.exit(0);
});

console.log('Monitoring started. Press Ctrl+C to stop and generate report.');