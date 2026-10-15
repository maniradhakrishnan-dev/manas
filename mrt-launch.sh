#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if [ -f "$DIR/src-tauri/target/release/mrt" ]; then
    exec "$DIR/src-tauri/target/release/mrt" "$@"
elif [ -f "$DIR/src-tauri/target/debug/mrt" ]; then
    exec "$DIR/src-tauri/target/debug/mrt" "$@"
elif [ -f "$DIR/target/release/mrt" ]; then
    exec "$DIR/target/release/mrt" "$@"
elif [ -f "$DIR/target/debug/mrt" ]; then
    exec "$DIR/target/debug/mrt" "$@"
else
    npx @tauri-apps/cli dev
fi
