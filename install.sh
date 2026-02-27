#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"
INSTALL_DIR="${HOME}/scripts/icecast-monitor"

# prompt for stream URL
read -rp "Icecast stream URL: " STREAM_URL
if [[ -z "$STREAM_URL" ]]; then
  echo "error: stream URL is required"
  exit 1
fi

mkdir -p "$UNIT_DIR" "$INSTALL_DIR"

cp "$SCRIPT_DIR/monitor.ts" "$INSTALL_DIR/monitor.ts"

# write unit file with configured URL
sed "s|Environment=ICECAST_URL=.*|Environment=ICECAST_URL=${STREAM_URL}|" \
  "$SCRIPT_DIR/icecast-monitor.service" > "$UNIT_DIR/icecast-monitor.service"

systemctl --user daemon-reload
systemctl --user enable icecast-monitor.service

echo ""
echo "installed to $INSTALL_DIR/monitor.ts"
echo "unit installed to $UNIT_DIR/icecast-monitor.service"
echo ""
echo "start with: systemctl --user start icecast-monitor"
echo "logs:       journalctl --user -u icecast-monitor -f"
echo ""
echo "to change the stream URL later, edit:"
echo "  $UNIT_DIR/icecast-monitor.service"
echo "then: systemctl --user daemon-reload && systemctl --user restart icecast-monitor"
