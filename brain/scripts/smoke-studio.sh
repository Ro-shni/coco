#!/usr/bin/env bash
# Boots the built brain with throwaway tokens and a temp config dir, then checks the Studio API auth.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build >/dev/null
TMP=$(mktemp -d)
export COCO_TOKEN=$(openssl rand -hex 24) COCO_STUDIO_TOKEN=$(openssl rand -hex 24)
export COCO_CONFIG_DIR="$TMP" COCO_DATA_DIR="$TMP" COCO_LOGS_DIR="$TMP"
node dist/main.js >"$TMP/out" 2>"$TMP/err" < <(sleep 30) &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$TMP"' EXIT
for _ in $(seq 1 50); do grep -q COCO_READY "$TMP/out" && break; sleep 0.2; done
PORT=$(sed -n 's/^COCO_READY {"port":\([0-9]*\)}$/\1/p' "$TMP/out")
B="http://127.0.0.1:$PORT"
echo "unauth: $(curl -s -o /dev/null -w '%{http_code}' "$B/api/health") (expect 401)"
echo "bad origin: $(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $COCO_STUDIO_TOKEN" -H 'origin: http://evil.test' "$B/api/health") (expect 403)"
echo "health: $(curl -s -H "authorization: Bearer $COCO_STUDIO_TOKEN" "$B/api/health")"
echo "catalog count: $(curl -s -H "authorization: Bearer $COCO_STUDIO_TOKEN" "$B/api/catalog" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))') (expect 5)"
echo "launch-nonce: $(curl -s -X POST -H "authorization: Bearer $COCO_STUDIO_TOKEN" "$B/api/launch-nonce" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(typeof j.nonce === "string" && /^[0-9a-f]{64}$/.test(j.nonce) ? "ok (64-hex nonce)" : "unexpected: "+s)})') (expect ok)"
