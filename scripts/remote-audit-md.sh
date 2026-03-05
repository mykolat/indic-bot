#!/bin/bash
set -euo pipefail

REMOTE="mykolat@34.179.171.213"
SSH_KEY="$HOME/.ssh/google_compute_engine"
REMOTE_DIR="~/indic-bot"

echo "=== 🚀 Running Remote Audit (Markdown) ==="
ssh -i "$SSH_KEY" "$REMOTE" "cd $REMOTE_DIR && npm run audit:md"

echo "=== 📥 Syncing Audit Reports back to local ==="
rsync -az -e "ssh -i $SSH_KEY" "$REMOTE:$REMOTE_DIR/docs/deepresult/audit_history/" ./docs/deepresult/audit_history/

echo "=== ✅ Done! ==="
LATEST=$(ls -t ./docs/deepresult/audit_history/*.md 2>/dev/null | head -n 1 || true)
if [ -n "$LATEST" ]; then
    echo "Latest report downloaded: $LATEST"
    echo "Run 'cat $LATEST' or open it in your editor to view the summary."
fi
