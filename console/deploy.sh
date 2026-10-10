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
# Each Mac pairs itself with its own token. ADMIN_TOKEN is only for consoles set up before that:
# ADMIN_TOKEN=... sh deploy.sh keeps their one Mac reachable with the old shared token.
if [ -n "$ADMIN_TOKEN" ]; then printf '%s' "$ADMIN_TOKEN" | npx -y wrangler@4 secret put ADMIN_TOKEN; fi
npx -y wrangler@4 deploy
echo
echo "Next: build the Mac app with CONSOLE_URL set to the workers.dev URL above (sh mac/build.sh) and install it."
echo "Every Mac pairs itself and shows a QR code for its phone."
