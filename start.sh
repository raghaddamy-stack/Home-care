#!/usr/bin/env bash
# One-command start: installs, builds the web console, and serves everything on http://localhost:3000
set -e
cd "$(dirname "$0")"
node -e 'const [maj]=process.versions.node.split(".").map(Number); if (maj < 22) { console.error("Node.js 22 or newer is required: https://nodejs.org"); process.exit(1) }'
(cd backend && npm ci)
(cd web && npm ci && npm run build)
echo "Open http://localhost:3000"
cd backend && npm start
