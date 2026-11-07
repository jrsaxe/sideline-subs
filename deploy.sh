#!/bin/sh
# Test, then publish the app:
#  1. Home Assistant www folder (served at /local/soccer/) if the HA "config" share is mounted
#  2. GitHub Pages (push to main) if this is a git repo with a remote
set -e
cd "$(dirname "$0")"
node test/engine.test.cjs >/dev/null && echo "tests ok"

# bump the service-worker cache name so phones pick up the new version
STAMP=$(date +%Y%m%d%H%M%S)
sed -i '' "s/^const CACHE = 'subs-[^']*';/const CACHE = 'subs-$STAMP';/" sw.js

if [ -d /Volumes/config/www ]; then
  DEST=/Volumes/config/www/soccer
  mkdir -p "$DEST"
  cp index.html engine.js sw.js manifest.json icon-180.png icon-512.png "$DEST/"
  echo "HA: deployed to $DEST"
else
  echo "HA: config share not mounted at /Volumes/config, skipped"
fi

if git remote get-url origin >/dev/null 2>&1; then
  git add -A
  git commit -qm "Deploy $STAMP" || true
  git push -q origin main
  echo "GitHub: pushed (Pages updates in ~1 min)"
fi
