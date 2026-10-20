#!/usr/bin/env bash
# Launch Manas in Development Mode
# Automatically uses ~/.local/share/mrt/entries for testing/scratchpad
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=================================================="
echo " Starting Manas (Development Mode)"
echo " Storage: ~/.local/share/mrt/entries"
echo " (Your production data in ~/.local/share/manas is safe)"
echo "=================================================="

exec npx @tauri-apps/cli dev "$@"
