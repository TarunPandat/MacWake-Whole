#!/bin/sh
# Deploy the console to Cloudflare Workers (free tier). Needs Node 22+.
set -e
cd "$(dirname "$0")"
npx -y wrangler@4 whoami >/dev/null 2>&1 || npx -y wrangler@4 login
if grep -q REPLACE_WITH_KV_ID wrangler.toml; then
  ID=$(npx -y wrangler@4 kv namespace create STATE 2>&1 | grep -oE '[0-9a-f]{32}' | head -1)
  [ -n "$ID" ] || { echo "could not read KV id, run: npx wrangler kv namespace create STATE"; exit 1; }
  sed -i '' "s/REPLACE_WITH_KV_ID/$ID/" wrangler.toml
fi
# Set the token only on first deploy or when ADMIN_TOKEN is given; re-running must not rotate it.
if [ -n "$ADMIN_TOKEN" ] || ! npx -y wrangler@4 secret list 2>/dev/null | grep -q ADMIN_TOKEN; then
  TOKEN=${ADMIN_TOKEN:-$(openssl rand -hex 24)}
  printf '%s' "$TOKEN" | npx -y wrangler@4 secret put ADMIN_TOKEN
fi
npx -y wrangler@4 deploy
echo
[ -n "$TOKEN" ] && echo "ADMIN TOKEN (save it, paste into phone console and Mac app): $TOKEN" || echo "ADMIN_TOKEN unchanged (export ADMIN_TOKEN=... to set a new one)"
