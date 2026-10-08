'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let server;
let base;
let lastOrderId;

before(async () => {
  process.env.PORT = '0';
  process.env.PAYMENT_FAILURE_RATE = '0'; // deterministic: payments only fail when chaos is on
  server = require('./server.js');
  // PORT=0 lets the OS pick a free port; server.js exposes it on global.__testBase.
  await new Promise((r) => setTimeout(r, 300));
  base = global.__testBase;
  assert.ok(base, 'server did not start');
});

after(() => {
  if (server) server.close();
});

test('landing page states the problem and the endpoints', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Problem:/);
  assert.match(html, /POST \/api\/orders/);
});

test('GET /api/products returns the catalogue with stock', async () => {
  const res = await fetch(base + '/api/products');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.products));
  assert.ok(body.products.length >= 5);
  for (const p of body.products) {
    assert.equal(typeof p.id, 'string');
    assert.equal(typeof p.price, 'number');
    assert.equal(typeof p.stock, 'number');
  }
});

test('POST /api/orders rejects an unknown product', async () => {
  const res = await fetch(base + '/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productId: 'nope', quantity: 1, customer: 'ayush' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'invalid');
});

test('POST /api/orders rejects a non-positive quantity', async () => {
  const res = await fetch(base + '/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productId: 'p-100', quantity: 0, customer: 'ayush' }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid');
});

test('POST /api/orders returns 409 when stock is exhausted', async () => {
  const res = await fetch(base + '/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productId: 'p-104', quantity: 1, customer: 'ayush' }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'out_of_stock');
});

test('POST /api/orders confirms an order and decrements stock', async () => {
  const before = await (await fetch(base + '/api/products/p-103')).json();
  const res = await fetch(base + '/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productId: 'p-103', quantity: 2, customer: 'ayush' }),
  });
  assert.equal(res.status, 201);
  const order = await res.json();
  assert.equal(order.status, 'confirmed');
  assert.equal(order.value, before.price * 2);
  assert.match(order.id, /^ord-\d{5}$/);
  lastOrderId = order.id;

  const after = await (await fetch(base + '/api/products/p-103')).json();
  assert.equal(after.stock, before.stock - 2);
});

test('confirmed order is retrievable by id', async () => {
  const res = await fetch(`${base}/api/orders/${lastOrderId}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'confirmed');
});

test('chaos at rate 1.0 makes payment fail with 502', async () => {
  const on = await fetch(`${base}/api/demo/chaos?seconds=10&rate=1`, { method: 'POST' });
  assert.equal(on.status, 200);
  assert.equal((await on.json()).failureRate, 1);

  try {
    const res = await fetch(base + '/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'p-100', quantity: 1, customer: 'ayush' }),
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'payment_failed');
    assert.equal(body.order.status, 'payment_failed');
  } finally {
    const off = await fetch(`${base}/api/demo/chaos?seconds=0`, { method: 'POST' });
    assert.equal(off.status, 200);
  }
});

test('GET /api/stats reports orders, revenue and stock', async () => {
  const res = await fetch(base + '/api/stats');
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.ok(s.orders >= 2, 'expected at least two recorded orders');
  assert.ok(s.byStatus.confirmed >= 1);
  assert.ok(s.byStatus.payment_failed >= 1);
  assert.ok(s.byStatus.invalid >= 2, 'invalid rejections must be counted in stats');
  assert.ok(s.byStatus.out_of_stock >= 1, 'out-of-stock rejections must be counted in stats');
  assert.ok(s.attempts >= s.orders, 'attempts cannot be lower than recorded orders');
  assert.ok(s.revenue > 0);
  assert.equal(typeof s.stockUnits, 'number');
  assert.equal(s.chaosActive, false);
});

test('GET /metrics exposes business and http metrics', async () => {
  const res = await fetch(base + '/metrics');
  assert.equal(res.status, 200);
  const text = await res.text();
  for (const metric of [
    'http_requests_total',
    'http_request_duration_seconds_bucket',
    'orders_total',
    'payment_failures_total',
    'order_value_bucket',
    'inventory_units',
    'payment_failure_rate',
    'revenue_collected',
    'process_cpu_seconds_total',
  ]) {
    assert.ok(text.includes(metric), `missing metric ${metric}`);
  }
});

test('GET /healthz is healthy', async () => {
  const res = await fetch(base + '/healthz');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
});

test('unknown route returns 404', async () => {
  const res = await fetch(base + '/nope');
  assert.equal(res.status, 404);
});

test('POST /api/demo/restock restores starting stock levels', async () => {
  const res = await fetch(base + '/api/demo/restock', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.restocked, true);

  const catalog = await (await fetch(base + '/api/products')).json();
  const p103 = catalog.products.find((p) => p.id === 'p-103');
  assert.equal(p103.stock, 80, 'p-103 should be back to its starting stock of 80');
});
