#!/usr/bin/env node

/**
 * Xora Backend Stress Test Runner
 * Tests the backend with simulated high load
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🚀 Starting Xora Backend Stress Test');
console.log('=====================================');

// Check if backend is running
console.log('📋 Checking backend status...');

const checkBackend = spawn('curl', ['-s', 'http://localhost:8787/health'], {
  stdio: 'pipe'
});

checkBackend.on('close', (code) => {
  if (code !== 0) {
    console.log('❌ Backend not running. Please start with: npm run dev');
    process.exit(1);
  }

  console.log('✅ Backend is running');

  // Start the stress test
  runStressTest();
});

function runStressTest() {
  console.log('\n🔥 Starting stress test...');
  console.log('This will simulate high load on your backend');
  console.log('Press Ctrl+C to stop the test\n');

  const artillery = spawn('npx', ['artillery', 'run', 'stress-test.yml'], {
    stdio: 'inherit',
    cwd: process.cwd()
  });

  artillery.on('close', (code) => {
    console.log(`\n📊 Stress test completed with exit code: ${code}`);
    if (code === 0) {
      console.log('✅ Test passed successfully!');
    } else {
      console.log('⚠️  Test completed with issues');
    }
  });

  artillery.on('error', (err) => {
    console.error('❌ Failed to start stress test:', err);
    process.exit(1);
  });
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n⏹️  Stopping stress test...');
  process.exit(0);
});