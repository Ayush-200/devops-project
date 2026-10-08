# OrderFlow — DevOps Delivery & Observability Project

An order-processing API for a small online store, wrapped in a complete DevOps toolchain:
**Docker, Kubernetes, Prometheus, Grafana and Jenkins.**

---

## 1. Problem statement

> **Small online stores lose revenue during traffic spikes — and they find out from customers, not from their systems.**

A typical small storefront has no way to answer, in real time:

* *Are orders actually succeeding right now?* — the payment gateway can be declining 40% of transactions while the site looks "up".
* *Are customers being served fast enough?* — a slow checkout is invisible to a CPU graph.
* *Do we still have stock?* — overselling happens when inventory is only checked against a spreadsheet.
* *What broke, and when?* — releases are deployed by hand, so nobody can tie a failure to a change.

Uptime monitoring does not solve any of this: a container can be at 2% CPU while failing
half of its requests. **The gap is business-level observability plus automated delivery.**

## 2. What this project builds

**OrderFlow** is a working storefront API that:

1. exposes a product catalogue with **live stock**,
2. accepts orders, **validates inventory**, and simulates payment-gateway outcomes,
3. records **business metrics** (orders by status, payment failures, order value, revenue, stock)
   alongside technical metrics (rate, latency, in-flight),
4. ships through an **automated pipeline** into a **self-healing, scalable** cluster,
5. renders all of it on a **dashboard**, so a failure is visible within ~15 seconds.

| Requirement | Tool | How it is used here |
|---|---|---|
| Environment consistency | **Docker** | Multi-stage `app/Dockerfile`, non-root, healthcheck; `docker-compose.yml` runs the whole stack |
| Repeatable delivery | **Jenkins** | `Jenkinsfile`: test → build → scan → push → deploy, all as code |
| Orchestration & self-healing | **Kubernetes (minikube)** | 2 replicas, liveness/readiness probes, resource limits, NodePort services, RBAC |
| Business + technical metrics | **Prometheus** | Scrapes `/metrics` every 15s via Kubernetes pod service discovery |
| Visualisation | **Grafana** | Provisioned datasource + a 10-panel dashboard, auto-loaded on startup |

### Architecture

```
Developer pushes code
   → Jenkins: npm test → docker build → (push) → kubectl apply
        → Kubernetes: 2 replicas in ns/demo, probes restart unhealthy pods
             → OrderFlow serves orders on :3000 and exposes /metrics
                  → Prometheus (ns/monitoring) scrapes annotated pods
                       → Grafana renders rate, errors, latency, orders, revenue, stock
```

---

## 3. The API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Landing page with the problem statement |
| `GET` | `/api/products` | Catalogue with live stock |
| `GET` | `/api/products/:id` | Single product |
| `POST` | `/api/orders` | Place an order — `{"productId","quantity","customer"}` |
| `GET` | `/api/orders?status=` | List orders |
| `GET` | `/api/orders/:id` | Order status |
| `GET` | `/api/stats` | Orders, revenue, stock, current failure rate |
| `POST` | `/api/demo/chaos?seconds=30&rate=0.8` | Simulate a payment-gateway outage |
| `POST` | `/api/demo/restock` | Reset every product to its starting stock |
| `GET` | `/metrics` | Prometheus scrape endpoint |
| `GET` | `/healthz` · `/readyz` | Kubernetes probes |

Validation paths (each one is tested): unknown product → **400**, bad quantity → **400**,
insufficient stock → **409**, gateway decline → **502**, success → **201**.

### Metrics exposed

| Metric | Type | Answers |
|---|---|---|
| `http_requests_total{method,route,status_code}` | counter | Traffic and HTTP error rate |
| `http_request_duration_seconds` | histogram | Latency p50 / p95 / p99 |
| `http_requests_in_flight` | gauge | Concurrency / saturation |
| `orders_total{status}` | counter | Are orders succeeding? (`confirmed`, `payment_failed`, `invalid`, `out_of_stock`) |
| `payment_failures_total{reason}` | counter | Why payments fail |
| `order_value` | histogram | Value distribution of confirmed orders |
| `inventory_units{product}` | gauge | Stock levels |
| `payment_failure_rate` | gauge | Failure rate currently in effect |
| `revenue_collected` | gauge | Revenue from confirmed orders |
| Node defaults | — | CPU, RSS, GC |

---

## 4. Run it — Docker Compose (fastest)

```bash
docker compose up -d --build
```

| Service | URL | Credentials |
|---|---|---|
| OrderFlow | http://localhost:3000 | — |
| Prometheus | http://localhost:9090 | — |
| Grafana | http://localhost:3001 | `admin` / `admin` |

### The demo (2 minutes)

```bash
# 1. healthy traffic
node scripts/load.js 20 30

# 2. simulate a payment gateway outage
curl -X POST "http://localhost:3000/api/demo/chaos?seconds=45&rate=0.8"
node scripts/load.js 30 40

# 3. watch Grafana: "Payment failure rate" jumps, "Orders by status" shifts
#    to payment_failed, HTTP error rate climbs.

# 4. chaos expires on its own (or clear it early), then restock for the next run
curl -X POST "http://localhost:3000/api/demo/chaos?seconds=0"
curl -X POST "http://localhost:3000/api/demo/restock"
```

In Grafana open **Dashboards → OrderFlow - Store Overview**.
In Prometheus open **Status → Targets** (`devops-demo-app` = `UP`) and try:

```promql
100 * sum(rate(payment_failures_total[1m]))
    / clamp_min(sum(rate(orders_total{status=~"confirmed|payment_failed"}[1m])), 0.0001)
```

Tear down: `docker compose down -v`

---

## 5. Run it — Kubernetes (minikube)

```bash
minikube start
./k8s/deploy.sh          # builds the image inside minikube + kubectl apply -f k8s/
```

| Namespace | Resources |
|---|---|
| `demo` | `Deployment/devops-demo-app` (2 replicas), `Service` NodePort **30080** |
| `monitoring` | `prometheus` + `grafana` Deployments, `grafana` NodePort **30030** |
| cluster | `ServiceAccount/prometheus`, `ClusterRole`, `ClusterRoleBinding` (pod discovery) |

```bash
kubectl get pods -A
kubectl -n demo logs deploy/devops-demo-app --tail=20

kubectl -n demo        port-forward svc/devops-demo-app 3000:3000   # app
kubectl -n monitoring  port-forward svc/grafana         3001:3000   # grafana
kubectl -n monitoring  port-forward svc/prometheus      9090:9090   # prometheus
```

### How Prometheus finds the app

The pod carries these annotations (`k8s/08-app.yaml`):

```yaml
prometheus.io/scrape: "true"
prometheus.io/port:    "3000"
prometheus.io/path:    "/metrics"
```

Prometheus uses `kubernetes_sd_configs` with `role: pod`, keeps only annotated pods and
rewrites `__address__` from the port annotation — no hard-coded IPs.

### Scale under load

```bash
kubectl -n demo scale deployment devops-demo-app --replicas=5
```

---

## 6. Jenkins CI/CD

**Plugins:** Docker Pipeline, Kubernetes CLI.

1. **New Item → Pipeline** → this repo, *Pipeline script from SCM* → `Jenkinsfile`.
2. Credentials: `dockerhub` (username/password), `kubeconfig` (secret file).
3. Add a `node-20` tool under **Manage Jenkins → Tools** (or edit `tools.nodejs`).
4. Build.

| Stage | Action | Skips when |
|---|---|---|
| Checkout | pull repo | — |
| Install dependencies | `npm ci` in `app/` | — |
| Test | `npm test` (13 tests) | — |
| Build image | `docker build` with build + `latest` tags | — |
| Scan image | `trivy` HIGH/CRITICAL | trivy missing |
| Push image | `docker login` + push | `PUSH != 'true'` |
| Deploy | `kubectl apply -f k8s` + rollout status | `DEPLOY != 'true'` |

Local Jenkins that can build images:

```bash
docker run -d --name jenkins -p 8080:8080 -p 50000:50000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v jenkins_home:/var/jenkins_home jenkins/jenkins:lts
```

---

## 7. Presentation script

1. **Problem** — show the landing page at `localhost:3000`; state the revenue-loss problem.
2. **Docker** — `docker compose up -d --build`; `docker ps`; three URLs.
3. **Domain** — place an order with `curl`; show validation (400/409/502/201).
4. **Metrics** — `curl localhost:3000/metrics`; contrast `http_requests_total` with `orders_total`.
5. **Prometheus** — Targets `UP`; run the failure-rate PromQL query.
6. **Chaos + Grafana** — fire `/api/demo/chaos`, run `scripts/load.js`, watch the panels move.
7. **Kubernetes** — `./k8s/deploy.sh`, `kubectl get pods -A`, scale to 5 replicas.
8. **Jenkins** — run the pipeline: test → image → deploy in one click.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| Prometheus target `DOWN` | `kubectl -n monitoring logs deploy/prometheus` — usually RBAC; confirm `01-rbac.yaml` applied |
| Dashboard panels "No data" | Check datasource URL and that the pod has `prometheus.io/scrape: "true"` |
| CPU/RSS panels empty in Compose | Confirm `prometheus/prometheus.yml` sets `app: devops-demo-app` on the target |
| `ImagePullBackOff` in `demo` | Image built on the host, not in minikube — rerun `./k8s/deploy.sh` |
| Orders never fail | Default failure rate is 5%; raise it via `POST /api/demo/chaos` or `PAYMENT_FAILURE_RATE` |
| Products sold out mid-demo | `curl -X POST /api/demo/restock` restores starting stock |
| Grafana login fails | `admin` / `admin` (set in compose and `k8s/07-grafana.yaml`) |

## 9. Local development

```bash
cd app
npm install
npm test        # 13 tests
npm run dev     # auto-reload on :3000

# load test from another terminal
node scripts/load.js 30 50
```

## Layout

```
app/                 OrderFlow service + tests + Dockerfile
scripts/load.js      Traffic generator for the spike demo
docker-compose.yml   app + Prometheus + Grafana
prometheus/          Compose scrape config
grafana/             Provisioned datasource, dashboard provider, 10-panel dashboard
k8s/                 15 manifests + deploy.sh
Jenkinsfile          CI/CD pipeline
```
