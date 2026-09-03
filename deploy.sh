#!/usr/bin/env bash
set -e

echo "🟣 Tojey deployment prep"
echo "========================="

# 1. Install all deps
echo "==> Installing root deps (frontend auto-builds)..."
npm install

# 2. Install backend deps
echo "==> Installing backend deps..."
npm --prefix backend install

# 3. Build frontend explicitly (if postinstall didn't)
if [ ! -d "frontend/dist/index.html" ]; then
  echo "==> Building frontend..."
  npm --prefix frontend run build
fi

echo ""
echo "✅ Build complete!"
echo ""
echo "Next steps:"
echo "  1. Create a GitHub repo and push this folder"
echo "  2. Set up Neon Postgres and copy the pooled connection string"
echo "  3. On Render: New -> Web Service -> connect your GitHub repo"
echo "     - Root Directory: . (root)"
echo "     - Build Command:  npm install && npm --prefix backend install"
echo "     - Start Command:  npm --prefix backend run start"
echo "  4. Add env vars: DATABASE_URL, JWT_SECRET, PORT=10000"
echo "  5. Deploy!"
