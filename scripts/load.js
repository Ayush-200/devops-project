#!/usr/bin/env node
'use strict';

// Generates a traffic spike against the order API so the dashboards have something
// to show. Usage:
//   node scripts/load.js [durationSeconds] [requestsPerSecond] [baseUrl]
// Examples:
//   node scripts/load.js 30 40
//   node scripts/load.js 60 100 http://localhost:3000

const BASE = process.argv[4] || process.env.BASE_URL || 'http://localhost:3000';
const DURATION_S = Number(process.argv[2] || 30);
const RPS = Number(process.argv[3] || 40);

const products = ['p-100', 'p-101', 'p-102', 'p-103'];
const names = ['ayush', 'priya', 'rahul', 'sneha', 'dev'];

let sent = 0;
let ok = 0;
let failed = 0;
const started = Date.now();

function order() {
  return fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      productId: products[Math.floor(Math.random() * products.length)],
      quantity: 1 + Math.floor(Math.random() * 2),
      customer: names[Math.floor(Math.random() * names.length)],
    }),
  }).then(
    (r) => {
      sent += 1;
      if (r.ok) ok += 1;
      else failed += 1;
      return r.body ? r.text() : null;
    },
    () => {
      sent += 1;
      failed += 1;
    }
  );
}

console.log(`Hitting ${BASE} at ${RPS} req/s for ${DURATION_S}s ...`);

const timer = setInterval(order, Math.max(1, Math.round(1000 / RPS)));

setTimeout(() => {
  clearInterval(timer);
  setTimeout(async () => {
    const elapsed = (Date.now() - started) / 1000;
    console.log(`\nDone in ${elapsed.toFixed(1)}s`);
    console.log(`  requests sent : ${sent}`);
    console.log(`  2xx           : ${ok}`);
    console.log(`  non-2xx       : ${failed}`);
    try {
      const stats = await (await fetch(`${BASE}/api/stats`)).json();
      console.log('  store stats   :', JSON.stringify(stats));
      console.log('\nNow open Grafana and watch the Orders / Failure-rate panels.');
    } catch {
      /* stats are informational only */
    }
  }, 500);
}, DURATION_S * 1000);
