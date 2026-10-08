#!/usr/bin/env bash
# Build the app image inside the minikube Docker daemon, then apply every manifest.
# Usage: ./k8s/deploy.sh
set -euo pipefail

IMAGE="${IMAGE:-devops-demo-app:latest}"
cd "$(dirname "$0")/.."

if ! command -v minikube >/dev/null 2>&1; then
  echo "minikube not found. Install it first: https://minikube.sigs.k8s.io/docs/start/" >&2
  exit 1
fi

echo "==> Pointing docker at the minikube daemon"
# --shell bash is required: on Windows minikube otherwise emits cmd.exe syntax (SET/REM).
minikube docker-env --shell bash | grep '^export ' > /tmp/minikube-docker-env.sh
# shellcheck disable=SC1091
. /tmp/minikube-docker-env.sh
echo "    DOCKER_HOST=${DOCKER_HOST:-default}"

echo "==> Building ${IMAGE}"
docker build -t "${IMAGE}" ./app

echo "==> Applying manifests to context: $(kubectl config current-context)"
kubectl apply -f k8s/

echo "==> Waiting for the app rollout"
kubectl -n demo rollout status deployment/devops-demo-app --timeout=180s

echo "==> Workloads"
kubectl get pods -n demo -o wide
kubectl get pods -n monitoring

cat <<EOF

Done. Useful commands:
  minikube service devops-demo-app -n demo --url   # app URL
  minikube service grafana -n monitoring --url     # grafana URL (admin/admin)
  kubectl port-forward -n monitoring svc/prometheus 9090:9090   # prometheus UI
EOF
