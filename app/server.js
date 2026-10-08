'use strict';

const express = require('express');
const client = require('prom-client');

const PORT = process.env.PORT || 3000;
const APP_NAME = process.env.APP_NAME || 'orderflow';

function toRate(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

const BASE_FAILURE_RATE = toRate(process.env.PAYMENT_FAILURE_RATE, 0.05);

const app = express();
app.use(express.json({ limit: '32kb' }));

// ---- Prometheus instrumentation ------------------------------------------------
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests handled',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

const inflightRequests = new client.Gauge({
  name: 'http_requests_in_flight',
  help: 'Number of HTTP requests currently being processed',
  registers: [register],
});

// Business metrics: these are what actually answer "is the store making money?".
const ordersTotal = new client.Counter({
  name: 'orders_total',
  help: 'Orders by final status',
  labelNames: ['status'],
  registers: [register],
});

const paymentFailures = new client.Counter({
  name: 'payment_failures_total',
  help: 'Failed payment attempts by reason',
  labelNames: ['reason'],
  registers: [register],
});

const orderValue = new client.Histogram({
  name: 'order_value',
  help: 'Value of confirmed orders',
  buckets: [250, 500, 1000, 2500, 5000, 10000, 25000],
  registers: [register],
});

const inventoryUnits = new client.Gauge({
  name: 'inventory_units',
  help: 'Units currently in stock, per product',
  labelNames: ['product'],
  registers: [register],
});

const paymentFailureRate = new client.Gauge({
  name: 'payment_failure_rate',
  help: 'Payment failure rate currently in effect (0-1)',
  registers: [register],
});

const revenueCollected = new client.Gauge({
  name: 'revenue_collected',
  help: 'Total revenue from confirmed orders',
  registers: [register],
});

function routeLabel(req) {
  return (req.route && req.route.path) || req.path;
}

app.use((req, res, next) => {
  inflightRequests.inc();
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const labels = {
      method: req.method,
      route: routeLabel(req),
      status_code: String(res.statusCode),
    };
    httpRequestsTotal.inc(labels);
    end(labels);
    inflightRequests.dec();
  });
  next();
});

// ---- Domain --------------------------------------------------------------------
const products = [
  { id: 'p-100', name: 'Wireless Mouse', price: 799, stock: 120 },
  { id: 'p-101', name: 'Mechanical Keyboard', price: 3499, stock: 40 },
  { id: 'p-102', name: '27-inch Monitor', price: 14999, stock: 15 },
  { id: 'p-103', name: 'USB-C Hub', price: 1299, stock: 80 },
  { id: 'p-104', name: 'HD Webcam', price: 2199, stock: 0 }, // sold out: exercises the 409 path
];
const initialStock = new Map(products.map((p) => [p.id, p.stock]));

const orders = new Map();
let orderSeq = 0;
let revenue = 0;

// Every order attempt is counted here, including the ones rejected before an order
// record exists (invalid payload / out of stock). /api/stats reads this, so the
// dashboard and the stats endpoint always agree with the orders_total metric.
const statusCounts = { confirmed: 0, payment_failed: 0, invalid: 0, out_of_stock: 0 };

function countStatus(status) {
  statusCounts[status] = (statusCounts[status] || 0) + 1;
  ordersTotal.inc({ status });
}

for (const p of products) inventoryUnits.set({ product: p.id }, p.stock);

// Chaos window used to demo alerting: temporarily spike the payment failure rate.
let chaos = { until: 0, rate: 0 };

function activeFailureRate() {
  return Date.now() < chaos.until ? chaos.rate : BASE_FAILURE_RATE;
}

function reject(res, httpStatus, status, message) {
  countStatus(status);
  res.status(httpStatus).json({ error: status, message });
}

// ---- Routes --------------------------------------------------------------------
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${APP_NAME} — order API</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 52rem; margin: 3rem auto; padding: 0 1rem; color: #16202b; line-height: 1.55; }
      code { background: #eef1f5; padding: .15rem .4rem; border-radius: 4px; }
      h1 { margin-bottom: .2rem; }
      .sub { color: #5b6b7c; margin-top: 0; }
      li { margin: .35rem 0; }
      table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
      th, td { border: 1px solid #dfe4ea; padding: .5rem .6rem; text-align: left; font-size: .95rem; }
      th { background: #f5f7fa; }
    </style>
  </head>
  <body>
    <h1>${APP_NAME}</h1>
    <p class="sub">Order-processing API for a small online store.</p>
    <p><strong>Problem:</strong> peak-hour traffic spikes crash small storefronts, and operators only find out
    from angry customers — there is no visibility into failure rate, latency or stock while it happens.</p>
    <p><strong>This service:</strong> accepts orders, validates inventory, simulates payment gateway outcomes,
    and exposes business metrics so the failure is visible within seconds.</p>
    <table>
      <tr><th>Endpoint</th><th>What it does</th></tr>
      <tr><td><code>GET /api/products</code></td><td>Catalogue with live stock levels</td></tr>
      <tr><td><code>POST /api/orders</code></td><td>Place an order <code>{"productId","quantity","customer"}</code></td></tr>
      <tr><td><code>GET /api/orders/:id</code></td><td>Order status</td></tr>
      <tr><td><code>GET /api/stats</code></td><td>Orders, revenue, stock, current failure rate</td></tr>
      <tr><td><code>POST /api/demo/chaos?seconds=30&amp;rate=0.8</code></td><td>Simulate a payment-gateway outage</td></tr>
      <tr><td><code>POST /api/demo/restock</code></td><td>Reset every product to its starting stock</td></tr>
      <tr><td><code>GET /metrics</code></td><td>Prometheus scrape endpoint</td></tr>
      <tr><td><code>GET /healthz</code> / <code>GET /readyz</code></td><td>Kubernetes probes</td></tr>
    </table>
  </body>
</html>`);
});

app.get('/api/products', (_req, res) => {
  res.json({ products });
});

app.get('/api/products/:id', (req, res) => {
  const product = products.find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'not_found', message: 'no such product' });
  res.json(product);
});

app.post('/api/orders', (req, res) => {
  const body = req.body || {};
  const product = products.find((p) => p.id === body.productId);
  const quantity = Number(body.quantity);
  const customer = typeof body.customer === 'string' ? body.customer.trim() : '';

  if (!product) return reject(res, 400, 'invalid', 'unknown productId');
  if (!Number.isInteger(quantity) || quantity < 1) {
    return reject(res, 400, 'invalid', 'quantity must be a positive integer');
  }
  if (!customer) return reject(res, 400, 'invalid', 'customer is required');
  if (product.stock < quantity) {
    return reject(res, 409, 'out_of_stock', `only ${product.stock} unit(s) of ${product.id} left`);
  }

  const rate = activeFailureRate();
  const value = product.price * quantity;
  const id = `ord-${String(++orderSeq).padStart(5, '0')}`;
  const createdAt = new Date().toISOString();
  paymentFailureRate.set(rate);

  if (Math.random() < rate) {
    paymentFailures.inc({ reason: 'gateway_declined' });
    countStatus('payment_failed');
    const order = { id, status: 'payment_failed', productId: product.id, quantity, unitPrice: product.price, value, customer, createdAt };
    orders.set(id, order);
    return res.status(502).json({ error: 'payment_failed', message: 'payment gateway declined the order', order });
  }

  product.stock -= quantity;
  revenue += value;
  inventoryUnits.set({ product: product.id }, product.stock);
  revenueCollected.set(revenue);
  orderValue.observe(value);
  countStatus('confirmed');

  const order = { id, status: 'confirmed', productId: product.id, quantity, unitPrice: product.price, value, customer, createdAt };
  orders.set(id, order);
  res.status(201).json(order);
});

app.get('/api/orders', (req, res) => {
  let list = [...orders.values()];
  if (req.query.status) list = list.filter((o) => o.status === req.query.status);
  res.json({ count: list.length, orders: list });
});

app.get('/api/orders/:id', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'not_found', message: 'no such order' });
  res.json(order);
});

app.get('/api/stats', (_req, res) => {
  res.json({
    attempts: Object.values(statusCounts).reduce((a, b) => a + b, 0),
    orders: orders.size,
    byStatus: { ...statusCounts },
    revenue,
    stockUnits: products.reduce((sum, p) => sum + p.stock, 0),
    baseFailureRate: BASE_FAILURE_RATE,
    currentFailureRate: activeFailureRate(),
    chaosActive: Date.now() < chaos.until,
  });
});

app.post('/api/demo/restock', (_req, res) => {
  for (const p of products) {
    p.stock = initialStock.get(p.id);
    inventoryUnits.set({ product: p.id }, p.stock);
  }
  res.json({ restocked: true, stockUnits: products.reduce((s, p) => s + p.stock, 0) });
});

app.post('/api/demo/chaos', (req, res) => {
  const seconds = Math.min(Math.max(Number(req.query.seconds) || 0, 0), 300);
  const rate = toRate(req.query.rate, 1);
  chaos = seconds > 0 ? { until: Date.now() + seconds * 1000, rate } : { until: 0, rate: 0 };
  paymentFailureRate.set(activeFailureRate());
  res.json({ chaosActive: seconds > 0, seconds, failureRate: activeFailureRate() });
});

// ---- Platform endpoints --------------------------------------------------------
app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(String(err));
  }
});

app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));
app.get('/readyz', (_req, res) => res.status(200).json({ status: 'ready' }));

app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ error: 'invalid', message: 'request body must be valid JSON' });
  }
  res.status(500).json({ error: 'internal', message: 'unexpected failure' });
});

// ---- Start ----------------------------------------------------------------------
const server = app.listen(PORT, () => {
  const { port } = server.address();
  global.__testBase = `http://127.0.0.1:${port}`;
  console.log(`${APP_NAME} listening on :${port}`);
});

module.exports = server;
