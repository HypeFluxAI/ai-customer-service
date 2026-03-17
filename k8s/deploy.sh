#!/bin/bash
# AI Customer Service — K8s 部署脚本
# 在 54 构建服务器上执行

set -e

echo "═══════════════════════════════════════════════"
echo "  AI Customer Service — K8s Deployment"
echo "═══════════════════════════════════════════════"

# ── Step 1: Build Docker image on server 54 ──
echo "[1/5] Building Docker image..."
cd ~/ai-customer-service
docker build -t ytvchsy/ai-customer-service:latest .

# ── Step 2: Push to Docker Hub ──
echo "[2/5] Pushing to Docker Hub..."
docker push ytvchsy/ai-customer-service:latest

# ── Step 3: Create K8s Secret (if not exists) ──
echo "[3/5] Creating K8s Secret..."
ssh ubuntu@122.99.183.55 "
sudo kubectl get secret ai-cs-secret -n node-api 2>/dev/null || \
sudo kubectl create secret generic ai-cs-secret -n node-api \
  --from-literal=MONGO_URI='mongodb://deeplink:DeepLinkGlobal2023@mongo-0.mongo-hs.deeplink.svc.cluster.local:27017,mongo-1.mongo-hs.deeplink.svc.cluster.local:27017,mongo-2.mongo-hs.deeplink.svc.cluster.local:27017/deeplinkgame?replicaSet=deeplink' \
  --from-literal=ZENMUX_API_KEY='sk-ss-v1-27f3f3294d7c7b334d10c44bf7672586c9a514ea918a8746af43d555712f817c' \
  --from-literal=ZENMUX_CHAT_MODEL='anthropic/claude-opus-4.6' \
  --from-literal=ZENMUX_MODEL='anthropic/claude-sonnet-4.5' \
  --from-literal=CHAT_ADMIN_TOKEN='admin123' \
  --from-literal=TEST1_MONGO_URI='mongodb://deeplink:DeepLinkGlobal2023@mongo-0.mongo-hs.deeplink.svc.cluster.local:27017,mongo-1.mongo-hs.deeplink.svc.cluster.local:27017,mongo-2.mongo-hs.deeplink.svc.cluster.local:27017/test1?replicaSet=deeplink'
"

# ── Step 4: Apply K8s deployment ──
echo "[4/5] Applying K8s deployment..."
scp k8s/deployment.yaml ubuntu@122.99.183.55:~/ai-cs-deployment.yaml
ssh ubuntu@122.99.183.55 "sudo kubectl apply -f ~/ai-cs-deployment.yaml"

# ── Step 5: Verify ──
echo "[5/5] Verifying deployment..."
ssh ubuntu@122.99.183.55 "
sudo kubectl rollout status deployment/ai-customer-service -n node-api --timeout=120s
echo ''
echo '=== Pod Status ==='
sudo kubectl get pods -n node-api -l app=ai-customer-service
echo ''
echo '=== Service ==='
sudo kubectl get svc ai-cs-svc -n node-api
echo ''
echo '=== Ingress ==='
sudo kubectl get ingress ai-cs-ingress -n node-api
"

echo ""
echo "═══════════════════════════════════════════════"
echo "  Deployment complete!"
echo "  URL: https://cs.deeplink.cloud"
echo "  Admin: https://cs.deeplink.cloud/terminal/admin.html"
echo "═══════════════════════════════════════════════"
