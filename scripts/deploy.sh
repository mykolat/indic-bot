#!/bin/bash
set -euo pipefail

REMOTE="mykolat@34.179.171.213"
SSH_KEY="$HOME/.ssh/google_compute_engine"
REMOTE_DIR="~/indic-bot"

echo "=== Deploying indic-bot ==="

# 1. Sync code (exclude secrets, node_modules, logs)
echo "[1/3] Syncing files..."
rsync -az --delete \
  -e "ssh -i $SSH_KEY" \
  --exclude node_modules \
  --exclude .git \
  --exclude .env \
  --exclude logs \
  . "$REMOTE:$REMOTE_DIR/"

# 2. Install deps if package.json changed
echo "[2/3] Installing dependencies..."
ssh -i "$SSH_KEY" "$REMOTE" "cd $REMOTE_DIR && npm install --production"

# 3. Restart bot
echo "[3/3] Restarting bot..."
ssh -i "$SSH_KEY" "$REMOTE" "cd $REMOTE_DIR && pm2 restart indic-bot"

echo "=== Deploy complete ==="
echo "Check logs: ssh -i $SSH_KEY $REMOTE 'pm2 logs indic-bot --lines 20'"
